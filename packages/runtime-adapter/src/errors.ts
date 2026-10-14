/**
 * 适配器方法失败时抛出的错误码。Host 据此映射成 Host API 的错误（host-api.md §7），`message` 只给人看。
 */
export type AdapterErrorCode =
  /** 适配器已 `dispose`。 */
  | 'disposed'
  /** 适配器或引擎不认识这个引擎会话 ID。 */
  | 'session_not_found'
  /** 会话不挂在引擎上：已 `close`，或引擎进程退出后尚未 `resumeSession`。 */
  | 'session_closed'
  /** 引擎拒绝恢复会话，如 cwd 与创建时不一致（ACP `-32602 session cwd does not match`）。 */
  | 'session_unavailable'
  /**
   * `resumeSession`：引擎里已经没有这个会话，或者读不了它，再试也恢复不了（T3.5）。原因在
   * `AdapterError.lostReason`。Host 据此把会话标为只读。
   */
  | 'session_lost'
  /** 会话有回合在进行，不排队、不打断。 */
  | 'session_busy'
  /** `steer`：没有能插话的回合（没有进行中的回合、正在取消，或引擎不肯），R11。 */
  | 'steer_rejected'
  /** 该会话没有这个 `requestId` 的未决审批：不存在、已决定或已结束。 */
  | 'approval_not_found'
  /** `optionId` 不在该审批请求的选项里；审批保持未决。 */
  | 'invalid_option'
  /** 参数不合法，如 `content` 为空、`cwd` 为空。 */
  | 'invalid_input'
  /** 已请求取消，但在时限内无法确认回合已停止。 */
  | 'cancel_unconfirmed'
  /** 会话用的账号没有登录（R6：ChatGPT 订阅），登录之后再试。Host 归为 `missing_credentials`。 */
  | 'missing_credentials'
  /** 引擎进程启动失败或调用途中不可用。 */
  | 'engine_unavailable';

/**
 * `session_lost` 的原因（T3.5）：
 * - `not_found`：引擎找不到可恢复的会话（dsh：会话日志被删除，或日志头读不出来，`DSH_HOME` 被清理时就是这样）。
 * - `incompatible`：会话还在，但当前引擎读不了它的格式（dsh：日志由更新、或没有升级路径的更旧版本写入）。
 * - `corrupted`：会话日志损坏。
 */
export type SessionLostReason = 'not_found' | 'incompatible' | 'corrupted';

export class AdapterError extends Error {
  override readonly name = 'AdapterError';
  readonly code: AdapterErrorCode;
  /** 只在 `code` 为 `session_lost` 时有。 */
  readonly lostReason?: SessionLostReason;

  constructor(
    code: AdapterErrorCode,
    message: string,
    options?: { cause?: unknown; lostReason?: SessionLostReason },
  ) {
    super(message, options);
    this.code = code;
    if (options?.lostReason !== undefined) this.lostReason = options.lostReason;
  }
}

/** 按 `name` 与 `code` 判断，不用 instanceof：调用方可能拿到另一份打包出来的 AdapterError 类。 */
export function isAdapterError(error: unknown, code?: AdapterErrorCode): error is AdapterError {
  return (
    error instanceof Error &&
    error.name === 'AdapterError' &&
    (code === undefined || (error as AdapterError).code === code)
  );
}
