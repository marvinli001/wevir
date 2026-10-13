import type { SessionLostReason } from '@wevir/runtime-adapter';

// ACP `session/resume` 失败的归类（T3.5）。dsh-acp 的 resumeSession（上游 `packages/acp/acp/src/index.ts`）自己拒绝的
// 三种情况是 `-32602`，消息是固定措辞：持久化里没有可恢复的会话（日志被删除，或日志头读不出来，子 agent 会话也是
// 这句）、cwd 与日志头里的不是同一目录（按 realpath 比较，目录不存在也报这句）、会话已挂在本进程上。读日志时抛出
// 的错误（上游 `packages/session/session-persistence/src/errors.ts` 的 SessionFormatUnsupportedError、
// SessionPersistenceCorruptionError 等）不是 RequestError，ACP SDK 把它包成 `-32603 Internal error`，原文在
// `data.details`。这些措辞都由 resume-error.integration.test.ts 用真实 dsh 复现，与 test-fixtures/acp/errors/
// 里的 resume-*.json 逐字比对；dsh 升级改了措辞时先在那里失败，规则表随样本一起改。
//
// 规则表与 docs/architecture/acp-event-mapping.md §6 一致（acp-event-mapping.test.ts 检查）。

export type ResumeFailure =
  /** 再试也恢复不了：Host 把会话标为只读。 */
  | { kind: 'lost'; reason: SessionLostReason }
  /** cwd 与创建时不一致：工作区目录被移走、删除或换成了别处的链接。 */
  | { kind: 'cwd_mismatch' }
  /** 会话仍挂在本进程上（适配器以为它已关闭：之前的 `session/close` 失败过）。 */
  | { kind: 'already_active' }
  | { kind: 'unknown' };

export interface ResumeErrorRule {
  failure: Exclude<ResumeFailure, { kind: 'unknown' }>;
  /** JSON-RPC 错误码。 */
  code: number;
  /** 匹配 `message`；`-32603` 的规则匹配 `message` 与 `data.details` 拼成的全文。 */
  pattern: RegExp;
}

export const RESUME_ERROR_RULES: readonly ResumeErrorRule[] = Object.freeze([
  {
    failure: { kind: 'lost', reason: 'not_found' },
    code: -32602,
    pattern: /^Invalid params: session is not resumable: /,
  },
  {
    failure: { kind: 'cwd_mismatch' },
    code: -32602,
    pattern: /^Invalid params: session cwd does not match: /,
  },
  {
    failure: { kind: 'already_active' },
    code: -32602,
    pattern: /^Invalid params: session is already active: /,
  },
  // sessionFormatVersionRefusal：比引擎新（`… but this harness reads only v4 …`），或更旧且没有升级路径。
  {
    failure: { kind: 'lost', reason: 'incompatible' },
    code: -32603,
    pattern: /^Internal error: session "[^"]*" uses log format v\d+, /,
  },
  // SessionPersistenceCorruptionError（`session "<id>": stored log is corrupt: …`、`… malformed header …`）、
  // Zstandard 帧结构错误、文件名与日志头的格式版本不一致。
  {
    failure: { kind: 'lost', reason: 'corrupted' },
    code: -32603,
    pattern:
      /^Internal error: (?:session "[^"]*": stored log (?:is corrupt|has a malformed header)|corrupt Zstandard session log|session generation filename identifies v\d+, but its header identifies v\d+)/,
  },
]);

export interface ClassifiedResumeError {
  failure: ResumeFailure;
  /** 引擎原文：`message`，有 `data.details` 时接在后面（`Internal error: <details>`），不截断、不改写。 */
  message: string;
  code?: number;
}

/** 把 `session/resume` 的失败归类。不是 ACP 错误（连接断开等）的一律 unknown。 */
export function classifyResumeError(error: unknown): ClassifiedResumeError {
  const { message, code } = describeError(error);
  const base = code === undefined ? { message } : { message, code };
  const rule = RESUME_ERROR_RULES.find(
    (candidate) => candidate.code === code && candidate.pattern.test(message),
  );
  return { failure: rule?.failure ?? { kind: 'unknown' }, ...base };
}

/** ACP SDK 的 `RequestError`：数字 `code`，`-32603` 的原文在 `data.details`。 */
function describeError(error: unknown): { message: string; code?: number } {
  if (typeof error !== 'object' || error === null) return { message: String(error) };
  const { message, code, data } = error as { message?: unknown; code?: unknown; data?: unknown };
  let text = typeof message === 'string' ? message : String(error);
  const details = (data as { details?: unknown } | null | undefined)?.details;
  if (typeof details === 'string' && details !== '') text = `${text}: ${details}`;
  return typeof code === 'number' ? { message: text, code } : { message: text };
}
