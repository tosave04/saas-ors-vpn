import { describe, expect, it } from 'vitest';
import type { FeatureCollection } from 'geojson';
import type { LonLat } from '../../src/utils/geo.js';
import {
  computeRouteProximity,
  isCoordinateNearRoute
} from '../../src/tools/routeProximity.js';

const parisDirections: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        name: 'Rue de Rivoli segment'
      },
      geometry: {
        type: 'LineString',
        coordinates: [
          [2.3522, 48.8566],
          [2.3622, 48.8566]
        ]
      }
    }
  ]
};

describe('routeProximity tools', () => {
  it('detects a coordinate aligned with the Paris route', () => {
    const pointOnRoute: LonLat = [2.355, 48.8566];

    const result = computeRouteProximity(parisDirections, pointOnRoute);

    expect(result.distanceKm).toBeLessThan(0.001);
    expect(result.isWithinTolerance).toBe(true);
  });

  it('computes the distance of a nearby coordinate in Paris', () => {
    const nearbyCoordinate: LonLat = [2.3572, 48.8568];

    const result = computeRouteProximity(parisDirections, nearbyCoordinate);

    expect(result.distanceKm).toBeCloseTo(0.02223, 3);
    expect(result.isWithinTolerance).toBe(true);
    expect(isCoordinateNearRoute(parisDirections, nearbyCoordinate, 0.03)).toBe(true);
  });

  it('rejects a coordinate located several kilometres away', () => {
    const farCoordinate: LonLat = [2.295, 48.858];

    expect(isCoordinateNearRoute(parisDirections, farCoordinate, 0.5)).toBe(false);
    const result = computeRouteProximity(parisDirections, farCoordinate, {
      toleranceKm: 1
    });
    expect(result.distanceKm).toBeGreaterThan(4);
    expect(result.isWithinTolerance).toBe(false);
  });
});
