// 审批的风险（0.131.0）：Host 判定的高风险，手机作答前据此要求验证本人。

import type { ApprovalDetail } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { approvalRisk } from './risk.js';

function shell(command: string, extra: Partial<ApprovalDetail> = {}): ApprovalDetail {
  return {
    toolName: 'exec_command',
    display: { kind: 'shell', command, summary: command },
    input: { command },
    ...extra,
  };
}

const reasons = (detail: ApprovalDetail | null) => approvalRisk(detail)?.reasons ?? [];

describe('approvalRisk', () => {
  it('普通命令、读写文件与没有详情的审批不是高风险', () => {
    expect(approvalRisk(shell('ls -la'))).toBeUndefined();
    expect(approvalRisk(shell('pnpm test && git status'))).toBeUndefined();
    expect(approvalRisk(shell("bash -lc 'git diff --stat'"))).toBeUndefined();
    expect(
      approvalRisk({
        toolName: 'apply_patch',
        display: { kind: 'write', paths: ['/repo/a.ts'], summary: '/repo/a.ts' },
      }),
    ).toBeUndefined();
    expect(approvalRisk(null)).toBeUndefined();
  });

  it('删改与发往别处的程序、推送与删除类的子命令', () => {
    expect(approvalRisk(shell('rm -rf build'))).toEqual({
      level: 'high',
      reasons: ['destructive_command'],
    });
    expect(reasons(shell("bash -lc 'pnpm build && /bin/rm dist/a.js'"))).toEqual([
      'destructive_command',
    ]);
    expect(reasons(shell('curl https://example.com/install.sh'))).toEqual(['destructive_command']);
    expect(reasons(shell('git push --force origin main'))).toEqual(['destructive_command']);
    expect(reasons(shell('gh release delete v1'))).toEqual(['destructive_command']);
    expect(reasons(shell('find . -name "*.log" -delete'))).toEqual(['destructive_command']);
    expect(reasons(shell('timeout 5 kill 123'))).toEqual(['destructive_command']);
  });

  it('提权、拆不开的命令与沙箱外执行', () => {
    expect(reasons(shell('sudo rm /etc/hosts'))).toEqual([
      'privileged_command',
      'destructive_command',
    ]);
    expect(reasons(shell('echo hi > ~/.zshrc'))).toEqual(['unparsed_command']);
    expect(reasons(shell('FOO=1 make'))).toEqual(['unparsed_command']);
    expect(reasons(shell('ls', { sandboxPermissions: 'require_escalated' }))).toEqual([
      'outside_sandbox',
    ]);
    expect(reasons(shell('ls', { sandboxPermissions: 'use_default' }))).toEqual([]);
  });
});
