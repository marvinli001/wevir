import type { ApprovalRequest, ClientIdentity } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  clientLabel,
  decidedHere,
  optionLabel,
  presentApproval,
  resolutionText,
} from './approval-model';

const self: ClientIdentity = { deviceId: 'dev-mac0001', clientId: 'desk-1', clientKind: 'desktop' };
const cliHere: ClientIdentity = { deviceId: 'dev-mac0001', clientId: 'cli-1', clientKind: 'cli' };
const cliElsewhere: ClientIdentity = {
  deviceId: 'dev-laptop2-long-id',
  clientId: 'cli-2',
  clientKind: 'cli',
};

function approval(detail: ApprovalRequest['detail']): ApprovalRequest {
  return {
    id: 'apr_01JA2B3C4D5E6F7G8H9JKMNPQR',
    sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR',
    turnId: 'trn_01JA2B3C4D5E6F7G8H9JKMNPQR',
    toolCallId: 'call-1',
    options: [
      { optionId: 'allow-once', label: 'Allow once', kind: 'allow_once', category: 'allow' },
      { optionId: 'reject-once', label: 'Reject', kind: 'reject_once', category: 'reject' },
    ],
    detail,
    status: 'pending',
    createdAt: '2026-10-13T08:00:00.000Z',
  };
}

describe('presentApproval（acp-event-mapping.md §5.5）', () => {
  it('写文件：标题、目标、完全访问、理由与内容预览（前 6 行）', () => {
    const content = Array.from({ length: 8 }, (_, i) => `第 ${i + 1} 行`).join('\n');
    const presentation = presentApproval(
      approval({
        toolName: 'write',
        display: { kind: 'write', paths: ['/out/summary.md'], summary: '/out/summary.md' },
        input: { file_path: '/out/summary.md', content },
        justification: '用户要求写到共享目录。',
        sandboxPermissions: 'danger-full-access',
      }),
    );
    expect(presentation).toEqual({
      title: '在工作区之外修改文件',
      target: '/out/summary.md',
      permission: '完全访问，不受工作区限制',
      justification: '用户要求写到共享目录。',
      preview: { text: content.split('\n').slice(0, 6).join('\n'), more: true },
    });
  });

  it('命令取第一行，其余权限原样显示；没有详情时用通用标题', () => {
    expect(
      presentApproval(
        approval({
          toolName: 'bash',
          display: { kind: 'shell', command: 'rm -rf build\necho ok' },
          sandboxPermissions: 'network',
        }),
      ),
    ).toEqual({ title: '不受工作区限制地运行命令', target: 'rm -rf build', permission: 'network' });
    expect(presentApproval(approval(null))).toEqual({ title: 'Agent 请求越过工作区限制' });
  });
});

describe('选项与处理者', () => {
  it('认识的选项本地化，不认识的显示引擎给的 label', () => {
    expect(optionLabel({ kind: 'allow_once', label: 'Allow once' })).toBe('允许一次');
    expect(optionLabel({ kind: 'reject_once', label: 'Reject' })).toBe('拒绝');
    expect(optionLabel({ kind: 'allow_for_session', label: 'Allow for session' })).toBe(
      'Allow for session',
    );
  });

  it('称呼区分本桌面端、本机的其他客户端与其他设备', () => {
    expect(clientLabel(self, self)).toBe('本桌面端');
    expect(clientLabel(cliHere, self)).toBe('本机的命令行');
    expect(clientLabel(cliElsewhere, self)).toBe('命令行（设备 dev-laptop）');
  });

  it('结算提示：用户决定写明处理者，其余写原因；本窗口的决定不另外提示', () => {
    const request = approval(null);
    expect(
      resolutionText(request, { reason: 'user', optionId: 'allow-once', decidedBy: cliHere }, self),
    ).toBe('已由本机的命令行处理：允许一次');
    expect(resolutionText(request, { reason: 'turn_cancelled' }, self)).toBe(
      '审批已取消（回合被取消）',
    );
    expect(decidedHere({ reason: 'user', optionId: 'allow-once', decidedBy: self }, self)).toBe(
      true,
    );
    expect(decidedHere({ reason: 'user', optionId: 'allow-once', decidedBy: cliHere }, self)).toBe(
      false,
    );
    expect(decidedHere({ reason: 'host_restarted' }, self)).toBe(false);
  });
});
