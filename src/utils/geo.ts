import type { Feature, FeatureCollection, GeoJsonObject, LineString, MultiPolygon, Polygon } from 'geojson';

export type LonLat = [number, number];

const EARTH_RADIUS_KM = 6371;

const toRadians = (value: number): number => (value * Math.PI) / 180;

export const haversineDistanceKm = (a: LonLat, b: LonLat): number => {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;

  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const lat1Rad = toRadians(lat1);
  const lat2Rad = toRadians(lat2);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);

  const h =
    sinDLat * sinDLat + Math.cos(lat1Rad) * Math.cos(lat2Rad) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));

  return EARTH_RADIUS_KM * c;
};

export const bboxAreaKm2 = (bbox: [number, number, number, number]): number => {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const width = haversineDistanceKm([minLon, minLat], [maxLon, minLat]);
  const height = haversineDistanceKm([minLon, minLat], [minLon, maxLat]);
  return width * height;
};

const polygonRingAreaKm2 = (ring: LonLat[], latitudeFactor: number): number => {
  let area = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[(i + 1) % ring.length];
    const x1 = lon1 * latitudeFactor;
    const x2 = lon2 * latitudeFactor;
    const y1 = lat1;
    const y2 = lat2;
    area += x1 * y2 - x2 * y1;
  }

  const km2Factor = Math.pow((Math.PI / 180) * EARTH_RADIUS_KM, 2);
  return Math.abs(area) * 0.5 * km2Factor;
};

export const polygonAreaKm2 = (polygon: Polygon): number => {
  const [outerRing] = polygon.coordinates;
  if (!outerRing) {
    return 0;
  }

  const avgLat =
    outerRing.reduce((sum, [, lat]) => sum + lat, 0) / outerRing.length || 0;
  const latitudeFactor = Math.cos(toRadians(avgLat));

  let area = polygonRingAreaKm2(outerRing as LonLat[], latitudeFactor);
  if (polygon.coordinates.length > 1) {
    for (let i = 1; i < polygon.coordinates.length; i += 1) {
      area -= polygonRingAreaKm2(polygon.coordinates[i] as LonLat[], latitudeFactor);
    }
  }
  return Math.max(area, 0);
};

const multiPolygonAreaKm2 = (multiPolygon: MultiPolygon): number =>
  multiPolygon.coordinates.reduce((sum, polygonCoords) => {
    const polygon: Polygon = {
      type: 'Polygon',
      coordinates: polygonCoords
    };
    return sum + polygonAreaKm2(polygon);
  }, 0);

export const featureCollectionAreaKm2 = (
  geojson: FeatureCollection | Feature | Polygon | MultiPolygon
): number => {
  if ('type' in geojson) {
    switch (geojson.type) {
      case 'Polygon':
        return polygonAreaKm2(geojson);
      case 'MultiPolygon':
        return multiPolygonAreaKm2(geojson);
      case 'Feature':
        if (geojson.geometry) {
          return featureCollectionAreaKm2(geojson.geometry as GeoJsonObject as Polygon | MultiPolygon);
        }
        return 0;
      case 'FeatureCollection':
        return geojson.features.reduce(
          (sum, feature) => sum + featureCollectionAreaKm2(feature),
          0
        );
      default:
        return 0;
    }
  }
  return 0;
};

export const linestringLengthKm = (line: LineString): number => {
  const { coordinates } = line;
  if (!coordinates || coordinates.length < 2) {
    return 0;
  }
  let length = 0;
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    length += haversineDistanceKm(
      coordinates[i] as LonLat,
      coordinates[i + 1] as LonLat
    );
  }
  return length;
};

export const metersToKilometers = (meters: number): number => meters / 1000;

export const pathLengthKm = (coordinates: LonLat[]): number => {
  if (coordinates.length < 2) {
    return 0;
  }
  let total = 0;
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    total += haversineDistanceKm(coordinates[i], coordinates[i + 1]);
  }
  return total;
};
