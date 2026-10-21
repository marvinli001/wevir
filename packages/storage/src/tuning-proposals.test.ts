import { describe, expect, it } from 'vitest';
import { T0, T1, T2, useTempStorage } from './test-utils.js';
import type { TuningProposalRecord } from './tuning-proposals.js';

describe('tuning_proposals', () => {
  const { storage } = useTempStorage();

  const record = (id: string, overrides: Partial<TuningProposalRecord> = {}) => ({
    id,
    workspaceId: 'ws_01',
    sessionId: 'ses_01',
    kind: 'rule',
    title: 'Run build first',
    target: 'AGENTS.md',
    baseHash: 'abc',
    payload: { kind: 'rule', path: '/p/AGENTS.md', before: '', after: 'x\n' },
    evidence: [{ id: 'e1', text: 'x' }],
    status: 'pending',
    usage: { inputTokens: 10, outputTokens: 2 },
    createdAt: T0,
    ...overrides,
  });

  it('存取、按项目与状态列出（新的在前，已处理的按处理时刻）', () => {
    const db = storage();
    db.tuningProposals.insert(record('tpr_1'));
    db.tuningProposals.insert(record('tpr_2', { createdAt: T1, usage: undefined }));
    db.tuningProposals.insert(
      record('tpr_3', { workspaceId: 'ws_02', status: 'rejected', decidedAt: T2 }),
    );
    expect(db.tuningProposals.get('tpr_1')).toEqual(record('tpr_1'));
    expect(db.tuningProposals.get('tpr_2')).not.toHaveProperty('usage');
    expect(db.tuningProposals.get('tpr_x')).toBeUndefined();
    expect(db.tuningProposals.list().map((r) => r.id)).toEqual(['tpr_3', 'tpr_2', 'tpr_1']);
    expect(db.tuningProposals.list({ workspaceId: 'ws_01' }).map((r) => r.id)).toEqual([
      'tpr_2',
      'tpr_1',
    ]);
    expect(
      db.tuningProposals.list({ statuses: ['rejected', 'accepted'] }).map((r) => r.id),
    ).toEqual(['tpr_3']);
    expect(db.tuningProposals.list({ statuses: [] })).toEqual([]);
    expect(db.tuningProposals.list({ limit: 1 }).map((r) => r.id)).toEqual(['tpr_3']);
    // 同一次生成的几条同一刻建立：按写入（模型给出）的先后，不看 ID。
    db.tuningProposals.insert(record('tpr_5', { createdAt: T1 }));
    db.tuningProposals.insert(record('tpr_4', { createdAt: T1 }));
    expect(db.tuningProposals.list({ workspaceId: 'ws_01' }).map((r) => r.id)).toEqual([
      'tpr_2',
      'tpr_5',
      'tpr_4',
      'tpr_1',
    ]);
  });

  it('只改给出的字段；采纳了、没有版本的按处理先后列出；删除', () => {
    const db = storage();
    db.tuningProposals.insert(record('tpr_1'));
    db.tuningProposals.insert(record('tpr_2'));
    expect(db.tuningProposals.update('tpr_1', { payload: { kind: 'rule', after: 'y' } })).toBe(
      true,
    );
    expect(db.tuningProposals.get('tpr_1')).toMatchObject({
      payload: { after: 'y' },
      status: 'pending',
    });
    db.tuningProposals.update('tpr_2', { status: 'accepted', decidedAt: T1 });
    db.tuningProposals.update('tpr_1', { status: 'accepted', decidedAt: T2 });
    expect(db.tuningProposals.unversioned('ws_01').map((r) => r.id)).toEqual(['tpr_2', 'tpr_1']);
    db.tuningProposals.update('tpr_2', { versionId: 'pfv_1' });
    expect(db.tuningProposals.get('tpr_2')?.versionId).toBe('pfv_1');
    expect(db.tuningProposals.unversioned('ws_01').map((r) => r.id)).toEqual(['tpr_1']);
    expect(db.tuningProposals.update('tpr_x', { status: 'rejected' })).toBe(false);
    expect(db.tuningProposals.delete('tpr_1')).toBe(true);
    expect(db.tuningProposals.delete('tpr_1')).toBe(false);
  });
});
