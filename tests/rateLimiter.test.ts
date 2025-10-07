import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../src/rateLimiter.js';

describe('RateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('queues tasks when the capacity is exceeded', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter({ requests: 1, intervalMs: 1000 });
    const order: number[] = [];

    const first = limiter.schedule(async () => {
      order.push(1);
      return 'first';
    });

    const second = limiter.schedule(async () => {
      order.push(2);
      return 'second';
    });

    await expect(first).resolves.toBe('first');
    expect(order).toEqual([1]);

    const secondResolution = expect(second).resolves.toBe('second');
    expect(order).toEqual([1]);

    await vi.advanceTimersByTimeAsync(1000);
    await secondResolution;
    expect(order).toEqual([1, 2]);
  });
});
