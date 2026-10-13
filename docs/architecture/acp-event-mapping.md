# ACP → Wevir 事件映射

> 状态：v0（T3.2）· 日期：2026-10-13
> 依据：[dsh 接入 Spike](../research/dsh-integration-spike.md) §3、§4、§11.2；[ADR-0001](../adr/0001-runtime-integration.md) §3、§5 与补记 3；[领域模型](./domain-model.md) §6、§7、§9
> 代码：`packages/adapter-dsh/src/`（`acp-mapping.ts`、`tool-display.ts`、`turn-error.ts`、`delta-merge.ts`、`session-events.ts`、`dsh-adapter.ts`）
> 样本：`packages/adapter-dsh/src/test-fixtures/acp/`，是 `spikes/dsh-acp/fixtures/acp/`（T0.3，`2ce30c0`）的副本，另加 T3.2 录的 5 个 Provider 错误；下文的样本路径都相对这个目录

本文件写 dsh 的 ACP 消息怎样变成 `AgentEvent`（`packages/runtime-adapter/src/events.ts`），Host 再照 domain-model.md §6 写成 `WevirEvent`。三张表（§1 类型、§2 工具名、§3 错误归类）与代码的一致性由 `acp-event-mapping.test.ts` 检查；改映射时两边一起改。每个样本都有对应的测试，或在 `acp-mapping.test.ts` 里写明由别处覆盖、为什么不属于 T3.2。

## 0. 事件路径

```text
dsh stdout ──ndJsonStream──▶ DshProcess 截下 session/update（原样，按写出顺序）──┐
                              其余消息 ──▶ ACP SDK（请求、响应、request_permission）│
dsh fd 3 ──StreamTapDecoder──▶ assistant.delta / assistant.stream_ended ──────────┤
                                                                                  ▼
                                     DshAdapter 按 sessionId 路由 ──▶ SessionEventQueue（每个引擎会话一个）
                                                                     映射（mapAcpUpdate）→ 对齐增量（DeltaMerger）
                                                                     → EventHub ──▶ subscribe()
DshAdapter.send：session/prompt 的结果 / 错误 ──▶ turn.settled / turn.failed（同一个队列）
DshProcess 的 exit 事件 ──▶ 每个挂着的会话一条 engine.exited，订阅结束
```

- **在 SDK 之前截下 `session/update`。** ACP SDK 收到通知先用 zod 校验：不认识的 `sessionUpdate` 类型校验失败，通知不交给处理器（SDK 只打印一行错误）；认识的类型里不认识的字段被删掉，不认识的枚举值（例如 `kind`）被丢掉（T3.2 用 SDK 1.4.0 实测）。而不认识的内容要以 `engine.raw` 原样保留。所以 `DshProcess` 在 `ndJsonStream` 与 SDK 之间插了一个 `TransformStream`：`session/update` 不往下传，原样同步交给 `onSessionUpdate`，其余消息照常给 SDK。
- **顺序。** 截取发生在 SDK 读到消息之前，同一条流里排在后面的 `session/prompt` 响应兑现时，它前面的通知都已入队，所以每个回合的终结事件都在该回合其他事件之后，这一点由构造保证，不依赖 SDK 内部的微任务次序。每个引擎会话一个 `SessionEventQueue`，三路输入（ACP 更新、旁路增量、回合边界）都是同步调用，按调用顺序产出。
- **旁路增量**走另一条管道，与 stdout 之间没有顺序保证，对齐规则见 §4。旁路里不属于任何 ACP 会话的帧（子 agent 的会话，ACP 看不到）直接丢弃。
- **回合之外**只发 `engine.raw`、`usage.updated` 与 `engine.exited`（events.ts 的顺序约定，Host 也只在回合外接受这几种）：回合外到达的其他 ACP 更新改发 `engine.raw` 并告警；增量与 `stream_ended` 丢弃，committed 的 end 帧可能晚于 `session/prompt` 的结果（T3.2a 实测）。

## 1. `session/update` 类型

dsh 0.2.1-alpha.2 实际发送的是前 5 种（T0.3 §3.3），`config_option_update` 只在源码里出现（Provider 拓扑变化时，上游 `packages/acp/acp/src/session.ts` 的 `topologyChanged`）。

| ACP `sessionUpdate` | Wevir 事件 | 说明 | 样本 |
|---|---|---|---|
| `agent_message_chunk` | `assistant.message` | dsh 每个已提交 attempt 的每个非空文本块发一条，同一 attempt 的块 `messageId` 相同；取消时一次补发已生成的部分，同样映射为 `assistant.message`。`replaces` 由会话队列对齐增量后填写（§4）。内容不是文本（图片）或缺 `messageId` 时改为 `engine.raw` | `mock/updates/agent_message_chunk.json`、`mock/transcripts/E2-cancel-during-generation.jsonl` |
| `agent_thought_chunk` | `assistant.thought` | 推理块，规则同上，`messageId` 与同一 attempt 的消息相同 | `mock/updates/agent_thought_chunk.json`、`mock/transcripts/F-stream-granularity.jsonl` |
| `tool_call` | `tool.started`、`todo.updated`、`tool.finished` | `title` 是工具名，`kind` 恒为 `other`，`status` 直接是 `in_progress`，没有 `locations`：展示类型按工具名取（§2），`rawInput` 原样作 `input`。工具是 `todo_write` 且 `rawInput.todos` 每项都有 `content` / `status` 时，紧跟一条 `todo.updated`（完整列表）。ACP 允许 `tool_call` 直接带终态，那时再跟一条 `tool.finished`（dsh 不发） | `mock/updates/tool_call.json`、`mock/transcripts/todo-subagent.jsonl` |
| `tool_call_update` | `tool.finished`、`tool.updated` | `status` 为 `completed` / `failed` 时是 `tool.finished`，`output` 是 `content` 里各文本块按顺序直接拼接的原文（模型看到的同一段文本），截断由 Host 做；取消期间的 `failed` 由 Host 记为 `cancelled`（domain-model.md §6.4）。其余状态（`pending`、`in_progress`、缺省）是 `tool.updated`，带 `title` 时重新计算展示类型（dsh 不发）。`content` 里有非文本项（`diff`、`terminal`、图片）时文本照常进 `output`，整条另发一条 `engine.raw` | `mock/updates/tool_call_update.completed.json`、`mock/updates/tool_call_update.failed.json` |
| `usage_update` | `usage.updated` | `used` → `contextUsed`，`size` → `contextSize`（模型未声明 `contextWindow` 时是 pi-ai 的猜测值 262144）；没有 `cost` | `mock/updates/usage_update.json` |
| `config_option_update` | `engine.raw` | 认识的类型，v0 没有中途改模型的事件（预留 `session.config_changed`，domain-model.md §6.6），有意保留为 `engine.raw`，不告警 | — |

其余情况一律映射为一条 `engine.raw`（`protocol: 'acp'`、`method: 'session/update'`、`kind` 为 `sessionUpdate` 的值、`params` 是整条通知的原样参数），不丢弃，并按“原因 + 类型”在一个适配器实例内只告警一次：

- dsh 不发的类型：`user_message_chunk`、`plan`、`plan_update`、`plan_removed`、`available_commands_update`、`current_mode_update`、`session_info_update`、`compaction_update`、`compaction_summary_chunk`（ACP SDK 1.4.0 的全部类型），以及将来的新类型；
- 认识的类型但字段不合预期：缺必需字段、`status` 或 `content` 的值不认识、`usage_update` 的数值不是非负数。

`session/update` 本身缺 `sessionId` 或 `update.sessionUpdate` 时无法路由到会话，告警后丢弃；属于没有挂着的会话的更新同样告警后丢弃。

ACP 的其他消息不经过 `mapAcpUpdate`：

| ACP 消息 | Wevir 事件 | 说明 | 样本 |
|---|---|---|---|
| `session/prompt` 结果 | `turn.settled` | `stopReason` 原样；`cancelled` 时 `outcome: 'cancelled'`，其余（`end_turn`、`max_tokens`…）为 `completed` | 全部 `mock/transcripts/*.jsonl` |
| `session/prompt` 错误 | `turn.failed` | 按 §3 归类，原文与错误码保留 | `errors/prompt-*.json` |
| dsh 进程退出 | `engine.exited` | 每个挂着的会话一条，是订阅的最后一个事件；进行中的回合不再有 `turn.*` | — |
| `session/request_permission` | `approval.requested` | 属于 T3.3。T3.3 之前 `DshProcess` 一律回复 `cancelled` | `mock/permission/request.json` |
| `session/new` 结果 | 无 | `configOptions` 里引擎当前的模型（`model` 的值是 JSON 编码的 `["<provider>","<model>"]`）与推理强度作为 `createSession` 的返回值 | `session-new.response.json`、`session-new.openai-compatible.response.json` |

## 2. 工具名 → 展示类型

ACP `kind` 恒为 `other`、没有 `locations` / `diff`，展示类型按工具名（`tool_call.title`）取，字段从 `rawInput` 提取，原值保留（路径可能是相对路径）。字段缺失或类型不对只少字段；`rawInput` 不是对象（dsh 解析模型给的 JSON 失败时是原始字符串）时只有展示类型。分类参考 Paseo `ToolCallDetail`（domain-model.md §7）。“观测”列：✅ 在 T0.3 样本中出现过；源码 = 字段名取自上游 `d743267` 的工具定义。

| dsh 工具名 | 展示类型 | 提取字段（`rawInput` → `ToolDisplay`） | 观测 |
|---|---|---|---|
| `read` | `read` | `file_path` → `paths`、`summary` | ✅ |
| `read_image` | `read` | `file_path` → `paths`、`summary` | 源码 |
| `write` | `write` | `file_path` → `paths`、`summary`；`content`、`sandbox_permissions`、`justification` 只在 `input` 里（审批详情用，T3.3） | ✅ |
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

dsh 的轮次失败让 `session/prompt` 以 JSON-RPC `-32603` 结束，消息是自由文本：ACP SDK 的 `RequestError.internalError` 加 `Internal error: `，dsh-acp 再加 `turn failed: `，后面是 dsh 内部失败的原文（T0.3 §3.4）。只有 `-32603` 且带这两层包装的才按下表归类（看去掉包装之后的开头，自上而下第一条匹配的生效），其余一律 `unknown`，包括 dsh 的其他 `-32603`（`prompt was not queued: …`、`assistant output delivery failed: …`）。`turn.failed` 的 `message` 始终是完整原文，`code` 是错误码。

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

## 4. 增量与已提交消息的对齐

规则的产品语义见 domain-model.md §6.3，这里是适配器的实现（`delta-merge.ts`，每个会话一个、按回合重置）。依据的 dsh 行为（上游 `dsh-acp/src/updates.ts`、`dsh-llm/src/assembler.ts`、`agent-loop/src/agent.ts`）：一个 attempt 的增量全部写到 fd 3 之后才提交 `assistant/message`；ACP 按块顺序为每个长度非零的文本块、推理块各发一条 chunk（同一 `messageId`）；取消时只保留含非空白字符的块，一个都没有就不提交消息，记为 `assistant/attempt`。旁路帧在 fd 3 上有序，但 fd 3 与 stdout 之间没有顺序。

1. attempt 按第一个增量的到达顺序排队等已提交消息。ACP 出现新的 `messageId` 时，取队列里第一个内容对得上的 attempt：它有一个未被替换的同类块，块的文本是已提交文本的前缀（前缀而不是相等，因为尾部增量可能还在 fd 3 里）。排在它前面的 attempt 不会再有已提交消息，一并出队。同一 `messageId` 的后续 chunk 在该 attempt 里按块顺序找下一个对得上的块。
2. 配对之后该 attempt 再到的增量丢弃：已提交内容已经替换了它。
3. 已提交消息到达时一个对得上的 attempt 都没有（增量整个落在消息之后），先记下；之后出现的 attempt 若第一段增量是它的前缀，就认定属于这条已经发出的消息，增量全部丢弃。
4. 被替换块之前、同类且只含空白的块一并替换（取消时 dsh 丢掉这些块）。
5. `abandoned` 的 end 帧让 attempt 出队；end 帧是 committed 但落成 `assistant/attempt` 的（没有已提交消息），`StreamTapDecoder` 已把它报成 `abandoned`。没发出过增量的 attempt 不发 `stream_ended`。
6. 内容对不上（例如旁路丢了一行畸形数据）时 `replaces` 为空，残留的增量由 Host 在回合结束时丢弃（domain-model.md §6.3 规则 4），不会留下重复文本。

测试：`delta-merge.test.ts` 用 F（思考 + 消息）、E2（取消时的半段消息，含前置空白块与迟到的尾部增量）、todo-subagent（一个回合多个 attempt）的已提交消息配旁路帧形状（`stream-tap/frames.sample.json`）构造的增量；`dsh-adapter.integration.test.ts` 用真实 dsh + mock Provider 覆盖正常回合与生成中取消。

## 5. 不在本文件的部分

- 审批：`session/request_permission` → `approval.requested`、回复、取消时的 `cancelled`，以及“dsh 的审批只来自沙箱升级”的说明，由 T3.3 补进本文件。
- resume：`session/resume` 的结果与 `-32602` 错误（`errors/resume-*.json`）属于 T3.5。
