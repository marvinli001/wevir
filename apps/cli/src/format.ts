import type {
  ApprovalOption,
  ApprovalResolutionReason,
  ClientIdentity,
  EngineErrorCategory,
  ProviderTestFailure,
  SessionReadOnlyReason,
  SessionState,
  StateChangeReason,
  ToolFinishStatus,
  TurnOutcome,
} from '@wevir/protocol';

// 界面文案（中文为主）与表格、时间的格式化。

export const STATE_LABEL: Record<SessionState, string> = {
  idle: '空闲',
  running: '运行中',
  awaiting_approval: '待审批',
  cancelling: '正在取消',
  error: '出错',
  closed: '已关闭',
};

export const TURN_OUTCOME_LABEL: Record<TurnOutcome, string> = {
  completed: '完成',
  cancelled: '已取消',
  failed: '失败',
  interrupted: '中断',
};

export const TOOL_STATUS_LABEL: Record<ToolFinishStatus, string> = {
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '状态未知',
};

export const STATE_REASON_LABEL: Partial<Record<StateChangeReason, string>> = {
  engine_exited: '引擎进程退出',
  cancel_unconfirmed: '取消没有得到引擎确认',
  resume_failed: '恢复引擎会话失败',
  host_restarted: 'Host 重启时回合被中断',
  turn_finished: '回合失败',
};

export const ENGINE_ERROR_LABEL: Record<EngineErrorCategory, string> = {
  missing_credentials: '缺少凭据',
  provider: 'Provider 错误',
  engine_exited: '引擎退出',
  cancel_unconfirmed: '取消未确认',
  session_unavailable: '引擎会话不可用',
  unknown: '未知错误',
};

/** 引擎错误的下一步建议。 */
export const ENGINE_ERROR_HINT: Record<EngineErrorCategory, string> = {
  missing_credentials: '这个 Provider 没有可用的 Key：运行 wevir provider add 重新设置',
  provider: 'Provider 返回了错误：运行 wevir provider test 检查地址、模型与 Key',
  engine_exited:
    '引擎进程退出了：再发一条消息会自动恢复会话；反复出现时查看 Host 日志（<数据目录>/logs/host.log）',
  cancel_unconfirmed: '取消没有得到引擎确认，引擎已重启：再发一条消息会自动恢复会话',
  session_unavailable: '引擎会话暂时不可用：稍后再发一次；仍不行时查看 Host 日志',
  unknown: '查看 Host 日志（<数据目录>/logs/host.log）了解详情',
};

export const READ_ONLY_LABEL: Record<SessionReadOnlyReason, string> = {
  engine_session_not_found: '引擎找不到这个会话（引擎数据目录可能被清理过）',
  engine_session_incompatible: '当前引擎版本读不了这个会话的格式',
  engine_session_corrupted: '引擎的会话日志已损坏',
};

export const APPROVAL_END_LABEL: Record<Exclude<ApprovalResolutionReason, 'user'>, string> = {
  turn_cancelled: '审批已取消（回合被取消）',
  session_closed: '审批已取消（会话已关闭）',
  engine_exited: '审批已取消（引擎退出）',
  host_shutdown: '审批已取消（Host 退出）',
  host_restarted: '审批已过期（Host 重启过）',
};

export const PROVIDER_TEST_LABEL: Record<ProviderTestFailure, string> = {
  missing_key: '没有 Key',
  network: '连不上',
  timeout: '超时',
  auth: '认证失败',
  model_not_found: '模型不存在',
  protocol: '协议不匹配',
  rate_limited: '被限流',
  server: '服务端错误',
  unknown: '未知错误',
};

export const PROVIDER_TEST_HINT: Record<ProviderTestFailure, string> = {
  missing_key: '没有存 Key：运行 wevir provider add，填同一个 ID 并输入 Key',
  network: '连不上服务地址：检查地址（baseURL）与网络、代理',
  timeout: '服务在时限内没有响应：稍后重试，或检查网络',
  auth: 'Key 无效或没有权限：运行 wevir provider add 更新 Key',
  model_not_found: '服务端没有这个模型：用 --model 换一个，或运行 wevir provider add 修改默认模型',
  protocol: '地址能连上，但不按所选协议应答：检查地址（通常以 /v1 结尾）与协议',
  rate_limited: '被限流或额度用完：稍后重试，或检查账户余额',
  server: '服务端出错（5xx）：稍后重试',
  unknown: '看上面的错误原文',
};

/** 审批选项的中文名；不认识的 `kind` 用引擎给的 `label`。 */
export function optionLabel(option: Pick<ApprovalOption, 'kind' | 'label'>): string {
  switch (option.kind) {
    case 'allow_once':
      return '允许一次';
    case 'allow_always':
      return '总是允许';
    case 'reject_once':
      return '拒绝';
    case 'reject_always':
      return '总是拒绝';
    default:
      return option.label || option.kind;
  }
}

/** 审批的决定者：`<clientKind>/<deviceId>`。 */
export function clientLabel(client: ClientIdentity): string {
  return `${client.clientKind}/${client.deviceId}`;
}

/** 本地时间 `YYYY-MM-DD HH:mm`。 */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

/** 终端里的显示宽度：东亚宽字符算 2 列。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** 截到 `max` 列以内，超出时以 … 结尾。 */
export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (displayWidth(oneLine) <= max) return oneLine;
  let out = '';
  let width = 0;
  for (const char of oneLine) {
    const w = isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
    if (width + w > max - 1) break;
    out += char;
    width += w;
  }
  return `${out}…`;
}

/** 按显示宽度在右侧补空格。 */
export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** 左对齐的纯文本表格，列间两个空格。 */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[i] ?? ''))),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : padEnd(cell, widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}
