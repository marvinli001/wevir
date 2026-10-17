# Antigravity → Wevir 事件映射

> 状态：v0.1（订阅来源 `antigravity` 的引擎：下载安装、应用内登录、模型、会话、审批与提问、取消、恢复）· 日期：2026-10-15
> 依据：[ADR-0005](../adr/0005-agent-runtime-and-model-gateway.md) 补记 14；[host-api.md](./host-api.md) §3.1 的 `account.*`（含 `account.install`、`account.setPath`）；[领域模型](./domain-model.md) §3.6；通用 ACP 映射见 [acp-event-mapping.md](./acp-event-mapping.md) 第一部分
> 代码：`packages/adapter-antigravity/src/`（`release.ts`、`installation.ts`、`zip.ts`、`profile.ts`、`process.ts`、`engine.ts`、`protocol.ts`、`models.ts`、`accounts.ts`、`session-files.ts`、`antigravity-adapter.ts`），登记在 `packages/host/src/engines.ts`
> 来源：移植自 T3 Code（[pingdotgg/t3code](https://github.com/pingdotgg/t3code)，MIT，提交 `ec1313c8f8333292506f05a355bb72d308a455d8`）的 `apps/server/src/provider/` 里 Antigravity 的部分与 `orchestration-v2/Adapters/AntigravityAdapterV2.ts`，逐文件的登记见 [UPSTREAM.md](../upstream/UPSTREAM.md) §4

本文件写 Wevir 怎样安装、启动、登录 Google 官方的 Antigravity ACP 运行体，以及它的 ACP 消息怎样变成 `AgentEvent`。Antigravity 是一个 ACP 引擎，会话、审批、取消与恢复都由通用 ACP 适配器（`@wevir/adapter-acp` 的 `AcpAdapter` / `AcpProcess`）处理，这里只写 Antigravity 的部分。**真实运行体还没有在 Wevir 里跑过**（下载约 110–330 MB、解开 0.4–1 GB，待维护者决定；见 §8），文中“照 T3”的行为以 T3 的代码与测试样本为依据。

## 1. 引擎的形态

- **运行体。** Google 的 `agy_acp_server.par`（Windows 是 `.exe`）加同目录的 `localharness_external`，PyInstaller 单文件，经 stdio 说 ACP。Wevir 不随安装包带它：用户在设置里点下载（`account.install`，§2），或用 `account.setPath` 指定自己装的。
- **不声明 npm 包。** 运行体不是 npm 包，`packages/adapter-antigravity` 只依赖 `@wevir/adapter-acp`、`@wevir/runtime-adapter` 与解 ZIP 的 `yauzl`（AGENTS.md 规则 2 没有要加的边界）。ACP SDK 经 `@wevir/adapter-acp/sdk` 取。
- **路由。** `engines.ts` 登记 `{ name: 'antigravity', adapter: AntigravityAdapter, kinds: ['antigravity'] }`；`--adapter codex` 的 Host 是 Codex、Claude Agent、Cursor 加 Antigravity 的 `EngineRouter`。
- **一个进程承载全部会话**（通用 ACP 适配器的做法）。T3 每个线程一个进程；Antigravity 每次启动都要往临时目录解包约 1 GB，共用一个进程省磁盘与启动时间。运行体声明了 `session/list`、`session/resume`，多会话在协议上成立；实际并发表现待真机验证（§8）。
- **懒启动。** 构造适配器、Host 启动时读账号（`account.list`）都只看文件，不启动运行体；第一次建会话、登录、显式刷新或登出时才启动。
- **数据在哪。** 都在 `<数据目录>/engines/antigravity/` 下：`runtime/<平台>-<架构>/`（下载的运行体，§2）、`profile/`（运行体的 `GEMINI_HOME`：Google 登录、对话，§3）、`tmp/run-*`（每个进程的解包目录）、`models.json`（最近一次读到的模型列表，只有 ID 与名字）。

## 2. 下载安装（`release.ts`、`installation.ts`、`zip.ts`）

照 T3 的 `AntigravityInstallation`：

- **钉住版本。** 1.3.0，6 个平台（macOS arm64 / x64、Linux x64 / arm64、Windows x64 / arm64）的地址、sha256、压缩包与两个文件的字节数写死在 `release.ts`（T3 于 2026-10-05 从 ACP Registry 核对）。其他平台 `canInstall` 不出现，`lastError` 说明本平台没有发布、可以手填路径。
- **只在用户点了才下载。** `account.install` 立即返回带 `installing: { completedBytes: 0, totalBytes }` 的状态，进度经 `onChange` → `account.updated` 每 250 ms 一次；完成后 `installed: true`、`version: '1.3.0'`、`executablePath`，`canInstall` 与 `installing` 消失；失败时 `installing` 消失、`lastError` 写原因。协议没有取消安装的方法，适配器的 `cancelInstall()` 只在 dispose 时用。
- **步骤。** 检查剩余空间（压缩包 + 两个文件 + 256 MiB）→ 下载到 `downloads/<sha256>.zip.part`，边下边算 sha256，大小与 sha256 都对才继续（不对就删掉）→ 在 `versions/.install-*` 里解包：压缩包必须恰好是这两个文件，条目名、普通文件、未加密、stored / deflate、解出的大小都与钉住的一致 → `chmod 755` → **校验**：在临时 profile 里启动它，`initialize` 必须报 `antigravity-acp`、版本 1.3.0（也认 `agy_acp_server_1.3.0`）、`loadSession`、`sessionCapabilities.resume`、`auth.logout` 与 `oauth-personal` 登录方式 → 写 `.install-complete.json` → rename 成 `versions/<sha256>/` → 原子地写 `active.json`（写下它才算装好）。失败或取消都不影响已装的版本。
- **与 T3 不同：下载更能扛断网。** 请求带 `Accept-Encoding: identity`（dl.google.com 在客户端接受时会 gzip，那样无法续传）；断线、卡住（60 秒收不到数据）时没下完的部分留着，下次 `account.install` 用 `Range: bytes=<已有>-` 接着下，服务器回 200 就从头来、回的范围不对就删掉重来。
- **大陆网络。** dl.google.com 在大陆常连不上。连不上、断线或卡住时 `lastError` 写明主机与错误码，并给两条出路：设 `WEVIR_ANTIGRAVITY_MIRROR` 替换 `https://dl.google.com` 前缀（路径不变，例如内网镜像；内容仍按钉住的 sha256 校验，给错文件只会校验失败），或自己装好后在设置里填可执行文件路径（`account.setPath`）。Host 进程的 `fetch` 不读 `HTTPS_PROXY`。
- **找运行体的顺序**（`resolve`）：`account.setPath` 指定的（绝对路径，或 PATH 上的命令名）→ Wevir 装的（`active.json` 指向的版本，记录与两个文件的大小、执行位都要对）→ PATH 上的 `agy_acp_server.par`。可执行文件旁边必须有 `localharness_external`。指定的路径不对时 `installed: false` 并在 `lastError` 写原因。

## 3. 启动与隔离（`profile.ts`、`process.ts`）

照 T3 的 `buildAntigravityAcpSpawnInput` 与 `prepareAntigravityProfile`：

- **私有 profile。** `GEMINI_HOME=<数据目录>/engines/antigravity/profile`，`AGY_ACP_FORCE_FILE_STORAGE=1`（不用系统钥匙串）。登录存在 `profile/antigravity-acp/acp_token.json`，由运行体自己读写；Wevir 不改它，登录状态只看它在不在，查用量时只读（§6）。每次启动重写 `antigravity-acp/settings.json`（只有 `{"auth":{"type":"oauth-personal"}}`）。目录权限 0700。
- **去掉会盖过 profile 登录的环境变量**：`GEMINI_API_KEY`、`GOOGLE_API_KEY`、`GOOGLE_APPLICATION_CREDENTIALS`、`GOOGLE_CLOUD_*`、`GCLOUD_PROJECT` 等（Windows 上不分大小写），以及外面带进来的 `GEMINI_HOME`、`BROWSER`、`TMPDIR` 相关项。只支持个人 Google 账号（`oauth-personal`）；T3 的 Gemini API Key、Gemini Enterprise、Vertex 方式没有移植（Wevir 不保存这类密钥）。
- **自己的临时目录。** 每个进程一个 `tmp/run-*`（`TMPDIR`，Windows 是 `TEMP` / `TMP`），进程退出、适配器 dispose 时删掉；第一次启动任何进程之前清掉上一个 Host 被杀时留下的。
- **全局 skills。** 运行体在 `GEMINI_HOME` 下读 `config/skills` 与 `antigravity-cli/skills`，profile 里这两个位置链接到用户的 `~/.gemini/…`（链不上只告警；已有真目录不动）。用户那边没有的目录不链，以前链过的删掉：运行体会把悬空的链接解析成真实路径交给模型，模型拿它当命令的工作目录，命令起不来（没装 `agy` CLI 时 `antigravity-cli/skills` 通常不存在）。每次启动都重新核对，目录出现后下次启动链上。MCP 服务、hooks 与凭据仍然隔离。
- **其他。** Linux 上带 `--uid=`；`ANTIGRAVITY_HARNESS_PATH` 指向同目录的 harness；`PYTHONUNBUFFERED=1`；POSIX 上 detached 启动，回收时信号发给整个进程组。
- **adapter-acp 的钩子**（acp-event-mapping.md §0.2）：接受协议版本 1 与 2（1.1.1 报 2，线上仍是 v1 格式）；stdout 上以登录提示开头的行不是 JSON-RPC，在 ACP 解码之前去掉；stderr 上认 BROWSER 钩子写的网址；会话进程在 `initialize` 之后先 `authenticate`（§6）。

## 4. ACP 消息 → AgentEvent（`engine.ts`、`protocol.ts`）

通用映射见 acp-event-mapping.md §1；Antigravity 的引擎描述（`ANTIGRAVITY_ENGINE`）给出这些差异：

| 项 | Antigravity |
|---|---|
| `messageChunks` | `streamed`：`agent_message_chunk` / `agent_thought_chunk` 是逐字增量、没有 `messageId`（T3 的样本），适配器把连续的增量合成一块，发 `assistant.delta`，块结束时补 `assistant.message` / `assistant.thought`（`replaces` 指向这些增量）与 `assistant.stream_ended`（acp-event-mapping.md §1.5）。契约能力 `incrementalStream: true` |
| `tools.display` | 按 ACP 的 `kind`：`execute` → shell（命令取原生字段 `CommandLine` / `command_line` / `commandLine` / `command`），`read`、`edit`（含 `delete`、`move`）、`search`、`fetch`（`url`），路径取 `locations`；标题为 `Running start_subagent` / `Run start_subagent?` 的 `other` 工具是子 agent（MCP 的同名工具不算，`_meta.is_mcp_tool_call`），只作工具卡片，没有子会话，摘要取输入里的说明（`description`、`TaskName`、`prompt` 等第一个有文字的字段）。别的工具（含 MCP 工具）的标题是 `Running wevir_models` / `Run generate_image?` 这类句子，摘要只写工具名（事件的 `toolName` 仍是原标题）；`locations` 只进 `paths`，不顶替工具名 |
| `normalizeUpdate` | `tool_call` / `tool_call_update` 进映射之前给标题、`rawInput`、`rawOutput`、`content`、`_meta` 设上限（文本只留最后 8000 字、去掉图片数据，T3 的 sanitize）；没有文本内容时，`rawOutput` 里的输出放进文本内容，作为 `tool.finished.output`：命令的 `combinedOutput`，否则是字符串的 `rawOutput`（失败的 `start_subagent` 等，T3 的 `antigravitySubagentOutput` 也这样读）或 `error` / `message` / `output` / `stderr` 字段的文字。失败的调用因此带着原因，而不是“无输出” |
| `route` | 模型选项 `model` 的值就是模型 ID（Google 账号能用的原生 ID，思考档位在 ID 里，例如 `gemini-3.7-flash-high`），没有推理强度选项 |
| `classifyTurnError` | `-32000` 或要登录的措辞 → `missing_credentials`（账号同时改为未登录，§6）；`SUBSCRIPTION_REQUIRED`、`RESOURCE_EXHAUSTED`、额度、限流、429 → `provider`；其余 `unknown` |
| `classifyResumeError` | 找不到会话的措辞 → `lost`（`not_found`）；`already active` → `already_active`；其余 `unknown`。Antigravity 的原文没有录过，待真机核对 |

其余 `session/update`（`available_commands_update`、`current_mode_update`、`config_option_update` 等）照通用规则保留为 `engine.raw`。`/plan` 是 Antigravity 自己的命令，Wevir 不做计划模式。

## 5. 审批、提问与权限模式（`antigravity-adapter.ts`）

- **审批。** 普通的 `session/request_permission` 照通用桥接（acp-event-mapping.md §1.3）：选项原样（`allow_once`、`allow_always`、`reject_once`），桌面端按 `kind` 选。T3 给 “Allow Always” 附的提示注入警告（`_meta['agy.security.warning']`）Wevir 没有显示。
- **提问。** `toolCallId` 以 `interaction_` 开头的 `session/request_permission` 是提问。适配器的 `interceptPermission` 认出它，经通用适配器的 `requestAnswers` 报 `question.requested`（一道单选题：标题是问题，选项的 `label` 是选项名，重名时后面带 ` (<选项 ID>)`，不允许“其他”）；`respondToQuestion` 经 `answerQuestion` 交回答，回答由 Host 按问题核对过（`question.respond`），Antigravity 的钩子再把 label 换成选项 ID 回复 `selected`，换不上（兜底）时回复 `cancelled`。随回合结束、取消、引擎退出与 dispose 以 `question.cancelled` 结束（规则同审批，acp-event-mapping.md §1.7）。不进 `listPendingApprovals`。Host 因此声明 `user_questions`。
- **权限模式**（T3 的 `antigravityPermissionMode`）：请求批准 → `default`，自动批准 → `auto_edit`，完全访问 → `yolo`。建会话与恢复时设（mode 类 config option 用 `session/set_config_option`，只有 ACP `modes` 时用 `session/set_mode`）；运行体没有这个模式时告警、沿用当前的。
- **会话中换设置。** `configureSession` 记下模型与权限模式，下一个 `send` 之前交给运行体（适配器接口的约定：进行中的回合不受影响）。
- **不支持的。** 插话（ACP 没有）、支线会话（`session/fork` 没有用）、补说明、回滚（Antigravity 不能回退对话，T3 同样不支持）、会话标题生成（Host 用首条消息截断）。

## 6. 账号与登录（`accounts.ts`、`models.ts`）

状态是 `signIn: 'in_app'`、`loginMethods: ['browser']`，加安装字段（§2）。

- **不启动运行体的状态**（T3 的健康检查也不启动）：装没装看 `resolve`；**已登录 = 运行体找得到、profile 里的登录文件在、最近没有报过要登录**。会话或刷新报要登录（`-32000`、或运行体又要去浏览器登录）时改为未登录，`lastError` 写“登录过期或被撤销”，直到重新登录或刷新成功。没有邮箱与套餐。
- **用量**（2026-10-17，协议 0.45.0，`usage.ts`，照 T3 的 `makeAntigravityUsageProbe`）：已登录时读，每 5 分钟最多一次，在后台读完经 `onChange` 报（`account.get` 带 `refresh` 时等它读完）。只读登录文件里的 `client_id`、`client_secret`、`refresh_token` 与 `project_id`，向 `oauth2.googleapis.com/token` 换 access token（只在内存里，按文件内容缓存到过期前 1 分钟，不写回文件），再 POST Cloud Code 的 `v1internal:retrieveUserQuotaSummary`（先 `daily-cloudcode-pa`，失败换 `cloudcode-pa`，不跟随重定向，每个请求 10 s、整次 30 s）：每个没停用的桶一个窗口，用量是 1 减 `remainingFraction`，`window` 是 `5h` / `weekly` 时给长度，`gemini-` 开头的桶额度名（`scope`）是 Gemini、`3p-` 开头的是 Claude & GPT（两家共用一份），别的用组名。汇总没有窗口时退回 `fetchAvailableModels` 里按模型的 `quotaInfo`（没有长度）与 `weeklyQuotaInfo`，同一家族取用得最多的。两个都没给、换令牌失败、文件坏了时留着上一次的；登出、重新登录时清掉。没有真实账号验证过，接口形状取自 T3。
- **登录**（T3 的 `makeAntigravityAuth`）：起一个一次性的登录进程，`authenticate { methodId: 'oauth-personal' }`。运行体用 Python 的 webbrowser 打开 Google 的登录页；`BROWSER` 设成 `<Host 的 Node> -e <脚本> -- %s`，脚本不开浏览器，只把网址带标记写到 stderr（命令里不能有冒号或分号，启动前先试跑一次核对，钩子不对就不启动，免得运行体去开系统浏览器）。1.1.1 也可能把网址写在 stdout 的提示行上，同样认出。网址必须是 `https://accounts.google.com/o/oauth2/v2/auth`、`response_type=code`、单个 `state`、回调 `http://127.0.0.1:<≥1024>/`。`login` 最多等 40 s 拿到网址再返回（`signing_in`，带 `login.authUrl`，桌面端随即打开浏览器）；没等到就先返回，网址随后经 `account.updated` 送达。用户在浏览器里登录后 Google 回调本机 127.0.0.1，`authenticate` 完成，再开一个一次性会话确认账号能用并读模型列表（T3 的 verifying），然后关掉登录进程、删掉一次性会话的文件与临时目录，报 `signed_in`。5 分钟没完成算过期。拒绝授权、订阅不符等照 T3 的 `safeAuthFailure` 写成 `lastError`（引擎原文进日志）。
- **回调必须落在 Host 这台机器上。** 浏览器要在本机；T3 支持从别的设备把回调网址粘贴回来（`complete`），Wevir 的协议没有这个方法，没有移植。
- **取消与替换。** `cancelLogin` 停掉登录进程；新的 `login` 替换进行中的那次。
- **模型列表**只来自 ACP 会话的 `configOptions`（`model` 选项，分组摊平、去重，当前值是默认；没有时退回 ACP 的 `models`）：登录完成、显式刷新（`account.get` 带 `refresh`：启动运行体，`authenticate` 加一次性会话）与每次建会话、恢复时更新，存进 `models.json`，Host 重启后不必为了模型列表启动运行体。没登录过时是空列表。
- **登出**（T3 的 logout）：先停掉会话进程（挂着的会话以 `engine.exited`，`reason: config_changed` 脱开：旧进程里缓存着凭据），再起一个进程发 ACP `logout`（要 `agentCapabilities.auth.logout`）；运行体起不来时直接删掉 profile 里的登录文件，保证登出生效。模型列表一并清掉。

## 7. 与 T3 Code 的差异

| T3 | Wevir |
|---|---|
| 每个线程一个运行体进程 | 一个进程承载全部会话（§1） |
| 恢复用 `session/resume`（不用会回放全部工具调用的 `session/load`） | 相同。任务说明里写的是 `session/load`，照 T3 用 resume |
| 四种登录方式（个人、Enterprise、API Key、Vertex），API Key 明文存在设置里 | 只有个人 Google 账号 |
| 远程设备粘贴回调网址 | 没有（协议没有这个方法），浏览器要在 Host 这台机器上 |
| 声明 `fs` 能力，编辑经 T3 的文件接口与审批 | 不声明，工具在运行体自己的环境里执行，审批照 ACP 转交 |
| 读令牌查用量，另读 Google 账号 ID 跨环境合并账号 | 读令牌查用量（§6），不读账号 ID |
| 下载失败就从头来 | 断线后用 Range 接着下，卡住有超时，连不上时说明镜像与手填路径（§2） |
| 运行体的租约与删除 | 没有删除运行体的方法，也就没有租约 |
| T3 自己的 MCP 服务（Antigravity 不挂，`mcpServers` 恒为空） | 应用级工具（0.30.0，domain-model §3.15）：会话带 `SessionConfig.appTools` 时 `session/new` 与 `session/resume` 带一项 stdio 的 `wevir`（同 Grok 的桥，grok-event-mapping.md §7）；运行体对 MCP 的支持与审批没有用真实运行体核对 |
| 附件（图片、音频、PDF、文本）、子 agent 批次、文本生成、slash 命令与 skills 列表 | 只有图片（0.28.0）：照通用 ACP 适配器发 `image` 内容块（引擎描述 `images: true`，`initialize` 报 `promptCapabilities.image: true`）；T3 的 Antigravity 不发 GIF，Wevir 不拦，运行体不收时回合失败。其余没有 |

## 8. 验证

- **自动测试**（`pnpm vitest run --project adapter-antigravity`）：
  - `replay.test.ts`：T3 的 Antigravity 样本（`test-fixtures/acp-samples.ts`）经引擎描述与通用会话队列的回放：逐字增量的合成、命令工具、负载截断、模型列表、提问、展示类型、错误归类。
  - `installation.test.ts`：本机假下载服务器上的成功（含启动校验）、sha256 不对、断线后续传、服务器不支持 Range、卡住、取消、HTTP 错误、不安全的压缩包、自报的不是这个发布、连不上 dl.google.com 时的说明与镜像。
  - `accounts.test.ts`、`antigravity-adapter.test.ts`、`antigravity-adapter.contract.test.ts`：假运行体（`test-fixtures/fake-agent.mjs`，按 T3 的样本说 ACP）上的登录（BROWSER 钩子与 stdout 两种网址）、拒绝、取消、刷新、登出、交给运行体的环境、`account.install` 的进度与失败；没登录时建会话、权限模式、会话中换设置、提问、恢复、登出停进程；`AgentRuntimeAdapter` 契约（子会话与插话两组跳过）。
  - `profile.test.ts`：登录网址的校验、环境的清理、profile 的准备（BROWSER 钩子的核对、0700、skills 链接）、stdout / stderr 上的网址。
- **待维护者验证**（没有做，不要当作已验证）：
  1. 真实运行体的下载与校验：设置 → 模型服务 → Antigravity → 下载，看进度与完成（约 110 MB 下载、解开约 400 MB，macOS arm64）。在大陆网络下看失败时的说明。
  2. 真实登录：点登录，浏览器打开 Google 的页面，登录后设置里显示已登录、模型列表出现。确认 Wevir 没有打开第二个浏览器窗口（BROWSER 钩子生效）。
  3. 真实会话：发消息、跑命令（看审批卡片）、`interaction_*` 提问、取消、关掉 Host 再打开后继续同一会话（resume）、换权限模式。
  4. 1.3.0 的 `initialize` 协议版本与 `agentInfo.version` 的实际写法、`session/resume` 找不到会话时的原文、多个会话共用一个进程的表现、`mode` 选项的实际取值（`auto_edit` 是否存在）。
  5. 登出后再登录。
