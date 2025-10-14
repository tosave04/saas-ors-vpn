import type { Point } from 'geojson';
import ORS from '../ors.js';
import type { LonLat } from '../utils/geo.js';
import type {
  GeocodeCommonParams,
  GeocodeFeature,
  GeocodeLookupAttempt,
  GeocodeLookupResult,
  GeocodeTownZipQuery,
  RequestOptions
} from '../types.js';

interface GeocodeResponse {
  features?: GeocodeFeature[];
}

interface GeocodeMatch {
  feature: GeocodeFeature;
  coordinates: LonLat;
}

const normalizeLookupInput = (value?: string): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const getTownPrefix = (town: string): string => {
  const normalized = normalizeLookupInput(town);
  if (!normalized) {
    return '';
  }
  const [firstWord] = normalized.split(/\s+/u);
  return (firstWord ?? '').slice(0, 3);
};

const findFirstPointFeature = (
  response?: GeocodeResponse | null
): GeocodeMatch | null => {
  if (!response || !Array.isArray(response.features)) {
    return null;
  }
  for (const feature of response.features) {
    if (!feature?.geometry || feature.geometry.type !== 'Point') {
      continue;
    }
    const point = feature.geometry as Point;
    const [lon, lat] = point.coordinates ?? [];
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      return {
        feature,
        coordinates: [lon, lat] as LonLat
      };
    }
  }
  return null;
};

const featureContainsTown = (
  feature: GeocodeFeature,
  normalizedTown: string
): boolean => {
  if (!normalizedTown) {
    return false;
  }
  const properties = feature.properties ?? {};
  if (typeof properties !== 'object' || properties === null) {
    return false;
  }
  const candidateKeys = [
    'locality',
    'name',
    'city',
    'localadmin',
    'county',
    'region',
    'state',
    'label'
  ];
  for (const key of candidateKeys) {
    const value = (properties as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.toLowerCase().includes(normalizedTown)) {
      return true;
    }
  }
  return false;
};

const pickAutocompleteMatch = (
  response: GeocodeResponse | undefined,
  town: string
): GeocodeMatch | null => {
  const normalizedTown = normalizeLookupInput(town)?.toLowerCase();
  if (!response) {
    return null;
  }
  if (normalizedTown) {
    for (const feature of response.features ?? []) {
      if (!feature?.geometry || feature.geometry.type !== 'Point') {
        continue;
      }
      if (featureContainsTown(feature, normalizedTown)) {
        const point = feature.geometry as Point;
        const [lon, lat] = point.coordinates ?? [];
        if (Number.isFinite(lon) && Number.isFinite(lat)) {
          return {
            feature,
            coordinates: [lon, lat] as LonLat
          };
        }
      }
    }
  }
  return findFirstPointFeature(response);
};

/**
 * Attempts to resolve a town/ZIP combination by chaining structured and autocomplete geocoding calls.
 * The helper feeds previous results back into ORS endpoints to improve match quality for European style addresses.
 * @param ors - An initialized ORS client instance.
 * @param query - Town, ZIP, and optional country code inputs provided by the caller.
 * @param options - Optional ORS request overrides such as throttling or axios tweaks.
 * @returns A best-effort lookup result with coordinates, the winning stage, and debug attempts.
 * @example
 * ```ts
 * const lookup = await geocodeTownZipLookup(ors, {
 *   town: 'Nice',
 *   zip: '06000',
 *   countryCode: 'FR'
 * });
 * if (lookup.coordinates) {
 *   console.log(`Matched ${lookup.stage} at`, lookup.coordinates);
 * }
 * ```
 */
export const geocodeTownZipLookup = async (
  ors: ORS,
  query: GeocodeTownZipQuery,
  options?: RequestOptions
): Promise<GeocodeLookupResult> => {
  const attempts: GeocodeLookupAttempt[] = [];
  const town = normalizeLookupInput(query.town);
  const zip = normalizeLookupInput(query.zip);
  const countryCode = normalizeLookupInput(query.countryCode)?.toUpperCase();
  const structuredSize =
    typeof query.structuredSize === 'number' && query.structuredSize > 0
      ? query.structuredSize
      : undefined;
  const autocompleteSize =
    typeof query.autocompleteSize === 'number' && query.autocompleteSize > 0
      ? query.autocompleteSize
      : undefined;

  if (!zip && !town) {
    throw new Error('geocodeTownZipLookup requires at least a "zip" or "town" input.');
  }

  const buildStructuredParams = (
    overrides: Record<string, unknown>
  ): GeocodeCommonParams => {
    const params: GeocodeCommonParams = { ...overrides };
    if (countryCode) {
      params.country = countryCode;
    }
    if (structuredSize) {
      params.size = structuredSize;
    }
    return params;
  };

  let structuredPostalMatch: GeocodeMatch | null = null;

  if (zip && town) {
    const params = buildStructuredParams({
      postalcode: zip,
      locality: town
    });
    let stageMatch: GeocodeMatch | null = null;
    let stageError: unknown;
    try {
      const response = await ors.geocodeStructured<GeocodeResponse>(params, options);
      stageMatch = findFirstPointFeature(response);
    } catch (error) {
      stageError = error;
    }
    attempts.push({
      stage: 'structured_postal_locality',
      params,
      feature: stageMatch?.feature,
      coordinates: stageMatch?.coordinates,
      error: stageError
    });
    if (stageMatch) {
      return {
        stage: 'structured_postal_locality',
        feature: stageMatch.feature,
        coordinates: stageMatch.coordinates,
        attempts
      };
    }
  }

  if (zip) {
    const params = buildStructuredParams({ postalcode: zip });
    let stageError: unknown;
    try {
      const response = await ors.geocodeStructured<GeocodeResponse>(params, options);
      structuredPostalMatch = findFirstPointFeature(response);
    } catch (error) {
      stageError = error;
    }
    attempts.push({
      stage: 'structured_postal',
      params,
      feature: structuredPostalMatch?.feature,
      coordinates: structuredPostalMatch?.coordinates,
      error: stageError
    });
    if (structuredPostalMatch && !town) {
      return {
        stage: 'structured_postal',
        feature: structuredPostalMatch.feature,
        coordinates: structuredPostalMatch.coordinates,
        attempts
      };
    }
  }

  if (structuredPostalMatch && town) {
    const prefix = getTownPrefix(town);
    if (prefix.length) {
      const params: GeocodeCommonParams = { text: prefix };
      if (autocompleteSize) {
        params.size = autocompleteSize;
      }
      params['focus.point.lat'] = structuredPostalMatch.coordinates[1];
      params['focus.point.lon'] = structuredPostalMatch.coordinates[0];
      if (countryCode) {
        params['boundary.country'] = countryCode;
      }

      let stageError: unknown;
      let autoMatch: GeocodeMatch | null = null;
      try {
        const response = await ors.geocodeAutocomplete<GeocodeResponse>(params, options);
        autoMatch = pickAutocompleteMatch(response, town);
      } catch (error) {
        stageError = error;
      }
      attempts.push({
        stage: 'autocomplete',
        params,
        feature: autoMatch?.feature,
        coordinates: autoMatch?.coordinates,
        error: stageError
      });
      if (autoMatch) {
        return {
          stage: 'autocomplete',
          feature: autoMatch.feature,
          coordinates: autoMatch.coordinates,
          attempts
        };
      }
    }
  }

  if (structuredPostalMatch) {
    return {
      stage: 'structured_postal',
      feature: structuredPostalMatch.feature,
      coordinates: structuredPostalMatch.coordinates,
      attempts
    };
  }

  return {
    stage: 'not_found',
    attempts
  };
};
