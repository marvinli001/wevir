import type { AgentEvent } from './events.js';
import type {
  AgentInput,
  ApprovalDecision,
  EngineSession,
  PendingApproval,
  ProviderConfig,
  ProviderIssue,
  ProviderTestResult,
  SessionConfig,
  TitleRequest,
} from './types.js';

/**
 * 引擎适配接口。Host 只通过它驱动 Agent 引擎；dsh 只出现在它的一个实现（packages/adapter-dsh）里。
 * 一个实例对应一个引擎（dsh：一个进程承载全部会话，ADR-0001 §2），由 Host 独占使用。
 *
 * 失败一律抛 `AdapterError`（errors.ts），各方法注明可能的错误码。`dispose` 之后除 `cancel` 与
 * `dispose` 外的方法都报 `disposed`。
 *
 * 与 SKELETON_PLAN §6 T1.3 草案的差异（按 ADR-0001 §7 与 T0.3 结论调整）：
 * 1. `cancel` 幂等：没有进行中的回合、会话已关闭或不认识都直接成功；只有在时限内无法确认回合已
 *    停止时才失败（`cancel_unconfirmed`）。成功返回时该回合的终结事件已经发出。
 * 2. 新增 `listPendingApprovals`：列出未决审批，供 Host 重启或客户端中途加入时对账（Paseo A19）。
 * 3. `AgentEvent` 区分增量（`assistant.delta`）与已提交消息（`assistant.message` /
 *    `assistant.thought`），后者用 `replaces` 指明替换哪些增量块（events.ts）。
 * 4. 引擎进程退出作为 `engine.exited` 事件上报，回合之间退出也报（ADR-0001 §2）。
 * 5. 审批请求（`approval.requested`）原样携带引擎给的选项列表；`ApprovalDecision` 是所选的
 *    `optionId`，不是 allow / deny 布尔值。
 * 6. `respondToApproval` 多了 `engineSessionId` 参数：与其他方法一致按会话定位，适配器可以校验
 *    请求确实属于该会话。
 * 7. `send` 在引擎接受输入后就返回，不等回合结束；回合结果看终结事件（`turn.settled` /
 *    `turn.failed` / `engine.exited`）。ACP `session/prompt` 要到回合结束才返回，dsh 适配器不能
 *    在 `send` 里等它。
 * 8. `subscribe` 只推订阅之后的事件，不回放（历史由 Host 事件库负责，ADR-0001 §5）；会话关闭、
 *    引擎退出或 `dispose` 时迭代结束。
 * 9. 草案未定义的类型在 types.ts 定稿：`EngineSession` 带引擎实际采用的模型与推理强度
 *    （ACP `configOptions`）；`AgentInput` 与 `user.message` 的 `content` 同形。
 */
export interface AgentRuntimeAdapter {
  /**
   * 新建引擎会话（dsh：ACP `session/new`）。不发事件。
   * 错误：`invalid_input`、`engine_unavailable`、`disposed`。
   */
  createSession(config: SessionConfig): Promise<EngineSession>;

  /**
   * 把已关闭、或引擎退出后脱开的会话重新挂到引擎上（dsh：ACP `session/resume`，必须用创建时的
   * `cwd`）。适配器不认识的 ID 也照样向引擎恢复：Host 重启后适配器是新的，会话只在引擎的持久化里
   * （T3.5）。会话已挂上时直接成功，不再问引擎。恢复后需要重新 `subscribe`，引擎不回放历史。
   * 恢复后会话的 Provider、模型与推理强度按 `config` 重新选定。
   * 错误：`invalid_input`（cwd 为空；Provider 或模型选不上）、`session_lost`（引擎没有这个会话或读不了它，
   * 原因见 `lostReason`）、`session_unavailable`（引擎拒绝，例如 cwd 不一致）、`engine_unavailable`、`disposed`。
   */
  resumeSession(engineSessionId: string, config: SessionConfig): Promise<EngineSession>;

  /**
   * 订阅一个会话的事件。只推订阅之后发出的事件；可以有多个订阅者，各自收到全部事件。
   * 会话关闭（`close` 完成）、引擎退出（`engine.exited` 之后）、`dispose` 时迭代结束；
   * 订阅者中途 `break` 即退订。
   * 同步抛出：`session_not_found`、`session_closed`、`disposed`。
   */
  subscribe(engineSessionId: string): AsyncIterable<AgentEvent>;

  /**
   * 开始一个回合。引擎接受输入后返回，此前不会发出本回合的事件；回合以终结事件结束。
   * 错误：`session_not_found`、`session_closed`、`session_busy`、`invalid_input`、
   * `engine_unavailable`、`disposed`。
   */
  send(engineSessionId: string, input: AgentInput): Promise<void>;

  /**
   * 回复一个未决审批（dsh：ACP `{"outcome":{"outcome":"selected","optionId":…}}`）。审批随即不再未决，
   * 引擎随后的事件（通常是该工具的 `tool.finished`）照常上报。同一请求只能决定一次。
   * 错误：`session_not_found`、`approval_not_found`、`invalid_option`（审批保持未决）、`disposed`。
   */
  respondToApproval(
    engineSessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void>;

  /**
   * 列出未决审批；不传 `engineSessionId` 时列出全部会话的。不认识的会话返回空列表。
   * 错误：`disposed`。
   */
  listPendingApprovals(engineSessionId?: string): Promise<PendingApproval[]>;

  /**
   * 取消进行中的回合（dsh：发 `session/cancel`，并以 cancelled 回复挂起的审批，ADR-0001 §6；写出顺序同
   * T0.3 场景 D，先 `session/cancel`）。
   * 未决审批以 `approval.cancelled`（`turn_cancelled`）结束，回合以 `turn.settled`（`cancelled`）
   * 或其他终结事件结束；返回时终结事件已经发出。幂等：没有回合、重复调用、会话已关闭或不认识都直接
   * 成功，一个回合只结算一次。
   * 错误：只有 `cancel_unconfirmed`（时限内无法确认已停止）。适配器随后要让这个会话可以 `resumeSession`
   * （dsh：重启引擎进程，同一进程上的会话都以 `engine.exited`（`cancel_unconfirmed`）脱开，T3.5）。
   */
  cancel(engineSessionId: string): Promise<void>;

  /**
   * 关闭会话（dsh：ACP `session/close`）。有回合在进行时先按 `cancel` 取消。完成后该会话的订阅结束，
   * `send` 报 `session_closed`；可以 `resumeSession`。已关闭时直接成功。
   * 错误：`session_not_found`、`cancel_unconfirmed`、`disposed`。
   */
  close(engineSessionId: string): Promise<void>;

  /**
   * 检查引擎能否接受这个 Provider 配置（T3.4）。Host 在 `provider.upsert` 写库之前调用，有问题就拒绝请求。
   * 返回空数组表示可以；不抛错。不实现表示引擎不检查。
   */
  validateProvider?(provider: ProviderConfig): ProviderIssue[];

  /**
   * 换上整套 Provider 配置（T3.4）：Host 启动时一次，之后每次 `provider.upsert` / `provider.remove` 一次，
   * 传入全部 Provider（含 Key）。返回时新配置已经交给引擎；何时对运行中的会话生效由实现决定并写明
   * （dsh：引擎不热加载，空闲时重启进程，会话按 `engine.exited`（`config_changed`）脱开，见 ADR-0001 补记 5）。
   * 错误：`engine_unavailable`（新配置下引擎起不来）、`disposed`。
   */
  configureProviders?(providers: readonly ProviderConfig[]): Promise<void>;

  /**
   * `provider.test`（T3.4）：用这个 Provider 发一次最小请求，验证地址、协议、Key 与模型。不抛错，失败写在结果里。
   * 不实现时 Host 回“不可用”。
   */
  testProvider?(provider: ProviderConfig, modelId: string): Promise<ProviderTestResult>;

  /**
   * 用会话当前的 Provider 与模型发一次不带工具的请求，生成会话标题（prompts/thread-title.md，R3）。Host 组好
   * 说明与输入、解析与整理输出；适配器只负责发请求，推理档位取这个模型最低的一档，返回模型的最终文本。不实现时
   * Host 只用首条消息截断的标题（dsh）。
   * 错误：`session_not_found`、`session_closed`（会话没挂着）、`engine_unavailable`（请求失败）、`disposed`。
   */
  generateTitle?(engineSessionId: string, request: TitleRequest): Promise<string>;

  /**
   * 释放全部资源（dsh：关 stdin，超时再 SIGTERM、SIGKILL）。进行中的回合被放弃，未决审批以
   * `approval.cancelled`（`disposed`）结束，所有订阅结束，不发 `engine.exited`。返回时引擎进程、
   * 计时器等已释放。幂等。
   */
  dispose(): Promise<void>;
}
