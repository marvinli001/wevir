import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDir } from '../test-utils.js';
import { baselineSavings } from './baseline-reports.js';

const at = Date.parse('2026-11-04T00:00:00.000Z');
function report() {
  return {
    mode: 'real',
    generatedAt: new Date(at).toISOString(),
    commit: 'abcd123',
    model: 'deepseek-flash',
    providerId: 'deepseek-official',
    task: 'C0',
    configs: { A: { name: 'full' }, B: { name: 'core' } },
    priceSnapshot: { source: 'models.dev', at, fetchedAt: at },
    runs: Array.from({ length: 5 }, (_, i) =>
      ['A', 'B'].map((arm, index) => ({
        arm,
        pair: i + 1,
        order: i * 2 + index + 1,
        precision: 'exact',
        success: true,
        requests: { total: 2, agent: 1, capHit: false },
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        cost: {
          input: arm === 'A' ? 2 : 1,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: arm === 'A' ? 2 : 1,
        },
        ledgerMismatch: [] as string[],
      })),
    ).flat(),
  };
}

describe('baselineSavings', () => {
  const dir = useTempDir();
  it('returns only comparable exact results and honors time/model/provider filters', async () => {
    const folder = join(dir(), 'reports');
    expect(await baselineSavings(folder, 0, at + 1)).toBeUndefined();
    await mkdir(folder);
    await writeFile(join(folder, 'paired.json'), JSON.stringify(report()));
    expect(await baselineSavings(folder, at, at + 1)).toMatchObject({
      baseline: 'full · abcd123',
      candidate: 'core',
      precision: 'exact',
      pairs: 5,
      costPerTask: 1,
    });
    expect(await baselineSavings(folder, at + 1, at + 2)).toBeUndefined();
    expect(await baselineSavings(folder, 0, at + 1, { models: ['other'] })).toBeUndefined();
  });
  it('hides mock, unknown prices, bad measurements, weak samples and regressed success', async () => {
    const file = join(dir(), 'paired.json');
    for (const change of [
      (r: ReturnType<typeof report>) => {
        r.mode = 'mock';
      },
      (r: ReturnType<typeof report>) => {
        r.priceSnapshot.source = 'fixture';
      },
      (r: ReturnType<typeof report>) => {
        r.runs = r.runs.map((run, index) =>
          index === 0 ? { ...run, precision: 'estimate' } : run,
        );
      },
      (r: ReturnType<typeof report>) => {
        r.runs = r.runs.map((run, index) =>
          index === 0 ? { ...run, ledgerMismatch: ['missing'] } : run,
        );
      },
      (r: ReturnType<typeof report>) => {
        r.runs = r.runs.slice(0, 8);
      },
      (r: ReturnType<typeof report>) => {
        r.runs = r.runs.map((run, index) => (index === 1 ? { ...run, success: false } : run));
      },
    ]) {
      const r = report();
      change(r);
      await writeFile(file, JSON.stringify(r));
      expect(await baselineSavings(dir(), 0, at + 1)).toBeUndefined();
    }
    await writeFile(file, '{');
    expect(await baselineSavings(dir(), 0, at + 1)).toBeUndefined();
  });
});
