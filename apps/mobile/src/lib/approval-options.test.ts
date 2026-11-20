import type { ApprovalOption } from '@wevir/protocol';
import { expect, it } from 'vitest';
import { setLocale } from '../i18n';
import { verifyApprovalOption } from './approval-gate';
import { approvalChoices, approvalLabel } from './approval-options';

it('keeps the exact Codex decision, including original ordering of alternatives and the policy target', async () => {
  setLocale('zh-CN');
  const opts = [
    {
      kind: 'allow_exec_policy',
      category: 'allow',
      label: 'policy',
      optionId: 'codex-policy-0',
      policyTarget: 'git status',
    },
    { kind: 'reject_decline', category: 'reject', label: 'decline', optionId: 'decline' },
    { kind: 'allow_accept', category: 'allow', label: 'accept', optionId: 'accept' },
    { kind: 'reject_cancel', category: 'reject', label: 'cancel', optionId: 'cancel' },
  ] as const satisfies readonly ApprovalOption[];
  const { primary, other } = approvalChoices(opts);
  expect(primary.map((o) => o.optionId)).toEqual(['cancel', 'accept']);
  expect(other.map((o) => approvalLabel(o, opts))).toEqual([
    '始终允许命令前缀 git status',
    '拒绝并继续',
  ]);
  expect(primary.map((o) => approvalLabel(o, opts))).toEqual(['拒绝并停止', '批准']);
  expect((await verifyApprovalOption({ options: opts }, 'decline')).optionId).toBe('decline');
  await expect(verifyApprovalOption({ options: opts }, 'missing')).rejects.toThrow();
  expect(approvalChoices([opts[0]]).primary).toEqual([]);
});
