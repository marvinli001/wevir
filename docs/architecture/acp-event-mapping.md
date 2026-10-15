# ACP → Wevir 事件映射

> 状态：v0.3（Grok Build 接入：§1.5 逐字增量、§1.6 `plan` 待办、§1.7 扩展方法；v0.2 是 R7 拆成通用 ACP 映射与 dsh 专属补充两部分；v0.1 是 T3.2，§5 审批由 T3.3 补）· 日期：2026-10-15
> 依据：[dsh 接入 Spike](../research/dsh-integration-spike.md) §3、§4、§5、§11.2；[ADR-0001](../adr/0001-runtime-integration.md) §3、§5、§6 与补记 3、4；[ADR-0005](../adr/0005-agent-runtime-and-model-gateway.md) 决策 1.3；[领域模型](./domain-model.md) §3.4、§5、§6、§7、§9
> 代码：第一部分在 `packages/adapter-acp/src/`（`acp-process.ts`、`acp-mapping.ts`、`session-events.ts`、`chunk-stream.ts`、`acp-adapter.ts`，引擎描述的类型在 `engine.ts`，用户自己装的引擎的查找在 `external.ts`）；第二部分在 `packages/adapter-dsh/src/`（引擎描述 `engine.ts`，以及 `dsh-process.ts`、`tool-display.ts`、`turn-error.ts`、`resume-error.ts`、`stream-tap.ts`、`delta-merge.ts`、`dsh-adapter.ts`）
> 样本：`packages/adapter-dsh/src/test-fixtures/acp/`，是 `spikes/dsh-acp/fixtures/acp/`（T0.3，`2ce30c0`）的副本，另加 T3.2 录的 5 个 Provider 错误；下文的样本路径都相对这个目录

本文件写 ACP 引擎的消息怎样变成 `AgentEvent`（`packages/runtime-adapter/src/events.ts`），Host 再照 domain-model.md §6 写成 `WevirEvent`。分两部分：

- **第一部分：通用 ACP 映射**（§0、§1），`@wevir/adapter-acp` 对任何 ACP 引擎都一样的部分：进程与事件路径、`session/update` 与其他 ACP 消息的映射、审批桥接、会话恢复与取消的兜底。引擎之间的差异只经引擎描述注入（§0.2）。
- **第二部分：dsh 专属补充**（§2–§6），`@wevir/adapter-dsh` 给出的那份引擎描述与 dsh 自己的行为：工具名表、回合失败的归类、增量与已提交消息的对齐（stream-tap）、什么时候会有审批、resume 失败的归类。

样本都是 dsh 的。§1 的类型表、§2 的工具名表、§3 的错误归类表与 §6 的 resume 归类表和代码的一致性由 `packages/adapter-dsh/src/acp-event-mapping.test.ts` 检查（它按节号找表，节号与每节的第一张表不要动）；改映射时两边一起改。每个样本都有对应的测试，或在 `acp-mapping.test.ts` 里写明由别处覆盖、为什么不属于 T3.2。

# 第一部分：通用 ACP 映射（`@wevir/adapter-acp`）

## 0. 事件路径与引擎描述

### 0.1 事件路径

```text
引擎 stdout ──ndJsonStream──▶ AcpProcess 截下 session/update（原样，按写出顺序）──┐
                              其余消息 ──▶ ACP SDK（请求、响应、request_permission）│
增量旁路的 fd（可选）──引擎的解码器──▶ assistant.delta / assistant.stream_ended ────┤
                                                                                  ▼
                                     AcpAdapter 按 sessionId 路由 ──▶ SessionEventQueue（每个引擎会话一个）
                                                                     映射（mapAcpUpdate）→ 对齐增量（引擎的对齐器）
                                                                     → EventHub ──▶ subscribe()
AcpAdapter.send：session/prompt 的结果 / 错误 ──▶ turn.settled / turn.failed（同一个队列）
ACP SDK 交来的 session/request_permission ──▶ approval.requested；结束未决审批 ──▶ approval.cancelled（同一个队列，§1.3）
AcpProcess 的 exit 事件 ──▶ 每个挂着的会话一条 engine.exited，订阅结束
```

- **在 SDK 之前截下 `session/update`。** ACP SDK 收到通知先用 zod 校验：不认识的 `sessionUpdate` 类型校验失败，通知不交给处理器（SDK 只打印一行错误）；认识的类型里不认识的字段被删掉，不认识的枚举值（例如 `kind`）被丢掉（T3.2 用 SDK 1.4.0 实测）。而不认识的内容要以 `engine.raw` 原样保留。所以 `AcpProcess` 在 `ndJsonStream` 与 SDK 之间插了一个 `TransformStream`：`session/update` 不往下传，原样同步交给 `onSessionUpdate`，其余消息照常给 SDK。
- **顺序。** 截取发生在 SDK 读到消息之前，同一条流里排在后面的 `session/prompt` 响应兑现时，它前面的通知都已入队，所以每个回合的终结事件都在该回合其他事件之后，这一点由构造保证，不依赖 SDK 内部的微任务次序。每个引擎会话一个 `SessionEventQueue`，几路输入（ACP 更新、旁路增量、审批、回合边界）都是同步调用，按调用顺序产出。
- **增量旁路**是可选的（引擎描述的 `incremental`）：ACP 只有已提交消息的引擎另开一个 fd 送逐字增量。它走另一条管道，与 stdout 之间没有顺序保证，对齐交给引擎给的对齐器（dsh 见 §4）。旁路里不属于任何挂着的会话的帧直接丢弃（dsh 子 agent 的会话，ACP 看不到）。没有旁路的引擎只有已提交消息，`replaces` 恒为空。
- **回合之外**只发 `engine.raw`、`usage.updated` 与 `engine.exited`（events.ts 的顺序约定，Host 也只在回合外接受这几种）：回合外到达的其他 ACP 更新改发 `engine.raw` 并告警；增量与 `stream_ended` 丢弃（dsh 的 committed end 帧可能晚于 `session/prompt` 的结果，T3.2a 实测）。

### 0.2 引擎描述

通用适配器对一个引擎要知道的差异都在引擎描述里：与进程实例无关的 `AcpEngine`（`engine.ts`），加上每个进程一份的启动器 `AcpLauncher`（`acp-process.ts`；入口、参数与环境随数据目录和 Provider 配置变化）。dsh 的那份是 `DSH_ENGINE`（`packages/adapter-dsh/src/engine.ts`）与 `DshProcess` 的启动器。

| 项 | 用途 | dsh（第二部分） |
|---|---|---|
| `name`、`version` | 错误与告警里的引擎名（“dsh 进程已退出…”，默认告警前缀 `[adapter-<name>]`）；`EngineSession.engineVersion` | `dsh`；锁定的 `0.2.1-alpha.2`（ACP 的 `agentInfo.version` 恒为 0.0.1，T0.3 §3.1） |
| 启动器 `AcpLauncher` | 可执行入口与参数、cwd、环境。每次启动、自动重启、计划重启之前先准备（建目录、解析入口、准备旁路），再按当时的启动配置给出 spawn 参数 | `<Node> <dsh 入口> --profile acp [--patch <overlay>]…`，cwd 是 `DSH_HOME`，白名单环境（ADR-0001 §4 与补记 1） |
| `capabilities` | 契约测试的能力表；`incrementalStream` 不在表里，由旁路的状态决定（`acpAdapterCapabilities`） | 工具调用、审批、resume、多会话并发都为 true（`dshAdapterCapabilities`） |
| `tools` | 工具的展示类型（`display`，拿到整条 `tool_call`，要看 `kind`、`locations` 的引擎从这里取）与待办（`todos`） | 按工具名取（§2）；待办工具是 `todo_write` |
| `route` | 选模型与推理强度的 config option，模型选项值的编码与解码 | `model` 的值是 `JSON.stringify([provider, model])`，推理强度是 `reasoning_effort` |
| `classifyTurnError` | `session/prompt` 的错误 → `turn.failed.category`，原文保留 | §3 |
| `classifyResumeError` | `session/resume` 的错误 → `lost`（带原因）/ `cwd_mismatch` / `already_active` / `unknown` | §6 |
| `incremental`（可选） | 增量旁路：fd、每个进程的解码器、initialize 之后等它报到的时间、每个会话的对齐器 | stream-tap 插件，fd 3，2 s，`DeltaMerger`（§4） |
| `messageChunks`（可选） | 消息与思考的 chunk 是已提交的整块（`committed`，默认）还是逐字增量（`streamed`，§1.5） | `committed` |
| `tools.isPlanTool`（可选） | 引擎用 ACP `plan` 报完整的待办列表时，哪些工具调用写待办（§1.6） | 不用（待办来自 `todo_write` 的输入） |
| `route.modelMethod`（可选） | 换模型用 `session/set_config_option`（默认）还是 `session/set_model`（推理强度在 `_meta.reasoningEffort`）；`encode` 返回 undefined 表示不换模型 | `config_option` |
| `initializeMeta`、`extensions`、`approvalOptions`（可选） | `initialize` 的 `_meta`；引擎的 ACP 扩展通知与扩展请求的方法名（§1.7）；交给用户之前过滤审批选项 | 不用 |

进程（`AcpProcess`）对所有引擎都一样，数值是在 dsh 上实测定下的（ADR-0001 补记 1）：`initialize` 的 `clientCapabilities` 为 `{}`（不声明 `fs` 与 `terminal`，工具在引擎自己的沙箱里执行），时限 15 s，协议版本不是 1 算启动失败；启动失败报 `engine_unavailable`，带退出码与 stderr 尾部（只留最后 16 KiB）。就绪的进程意外退出时发 `exit`，自动重启最多连续 3 次（等 0.5 s、1 s、2 s），连续运行满 60 s 后重新计数。回收是关连接 → 关 stdin 等 2 s → SIGTERM 等 1.5 s → SIGKILL 等 1 s，启动器以 detached 启动时信号发给整个进程组。引擎不热加载配置时，换了启动配置（`launchConfigStale`）的进程要重启才生效，什么时候重启由引擎的适配器决定（dsh 见第二部分开头）。

Grok Build 的那份是 `GROK_ENGINE`（`packages/adapter-grok/src/engine.ts`，[grok-event-mapping.md](./grok-event-mapping.md)）：逐字增量、`plan` 待办、`session/set_model`、xAI 扩展；它的适配器还用到 `AcpAdapter` 给子类的扩展点（`promptMeta` / `cancelMeta`、`extNotification` / `extRequest`、`completeTurn`、`requestApproval`、`requestAnswers` / `answerQuestion`、`applyRoute`、`authenticateAfter`，§1.7）。Gemini CLI（codex-notes §9）还没有接。

## 1. ACP 消息 → AgentEvent

### 1.1 `session/update` 类型

| ACP `sessionUpdate` | Wevir 事件 | 说明 | 样本 |
|---|---|---|---|
| `agent_message_chunk` | `assistant.message` | 一条已提交的文本块，`messageId` 原样（同一条消息的各块相同）；引擎取消时补发的已生成部分同样映射为 `assistant.message`。`replaces` 由会话队列用引擎的对齐器填写（§0.1，没有旁路时为空）。内容不是文本（图片）或缺 `messageId` 时改为 `engine.raw` | `mock/updates/agent_message_chunk.json`、`mock/transcripts/E2-cancel-during-generation.jsonl` |
| `agent_thought_chunk` | `assistant.thought` | 推理块，规则同上 | `mock/updates/agent_thought_chunk.json`、`mock/transcripts/F-stream-granularity.jsonl` |
| `tool_call` | `tool.started`、`todo.updated`、`tool.finished` | `title` 是工具名，`rawInput` 原样作 `input`，展示类型由引擎描述的 `tools.display` 给出。引擎的 `tools.todos` 认出写待办的工具（完整列表）时，紧跟一条 `todo.updated`。ACP 允许 `tool_call` 直接带终态，那时再跟一条 `tool.finished` | `mock/updates/tool_call.json`、`mock/transcripts/todo-subagent.jsonl` |
| `tool_call_update` | `tool.finished`、`tool.updated` | `status` 为 `completed` / `failed` 时是 `tool.finished`，`output` 是 `content` 里各文本块按顺序直接拼接的原文（模型看到的同一段文本），截断由 Host 做；取消期间的 `failed` 由 Host 记为 `cancelled`（domain-model.md §6.4）。其余状态（`pending`、`in_progress`、缺省）是 `tool.updated`，带 `title` 时重新计算展示类型。`content` 里有非文本项（`diff`、`terminal`、图片）时文本照常进 `output`，整条另发一条 `engine.raw` | `mock/updates/tool_call_update.completed.json`、`mock/updates/tool_call_update.failed.json` |
| `usage_update` | `usage.updated` | `used` → `contextUsed`，`size` → `contextSize`；`cost` 不映射 | `mock/updates/usage_update.json` |
| `config_option_update` | `engine.raw` | 认识的类型，v0 没有中途改模型的事件（预留 `session.config_changed`，domain-model.md §6.6），有意保留为 `engine.raw`，不告警；适配器另记下其中的当前值（会话中换模型时比较用） | — |
| `available_commands_update` | `engine.raw` | 引擎的斜杠命令（Grok 每个回合都发）：Wevir 不用引擎的命令，有意保留，不告警；不截断正在流式的一块内容（§1.5） | — |
| `current_mode_update` | `engine.raw` | 引擎的模式（Grok 的计划模式）：Wevir 不用引擎的模式，有意保留，不告警 | — |
| `session_info_update` | `engine.raw` | 引擎起的会话标题：标题由 Host 生成，有意保留，不告警 | — |

其余情况一律映射为一条 `engine.raw`（`protocol: 'acp'`、`method: 'session/update'`、`kind` 为 `sessionUpdate` 的值、`params` 是整条通知的原样参数），不丢弃，并按“原因 + 类型”在一个适配器实例内只告警一次：

- 映射还不认识的类型：`user_message_chunk`、`plan`（引擎描述有 `tools.isPlanTool` 时另见 §1.6）、`plan_update`、`plan_removed`、`compaction_update`、`compaction_summary_chunk`（ACP SDK 1.4.0 的其余类型，dsh 都不发），以及将来的新类型；
- 认识的类型但字段不合预期：缺必需字段、`status` 或 `content` 的值不认识、`usage_update` 的数值不是非负数。

`session/update` 本身缺 `sessionId` 或 `update.sessionUpdate` 时无法路由到会话，告警后丢弃；属于没有挂着的会话的更新同样告警后丢弃。

### 1.2 其他 ACP 消息

不经过 `mapAcpUpdate`：

| ACP 消息 | Wevir 事件 | 说明 | 样本 |
|---|---|---|---|
| `session/prompt` 结果 | `turn.settled` | `stopReason` 原样；`cancelled` 时 `outcome: 'cancelled'`，其余（`end_turn`、`max_tokens`…）为 `completed` | 全部 `mock/transcripts/*.jsonl` |
| `session/prompt` 错误 | `turn.failed` | 按引擎描述的 `classifyTurnError` 归类（dsh 见 §3），原文与错误码保留 | `errors/prompt-*.json` |
| 引擎进程退出 | `engine.exited` | 每个挂着的会话一条，是订阅的最后一个事件；进行中的回合不再有 `turn.*` | — |
| `session/request_permission` | `approval.requested`；结束时 `approval.cancelled` | 经 ACP SDK 应答（不截下）：适配器分配 `requestId`，选项原样，挂起到 `respondToApproval`，或以 `cancelled` 回复（§1.3） | `mock/permission/request.json`、`mock/transcripts/B-permission-allow.jsonl` |
| `session/new` 结果 | 无 | `configOptions` 里引擎当前的模型与推理强度（按引擎描述的 `route` 解码）作为 `createSession` 的返回值；与 `SessionConfig` 不同时先 `session/set_config_option`，返回设置之后的值；选不上报 `invalid_input`，刚建的会话在引擎侧关掉（dsh：T3.4，providers.md §2.2） | `session-new.response.json`、`session-new.openai-compatible.response.json` |
| 适配器有计划地重启引擎 | `engine.exited`（带 `reason`） | `exitCode` / `signal` 为 null。`cancel_unconfirmed`：取消得不到确认（§1.4）；`config_changed`：dsh 为应用新的 Provider 配置，只在没有回合时发生（第二部分开头，providers.md §5） | — |

### 1.3 审批桥接

代码在 `acp-adapter.ts`（`#onRequestPermission`、`requestApproval`、`respondToApproval`、`#cancelPending`）；Host 一侧的审批状态机见 domain-model.md §5 与 §4.3。dsh 什么时候请求审批、给哪些选项、怎样解读回复见 §5。

| ACP | AgentEvent 或适配器方法 | 说明 | 样本 |
|---|---|---|---|
| `session/request_permission` `{sessionId, toolCall: {toolCallId}, options}` | `approval.requested` | `requestId` 由适配器分配（`perm-<n>`，在适配器实例内唯一；不用 JSON-RPC id，它在引擎重启后会重复）；`toolCallId` 原样；`options` 原样（`optionId`、`name` → `label`、`kind`） | `mock/permission/request.json` |
| 回复 `{"outcome":{"outcome":"selected","optionId":…}}` | `respondToApproval(engineSessionId, requestId, {optionId})` | `optionId` 不在 `options` 里报 `invalid_option`，审批保持未决、什么都不写；回复之后同一 `requestId` 报 `approval_not_found` | `mock/permission/responses.json` 的 `allow`、`deny` |
| 回复 `{"outcome":{"outcome":"cancelled"}}` | `approval.cancelled` | 下面的“挂起审批的结束” | `mock/permission/responses.json` 的 `cancelled` |

- **详情不在适配器里拼。** 请求只带 `toolCallId`。审批详情由 Host 从同一会话、同一 `toolCallId` 的 `tool.started`（即 `tool_call` 的 `rawInput`）生成 `ApprovalRequest.detail`（domain-model.md §3.4）：`toolName`、`display`（§1.1 的展示类型；dsh 的 `write` 的 `summary` 与 `paths` 是目标路径）、`input`（截断规则同工具输出）、`justification`、`sandboxPermissions`（后两个是 dsh 升级请求带的字段，§5.1）。找不到对应的 `tool.started` 时 `detail` 为 null，界面用通用文案。
- **顺序。** 引擎先把积压的 `session/update` 写完才发审批请求时（dsh 是这样，§5.2），该工具的 `tool.started` 一定在 `approval.requested` 之前：`AcpProcess` 在 SDK 读到消息之前就同步截下更新（§0.1），SDK 把审批请求交给处理器时，前面的更新都已入队。审批请求本身不截下，由 SDK 校验并经它的写队列回复。

**挂起审批的结束。** 适配器不给审批设时限，等用户决定（dsh 自己也不设，§5.4）；下表的情况由适配器以 `cancelled` 回复并发 `approval.cancelled`，之后对该 `requestId` 的 `respondToApproval` 报 `approval_not_found`。

| 触发 | 适配器 | `approval.cancelled.reason` | Host 的结算（domain-model.md §4.1、§5） |
|---|---|---|---|
| `session.cancel` → `cancel` | 先写 `session/cancel`，再以 `cancelled` 回复（T0.3 场景 D 的顺序；SDK 在 `notify` 调用时就把通知排进写队列） | `turn_cancelled` | 调适配器之前已写 `cancelled`（`turn_cancelled`），适配器的事件被忽略 |
| `session.close` → `close` | 先按 `cancel` 取消 | `turn_cancelled` | `cancelled`（`session_closed`） |
| 取消开始之后才到的审批请求 | 照常上报 `approval.requested`，随即以 `cancelled` 回复 | `turn_cancelled` | 同一事务里记下并结为 `cancelled`（domain-model.md §4.3） |
| 回合在审批未决时结算；引擎撤回请求（dsh 两者都不会，防御） | 以 `cancelled` 回复 | `turn_ended` | `cancelled`（`turn_cancelled`） |
| 引擎进程退出 | 已无从回复；`approval.cancelled` 在 `engine.exited` 之前 | `engine_exited` | 随 `engine.exited` 一并结为 `cancelled`（`engine_exited`，#10） |
| Host 优雅退出 | `SessionManager.shutdown()` 先按会话取消（同第一行）；之后 `dispose` 兜底：以 `cancelled` 回复，等回复写进引擎的 stdin 再关连接 | `turn_cancelled`；兜底时 `disposed` | `cancelled`（`host_shutdown`） |
| Host 非正常退出后重启 | 不涉及：引擎已因 stdin EOF 随之退出（dsh 实测，ADR-0001 补记 1），没有可回复的请求 | — | 启动对账把残留的未决审批结为 `expired`（`host_restarted`） |
| 请求不属于进行中的回合（会话不认识、已关闭或已脱开、回合已结束） | 直接以 `cancelled` 回复并告警，不发事件 | — | — |

**重复决定不重复发给引擎。** Host 按会话串行处理 `approval.respond`，首个决定生效，之后返回 `ALREADY_DECIDED`，不再调适配器（domain-model.md §5）。适配器自己也保证一个 `requestId` 只回复引擎一次：先移出未决表再回复，两个决定同时到达时只有一个写给引擎，另一个报 `approval_not_found`。适配器报 `approval_not_found` 而 Host 那边仍未决，只会是引擎侧刚结束了这个审批：对应的 `approval.cancelled` 已在 Host 暂扣的事件里，Host 处理后返回 `ALREADY_DECIDED`（domain-model.md §4.3）。

### 1.4 会话恢复与取消的兜底

`AcpAdapter.resumeSession`。已挂在本进程上的会话直接成功，不发 ACP（dsh 拒绝 resume 同一进程里仍活跃的会话）。其余的会话（已 `close`、引擎退出或重启后脱开、适配器根本不认识它，Host 重启后就是这样）发 `session/resume`（`{sessionId, cwd, mcpServers: []}`，`cwd` 是会话创建时的工作区），成功后像建会话一样用 `session/set_config_option` 选定 Host 记录的 Provider、模型与推理强度：引擎恢复的路由可能是会话日志里最后的那个，Provider 配置换过之后已经不是它。结果带引擎描述的 `version`。引擎不回放历史（dsh 不回放任何 `session/update`），历史由 Host 的事件库负责。

失败按引擎描述的 `classifyResumeError` 归类（dsh 的规则表见 §6），适配器据此报错；`AdapterError.message` 是 `session/resume 失败：` 加引擎原文：

| 归类 | 适配器 | Host（domain-model.md §4.4） |
|---|---|---|
| `lost`（原因 `not_found` / `incompatible` / `corrupted`） | `session_lost`，原因在 `AdapterError.lostReason` | 写 `session.read_only`（原因对应 `engine_session_not_found` / `engine_session_incompatible` / `engine_session_corrupted`），会话只读 |
| `cwd_mismatch` | `session_unavailable` | 只是 `engine.error`，不标只读 |
| `already_active` | 告警后沿用，照常选定路由 | — |
| `unknown`（连接断开、引擎的其他内部错误） | `engine_unavailable` | 只是 `engine.error` |

- 路由选不上（Provider 配置里没有这个模型了）报 `invalid_input`，刚恢复的会话在引擎侧关掉。
- Host 在调适配器之前先检查工作区目录还在，不在就回 `WORKSPACE_PATH_INVALID`。

**不能插话（R11）。** ACP 没有往进行中的 `session/prompt` 追加输入的办法，`AcpAdapter` 不实现 `steer`（契约能力 `steer: false`），回合进行中带 `delivery` 的发送由 Host 一律排队，回合结束后作为下一个 `session/prompt` 发出（domain-model §4.6）。

**取消得不到确认时重启引擎。** `cancel` 发出 `session/cancel` 后 4 s 内（`CANCEL_TIMEOUT_MS`，先于 Host 的 5 s）回合没有结算，适配器报 `cancel_unconfirmed`，同时重启引擎进程：卡住的回合随旧进程结束，挂在这个进程上的会话都以 `engine.exited`（`reason: cancel_unconfirmed`，`exitCode` 与 `signal` 为 null）脱开，Host 按引擎退出处理（domain-model.md §4.1 #10，取消的那个会话已按 #9 转 `error`）。之后 resume 到新进程上；不重启的话，引擎里那个会话仍是活跃的，resume 会被拒（dsh 报 `already active`），回合也一直占着它。dsh 实测取消在 3–64 ms 内结算（T0.3），这条路径只为引擎卡住时兜底。

### 1.5 逐字增量的引擎（`messageChunks: 'streamed'`）

Grok Build 与 Gemini CLI 的 `agent_message_chunk` / `agent_thought_chunk` 是一段段逐字增量，没有 `messageId`（codex-notes §9）。引擎描述声明 `streamed` 时，会话队列不按 §1.1 的整块规则映射它们，而是交给 `ChunkStream`（`chunk-stream.ts`）：

- 一块内容是同一种（文本或思考）、同一个 `messageId`（引擎给了的话）的连续增量。每段增量发一条 `assistant.delta`（`attemptId` 是 `acp-<n>`，进程内唯一，块序号 0）。
- 换了种类、换了 `messageId`，或中间来了别的**可见**更新（工具调用、`plan`、审批或提问），这一块结束：发一条替换它的 `assistant.message` / `assistant.thought`（`messageId` 用引擎给的，没有时用 `attemptId`），再发 `assistant.stream_ended`（`committed`）。只映射成 `engine.raw` 或 `usage.updated` 的更新不截断（Grok 回合中途的 `session_info_update`）。
- 回合结束、取消或出错时，停在半途的一块按已生成的部分提交；引擎退出时同样先提交再发 `engine.exited`。回合之外的增量（`session/load` 回放的历史、引擎自己开的回合）按 §0.1 保留为 `engine.raw`。
- 内容不是文本（图片）时照 §1.1 的规则保留为 `engine.raw`。`streamed` 的引擎不能再配增量旁路。

### 1.6 ACP `plan` 作为待办（`tools.isPlanTool`）

引擎描述给了 `tools.isPlanTool` 时（Grok：`todo_write` 可以只给改动的几项，合并后的完整列表随后以 `plan` 发出），回合中的 `plan`（`entries` 的 `content`、`status`，`priority` 不用）变成一条 `todo.updated`，记在本回合最近一个 `isPlanTool` 认出的工具调用上；本回合还没有这样的调用时 `toolCallId` 是 `plan-<n>`。`entries` 形状不对时照 §1.1 保留为 `engine.raw`。没有 `isPlanTool` 的引擎（dsh）`plan` 仍是 `engine.raw`。

### 1.7 扩展方法与给子类的扩展点

ACP 的扩展方法名以 `_` 开头（Grok 的 `_x.ai/…`）。引擎描述的 `extensions` 列出要接的：

- **扩展通知**（`extensions.notifications`）与 `session/update` 一样由 `AcpProcess` 在 SDK 之前按序截下，交给适配器的 `extNotification`（子类覆盖，默认什么都不做），所以它与同一条流里的 `session/update`、`session/prompt` 结果的先后不变。没列出的扩展通知由 SDK 丢弃。
- **扩展请求**（`extensions.requests`）登记给 SDK，交给 `extRequest`（子类覆盖，默认回 `-32601`）；返回值作为响应写给引擎，抛错回 JSON-RPC 错误。

`AcpAdapter` 给引擎子类的扩展点：

| 扩展点 | 用途 | 用它的引擎 |
|---|---|---|
| `promptMeta(id)`、`cancelMeta(id)` | `session/prompt`、`session/cancel` 的 `_meta` | Grok：本回合的 `promptId`；`cancelTrigger: ctrl_c` |
| `completeTurn(id, {stopReason} 或 {error})` | 引擎用扩展通知报了回合结束：按它结算进行中的回合（同 `session/prompt` 的结果或错误，错误照 `classifyTurnError` 归类），之后到的 `session/prompt` 结果不再上报；`cancel` 等的也是这次结算 | Grok 的 `prompt_complete` / `turn_completed` |
| `requestApproval(id, toolCallId, options, signal?)` | 经扩展请求向用户要审批：与 `session/request_permission` 共用 §1.3 的记账（`perm-<n>`、`respondToApproval`、取消、回合结束、引擎退出、`dispose` 时结束），得到所选的 `optionId` 或 undefined | Grok 的退出计划模式 |
| `requestAnswers(id, toolCallId, questions, signal?)`、`answerQuestion(id, requestId, answers)` | 向用户提问：发 `question.requested`（`q-<n>`），子类的 `respondToQuestion` 经 `answerQuestion` 给回答；结束规则同审批，结束时发 `question.cancelled` | Grok 的 `ask_user_question` |
| `applyRoute(id, config)` | 给挂着、没有回合的会话重新选定模型与推理强度（会话中换模型） | Grok |
| `authenticateAfter(error)` | `session/new` / `session/resume` 失败后：引擎要先认证时认证，返回 true 重试一次；也可以抛 `missing_credentials` | Grok 的 `-32000 Authentication required` |

# 第二部分：dsh 专属补充（`@wevir/adapter-dsh`）

dsh 的引擎描述是 `DSH_ENGINE`（`engine.ts`），启动器在 `DshProcess`（`dsh-process.ts`）；`DshAdapter` 在 `AcpAdapter` 之上只多出 Provider 桥接与配置变更时的重启（providers.md）。dsh 0.2.1-alpha.2 的 ACP 面（T0.3 §3.3，上游 `packages/acp/acp/src/`）：

- `session/update` 实际只发 §1.1 表里的前 5 种；`config_option_update` 只在源码里出现（Provider 拓扑变化时，上游 `session.ts` 的 `topologyChanged`）。
- 已提交消息：每个已提交 attempt 的每个非空文本块发一条 `agent_message_chunk`、推理块一条 `agent_thought_chunk`，同一 attempt 的块 `messageId` 相同；取消时一次补发已生成的部分（§4）。
- `tool_call` 的 `kind` 恒为 `other`，`status` 直接是 `in_progress`，没有 `locations` / `diff`，所以展示类型按工具名取（§2）；`tool_call` 不带终态，`tool_call_update` 不带 `title`。工具是 `todo_write` 且 `rawInput.todos` 每项都有 `content` / `status` 时发 `todo.updated`（完整列表）。
- `usage_update` 的 `size` 在模型未声明 `contextWindow` 时是 pi-ai 的猜测值 262144；没有 `cost`。
- 会话的路由（`DSH_ROUTE`）：模型选项 `model` 的值是 JSON 编码的 `["<provider>","<model>"]`（上游 `model-control.ts`），推理强度是 `reasoning_effort`（T3.4，providers.md §2.2）。
- **配置变更时重启。** dsh 不热加载 Provider 配置（ADR-0001 补记 5）。`DshAdapter.configureProviders` 换掉下一次 spawn 的 overlay 与 Key（`DshProcess.setLaunchConfig`）；dsh 在运行且没有回合时立即重启，有回合时等最后一个回合结束再重启。挂着的会话以 `engine.exited`（`reason: config_changed`）脱开，resume 后用新配置（providers.md §5）。

## 2. 工具名 → 展示类型

dsh 的 `tools.display`（`tool-display.ts` 的 `DSH_TOOLS`）。dsh 的 `kind` 恒为 `other`、没有 `locations` / `diff`，展示类型按工具名（`tool_call.title`）取，字段从 `rawInput` 提取，原值保留（路径可能是相对路径）。字段缺失或类型不对只少字段；`rawInput` 不是对象（dsh 解析模型给的 JSON 失败时是原始字符串）时只有展示类型。分类参考 Paseo `ToolCallDetail`（domain-model.md §7）。“观测”列：✅ 在 T0.3 样本中出现过；源码 = 字段名取自上游 `d743267` 的工具定义。

| dsh 工具名 | 展示类型 | 提取字段（`rawInput` → `ToolDisplay`） | 观测 |
|---|---|---|---|
| `read` | `read` | `file_path` → `paths`、`summary` | ✅ |
| `read_image` | `read` | `file_path` → `paths`、`summary` | 源码 |
| `write` | `write` | `file_path` → `paths`、`summary`；`content`、`sandbox_permissions`、`justification` 只在 `input` 里（审批详情用，§5.2） | ✅ |
| `edit` | `edit` | `file_path` → `paths`、`summary`；`old_string` / `new_string` 只在 `input` 里（界面生成 diff，T5.3） | 源码 |
| `str_replace_editor` | `edit` | `path` → `paths`、`summary`（它的 `command` 是子命令，不是 shell 命令） | 源码 |
| `bash`、`pwsh` | `shell` | `command` → `command`；`summary` 取命令的第一个非空行 | ✅（bash） |
| `job_output`、`job_kill` | `shell` | `job_id` → `summary` | 源码 |
| `job_list` | `shell` | 无 | 源码 |
| `grep`、`glob` | `search` | `pattern` → `query`、`summary`；`path` → `paths` | 源码 |
| `web_search` | `search` | `queries`（字符串数组）以 ` \| ` 相连 → `query`、`summary` | 源码 |
| `web_fetch` | `fetch` | `url` → `url`、`summary` | 源码 |
| `todo_write` | `plan` | 无；`todos` 另发 `todo.updated` | ✅ |
| `plan` | `plan` | `plan`（Markdown）第一个非空行去掉 `#` → `summary` | 源码 |
| `subagent` | `sub_agent` | `description` → `summary`；`prompt` 只在 `input` 里 | ✅ |
| `send_message`、`interrupt_agent`、`list_agents`、`list_subagent_models` | `sub_agent` | 无 | 源码 |
| `present` | `unknown` | `files[].path` → `paths`（将来的 Artifact 来源） | 源码 |
| `mcp__<server>__<tool>` | `unknown` | 工具名里的 `<server>` → `mcpServer` | 源码（命名规则） |
| 其他任何名字 | `unknown` | 无 | — |

## 3. 回合失败的错误归类

dsh 的 `classifyTurnError`（`turn-error.ts`）。dsh 的轮次失败让 `session/prompt` 以 JSON-RPC `-32603` 结束，消息是自由文本：ACP SDK 的 `RequestError.internalError` 加 `Internal error: `，dsh-acp 再加 `turn failed: `，后面是 dsh 内部失败的原文（T0.3 §3.4）。只有 `-32603` 且带这两层包装的才按下表归类（看去掉包装之后的开头，自上而下第一条匹配的生效），其余一律 `unknown`，包括 dsh 的其他 `-32603`（`prompt was not queued: …`、`assistant output delivery failed: …`）。`turn.failed` 的 `message` 始终是完整原文，`code` 是错误码。

| 类别 | 去掉包装后的开头（正则） | 来源 | 样本 |
|---|---|---|---|
| `missing_credentials` | `/^llm-[a-z0-9-]+: no (?:API key\|credential) for /` | llm-deepseek：`no API key for provider route "…"`；llm-pi-ai：`no credential for provider route "…"` | `errors/prompt-missing-key.deepseek-official.json`、`errors/prompt-missing-key.openai-compatible.json` |
| `provider` | `/^[1-5]\d\d:? /` | llm-pi-ai 的 HTTP 错误写成 `<状态码>: <响应体里的 error JSON>`（实测 400、401、402、404、429、500）；OpenAI SDK 自己的写法是 `<状态码> <消息>` | `errors/prompt-provider-401.openai-compatible.json`、`errors/prompt-provider-429.openai-compatible.json`、`errors/prompt-provider-500.openai-compatible.json` |
| `provider` | `/^Connection error\./` | OpenAI SDK（llm-pi-ai 经它访问 OpenAI 兼容服务）：连不上、连接中途断开（实测两种都是这句） | `errors/prompt-provider-connection.openai-compatible.json` |
| `provider` | `/^Request timed out\./` | OpenAI SDK 的请求超时 | — |
| `provider` | `/^DeepSeek Messages (?:request failed\|returned no response body)/` | llm-deepseek：响应体里没有 `error.message` 时的兜底文本 | — |
| `unknown` | 其余 | 包括 llm-deepseek 的 Provider 错误：它把服务端返回的 `error.message` 原样放在 `turn failed: ` 后面（实测 401、402、400），没有状态码，也没有可依赖的前缀 | `errors/prompt-provider-401.deepseek-official.json` |

说明：

- 401 是 Key 无效，归 `provider`，不归 `missing_credentials`（后者是 Wevir 没把 Key 交给 dsh，修法不同）。
- Provider 的可重试错误（429、5xx、连接错误）dsh 默认重试 5 次（`llm-retry`，最长约 16 s），最终的错误文本与第一次相同；回合失败到达时重试已经结束。
- `errors/prompt-provider-*.json` 由 `turn-error.integration.test.ts` 用真实 dsh + 本地 mock Provider 复现并逐字比对（关掉重试）；响应体由 mock 给出，DeepSeek 401 的那句措辞是仿照的，不是官方原文。dsh 改措辞时这个测试先失败，样本与规则表一起更新；归不了类只影响类别，不影响会话状态转换（ADR-0001“后果”）。

## 4. 增量与已提交消息的对齐（stream-tap 与 `DeltaMerger`）

dsh 的增量旁路（`DSH_ENGINE.incremental`）：stream-tap 插件把 dsh 进程内的 `agent/assistant-stream` 帧写到 fd 3（ADR-0001 §3 与补记 2），`StreamTapDecoder` 解码，对齐器是 `DeltaMerger`（`delta-merge.ts`，每个会话一个、按回合重置）。规则的产品语义见 domain-model.md §6.3。依据的 dsh 行为（上游 `dsh-acp/src/updates.ts`、`dsh-llm/src/assembler.ts`、`agent-loop/src/agent.ts`）：一个 attempt 的增量全部写到 fd 3 之后才提交 `assistant/message`；ACP 按块顺序为每个长度非零的文本块、推理块各发一条 chunk（同一 `messageId`）；取消时只保留含非空白字符的块，一个都没有就不提交消息，记为 `assistant/attempt`。旁路帧在 fd 3 上有序，但 fd 3 与 stdout 之间没有顺序。

1. attempt 按第一个增量的到达顺序排队等已提交消息。ACP 出现新的 `messageId` 时，取队列里第一个内容对得上的 attempt：它有一个未被替换的同类块，块的文本是已提交文本的前缀（前缀而不是相等，因为尾部增量可能还在 fd 3 里）。排在它前面的 attempt 不会再有已提交消息，一并出队。同一 `messageId` 的后续 chunk 在该 attempt 里按块顺序找下一个对得上的块。
2. 配对之后该 attempt 再到的增量丢弃：已提交内容已经替换了它。
3. 已提交消息到达时一个对得上的 attempt 都没有（增量整个落在消息之后），先记下；之后出现的 attempt 若第一段增量是它的前缀，就认定属于这条已经发出的消息，增量全部丢弃。
4. 被替换块之前、同类且只含空白的块一并替换（取消时 dsh 丢掉这些块）。
5. `abandoned` 的 end 帧让 attempt 出队；end 帧是 committed 但落成 `assistant/attempt` 的（没有已提交消息），`StreamTapDecoder` 已把它报成 `abandoned`。没发出过增量的 attempt 不发 `stream_ended`。
6. 内容对不上（例如旁路丢了一行畸形数据）时 `replaces` 为空，残留的增量由 Host 在回合结束时丢弃（domain-model.md §6.3 规则 4），不会留下重复文本。

测试：`delta-merge.test.ts` 用 F（思考 + 消息）、E2（取消时的半段消息，含前置空白块与迟到的尾部增量）、todo-subagent（一个回合多个 attempt）的已提交消息配旁路帧形状（`stream-tap/frames.sample.json`）构造的增量；`dsh-adapter.integration.test.ts` 用真实 dsh + mock Provider 覆盖正常回合与生成中取消。

## 5. 审批：dsh 的部分

通用的桥接（请求与回复、挂起审批的结束、重复决定）见 §1.3。这里是 dsh 什么时候请求审批、给哪些选项、怎样解读回复，以及界面与测试据此的设计。

### 5.1 什么时候会有审批：只来自沙箱升级

dsh 的审批**只来自沙箱升级**，不是“每次写文件都问”（ADR-0001 §6，T0.3 §5.1）。Wevir 显式设置 `DSH_PERMISSION_MODE=workspace-write`（ADR-0001 §4），审批策略是 dsh 默认的 `ask`。这个模式下可写的根是工作区（`session/new` 的 `cwd`）、`/tmp` 与 dsh 进程的系统临时目录 `os.tmpdir()`（上游 `packages/sandbox/sandbox/src/roots.ts` 的 `writableRoots`；Seatbelt 配置与进程内文件围栏共用这一份）。

| 操作 | 结果 | 审批 | 依据 |
|---|---|---|---|
| 工作区内读写 | 直接执行 | 没有 | T0.3 场景 A |
| 工作区外、但在系统临时目录下的写入 | 直接执行 | 没有 | T0.3 场景 B0 |
| 工作区外其他路径的写入（`write`、`edit`，bash 里的同类操作） | 第一次调用失败，结果带 `[sandbox: file access denied under workspace-write mode]` 和“带 `sandbox_permissions` 与 `justification` 重试一次”的提示 | 没有 | 场景 B / C / D 的第一次调用 |
| 模型按提示带 `sandbox_permissions`（从 `workspace-write` 只能升到 `danger-full-access`）与 `justification` 重试 | 执行之前发 `session/request_permission` | **有** | 场景 B / C / D 的第二次调用 |

前三行与第四行都由 `dsh-adapter.approval.integration.test.ts` 用真实 dsh + mock Provider 复核。卡片出现与否取决于模型是否升级：mock Provider 按脚本升级；真实模型是否可靠升级由同一文件里的真实模型用例检验（需要 `WEVIR_TEST_API_KEY`，ADR-0001 未决事项 3）。

一次升级在事件流里是**两个工具调用**（`mock/transcripts/B-permission-allow.jsonl`）：

```text
tool.started   write {file_path, content}                                    第一次
tool.finished  failed "[sandbox: file access denied under workspace-write mode] … retry …"
tool.started   write {file_path, content, sandbox_permissions, justification} 第二次，新的 toolCallId
approval.requested  toolCallId = 第二次的 id；options = allow-once / reject-once
（决定）
tool.finished  completed / failed（§5.3）
```

### 5.2 选项与回复的解读

- **选项。** dsh 只给 `allow-once`（`allow_once`）与 `reject-once`（`reject_once`），没有 always 类选项（`mock/permission/request.json`）；适配器原样转出（§1.3）。回给 dsh 的三种回复见 `mock/permission/responses.json`。
- **dsh 怎么解读回复。** 只有 `optionId` 为 `allow-once` 算批准，其他 `optionId` 一律按拒绝（上游 `packages/acp/acp/src/index.ts`）；`cancelled` 单独处理（§5.3）。
- **§1.3 的顺序前提成立。** dsh 先把积压的 `session/update` 写完才发审批请求（上游 `index.ts` 的 `drainUpdates`），所以该工具的 `tool.started` 一定在 `approval.requested` 之前；dsh 收到回复之前不会写出这个工具的结果，所以 `approval.requested` 也在该工具的 `tool.finished` 之前。
- **详情的字段。** 升级请求对应的 `tool_call.rawInput` 里有路径、内容、`sandbox_permissions` 与模型写的 `justification`（§5.1），Host 用它生成审批详情（§1.3）。

### 5.3 决定之后的工具结果

| 决定 | 回复 | 该工具的 `tool.finished`（输出是模型看到的同一段文本） | 回合 | 样本 |
|---|---|---|---|---|
| 批准 | `selected` `allow-once` | `completed`，文件已写 | 继续，模型汇报结果 | `B-permission-allow.jsonl`、`mock/permission/after-allow.tool-lifecycle.json` |
| 拒绝 | `selected` `reject-once` | `failed`：`Error: the user rejected escalating this operation to "danger-full-access"; it stays denied, so stop and explain instead of working around it` | 继续，模型说明 | `C-permission-deny.jsonl`、`mock/permission/after-deny.tool-lifecycle.json` |
| 取消 | `cancelled` | `failed`：`Error: approval for escalating to "danger-full-access" was cancelled`；在取消期间到达，Host 记为 `cancelled`（domain-model.md §6.4） | 以 `cancelled` 结算，没有助手回复 | `D-permission-cancel.jsonl`、`mock/permission/after-cancel.tool-lifecycle.json` |

### 5.4 挂起的审批：dsh 不超时

dsh 不给审批请求设时限，也不撤回（0.2.1-alpha.2 不发 `$/cancel_request`）：客户端不回复，dsh 就一直等，回合也一直不结算。所以审批默认不超时，等用户决定；取消、关闭、引擎退出、`dispose` 时由适配器以 `cancelled` 结束（§1.3 的表）。表里“回合在审批未决时结算”“引擎撤回请求”两种情况 dsh 都不会发生，是防御。

### 5.5 界面文案与测试用例

按 §5.1 设计：审批问的是“这一次操作能不能越过工作区的限制”，不是“能不能写文件”，工作区内的写入从不出现卡片。

- **卡片**（T4.2 CLI、T5.3 桌面）：标题按展示类型给出，`write` / `edit` 为“在工作区之外修改文件”，`shell` 为“不受工作区限制地运行命令”，其他类型或 `detail` 为 null 时为“Agent 请求越过工作区限制”。正文依次是目标（`display.summary`：路径或命令的第一行）、所需权限（`sandboxPermissions` 为 `danger-full-access` 时写“完全访问，不受工作区限制”，其余原样显示）、“Agent 给出的理由”（`justification` 原文），`write` 再附内容预览（`input.content` 的前几行）。按钮按 `options` 渲染：`allow_once` 为“允许这一次”，`reject_once` 为“拒绝”，不认识的 `kind` 显示引擎给的 `label`。没有“总是允许”（ADR-0001 §5 第 7 条）。
- **结束提示**：拒绝后“已拒绝，Agent 会停下来说明”；`cancelled` 按 `resolution.reason` 写“回合已取消”“会话已关闭”“引擎已退出”“Host 正在退出”；`expired` 写“Host 重启，这次审批已失效”；另一个客户端先做了决定时按 `approval.resolved` 收起卡片，并提示由谁决定。
- **说明文字**（设置或帮助页）：工作区内的读写、系统临时目录下的写入不经审批（`workspace-write`，T0.3 §10 要求写清楚）。
- **测试用例**：要出现审批，用例必须包含一次工作区外、且不在系统临时目录的写入。测试的临时目录通常就在系统临时目录下，写到那里不会有审批；本包的用例把目标建在 `packages/adapter-dsh/.test-outside/`（`test-fixtures/outside-dir.ts`，gitignore）。Gate M4 与计划 §4.2 第 4 条的验收同理。

测试：`dsh-adapter.approval.test.ts` 用 `fake-dsh.mjs` 回放 B / C / D 三份录制（真实子进程、真实 ACP 帧），覆盖批准、拒绝、两个决定同时到达与重复决定、审批挂起时取消、关闭、引擎退出、`dispose`，以及不属于回合的请求；回给 dsh 的响应与 `mock/permission/responses.json` 逐个相等。`dsh-adapter.approval.integration.test.ts` 用真实 dsh：mock Provider 下一次批准、一次拒绝，以及工作区内与系统临时目录的写入没有审批；真实模型用例需要 `WEVIR_TEST_API_KEY`。

## 6. 会话恢复：dsh 的部分

通用的流程与归类之后的处理见 §1.4。dsh 的 `session/resume`：`cwd` 用会话创建时工作区的 realpath（dsh 按 realpath 比较）；dsh 拒绝 resume 同一进程里仍活跃的会话；恢复的路由是会话日志里最后的那个；不回放任何 `session/update`（T0.3 §3.2）。模型可见的上下文由 dsh 的会话日志恢复，新进程 resume 后的第一个模型请求带着之前的全部消息（T0.3 §8，`dsh-adapter.resume.integration.test.ts` 用真实 dsh 复现）。`engineVersion` 是适配器锁定的 dsh 版本（ACP 的 `agentInfo.version` 恒为 0.0.1）。

失败按下表归类（`resume-error.ts` 的 `RESUME_ERROR_RULES`，即 dsh 的 `classifyResumeError`，自上而下第一条匹配的生效；适配器与 Host 据归类怎么做见 §1.4）。dsh-acp 自己拒绝的是 `-32602`；读会话日志时抛出的错误不是 RequestError，ACP SDK 把它包成 `-32603 Internal error`，原文在 `data.details`。规则匹配 `message`，`-32603` 匹配 `message` 与 `data.details` 拼成的 `Internal error: <details>`，`AdapterError.message` 保留这段全文。

| 归类 | 错误码 | 原文（正则） | 来源 | 适配器 | 样本 |
|---|---|---|---|---|---|
| `lost` `not_found` | `-32602` | `/^Invalid params: session is not resumable: /` | 持久化里找不到可恢复的会话：会话日志被删除（`DSH_HOME` 被清理），或日志头读不出来（截断的日志也是这句） | `session_lost`，`lostReason: not_found` | `errors/resume-not-resumable.json` |
| `cwd_mismatch` | `-32602` | `/^Invalid params: session cwd does not match: /` | `cwd` 与日志头里的不是同一目录；目录不存在也是这句 | `session_unavailable` | `errors/resume-cwd-mismatch.json` |
| `already_active` | `-32602` | `/^Invalid params: session is already active: /` | 会话仍挂在本进程上：适配器以为它已关闭（之前的 `session/close` 失败过） | 告警后沿用，照常选定路由 | `errors/resume-active-session.json` |
| `lost` `incompatible` | `-32603` | `/^Internal error: session "[^"]*" uses log format v\d+, /` | `SessionFormatUnsupportedError`：日志由更新的 dsh 写入，或更旧且没有升级路径 | `session_lost`，`lostReason: incompatible` | `errors/resume-format-newer.json` |
| `lost` `corrupted` | `-32603` | `/^Internal error: (?:session "[^"]*": stored log (?:is corrupt\|has a malformed header)\|corrupt Zstandard session log\|session generation filename identifies v\d+, but its header identifies v\d+)/` | `SessionPersistenceCorruptionError`、Zstandard 帧结构错误、文件名与日志头的格式版本不一致 | `session_lost`，`lostReason: corrupted` | `errors/resume-log-corrupt.json` |
| `unknown` | 其余 | — | 连接断开、dsh 的其他内部错误 | `engine_unavailable` | — |

说明：

- `errors/resume-not-resumable.json`、`resume-format-newer.json`、`resume-log-corrupt.json` 由 `dsh-adapter.resume.integration.test.ts` 用真实 dsh 复现并逐字比对（会话 ID、`DSH_HOME`、会话日志的 cwd 编码目录换成占位符）：关闭会话后删掉日志目录、把日志头改成格式 v5、在日志末尾追加半条记录。dsh 改措辞时这个测试先失败，设 `WEVIR_RECORD_FIXTURES=1` 重跑改写样本，再按新措辞改规则表。`fake-dsh.mjs` 回放的也是这三份样本。
