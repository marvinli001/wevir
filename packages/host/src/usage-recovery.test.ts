import type { RoutingDecision, WevirEvent } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { usageRecoveryReports } from './usage-recovery.js';

const decision: RoutingDecision = {
  turnId: 'trn_1',
  originTurnId: 'trn_1',
  attempt: 1,
  from: { providerId: 'source', modelId: 'old' },
  to: { providerId: 'source', modelId: 'new' },
  skipped: [],
  at: '2026-11-03T00:00:00.000Z',
};
const event = (seq: number, type: string, payload: unknown) =>
  ({
    sessionId: 'ses_1',
    seq,
    type,
    payload,
    ts: decision.at,
    source: 'host',
  }) as WevirEvent;

describe('额度报告', () => {
  it('只选中目标不报成功，落地配置后才报告同来源换模型与次数', () => {
    const decided = event(1, 'routing.decided', decision);
    expect(usageRecoveryReports([decided], (id) => id)).toEqual([]);
    const configured = event(2, 'session.configured', {
      modelId: 'new',
      reason: 'usage_limit',
      failover: { attempt: 1, originTurnId: 'trn_1' },
    });
    expect(usageRecoveryReports([decided, configured], (id) => id)).toEqual([
      expect.objectContaining({
        seq: 2,
        turnId: 'trn_1',
        originTurnId: 'trn_1',
        text: '因额度从 source / old 接力到 source / new（第 1 次）',
      }),
    ]);
    expect(
      usageRecoveryReports(
        [decided, event(2, 'session.configured', { modelId: 'new' })],
        (id) => id,
      ),
    ).toEqual([]);
  });

  it('来源与模型里的密钥打码，取消自动继续不生成报告', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    const log = [
      event(1, 'routing.decided', { ...decision, to: { providerId: 'source', modelId: secret } }),
      event(2, 'session.configured', {
        modelId: secret,
        reason: 'usage_limit',
        failover: { attempt: 1, originTurnId: 'trn_1' },
      }),
      event(3, 'session.auto_continue', { turnId: 'trn_1', resumeAt: null }),
    ];
    const reports = usageRecoveryReports(log, () => secret);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.text).not.toContain(secret);
    expect(reports[0]?.text).toContain('[REDACTED]');
  });
});
