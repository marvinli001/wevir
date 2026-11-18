import type { VerificationEvidence } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { requiredChecks } from './exec-checks.js';

describe('required exec checks', () => {
  const evidence: VerificationEvidence = {
    status: 'partial',
    checks: [
      { checkId: 'chk_1', name: 'Lint', kind: 'lint', status: 'passed', outputAvailable: true },
      {
        checkId: 'chk_2',
        name: 'Tests',
        kind: 'test',
        status: 'config_changed',
        outputAvailable: true,
      },
    ],
  };

  it('checks all configured items or resolves the selected names', () => {
    expect(requiredChecks(true, evidence)).toEqual([
      { checkId: 'chk_1', name: 'Lint', status: 'passed' },
      { checkId: 'chk_2', name: 'Tests', status: 'config_changed', reason: 'config_changed' },
    ]);
    expect(requiredChecks(['Lint', 'Never configured'], evidence)).toEqual([
      { checkId: 'chk_1', name: 'Lint', status: 'passed' },
      { name: 'Never configured', status: 'not_run', reason: 'unknown_check' },
    ]);
  });

  it('reports unavailable evidence without claiming anything passed', () => {
    expect(requiredChecks(true, { status: 'unconfigured', checks: [] })).toEqual([
      { name: '*', status: 'not_run', reason: 'not_configured' },
    ]);
    expect(requiredChecks(['Lint'])).toEqual([
      { name: 'Lint', status: 'unbound', reason: 'unbound' },
    ]);
  });
});
