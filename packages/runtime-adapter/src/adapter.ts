import type { AgentEvent } from './events.js';
import type {
  AccountKind,
  AccountLoginMethod,
  AccountModels,
  AccountState,
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
 *
 * 子会话（R4，domain-model §3.3.1，契约能力 `subagents`）：引擎派出的子 agent 由适配器在父会话的流里以
 * `subagent.started` 报出，子会话有自己的引擎会话 ID，`subscribe` 拿它的事件（第一个订阅者之前的已缓冲），它的
 * 回合由引擎开始（`turn.started`）。子会话不接受 `send`（`invalid_input`）；`cancel` 中断它进行中的回合（Host 取消
 * 父会话时级联用），`respondToApproval`、`listPendingApprovals`、`generateTitle` 照常。Host 不对子会话调用
 * `close` 与 `resumeSession`。
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
   * 错误：`session_not_found`、`session_closed`、`session_busy`、`invalid_input`（含子会话：它由父 agent 驱动）、
   * `engine_unavailable`、`disposed`。
   */
  send(engineSessionId: string, input: AgentInput): Promise<void>;

  /**
   * 插话（R11，domain-model §4.6）：把输入交给进行中的回合，不打断它；引擎在当前这一步（模型这一段输出，或这次工具
   * 调用）结束后把它放进同一个回合，模型接着往下做（Codex：`turn/steer`）。引擎接受即返回；放进去时在这个回合的流里
   * 报 `turn.steered`（带 `steerId`），在终结事件之前。回合被中断时引擎丢掉没用上的插话，不报。不实现表示引擎不能
   * 插话（dsh 与其他 ACP 引擎），Host 一律排队。契约能力 `steer`。
   * 错误：`steer_rejected`（没有能插话的回合：没有进行中的回合、回合正在取消、引擎不肯，例如 Codex 的 review 回合；
   * Host 转为排队）、`session_not_found`、`session_closed`、`invalid_input`（含子会话）、`disposed`。
   */
  steer?(engineSessionId: string, steerId: string, input: AgentInput): Promise<void>;

  /**
   * 换会话的模型或推理档位（0.9.0，`session.configure`）：从下一个回合起用新的值，进行中的回合不受影响（Codex：下一个
   * `turn/start` 带 `model` 与 `effort`）。`reasoningEffort` 省略表示不指定，用模型的默认档位。会话没挂着（关闭、脱开）
   * 时 Host 不调它，之后 `resumeSession` 的配置里就是新的值。不实现表示引擎不能在会话中换（dsh），Host 不声明
   * `session_configure`。
   * 错误：`session_not_found`、`invalid_input`（Provider 没有这个模型、子会话）、`disposed`。
   */
  configureSession?(
    engineSessionId: string,
    config: { modelId: string; reasoningEffort?: string },
  ): Promise<void>;

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
   * 引擎自己的订阅登录（R6，ADR-0005 决策 4）。不实现表示引擎没有账号（dsh、echo）；Host 据此决定是否声明
   * `chatgpt_account` 功能。
   */
  readonly accounts?: EngineAccounts;

  /**
   * 释放全部资源（dsh：关 stdin，超时再 SIGTERM、SIGKILL）。进行中的回合被放弃，未决审批以
   * `approval.cancelled`（`disposed`）结束，所有订阅结束，不发 `engine.exited`。返回时引擎进程、
   * 计时器等已释放。幂等。
   */
  dispose(): Promise<void>;
}

/**
 * 引擎的账号（R6，domain-model §3.6）。凭据由引擎自己保存，适配器与 Host 都不读、不转交令牌；这里只有状态。
 * 方法都可能抛 `AdapterError`：`invalid_input`（种类不支持）、`engine_unavailable`（引擎起不来、请求失败）、`disposed`。
 */
export interface EngineAccounts {
  /** 支持的账号种类。 */
  readonly kinds: readonly AccountKind[];
  /** 读状态；已登录时尽力附带用量。 */
  read(kind: AccountKind): Promise<AccountState>;
  /** 开始登录，返回 `signing_in` 的状态（带 `login`）；已有进行中的登录时替换它。 */
  login(kind: AccountKind, method: AccountLoginMethod): Promise<AccountState>;
  /** 取消进行中的登录；`loginId` 不是当前的时什么都不做。返回取消之后的状态。 */
  cancelLogin(kind: AccountKind, loginId?: string): Promise<AccountState>;
  /** 登出，没登录时同样成功。 */
  logout(kind: AccountKind): Promise<AccountState>;
  /** 账号能用的模型（Host 用它填 `chatgpt` Provider 的模型列表）。 */
  models(kind: AccountKind): Promise<AccountModels>;
  /**
   * 状态变了（登录开始、完成、失败、取消，登出，套餐或用量变化）时调用，带完整的状态。返回退订函数。监听器里抛错不影响别的
   * 监听器。
   */
  onChange(listener: (state: AccountState) => void): () => void;
}
