import { describe, expect, it } from 'vitest';
import { CdpSessionQueue } from './cdp-session-queue.js';

describe('CdpSessionQueue', () => {
  it('runs tasks in order', async () => {
    const queue = new CdpSessionQueue();
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((value) =>
        queue.run(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5 - value));
          order.push(value);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);
  });

  it('a task that never finishes holds the next one back only up to maxWaitMs, once', async () => {
    const queue = new CdpSessionQueue(30);
    void queue.run(() => new Promise<never>(() => {}));
    const started = Date.now();
    await queue.run(async () => 'second');
    const second = Date.now() - started;
    expect(second).toBeGreaterThanOrEqual(25);
    const third = Date.now();
    await queue.run(async () => 'third');
    expect(Date.now() - third).toBeLessThan(25);
  });
});
