type Task = {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

export interface RateLimiterOptions {
  requests: number;
  intervalMs: number;
}

export class RateLimiter {
  private readonly capacity: number;
  private readonly intervalMs: number;
  private tokens: number;
  private lastRefill: number;
  private queue: Task[] = [];
  private timer?: NodeJS.Timeout;

  constructor(options: RateLimiterOptions) {
    if (options.requests <= 0 || options.intervalMs <= 0) {
      throw new Error('Rate limiter requires positive request and interval values.');
    }
    this.capacity = options.requests;
    this.intervalMs = options.intervalMs;
    this.tokens = options.requests;
    this.lastRefill = Date.now();
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    this.refillTokens();
    if (this.tokens > 0 && this.queue.length === 0) {
      this.tokens -= 1;
      return fn();
    }

    return new Promise<T>((resolve, reject) => {
      const task: Task = {
        fn: () => fn() as Promise<unknown>,
        resolve: (value) => resolve(value as T),
        reject
      };
      this.queue.push(task);
      this.ensureProcessingScheduled();
    });
  }

  private ensureProcessingScheduled() {
    if (this.timer) {
      return;
    }
    const delay = Math.max(0, this.intervalMs - (Date.now() - this.lastRefill));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.processQueue();
    }, delay);
  }

  private processQueue() {
    this.refillTokens();
    while (this.tokens > 0 && this.queue.length > 0) {
      const task = this.queue.shift() as Task;
      this.tokens -= 1;
      task.fn().then(task.resolve, task.reject);
    }

    if (this.queue.length > 0) {
      this.ensureProcessingScheduled();
    }
  }

  private refillTokens() {
    const now = Date.now();
    if (this.tokens >= this.capacity) {
      this.lastRefill = now;
      return;
    }

    const elapsed = now - this.lastRefill;
    if (elapsed >= this.intervalMs) {
      const intervals = Math.floor(elapsed / this.intervalMs);
      this.tokens = Math.min(this.capacity, this.tokens + intervals * this.capacity);
      this.lastRefill += intervals * this.intervalMs;
    }
  }
}
