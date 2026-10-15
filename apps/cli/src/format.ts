import type {
  ApprovalOption,
  ApprovalResolutionReason,
  ClientIdentity,
  EngineErrorCategory,
  ProviderTestFailure,
  SessionReadOnlyReason,
  SessionState,
  StateChangeReason,
  SubagentStatus,
  ToolFinishStatus,
  TurnOutcome,
} from '@wevir/protocol';

import { type PlainMessageKey, t } from './i18n/index.js';

// 协议里的值的说法（经 i18n 的目录）与表格、时间的格式化。

export const stateLabel = (state: SessionState): string => t(`state.${state}`);

export const turnOutcomeLabel = (outcome: TurnOutcome): string => t(`turnOutcome.${outcome}`);

/** 子 agent 离开“运行中”时的说法（R4，domain-model §3.3.1）。 */
export const subagentEndLabel = (status: Exclude<SubagentStatus, 'running'>): string =>
  t(`subagentEnd.${status}`);

export const toolStatusLabel = (status: ToolFinishStatus): string => t(`toolStatus.${status}`);

const STATE_REASON_KEY: Partial<Record<StateChangeReason, PlainMessageKey>> = {
  engine_exited: 'stateReason.engine_exited',
  cancel_unconfirmed: 'stateReason.cancel_unconfirmed',
  resume_failed: 'stateReason.resume_failed',
  host_restarted: 'stateReason.host_restarted',
  turn_finished: 'stateReason.turn_finished',
};

/** 会话出错的原因；不需要说明的原因为 undefined。 */
export function stateReasonLabel(reason: StateChangeReason): string | undefined {
  const key = STATE_REASON_KEY[reason];
  return key === undefined ? undefined : t(key);
}

export const engineErrorLabel = (category: EngineErrorCategory): string =>
  t(`engineError.${category}`);

/** 引擎错误的下一步建议。 */
export const engineErrorHint = (category: EngineErrorCategory): string =>
  t(`engineHint.${category}`);

export const readOnlyLabel = (reason: SessionReadOnlyReason): string => t(`readOnly.${reason}`);

export const approvalEndLabel = (reason: Exclude<ApprovalResolutionReason, 'user'>): string =>
  t(`approvalEnd.${reason}`);

export const providerTestLabel = (reason: ProviderTestFailure): string =>
  t(`providerTest.${reason}`);

export const providerTestHint = (reason: ProviderTestFailure): string =>
  t(`providerHint.${reason}`);

/** 审批选项的说法；不认识的 `kind` 用引擎给的 `label`。 */
export function optionLabel(option: Pick<ApprovalOption, 'kind' | 'label'>): string {
  switch (option.kind) {
    case 'allow_once':
      return t('option.allowOnce');
    case 'allow_always':
      return t('option.allowAlways');
    case 'reject_once':
      return t('option.rejectOnce');
    case 'reject_always':
      return t('option.rejectAlways');
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
  return t('time.minutes', { minutes, seconds: Math.round((ms % 60_000) / 1000) });
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
