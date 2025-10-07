export const DEFAULT_BASE_URL = 'https://api.openrouteservice.org';
export const DEFAULT_API_VERSION = 'v2';
export const DEFAULT_TIMEOUT = 30000;
export const DEFAULT_ENV_KEY = 'ORS_API_KEY';

export type DirectionModeGroup = 'driving' | 'cycling' | 'foot' | 'wheelchair';

export const PROFILE_GROUPS: Record<DirectionModeGroup, string[]> = {
  driving: [
    'driving-car',
    'driving-hgv',
    'driving-tractor',
    'driving-electric',
    'driving-emergency'
  ],
  cycling: [
    'cycling-regular',
    'cycling-road',
    'cycling-mountain',
    'cycling-electric',
    'cycling-safe',
    'cycling-tour',
    'cycling-gravel'
  ],
  foot: ['foot-walking', 'foot-hiking'],
  wheelchair: ['wheelchair']
};

export interface RateLimit {
  requests: number;
  intervalMs: number;
}

export interface DirectionLimits {
  maxWaypoints: number;
  maxAvoidPolygonAreaKm2: number;
  maxAvoidPolygonExtentKm: number;
  maxAlternativeRoutes: number;
  maxRoundTripDistanceKm: number;
  maxDistanceKmByGroup: Record<DirectionModeGroup, number>;
  maxRestrictedDistanceKmByGroup: Partial<Record<DirectionModeGroup, number>>;
}

export interface IsochroneLimits {
  maxLocations: number;
  maxIntervals: number;
  maxRangeDistanceKm: number;
  maxRangeTimeHoursByGroup: Record<Exclude<DirectionModeGroup, 'wheelchair'>, number>;
}

export interface MatrixLimits {
  maxLocationsProduct: number;
  maxDynamicLocations: number;
}

export interface SnapLimits {
  maxLocations: number;
}

export interface PoisLimits {
  maxBboxAreaKm2: number;
  maxLinestringLengthKm: number;
  maxSearchRadiusKm: number;
}

export interface ElevationLimits {
  maxVertices: number;
}

export interface OptimizationLimits {
  maxRoutes: number;
  maxVehicles: number;
}

export interface ExportLimits {
  maxBboxAreaKm2: number;
}

export interface ORSLimits {
  rateLimit: RateLimit;
  directions: DirectionLimits;
  isochrones: IsochroneLimits;
  matrix: MatrixLimits;
  snap: SnapLimits;
  pois: PoisLimits;
  elevation: ElevationLimits;
  optimization: OptimizationLimits;
  export: ExportLimits;
}

export const DEFAULT_LIMITS: ORSLimits = {
  rateLimit: {
    requests: 40,
    intervalMs: 60_000
  },
  directions: {
    maxWaypoints: 50,
    maxAvoidPolygonAreaKm2: 200,
    maxAvoidPolygonExtentKm: 20,
    maxAlternativeRoutes: 3,
    maxRoundTripDistanceKm: 100,
    maxDistanceKmByGroup: {
      driving: 6000,
      cycling: 6000,
      foot: 6000,
      wheelchair: 6000
    },
    maxRestrictedDistanceKmByGroup: {
      driving: 150,
      cycling: 150,
      foot: 150,
      wheelchair: 300
    }
  },
  isochrones: {
    maxLocations: 5,
    maxIntervals: 10,
    maxRangeDistanceKm: 120,
    maxRangeTimeHoursByGroup: {
      driving: 1,
      cycling: 5,
      foot: 20
    }
  },
  matrix: {
    maxLocationsProduct: 3500,
    maxDynamicLocations: 25
  },
  snap: {
    maxLocations: 5000
  },
  pois: {
    maxBboxAreaKm2: 50,
    maxLinestringLengthKm: 500,
    maxSearchRadiusKm: 2
  },
  elevation: {
    maxVertices: 2000
  },
  optimization: {
    maxRoutes: 50,
    maxVehicles: 3
  },
  export: {
    maxBboxAreaKm2: 10
  }
};

export const DEFAULT_USER_AGENT = 'ors-ts-client/0.1.0';
