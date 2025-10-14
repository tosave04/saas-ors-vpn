import type {
  Feature,
  FeatureCollection,
  GeoJsonObject,
  GeometryCollection,
  LineString,
  MultiLineString
} from 'geojson';
import { haversineDistanceKm } from '../utils/geo.js';
import type { LonLat } from '../utils/geo.js';

const EARTH_RADIUS_KM = 6371;
const DEFAULT_TOLERANCE_KM = 0.1;
const EPSILON = 1e-9;

export interface RouteProximityOptions {
  toleranceKm?: number;
}

export interface RouteProximityResult {
  distanceKm: number;
  isWithinTolerance: boolean;
}

const toRadians = (value: number): number => (value * Math.PI) / 180;

const sanitizeCoordinate = (coordinate: number[]): LonLat | null => {
  if (!Array.isArray(coordinate) || coordinate.length < 2) {
    return null;
  }
  const lon = Number(coordinate[0]);
  const lat = Number(coordinate[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return null;
  }
  return [lon, lat];
};

const sanitizeLine = (coordinates: number[][]): LonLat[] => {
  const line: LonLat[] = [];
  for (const coordinate of coordinates) {
    const normalized = sanitizeCoordinate(coordinate);
    if (normalized) {
      line.push(normalized);
    }
  }
  return line;
};

const appendLineStrings = (
  geometry: GeoJsonObject,
  sink: LonLat[][]
): void => {
  switch (geometry.type) {
    case 'FeatureCollection': {
      const collection = geometry as FeatureCollection;
      for (const feature of collection.features) {
        if (feature.geometry) {
          appendLineStrings(feature.geometry as GeoJsonObject, sink);
        }
      }
      break;
    }
    case 'Feature': {
      const feature = geometry as Feature;
      if (feature.geometry) {
        appendLineStrings(feature.geometry as GeoJsonObject, sink);
      }
      break;
    }
    case 'GeometryCollection': {
      const collection = geometry as GeometryCollection;
      for (const inner of collection.geometries) {
        appendLineStrings(inner as GeoJsonObject, sink);
      }
      break;
    }
    case 'LineString': {
      const line = sanitizeLine((geometry as LineString).coordinates);
      if (line.length >= 2) {
        sink.push(line);
      }
      break;
    }
    case 'MultiLineString': {
      const lines = (geometry as MultiLineString).coordinates;
      for (const lineCoordinates of lines) {
        const line = sanitizeLine(lineCoordinates);
        if (line.length >= 2) {
          sink.push(line);
        }
      }
      break;
    }
    default:
      break;
  }
};

const initialBearingRad = (from: LonLat, to: LonLat): number => {
  const [lon1, lat1] = from;
  const [lon2, lat2] = to;
  const φ1 = toRadians(lat1);
  const φ2 = toRadians(lat2);
  const Δλ = toRadians(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.atan2(y, x);
};

const pointToSegmentDistanceKm = (point: LonLat, start: LonLat, end: LonLat): number => {
  const segmentLengthKm = haversineDistanceKm(start, end);
  if (segmentLengthKm < EPSILON) {
    return haversineDistanceKm(point, start);
  }

  const distanceToStartKm = haversineDistanceKm(start, point);
  if (distanceToStartKm < EPSILON) {
    return 0;
  }

  // Cross-track calculations on a sphere (see https://www.movable-type.co.uk/scripts/latlong.html)
  const δ13 = distanceToStartKm / EARTH_RADIUS_KM;
  const θ13 = initialBearingRad(start, point);
  const θ12 = initialBearingRad(start, end);
  const sinCrossTrack = Math.sin(δ13) * Math.sin(θ13 - θ12);
  const δxt = Math.asin(Math.max(-1, Math.min(1, sinCrossTrack)));
  const crossTrackKm = Math.abs(δxt) * EARTH_RADIUS_KM;

  const alongTrackRad = Math.atan2(
    Math.sin(δ13) * Math.cos(θ13 - θ12),
    Math.cos(δ13)
  );
  if (Number.isNaN(alongTrackRad)) {
    return Math.min(distanceToStartKm, haversineDistanceKm(point, end));
  }
  if (alongTrackRad < -EPSILON) {
    return distanceToStartKm;
  }

  const segmentLengthRad = segmentLengthKm / EARTH_RADIUS_KM;
  if (alongTrackRad - segmentLengthRad > EPSILON) {
    return haversineDistanceKm(point, end);
  }

  return crossTrackKm;
};

const computeMinimumDistanceKm = (lines: LonLat[][], coordinate: LonLat): number => {
  let minimum = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i += 1) {
      const distance = pointToSegmentDistanceKm(coordinate, line[i], line[i + 1]);
      if (distance < minimum) {
        minimum = distance;
        if (minimum < EPSILON) {
          return 0;
        }
      }
    }
  }
  return minimum;
};

const validateCoordinate = (coordinate: LonLat): void => {
  if (
    !Array.isArray(coordinate) ||
    coordinate.length !== 2 ||
    !Number.isFinite(coordinate[0]) ||
    !Number.isFinite(coordinate[1])
  ) {
    throw new Error('Coordinate must be a [lon, lat] pair with finite values.');
  }
};

/**
 * Measures how far a coordinate sits from a route geometry and reports whether it is within tolerance.
 * Handles FeatureCollection, Feature, or raw GeoJSON inputs and keeps calculations spherical.
 * @param route - GeoJSON describing the route or corridor to compare against.
 * @param coordinate - `[lon, lat]` location to test.
 * @param options - Optional overrides including `toleranceKm`.
 * @returns Distance in kilometers plus a boolean convenience flag.
 * @example
 * ```ts
 * const proximity = computeRouteProximity(routeGeoJson, [8.68, 49.41], {
 *   toleranceKm: 0.2
 * });
 * if (!proximity.isWithinTolerance) {
 *   console.warn(`Client is ${proximity.distanceKm.toFixed(2)} km away from the route`);
 * }
 * ```
 */
export const computeRouteProximity = (
  route: FeatureCollection | Feature | GeoJsonObject,
  coordinate: LonLat,
  options?: RouteProximityOptions
): RouteProximityResult => {
  if (!route || typeof route !== 'object') {
    throw new Error('Route GeoJSON input is required.');
  }

  validateCoordinate(coordinate);

  const lineStrings: LonLat[][] = [];
  appendLineStrings(route as GeoJsonObject, lineStrings);
  if (lineStrings.length === 0) {
    throw new Error('Route GeoJSON must contain at least one LineString with two or more coordinates.');
  }

  const distanceKm = computeMinimumDistanceKm(lineStrings, coordinate);
  const toleranceKm =
    options?.toleranceKm && options.toleranceKm > 0
      ? options.toleranceKm
      : DEFAULT_TOLERANCE_KM;

  return {
    distanceKm,
    isWithinTolerance: distanceKm <= toleranceKm
  };
};

/**
 * Convenience wrapper that answers “is this coordinate close enough to the route?” using `computeRouteProximity`.
 * @param route - GeoJSON describing the route or corridor to compare against.
 * @param coordinate - `[lon, lat]` location to test.
 * @param toleranceKm - Optional tolerance in kilometers (defaults to the helper’s internal value).
 * @returns `true` when the coordinate is at or below the tolerance, otherwise `false`.
 * @example
 * ```ts
 * if (isCoordinateNearRoute(routeGeoJson, [8.68, 49.41], 0.15)) {
 *   console.log('The stop remains inside the delivery corridor');
 * }
 * ```
 */
export const isCoordinateNearRoute = (
  route: FeatureCollection | Feature | GeoJsonObject,
  coordinate: LonLat,
  toleranceKm?: number
): boolean => {
  const result = computeRouteProximity(route, coordinate, {
    toleranceKm
  });
  return result.isWithinTolerance;
};
