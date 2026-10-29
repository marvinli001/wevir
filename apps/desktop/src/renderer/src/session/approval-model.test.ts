import type { ApprovalRequest, ClientIdentity } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  type ApprovalScope,
  alwaysAllow,
  approvalLayout,
  approvalScope,
  clientLabel,
  decidedHere,
  optionLabel,
  prefixText,
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

/** Codex 与 dsh：只为越过沙箱的操作问。 */
const codex: ApprovalScope = { roots: ['/repo'], sandboxed: true };
/** Claude Agent：项目目录里改文件、运行命令也问（claude-event-mapping.md §5.1）。 */
const claude: ApprovalScope = { roots: ['/repo', '/wt/repo-feature'], sandboxed: false };

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
      codex,
    );
    expect(presentation).toEqual({
      title: '允许修改项目目录之外的文件？',
      target: '/out/summary.md',
      permission: '完全访问',
      justification: '用户要求写到共享目录。',
      preview: { text: content.split('\n').slice(0, 6).join('\n'), more: true },
    });
  });

  it('命令显示全文，其余权限原样显示；没有详情时用通用标题', () => {
    expect(
      presentApproval(
        approval({
          toolName: 'bash',
          display: { kind: 'shell', command: 'rm -rf build\necho ok' },
          sandboxPermissions: 'network',
        }),
        codex,
      ),
    ).toEqual({
      title: '允许在沙箱之外运行命令？',
      target: 'rm -rf build\necho ok',
      permission: 'network',
    });
    expect(presentApproval(approval(null), codex)).toEqual({ title: '允许越过项目目录限制？' });
  });
});

describe('审批标题按会话的边界', () => {
  const title = (detail: ApprovalRequest['detail'], scope?: ApprovalScope) =>
    presentApproval(approval(detail), scope).title;
  const write = (path: string): ApprovalRequest['detail'] => ({
    toolName: 'Write',
    display: { kind: 'write', paths: [path], summary: path },
  });
  const bash: ApprovalRequest['detail'] = {
    toolName: 'Bash',
    display: { kind: 'shell', command: 'pnpm test' },
  };

  it('Claude Agent：项目目录与 worktree 里的改动、命令不说“之外”', () => {
    expect(title(write('/repo/approve.txt'), claude)).toBe('允许修改文件？');
    expect(title(write('/wt/repo-feature/src/a.ts'), claude)).toBe('允许修改文件？');
    expect(title(write('src/a.ts'), claude)).toBe('允许修改文件？');
    expect(title(bash, claude)).toBe('允许运行命令？');
    expect(
      title(
        { toolName: 'WebFetch', display: { kind: 'fetch', url: 'https://example.com' } },
        claude,
      ),
    ).toBe('允许执行此操作？');
    expect(title(null, claude)).toBe('允许执行此操作？');
  });

  it('应用级工具（0.30.0）按工具说做什么，别的 MCP 服务不算', () => {
    const mcp = (toolName: string): ApprovalRequest['detail'] => ({
      toolName,
      display: { kind: 'unknown', summary: toolName },
    });
    expect(title(mcp('mcp__wevir__wevir_session_create'), codex)).toBe('允许新建会话？');
    expect(title(mcp('mcp__wevir__wevir_session_send'), claude)).toBe('允许向其他会话发消息？');
    expect(title(mcp('mcp__wevir__wevir_session_interrupt'), claude)).toBe('允许停止其他会话？');
    expect(title(mcp('mcp__wevir__wevir_session_close'), claude)).toBe('允许关闭其他会话？');
    expect(title(mcp('mcp__wevir__wevir_session_archive'), codex)).toBe('允许归档其他会话？');
    expect(title(mcp('mcp__wevir__wevir_plugin_install'), codex)).toBe('允许安装此插件？');
    expect(title(mcp('mcp__wevir__wevir_skill_install'), claude)).toBe('允许安装 Skills？');
    expect(title(mcp('mcp__wevir__wevir_connector_add'), codex)).toBe('允许添加此 MCP 服务？');
    expect(title(mcp('mcp__wevir_more__wevir_plugins_manage'), codex)).toBe('允许更改插件配置？');
    expect(title(mcp('mcp__other__wevir_session_create'), claude)).toBe('允许执行此操作？');
  });

  it('浏览器工具（0.33.0）：开网页、操作网页、关标签页各有标题', () => {
    const mcp = (toolName: string): ApprovalRequest['detail'] => ({
      toolName,
      display: { kind: 'unknown', summary: toolName },
    });
    expect(title(mcp('mcp__wevir__browser_new_tab'), codex)).toBe('允许在浏览器中打开网页？');
    // Codex 把按需加载的应用级工具挂在 wevir_more 上，标题一样。
    expect(title(mcp('mcp__wevir_more__browser_new_tab'), codex)).toBe('允许在浏览器中打开网页？');
    expect(title(mcp('mcp__wevir_more__wevir_plugin_install'), codex)).toBe('允许安装此插件？');
    expect(title(mcp('mcp__wevir__browser_navigate'), codex)).toBe('允许在浏览器中打开网页？');
    expect(title(mcp('mcp__wevir__browser_click'), claude)).toBe('允许操作浏览器中的网页？');
    expect(title(mcp('mcp__wevir__browser_fill'), codex)).toBe('允许操作浏览器中的网页？');
    expect(title(mcp('mcp__wevir__browser_close_tab'), codex)).toBe('允许关闭浏览器标签页？');
    expect(title(mcp('mcp__wevir__browser_claim_tab'), codex)).toBe('允许接管浏览器标签页？');
  });

  it('Claude Agent：路径出了目录时照实说', () => {
    expect(title(write('/repo-other/a.txt'), claude)).toBe('允许修改项目目录之外的文件？');
    expect(title(write('/repo/../etc/hosts'), claude)).toBe('允许修改项目目录之外的文件？');
    expect(
      title(
        {
          toolName: 'Read',
          display: { kind: 'read', paths: ['/etc/hosts'], summary: '/etc/hosts' },
        },
        claude,
      ),
    ).toBe('允许读取项目目录之外的文件？');
    expect(
      title({ toolName: 'Read', display: { kind: 'read', paths: ['/repo/a.ts'] } }, claude),
    ).toBe('允许执行此操作？');
  });

  it('Codex：越过沙箱的请求标题不变；目录里受保护的文件只说修改', () => {
    expect(title(write('/tmp/out.txt'), codex)).toBe('允许修改项目目录之外的文件？');
    expect(
      title({ toolName: 'fileChange', display: { kind: 'edit', paths: [], summary: '' } }, codex),
    ).toBe('允许修改项目目录之外的文件？');
    expect(title(bash, codex)).toBe('允许在沙箱之外运行命令？');
    expect(title(write('/repo/.git/config'), codex)).toBe('允许修改文件？');
  });

  it('Windows 路径与不知道会话边界时', () => {
    const windows: ApprovalScope = { roots: ['C:\\Users\\me\\repo'], sandboxed: false };
    expect(title(write('c:/Users/me/repo/a.txt'), windows)).toBe('允许修改文件？');
    expect(title(write('C:\\Users\\me\\repo2\\a.txt'), windows)).toBe(
      '允许修改项目目录之外的文件？',
    );
    expect(title(write('/out/a.txt'))).toBe('允许修改文件？');
    expect(title(bash)).toBe('允许运行命令？');
    expect(title({ ...bash, sandboxPermissions: 'require_escalated' })).toBe(
      '允许在沙箱之外运行命令？',
    );
  });

  it('approvalScope：目录含额外文件夹与 worktree，订阅来源的 Provider 不是沙箱引擎', () => {
    const session = {
      cwd: '/repo',
      extraRoots: ['/docs'],
      worktrees: [{ workspaceId: 'ws_1', path: '/wt/repo', branch: 'feature' }],
      providerId: 'claude',
    } as Parameters<typeof approvalScope>[0];
    expect(approvalScope(session, [{ id: 'claude', kind: 'claude' }])).toEqual({
      roots: ['/repo', '/docs', '/wt/repo'],
      sandboxed: false,
    });
    expect(
      approvalScope({ ...session, providerId: 'chatgpt' } as typeof session, [
        { id: 'chatgpt', kind: 'chatgpt' },
      ])?.sandboxed,
    ).toBe(true);
    expect(approvalScope(session, [])).toBeUndefined();
  });
});

describe('approvalLayout（U13）', () => {
  const codex = [
    { optionId: 'accept', label: '允许', kind: 'allow_accept', category: 'allow' },
    {
      optionId: 'acceptForSession',
      label: '允许，本会话不再询问此命令',
      kind: 'allow_accept_for_session',
      category: 'allow',
    },
    { optionId: 'decline', label: '拒绝并继续', kind: 'reject_decline', category: 'reject' },
    { optionId: 'cancel', label: '拒绝并停止', kind: 'reject_cancel', category: 'reject' },
  ] as const;

  it('只有拒绝与允许：Codex 的拒绝取“拒绝并停止”，允许取只允许这一次', () => {
    const layout = approvalLayout(codex);
    expect(layout.reject?.optionId).toBe('cancel');
    expect(layout.allow?.optionId).toBe('accept');
    expect(layout.numbered.map((o) => o.optionId)).toEqual(['cancel', 'accept']);
  });

  it('ACP 的选项：第一个拒绝类与第一个允许类', () => {
    const layout = approvalLayout(approval(null).options);
    expect(layout.numbered.map((o) => o.kind)).toEqual(['reject_once', 'allow_once']);
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
      '审批已取消：回合已停止',
    );
    // 0.105.0：无人值守的会话里过期了。
    expect(resolutionText(request, { reason: 'timeout', optionId: 'reject-once' }, self)).toBe(
      '审批已过期：无人处理',
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

describe('总是允许（0.80.0）', () => {
  it('审批带 Host 提议的规则时才有，用允许那个选项，前缀按词显示', () => {
    const plain = approval(null);
    expect(alwaysAllow(plain)).toBeUndefined();
    const proposed = {
      ...plain,
      proposedRule: {
        prefixes: [
          ['git', 'status'],
          ['echo', 'a b'],
        ],
      },
    };
    expect(alwaysAllow(proposed)).toEqual({
      option: plain.options[0],
      prefix: "git status、echo 'a b'",
    });
    expect(prefixText(['echo', "it's"])).toBe(`echo 'it'\\''s'`);
  });

  it('按规则允许的结算写“已按规则允许”', () => {
    expect(
      resolutionText(approval(null), { reason: 'rule', optionId: 'allow-once', ruleIds: [] }, self),
    ).toBe('已按规则允许');
  });
});
