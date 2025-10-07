import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { loadEnv } from './utils/env.js';
import {
  DEFAULT_API_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_ENV_KEY,
  DEFAULT_LIMITS,
  DEFAULT_TIMEOUT,
  DEFAULT_USER_AGENT,
  DirectionModeGroup,
  ORSLimits,
  PROFILE_GROUPS
} from './constants.js';
import { RateLimiter } from './rateLimiter.js';
import type { RateLimiterOptions } from './rateLimiter.js';
import {
  bboxAreaKm2,
  featureCollectionAreaKm2,
  haversineDistanceKm,
  linestringLengthKm,
  metersToKilometers,
  pathLengthKm
} from './utils/geo.js';
import type {
  DirectionsProfile,
  DirectionsRequest,
  ElevationLineRequest,
  ElevationPointRequest,
  GeocodeCommonParams,
  IsochroneProfile,
  IsochroneRequest,
  MatrixProfile,
  MatrixRequest,
  OptimizationRequest,
  ORSClientOptions,
  PoisRequest,
  RequestOptions,
  SnapProfile,
  SnapRequest
} from './types.js';
import type {
  Feature,
  FeatureCollection,
  GeoJsonObject,
  GeometryCollection,
  LineString,
  MultiLineString,
  MultiPoint,
  MultiPolygon,
  Point,
  Polygon
} from 'geojson';

const cloneLimits = (limits: ORSLimits): ORSLimits =>
  JSON.parse(JSON.stringify(limits));

const deepMerge = (target: any, source?: any): any => {
  if (!source) {
    return target;
  }
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (value === undefined || value === null) {
      continue;
    }
    const current = target[key];
    if (typeof current === 'object' && current !== null && !Array.isArray(current) &&
        typeof value === 'object' && value !== null && !Array.isArray(value)) {
      target[key] = deepMerge({ ...current }, value);
    } else {
      target[key] = value;
    }
  }
  return target;
};

const buildBaseUrl = (baseUrl: string, apiVersion: string): string => {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const normalizedVersion = apiVersion.replace(/^\/+/, '');
  return `${normalizedBase}/${normalizedVersion}`;
};

const getProfileGroup = (profile: DirectionsProfile): DirectionModeGroup => {
  for (const [group, profiles] of Object.entries(PROFILE_GROUPS) as Array<
    [DirectionModeGroup, string[]]
  >) {
    if (profiles.includes(profile)) {
      return group;
    }
  }
  throw new Error(`Unsupported profile "${profile}".`);
};

const isGeoJsonObject = (geometry: unknown): geometry is GeoJsonObject => {
  return Boolean(geometry && typeof geometry === 'object' && 'type' in geometry);
};

const appendCoordinates = (
  geometry: GeoJsonObject,
  sink: Array<[number, number]>
): void => {
  switch (geometry.type) {
    case 'FeatureCollection': {
      const collection = geometry as FeatureCollection;
      for (const feature of collection.features) {
        if (feature.geometry) {
          appendCoordinates(feature.geometry as GeoJsonObject, sink);
        }
      }
      break;
    }
    case 'Feature': {
      const feature = geometry as Feature;
      if (feature.geometry) {
        appendCoordinates(feature.geometry as GeoJsonObject, sink);
      }
      break;
    }
    case 'GeometryCollection': {
      const collection = geometry as GeometryCollection;
      for (const innerGeometry of collection.geometries) {
        appendCoordinates(innerGeometry as GeoJsonObject, sink);
      }
      break;
    }
    case 'Point': {
      const [lon, lat] = (geometry as Point).coordinates;
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        sink.push([lon, lat]);
      }
      break;
    }
    case 'MultiPoint': {
      const coordinates = (geometry as MultiPoint).coordinates;
      for (const coordinate of coordinates) {
        if (coordinate.length >= 2) {
          sink.push([coordinate[0], coordinate[1]]);
        }
      }
      break;
    }
    case 'LineString': {
      const coordinates = (geometry as LineString).coordinates;
      for (const coordinate of coordinates) {
        if (coordinate.length >= 2) {
          sink.push([coordinate[0], coordinate[1]]);
        }
      }
      break;
    }
    case 'MultiLineString': {
      const lines = (geometry as MultiLineString).coordinates;
      for (const line of lines) {
        for (const coordinate of line) {
          if (coordinate.length >= 2) {
            sink.push([coordinate[0], coordinate[1]]);
          }
        }
      }
      break;
    }
    case 'Polygon': {
      const rings = (geometry as Polygon).coordinates;
      for (const ring of rings) {
        for (const coordinate of ring) {
          if (coordinate.length >= 2) {
            sink.push([coordinate[0], coordinate[1]]);
          }
        }
      }
      break;
    }
    case 'MultiPolygon': {
      const polygons = (geometry as MultiPolygon).coordinates;
      for (const polygon of polygons) {
        for (const ring of polygon) {
          for (const coordinate of ring) {
            if (coordinate.length >= 2) {
              sink.push([coordinate[0], coordinate[1]]);
            }
          }
        }
      }
      break;
    }
    default:
      break;
  }
};

const flattenCoordinates = (
  feature: Feature | FeatureCollection | GeoJsonObject
): Array<[number, number]> => {
  const coords: Array<[number, number]> = [];
  if (!isGeoJsonObject(feature)) {
    return coords;
  }

  appendCoordinates(feature, coords);
  return coords;
};

const computeGeometryBbox = (
  geometry: Feature | FeatureCollection | GeoJsonObject
): [number, number, number, number] | undefined => {
  const coords = flattenCoordinates(geometry);
  if (!coords.length) {
    return undefined;
  }
  let minLon = coords[0][0];
  let minLat = coords[0][1];
  let maxLon = coords[0][0];
  let maxLat = coords[0][1];
  for (const [lon, lat] of coords) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return [minLon, minLat, maxLon, maxLat];
};

export class ORS {
  private apiKey: string;
  private readonly client: AxiosInstance;
  private readonly limits: ORSLimits;
  private readonly defaultProfile?: DirectionsProfile;
  private readonly defaultHeaders: Record<string, string>;
  private readonly rateLimiter?: RateLimiter;

  constructor(options: ORSClientOptions = {}) {
    const {
      baseUrl = DEFAULT_BASE_URL,
      apiVersion = DEFAULT_API_VERSION,
      timeoutMs = DEFAULT_TIMEOUT,
      autoLoadEnv = true,
      envFilePath,
      headers,
      userAgent = DEFAULT_USER_AGENT,
      defaultProfile,
      rateLimit,
      limits: limitOverrides
    } = options;

    if (autoLoadEnv) {
      loadEnv(envFilePath ? { path: envFilePath } : undefined);
    }

    const resolvedApiKey =
      options.apiKey ?? process.env[DEFAULT_ENV_KEY];
    if (!resolvedApiKey) {
      throw new Error(
        `Missing openrouteservice API key. Provide it via options.apiKey or set ${DEFAULT_ENV_KEY} in your environment.`
      );
    }
    this.apiKey = resolvedApiKey;

    const limitsClone = cloneLimits(DEFAULT_LIMITS);
    this.limits = deepMerge(limitsClone, limitOverrides);

    const rateLimitOverrides: RateLimiterOptions = {
      requests: rateLimit?.requests ?? this.limits.rateLimit.requests,
      intervalMs: rateLimit?.intervalMs ?? this.limits.rateLimit.intervalMs
    };

    if (rateLimit?.enabled !== false) {
      this.rateLimiter = new RateLimiter(rateLimitOverrides);
    }

    this.defaultHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
      ...headers
    };

    this.client = axios.create({
      baseURL: buildBaseUrl(baseUrl, apiVersion),
      timeout: timeoutMs
    });
    this.defaultProfile = defaultProfile;
  }

  public setApiKey(apiKey: string): void {
    if (!apiKey) {
      throw new Error('API key cannot be empty.');
    }
    this.apiKey = apiKey;
  }

  private async runRequest<T>(
    config: AxiosRequestConfig,
    options?: RequestOptions
  ): Promise<T> {
    const overrideConfig = options?.axios ?? {};
    const mergedHeaders = {
      ...this.defaultHeaders,
      ...overrideConfig.headers,
      ...config.headers,
      Authorization: this.apiKey
    };

    const finalConfig: AxiosRequestConfig = {
      ...overrideConfig,
      ...config,
      headers: mergedHeaders,
      signal: options?.signal ?? overrideConfig.signal ?? config.signal
    };

    const execute = async () => {
      const response = await this.client.request<T>(finalConfig);
      return response.data;
    };

    if (!this.rateLimiter) {
      return execute();
    }

    return this.rateLimiter.schedule(execute);
  }

  private ensureProfile(profile?: DirectionsProfile): DirectionsProfile {
    if (profile) {
      return profile;
    }
    if (!this.defaultProfile) {
      throw new Error(
        'A profile is required. Provide it as an argument or configure defaultProfile in the client options.'
      );
    }
    return this.defaultProfile;
  }

  private validateDirections(
    profile: DirectionsProfile,
    request: DirectionsRequest
  ): void {
    if (!request.coordinates || request.coordinates.length < 2) {
      throw new Error('Directions request requires at least two coordinates.');
    }

    if (request.coordinates.length > this.limits.directions.maxWaypoints) {
      throw new Error(
        `Directions request exceeds ${this.limits.directions.maxWaypoints} waypoints limit.`
      );
    }

    const group = getProfileGroup(profile);
    const hasRestrictions =
      typeof request.options?.profile_params?.restrictions === 'object' &&
      request.options?.profile_params?.restrictions !== null;
    if (hasRestrictions) {
      const straightDistance = pathLengthKm(request.coordinates);
      const restrictionLimit =
        this.limits.directions.maxRestrictedDistanceKmByGroup[group];
      if (
        restrictionLimit !== undefined &&
        straightDistance > restrictionLimit
      ) {
        throw new Error(
          `Directions with profile restrictions are limited to ${restrictionLimit} km straight-line distance for ${group} profiles.`
        );
      }
    }

    const options = request.options ?? {};
    const roundTrip = options.round_trip ?? request.round_trip;
    if (roundTrip?.length !== undefined) {
      const roundTripLengthKm = metersToKilometers(roundTrip.length);
      if (roundTripLengthKm > this.limits.directions.maxRoundTripDistanceKm) {
        throw new Error(
          `Round trip length exceeds ${this.limits.directions.maxRoundTripDistanceKm} km limit.`
        );
      }
    }

    if (options.alternative_routes?.target_count !== undefined) {
      if (
        options.alternative_routes.target_count >
        this.limits.directions.maxAlternativeRoutes
      ) {
        throw new Error(
          `Alternative routes target_count cannot exceed ${this.limits.directions.maxAlternativeRoutes}.`
        );
      }
    }

    const avoidGeometry =
      options.avoid_polygons ?? options.avoid_areas;
    if (avoidGeometry && isGeoJsonObject(avoidGeometry)) {
      const areaKm2 = featureCollectionAreaKm2(avoidGeometry);
      if (areaKm2 > this.limits.directions.maxAvoidPolygonAreaKm2) {
        throw new Error(
          `Avoid areas exceed ${this.limits.directions.maxAvoidPolygonAreaKm2} km² limit.`
        );
      }

      const bbox = computeGeometryBbox(avoidGeometry);
      if (bbox) {
        const width = haversineDistanceKm(
          [bbox[0], bbox[1]],
          [bbox[2], bbox[1]]
        );
        const height = haversineDistanceKm(
          [bbox[0], bbox[1]],
          [bbox[0], bbox[3]]
        );
        if (
          Math.max(width, height) >
          this.limits.directions.maxAvoidPolygonExtentKm
        ) {
          throw new Error(
            `Avoid polygon extent exceeds ${this.limits.directions.maxAvoidPolygonExtentKm} km limit.`
          );
        }
      }
    }
  }

  private validateIsochrones(
    profile: IsochroneProfile,
    request: IsochroneRequest
  ): void {
    if (!request.locations || request.locations.length === 0) {
      throw new Error('Isochrone request requires at least one location.');
    }
    if (request.locations.length > this.limits.isochrones.maxLocations) {
      throw new Error(
        `Isochrones request exceeds ${this.limits.isochrones.maxLocations} locations limit.`
      );
    }
    if (!request.range || request.range.length === 0) {
      throw new Error('Isochrone request requires at least one range value.');
    }
    if (request.range.length > this.limits.isochrones.maxIntervals) {
      throw new Error(
        `Isochrones request exceeds ${this.limits.isochrones.maxIntervals} range intervals limit.`
      );
    }

    const rangeType = request.range_type ?? 'time';
    const group = getProfileGroup(profile);
    if (group === 'wheelchair') {
      throw new Error('Wheelchair profile is not supported for isochrone requests.');
    }
    for (const value of request.range) {
      if (rangeType === 'distance') {
        const valueKm =
          request.units === 'km' ? value : metersToKilometers(value);
        if (valueKm > this.limits.isochrones.maxRangeDistanceKm) {
          throw new Error(
            `Isochrone distance range exceeds ${this.limits.isochrones.maxRangeDistanceKm} km limit.`
          );
        }
      } else {
        const valueHours = value / 3600;
        const maxHours =
          this.limits.isochrones.maxRangeTimeHoursByGroup[
            group as keyof typeof this.limits.isochrones.maxRangeTimeHoursByGroup
          ];
        if (maxHours !== undefined && valueHours > maxHours) {
          throw new Error(
            `Isochrone time range exceeds ${maxHours} hours for ${group} profiles.`
          );
        }
      }
    }
  }

  private validateMatrix(request: MatrixRequest): void {
    if (!request.locations || request.locations.length === 0) {
      throw new Error('Matrix request requires at least one location.');
    }
    const totalLocations = request.locations.length;
    const sourcesCount =
      request.sources === undefined || request.sources === 'all'
        ? totalLocations
        : Array.isArray(request.sources)
        ? request.sources.length
        : totalLocations;
    const destinationsCount =
      request.destinations === undefined || request.destinations === 'all'
        ? totalLocations
        : Array.isArray(request.destinations)
        ? request.destinations.length
        : totalLocations;

    const product = sourcesCount * destinationsCount;
    if (product > this.limits.matrix.maxLocationsProduct) {
      throw new Error(
        `Matrix request exceeds ${this.limits.matrix.maxLocationsProduct} cell limit (${sourcesCount} sources x ${destinationsCount} destinations).`
      );
    }

    if (
      (typeof request.sources === 'string' ||
        typeof request.destinations === 'string') &&
      product > this.limits.matrix.maxDynamicLocations
    ) {
      throw new Error(
        `Matrix requests with dynamic sources/destinations cannot exceed ${this.limits.matrix.maxDynamicLocations} cells.`
      );
    }
  }

  private validateSnap(request: SnapRequest): void {
    if (!request.locations || request.locations.length === 0) {
      throw new Error('Snap request requires at least one location.');
    }
    if (request.locations.length > this.limits.snap.maxLocations) {
      throw new Error(
        `Snap request exceeds ${this.limits.snap.maxLocations} coordinate limit.`
      );
    }
  }

  private validatePois(request: PoisRequest): void {
    if (!request.geometry) {
      throw new Error('POIs request requires geometry definition.');
    }
    if (request.request === 'bbox' && request.geometry.bbox) {
      const area = bboxAreaKm2(request.geometry.bbox);
      if (area > this.limits.pois.maxBboxAreaKm2) {
        throw new Error(
          `POIs bbox area exceeds ${this.limits.pois.maxBboxAreaKm2} km² limit.`
        );
      }
    }
    if (request.request === 'radius' && request.geometry.radius !== undefined) {
      const radiusKm = metersToKilometers(request.geometry.radius);
      if (radiusKm > this.limits.pois.maxSearchRadiusKm) {
        throw new Error(
          `POIs radius exceeds ${this.limits.pois.maxSearchRadiusKm} km limit.`
        );
      }
    }
    if (
      request.geometry.geojson &&
      isGeoJsonObject(request.geometry.geojson)
    ) {
      const areaKm2 = featureCollectionAreaKm2(request.geometry.geojson);
      if (areaKm2 > this.limits.pois.maxBboxAreaKm2) {
        throw new Error(
          `POIs polygon area exceeds ${this.limits.pois.maxBboxAreaKm2} km² limit.`
        );
      }

      const bbox = computeGeometryBbox(request.geometry.geojson);
      if (bbox) {
        const width = haversineDistanceKm(
          [bbox[0], bbox[1]],
          [bbox[2], bbox[1]]
        );
        const height = haversineDistanceKm(
          [bbox[0], bbox[1]],
          [bbox[0], bbox[3]]
        );
        if (width * height > this.limits.pois.maxBboxAreaKm2) {
          throw new Error(
            `POIs search area exceeds ${this.limits.pois.maxBboxAreaKm2} km² limit.`
          );
        }
      }

      const geojsonValue = request.geometry.geojson;
      const geometry =
        (geojsonValue as Feature)?.geometry ?? geojsonValue;
      if (geometry?.type === 'LineString') {
        const length = linestringLengthKm(geometry as LineString);
        if (length > this.limits.pois.maxLinestringLengthKm) {
          throw new Error(
            `POIs linestring length exceeds ${this.limits.pois.maxLinestringLengthKm} km limit.`
          );
        }
      }
    }
  }

  private validateElevationPoint(request: ElevationPointRequest): void {
    if (!request.geometry) {
      throw new Error('Elevation point request requires geometry.');
    }
  }

  private validateElevationLine(request: ElevationLineRequest): void {
    if (!request.geometry) {
      throw new Error('Elevation line request requires geometry.');
    }

    const geometry = (request.geometry as Feature)?.geometry ?? request.geometry;
    if (!geometry || geometry.type !== 'LineString') {
      return;
    }
    const coordinates = (geometry as LineString).coordinates;
    if (coordinates && coordinates.length > this.limits.elevation.maxVertices) {
      throw new Error(
        `Elevation line requests cannot exceed ${this.limits.elevation.maxVertices} vertices.`
      );
    }
  }

  private validateOptimization(request: OptimizationRequest): void {
    if (!Array.isArray(request.jobs) || request.jobs.length === 0) {
      throw new Error('Optimization request requires at least one job.');
    }
    if (request.jobs.length > this.limits.optimization.maxRoutes) {
      throw new Error(
        `Optimization request exceeds ${this.limits.optimization.maxRoutes} jobs limit.`
      );
    }
    if (!Array.isArray(request.vehicles) || request.vehicles.length === 0) {
      throw new Error('Optimization request requires at least one vehicle.');
    }
    if (request.vehicles.length > this.limits.optimization.maxVehicles) {
      throw new Error(
        `Optimization request exceeds ${this.limits.optimization.maxVehicles} vehicles limit.`
      );
    }
  }

  async directions<T = unknown>(
    profile: DirectionsProfile,
    request: DirectionsRequest,
    options?: RequestOptions
  ): Promise<T> {
    const resolvedProfile = this.ensureProfile(profile);
    this.validateDirections(resolvedProfile, request);
    const { format = 'json', ...body } = request;
    const responseType = format === 'gpx' ? 'text' : 'json';
    const acceptHeader =
      format === 'gpx'
        ? 'application/gpx+xml'
        : format === 'geojson'
        ? 'application/geo+json'
        : 'application/json';
    const path = `directions/${resolvedProfile}/${format}`;
    return this.runRequest<T>(
      {
        method: 'POST',
        url: path,
        data: body,
        headers: {
          Accept: acceptHeader
        },
        responseType
      },
      options
    );
  }

  async isochrones<T = unknown>(
    profile: IsochroneProfile,
    request: IsochroneRequest,
    options?: RequestOptions
  ): Promise<T> {
    let resolvedProfile = profile;
    if (!resolvedProfile) {
      if (!this.defaultProfile) {
        throw new Error(
          'An isochrone profile is required. Provide it as an argument or configure a compatible defaultProfile.'
        );
      }
      if (this.defaultProfile === 'wheelchair') {
        throw new Error('Wheelchair profile is not supported for isochrone requests.');
      }
      resolvedProfile = this.defaultProfile as IsochroneProfile;
    }
    if (!resolvedProfile) {
      throw new Error(
        'An isochrone profile is required. Provide it as an argument or configure a compatible defaultProfile.'
      );
    }
    this.validateIsochrones(resolvedProfile, request);
    const path = `isochrones/${resolvedProfile}`;
    return this.runRequest<T>(
      {
        method: 'POST',
        url: path,
        data: request
      },
      options
    );
  }

  async matrix<T = unknown>(
    profile: MatrixProfile,
    request: MatrixRequest,
    options?: RequestOptions
  ): Promise<T> {
    const resolvedProfile = this.ensureProfile(profile);
    this.validateMatrix(request);
    const path = `matrix/${resolvedProfile}`;
    return this.runRequest<T>(
      {
        method: 'POST',
        url: path,
        data: request
      },
      options
    );
  }

  async optimization<T = unknown>(
    request: OptimizationRequest,
    options?: RequestOptions
  ): Promise<T> {
    this.validateOptimization(request);
    return this.runRequest<T>(
      {
        method: 'POST',
        url: 'optimization',
        data: request
      },
      options
    );
  }

  async snap<T = unknown>(
    profile: SnapProfile,
    request: SnapRequest,
    options?: RequestOptions
  ): Promise<T> {
    const resolvedProfile = this.ensureProfile(profile);
    this.validateSnap(request);
    const path = `snap/${resolvedProfile}`;
    return this.runRequest<T>(
      {
        method: 'POST',
        url: path,
        data: request
      },
      options
    );
  }

  async pois<T = unknown>(
    request: PoisRequest,
    options?: RequestOptions
  ): Promise<T> {
    this.validatePois(request);
    return this.runRequest<T>(
      {
        method: 'POST',
        url: 'pois',
        data: request
      },
      options
    );
  }

  async elevationPoint<T = unknown>(
    request: ElevationPointRequest,
    options?: RequestOptions
  ): Promise<T> {
    this.validateElevationPoint(request);
    return this.runRequest<T>(
      {
        method: 'POST',
        url: 'elevation/point',
        data: request
      },
      options
    );
  }

  async elevationLine<T = unknown>(
    request: ElevationLineRequest,
    options?: RequestOptions
  ): Promise<T> {
    this.validateElevationLine(request);
    return this.runRequest<T>(
      {
        method: 'POST',
        url: 'elevation/line',
        data: request
      },
      options
    );
  }

  private async geocode<T = unknown>(
    endpoint: string,
    params: GeocodeCommonParams,
    options?: RequestOptions
  ): Promise<T> {
    return this.runRequest<T>(
      {
        method: 'GET',
        url: endpoint,
        params
      },
      options
    );
  }

  async geocodeSearch<T = unknown>(
    params: GeocodeCommonParams,
    options?: RequestOptions
  ): Promise<T> {
    if (typeof params.text !== 'string' || params.text.trim().length === 0) {
      throw new Error('Geocode search requires a non-empty "text" parameter.');
    }
    return this.geocode<T>('geocode/search', params, options);
  }

  async geocodeReverse<T = unknown>(
    params: GeocodeCommonParams,
    options?: RequestOptions
  ): Promise<T> {
    if (
      typeof params.point !== 'object' ||
      params.point === null ||
      typeof (params.point as Record<string, unknown>).lng !== 'number' ||
      typeof (params.point as Record<string, unknown>).lat !== 'number'
    ) {
      throw new Error(
        'Geocode reverse requires "point.lat" and "point.lng" numeric parameters.'
      );
    }
    return this.geocode<T>('geocode/reverse', params, options);
  }

  async geocodeAutocomplete<T = unknown>(
    params: GeocodeCommonParams,
    options?: RequestOptions
  ): Promise<T> {
    if (typeof params.text !== 'string' || params.text.trim().length === 0) {
      throw new Error(
        'Geocode autocomplete requires a non-empty "text" parameter.'
      );
    }
    return this.geocode<T>('geocode/autocomplete', params, options);
  }

  async geocodeStructured<T = unknown>(
    params: GeocodeCommonParams,
    options?: RequestOptions
  ): Promise<T> {
    return this.geocode<T>('geocode/structured', params, options);
  }
}

export default ORS;
