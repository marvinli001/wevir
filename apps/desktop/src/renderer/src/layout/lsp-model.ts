// 会话侧栏“语言服务器”卡片的纯逻辑（0.70.0，`lsp.status`）：状态的颜色与文案、摘要、项目根的显示、默认选中的安装方案。

import type {
  LspInstallPlan,
  LspInstallStatus,
  LspServerState,
  LspServerStatus,
} from '@wevir/protocol';
import type { StatusTone } from '@/components/status-dot';
import type { PlainMessageKey } from '@/i18n';

export const STATE_TONES: Record<LspServerState, StatusTone> = {
  missing: 'warning',
  outdated: 'warning',
  not_started: 'neutral',
  starting: 'accent',
  running: 'success',
  failed: 'danger',
};

export const STATE_LABELS: Record<LspServerState, PlainMessageKey> = {
  missing: 'lsp.state.missing',
  outdated: 'lsp.state.outdated',
  not_started: 'lsp.state.not_started',
  starting: 'lsp.state.starting',
  running: 'lsp.state.running',
  failed: 'lsp.state.failed',
};

export const INSTALL_LABELS: Record<LspInstallStatus, PlainMessageKey> = {
  running: 'lsp.install.running',
  verifying: 'lsp.install.verifying',
  succeeded: 'lsp.install.succeeded',
  failed: 'lsp.install.failed',
  cancelled: 'lsp.install.cancelled',
  timed_out: 'lsp.install.timed_out',
};

/** 能用（找到了、版本够）的状态。 */
export const usable = (state: LspServerState) =>
  state === 'not_started' || state === 'starting' || state === 'running';

const SEVERITY: Record<StatusTone, number> = {
  danger: 4,
  warning: 3,
  accent: 2,
  success: 1,
  neutral: 0,
};

/** 收起时的摘要：能用的个数 / 总数，圆点取最该注意的那个状态。 */
export function lspSummary(servers: readonly LspServerStatus[]): {
  ready: number;
  total: number;
  tone: StatusTone;
} {
  let tone: StatusTone = 'neutral';
  for (const server of servers) {
    const next = STATE_TONES[server.state];
    if (SEVERITY[next] > SEVERITY[tone]) tone = next;
  }
  return {
    ready: servers.filter((server) => usable(server.state)).length,
    total: servers.length,
    tone,
  };
}

/** 项目根相对扫描目录的显示：就是扫描目录时为空，其余用 `/` 分隔的相对路径。 */
export function rootLabel(dir: string, root: string): string {
  if (root === dir) return '';
  const prefix = dir.endsWith('/') || dir.endsWith('\\') ? dir : `${dir}/`;
  const winPrefix = dir.endsWith('\\') ? dir : `${dir}\\`;
  if (root.startsWith(prefix)) return root.slice(prefix.length).replaceAll('\\', '/');
  if (root.startsWith(winPrefix)) return root.slice(winPrefix.length).replaceAll('\\', '/');
  return root;
}

/** 一行右边：能用的写版本（没有时写状态），不能用的写状态。 */
export function rowDetail(server: LspServerStatus): { version?: string; state: PlainMessageKey } {
  return usable(server.state) && server.version !== undefined
    ? { version: server.version, state: STATE_LABELS[server.state] }
    : { state: STATE_LABELS[server.state] };
}

/** 默认选中的方案：第一个能运行的（项目级在前），都不能运行时第一个。 */
export function defaultPlan(plans: readonly LspInstallPlan[]): LspInstallPlan | undefined {
  return plans.find((plan) => plan.runnable) ?? plans[0];
}

export const SCOPE_LABELS: Record<LspInstallPlan['scope'], PlainMessageKey> = {
  project: 'lsp.scope.project',
  user: 'lsp.scope.user',
  system: 'lsp.scope.system',
};

export const SOURCE_LABELS: Record<NonNullable<LspServerStatus['source']>, PlainMessageKey> = {
  project: 'lsp.source.project',
  user: 'lsp.source.user',
  system: 'lsp.source.system',
};

/** 安装在进行中（装着或在验证）。 */
export const installing = (server: LspServerStatus) =>
  server.install?.status === 'running' || server.install?.status === 'verifying';
