# Grok Build → Wevir 事件映射

> 状态：v0.1（订阅来源 `grok` 的引擎：账号检测、模型、会话、审批与提问、取消、恢复、权限模式）· 日期：2026-10-15
> 依据：[ADR-0005](../adr/0005-agent-runtime-and-model-gateway.md) 决策 1.3 与补记 14；[host-api.md](./host-api.md) §3.1 的 `account.*`；[领域模型](./domain-model.md) §3.6；[ACP 映射](./acp-event-mapping.md) 第一部分
> 代码：`packages/adapter-grok/src/`（`launch.ts`、`accounts.ts`、`models.ts`、`engine.ts`、`tool-display.ts`、`xai.ts`、`grok-adapter.ts`），建在 `@wevir/adapter-acp` 上，登记在 `packages/host/src/engines.ts`
> 来源：移植自 T3 Code（[pingdotgg/t3code](https://github.com/pingdotgg/t3code)，MIT，提交 `ec1313c8f8333292506f05a355bb72d308a455d8`）的 `packages/provider-grok`，逐文件的登记见 [UPSTREAM.md](../upstream/UPSTREAM.md) §4
> 样本：`packages/adapter-grok/src/test-fixtures/acp/`，T3 Code 录的真实 Grok Build 1.0.41（`grok_prompt_error` 是 1.0.44）ACP 往返，原样复制

本文件写 Grok Build 怎样被 Wevir 驱动，以及它的 ACP 消息与 xAI 扩展怎样变成 `AgentEvent`。通用的 ACP 映射（`session/update` 的类型表、审批桥接、取消与恢复的兜底）见 [acp-event-mapping.md](./acp-event-mapping.md) 第一部分；这里只写 Grok 的那份引擎描述（`GROK_ENGINE`）与它特有的行为。

## 1. 引擎的形态（`launch.ts`、`grok-adapter.ts`）

- **用户自己的 `grok`。** Wevir 不随包带 Grok，也不声明它的 npm 包 `@xai-official/grok`（AGENTS.md 规则 2；`check-engine-boundary.mjs` 只许 `packages/adapter-grok` 声明它，现在谁都没声明）。找可执行文件的顺序：`WEVIR_GROK_BIN`（开发与测试）→ `account.setPath` 指定的路径（`~/` 按家目录展开，不存在就报错，不悄悄换别处的）→ PATH → 常见的安装目录（`~/.grok/bin`、`~/.local/bin`、Homebrew、npm、bun、Volta、pnpm 的全局目录）。Host 由桌面端拉起时 PATH 很短，所以交给 `grok` 的 PATH 前面加上它所在的目录、后面补上存在的常见目录（`grok` 跑的命令也要找得到用户的工具）。Windows 上 npm 装的是 `.cmd` 启动脚本，经 shell 起。
- **启动参数**照 T3 的 `grokAcpSpawnArgs`，权限模式只能在启动时给（§6）：

  | Wevir 权限模式 | `grok` 参数 |
  |---|---|
  | `on_request`（默认） | `--permission-mode default agent stdio` |
  | `auto_review` | `--permission-mode auto agent stdio` |
  | `full_access` | `agent --always-approve stdio` |

  命令行上的 `--permission-mode` 压过用户 Grok 配置里的设置，所以“请求批准”不会继承配置里的 always-approve。
- **每种权限模式一个进程。** T3 每个会话一个 `grok` 进程；Wevir 的通用 ACP 适配器是一个进程承载多个会话（dsh 也这样），Grok 的 ACP 支持一个连接多个会话（`sessionCapabilities` 有 `list` / `resume` / `close`，`_x.ai/sessions/changed` 报全部会话），所以 `GrokAdapter` 按权限模式各开一个 `GrokModeAdapter`（`AcpAdapter` 的子类，一个 `AcpProcess`），会话交给它所在模式的那个。进程懒启动：构造时不起，第一次建会话或恢复时才起。Host 订阅的是 `GrokAdapter` 的每会话事件流，会话在进程之间挪动时订阅不断（§6）。
- **工作目录与环境。** 进程的工作目录是 `<数据目录>/engines/grok`（空目录，每个会话的 cwd 在 `session/new` 里给）。环境照 T3 继承 Host 的环境（用户的 `XAI_API_KEY` 照常生效）。**不设 `GROK_HOME`**：`grok` 用用户自己的 `~/.grok`，登录（`authMethods` 的说明是 “Cached token from ~/.grok/auth.json”）、设置与会话记录都在那里，`session/resume` 也靠这些会话记录（T3 的 `isGrokPlanMarkdownPath` 按 `~/.grok/sessions/<编码后的 cwd>/<会话>/` 与 `$GROK_HOME/sessions/…` 找计划文件，说明 `GROK_HOME` 改的是这个根）。Wevir 不读 `~/.grok` 里的任何文件。也不设 T3 的 `GROK_OAUTH2_REFERRER`：Wevir 不在应用里登录。
- **进程组。** POSIX 上以 detached 启动，`grok` 是进程组组长，回收（关 stdin → SIGTERM → SIGKILL，acp-event-mapping.md §0.2）的信号连同它起的工具进程一起（T3 的 `ownDetachedProcessGroup`）。
- **`initialize`**：协议版本 1（Grok 回 1，与 SDK 1.4.0 的 `PROTOCOL_VERSION` 相同），`clientCapabilities` 为 `{}`，`_meta` 为 `{ clientType: 'extension' }`（T3 的 `GROK_ACP_INITIALIZE_META`：自动模式下分类器拦下的操作，Grok 只在客户端声明自己能弹出询问时才问，默认的 `generic` 直接拒绝）。会话的 `engineVersion` 取 `initialize` 的 `_meta.agentVersion`（没有时用账号检测到的版本）。

## 2. 账号与模型（`accounts.ts`、`models.ts`）

### 2.1 检测

`EngineAccounts.kinds` 只有 `grok`。状态总带 `signIn: 'command'` 与 `loginCommand: 'grok login'`：Wevir 不登录，用户在终端里登录后点“重新检测”（`account.get` 带 `refresh`）。照 T3 的 `checkGrokProviderStatus`，一次检测依次：

| 步骤 | 做法 | 结果 |
|---|---|---|
| 找 `grok` | §1 的顺序 | 找不到：`installed: false`、`installCommand: 'npm install -g @xai-official/grok'`；指定的路径不对时 `lastError` 说明 |
| `grok --version` | 10 s 时限，取第一个 `x.y.z` | 跑不起来或非 0 退出：`installed`（没找到文件时 false）、`lastError` |
| `grok models` | 10 s 时限，不起 agent；只解析干净退出的输出（失败时打印的是帮助或错误） | 有 “you are logged in” 算已登录，有 “not authenticated / not logged in” 算没登录，都没有算看不出来；带圆点的行是模型，`(default)` 是默认 |
| ACP 探测 | 起一次请求批准模式的 `grok agent stdio`，只做 `initialize`（8 s 时限）就回收；不调 `authenticate`、不建会话，所以不会打开浏览器登录，也不会启动工作区的 MCP 服务器 | `_meta.modelState` 的模型列表（带上下文窗口与推理档位）；失败只让模型信息少一些 |

登录状态：环境里有 `XAI_API_KEY` 时算已登录（`plan: 'apiKey'`、`planLabel: 'xAI API Key'`）；否则看 `grok models`：没登录是 `signed_out`；看不出来时当作已登录并在 `lastError` 说明（同 Claude Agent：措辞变了不该把用户挡在外面，回合里 Grok 要认证时再标回没登录，§2.3）。结果缓存 5 分钟，`read` 带 `refresh`、`setExecutablePath` 时重新检测；`dispose` 中止进行中的检测，不留下 `grok` 进程。

`login` / `logout` 报 `invalid_input`（让用户在终端里做）。**没有邮箱、套餐与用量**：T3 读 `~/.grok` 里存的凭据去问 xAI 的用量接口，Wevir 不读别的软件存的凭据（ADR-0005 补记 14）。

### 2.2 模型

模型列表优先用 `initialize` 的 `_meta.modelState`（`currentModelId` 是默认；每个模型的 `_meta.totalContextTokens` → `contextWindow`，`_meta.reasoningEfforts` 的 `value` → `reasoningEfforts`，`supportsReasoningEffort: false` 时没有），其次是 `grok models` 的列表（显示名由 ID 拼出，`grok-4.6` → `Grok 4.6`），都没有时只有 `grok-build`（T3 的 `GROK_DEFAULT_MODEL_SLUG`：CLI 的产品名，选它表示用会话当前的模型，不发 `session/set_model`）。录到的 1.0.41 有 `grok-4.7`（默认）、`grok-4.7-build-fast`、`grok-4.6`、`grok-4.5`，上下文 50 万，档位 xhigh / high / medium / low（4.5 没有 xhigh），默认 high。

### 2.3 会话里的认证

`session/new` / `session/resume` 报 `-32000 Authentication required` 时（T3 的 `authenticateAfterRequired`），用 `XAI_API_KEY`（有的话，方法 `xai.api_key`）或 Grok 缓存的登录令牌（`cached_token`）`authenticate` 一次再重试；`initialize` 没列出这种方法、或认证失败时报 `missing_credentials` 并把账号标成没登录。从不用 `grok.com`（浏览器登录）。录到的 1.0.41 列的是 `cached_token` 与 `grok.com`，codex-notes §9 记的 1.0.52 是 `xai.api_key` 与 `grok.com`：在 1.0.52 上没有 Key 而令牌失效时，结果是 `missing_credentials`，让用户重新 `grok login`。

## 3. 工具展示（`tool-display.ts`）

`tool_call` 的 `title` 是工具名，不带 ACP 的 `kind`；之后的 `tool_call_update` 才带 `kind` 与给人看的标题（“Execute \`ls\`”、“Read \`…\`”），`rawInput` 多一个 `variant`（`Bash`、`ReadFile`、`TodoWrite`…）。两种更新都带 `_meta["x.ai/tool"]`（`name`、`kind`、`label`、`read_only`），工具名优先从那里取，其次是 `tool_call` 的标题，再按 `rawInput.variant`、`x.ai/tool` 的 `kind` 与 ACP 的 `kind` 兜底。`tool.started.toolName` 是 `tool_call` 的标题（工具名）。

| Grok 工具名 | 展示类型 | 摘要取自 |
|---|---|---|
| `run_terminal_command`、`monitor`、`get_command_or_subagent_output` | `shell` | `command`（没有时用描述或变体，T3 的 `resolveXAiAcpToolTitle`） |
| `read_file`、`list_dir` | `read` | `target_file` / `target_directory` 等路径 |
| `write` | `write` | `file_path` |
| `search_replace`、`edit` | `edit` | `file_path` 等路径，或更新里的 `locations` |
| `search_tool`、`grep`、`web_search`、`x_keyword_search`… | `search` | `query` / `pattern` |
| `web_fetch` | `fetch` | `url` |
| `todo_write`、`enter_plan_mode`、`exit_plan_mode` | `plan` | — |
| `spawn_subagent`、`task` | `sub_agent` | `description` |
| `mcp__<server>__<tool>` | `unknown` | `mcpServer` 是 server |

Grok 有时给 `Tool` 这样不说明问题的标题（T3 的 `isGenericAcpToolTitle`），摘要换成描述或变体（`Monitor: <描述>`、`Task`、`Task output`）。写文件的工具输出是 `diff` 内容，按通用规则文本进 `output`、整条另发 `engine.raw`（acp-event-mapping.md §1.1）。

## 4. 消息与回合（`engine.ts`、`xai.ts`、`grok-adapter.ts`）

- **逐字增量**（引擎描述 `messageChunks: 'streamed'`，acp-event-mapping.md §1.5）：`agent_message_chunk` / `agent_thought_chunk` 是一段段增量、没有 `messageId`，适配器把连续的同类增量合成一块：每段一条 `assistant.delta`，块结束时一条替换它们的 `assistant.message` / `assistant.thought` 与 `assistant.stream_ended`。工具调用、审批、`plan` 等可见的更新把块截断；Grok 在回合中途发的 `session_info_update`、`available_commands_update` 只是 `engine.raw`，不截断。
- **待办**（引擎描述 `tools.isPlanTool`，acp-event-mapping.md §1.6）：`todo_write` 可以只给改动的几项（`merge: true`），合并后的完整列表随后以 ACP `plan` 发出，所以 `todo.updated` 取自 `plan`（`entries` 的 `content`、`status`），记在本回合最近一次 `todo_write` 上，而不是 `todo_write` 的输入。
- **回合结束**（T3 的 `makeXAiPromptCompletionRuntime`）：`session/prompt` 带 `_meta: { promptId, requestId }`（`wevir-<模式>-<n>`）；Grok 在 `session/prompt` 的结果之前先发 `_x.ai/session_notification` 的 `turn_completed`（带 `prompt_id`）与 `_x.ai/session/prompt_complete`，哪个先到就按它结算（acp-event-mapping.md §1.7 的 `completeTurn`），之后到的结果不再上报。只认 `promptId` 与本会话进行中的回合相同的；后台任务的回合（`task-completed-*`）不算。停止原因 `cancelled`、`end_turn`、`max_tokens`、`max_turn_requests`、`refusal` 原样，`error` 与 `rate_limit` 是失败，其余按 `end_turn`。
- **回合失败的归类**（`classifyTurnError`）：`session/prompt` 的错误是 `-32603 Internal error`，真正的原文在 `data.message`（`API error (status 400 Bad Request): …`，带 `data.http_status`）；`prompt_complete` 的 `error` 带同一段原文（`agentResult`），先到。

  | 情形 | `turn.failed.category` |
  |---|---|
  | `-32000 Authentication required`，或原文说没登录 | `missing_credentials`（账号同时标成没登录） |
  | 用量上限（`rate_limit`，`-32003`）、带 HTTP 状态码的上游错误 | `provider` |
  | 其余 | `unknown` |

- **取消**：`session/cancel` 带 `_meta: { cancelTrigger: 'ctrl_c' }`（T3 的 `GROK_ACP_CANCEL_META`：Grok 把它当作屏障，之后直到用户下一次发消息不再因为后台任务结束自己开回合）。录到的 Grok 在 22 ms 内以 `cancelled` 结束回合。T3 在用户点停止后还杀掉整个进程组重启，好停掉已经放到后台的命令；Wevir 一个进程承载同一模式的全部会话，不这样做，后台命令会继续跑（§7）。
- **其余扩展通知**：`_x.ai/queue/changed`、`_x.ai/sessions/changed`、`_x.ai/session/setup`、`_x.ai/models/update`、`_x.ai/mcp/*`、`_x.ai/task_backgrounded`、`_x.ai/task_completed`、`_x.ai/monitor_event` 与 `session_notification` 里的其他更新（`model_changed`、`response_completed`、`pending_interaction`、`interaction_resolved`、`hook_*`、`session_summary_generated`、`last_turn_summary`、`background_tasks`、`subagent_*`、`retry_state`）不映射：只登记了上面两种回合结束的方法，其余由 ACP SDK 丢弃。

## 5. 审批与提问（`xai.ts`、`grok-adapter.ts`）

- **审批选项**（引擎描述 `approvalOptions`，T3 的 `grokApprovalOptions`）：只交出 `allow_once`、`reject_once` 与本会话允许编辑（`allow-edits-session`，编辑审批才有）。Grok 的 `always-allow`（“不再询问 bash 命令”）与 `reject-always` 会给整个项目存一条比会话活得长的授权（T3 引 grok-build 的 `prompter.rs` / `grants.rs`），去掉：长期的权限变化只经 Wevir 的权限模式。录到的选项：写文件是 `allow-edits-session`、`allow-once`、`reject-once`；命令是 `always-allow`、`allow-once`、`reject-once`、`reject-always`；发消息给子 agent 是 `allow-once`、`reject-once`。
- **向用户提问**：`_x.ai/ask_user_question`（参数可能包了一层 `{method, params}`）→ `question.requested`（问题 ID 是 `id`，没有时用问题原文；`allowOther: true`，Grok 接受选项之外的回答）；`respondToQuestion` 的回答 → `{outcome: 'accepted', answers: {<问题原文>: [<选中的 label>]}}`，不在选项里的回答记为 `Other`、原文放进 `annotations[问题].notes`（T3 的 `makeXAiAskUserQuestionResponse`）；取消、回合结束、引擎退出时 `question.cancelled`，回 `{outcome: 'cancelled'}`。
- **退出计划模式**：`_x.ai/exit_plan_mode` → 一次审批（选项“实施计划” `allow_once` / “停下等反馈” `reject_once`），详情取自同一 `toolCallId` 的 `exit_plan_mode` 工具调用。批准回 `{outcome: 'approved'}`，Grok 接着实施；拒绝或取消照 T3 回 `{outcome: 'abandoned', feedback}`，让 Grok 停下等用户下一条消息（T3 #8358：不回复回合会一直挂着）。T3 把计划捕获成卡片；Wevir 没有计划卡片，计划在 `plan.md` 的写入工具里看得到。
- **自动模式**（`auto_review`）：Grok 的分类器自己放行日常操作，只把拦下的问客户端（`clientType: extension`），这些审批照常交给用户。

## 6. 权限模式、模型与恢复

- **会话中换权限模式**：Grok 的权限模式只能在启动时给（T3 不允许会话中途换）。`configureSession` 记下新的模式，下一次 `send` 之前把会话挪到新模式的进程：旧进程里 `session/close`，新进程里 `session/resume`（创建时的 cwd），再按 Host 的配置选定模型。Host 的订阅不断；挪失败时会话留在没有进程的状态、`send` 报错，下一次 `send` 再试。依赖 Grok 把会话记在 `~/.grok/sessions`、别的进程能 resume（待维护者验证，§8）。
- **会话中换模型与推理档位**：记下，下一次 `send` 之前用 ACP 的 `session/set_model`（`{sessionId, modelId, _meta: {reasoningEffort}}`，T3 的 `applyGrokAcpModelSelection`；Grok 的 `initialize` 回协议版本 1，T3 对它不用 `set_config_option`）。没给档位时不带 `_meta`，不当作清掉 Grok 的默认档位；选 `grok-build` 不换模型，只换档位时对当前模型发。结果 `_meta.model.Err` 报 `invalid_input`。Grok 随后发 `config_option_update`，适配器据此更新当前值。建会话时同样：与 `session/new` 结果的 `configOptions`（`model`、`reasoning_effort`）不同才发。
- **读历史的工具（0.25.0）**：Host 给了 `historyTool` 时，`session/new` 与 `session/resume` 的 `mcpServers` 带上 Wevir 的读历史服务（ACP 的 stdio 形状：`name: wevir_history`、`command`、`args`、`env`；通用 ACP 适配器的 `mcpServers` 选项，dsh 与 Antigravity 不给）。Grok 调它时要不要审批由 Grok 决定，要就照常问用户。真实 `grok` 待维护者验证（§8）。
- **恢复**：`session/resume`（`{sessionId, cwd, mcpServers}`）。T3 在 `loadSession` 为 true 时用 `session/load`（会回放历史，T3 要等回放结束）；Wevir 的历史在 Host 的事件库里，用不回放的 `resume`，Grok 两者都支持。失败的归类（`classifyResumeError`）：Grok 的措辞还没有录到，只把明说会话不存在的（`session … not found` 等）归为 `lost`（Host 标只读），说已在活动的归为 `already_active`，其余 `unknown`（不标只读，下次还能重试）。

## 7. 与 T3 的差别与缺口

- **每种权限模式一个进程**，不是每个会话一个（§1）；用户点停止后不杀进程组，已放到后台的命令继续跑。
- **后台任务与唤醒回合**：模型可以把命令放到后台（`run_terminal_command` 的 `background: true`、`monitor`）。命令结束后 Grok 自己开一个回合（`task-completed-*`）回答；Wevir 的顶层会话没有引擎开的回合（Claude Agent 同，claude-event-mapping.md），这个回合的消息与工具更新在回合之外到达，保留为 `engine.raw` 并告警，界面上看不到。T3 推迟回合的结束、并把唤醒回合接成续写，Wevir 没做。用户下一条消息时 Grok 的上下文里有这些内容。
- **子 agent**（`spawn_subagent`、`subagent_*` 通知）：只作为一次 `sub_agent` 工具调用显示，没有子会话（ACP 引擎的能力 `subagents: false`）。
- **没做**：计划卡片、斜杠命令（`initialize` 的 `availableCommands`）、对话压缩、skills、用户自己的 MCP 服务器、用量与邮箱（§2.1）、图片输入（Wevir 的输入只有文本）、会话标题（Grok 的 `session_info_update` 保留为 `engine.raw`，标题由 Host 生成）、插话（ACP 不能往进行中的回合追加输入，Host 排队）。

- **应用级工具**（0.30.0，domain-model §3.15）：会话带 `SessionConfig.appTools` 时，`session/new` 与 `session/resume` 的 `mcpServers` 里除了读历史的工具还有一项 stdio 的 `wevir`：Host 的 Node 跑 `<数据目录>/mcp/wevir-app-tools.mjs`（`@wevir/runtime-adapter/app-tools-bridge`），把每条 JSON-RPC 转给 Host 的 `/mcp`，地址与令牌在这一项的 `env` 里（T3 对 ACP 引擎也用 stdio 桥，HTTP 的服务 ACP 引擎常常接不上）。会话挪到别的权限模式的进程时照样带上。工具要不要批准由 Grok 自己定（`session/request_permission` 照常转成审批）。只用假 grok 验证了 `session/new` 的参数（`grok-adapter.test.ts`）与桥本身（`app-tools-bridge.test.ts`），本机没有 grok。

## 8. 验证

| 层 | 做法 | 状态 |
|---|---|---|
| 单元 | `units.test.ts`：启动参数、审批选项、回合结束、提问与退出计划模式的编解码、`grok models` 与 `modelState` 的解析、工具展示（录到的帧）、失败归类；`accounts.test.ts`：账号检测（假 grok） | 通过 |
| 样本回放 | `grok-adapter.test.ts`：假 grok（`test-fixtures/fake-grok.mjs`）回放 T3 录的真实样本：逐字增量合成、待办、审批、回合失败、引擎报的回合结束先到、取消、提问、后台任务的唤醒回合；另测按模式分进程的参数、会话中换模式与模型、要认证时认证后重试、close 与引擎退出后的 resume | 通过 |
| 契约 | `grok-adapter.contract.test.ts`：通用契约跑在假 grok 上（真的子进程与 ACP，样本消息） | 通过（子会话、插话两类跳过） |
| 真实 `grok` | `grok-adapter.contract.real.integration.test.ts`（`WEVIR_TEST_GROK=1`）与下面的手工步骤 | **待维护者验证**：本机没有装 `grok` |

真实 `grok` 的验证步骤（维护者，会用掉订阅额度）：

1. 装好并登录：`npm install -g @xai-official/grok`（或 x.ai 的安装脚本），`grok --version`，`grok login`，`grok models` 应打印 “You are logged in…” 与模型列表。记下版本（样本是 1.0.41 / 1.0.44，codex-notes §9 核实过 1.0.52 的部分行为）。
2. 跑真实契约与账号检测：`env -i HOME="$HOME" PATH="$PATH" USER="$USER" WEVIR_TEST_GROK=1 pnpm vitest run --project adapter-grok contract.real`。`WEVIR_TEST_GROK_MODEL` 可换模型（默认 `grok-build`，即 Grok 自己的默认模型）。
3. 在桌面端走一遍：默认的 Codex Host 带着 Grok 引擎（`env -i HOME="$HOME" PATH="$PATH" USER="$USER" WEVIR_CODEX_BIN=<codex-app-server> pnpm --silent wevir --home <目录> host start`，再在 apps/desktop 里 `WEVIR_HOME=<目录> ./node_modules/.bin/electron-vite dev`）：设置 → 模型服务的 Grok 显示版本、已登录与“重新检测”；模型选择里有 Grok 的模型；一问一答、读文件、跑命令的审批（允许、拒绝）、取消、关掉 Host 再打开后继续同一会话（resume）、在会话中换权限模式与模型后接着发消息。
4. 下面几项现在只有推断，请顺手核对并记下结果：
   - `GROK_HOME`：Wevir 不设它；`grok` 是否只写 `~/.grok`（会话、日志、设置），有没有写别处（`~/.cache`、`~/Library` 等）；设了 `GROK_HOME` 时是否完全隔离（codex-notes §9 留下的问题）。
   - 会话记录：`~/.grok/sessions/<编码后的 cwd>/<会话 ID>/` 的命名；跑完真实契约后可以删掉以 `wevir-grok-contract-` 临时目录命名的那些。
   - 换权限模式时的 `session/close` + 另一个进程 `session/resume` 能不能接上同一段上下文；`session/resume` 找不到会话时的错误码与措辞（§6 的归类）。
   - 一个 `grok agent stdio` 进程同时跑两个会话是否互不影响（契约的“两个会话并发”在真实 `grok` 上跑）。
   - 退出计划模式（让 Grok 先进计划模式再退出）的 `exit_plan_mode` 请求与工具调用的形状；`ask_user_question` 在真实 Grok 上的参数（样本是 T3 合成的形状探测）。
   - 遥测与更新检查的开关（codex-notes §9 留下的问题）。
