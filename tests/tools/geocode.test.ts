import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestOptions } from '../../src/types.js';
import { geocodeTownZipLookup } from '../../src/tools/geocode.js';
import type ORS from '../../src/ors.js';

const pointFeature = (
  lon: number,
  lat: number,
  props: Record<string, unknown> = {}
) => ({
  type: 'Feature',
  geometry: {
    type: 'Point',
    coordinates: [lon, lat]
  },
  properties: props
});

describe('geocodeTownZipLookup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the structured postal + locality match when available', async () => {
    const geocodeStructured = vi.fn().mockResolvedValue({
      features: [pointFeature(7.19, 43.7)]
    });
    const geocodeAutocomplete = vi.fn();
    const ors = { geocodeStructured, geocodeAutocomplete } as unknown as ORS;

    const result = await geocodeTownZipLookup(ors, {
      town: 'Nice',
      zip: '06000',
      countryCode: 'fr',
      structuredSize: 5
    });

    expect(result.stage).toBe('structured_postal_locality');
    expect(result.coordinates).toEqual([7.19, 43.7]);
    expect(result.attempts).toHaveLength(1);
    expect(geocodeStructured).toHaveBeenCalledTimes(1);
    expect(geocodeStructured).toHaveBeenCalledWith(
      { postalcode: '06000', locality: 'Nice', country: 'FR', size: 5 },
      undefined
    );
    expect(geocodeAutocomplete).not.toHaveBeenCalled();
  });

  it('falls back to postal code only and enriches the result with autocomplete', async () => {
    const geocodeStructured = vi
      .fn()
      .mockResolvedValueOnce({ features: [] })
      .mockResolvedValueOnce({
        features: [pointFeature(7.19, 43.7, { locality: 'Nice' })]
      });
    const geocodeAutocomplete = vi.fn().mockResolvedValue({
      features: [
        pointFeature(7.2, 43.71, { locality: 'Nice', label: 'Nice, FR' })
      ]
    });
    const ors = { geocodeStructured, geocodeAutocomplete } as unknown as ORS;
    const options: RequestOptions = { axios: { timeout: 3_000 } };

    const result = await geocodeTownZipLookup(
      ors,
      {
        town: 'Nice',
        zip: '06000',
        countryCode: 'FR',
        structuredSize: 4,
        autocompleteSize: 3
      },
      options
    );

    expect(result.stage).toBe('autocomplete');
    expect(result.coordinates).toEqual([7.2, 43.71]);
    expect(result.attempts).toHaveLength(3);

    expect(geocodeStructured).toHaveBeenNthCalledWith(
      1,
      { postalcode: '06000', locality: 'Nice', country: 'FR', size: 4 },
      options
    );
    expect(geocodeStructured).toHaveBeenNthCalledWith(
      2,
      { postalcode: '06000', country: 'FR', size: 4 },
      options
    );
    expect(geocodeAutocomplete).toHaveBeenCalledWith(
      {
        text: 'Nic',
        size: 3,
        'focus.point.lat': 43.7,
        'focus.point.lon': 7.19,
        'boundary.country': 'FR'
      },
      options
    );
  });

  it('returns the structured postal match when autocomplete finds nothing', async () => {
    const geocodeStructured = vi
      .fn()
      .mockResolvedValueOnce({ features: [] })
      .mockResolvedValueOnce({
        features: [pointFeature(7.19, 43.7, { locality: 'Nice' })]
      });
    const geocodeAutocomplete = vi.fn().mockResolvedValue({ features: [] });
    const ors = { geocodeStructured, geocodeAutocomplete } as unknown as ORS;

    const result = await geocodeTownZipLookup(ors, {
      town: 'Nice',
      zip: '06000'
    });

    expect(result.stage).toBe('structured_postal');
    expect(result.coordinates).toEqual([7.19, 43.7]);
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts[2]?.stage).toBe('autocomplete');
    expect(result.attempts[2]?.feature).toBeUndefined();
  });

  it('throws when neither zip nor town is provided', async () => {
    const geocodeStructured = vi.fn();
    const geocodeAutocomplete = vi.fn();
    const ors = { geocodeStructured, geocodeAutocomplete } as unknown as ORS;

    await expect(
      geocodeTownZipLookup(ors, { countryCode: 'FR' })
    ).rejects.toThrow(/zip/);
    expect(geocodeStructured).not.toHaveBeenCalled();
    expect(geocodeAutocomplete).not.toHaveBeenCalled();
  });
});
