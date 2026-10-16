# Cursor SDK → Wevir 事件映射

> 状态：v0.1（订阅来源 `cursor` 的引擎：应用内登录、模型、会话、回合与流式事件、取消、恢复）· 日期：2026-10-15
> 依据：[ADR-0005](../adr/0005-agent-runtime-and-model-gateway.md) 补记 14；[host-api.md](./host-api.md) §3.1 的 `account.*`；[领域模型](./domain-model.md) §3.6
> 代码：`packages/adapter-cursor/src/`（`sdk.ts`、`credentials.ts`、`accounts.ts`、`models.ts`、`mapping.ts`、`tool-display.ts`、`transport-failure.ts`、`errors.ts`、`cursor-adapter.ts`），登记在 `packages/host/src/engines.ts`
> 来源：移植自 T3 Code（[pingdotgg/t3code](https://github.com/pingdotgg/t3code)，MIT，提交 `ec1313c8f8333292506f05a355bb72d308a455d8`）的 `packages/provider-cursor`，逐文件的登记见 [UPSTREAM.md](../upstream/UPSTREAM.md) §4

本文件写 Cursor 引擎怎样被 Wevir 驱动，以及 Cursor SDK 的流式更新怎样变成 `AgentEvent`（`packages/runtime-adapter/src/events.ts`），Host 再照 domain-model.md §6 写成 `WevirEvent`。SDK 的类型以锁定版本 `@cursor/sdk` 1.0.35 的 `dist/esm/**/*.d.ts` 为准。

## 1. 引擎的形态

- **SDK 在 Host 进程里跑。** `@cursor/sdk`（只由 `packages/adapter-cursor` 声明，AGENTS.md 规则 2）的本地 agent（`Agent.create` / `Agent.resume` 带 `local`）就在 Host 进程里执行模型返回的工具调用，不需要 Cursor CLI，也没有子进程可以重启；工具的 shell 由 SDK 自己起（Cursor 的沙箱包装，平台包 `@cursor/sdk-<平台>` 带 `cursorsandbox`、`rg`、tree-sitter）。
- **懒加载。** SDK 约 2 MB 的 ESM 在第一次登录、读账号的模型或建会话时才 `import()`（`sdk.ts`），Host 启动、`account.list` 读本地凭据都不加载它。
- **路由。** `engines.ts` 登记 `{ name: 'cursor', adapter: CursorAdapter, kinds: ['cursor'] }`；`--adapter codex` 的 Host 是 Codex 加 Cursor 的 `EngineRouter`。
- **一个 Wevir 会话 = 一个 Cursor agent**，引擎会话 ID 是 `agentId`；一个回合是一次 `agent.send` 开出的 run。有图片（0.28.0）时 `send` 的消息是 `SDKUserMessage { text, images: [{ data, mimeType }] }`（base64，读 Host 存的文件，同 T3 Code 的 CursorAdapterV2），否则照旧是字符串。
- **数据在哪。** 登录铸出的 API Key 在 `<数据目录>/engines/cursor/auth.json`（§2）。agent 的对话与检查点由 SDK 存在它的默认位置（`~/.cursor/projects/<工作区>/sdk-agent-store/`，SQLite 或 JSONL），与 T3 相同；`settingSources` 让 agent 读用户自己的 Cursor 设置（规则、skills、hooks、MCP、团队与 MDM 策略、插件）。
- **外连。** SDK 连 Cursor 的后端（默认 `api2.cursor.sh`，环境变量 `CURSOR_BACKEND_URL` 可改；登录页 `cursor.com`，`CURSOR_WEBSITE_URL` 可改）。
- **unhandled rejection。** 工作目录不对时 SDK 起 shell 失败（`spawn /bin/zsh ENOENT`）会 reject 一个没人等的内部 promise。Host 把 unhandled rejection 当致命错误，所以 `cli.ts` 先问 `engines.ts` 的 `isIgnorableEngineRejection`：带 Cursor 沙箱包装标记的这一种只记告警（T3 的同名守卫）。适配器也在建会话与恢复时先检查 cwd 是存在的目录。
- **许可证。** `@cursor/sdk` 不是开源软件（`SEE LICENSE IN LICENSE.md`：© Anysphere Inc.，使用受 Cursor 服务条款约束），作为 npm 依赖安装与运行，Wevir 不复制它的代码；T3 的做法相同。打包分发前要核对条款（UPSTREAM.md §1.1）。

## 2. 账号与登录（`accounts.ts`、`credentials.ts`）

`EngineAccounts.kinds` 只有 `cursor`。状态总带 `signIn: 'in_app'` 与 `loginMethods: ['browser']`；SDK 随包，所以没有 `installed`、`executablePath`、`setExecutablePath` 与 `install`。

| 操作 | 做法 |
|---|---|
| `read` | 有可用的 Key（`CURSOR_API_KEY`，否则是凭据文件里没过期的那把）就调 `Cursor.me({ apiKey })`（15 s 时限），`signed_in` 带邮箱（`userEmail`）；没有 Key 是 `signed_out`。不带 `refresh` 时 5 分钟内复用上一次的结果。Key 被拒（`AuthenticationError` 或 401）是 `signed_out` 带 `lastError`；网络等其他失败有上一次的结果就沿用，没有就报 `engine_unavailable`（Host 的 `account.list` 把它显示成未登录带原因）。 |
| `login(browser)` | `Cursor.auth.login({ openBrowser: false, onLoginUrl, signal, apiKeyName: 'Wevir', store })`：SDK 本地生成 PKCE 式的一次性 challenge，给出 `cursor.com/loginDeepControl?…` 的网址（成为 `login.authUrl`，界面用 `openExternal` 打开），然后轮询 `/auth/poll`；浏览器那边登录完成后，SDK 用这次的会话令牌经 `DashboardService/CreateUserApiKey` 铸一把有期限（默认 90 天）的用户 API Key，会话令牌随即丢掉。返回 `signing_in`；完成后经 `onChange` 报 `signed_in`。已有进行中的登录时替换它（中止旧的）。5 分钟没完成报 `signed_out` 带 “Cursor sign-in expired”。 |
| 落盘 | SDK 先写进内存（`MemoryCredentials`）；确认还是当前这次登录、没被取消，才存进 `<数据目录>/engines/cursor/auth.json`（SDK 的 `StoredSdkCredentials` 格式；目录 0700、文件 0600，先写临时文件再 rename，同 `FileSecretStore`），再用新 Key 读一次账号；被拒就删掉。取消或被替换的登录即使晚到也不落盘（T3：interrupting a store Promise cannot stop a late write）。 |
| `cancelLogin` | 中止 SDK 的轮询，回到 `signed_out`；`loginId` 不是当前的时不动。 |
| `logout` | 先停掉用着这把 Key 的会话（§3.4），再删凭据文件。Key 本身在 Cursor 那边到期前仍然有效，用户可以在 Cursor 后台的 API Keys 里吊销（名字是 Wevir）。 |
| `models` | `Cursor.models.list({ apiKey })`（15 s 时限，非空结果缓存 30 分钟）→ §3.1；没登录时是空表。 |

- **`CURSOR_API_KEY` 优先**（T3 相同）：设了它就用它，应用里的登录与登出报 `invalid_input`，提示先去掉这个环境变量。
- **密钥不落地**（AGENTS.md 规则 5）：Key 只在凭据文件与内存里；每次读到都交给 Host 日志的 `addSecret`，不进事件、`account.updated` 与日志。凭据文件不是 Host 的 `secrets.json`：适配器在 Host 进程里，但拿不到 Host 的 `SecretStore`；放在引擎目录下与 Codex 的 `engines/codex-chatgpt/auth.json` 同一保护级别。
- **没有套餐与用量。** SDK 的 `Cursor.me` 不给套餐，所以没有 `plan` / `planLabel`。T3 的用量读的是 Cursor CLI 自己的登录（macOS 钥匙串的 `cursor-access-token`，用户在 T3 里打开开关才读）；Wevir 不读其他软件存的凭据（ADR-0005 补记 14），没有 `rateLimits`。
- **不读 SDK 的默认凭据位置**：Wevir 总是显式传 `apiKey`，SDK 自己的 `~/.cursor/sdk/auth.json` 不读也不写。

## 3. 会话、模型与权限（`models.ts`、`cursor-adapter.ts`）

### 3.1 模型

账号的模型列表第一个是 `auto`（显示名 Auto，默认模型；交给 SDK 时换成 `default`，T3 相同），后面是 `Cursor.models.list` 的模型（去掉空的、重复的与 SDK 的 `default`）。Wevir 的模型只有推理档位：取模型参数里 `effort` 或 `reasoning` 那一个的取值中 protocol 认识的档位（off / minimal / low / medium / high / xhigh / max）作 `reasoningEfforts`；其余参数（fast、context、thinking 等）不出现在 Wevir 里，用 Cursor 的默认值。

会话的模型与档位 → SDK 的 `ModelSelection`：`{ id }`，档位在这个模型的参数里有对应取值时带 `params: [{ id: <参数 ID>, value: <原值> }]`（参数 ID 与原值取自缓存的模型列表），否则不带。

### 3.2 权限模式

SDK 没有审批回调（T3 的能力表 `supports*Approval` 全是 false），只有建 agent 时的两个开关：`local.sandboxOptions.enabled`（Cursor 的沙箱）与 `local.autoReview`（Cursor 的 Auto-review 分类器替用户判断越界的工具调用）。Wevir 的三种权限模式按语义映射：

| Wevir | `sandboxOptions.enabled` | `autoReview` | 含义 |
|---|---|---|---|
| `on_request`（默认） | true | false | 在沙箱里做；越界的操作没人能批准，就不做（不问也不做） |
| `auto_review` | true | true | 越界的操作由 Cursor 的分类器决定，对应“先由模型审查” |
| `full_access` | false | false | 不用沙箱、不审查 |

T3 的 `cursorRuntimeAgentPolicy` 是同一组开关：它的 approval-required 开 Auto-review，full-access 关沙箱。Wevir 的 `on_request` 不开 Auto-review，是因为用户选的是“越界的要我同意”，分类器替用户放行不符合这个意思。适配器声明三种模式（`permissionModes`），但永远不发 `approval.requested`，`listPendingApprovals` 总是空。

两个开关只能在建或恢复 agent 时给，所以 `configureSession` 换了权限模式时，下一个回合之前按新设置重新打开 agent（`Agent.resume`，同一个 `agentId`）；只换模型或档位不用重开，下一个回合的 `send` 带新的 `model`。

### 3.3 建会话、恢复与关闭

- **`createSession`**：先要有 Key（没有报 `missing_credentials`）、cwd 是存在的目录（否则 `invalid_input`），然后 `Agent.create`：`model`、`name: 'Wevir'`、`mode: 'agent'`、`apiKey`、`local: { cwd, autoReview, sandboxOptions, settingSources: ['project', 'user', 'team', 'mdm', 'plugins'], enableAgentRetries: true }`。`EngineSession.engineVersion` 是 SDK 版本 1.0.35。
- **`resumeSession`**：已挂着时直接成功；否则 `Agent.resume(agentId, 同样的选项)`。SDK 报 `AgentNotFoundError` 是 `session_lost`（`not_found`）。恢复后的第一条消息若撞上 “already has active run”（上一个 Host 进程的 run 还登记着），用 `Agent.listRuns` 找出在跑的那个、`Agent.cancelRun` 取消、再发一次（T3 的 abandoned run recovery）。
- **`close`**：先按 §5 取消进行中的回合，再 `agent.close()`，订阅结束；之后能 `resumeSession`。
- **不支持的**：插话（SDK 有 `run.steer`，T3 没用，Host 一律排队）、`fork`（支线会话）、子会话、提问、额外文件夹（SDK 有 `local.dirs`，没接）、会话标题（Host 用首条消息截断）。

### 3.4 登出时的会话

登出时（`account.logout`），挂着的会话都停下：进行中的 run 取消、没完成的工具按失败收尾，每个会话以 `engine.exited`（`exitCode: null`、`stderrTail: 'signed out of Cursor; sign in again and resume the session'`）脱开，agent 关闭。重新登录后 `resumeSession` 用新 Key 接着做。

## 4. 流式更新 → AgentEvent（`mapping.ts`、`tool-display.ts`）

`agent.send` 的 `onDelta` 逐条给出 `InteractionUpdate`。run 开出之前 SDK 就可能调它，先存着，`send` 拿到 runId 后再按顺序映射（T3 的 pendingUpdates）。一个回合一个 `CursorTurnMapper`。

### 4.1 文字与思考

SDK 只给增量，不给“这段定稿了”的消息。文字与思考各是一段一段的：另一种输出、工具调用、`step-completed` 或 `turn-ended` 一来，上一段就结束。

| 更新 | 事件 |
|---|---|
| `text-delta` | 先结束进行中的思考段；`assistant.delta`（`kind: text`，`attemptId: <runId>:text:<n>`，块 0） |
| `thinking-delta` | 先结束进行中的文字段；`assistant.delta`（`kind: reasoning`，`<runId>:reasoning:<n>`） |
| `thinking-completed` | 结束思考段 |
| 一段结束 | 有非空白字符：`assistant.message` / `assistant.thought`（`messageId` = attemptId，`replaces` 是这一段的块）+ `assistant.stream_ended`（`committed`）；只有空白：`assistant.stream_ended`（`abandoned`） |
| run 的 `result`（`RunResult.result`） | 整个回合没有一个回答增量时，当作一条 `assistant.message`（`<runId>:result`，`replaces` 为空）发出 |

### 4.2 工具

| 更新 | 事件 |
|---|---|
| `tool-call-started` | `tool.started`（`toolCallId` = `callId`，`toolName`、`display`、`input` = `toolCall.args`） |
| `partial-tool-call` | 参数变了才发 `tool.updated`（`display`、`input`）；`task` 的局部更新不看（T3） |
| `tool-call-completed` | 没开始过的先补 `tool.started`；`tool.finished`（`status`：结果是 error，或 MCP 结果的 `isError`，为 `failed`，否则 `completed`；`output` 见下） |
| `shell-output-delta` | 加到最近一个还在跑的命令上（SDK 不给这条输出属于哪次调用，T3 相同），`tool.updated` 带到目前为止的 `output` |
| `updateTodos` 的开始 / 局部 / 完成 | 照常的工具事件，另在待办变了时发 `todo.updated`：取结果里的列表（没有结果时取参数），去掉 cancelled 与空的，`inProgress` 写成 `in_progress` |

`toolName` 是 SDK 的工具类型（`shell`、`read`、`edit`…），MCP 是 `mcp__<server>__<tool>`。展示类型：

| SDK 工具 | `display.kind` | 摘要等 |
|---|---|---|
| `shell` | `shell` | `command` |
| `read`、`readLints` | `read` | 路径 |
| `ls`、`glob`、`grep`、`semSearch` | `search` | 查询词（`ls` 是路径），`paths` 是搜索目录 |
| `edit`、`delete` | `edit` | 路径 |
| `write`、`generateImage` | `write` | 路径 |
| `updateTodos`、`createPlan` | `plan` | — |
| `task`（子 agent） | `sub_agent` | 任务描述的第一行 |
| `mcp` | `unknown` | `<server>/<tool>`，`mcpServer` |
| 其他（SDK 类型表以外，随平台新增） | 有 `url` 参数是 `fetch`，有 `query` 是 `search`，否则 `unknown` | — |

`output`：命令是 stdout 与 stderr（没有时用流式收到的），MCP 是文本内容，`edit` 是 `diffString`，`read` 是文件内容，`task` 是子 agent 对话里的助手消息加结果后缀，其余是结果的 JSON；失败时是错误原文。

子 agent（`task`）只当成一个工具调用：SDK 不给它单独可订阅的会话，嵌套更新（`tool-call-delta`）不映射，结果在 `tool.finished` 的输出里。所以适配器的契约能力 `subagents` 是 false。

### 4.3 不映射的更新

`token-delta`、`summary*`、`step-started`、`tool-requests-listed`、`tool-call-delta`、`user-message-appended` 认识但不映射（`turn-ended` 带的 token 用量也不报：没有上下文窗口大小，凑不成 `usage.updated`）。不认识的类型整条保留为 `engine.raw`（`protocol: 'cursor-sdk'`，`method: 'onDelta'`，`kind` 是更新类型）。

## 5. 回合结算与取消

`run.wait()` 返回后：

| 情形 | 终结事件 |
|---|---|
| `status: finished` | `turn.settled`（`completed`，`stopReason: finished`） |
| `finished`，但整段回答只是一段传输诊断（`Error: ConnectError: [unavailable] …`、`Error: RetriableError: …`（`[internal]` 除外）或 “Something went wrong communicating with the server…”，`transport-failure.ts`，T3 原样） | `turn.failed`（`provider`，`message` 是那段诊断） |
| `status: cancelled`，或回合正在取消 | `turn.settled`（`cancelled`） |
| `status: error` | `turn.failed`：错误码或原文像认证失败（unauthenticated、API key…）是 `missing_credentials`，其余 `provider`；`message` 是 `RunResult.error.message` |
| `wait()` 抛错 | 回合正在取消或是 AbortError：`turn.settled`（`cancelled`）；认证失败：`turn.failed`（`missing_credentials`）；其余 `turn.failed`（`unknown`，原文） |

终结之前，还在流的文字与思考按 §4.1 提交（取消或出错时保留已经显示的输出）；取消与失败时没完成的工具以 `tool.finished`（`failed`）收尾（Host 在取消期间记为 cancelled），正常结束时留给 Host 记为 unknown。

**取消**：`run.cancel()`（吞掉 AbortError），最多等 10 秒（`CANCEL_TIMEOUT_MS`）回合结算。SDK 在时限内没结束这个 run 时，适配器自己按取消结算（T3 同样在 10 秒后自己收尾）、记告警，之后的更新丢掉，会话照常可用；下一条消息若撞上还没停的 run，按 §3.3 的办法取消它再发。所以 `cancel` 不报 `cancel_unconfirmed`。

## 6. 错误归类（`errors.ts`）

SDK 的错误类带自己的 `name`（打包后类名被压缩，但实例的 `name` 是对的），按 `name`、`status` 与 `code` 判断，不用 instanceof（测试里的假 SDK 与动态加载的真 SDK 是两套类）。

| SDK 错误 | AdapterError |
|---|---|
| `AuthenticationError`、HTTP 401 | `missing_credentials`（Host 归为 `missing_credentials`，界面提示去登录） |
| `AgentNotFoundError`（`agent_not_found`），在 `resumeSession` 里 | `session_lost`（`not_found`） |
| SDK 加载失败、其他错误 | `engine_unavailable`，原文保留 |

## 7. 与 T3 Code 的差异

- Effect 改写成普通 TS，没有引入 `effect`；SDK 用动态 import 而不是 `createRequire`（T3 为了 Node SEA）。
- 凭据存在 Wevir 的数据目录（§2），不进 Host 的 `secrets.json`；T3 存在自己的密钥库，并迁移旧版的文件。
- T3 自己的 MCP 服务（`t3-code`）换成 Wevir 的应用级工具（0.30.0，domain-model §3.15）：会话带 `SessionConfig.appTools` 时 `Agent.create` / `Agent.resume` 的选项里有 `mcpServers.wevir`（`type: 'http'`、`url`、`Authorization` 头），重新打开 agent 时照样带上；Cursor 没有审批，工具直接调用。只验证了选项（`cursor-adapter.test.ts`），没有用真实账号跑。
- 不接 skills 的 `$提及` 改写、图片附件、计划模式（`mode: 'plan'` 与 `createPlan` 的计划视图）、`/compress`、`readThreadSnapshot`、用量；子 agent 不建子线程。
- 权限模式按 §3.2 映射到 Wevir 的三种；换权限模式时重新打开 agent（T3 的会话中不能换）。
- 取消确认不了时 T3 记为 interrupted，Wevir 记为 cancelled。

## 8. 验证

自动化（`pnpm vitest run --project adapter-cursor`，不需要账号，不联网）：

- `mapping.test.ts`：按 SDK schema 手写的更新序列（`test-fixtures/updates.ts`，类型就是 SDK 的 `InteractionUpdate`，字段不对 tsc 报错）回放 §4 的映射。
- `cursor-adapter.contract.test.ts`：runtime-adapter 的契约套件跑在假 SDK 上（审批、子会话、插话与进程退出的条款按能力跳过）。
- `cursor-adapter.test.ts`：建会话与恢复的选项、权限模式、run 开出前的更新、忙、取消与取消确认不了、各种失败、遗留 run 的恢复、换模型与重开、登出时脱开、dispose。
- `accounts.test.ts`：登录、取消、替换、超时、登出、`CURSOR_API_KEY`、Key 被拒、缓存，Key 不出现在状态里。
- `login.integration.test.ts`：**真实 SDK** 的 `Cursor.auth.login`，登录页、`/auth/poll` 与铸 Key 的 Connect 端点换成本机 mock（二进制 protobuf，字段号取自 SDK 打包的 proto 描述）；测试自己访问登录网址，不打开浏览器；外连被拦下并让测试失败。
- Host 的 `cli.test.ts`：`--adapter codex` 是 Codex 加 Cursor 的路由；Cursor 的 shell 起不来的 rejection 不让 Host 退出，别的仍然致命。

另外在构建好的 Host 进程上走过一遍（2026-10-15）：Cursor 的后端换成本机 mock（`CURSOR_BACKEND_URL` / `CURSOR_WEBSITE_URL`），客户端经 WebSocket `account.list` → `account.login` → 访问 `authUrl` → `account.updated`（`signed_in`，邮箱来自 `/v1/me`）→ Host 按 `/v1/models` 建了 `cursor` Provider（Auto、带推理档位的模型）→ `account.logout`；凭据文件 0600，Key 不在日志与通知里，没有外连，没有写 `~/.cursor`。

**待维护者验证**（需要 Cursor 账号，自动化做不了）：

1. `pnpm dev` 打开桌面端，设置 → 模型服务 → 订阅 → Cursor → 登录；浏览器打开 Cursor 的登录页，登录并确认。
2. 设置里的 Cursor 变成已登录、显示邮箱；`<数据目录>/engines/cursor/auth.json` 存在且是 0600；Cursor 后台的 API Keys 里多了一把叫 Wevir 的 Key。
3. 模型选择里出现 Cursor 一组（Auto 与账号能用的模型）。选一个模型建会话，发一条要读文件、跑命令、改文件的消息：消息流里有思考、回答与工具调用（命令输出、改动的 diff），回合正常结束。
4. 回合进行中点停止：回合以停止结束，之后能接着发。
5. 把权限模式换成完全访问再发一条：沙箱外的命令能执行；换回请求批准：越界的操作不做。
6. 重启桌面端（Host 重启）后回到这个会话接着发：会话恢复，Cursor 记得之前的对话。
7. 登出：会话停下并提示重新登录；再登录后能恢复。Cursor 后台的那把 Key 需要时手动吊销。
