// 会话侧栏“依赖”卡片（0.70.0，Host 功能 `workspace_readiness`）的显示逻辑：预检结果的状态、原因与建议的文案，先列哪些项，通知
// 怎么并进报告。

import type {
  InstallCredential,
  InstallRun,
  InstallScripts,
  ReadinessItem,
  ReadinessReport,
  ReadinessStatus,
} from '@wevir/protocol';
import type { StatusTone } from '@/components/status-dot';
import type { PlainMessageKey } from '@/i18n';

export const REPORT_LABELS: Record<ReadinessReport['status'], PlainMessageKey> = {
  ready: 'readiness.report.ready',
  not_ready: 'readiness.report.not_ready',
  unknown: 'readiness.report.unknown',
};

export const REPORT_TONES: Record<ReadinessReport['status'], StatusTone> = {
  ready: 'success',
  not_ready: 'warning',
  unknown: 'neutral',
};

export const STATUS_LABELS: Record<ReadinessStatus, PlainMessageKey> = {
  ready: 'readiness.status.ready',
  missing: 'readiness.status.missing',
  incompatible: 'readiness.status.incompatible',
  network: 'readiness.status.network',
  permission: 'readiness.status.permission',
  unknown: 'readiness.status.unknown',
};

export function itemTone(item: ReadinessItem): StatusTone {
  if (item.status === 'ready') return 'success';
  if (item.status === 'unknown') return 'neutral';
  return item.blocking ? 'danger' : 'warning';
}

/** 项与安装的原因（Host 写的机器可读字符串）；不认识的显示状态。 */
const REASON_LABELS: Record<string, PlainMessageKey> = {
  not_found: 'readiness.reason.not_found',
  clt_missing: 'readiness.reason.clt_missing',
  not_cached: 'readiness.reason.not_cached',
  probe_failed: 'readiness.reason.probe_failed',
  version_mismatch: 'readiness.reason.version_mismatch',
  lockfile_missing: 'readiness.reason.lockfile_missing',
  lockfile_mismatch: 'readiness.reason.lockfile_mismatch',
  lockfile_maybe_outdated: 'readiness.reason.lockfile_maybe_outdated',
  lockfile_unreadable: 'readiness.reason.lockfile_unreadable',
  dependencies_missing: 'readiness.reason.dependencies_missing',
  dependencies_outdated: 'readiness.reason.dependencies_outdated',
  no_virtualenv: 'readiness.reason.no_virtualenv',
  not_writable: 'readiness.reason.not_writable',
  last_install_network: 'readiness.reason.network',
  network: 'readiness.reason.network',
  registry_auth: 'readiness.reason.registry_auth',
  permission: 'readiness.reason.not_writable',
  command_not_found: 'readiness.reason.command_not_found',
  cwd_missing: 'readiness.reason.cwd_missing',
  script_missing: 'readiness.reason.script_missing',
  bin_missing: 'readiness.reason.bin_missing',
  not_executable: 'readiness.reason.not_executable',
  downloads_package: 'readiness.reason.downloads_package',
  outside_project: 'readiness.reason.outside_project',
  incompatible: 'readiness.reason.version_mismatch',
  exit_code: 'readiness.reason.exit_code',
  timed_out: 'readiness.install.timed_out',
  user: 'readiness.reason.user',
  host_restarted: 'readiness.reason.host_restarted',
  workspace_removed: 'readiness.reason.workspace_removed',
  install_incomplete: 'readiness.reason.install_incomplete',
};

export function readinessReasonLabel(reason: string | undefined): PlainMessageKey | undefined {
  return reason === undefined ? undefined : REASON_LABELS[reason];
}

export const INSTALL_LABELS: Record<InstallRun['status'], PlainMessageKey> = {
  running: 'readiness.install.running',
  succeeded: 'readiness.install.succeeded',
  failed: 'readiness.install.failed',
  cancelled: 'readiness.install.cancelled',
  timed_out: 'readiness.install.timed_out',
};

export const INSTALL_TONES: Record<InstallRun['status'], StatusTone> = {
  running: 'accent',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  timed_out: 'danger',
};

export const SCRIPT_LABELS: Record<InstallScripts['dependencies'], PlainMessageKey> = {
  run: 'readiness.scripts.run',
  restricted: 'readiness.scripts.restricted',
  disabled: 'readiness.scripts.disabled',
  unknown: 'readiness.scripts.unknown',
};

export const CREDENTIAL_LABELS: Record<InstallCredential['source'], PlainMessageKey> = {
  env: 'readiness.credential.env',
  wevir: 'readiness.credential.wevir',
  missing: 'readiness.credential.missing',
};

/** Agent 命令的网络。`domains` 总是未限定：界面不写“已隔离”。 */
export const AGENT_NETWORK_LABELS: Record<string, PlainMessageKey> = {
  sandboxed: 'readiness.agent.sandboxed',
  unrestricted: 'readiness.agent.unrestricted',
  engine_managed: 'readiness.agent.engine_managed',
  unknown: 'readiness.agent.unknown',
};

const ADVICE_LABELS: Record<string, PlainMessageKey> = {
  install_by_user: 'readiness.advice.install_by_user',
  registry_auth_missing: 'readiness.advice.registry_auth_missing',
  domains_not_enforced: 'readiness.advice.domains_not_enforced',
  proxy_configured: 'readiness.advice.proxy_configured',
  last_install_network: 'readiness.advice.last_install_network',
  last_install_auth: 'readiness.advice.last_install_auth',
};

/** 认识的建议（按 Host 给的顺序，去重）。 */
export function adviceLabels(advice: readonly string[]): PlainMessageKey[] {
  const labels: PlainMessageKey[] = [];
  for (const code of advice) {
    const label = ADVICE_LABELS[code];
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** 卡片上先列几项。 */
export const READINESS_ITEMS_SHOWN = 8;

const STATUS_ORDER: Record<ReadinessStatus, number> = {
  permission: 0,
  network: 1,
  missing: 2,
  incompatible: 3,
  unknown: 4,
  ready: 5,
};

/** 卡片上的项：没就绪的在前（阻塞的先），就绪的在后；同一档里保持 Host 的顺序（按目录）。 */
export function sortedItems(items: readonly ReadinessItem[]): ReadinessItem[] {
  const rank = (item: ReadinessItem) =>
    item.status === 'ready' ? 20 : (item.blocking ? 0 : 10) + STATUS_ORDER[item.status];
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map(({ item }) => item);
}

/** 没就绪的项数（阻塞的与不阻塞的都算，未知不算）。 */
export function problemCount(items: readonly ReadinessItem[]): number {
  return items.filter((item) => item.status !== 'ready' && item.status !== 'unknown').length;
}

/** 一项后面那段：原因，或要求与找到的版本。 */
export function itemDetail(item: ReadinessItem): { reason?: PlainMessageKey; version?: string } {
  const reason = item.status === 'ready' ? undefined : readinessReasonLabel(item.reason);
  const version =
    item.status === 'ready'
      ? item.found
      : item.reason === 'version_mismatch' && item.required !== undefined
        ? `${item.found ?? '?'} → ${item.required}`
        : undefined;
  return { ...(reason && { reason }), ...(version !== undefined && { version }) };
}

/** 方案的目录：根目录写成 `.`。 */
export function planFolder(path: string): string {
  return path === '' ? '.' : path;
}

/** `readiness.changed` 并进当前报告：别的根目录（另一个 worktree）不管；带报告的整份换掉，只带安装的换掉 `install`。 */
export function mergeChange(
  report: ReadinessReport | undefined,
  change: { workspaceId: string; root: string; run?: InstallRun; report?: ReadinessReport },
): ReadinessReport | undefined {
  if (!report || change.workspaceId !== report.workspaceId || change.root !== report.root)
    return report;
  const next = change.report;
  if (next) {
    if (next.sessionId === report.sessionId) return next;
    // 别的会话发起的安装结束后重新预检的报告：Agent 网络是那个会话的，留着自己的。
    const { sessionId: _other, ...rest } = next;
    const { agent: _agent, ...network } = next.network;
    return {
      ...rest,
      ...(report.sessionId !== undefined && { sessionId: report.sessionId }),
      network: { ...network, ...(report.network.agent && { agent: report.network.agent }) },
    };
  }
  const run = change.run;
  if (run && (report.install === undefined || run.startedAt >= report.install.startedAt))
    return { ...report, install: run };
  return report;
}
