import { describe, expect, it, vi } from 'vitest';
import type { LonLat } from '../../src/utils/geo.js';
import { planDeliveryToursVRP } from '../../src/tools/vrpPlanner.js';

const depot: LonLat = [2.0, 48.0];

const buildStep = (
  type: 'start' | 'end' | 'job',
  data: Partial<{
    job: number;
    location: LonLat;
    arrival: number;
    distance: number;
  }>
) => ({
  type,
  job: data.job,
  location: data.location,
  arrival: data.arrival,
  distance: data.distance
});

describe('planDeliveryToursVRP', () => {
  it('builds tours based on the ORS optimization response and tracks unassigned clients', async () => {
    const optimizationResponse = {
      code: 0,
      summary: {
        cost: 1200,
        distance: 26_000,
        duration: 5_400
      },
      routes: [
        {
          vehicle: 1,
          distance: 18_000,
          duration: 3_600,
          steps: [
            buildStep('start', { location: depot, arrival: 0, distance: 0 }),
            buildStep('job', { job: 1, location: [2.05, 48.05], arrival: 900, distance: 8_000 }),
            buildStep('job', { job: 2, location: [2.1, 48.07], arrival: 1_800, distance: 14_000 }),
            buildStep('end', { location: depot, arrival: 3_600, distance: 18_000 })
          ]
        }
      ],
      unassigned: [
        { id: 3 }
      ]
    };

    const optimizationMock = vi.fn().mockResolvedValue(optimizationResponse);
    const ors = {
      optimization: optimizationMock
    };

    const result = await planDeliveryToursVRP(
      ors as any,
      {
        depot,
        truckCapacityKg: 1_800,
        desiredTourCount: 2,
        clients: [
          {
            id: 'job_1',
            name: 'Client 1',
            coordinate: [2.05, 48.05],
            weightKg: 500,
            orderDate: '2023-10-10'
          },
          {
            id: 'job_2',
            name: 'Client 2',
            coordinate: [2.1, 48.07],
            weightKg: 700,
            orderDate: '2023-09-15',
            urgent: true
          },
          {
            id: 'job_3',
            name: 'Client 3',
            coordinate: [1.95, 47.98],
            weightKg: 400,
            orderDate: '2023-11-01'
          }
        ]
      },
      {
        serviceTimeMinutes: 15,
        shiftDurationHours: 9
      }
    );

    expect(optimizationMock).toHaveBeenCalledTimes(1);
    const [payload] = optimizationMock.mock.calls[0];
    expect(payload.vehicles).toHaveLength(2);
    expect(payload.jobs).toHaveLength(3);
    expect(result.tours).toHaveLength(1);
    expect(result.tours[0].stops.map((stop) => stop.id)).toEqual(['job_1', 'job_2']);
    expect(result.tours[0].routeGeoJson).toBeDefined();
    expect(result.unassigned.map((client) => client.id)).toContain('job_3');
    expect(result.solver?.vehiclesUsed).toBe(1);
    expect(result.warnings.join(' ')).toMatch(/unassigned/i);
  });

  it('clamps vehicles to solver limits and reports warnings', async () => {
    const optimizationMock = vi.fn().mockResolvedValue({
      routes: [],
      unassigned: []
    });
    const ors = { optimization: optimizationMock };

    const result = await planDeliveryToursVRP(
      ors as any,
      {
        depot,
        truckCapacityKg: 2_000,
        desiredTourCount: 5,
        clients: [
          {
            id: 'job_1',
            name: 'Client 1',
            coordinate: [2.05, 48.05],
            weightKg: 500,
            orderDate: '2023-10-10'
          }
        ]
      }
    );

    expect(result.warnings.join(' ')).toMatch(/limit/i);
    expect(optimizationMock).toHaveBeenCalledTimes(1);
  });
});
