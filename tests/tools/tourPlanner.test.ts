import { describe, expect, it } from 'vitest';
import type { FeatureCollection } from 'geojson';
import { planDeliveryTours } from '../../src/tools/tourPlanner.js';

interface MatrixPayload {
  distances: number[][];
  durations: number[][];
}

const buildMockDirections = (coordinates: Array<[number, number]>): FeatureCollection => ({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates
      }
    }
  ]
});

const createMockOrs = (
  matrixPayload: MatrixPayload | Error,
  directionsPayload: FeatureCollection
) => {
  return {
    async matrix() {
      if (matrixPayload instanceof Error) {
        throw matrixPayload;
      }
      return matrixPayload;
    },
    async directions() {
      return directionsPayload;
    },
    async isochrones() {
      return { type: 'FeatureCollection', features: [] } satisfies FeatureCollection;
    }
  };
};

describe('planDeliveryTours', () => {
  it('builds a prioritized tour using ORS matrix data', async () => {
    const matrixPayload: MatrixPayload = {
      distances: [
        [0, 12_000, 18_000, 9_000],
        [12_000, 0, 5_000, 6_500],
        [18_000, 5_000, 0, 7_000],
        [9_000, 6_500, 7_000, 0]
      ],
      durations: [
        [0, 900, 1_200, 600],
        [900, 0, 420, 480],
        [1_200, 420, 0, 540],
        [600, 480, 540, 0]
      ]
    };

    const depot: [number, number] = [2.0, 48.0];
    const directionsPayload = buildMockDirections([
      depot,
      [2.15, 48.11],
      [2.1, 48.1],
      [2.05, 48.08],
      depot
    ]);

    const ors = createMockOrs(matrixPayload, directionsPayload);

    const result = await planDeliveryTours(
      ors as any,
      {
        depot,
        truckCapacityKg: 1_600,
        desiredTourCount: 1,
        clients: [
          {
            id: 'c1',
            name: 'Client 1',
            coordinate: [2.1, 48.1],
            weightKg: 600,
            orderDate: '2023-12-01'
          },
          {
            id: 'c2',
            name: 'Client 2',
            coordinate: [2.15, 48.11],
            weightKg: 700,
            orderDate: '2023-11-15',
            urgent: true
          },
          {
            id: 'c3',
            name: 'Client 3',
            coordinate: [2.05, 48.08],
            weightKg: 200,
            orderDate: '2024-01-05'
          }
        ]
      },
      {
        profile: 'driving-hgv',
        isoRangeMinutes: 45,
        referenceDate: new Date('2024-01-20T00:00:00Z'),
        maxCandidatesPerTour: 10
      }
    );

    expect(result.tours).toHaveLength(1);
    const [tour] = result.tours;
    expect(tour.stops.map((stop) => stop.id)).toEqual(['c2', 'c1', 'c3']);
    expect(tour.totalWeightKg).toBeCloseTo(1_500);
    expect(tour.routeGeoJson).toBeDefined();
    expect(result.unassigned).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('falls back to haversine distances when the matrix call fails', async () => {
    const depot: [number, number] = [1.9, 48.0];
    const failingOrs = createMockOrs(
      new Error('matrix down'),
      buildMockDirections([depot, [1.95, 48.02], [2.05, 48.04], depot])
    );

    const result = await planDeliveryTours(
      failingOrs as any,
      {
        depot,
        truckCapacityKg: 2_000,
        desiredTourCount: 1,
        clients: [
          {
            id: 'f1',
            name: 'Fallback 1',
            coordinate: [1.95, 48.02],
            weightKg: 500,
            orderDate: '2023-12-10'
          },
          {
            id: 'f2',
            name: 'Fallback 2',
            coordinate: [2.05, 48.04],
            weightKg: 600,
            orderDate: '2023-10-15'
          }
        ]
      },
      {
        isoRangeMinutes: 0,
        referenceDate: new Date('2024-01-20T00:00:00Z')
      }
    );

    expect(result.tours).toHaveLength(1);
    expect(result.tours[0].stops.map((stop) => stop.id)).toEqual(['f2', 'f1']);
    expect(result.warnings.join(' ')).toMatch(/haversine/i);
    expect(result.unassigned).toHaveLength(0);
  });
});
