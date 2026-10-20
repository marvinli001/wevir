import { describe, expect, it } from 'vitest';
import type { ApprovalRecord } from './approvals.js';
import { seedSession, T0, T1, T2, useTempStorage } from './test-utils.js';

const options = [
  { optionId: 'allow-once', label: 'Allow once', kind: 'allow_once', category: 'allow' },
  { optionId: 'reject-once', label: 'Reject', kind: 'reject_once', category: 'reject' },
];

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: 'apr_01',
    sessionId: 'ses_01',
    turnId: 'trn_01',
    toolCallId: 'call_1',
    options,
    detail: { toolName: 'write', display: { kind: 'write', paths: ['/tmp/x'] }, input: {} },
    status: 'pending',
    createdAt: T0,
    ...overrides,
  };
}

const desktop = { deviceId: 'dev-1', clientId: 'cli-1', clientKind: 'desktop' };

describe('approvals', () => {
  const { storage } = useTempStorage();

  it('插入与读取；detail 可以是 null', () => {
    const s = storage();
    seedSession(s);
    s.approvals.insert(approval());
    s.approvals.insert(approval({ id: 'apr_02', detail: null, createdAt: T1 }));
    expect(s.approvals.get('apr_01')).toEqual(approval());
    expect(s.approvals.get('apr_02')).toEqual(
      approval({ id: 'apr_02', detail: null, createdAt: T1 }),
    );
    expect(s.approvals.get('apr_missing')).toBeUndefined();
  });

  it('id 唯一，会话必须存在', () => {
    const s = storage();
    expect(() => s.approvals.insert(approval())).toThrow(/FOREIGN KEY constraint failed/);
    seedSession(s);
    s.approvals.insert(approval());
    expect(() => s.approvals.insert(approval())).toThrow(/UNIQUE constraint failed: approvals\.id/);
  });

  it('用户决定记录 decidedBy；首个决定生效，之后的 resolve 不改任何东西', () => {
    const s = storage();
    seedSession(s);
    s.approvals.insert(approval());
    const first = {
      status: 'approved',
      resolvedAt: T1,
      resolution: { reason: 'user', optionId: 'allow-once', decidedBy: desktop },
    };
    expect(s.approvals.resolve('apr_01', first)).toBe(true);
    expect(
      s.approvals.resolve('apr_01', {
        status: 'denied',
        resolvedAt: T2,
        resolution: {
          reason: 'user',
          optionId: 'reject-once',
          decidedBy: { ...desktop, clientKind: 'cli' },
        },
      }),
    ).toBe(false);
    expect(s.approvals.get('apr_01')).toEqual(approval({ ...first }));
    expect(s.approvals.resolve('apr_missing', first)).toBe(false);
  });

  it('Host 结算没有 optionId 与 decidedBy', () => {
    const s = storage();
    seedSession(s);
    s.approvals.insert(approval());
    s.approvals.resolve('apr_01', {
      status: 'cancelled',
      resolvedAt: T1,
      resolution: { reason: 'turn_cancelled' },
    });
    expect(s.approvals.get('apr_01')).toEqual(
      approval({ status: 'cancelled', resolvedAt: T1, resolution: { reason: 'turn_cancelled' } }),
    );
  });

  it('resolve 的 status 不能是 pending', () => {
    expect(() =>
      storage().approvals.resolve('apr_01', {
        status: 'pending',
        resolvedAt: T1,
        resolution: { reason: 'user' },
      }),
    ).toThrow(TypeError);
  });

  it('按会话与状态列出；列出所有会话的 pending', () => {
    const s = storage();
    seedSession(s);
    seedSession(s, { id: 'ses_02', engineSessionId: 'e2' });
    s.approvals.insert(approval({ id: 'apr_1' }));
    s.approvals.insert(approval({ id: 'apr_2', createdAt: T1 }));
    s.approvals.insert(approval({ id: 'apr_3', sessionId: 'ses_02', createdAt: T2 }));
    s.approvals.resolve('apr_1', {
      status: 'expired',
      resolvedAt: T2,
      resolution: { reason: 'host_restarted' },
    });

    const ids = (records: ApprovalRecord[]) => records.map((a) => a.id);
    expect(ids(s.approvals.listBySession('ses_01'))).toEqual(['apr_1', 'apr_2']);
    expect(ids(s.approvals.listBySession('ses_01', { status: 'pending' }))).toEqual(['apr_2']);
    expect(ids(s.approvals.listBySession('ses_01', { status: 'expired' }))).toEqual(['apr_1']);
    expect(ids(s.approvals.listPending())).toEqual(['apr_2', 'apr_3']);
  });

  it('用户手动允许过的审批带项目，最近的在前，可按项目过滤', () => {
    const s = storage();
    seedSession(s, { id: 'ses_a', workspaceId: 'ws_a' });
    seedSession(s, { id: 'ses_b', workspaceId: 'ws_b', engineSessionId: 'eng_b' });
    const approve = (
      id: string,
      sessionId: string,
      at: string,
      reason = 'user',
      status = 'approved',
    ) => {
      s.approvals.insert(approval({ id, sessionId, createdAt: at }));
      s.approvals.resolve(id, {
        status,
        resolvedAt: at,
        resolution: {
          reason,
          optionId: 'allow-once',
          ...(reason === 'user' && { decidedBy: desktop }),
        },
      });
    };
    approve('apr_1', 'ses_a', T0);
    approve('apr_2', 'ses_b', T1);
    approve('apr_3', 'ses_a', T2, 'rule');
    approve('apr_4', 'ses_a', T2, 'user', 'denied');
    const ids = (records: { id: string; workspaceId: string }[]) =>
      records.map((r) => `${r.id}@${r.workspaceId}`);
    expect(ids(s.approvals.listUserApproved({ limit: 10 }))).toEqual(['apr_2@ws_b', 'apr_1@ws_a']);
    expect(ids(s.approvals.listUserApproved({ workspaceId: 'ws_a', limit: 10 }))).toEqual([
      'apr_1@ws_a',
    ]);
    expect(ids(s.approvals.listUserApproved({ limit: 1 }))).toEqual(['apr_2@ws_b']);
  });
});
