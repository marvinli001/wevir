import { WevirRpcError } from '@wevir/client-sdk';
import { ErrorCode, type InboxItem } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalNotVerifiedError, setApprovalGate, verifyApproval } from './approval-gate';
import {
  applyInboxChange,
  approvalConflict,
  expiryOf,
  inboxTarget,
  isHighRisk,
  mergeInboxes,
  questionOutcome,
  quickQuestion,
} from './inbox';
import { approvalItem, failedItem } from './inbox-test-utils';

function questionItem(patch: Record<string, unknown> = {}): InboxItem {
  return {
    id: 'question:qst_1',
    kind: 'question',
    sessionId: 'ses_2',
    title: '查依赖',
    summary: '做到哪一步？',
    createdAt: '2026-10-27T08:00:00.000Z',
    ref: {
      questionId: 'qst_1',
      turnId: 'trn_1',
      questions: [
        { id: 'q', question: '做到哪一步？', options: [{ label: '全部' }, { label: '一半' }] },
      ],
      ...patch,
    },
  } as InboxItem;
}

const rpc = (name: 'ALREADY_DECIDED' | 'APPROVAL_EXPIRED' | 'INVALID_PARAMS', data?: unknown) =>
  new WevirRpcError('approval.respond', { code: ErrorCode[name], message: 'x', data });

describe('applyInboxChange', () => {
  it('版本接上时增删，新的在前；接不上时要重读', () => {
    const list = { items: [approvalItem('apr_1')], inboxVersion: 4 };
    const next = applyInboxChange(list, {
      inboxVersion: 5,
      upserted: [approvalItem('apr_2')],
      removed: ['approval:apr_1'],
    });
    expect(next?.items.map((i) => i.id)).toEqual(['approval:apr_2']);
    expect(applyInboxChange(list, { inboxVersion: 6, upserted: [], removed: [] })).toBeUndefined();
  });
});

describe('mergeInboxes', () => {
  it('要作答的在前，先到期的在前，其余新的在前；标明电脑', () => {
    const merged = mergeInboxes([
      {
        computer: 'studio',
        computerName: 'Studio',
        items: [
          failedItem('trn_9', '2026-10-27T09:00:00.000Z'),
          approvalItem('apr_old', { createdAt: '2026-10-27T07:00:00.000Z' }),
        ],
      },
      {
        computer: 'mini',
        computerName: 'Mac mini',
        items: [
          approvalItem('apr_new', { createdAt: '2026-10-27T08:30:00.000Z' }),
          approvalItem('apr_soon', { expiresAt: '2026-10-27T08:10:00.000Z' }),
          approvalItem('apr_later', { expiresAt: '2026-10-27T08:40:00.000Z' }),
        ],
      },
    ]);
    expect(merged.map((e) => e.key)).toEqual([
      'mini/approval:apr_soon',
      'mini/approval:apr_later',
      'mini/approval:apr_new',
      'studio/approval:apr_old',
      'studio/turn_failed:trn_9',
    ]);
    expect(merged[0]).toMatchObject({ computer: 'mini', computerName: 'Mac mini' });
  });

  it('同样的时间按电脑与 ID 排，顺序稳定', () => {
    const items = [approvalItem('apr_b'), approvalItem('apr_a')];
    const merged = mergeInboxes([
      { computer: 'b', computerName: 'B', items },
      { computer: 'a', computerName: 'A', items },
    ]);
    expect(merged.map((e) => e.key)).toEqual([
      'a/approval:apr_a',
      'a/approval:apr_b',
      'b/approval:apr_a',
      'b/approval:apr_b',
    ]);
  });
});

describe('expiryOf', () => {
  const now = new Date('2026-10-27T08:00:00.000Z');
  it('没有期限、还剩几分钟（向上取整）、已过期', () => {
    expect(expiryOf(approvalItem('a'), now)).toEqual({ kind: 'none' });
    expect(expiryOf({ expiresAt: '2026-10-27T08:04:01.000Z' }, now)).toEqual({
      kind: 'pending',
      minutes: 5,
    });
    expect(expiryOf({ expiresAt: '2026-10-27T08:00:00.000Z' }, now)).toEqual({ kind: 'expired' });
  });
});

describe('approvalConflict', () => {
  const self = { clientId: 'mobile-1' };
  it('电脑上先批准了：谁、何时、结果', () => {
    const error = rpc('ALREADY_DECIDED', {
      approvalId: 'apr_1',
      status: 'approved',
      resolution: {
        reason: 'user',
        optionId: 'allow-once',
        decidedBy: { deviceId: 'dev-mac', clientId: 'desk-1', clientKind: 'desktop' },
      },
      resolvedAt: '2026-10-27T08:01:00.000Z',
    });
    expect(approvalConflict(error, self)).toEqual({
      kind: 'elsewhere',
      by: 'desktop',
      at: '2026-10-27T08:01:00.000Z',
      result: 'approved',
    });
  });

  it('本机重复作答、规则、取消、过期；旧 Host 没有时刻', () => {
    const mine = rpc('ALREADY_DECIDED', {
      approvalId: 'apr_1',
      status: 'denied',
      resolution: {
        reason: 'user',
        optionId: 'reject-once',
        decidedBy: { deviceId: 'dev-p', clientId: 'mobile-1', clientKind: 'mobile' },
      },
    });
    expect(approvalConflict(mine, self)).toEqual({
      kind: 'elsewhere',
      by: 'this_device',
      result: 'denied',
    });
    const rule = rpc('ALREADY_DECIDED', {
      approvalId: 'apr_1',
      status: 'approved',
      resolution: { reason: 'rule', optionId: 'allow-once', ruleIds: [] },
    });
    expect(approvalConflict(rule, self)?.by).toBe('rule');
    const cancelled = rpc('ALREADY_DECIDED', {
      approvalId: 'apr_1',
      status: 'cancelled',
      resolution: { reason: 'turn_cancelled' },
    });
    expect(approvalConflict(cancelled, self)).toMatchObject({
      by: 'cancelled',
      result: 'cancelled',
    });
    const expired = rpc('APPROVAL_EXPIRED', {
      approvalId: 'apr_1',
      resolution: { reason: 'timeout', optionId: 'reject-once' },
      resolvedAt: '2026-10-27T08:30:00.000Z',
    });
    expect(approvalConflict(expired, self)).toEqual({
      kind: 'elsewhere',
      by: 'timeout',
      at: '2026-10-27T08:30:00.000Z',
      result: 'expired',
    });
  });

  it('别的错误不归它管', () => {
    expect(approvalConflict(rpc('INVALID_PARAMS'), self)).toBeUndefined();
    expect(approvalConflict(new Error('offline'), self)).toBeUndefined();
  });
});

describe('questionOutcome', () => {
  const self = { clientId: 'mobile-1' };
  const by = (clientId: string, clientKind: 'desktop' | 'mobile') => ({
    deviceId: 'd',
    clientId,
    clientKind,
  });
  it('本机答的是完成，别处答的、超时与取消是别处处理', () => {
    expect(
      questionOutcome(
        {
          status: 'answered',
          resolution: { reason: 'user', answeredBy: by('mobile-1', 'mobile') },
        },
        self,
      ),
    ).toEqual({ kind: 'done' });
    expect(
      questionOutcome(
        { status: 'answered', resolution: { reason: 'user', answeredBy: by('desk', 'desktop') } },
        self,
      ),
    ).toEqual({ kind: 'elsewhere', by: 'desktop', result: 'answered' });
    expect(
      questionOutcome({ status: 'answered', resolution: { reason: 'timeout' } }, self),
    ).toEqual({ kind: 'elsewhere', by: 'timeout', result: 'answered' });
    expect(
      questionOutcome({ status: 'cancelled', resolution: { reason: 'turn_cancelled' } }, self),
    ).toEqual({ kind: 'elsewhere', by: 'cancelled', result: 'cancelled' });
  });
});

describe('inboxTarget / quickQuestion / isHighRisk', () => {
  it('助理的进助理，会话的进会话，没有会话的进电脑', () => {
    expect(inboxTarget({ computer: 'studio', item: approvalItem('a') })).toEqual({
      pathname: '/session/[key]',
      params: { key: 'studio/ses_1' },
    });
    expect(
      inboxTarget({ computer: 'studio', item: approvalItem('a', { channelId: 'chn_1' as never }) }),
    ).toEqual({ pathname: '/bot/[key]', params: { key: 'studio/chn_1' } });
    const automation = { ...failedItem('t', '2026-10-27T08:00:00.000Z') };
    delete (automation as { sessionId?: string }).sessionId;
    expect(inboxTarget({ computer: 'studio', item: automation })).toEqual({
      pathname: '/computer/[name]',
      params: { name: 'studio' },
    });
  });

  it('只有一题、单选、有选项、不是密码的提问能在列表里答', () => {
    expect(quickQuestion(questionItem())).toEqual({
      questionId: 'qst_1',
      id: 'q',
      options: ['全部', '一半'],
    });
    const multi = questionItem({
      questions: [{ id: 'q', question: '?', options: [{ label: 'a' }], multiSelect: true }],
    });
    expect(quickQuestion(multi)).toBeUndefined();
    const secret = questionItem({
      questions: [{ id: 'q', question: '?', options: [{ label: 'a' }], secret: true }],
    });
    expect(quickQuestion(secret)).toBeUndefined();
    expect(quickQuestion(approvalItem('a'))).toBeUndefined();
  });

  it('高风险看 Host 给的 risk', () => {
    expect(isHighRisk(approvalItem('a'))).toBe(false);
    const risky = approvalItem('a');
    if (risky.kind === 'approval')
      risky.ref = { ...risky.ref, risk: { level: 'high', reasons: ['destructive_command'] } };
    expect(isHighRisk(risky)).toBe(true);
  });
});

describe('verifyApproval', () => {
  let off: (() => void) | undefined;
  afterEach(() => off?.());
  const risk = { level: 'high' as const, reasons: ['destructive_command'] };

  it('普通的与拒绝不验证；高风险的允许要通过验证，没装验证时不放行', async () => {
    await verifyApproval({}, 'allow');
    await verifyApproval({ risk }, 'reject');
    await expect(verifyApproval({ risk }, 'allow')).rejects.toBeInstanceOf(
      ApprovalNotVerifiedError,
    );
    const seen: unknown[] = [];
    off = setApprovalGate(async (r) => {
      seen.push(r);
      return seen.length > 1;
    });
    await expect(verifyApproval({ risk }, 'allow')).rejects.toBeInstanceOf(
      ApprovalNotVerifiedError,
    );
    await verifyApproval({ risk }, 'allow');
    expect(seen).toEqual([risk, risk]);
  });
});
