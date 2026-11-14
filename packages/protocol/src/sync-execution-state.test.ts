import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { executionStateSchema } from './sync-execution-state.js';
import { schemas } from './sync-wire.js';

describe('execution state artifact revision 2', () => {
  it('accepts all shared states and rejects invalid or secret-bearing snapshots', () => {
    const fixtures = JSON.parse(
      readFileSync(
        new URL('../../../contracts/wevir-sync/v1-r2/fixtures.json', import.meta.url),
        'utf8',
      ),
    );
    for (const [values, accepted] of [
      [fixtures.valid, true],
      [fixtures.invalid, false],
    ] as const)
      for (const value of values)
        expect(executionStateSchema.safeParse(value).success, JSON.stringify(value)).toBe(accepted);
    expect(
      schemas.execution.safeParse({ runId: 'run_fixture', epoch: '7', state: 'held' }).success,
    ).toBe(false);
  });
});
