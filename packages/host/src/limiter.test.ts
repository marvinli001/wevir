import { describe, expect, it } from 'vitest';
import { createLimiter } from './limiter.js';

describe('createLimiter', () => {
  it('同时最多跑 max 个，其余按顺序排队，结果与错误各归各的', async () => {
    const limit = createLimiter(2);
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    const task = (id: number, fail = false) =>
      limit(async () => {
        started.push(id);
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        if (fail) throw new Error(`task ${id}`);
        return id;
      });
    const results = await Promise.allSettled([task(1), task(2, true), task(3), task(4), task(5)]);
    expect(peak).toBe(2);
    expect(started).toEqual([1, 2, 3, 4, 5]);
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'rejected',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    expect((results[2] as PromiseFulfilledResult<number>).value).toBe(3);
  });
});
