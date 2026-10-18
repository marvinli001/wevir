import type { AgentEvent } from './events.js';
import type {
  AccountKind,
  AccountLoginMethod,
  AccountLoginOptions,
  AccountModels,
  AccountState,
  AccountUpstream,
  AgentInput,
  ApprovalDecision,
  EngineAppToolsGrant,
  EngineGoal,
  EngineSession,
  ForkOptions,
  GoalStartRequest,
  PendingApproval,
  PermissionMode,
  ProviderConfig,
  ProviderIssue,
  ProviderTestResult,
  ReviewRequest,
  SessionCapability,
  SessionConfig,
  TitleRequest,
} from './types.js';

/**
 * 引擎适配接口。Host 只通过它驱动 Agent 引擎；每个引擎只出现在它自己的适配器包里。
 * 一个实例对应一个引擎（Codex：一个进程承载全部会话，ADR-0005 决策 1），由 Host 独占使用。
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
/** `cancel` 的选项（0.14.0）。 */
export interface CancelOptions {
  /** 用户单独停掉了这个子会话：引擎能告诉父 agent 时告诉它。 */
  notifyParent?: boolean;
}

export interface AgentRuntimeAdapter {
  /** 全局插件（0.41.0）：未声明的引擎不接收用户连接器或 skills。 */
  readonly mcpServers?: boolean;
  readonly skills?: boolean;
  bindPlugins?(source: import('./plugins.js').EnginePluginSource): void;
  reloadPlugins?(): Promise<void>;
  listConnectorStatus?(): Promise<import('./plugins.js').EngineConnectorStatus[]>;
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
   * 立即压缩会话的上下文（0.24.0，`session.compact`）：开始一个回合，同 `send` 在引擎接受后返回，回合以终结事件结束；回合里引擎
   * 报 `context.compacting` 与 `context.compacted`（`manual`）。会话有进行中的回合时 `session_busy`。不实现表示引擎不能压缩，
   * Host 不声明 `session_compact`（Codex：`thread/compact/start`，回合由 app-server 开始；Claude：发 `/compact`）。
   * 错误：同 `send`。
   */
  compact?(engineSessionId: string): Promise<void>;

  /**
   * 代码审查（0.24.0，`session.review`）：开始一个回合，同 `send`；审查结果是这个回合的助手消息。不实现表示引擎不能审查，Host
   * 不声明 `session_review`（Codex：`review/start`，`delivery: 'inline'`）。
   * 错误：同 `send`。
   */
  review?(engineSessionId: string, request: ReviewRequest): Promise<void>;

  /**
   * 设会话目标（0.35.0，`session.setGoal`，domain-model §3.16）：替换原有的目标，以 `request.input` 开始第一个回合，同 `send` 在
   * 引擎接受后返回、回合以终结事件结束；之后目标进行中、会话空闲时引擎自己开回合接着做（流里的 `turn.started`，`trigger` 为
   * `goal`），目标的变化以 `goal.updated` 报出。不实现表示引擎没有目标，Host 不声明 `session_goals`（Codex：先以 `paused` 写入目标，
   * `turn/start` 之后再设为 `active`，免得 Codex 抢先用旧的设置开回合）。
   * 错误：同 `send`。
   */
  startGoal?(engineSessionId: string, request: GoalStartRequest): Promise<void>;

  /**
   * 暂停或继续会话目标（0.35.0，`session.updateGoal`），返回改后的目标。继续时会话空闲则引擎随即开回合（`turn.started`，`trigger`
   * 为 `goal`）；暂停不打断进行中的回合，只是之后不再接着做。和 `startGoal` 同时实现。
   * 错误：`session_not_found`、`session_closed`、`invalid_input`（没有目标、子会话）、`engine_unavailable`、`disposed`。
   */
  updateGoal?(engineSessionId: string, status: 'active' | 'paused'): Promise<EngineGoal>;

  /**
   * 清除会话目标（0.35.0，`session.clearGoal`）；本来就没有时返回 `false`。进行中的回合不受影响。和 `startGoal` 同时实现。
   * 错误：`session_not_found`、`session_closed`、`invalid_input`（子会话）、`engine_unavailable`、`disposed`。
   */
  clearGoal?(engineSessionId: string): Promise<boolean>;

  /**
   * 这个会话所在的引擎有没有某个可选方法（0.24.0），或计划模式（0.36.0，`planMode`）：多引擎的路由（host/engine-router.ts）实现
   * 它，Host 在开始命令回合、开始计划模式的回合之前问，引擎没有时直接拒绝、不写事件。单个引擎的适配器不实现，看方法在不在
   * （`planMode` 看那个属性）。
   */
  supports?(engineSessionId: string, method: SessionCapability): boolean;

  /**
   * 引擎有计划模式（0.36.0，domain-model §3.17）：`send` 的 `collaborationMode: 'plan'` 让回合只做不改动工作区的事，计划以
   * `plan.proposed` 报出。有它 Host 才声明 `plan_mode`，`engineFeatures` 带 `planMode`（Codex：协作模式；Claude：权限模式
   * `plan`）。
   */
  readonly planMode?: boolean;

  /**
   * 换会话的模型、推理档位（0.9.0，`session.configure`）或权限模式（0.11.0）：Host 每次给全部当前值，从下一个回合起用新的
   * 值，进行中的回合不受影响（Codex：下一个 `turn/start` 带 `model`、`effort` 与审批、沙箱设置）。`reasoningEffort` 省略
   * 表示不指定，用模型的默认档位；`permissionMode` 省略表示 `on_request`。会话没挂着（关闭、脱开）时 Host 不调它，之后
   * `resumeSession` 的配置里就是新的值。不实现表示引擎不能在会话中换（dsh），Host 不声明 `session_configure`。
   * 错误：`session_not_found`、`invalid_input`（Provider 没有这个模型、子会话）、`disposed`。
   */
  configureSession?(
    engineSessionId: string,
    config: { modelId: string; reasoningEffort?: string; permissionMode?: PermissionMode },
  ): Promise<void>;

  /**
   * 引擎支持的权限模式（0.11.0）。有它 Host 才声明 `permission_modes`，接受 `session.create` / `session.configure` 的
   * `permissionMode`，并在建会话、恢复、`configureSession` 时交给引擎；没有表示引擎只有自己的审批方式（dsh：ACP 的审批），
   * Host 只接受 `on_request`。
   */
  readonly permissionModes?: readonly PermissionMode[];

  /**
   * 引擎能给一个会话 `cwd` 之外的可写目录（0.15.0，`SessionConfig.additionalRoots`，多文件夹的环境要它）。没有时 Host 不接受
   * 多文件夹的环境会话。
   */
  readonly additionalRoots?: boolean;
  /** 服务账号认证的 Vertex Provider（0.21.0）。 */
  readonly googleVertex?: boolean;

  /**
   * 这个 Provider 与模型的会话收不收用户消息里的图片（0.28.0，`AgentInput` 的 `image` 段）。Host 在接受带图片的消息之前问它，
   * 回答 `false` 时回 `INVALID_PARAMS`、不写事件；多引擎的路由问承载这类 Provider 的引擎。适配器按引擎与模型回答（Codex：
   * 模型声明了 `supportsImages`，否则 Codex 会把图片换成占位文字）。不实现表示引擎只收文本，Host 不声明 `user_images`。
   */
  acceptsImages?(config: { providerId: string; modelId: string }): boolean;

  /**
   * 从会话分出一个新会话。`options` 省略时同 `{ kind: 'side' }`。支线（0.17.0，U23.1，domain-model §3.12）：新的引擎会话带着原会话到最近一个完成的回合为止的上下文，
   * 引擎不持久化它，模型知道这是支线、之前的历史只作参考（Codex：`thread/fork` 带 `ephemeral`，再用 `thread/inject_items`
   * 补一条边界说明）。原会话不受影响，回合进行中也可以。`config` 是支线的配置（同 `createSession`；`cwd` 与原会话相同）。
   * 返回后像 `createSession` 一样 `subscribe`。不实现表示引擎不能分支，Host 不声明 `side_sessions`。
   * 错误：`session_not_found`、`session_closed`、`invalid_input`（子会话、还没有完成的回合）、`engine_unavailable`、
   * `disposed`。
   */
  fork?(
    engineSessionId: string,
    config: SessionConfig,
    options?: ForkOptions,
  ): Promise<EngineSession>;

  /**
   * 能分支到新会话（0.38.0，`fork` 的 `{ kind: 'branch' }`）：分出的是持久化的普通会话，能从任一完成的回合分（`dropTurns`）。有它
   * Host 才声明 `session_branches`、在 `engineFeatures` 里报 `branch`。
   */
  readonly branches?: boolean;

  /**
   * 撤回会话最后一个完成的回合（0.38.0，`session.rewind`）：引擎的上下文回到这个回合之前，下一个回合接着之前的历史（Codex：
   * `thread/revert`，`beforeTurnId` 是 thread 最后一个回合）。不改文件。会话要空闲（没有进行中的回合）、至少有一个完成的回合。
   * 不实现表示引擎不能撤回，Host 不声明 `session_rewind`。
   * 错误：`session_not_found`、`session_closed`、`session_busy`、`invalid_input`（子会话、支线、没有回合）、`engine_unavailable`。
   */
  rewind?(engineSessionId: string): Promise<void>;

  /**
   * 引擎能让 agent 建议后续任务（0.16.0，U23）：回合里以 `tasks.suggested` 报出。有它 Host 才声明 `suggested_tasks`。
   */
  readonly suggestedTasks?: boolean;

  /**
   * 引擎的会话挂上了读历史的本机 MCP 服务（0.25.0，接力，`@wevir/runtime-adapter/history-tool`）：会话从别的来源接力过来后，
   * 模型能用 `read_session_history` 读换来源之前的完整历史。Host 据此在交给它的摘要里提这个工具。
   */
  readonly historyTool?: boolean;

  /**
   * 引擎会话能挂上 Host 的应用级工具（0.30.0，`SessionConfig.appTools`）。有它 Host 才在建会话、恢复、分支与接力时给令牌，
   * 并在 `engineFeatures` 里报 `appTools`。
   */
  readonly appTools?: boolean;

  /**
   * 引擎级的应用级工具入口（OpenCode，domain-model §3.15）：一个引擎进程服务所有会话、MCP 服务挂不到单个会话上的引擎实现它。
   * Host 在 `wevir` MCP 端点监听之后调用一次；`grant(kinds)` 给出端点与一个只认这些 Provider 种类的会话的引擎令牌（Host 运行期间
   * 不变）。带引擎令牌的请求在 `APP_TOOLS_ENGINE_SESSION_HEADER` 里写调用工具的引擎会话 ID，Host 映射回 Wevir 会话，之后同按会话
   * 的令牌。
   */
  bindEngineAppTools?(grant: EngineAppToolsGrant): void;

  /**
   * 往会话的引擎上下文补一条说明，不开回合（0.16.0，U23：用户开出的任务会话回报结果，domain-model §3.11）。模型从下一次
   * 请求起看得到；回合进行中也可以调用。不实现时 Host 只写事件（Codex：`thread/inject_items`）。
   * 错误：`session_not_found`、`session_closed`（会话没挂着）、`disposed`。
   */
  injectNote?(engineSessionId: string, text: string): Promise<void>;

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
   * 回答一组提问（0.10.0，Codex：`item/tool/requestUserInput` 的回复）：按问题 ID 给回答（选中的选项 `label` 或用户填写
   * 的文本），没给的当作跳过。提问随即结束，回合接着做。不实现表示引擎不会提问，Host 不声明 `user_questions`。
   * 错误：`session_not_found`、`question_not_found`、`disposed`。
   */
  respondToQuestion?(
    engineSessionId: string,
    requestId: string,
    answers: Record<string, string[]>,
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
   *
   * `options.notifyParent`（0.14.0，U21）：用户单独停掉的是一个子会话（不是父会话取消时的级联），引擎能告诉父 agent
   * 时在回合结算后告诉它（Codex：往父 thread 补一条说明，codex-event-mapping.md §6.5）；做不到就忽略。
   *
   * 会话目标进行中时（0.35.0）先暂停目标，免得引擎在回合停下后又开回合接着做（同 Codex 终端界面的停止）。
   */
  cancel(engineSessionId: string, options?: CancelOptions): Promise<void>;

  /**
   * 关闭会话（dsh：ACP `session/close`）。有回合在进行时先按 `cancel` 取消。完成后该会话的订阅结束，
   * `send` 报 `session_closed`；可以 `resumeSession`。已关闭时直接成功。
   * 错误：`session_not_found`、`cancel_unconfirmed`、`disposed`。
   */
  close(engineSessionId: string): Promise<void>;

  /**
   * 永久删掉引擎为这个会话存下的数据（0.43.0，`session.delete`，domain-model §3.20）：引擎会话已经关闭，之后不能再
   * `resumeSession`。Host 重启后适配器不认识这个会话，所以带上它最后用的 `providerId`，多引擎的路由按它找引擎。引擎没有这个会话时
   * 直接成功。挂着时先关闭。不实现表示引擎的数据留着，Host 在结果里报 `engineDataKept`（Codex：`thread/delete`，连同它派出的子
   * thread；echo：忘掉它）。
   * 错误：`engine_unavailable`、`disposed`，以及引擎拒绝时的 `invalid_input`。
   */
  deleteSession?(engineSessionId: string, options: { providerId: string }): Promise<void>;

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
 * 引擎的账号（R6，domain-model §3.6）。凭据由引擎自己保存，Host 不读、不转交令牌，这里只有状态；引擎就在适配器里运行时
 * （Cursor 的 SDK），由适配器存在数据目录的引擎目录下交给它（adapter-cursor 的 credentials.ts）。
 * 方法都可能抛 `AdapterError`：`invalid_input`（种类不支持）、`engine_unavailable`（引擎起不来、请求失败）、`disposed`。
 */
export interface EngineAccounts {
  /** 支持的账号种类。 */
  readonly kinds: readonly AccountKind[];
  /**
   * 读状态；已登录时尽力附带用量。`refresh`（0.19.0）：重新找可执行文件、重读登录状态；不带时可以用最近一次的结果
   * （订阅来源的检测可能要起进程，引擎自己决定缓存多久）。
   */
  read(kind: AccountKind, options?: { refresh?: boolean }): Promise<AccountState>;
  /**
   * 开始登录，返回 `signing_in` 的状态（带 `login`）；已有进行中的登录时替换它。后面接着好几家上游的引擎（OpenCode，0.56.0）
   * 另认 `options`：`upstream` 选接哪一家，`option` 选方式，`apiKey` 是填 Key 的方式用的 Key（立即返回重新检测后的状态）；
   * 实现了 `upstreams` 的引擎才会收到 `options`。
   */
  login(
    kind: AccountKind,
    method: AccountLoginMethod,
    options?: AccountLoginOptions,
  ): Promise<AccountState>;
  /** 取消进行中的登录；`loginId` 不是当前的时什么都不做。返回取消之后的状态。 */
  cancelLogin(kind: AccountKind, loginId?: string): Promise<AccountState>;
  /** 登出，没登录时同样成功。`options.upstream`（0.56.0）：只断开这一家上游。 */
  logout(kind: AccountKind, options?: { upstream?: string }): Promise<AccountState>;
  /**
   * 后面接着好几家上游的引擎（OpenCode，0.56.0，Host 功能 `subscription_upstreams`）：能在应用内接的上游，常用的在前。不实现
   * 表示这类账号没有上游。
   */
  upstreams?(kind: AccountKind): Promise<AccountUpstream[]>;
  /** 账号能用的模型（Host 用它填 `chatgpt` 与订阅来源的 Provider 的模型列表）。 */
  models(kind: AccountKind): Promise<AccountModels>;
  /**
   * 指定这类订阅的引擎用的可执行文件（0.19.0，`account.setPath`），`null` 回到自动查找；返回重新检测后的状态。Host 启动时
   * 也用它把记下的路径交给引擎。不实现表示不能指定。
   */
  setExecutablePath?(kind: AccountKind, path: string | null): Promise<AccountState>;
  /**
   * 下载安装这类订阅的引擎（0.19.0，`account.install`，状态带 `canInstall` 的种类）：立即返回带 `installing` 的状态，进度、
   * 完成与失败经 `onChange` 报告；已在安装时返回当前状态。不实现表示不能安装。
   */
  install?(kind: AccountKind): Promise<AccountState>;
  /**
   * 状态变了（登录开始、完成、失败、取消，登出，套餐或用量变化）时调用，带完整的状态。返回退订函数。监听器里抛错不影响别的
   * 监听器。
   */
  onChange(listener: (state: AccountState) => void): () => void;
}
