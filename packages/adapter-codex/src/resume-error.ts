import type { SessionLostReason } from '@wevir/runtime-adapter';
import { CodexRpcError } from './codex-process.js';

// `thread/resume` 失败的归类（R3，docs/architecture/codex-event-mapping.md §4.2）。app-server 自己拒绝的是
// `-32600`（invalid_request），读 rollout 出错是 `-32603`（internal_error）；措辞在锁定提交的
// app-server/src/request_processors/thread_processor.rs（`thread_resume_inner`、`read_stored_thread_for_resume`、
// `thread_store_resume_read_error`）。样本在 test-fixtures/app-server/errors/resume-*.json（真实 codex-app-server 录制）。
//
// 与 dsh 不同：cwd 与创建时不一致不是错误（Codex 把 `cwd` 当作覆盖，按新的 cwd 继续），Wevir 也总是传创建时的工作区，
// 所以没有“cwd 不一致”一类；app-server 拒绝的其他请求（已归档等，Wevir 不会触发）归为 `rejected`。

export type CodexResumeFailure =
  /** Codex 没有这个会话或读不了它：Host 标为只读。 */
  | { kind: 'lost'; reason: SessionLostReason; explanation: string }
  /** thread 正在卸载（关闭后没有订阅者、空闲满 60 s），稍后重试。 */
  | { kind: 'closing' }
  /** app-server 拒绝了这次恢复：`session_unavailable`，不标只读。 */
  | { kind: 'rejected' }
  /** 连接断开、内部错误等：`engine_unavailable`。 */
  | { kind: 'unknown' };

export interface ResumeErrorRule {
  failure: Exclude<CodexResumeFailure, { kind: 'rejected' } | { kind: 'unknown' }>;
  code: number;
  pattern: RegExp;
}

export const RESUME_ERROR_RULES: readonly ResumeErrorRule[] = Object.freeze([
  // ThreadStoreError::ThreadNotFound：CODEX_HOME 里没有这个会话的 rollout。rollout 在第一条用户消息时才写，所以一次
  // 都没对话过的会话在引擎重启之后也是这句。
  {
    failure: {
      kind: 'lost',
      reason: 'not_found',
      explanation:
        'Codex 找不到这个会话的记录：会话日志（CODEX_HOME 下的 rollout）被删除，或者会话还没有对话过引擎就重启了',
    },
    code: -32600,
    pattern: /^no rollout found for (?:thread|conversation) id /,
  },
  // 不是 Codex 的 thread ID（UUID）：引擎里不可能有这个会话。
  {
    failure: { kind: 'lost', reason: 'not_found', explanation: '这不是 Codex 的会话 ID' },
    code: -32600,
    pattern: /^invalid (?:session|thread) id: /,
  },
  // rollout 读不出会话的元数据（文件空了或没有一行能解析）。
  {
    failure: {
      kind: 'lost',
      reason: 'corrupted',
      explanation: 'Codex 的会话日志（rollout）损坏，读不出会话',
    },
    code: -32603,
    pattern:
      /^failed to read thread: thread-store internal error: failed to read session metadata /,
  },
  {
    failure: { kind: 'closing' },
    code: -32600,
    pattern: /^thread \S+ is closing; retry thread\/resume after the thread is closed/,
  },
]);

export interface ClassifiedResumeError {
  failure: CodexResumeFailure;
  /** app-server 的原文。 */
  message: string;
  code?: number;
}

/** 把 `thread/resume` 的失败归类。不是 app-server 的 JSON-RPC 错误（进程退出等）一律 unknown。 */
export function classifyResumeError(error: unknown): ClassifiedResumeError {
  if (!(error instanceof CodexRpcError)) {
    return { failure: { kind: 'unknown' }, message: describe(error) };
  }
  const { code, rpcMessage: message } = error;
  const rule = RESUME_ERROR_RULES.find(
    (candidate) => candidate.code === code && candidate.pattern.test(message),
  );
  if (rule !== undefined) return { failure: rule.failure, message, code };
  return { failure: { kind: code === -32600 ? 'rejected' : 'unknown' }, message, code };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
