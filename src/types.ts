import type {
  Feature,
  FeatureCollection,
  GeoJsonObject,
  Geometry,
  LineString,
  MultiPolygon,
  Polygon
} from 'geojson';
import type { AxiosRequestConfig } from 'axios';
import type { DirectionModeGroup, ORSLimits } from './constants.js';
import type { LonLat } from './utils/geo.js';

export type DirectionsProfile =
  | 'driving-car'
  | 'driving-hgv'
  | 'driving-tractor'
  | 'driving-electric'
  | 'driving-emergency'
  | 'cycling-regular'
  | 'cycling-road'
  | 'cycling-mountain'
  | 'cycling-electric'
  | 'cycling-safe'
  | 'cycling-tour'
  | 'cycling-gravel'
  | 'foot-walking'
  | 'foot-hiking'
  | 'wheelchair';

export type MatrixProfile = DirectionsProfile;
export type IsochroneProfile = Exclude<DirectionsProfile, 'wheelchair'>;
export type SnapProfile = DirectionsProfile;

export interface DirectionsOptions {
  avoid_polygons?: FeatureCollection | Feature | Polygon | MultiPolygon;
  avoid_features?: string[];
  alternative_routes?: {
    target_count?: number;
    share_factor?: number;
    weight_factor?: number;
  };
  round_trip?: {
    length?: number;
    duration?: number;
    points?: number;
    seed?: number;
  };
  profile_params?: {
    restrictions?: Record<string, unknown>;
    surface_quality?: Record<string, unknown>;
  };
  avoid_borders?: {
    type?: 'controlled' | 'all';
    avoid_countries?: string[];
  };
  avoid_areas?: FeatureCollection | Feature | Polygon | MultiPolygon;
  [key: string]: unknown;
}

export interface DirectionsRequest {
  coordinates: LonLat[];
  options?: DirectionsOptions;
  attributes?: string[];
  extra_info?: string[];
  preference?: 'fastest' | 'shortest' | 'recommended';
  elevation?: boolean;
  instructions?: boolean;
  maneuvers?: boolean;
  round_trip?: DirectionsOptions['round_trip'];
  language?: string;
  units?: 'm' | 'km' | 'mi';
  geometry_simplify?: boolean;
  radiuses?: (number | null)[];
  bearings?: Array<[number, number] | null>;
  continue_straight?: boolean;
  suppress_warnings?: boolean;
  optimized?: boolean;
  format?: 'json' | 'geojson' | 'gpx';
  [key: string]: unknown;
}

export interface IsochroneRequest {
  locations: LonLat[];
  range: number[];
  range_type?: 'time' | 'distance';
  units?: 'm' | 'km';
  interval?: number;
  smoothing?: number;
  location_type?: 'start' | 'destination';
  attributes?: string[];
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MatrixRequest {
  locations: LonLat[];
  sources?: Array<number> | 'all';
  destinations?: Array<number> | 'all';
  metrics?: Array<'distance' | 'duration'>;
  resolve_locations?: boolean;
  optimized?: boolean;
  units?: 'm' | 'km' | 'mi';
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SnapRequest {
  locations: LonLat[];
  radiuses?: Array<number | null>;
  bearings?: Array<[number, number] | null>;
  elevation?: boolean;
  units?: 'm' | 'km';
  [key: string]: unknown;
}

export interface PoisRequest {
  request: 'bbox' | 'radius' | 'polygon';
  geometry: {
    bbox?: [number, number, number, number];
    geojson?: FeatureCollection | Feature | Polygon | MultiPolygon;
    radius?: number;
    coordinates?: LonLat[];
  };
  filters?: Record<string, unknown>;
  limit?: number;
  sortby?: string;
  level?: number;
  categories?: number[];
  [key: string]: unknown;
}

export interface OptimizationRequest {
  jobs: Record<string, unknown>[];
  vehicles: Record<string, unknown>[];
  shipments?: Record<string, unknown>[];
  relations?: Record<string, unknown>[];
  [key: string]: unknown;
}

export interface ElevationPointRequest {
  format?: 'point' | 'json' | 'geojson';
  geometry: Feature | GeoJsonObject;
  [key: string]: unknown;
}

export interface ElevationLineRequest {
  format?: 'json' | 'geojson';
  geometry: LineString | Feature<LineString>;
  [key: string]: unknown;
}

export type GeocodeCommonParams = Record<string, unknown>;

export type GeocodeFeature = Feature<Geometry | null, Record<string, unknown>>;

export type GeocodeLookupStage =
  | 'structured_postal_locality'
  | 'structured_postal'
  | 'autocomplete';

export interface GeocodeLookupAttempt {
  stage: GeocodeLookupStage;
  params: GeocodeCommonParams;
  feature?: GeocodeFeature;
  coordinates?: LonLat;
  error?: unknown;
}

export interface GeocodeLookupResult {
  stage: GeocodeLookupStage | 'not_found';
  feature?: GeocodeFeature;
  coordinates?: LonLat;
  attempts: GeocodeLookupAttempt[];
}

export interface GeocodeTownZipQuery {
  town?: string;
  zip?: string;
  countryCode?: string;
  structuredSize?: number;
  autocompleteSize?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  axios?: AxiosRequestConfig;
}

export type PartialDeep<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown>
    ? PartialDeep<T[K]>
    : T[K];
};

export interface ORSClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  defaultProfile?: DirectionsProfile;
  apiVersion?: string;
  rateLimit?: {
    requests?: number;
    intervalMs?: number;
    enabled?: boolean;
  };
  limits?: PartialDeep<ORSLimits>;
  headers?: Record<string, string>;
  userAgent?: string;
  autoLoadEnv?: boolean;
  envFilePath?: string;
}

export interface RequestMetadata {
  profileGroup: DirectionModeGroup;
}
