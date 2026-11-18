import type { CodeState, VerificationRun } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { type EvidenceCheck, evaluateVerification } from './evidence.js';

const check = { id: 'chk_test', name: 'Tests', kind: 'test', revision: 1 } satisfies EvidenceCheck;
const lint = { ...check, id: 'chk_lint', name: 'Lint', kind: 'lint' } satisfies EvidenceCheck;
const codeState = { kind: 'git', head: 'head', tree: 'tree' } satisfies CodeState;
const working = { kind: 'working_tree', codeState } as const;
const run = {
  id: 'vrn_test',
  checkId: check.id,
  checkRevision: 1,
  codeState,
  status: 'passed',
  queuedAt: '2026-11-18T00:00:00.000Z',
} satisfies Partial<VerificationRun>;

describe('verification evidence', () => {
  it('only passes when every configured check passed, ignoring deleted checks', () => {
    expect(evaluateVerification([], [run], working)).toMatchObject({
      status: 'unconfigured',
      checks: [],
    });
    expect(evaluateVerification([check], [run], working).status).toBe('passed');
    expect(evaluateVerification([check, lint], [run], working)).toMatchObject({
      status: 'partial',
      checks: [{ status: 'passed' }, { status: 'not_run' }],
    });
    expect(evaluateVerification([lint], [], working).status).toBe('unverified');
  });

  it.each(['failed', 'timed_out', 'running', 'cancelled', 'environment_unavailable'] as const)(
    'keeps a matching run with status %s',
    (status) => {
      expect(evaluateVerification([check], [{ ...run, status }], working)).toMatchObject({
        status:
          status === 'timed_out'
            ? 'failed'
            : status === 'failed' || status === 'running'
              ? status
              : 'unverified',
        checks: [{ status }],
      });
    },
  );

  it('uses HEAD and tree for the worktree and tree alone for staged and committed contents', () => {
    expect(
      evaluateVerification([check], [run], {
        kind: 'working_tree',
        codeState: { ...codeState, head: 'other-worktree-head' },
      }).checks[0]?.status,
    ).toBe('stale');
    expect(
      evaluateVerification([check], [run], {
        kind: 'staged',
        tree: 'partially-staged',
      }).checks[0]?.status,
    ).toBe('stale');
    expect(evaluateVerification([check], [run], { kind: 'staged', tree: 'tree' }).status).toBe(
      'passed',
    );
    expect(evaluateVerification([check], [run], { kind: 'commit', tree: 'tree' }).status).toBe(
      'passed',
    );
  });

  it('uses the latest update of the most recent matching run', () => {
    const other = {
      ...run,
      id: 'vrn_other',
      queuedAt: '2026-11-18T00:00:01.000Z',
      codeState: { ...codeState, tree: 'other' },
    } as const;
    expect(evaluateVerification([check], [run, other], working).status).toBe('passed');
    expect(
      evaluateVerification(
        [check],
        [{ ...run, status: 'running' }, { ...run, status: 'failed' }, other],
        working,
      ).status,
    ).toBe('failed');
  });

  it('distinguishes an unbound run or target from an old configuration', () => {
    expect(evaluateVerification([check], [run], { kind: 'staged' }).checks[0]?.status).toBe(
      'unbound',
    );
    expect(
      evaluateVerification(
        [check],
        [
          {
            ...run,
            codeState: {
              kind: 'none',
              reason: 'not_git',
            },
          },
        ],
        working,
      ).checks[0]?.status,
    ).toBe('unbound');
    expect(
      evaluateVerification([{ ...check, revision: 2 }], [run], working).checks[0]?.status,
    ).toBe('config_changed');
  });
});
