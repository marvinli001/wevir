import { describe, expect, it } from 'vitest';
import { T0, T1, useTempStorage } from './test-utils.js';

describe('approval_rules', () => {
  const { storage } = useTempStorage();

  const rule = (id: string, prefix: string[], workspaceId?: string) => ({
    id,
    ...(workspaceId !== undefined && { workspaceId }),
    kind: 'command_prefix',
    prefix,
    source: 'approval',
    createdAt: T0,
    useCount: 0,
  });

  it('同一范围同一前缀只存一条，按范围列出，记录使用，删除', () => {
    const db = storage();
    expect(db.approvalRules.insert(rule('arl_1', ['git', 'status']))).toEqual(
      rule('arl_1', ['git', 'status']),
    );
    expect(db.approvalRules.insert(rule('arl_2', ['git', 'status'])).id).toBe('arl_1');
    expect(db.approvalRules.insert(rule('arl_3', ['git', 'status'], 'ws_a')).id).toBe('arl_3');
    db.approvalRules.insert({
      ...rule('arl_4', ['ls'], 'ws_b'),
      source: 'suggestion',
      sourceSessionId: 'ses_1',
      sourceApprovalId: 'apv_1',
    });

    expect(db.approvalRules.list().map((r) => r.id)).toEqual(['arl_1', 'arl_3', 'arl_4']);
    expect(db.approvalRules.listEffective('ws_a').map((r) => r.id)).toEqual(['arl_1', 'arl_3']);
    expect(db.approvalRules.listEffective(undefined).map((r) => r.id)).toEqual(['arl_1']);
    expect(db.approvalRules.get('arl_4')).toMatchObject({
      sourceSessionId: 'ses_1',
      sourceApprovalId: 'apv_1',
    });

    db.approvalRules.recordUse(['arl_1', 'arl_1'], T1);
    expect(db.approvalRules.get('arl_1')).toMatchObject({ useCount: 2, lastUsedAt: T1 });

    expect(db.approvalRules.remove('arl_1')).toBe(true);
    expect(db.approvalRules.remove('arl_1')).toBe(false);
    expect(db.approvalRules.removeByWorkspace('ws_b')).toBe(1);
    expect(db.approvalRules.list().map((r) => r.id)).toEqual(['arl_3']);
  });
});
