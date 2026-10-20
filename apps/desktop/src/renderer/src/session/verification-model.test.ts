import type { RepairChain, SessionVerification, TurnId, VerificationRun } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  isQueued,
  latestRound,
  reasonLabel,
  repairForRound,
  stopLabel,
  summarizeRound,
  turnChecks,
} from './verification-model';

const TURN = 'trn_01JA2B3C4D5E6F7G8H9JKMNPQR' as TurnId;
const REPAIR_TURN = 'trn_01JA2B3C4D5E6F7G8H9JKMNPQS' as TurnId;

function run(id: string, roundId: string, patch: Partial<VerificationRun> = {}): VerificationRun {
  return {
    id: `vrn_${id.padStart(26, '0')}`,
    roundId: `vrd_${roundId.padStart(26, '0')}`,
    checkId: 'chk_00000000000000000000000001',
    checkRevision: 1,
    name: `check ${id}`,
    command: 'pnpm test',
    cwd: '',
    kind: 'test',
    trigger: 'after_turn',
    turnId: TURN,
    status: 'passed',
    queuedAt: '2026-10-20T00:00:00.000Z',
    ...patch,
  } as VerificationRun;
}

describe('summarizeRound', () => {
  it('在跑 > 有失败 > 环境不可用 > 全部通过；其余是未验证', () => {
    expect(summarizeRound([])).toBeUndefined();
    expect(summarizeRound([run('1', '1'), run('2', '1', { status: 'running' })])?.tone).toBe(
      'running',
    );
    expect(summarizeRound([run('1', '1'), run('2', '1', { status: 'timed_out' })])).toMatchObject({
      tone: 'failed',
      passed: 1,
      total: 2,
      key: 'failed:1/2',
    });
    expect(summarizeRound([run('1', '1', { status: 'environment_unavailable' })])?.tone).toBe(
      'environment_unavailable',
    );
    expect(summarizeRound([run('1', '1'), run('2', '1')])?.tone).toBe('passed');
    expect(summarizeRound([run('1', '1'), run('2', '1', { status: 'stale' })])?.tone).toBe(
      'unverified',
    );
  });
});

describe('turnChecks', () => {
  it('每个回合取它触发的一轮；手动运行的不记在回合上', () => {
    const verification: SessionVerification = {
      acceptance: { status: 'accepted', updatedAt: '2026-10-20T00:00:01.000Z' },
      runs: [
        run('1', '1', { status: 'failed' }),
        run('2', '2', { trigger: 'repair', turnId: REPAIR_TURN }),
        run('3', '3', { trigger: 'manual', turnId: undefined }),
      ],
    };
    const map = turnChecks(verification);
    expect(map.get(TURN)?.tone).toBe('failed');
    expect(map.get(REPAIR_TURN)?.tone).toBe('passed');
    expect(map.size).toBe(2);
    expect(turnChecks(undefined).size).toBe(0);
  });
});

describe('latestRound', () => {
  it('验收那一轮；验收没有轮次时取最后一条记录的那一轮', () => {
    const runs = [run('1', '1'), run('2', '2'), run('3', '2')];
    expect(
      latestRound({
        acceptance: {
          status: 'failed',
          roundId: runs[0]?.roundId,
          updatedAt: '2026-10-20T00:00:01.000Z',
        },
        runs,
      }).map((item) => item.id),
    ).toEqual([runs[0]?.id]);
    expect(
      latestRound({
        acceptance: { status: 'unverified', updatedAt: '2026-10-20T00:00:01.000Z' },
        runs,
      }),
    ).toHaveLength(2);
    expect(latestRound(undefined)).toEqual([]);
  });
});

describe('labels', () => {
  it('认识的原因有文案，不认识的没有', () => {
    expect(reasonLabel('dependencies_missing')).toBe('verification.reason.dependencies_missing');
    expect(reasonLabel('something_new')).toBeUndefined();
    expect(stopLabel('limit')).toBe('verification.stop.limit');
    expect(stopLabel(undefined)).toBeUndefined();
    expect(isQueued(run('1', '1', { status: 'running' }))).toBe(true);
    expect(
      isQueued(run('1', '1', { status: 'running', startedAt: '2026-10-20T00:00:00.000Z' })),
    ).toBe(false);
  });
});

describe('repairForRound', () => {
  const repair: RepairChain = {
    id: 'rpr_00000000000000000000000001',
    roundId: 'vrd_00000000000000000000000001',
    lastRoundId: 'vrd_00000000000000000000000002',
    originTurnId: TURN,
    status: 'passed',
    attempt: 1,
    maxAttempts: 2,
    turnIds: [REPAIR_TURN],
    startedAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
  };

  it('链的那几轮显示它，之后手动运行的一轮不显示；进行中的总是显示', () => {
    expect(repairForRound(repair, repair.lastRoundId)).toBe(repair);
    expect(repairForRound(repair, repair.roundId)).toBe(repair);
    expect(repairForRound(repair, 'vrd_00000000000000000000000003')).toBeUndefined();
    const running: RepairChain = { ...repair, status: 'running' };
    expect(repairForRound(running, undefined)).toBe(running);
    expect(repairForRound(undefined, repair.roundId)).toBeUndefined();
  });
});
