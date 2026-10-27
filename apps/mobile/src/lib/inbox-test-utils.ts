// 收件箱测试用的假项。

import type { InboxItem } from '@wevir/protocol';

const OPTIONS = [
  { optionId: 'allow-once', label: 'Allow', kind: 'allow_once', category: 'allow' as const },
  { optionId: 'reject-once', label: 'Reject', kind: 'reject_once', category: 'reject' as const },
];

export function approvalItem(id: string, patch: Partial<InboxItem> = {}): InboxItem {
  return {
    id: `approval:${id}`,
    kind: 'approval',
    sessionId: 'ses_1',
    title: '修登录页',
    summary: 'rm -rf build',
    createdAt: '2026-10-27T08:00:00.000Z',
    ref: { approvalId: id, turnId: 'trn_1', options: OPTIONS },
    ...patch,
  } as InboxItem;
}

export function failedItem(id: string, createdAt: string): InboxItem {
  return {
    id: `turn_failed:${id}`,
    kind: 'turn_failed',
    sessionId: 'ses_1',
    title: '修登录页',
    summary: 'provider is gone',
    createdAt,
    ref: { turnId: id },
  } as InboxItem;
}
