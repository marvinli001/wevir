# Claude Agent SDK → Wevir 事件映射

> 状态：v0.1（订阅来源的第一个引擎：账号检测、模型清单、会话与回合、流式事件、工具、审批与提问、取消、恢复、插话、子 agent、支线、补说明、标题）· 日期：2026-10-15
> 依据：[ADR-0005](../adr/0005-agent-runtime-and-model-gateway.md) 补记 14（订阅来源、Claude 的条款）；[Host API](./host-api.md) §3.1 的 `account.*`；[领域模型](./domain-model.md) §3.6、§3.9、§3.12、§4、§6、§7；实现移植自 T3 Code（github.com/pingdotgg/t3code，MIT，提交 `ec1313c8f8333292506f05a355bb72d308a455d8`）的 `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` 与 `apps/server/src/provider/Claude*.ts`，登记见 [UPSTREAM.md](../upstream/UPSTREAM.md) §4
> 代码：`packages/adapter-claude/src/`（`sdk.ts`、`executable.ts`、`env.ts`、`account.ts`、`model-manifest.ts`、`model-catalog.ts`、`permissions.ts`、`tool-display.ts`、`todos.ts`、`turn-result.ts`、`side.ts`、`claude-adapter.ts`）
> 样本：`packages/adapter-claude/src/test-fixtures/sdk/`，本机 `claude` 2.1.287 + `claude-haiku-4-5` 录的 SDK 消息（`record-sdk.test.ts`）

本文件写 Claude Agent 引擎怎样被 Wevir 驱动，以及 Claude Agent SDK（`@anthropic-ai/claude-agent-sdk` 0.3.286）交出的消息怎样变成 `AgentEvent`（`packages/runtime-adapter/src/events.ts`）。照 T3 Code：Wevir 自己不登录、不带 Claude Code，用用户自己装的 `claude` 与他在终端里 `claude auth login` 的登录和订阅额度。界面与 Provider 的名字是 “Claude Agent”，不叫 “Claude Code”（Anthropic 的品牌要求，补记 14）。

## 0. 事件路径

```text
用户装的 claude（~/.local/bin/claude 等，executable.ts 找）
  ▲ stdin：SDK 的控制请求 + 推进去的用户消息（流式输入）
  │ stdout：SDK 消息（stream-json）
Claude Agent SDK 的 query()（一个会话一个，常驻；sdk.ts 是唯一 import SDK 的地方）
  ├─ stream_event（顶层）──▶ assistant.delta（text / reasoning）
  ├─ assistant（快照，一块一条）──▶ assistant.message / assistant.thought（替换同一块的增量）、tool.started（+ todo.updated）、
  │                                usage.updated；parent_tool_use_id 指向 Agent 调用的 → 子会话
  ├─ user（工具结果）──▶ tool.finished（+ Task* 的 todo.updated）；Agent 调用的结果 → 子会话结算
  ├─ result ──▶ turn.settled / turn.failed（插话还没进回合时推迟，§4.5）
  ├─ system/task_started、task_notification ──▶ 子会话的任务 ID 与后台结算
  ├─ rate_limit_event ──▶ 账号的用量（account.updated）
  ├─ 高频的进度与状态 ──▶ 丢弃（IGNORED_MESSAGES）
  └─ 其余 ──▶ engine.raw（protocol `claude-agent-sdk`）
canUseTool 回调 ──▶ approval.requested / question.requested，等 respondToApproval / respondToQuestion
```

## 1. 依赖与边界

- `@anthropic-ai/claude-agent-sdk` 钉 `0.3.286`（2026-09-30 发布）。只有 `packages/adapter-claude` 声明它（AGENTS.md 规则 2；`biome.json` 的 `noRestrictedImports` 与 `scripts/check-engine-boundary.mjs` 同样拦着 `@anthropic-ai/claude-code`）。
- SDK 的各平台可选包（`@anthropic-ai/claude-agent-sdk-<平台>`，每个约 225 MB 的 Claude Code 原生二进制）由 `pnpm-workspace.yaml` 的 `ignoredOptionalDependencies` 跳过：适配器总是传 `pathToClaudeCodeExecutable`，用不到随包的那一份。
- SDK 的 peer `@modelcontextprotocol/sdk` 只在 `sdk.d.ts` 里用到类型；`packageExtensions` 把它标成可选，否则 pnpm 自动装上它，dsh 依赖树里 `@google/genai` 的可选 peer 随之解析到它。`@anthropic-ai/sdk` 与 `zod` 照常自动装（工作区里已有同版本）。
- SDK 的许可证是 Anthropic 的商业条款（包内 `LICENSE.md`），作为 npm 依赖安装，不进仓库。

## 2. 找 `claude`、环境与账号（`executable.ts`、`env.ts`、`account.ts`）

### 2.1 找可执行文件

顺序：`account.setPath` 指定的路径（`~` 展开；不存在就报出来，不再自动找）→ 环境变量 `WEVIR_CLAUDE_BIN` → `PATH` → 常见的安装位置：`~/.local/bin`（官方安装脚本）、`~/.claude/local`、`/opt/homebrew/bin`、`/usr/local/bin`、`~/.npm-global/bin`、`~/.bun/bin`、`~/.volta/bin`、pnpm 的全局目录；Windows 是 `%USERPROFILE%\.local\bin`、`%APPDATA%\npm`、`.bun\bin`、`scoop\shims`。桌面端拉起的 Host 继承的是 GUI 的 `PATH`（macOS 上只有 `/usr/bin:/bin:/usr/sbin:/sbin`），T3 的桌面端为此读登录 shell 的环境，Wevir 不读，改为把这些位置一并找一遍。

Windows 上 npm 装的 `claude.cmd` 换成旁边的包入口（新版 `node_modules/@anthropic-ai/claude-code/bin/claude.exe`，旧版 `cli.js`），T3 的 `resolveClaudeSdkExecutablePath`：SDK 不经 shell 起进程，起不了启动脚本。

### 2.2 交给 `claude` 的环境

继承 Host 的环境（用户的 `ANTHROPIC_API_KEY`、Bedrock 等设置照常生效），另外：

- `PATH` 前面加上 `claude` 所在的目录，后面补上存在而不在其中的常见目录（它的 Bash 工具要找得到用户的工具）；
- 去掉“正运行在另一个 Claude Code 会话里”的标记（`CLAUDECODE`、`CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_SESSION_ID` 等，`NESTED_SESSION_ENV`）：Host 由 Claude Code 拉起时（开发时常见）这些变量会让 `claude` 当成嵌套会话；
- `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`，见 §6.4。

### 2.3 检测登录与套餐

照 T3 的 `checkClaudeProviderStatus`：

1. 找 `claude`，找不到 → `{ status: 'signed_out', installed: false, installCommand }`（安装命令是官方的 `curl -fsSL https://claude.ai/install.sh | bash`，Windows `irm https://claude.ai/install.ps1 | iex`）。
2. `claude --version`（10 s）。跑不起来 → `installed: true` 而 `signed_out`，`lastError` 写原因。
3. 开一个 SDK 的探测会话读初始化结果的 `account`（T3 的 `probeClaudeCapabilities`）：prompt 是永远不产出的异步迭代，`claude` 只做本地的初始化、不向 Anthropic 发请求；`persistSession: false`、不跑 hooks（`disableAllHooks`）、不连 MCP（`mcpServers: {}` + `strictMcpConfig`，另关掉 claude.ai 上连接的 MCP 与 IDE 自动连接）、工作目录是 `<数据目录>/engines/claude`。等初始化 25 s（Bedrock 慢），再单独等 10 s 读一次套餐用量（SDK 的实验接口 `usage_EXPERIMENTAL_…`，`skipBehaviors`），读不到不影响登录状态。
4. 只有 `tokenSource: "none"` 而且没有 API Key、邮箱与套餐时才算没登录（T3 的 `claudeAuthStatus`）；第三方后端（`apiProvider` 不是 `firstParty`）算已登录；太旧的 `claude` 什么都不报也算已登录。

结果：

| `AccountState` 字段 | 来源 |
|---|---|
| `signIn` / `loginCommand` | 恒为 `command` / `claude auth login`（Wevir 不登录；`login` 与 `logout` 报 `invalid_input`，界面显示命令与“在终端登出”） |
| `installed`、`version`、`executablePath`、`customPath` | 第 1、2 步 |
| `email` | `account.email` |
| `plan` / `planLabel` | `subscriptionType` 原值 / T3 的 `claudeSubscriptionLabel`（`max20` → “Max 20x”）；API Key 登录是 `apiKey` / “API Key”，Bedrock 是 “Amazon Bedrock” |
| `rateLimits.primary` / `secondary` | 用量的 5 小时 / 7 天窗口（0–100 的百分比、ISO 重置时间）；回合里的 `rate_limit_event` 随后更新（0–1 的小数，新版带两个窗口全貌的 `unifiedWindows`） |

结果缓存 5 分钟（T3 的 `CAPABILITIES_PROBE_TTL`），`read` 带 `refresh` 时重新检测，`setExecutablePath` 也重新检测。每次检测都经 `onChange` 报出。回合里的助手消息报 `authentication_failed` 时把账号标成没登录。

建会话、发消息之前先要“已装、已登录”：没装报 `engine_unavailable`，没登录报 `missing_credentials`（与 ChatGPT 会话相同，补记 10）。

## 3. 模型（`model-manifest.ts`、`model-catalog.ts`）

模型清单是 T3 的 `model-manifest.json` 里 `claudeAgent` 一节的原样拷贝（13 个模型，各带 profile 与 `minVersion`）。T3 运行时还会从 GitHub 重新拉这份清单，Wevir 不联网，只用随包的；升级时从新的 T3 提交重新复制。

- `models()`：按装的 `claude` 版本过滤（`minVersion` / `maxVersionExclusive`，T3 的 `resolveClaudeModelsForVersion`；版本不知道时只留没有版本要求的），current 的在前、legacy 在后；默认模型是清单的 `defaults.chat`（Claude Fable 5.1），用不了时取第一个。`claude` 2.1.287 上是 12 个（Claude Haiku 5.5 要 2.1.293）。
- 推理档位：profile 的 effort 选项里 Wevir 认识的值（low / medium / high / xhigh / max）；T3 的 ultracode、ultrathink 与 fastMode 不在 Wevir 的档位里，不提供。交给 Claude Code 时按 profile 的 `effortMap` 换算（如 Opus 4.7 的 xhigh 跑成 max、Sonnet 4.6 的 max 跑成 high）；不传档位时用 `claude` 自己的默认。
- 上下文窗口：`fixedContextWindowTokens`，或默认的 `contextWindow` 选项对应的值；默认选项有模型后缀时交给 Claude Code 的模型 ID 带上它（Opus 4.6 是 `claude-opus-4-6[1m]`）。
- 清单里没有的模型 ID 原样交给 `claude`。

## 4. 会话与回合（`claude-adapter.ts`）

### 4.1 进程

每个会话一个 `query()`（一个 `claude` 进程），流式输入：适配器把用户消息推进一个异步队列。进程在第一次 `send` 时才起，空闲时一直留着，`close` / `dispose` 时关掉。`claude` 自成进程组，退出后整个组收 SIGKILL（T3 的 `spawnClaudeProcessGroup`：它起的 MCP 服务器的子进程不会随它退出）。

建进程的选项（照 T3 的 `makeClaudeQueryOptions`）：

| 选项 | 值 |
|---|---|
| `pathToClaudeCodeExecutable`、`env` | §2 |
| `cwd`、`additionalDirectories` | 会话的工作目录；环境会话的额外目录（`additionalRoots`，0.15.0） |
| `sessionId` / `resume` | 会话 ID 由适配器事先定好（`randomUUID()`），第一次用 `sessionId`，会话记录写进磁盘之后用 `resume` |
| `model`、`effort` | §3 |
| `permissionMode`、`allowDangerouslySkipPermissions`、`canUseTool` | §5 |
| `includePartialMessages` | `true`（增量） |
| `forwardSubagentText` | `true`（子 agent 的文本与思考也交出来，§6.4） |
| `thinking`、`settings.showThinkingSummaries` | `{ type: 'adaptive', display: 'summarized' }`（T3：新模型默认不显示思考内容） |
| `systemPrompt` | Claude Code 的预设提示词（`preset: 'claude_code'`），不追加 |
| `settingSources` | 不传：用户的设置、CLAUDE.md、hooks 与 MCP 照常生效（同 T3） |

### 4.2 一个回合

`send` 推一条带 uuid 的用户消息即返回。Claude 在回答这条消息的帧上带回它的 uuid（`user_message_uuid(s)`），`result` 结束回合。结果的 uuid 里没有这条消息的（Claude 自己开的一轮，例如后台任务结束后的唤醒）不结算这个回合，原样作 `engine.raw`（T3 的 `isClaudeResultForOtherTurn`）。回合之外到的助手消息与工具结果同样作 `engine.raw`。

`result` → 终结事件（`turn-result.ts`，T3 的 `terminalStatusFromResult` / `providerFailureFromResult`）：

| 结果 | 事件 |
|---|---|
| 取消中、用户选了“拒绝并停止”，或中断（`terminal_reason` 是 `aborted_streaming` / `aborted_tools`，或错误里写着 interrupt / cancel） | `turn.settled`（`cancelled`，`stopReason` 是 `terminal_reason`） |
| `subtype` 不是 `success` | `turn.failed`：第一条不是 `[ede_diagnostic]` 的错误；回合里报过 `authentication_failed` 的归 `missing_credentials`，其余 `unknown` |
| `success` 而 `is_error`，或 `terminal_reason` 是失败原因 | `turn.failed`：401 或报过认证失败 → `missing_credentials`；有 HTTP 状态（429、529 等）或 `api_error` / `blocking_limit` → `provider`，`code` 是状态码 |
| 其余 | `turn.settled`（`completed`，`stopReason` 是 `stop_reason`） |

CLI 自己生成的错误消息（模型是 `<synthetic>` 且带 `error`，如 “Please run /login”）不当回答显示，错误进 `turn.failed`（T3 同）。

### 4.3 取消

`cancel`：先把未决的审批与提问以 `turn_cancelled` 结掉（回给 Claude 拒绝并中断），再 `Query.interrupt()`，等这个回合的结果（10 s）按取消结算。等不到就关掉进程（下次 `send` 以 `resume` 重起），回合照样按取消结算——进程没了回合必然已停，所以 Claude 适配器不报 `cancel_unconfirmed`。T3 中断后总是关掉进程，Wevir 只在等不到时关。

### 4.4 进程中途退出：不报 `engine.exited`

消息流以错误结束（`claude` 崩了、被杀）时：进行中的回合以 `turn.failed` 结束（原因是 SDK 的错误原文，含 log in / authenticat / credential 的归 `missing_credentials`），未决的审批以 `engine_exited` 结束；会话照样挂着，下次 `send` 以 `resume` 起一个新进程。回合之间退出什么都不报。与 dsh、Codex 不同：每个会话一个进程，重起只影响这一个会话，不必让 Host 走一遍恢复。契约的“引擎进程退出”两条因此跳过。

### 4.5 插话：priority `next`（R11）

`steer` 推一条 `priority: 'next'` 的用户消息（T3 用 `now`，会打断正在进行的输出；Wevir 的插话不打断）。实测（`steer.next` / `steer.now` 录音，`claude` 2.1.287）：

- 有工具调用时 Claude Code 在下一次工具调用的间隙把它并进回合，之后的帧带上它的 uuid；
- 没有工具调用时这一轮照常答完（`result`），再以它开下一轮；`now` 则先以 `aborted_streaming` 结束这一轮。两种情况 `queued_turn_count` 都是 0。

所以：帧上第一次出现插话的 uuid 时报 `turn.steered`（之前没提交的增量先提交）；插话还没进回合时到的 `result` 推迟，等插话那一轮的结果再结算（Wevir 当作同一个回合）。Claude 取消了排队的插话（`command_lifecycle` 的 `cancelled`）时不再等它，推迟的结果照常结算。没有进行中的回合、正在取消时报 `steer_rejected`。

### 4.6 换模型、档位与权限（0.9.0、0.11.0）

`configureSession` 只记下新的值。下一次 `send` 时在进程里改：`Query.setModel`、`applyFlagSettings({ effortLevel })`、`setPermissionMode`。清掉档位（进程里的重置会去模型默认，新进程才读用户的设置，T3 的 `canApplyClaudeSelectionLive`）、换到完全访问（要启动参数 `allowDangerouslySkipPermissions`）、或进程里改失败时关掉进程、以 `resume` 重起。

### 4.7 恢复与关闭

- `close`：有回合先按 §4.3 取消，再关进程；之后 `send` 报 `session_closed`。同一实例里关掉的会话 `resumeSession` 直接挂回（不问磁盘）。
- `resumeSession` 不认识的 ID（Host 重启后）：用 SDK 的 `getSessionInfo(id, { dir: cwd })` 看 `~/.claude/projects` 里有没有这个会话的记录，没有（或 ID 不是 UUID）报 `session_lost`（`not_found`），Host 把会话标为只读；有就挂上，下次 `send` 以 `resume` 起进程。

### 4.8 会话标题：`generateTitle`

一次性的 `query()`（字符串 prompt），同 T3 的标题生成（`claude -p --json-schema`）：会话的模型、它最低的档位，Host 给的说明作系统提示词，`tools: []`、`settingSources: []`、不跑 hooks、不连 MCP、`permissionMode: 'dontAsk'`、`persistSession: false`、`outputFormat` 是 Host 给的 JSON Schema，工作目录 `<数据目录>/engines/claude`；返回结构化输出的 JSON。会用掉用户一点额度。

### 4.9 压缩上下文（0.24.0）

`compact` 照 T3 的 `compactThread`（`ClaudeAdapterV2.ts`）把 `/compact` 当一条消息发给会话的进程，`claude` 在本地执行这条斜杠命令（支线的边界说明不加在它前面，留给下一条消息）。回合里 `system/status` 的 `status: 'compacting'` → `context.compacting`（`compactionId` 是这条消息的 uuid，`compact` 开的回合是 `manual`，其余是 Claude 自己压缩的 `auto`），`compact_boundary` → `context.compacted`（同一 `compactionId`，`trigger` 取 `compact_metadata.trigger`）；`compact_metadata.post_tokens` 是压缩后的上下文用量，另报一条 `usage.updated`（T3 同样拿它更新用量）。`status` 带 `compact_result: 'failed'` 时压缩没成，不报完成，回合照常结算。`/compact` 的结果不一定带这条消息的 uuid，这种回合不按 uuid 对结果（§4.2）。代码审查（`review`）Claude 没有对应的命令，不实现。

### 4.10 读历史的工具（0.25.0，接力）

Host 给了 `historyTool` 时，每个会话的 `query()` 选项带 `mcpServers: { wevir_history: { type: 'stdio', command, args, env } }`（`@wevir/runtime-adapter/history-tool` 的命令，脚本在第一次起进程前写好）与 `allowedTools: ['mcp__wevir_history__read_session_history']`：这个只读工具不经 `canUseTool`、不出审批。会话从别的来源接力过来时（domain-model §3.14），模型用它读换来源之前的全文。实测（`claude` 2.1.287、Claude Haiku 4.5，2026-10-15）：模型先用 ToolSearch 取到 `mcp__wevir_history__read_session_history` 再调用，拿到第一条用户消息的原文；交给它的接力摘要随第一条消息的开头进上下文，它据此答出之前的对话内容。

## 5. 权限与审批（`permissions.ts`）

### 5.1 三种模式

Wevir 的三种模式按语义对到 Claude Code 的权限模式（同 T3 的 runtimeMode 一支）：

| Wevir（界面） | Claude Code | 行为 |
|---|---|---|
| `on_request`（请求批准） | `default` | Claude Code 自己判断哪些调用要问（改文件、不在只读名单里的命令等），经 `canUseTool` 交给用户 |
| `auto_review`（自动批准） | `auto` | Claude Code 的模型分类器逐个批准或拒绝，拿不准时照样经 `canUseTool` 问用户 |
| `full_access`（完全访问） | `bypassPermissions` + `allowDangerouslySkipPermissions` | 不问；`canUseTool` 收到的请求一律允许（AskUserQuestion 除外） |

Codex 的 `on_request` 在工作区里写文件不问（沙箱放行），Claude 的 `default` 改文件也问，所以桌面端审批卡片的标题按会话的目录与 Provider 写（desktop-tokens §17）：Claude 改项目目录里的文件是“允许修改文件？”，运行命令是“允许运行命令？”，路径出了目录才说“项目目录之外”。`auto` 模式在账号没有资格时 `claude` 会退回别的模式，初始化消息里的模式与请求的不同时记一条告警。

### 5.2 `canUseTool` → 审批

`canUseTool(toolName, input, { toolUseID, signal, suggestions, agentID, … })`：先报这次工具调用的 `tool.started`（回调可能先于消息到；一次工具调用只报一次），再报 `approval.requested`（`requestId` 与 `toolCallId` 都是 `toolUseID`）。选项照 adapter-codex 的四个：

| `optionId` | `kind` | 回给 SDK 的 `PermissionResult` |
|---|---|---|
| `accept` | `allow_accept` | `allow`（原输入，`user_temporary`） |
| `acceptForSession` | `allow_accept_for_session` | `allow` + `updatedPermissions`：Claude 给的建议规则改成只在本会话生效（`destination: 'session'`），没有建议时按工具名加一条；不写进用户的设置文件（T3 的 `toSessionPermissionUpdates`） |
| `decline` | `reject_decline` | `deny`（“User declined tool execution.”），模型接着做 |
| `cancel` | `reject_cancel` | `deny` + `interrupt: true`：Claude 中断回合，按取消结算 |

SDK 的 `signal` 中止（中断、进程退出）时审批以 `approval.cancelled` 结束。回合结束时仍未决的以 `turn_ended`、取消时以 `turn_cancelled`、`dispose` 时以 `disposed` 结束。子 agent 发起的请求带 `agentID`（它的任务 ID，§6.4），审批记在那个子会话上。

### 5.3 提问：AskUserQuestion

`canUseTool('AskUserQuestion', { questions })` → `question.requested`（T3 的 `claudeUserInputQuestions`）：问题 ID 就是问题原文（Claude 按原文认回答），`header` 没有时是 “Question N”，选项原样，`multiSelect` 原样，`allowOther: true`（Claude Code 的提问总能填别的）。`respondToQuestion` 的回答作为工具的新输入交回：`{ questions, answers: { 问题原文: 选项用 ", " 连起来 } }`。中断时以 `question.cancelled` 结束、回给 Claude 拒绝。

## 6. 事件逐条映射

### 6.1 增量与已提交消息

| SDK 消息 | 事件 |
|---|---|
| `stream_event` `message_start` | 新的 attempt（`attemptId` 是 API 消息的 `id`）；上一条没被替换的增量先提交 |
| `content_block_start`（text / thinking） | 记下这一块（`blockIndex` 是流式的 `index`），带初始文本时报增量 |
| `content_block_delta` `text_delta` / `thinking_delta` | `assistant.delta`（`text` / `reasoning`）；`signature_delta`、`input_json_delta` 不报 |
| `assistant` 快照 | 每个内容块按序号对上流式的 `index`：text → `assistant.message`、thinking → `assistant.thought`，`messageId` 是 `<API 消息 id>:<序号>`，`replaces` 指向同一块的增量；思考的快照不带文本（不显示思考时）以增量拼出的为准 |
| `system/api_retry` | 这一 attempt 的增量作废：`assistant.stream_ended`（`abandoned`） |
| 回合结束、插话进来时还没被替换的增量块 | 按已收到的文本提交（中断时的半截输出） |

只有顶层会话有增量；子 agent 的输出整段到（`replaces` 为空）。

### 6.2 工具（`tool-display.ts`）

快照里的 `tool_use`（及 `server_tool_use`、`mcp_tool_use`）→ `tool.started`（`toolName` 是 Claude Code 的工具名，`input` 原样）；用户消息里的 `tool_result` → `tool.finished`（`is_error` → `failed`，输出是文本块拼起来）。展示类型按工具名（去掉大小写、空白、下划线与连字符，T3 的 `classifyClaudeNativeTool`）：

| 工具 | `display.kind` | 字段 |
|---|---|---|
| Bash、BashOutput、KillShell、Monitor | `shell` | `command`，摘要是第一行 |
| Read、LS | `read` | `paths: [file_path]` |
| Edit、MultiEdit、NotebookEdit | `edit` | `paths`（桌面端从 `old_string` / `new_string` 算增删行数） |
| Write | `write` | `paths` |
| Glob、Grep、ToolSearch、WebSearch | `search` | `query`（pattern / query）、`paths: [path]` |
| WebFetch | `fetch` | `url` |
| Agent、Task、SendMessage、TaskStop | `sub_agent` | 摘要是 description |
| TodoWrite、TaskCreate / TaskUpdate / TaskList / TaskGet、ExitPlanMode、EnterPlanMode | `plan` | |
| `mcp__<server>__<tool>` | `unknown` | `mcpServer` |
| 其余 | `unknown` | 摘要取 command / 路径 / description 等 |

### 6.3 清单与支线

- **清单**（`todos.ts`）：TodoWrite 的输入是完整清单，紧跟它的 `tool.started` 报 `todo.updated`；Claude 5 用 TaskCreate / TaskUpdate / TaskList 逐条改（T3 的 `applyClaudeTaskTool`：ID 来自 TaskCreate 的结果，`deleted` 删掉一条，TaskList 换掉整张），工具成功结束后报整张清单的 `todo.updated`（`toolCallId` 是那次调用）。
- **支线**（0.17.0，`side.ts`）：`fork` 用 SDK 的 `forkSession(id, { dir, upToMessageId })` 复制会话记录到最近一个完成的回合的最后一条（回合进行中也行；还没有完成的回合时 `invalid_input`），新会话 `persistSession: false`、以 `resume` 起，第一条消息前面放上边界说明（与 adapter-codex 的措辞相同）。分出的那份记录留在 `~/.claude/projects`，支线自己的回合不写进去。
- **补说明**（0.16.0）：`injectNote` 推一条 `shouldQuery: false` 的用户消息——只写进会话记录、不开回合，随下一条消息交给模型；进程还没起时先存着，起进程后在下一条消息之前推进去。

### 6.4 子 agent → 子会话（R4）

Claude 默认把 Agent 工具放到后台（工具立即返回 “Async agent launched”、做完后发 `task_notification`，再由 Claude 自己开一轮回答，录音 `subagent` 的第一版）。Wevir 的顶层会话没有引擎自己开的回合，那一轮的输出会丢，所以交给 `claude` 的环境设 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`：子 agent 与后台命令都在回合里跑完，父 agent 等 Agent 工具的结果再回答。

| SDK | 事件 |
|---|---|
| 父会话（或子会话）快照里的 Agent / Task 调用 | 那个会话报 `tool.started`（`sub_agent`）与 `subagent.started`：`childEngineSessionId` 是 `<会话 ID>/<tool_use_id>`，`title` 是 description（没有时 prompt 首行），`prompt`、`role`（`subagent_type`）、`modelId`（输入里的 `model`）；子会话的流（第一个订阅者之前缓冲）先报 `turn.started`（`input` 是 prompt） |
| `system/task_started`（`tool_use_id` 对上） | 记下子会话的任务 ID：子 agent 的审批带它（`agentID`），`stopTask` 用它 |
| `parent_tool_use_id` 是这次调用的快照与工具结果 | 子会话的 `assistant.message` / `assistant.thought`（整段）、`tool.started` / `tool.finished`；嵌套的 Agent 调用照样开孙会话 |
| 父会话里这次 Agent 调用的结果 | 父会话 `tool.finished`；子会话以 `turn.settled`（`completed`）结束，`is_error` 时 `turn.failed`；子会话没报过回答时用结果文本补一条 `assistant.message` |
| 仍是后台启动的（结果是 `async_launched`）| 等 `task_notification`：completed / stopped / failed → 完成 / 取消 / 失败 |

`cancel` 子会话（Host 级联，或用户单独停掉，0.14.0）：结掉它的审批（回给 Claude 拒绝并中断），`Query.stopTask(任务 ID)`，子回合以取消结算；Agent 工具的结果照常交回父 agent，它自然知道，`notifyParent` 不另外补说明。父回合结束时还在跑的前台子会话按取消结算。子会话不接受 `send`。

### 6.5 用量

顶层会话的每条 API 消息（同一 `id` 的快照只算一次，`<synthetic>` 不算）报 `usage.updated`：`contextUsed` 是 input + 缓存写入 + 缓存读取 + output（T3 的 `claudeProviderTurnTokenUsage`），`contextSize` 是 §3 的上下文窗口（不知道时 200k）。回合结束时再报一次，带 `totalTokens`（结果的 `modelUsage` 各模型四项之和，SDK 按进程累计）。

### 6.6 不映射的消息

丢弃：`command_lifecycle`（用于 §4.5 的取消）、`tool_progress`、`tool_use_summary`、`auth_status`、`prompt_suggestion`、`system/` 的 `status`（`compacting` 除外，§4.9）、`session_state_changed`、`thinking_tokens`、`hook_*`、`task_progress`、`task_updated`、`background_tasks_changed`、`commands_changed`、`files_persisted`、`ui_status`。`system/init` 只用来核对权限模式。`compact_boundary` 见 §4.9（回合之外到的作 `engine.raw`）。其余（`model_refusal_fallback`、`local_command_output` 等）作 `engine.raw`（开发模式的界面才显示）。

## 7. 测试

| 层 | 文件 | 内容 |
|---|---|---|
| 单元 | `account.test.ts`、`units.test.ts` | 套餐与登录状态、用量与 `rate_limit_event`（录音里的真实消息）、检测的缓存与刷新、没装 / 跑不起来 / 没登录；找 `claude`（GUI 的短 PATH、Windows 启动脚本）、环境、模型目录（版本过滤、档位换算、`[1m]`）、结果归类、工具展示、清单与提问 |
| 映射回放 | `claude-adapter.test.ts` | 假的 SDK（`test-fixtures/fake-sdk.ts`）回放 `test-fixtures/sdk/` 的真实录音：增量与替换、工具、审批的四个选项、完全访问与自动批准、子 agent、换设置（进程里改与重起）、支线、补说明、标题、清单、提问、认证失败、进程中途退出；压缩上下文（0.24.0，照真实消息形状拼的 `status` 与 `compact_boundary`：manual、auto、压缩失败） |
| 契约第 1 层 | `claude-adapter.contract.test.ts` | `runAdapterContract` 跑在假 SDK 上（审批按决定走对应录音的分支；中断、插话、子 agent 的审批与慢回合是照真实消息形状拼的脚本）：21 条通过，“引擎进程退出”两条跳过（§4.4） |
| 契约真实层 | `claude-adapter.contract.real.integration.test.ts` | 本机真实的 `claude`（`WEVIR_TEST_CLAUDE=1`，`claude-haiku-4-5`，用掉订阅额度，命令见文件头）；2026-10-15 在 `claude` 2.1.287 上跑过 12 条：一问一答与多回合、增量替换、工具、审批允许 / 拒绝 / 挂起时取消、恢复、插话、子会话、子会话的审批、取消子会话 |
| 录制 | `test-fixtures/record-sdk.test.ts` | `WEVIR_RECORD_CLAUDE=1` 时重录样本（`settingSources: []`，本机路径、用户的插件与命令清单抹掉） |

## 7a. 图片（0.28.0）

用户消息里的图片按 T3 Code 的 `makeClaudeUserMessageWithAttachments` 发：`SDKUserMessage.message.content` 是内容块，每张图片一个 `{ type: 'image', source: { type: 'base64', media_type, data } }`（读 Host 存的文件），文本块在最后；只有文本时照旧是字符串。插话同样。Claude 的模型都收图片（随包的模型清单里 `supportsImages` 恒为 true），`acceptsImages` 一律回答收。

## 8. 留给后续任务

- **跨来源换模型的接力**（补记 14）另做。
- **后台任务**：关掉了（§6.4）。要支持就得让顶层会话接受引擎自己开的回合（协议与 Host 都要改）。
- **slash 命令与 skills**：T3 把 `claude` 初始化结果里的命令与 skills 交给界面，Wevir 的协议还没有这类字段。
- **模型清单的更新**：随包的清单跟着 T3 的提交手动更新，不联网拉。
- **建议的后续任务**（0.16.0）：Codex 经 Wevir 的 MCP 工具实现，Claude 可以用 SDK 的进程内 MCP 服务器（`createSdkMcpServer`）照做，没有做。
