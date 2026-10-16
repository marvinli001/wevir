# OpenCode → Wevir 事件映射

> 状态：v0.3（订阅来源 `opencode` 的引擎：检测与模型、本机服务器、会话、回合与流式事件、审批与提问、子 agent、取消、恢复；v0.2 加插话、会话标题、支线与补充说明；v0.3 加应用级工具）· 日期：2026-10-16
> 依据：[ADR-0005](../adr/0005-agent-runtime-and-model-gateway.md) 补记 14；[host-api.md](./host-api.md) §3.1 的 `account.*`；[领域模型](./domain-model.md) §3.6
> 代码：`packages/adapter-opencode/src/`（`sdk.ts`、`executable.ts`、`server.ts`、`runtime.ts`、`accounts.ts`、`models.ts`、`permissions.ts`、`message-id.ts`、`tool-display.ts`、`mapping.ts`、`opencode-adapter.ts`、`title.ts`、`side.ts`、`app-tools.ts`、`app-tools-plugin.ts`），登记在 `packages/host/src/engines.ts`
> 来源：移植自 T3 Code（[pingdotgg/t3code](https://github.com/pingdotgg/t3code)，MIT，提交 `ec1313c8f8333292506f05a355bb72d308a455d8`）的 `packages/provider-opencode`（1.x 那一套：`OpenCodeRuntime.ts`、`OpenCodeServerOwner.ts`、`OpenCodeServerLedger.ts`、`status.ts`、`versionProbe.ts`、`toolItems.ts`、`adapter.ts`、`textGeneration.ts`），逐文件的登记见 [UPSTREAM.md](../upstream/UPSTREAM.md) §4；应用级工具的插件改写自 Paseo（[getpaseo/paseo](https://github.com/getpaseo/paseo)，Apache-2.0，提交 `dc7bc8db124e837ba909ffd3b4b20e16adaebe24`）的 `packages/server/src/server/agent/providers/opencode/bridge-plugin.mjs`

本文件写 OpenCode 引擎怎样被 Wevir 驱动，以及 opencode 服务器的事件怎样变成 `AgentEvent`（`packages/runtime-adapter/src/events.ts`），Host 再照 domain-model.md §6 写成 `WevirEvent`。事件与接口的形状以锁定的 `@opencode-ai/sdk` 1.18.34 的 `dist/v2/gen/*.d.ts` 为准，行为以真实 `opencode` 1.18.34 录下的事件（`test-fixtures/events/*.jsonl`，§9）为准。

## 1. 引擎的形态

- **引擎是用户自己装的 `opencode`。** Wevir 不带 opencode、不替用户登录。适配器在本机起它的 HTTP 服务器（`opencode serve`，§3），经官方 SDK `@opencode-ai/sdk`（只由 `packages/adapter-opencode` 声明，AGENTS.md 规则 2；用 `v2` 入口，与 T3 相同）说话。SDK 只是 HTTP 客户端，钉 `1.18.34`，第一次用到时才 `import()`。
- **只支持 1.x。** `opencode-ai` 的 `latest` 是 1.19.0（2026-10-11）；OpenCode 2.x（`@opencode/cli` 与 `@opencode/client`）是另一套协议，T3 另有一份适配器。`opencode --version` 读出 2.x 时账号报“还不支持”（§2.1），以后要接再另做。
- **路由。** `engines.ts` 登记 `{ name: 'opencode', adapter: OpenCodeAdapter, kinds: ['opencode'] }`；`--adapter codex` 的 Host 是 Codex、Claude Agent、Cursor、OpenCode 的 `EngineRouter`。
- **一个 Wevir 会话 = 一个 opencode 会话**，引擎会话 ID 是 opencode 的 `ses_…`；一个回合是一次 `session.promptAsync`（带 Wevir 生成的用户消息 ID，`message-id.ts`）到这个会话回到 idle。图片（0.28.0）是 `file` 部件 `{ type: 'file', mime, filename?, url: 'file://…' }`，opencode 自己读 Host 存的文件（同 T3 Code 的 toOpenCodeFileParts）；模型目录标了不收图片（`capabilities.input.image`）的，Host 按 `supportsImages: false` 先拒绝。
- **一个 Host 一个服务器，按目录分客户端。** opencode 1.x 的服务器按请求头 `x-opencode-directory` 为每个目录开一个实例，一个进程服务所有目录（`opencode serve` 自己就是 `instance: false`）。适配器给每个工作目录一个 SDK 客户端，各订阅一条事件流（`/event`），事件按 `sessionID` 分给会话；task 工具派出的子会话也在同一条流里。T3 每个会话另起一个绑在目录上的服务器，Wevir 不这样做（§8）。
- **配置与数据复用用户自己的**（同 T3）：服务器读用户的 opencode 配置（`~/.config/opencode`、项目里的 `opencode.json`）、`opencode auth login` 存的凭据和它的会话库（`~/.local/share/opencode`），所以 Wevir 里的会话也出现在用户自己的 opencode 会话列表里，用户配的 Provider、模型、MCP、agent 照常生效。隔离数据目录就等于丢掉用户的登录，没有这样做。服务器的环境继承 Host 的（上游的 Key 环境变量照常生效），PATH 补上 `opencode` 所在的目录与常见的安装目录（`executable.ts`）。Wevir 自己只写 `<数据目录>/engines/opencode/`：账号检测用它当中立的工作目录，`servers/` 下是服务器台账（§3），`plugins/` 下是应用级工具的插件（§4.4）。加进去的配置只有一层权限（§4.2）与应用级工具的插件（§4.4）。
- **外连。** 适配器只连本机的服务器。服务器自己连用户接上的上游、models.dev 等，与用户直接用 opencode 相同。

## 2. 账号与模型（`executable.ts`、`runtime.ts`、`accounts.ts`、`models.ts`）

### 2.1 检测

`EngineAccounts.kinds` 只有 `opencode`，状态总带 `signIn: 'command'` 与 `loginCommand: 'opencode auth login'`。照 T3 的 `checkOpenCodeProviderStatus`：

1. 找 `opencode`：`account.setPath` 指定的路径（不存在就不再自动找，`installed: false` 带 “… does not exist”）→ `WEVIR_OPENCODE_BIN` → PATH → 常见位置（官方安装脚本的 `~/.opencode/bin`、Homebrew、npm、bun、volta、pnpm、mise；Windows 是 `%APPDATA%\npm`、scoop、winget）。找不到是 `installed: false` 带 `installCommand: 'npm install -g opencode-ai'`（opencode README 的写法之一，另有 `curl -fsSL https://opencode.ai/install | bash`，装在 `~/.opencode/bin`）。
2. `opencode --version`（10 s 时限）。跑不起来是 `installed: true` 带原因（macOS 隔离、签名损坏给出处理办法，T3 的 `formatOpenCodeProbeError`）；版本低于 1.14.19（T3 的 `MINIMUM_OPENCODE_VERSION`）或是 2.x 也是 `installed: true` 带原因、不往下走。
3. 借本机服务器（§3），在 `<数据目录>/engines/opencode` 这个目录上读 `provider.list`。`connected` 里有上游就是 `signed_in`：`planLabel` 是这些上游的名字，按 `connected` 的顺序用 “, ” 连起来（例如 “Anthropic, OpenAI”，界面有十种语言，不用中文顿号），`plan` 是它们的 ID；没有就是 `signed_out`（不带 `lastError`，界面给登录命令）。读失败是 `signed_out` 带原因。

结果缓存 5 分钟，`read` 带 `refresh` 时重新检测（用户在终端里登录之后桌面端点“重新检测”）。`login` / `logout` 报 `invalid_input`，提示在终端里做（`opencode auth login` / `opencode auth logout`）；没有 `install`。opencode 自己存的凭据 Wevir 不读（ADR-0005 补记 14）。

### 2.2 模型

`models` 来自最近一次的 `provider.list`（`accountModels`，T3 的 `flattenOpenCodeModels`）：

- 只列 `connected` 的上游，ID 是 opencode 的 `<上游>/<模型>`（例如 `anthropic/claude-sonnet-4-5`；模型 ID 本身可以带 `/`，只按第一个 `/` 拆）。
- `displayName` 是 “<上游的名字> · <模型的名字>”：一个 opencode 后面常接着好几家，目录还会重叠（T3 的 `subProviderLabelFor`）。按上游、再按模型名排。
- `contextWindow` / `maxTokens` 取 `limit.context` / `limit.output`，`supportsImages` 取 `capabilities.input.image`。
- 推理档位是模型的变体（`variants` 的键，opencode 的原值，例如 `low` / `high` / `max`），发消息时原样作 `variant`；模型不推理时是空数组。没有变体的推理模型也是空数组：T3 给它们补一组 `low…xhigh` 让界面一致，但 opencode 不认就忽略，Wevir 不补。
- 默认模型是第一个上游在 opencode 里的默认模型（`provider.list` 的 `default`），没有时取第一个。

Host 照补记 14 的规则在第一次读到已登录时建 `opencode` Provider，之后刷新模型。

## 3. 服务器进程（`server.ts`、`runtime.ts`）

照 T3 的 `startOpenCodeServerProcess` 与 `OpenCodeServerOwner`：

- **懒启动。** 第一次读账号或建会话时才起；构造适配器不起进程、不联网。Host 启动时后台读一遍每种订阅的账号（补记 14），装了 opencode 的机器上这一步会起一次服务器，30 秒后自己停。
- **只听本机、随机端口、随机密码。** `opencode serve --hostname=127.0.0.1 --port=<空闲端口>`；每次起都生成一个 32 字节的随机密码经 `OPENCODE_SERVER_PASSWORD` 交给它（HTTP Basic，用户名 `opencode`），SDK 的每个请求带上，只在内存里。T3 只在用户自己设了这个变量时带密码；没有密码的 opencode 服务器本机任何进程都能驱动（它启动时也这样警告）。stdout 打出 `opencode server listening on http://…` 即就绪（30 s 时限），再在 5 s 内读 `/global/health` 核对版本。
- **一直读完输出。** 就绪后照样读 stdout / stderr（不读管道会写满、opencode 会卡住），stderr 留最后 8 KiB 作退出时的诊断。
- **借用与空闲停止。** 会话挂着、正在读账号时借着服务器；都还回来 30 秒后停掉。服务器意外退出时，挂着的会话以 `engine.exited`（退出码、信号、stderr 尾部）脱开，下次建会话或恢复时重起。
- **整组停掉。** 服务器自成进程组（npm 装的 `opencode` 是个 Node 启动器，真正的服务器是它的子进程）；停的时候整组 SIGTERM，1 秒后 SIGKILL。Wevir 退出时（适配器 `dispose`）停掉。Windows 上不分离，`child.kill`。
- **Host 被强杀后的回收（台账，T3 的 `OpenCodeServerLedger`）。** 起服务器时把进程组 ID、一个组成员的 pid、启动时间（Linux 读 `/proc/<pid>/stat`，macOS 读 `ps -o lstart`）与命令行、端口、起它的 Host 进程的身份写进 `<数据目录>/engines/opencode/servers/<pgid>.json`（0600），优雅停止时删掉。下一个 Host 第一次起服务器前检查这些条目：主人还活着的不动；主人不在了，而且记下的成员 pid、启动时间、进程组与命令行都还对得上，才整组 SIGTERM（2 秒后还在就 SIGKILL），对不上（pid 被复用）的只删条目；跟着数据目录一起拷来的（目录对不上）只删。Windows 不记。

## 4. 权限（`permissions.ts`）

OpenCode 没有操作系统沙箱，会话的规则集（`session.create` / `session.update` 的 `permission`）就是边界。规则是 `{ permission, pattern, action: allow | ask | deny }`，最后一条命中的生效（opencode 的 `Permission.evaluate` 用 findLast）；`ask` 的经事件 `permission.asked` 问用户。

### 4.1 三种模式

| Wevir | 规则集 |
|---|---|
| `on_request` | `*` 问；`bash`、`edit`、`webfetch`、`websearch`、`codesearch`、`external_directory`、`doom_loop` 问；`read`、`glob`、`grep`、`list`、`lsp`、`todowrite`、`task`、`skill`、`question` 放行；读 `*.env`、`*.env.*` 问，`*.env.example` 放行（T3 的规则，多放行了只读的 `list`） |
| `auto_review` | 同 `on_request`：OpenCode 没有替用户审查的模型（T3：没有 AI 审查的引擎在 auto 下退回到询问） |
| `full_access` | 全部放行（`*` 与 `external_directory`） |

环境会话的额外目录（`SessionConfig.additionalRoots`，适配器声明了 `additionalRoots`）各加一条 `external_directory` `<目录>/*` 放行：进入这些目录不问，改文件照样按模式问。建会话时给规则集；`configureSession` 换模式时立刻 `session.update`（规则没变就不发）；恢复时按现在的配置重装。

### 4.2 子会话与服务器的权限配置

task 工具派出的子会话是 opencode 自己建的，它的规则只继承父会话的 `deny` 与 `external_directory`，再加上子 agent 自己的限制（`task` 不许再派等，opencode 的 `deriveSubagentSessionPermission`）。适配器在 `session.created`（`parentID` 是自己的会话）时就给它装上父会话的完整规则加子 agent 特有的那几条（T3 的 `openCodeChildPermissionRules`；T3 等到 task 工具报出子会话 ID 才装）。

装上之前有一段空档：opencode 在每一步开始时取会话规则，子会话的第一步往往在适配器的 `session.update` 到达之前就开始了，这一步按 agent 的默认权限走，而 opencode 的默认是全部放行。T3 的办法是在父会话的规则前面先写一串 `deny`（`*` 与上面那几种）让子会话继承；可是 opencode 把最后命中 `*` 规则是 `deny` 的工具整个从工具列表里拿掉（`session/llm.ts`），子会话第一步一个工具都看不到，在真实的 opencode 上子 agent 因此什么都不做就答完了（录事件时观察到）。Wevir 改为给自己起的服务器加一层配置：`OPENCODE_CONFIG_CONTENT` 里的 `permission` 把 `bash`、`edit`、`webfetch`、`websearch`、`codesearch` 设为 `ask`（`SERVER_PERMISSION_CONFIG`；`external_directory` 与 `doom_loop` 的默认本来就是 ask）。opencode 的 agent 权限是“默认 → agent 自己的 → 配置里的”依次合并，所以这层对所有 agent 生效：子会话第一步照样有工具，越界的照样问；会话规则排在它之后，顶层会话不受影响。用户自己设了 `OPENCODE_CONFIG_CONTENT` 的照留，只把这几项并进它的 `permission`（T3：不能盖掉用户的配置）。

代价：`full_access` 会话的子 agent 在第一步里跑命令也会问一次；用户在 opencode 配置里给全局 `permission` 设的这几项在 Wevir 起的服务器上被这层盖过（顶层会话本来就按 Wevir 的规则集走）。MCP 工具在空档里按 opencode 的默认放行。

### 4.3 审批选项与回复

审批选项照 adapter-codex 的四个，回复是 `permission.reply`（T3 的 `toOpenCodePermissionReply`）：

| 选项 | `reply` | opencode 的行为（`permission/index.ts`） |
|---|---|---|
| `accept`（允许） | `once` | 只放行这一次 |
| `acceptForSession`（允许，本会话不再询问） | `always` | 把请求带的 `always` 模式（例如 `echo *`）记进这个目录实例的已批准列表，同一会话里匹配的未决请求一并放行；只在内存里，服务器停了就没了，不写用户的配置 |
| `decline`（拒绝并继续） | `reject` 带 `message` | 记成 CorrectedError：工具失败，反馈交给模型，回合接着做 |
| `cancel`（拒绝并停止） | `reject` | 记成 RejectedError：停下这个会话的循环（opencode 的 `continue_loop_on_deny` 关着时），同一会话里别的未决请求一并拒绝；回合以 opencode 的 idle 正常结束 |

### 4.4 应用级工具（0.30.0，`app-tools.ts`、`app-tools-plugin.ts`）

Wevir 的 `wevir` 工具（domain-model §3.15）在别的引擎上是每个会话一个令牌的 MCP 服务。opencode 1.x 的 MCP 服务按服务器与目录登记（`mcp.add`），一个服务器服务所有会话，没法给每个会话自己的令牌。照 Paseo 的 OpenCode 桥（`bridge-plugin.mjs`），改用 opencode 插件：

- **引擎令牌。** `OpenCodeAdapter` 声明 `appTools` 并实现 `bindEngineAppTools`：Host 在 `/mcp` 监听之后给它一个只认 `opencode` 种类的会话的引擎令牌（host-api.md §1）。`SessionConfig.appTools` 里按会话的令牌用不上。
- **插件。** 起服务器时（runtime.ts），有令牌就把插件写进 `<数据目录>/engines/opencode/plugins/wevir-app-tools-<内容摘要>.mjs`（0600，内容不变不重写，里面没有令牌），经 `OPENCODE_CONFIG_CONTENT` 的 `plugin` 登记为 `[file://…, { url, token, noApproval }]`（permissions.ts 的 `serverConfigContent`；用户自己的插件照留，以前的 Wevir 插件去掉）。插件只有一个默认导出的函数（opencode 把模块导出的每个函数都当成插件）。
- **工具。** 插件启动时用引擎令牌 `tools/list`（不带会话），每个工具注册成同名的插件工具（`wevir_session_list` 等）。opencode 的插件工具参数要是 zod 的 shape（1.14.49 起也收 JSON Schema，但会把每个参数都当成必填），所以把 Host 给的 JSON Schema 转成 zod（Paseo 的 `jsonSchemaToZod`）；zod 是适配器自己声明的那份，按绝对的 `file:` 地址 import（插件在数据目录里，按包名解析不到）。和 opencode 自带的 zod 不是同一份，opencode 照常转出 JSON Schema 给模型（真实 1.18.34 上核对过）。列不出工具时（Host 不在）插件不挂工具，不让加载失败。
- **调用。** `execute(args, context)` 用 `context.sessionID` 作请求头 `x-wevir-engine-session` 调 `tools/call`，带上 opencode 的中止信号；Host 把它映射回 Wevir 会话（子 agent 的子会话有自己的记录），之后套用这个会话的工具与边界。结果的文本是工具输出；`isError` 时抛错，opencode 记成工具失败、原因交给模型；Host 认不出会话（404）时也抛错。
- **审批。** opencode 把插件工具的权限交给插件自己。只读的工具与 `wevir_show`（`APP_TOOLS_NO_APPROVAL`）直接调；其余先 `context.ask({ permission: <工具名>, patterns: ['*'], always: ['*'], metadata: <参数> })`，由会话的规则集决定：`on_request` / `auto_review` 的 `*` 是 ask，经 `permission.asked` 成为 Wevir 的审批（§5.5；“本会话不再询问”记住这个工具），`full_access` 放行。拒绝时 `ask` 抛错，不调 Host。生成标题的临时会话全部 deny，看不到这些工具。
- **工具名。** opencode 里叫 `wevir_session_create`，报给 Host 时照别的引擎的 MCP 工具写成 `mcp__wevir__wevir_session_create`（`engineToolName`，domain-model §7），桌面端据此给三个要审批的工具说清楚做什么。
- **服务器的时机。** Host 启动时为读账号起的服务器可能在 `/mcp` 监听之前，没有插件：绑定之后这个服务器没人借用就停掉（借着的还完再停），下次用到时带插件重起。
- **暴露面。** 令牌在 opencode 服务器的环境里（插件选项），这个服务器里跑的命令读得到，与它的 `OPENCODE_SERVER_PASSWORD` 一样；能冒充的只有这个服务器上的 OpenCode 会话，别的引擎的会话不认。

## 5. 事件 → AgentEvent（`mapping.ts`、`tool-display.ts`、`opencode-adapter.ts`）

下面的事件都来自 `/event`（1.x 的事件流）。录下的真实事件顺序见 `test-fixtures/events/`。

### 5.1 回合的开始与结束

- `send`：生成 `msg_…` 用户消息 ID（opencode 的格式：12 位十六进制的时间与计数 + 28 位 base62，T3 的 `makeOpenCodeMessageId`），`promptAsync({ sessionID, messageID, model: { providerID, modelID }, variant?, parts: [{ type: 'text', text }] })`，204 即返回。返回之前收到的这个回合的事件先存着，返回后再交出（引擎接受输入之后才报这个回合的事件）。模型 ID 不是 `<上游>/<模型>` 报 `invalid_input`。不传 `agent`（opencode 默认的 build）与 `system`。
- **结束看 idle，但只认这个回合的。** opencode 每个回合先报 `session.status` busy（之后每一步都再报），结束时报 `session.status` idle（有时再跟一条旧式的 `session.idle`）。顶层回合在见到这个会话的 busy（或回答这条用户消息、`parentID` 是它的 assistant 消息）之后，idle 才结束它：`turn.settled`（`completed`，`stopReason` 是最后一条 assistant 消息的 `finish`，如 `stop` / `tool-calls`）。之前的 idle 是上一个回合留下的，不管。接受输入 5 秒后还没见到 busy，就问一次 `session.status`：busy 当作已开始，idle 按完成结算（T3 的 `reconcileOpenCodePromptAdmissionStatus`）。T3 用 admission 状态机（`promptAsync` 返回、用户消息出现、中间见过 idle 就去问 status）；它在“旧 idle 赶上 opencode 的循环还没开始”时会读到 idle、提前结束回合，Wevir 改为以 busy 为准。
- `session.error`（带 `sessionID`）：`MessageAbortedError` 或正在取消时是 `turn.settled`（`cancelled`）；其他是 `turn.failed`（§7）。之后的 idle 不再管。
- 结算时先提交没提交的文字（§5.2），未决的审批与提问以 `approval.cancelled` / `question.cancelled` 结束（取消时 `turn_cancelled`，否则 `turn_ended`）。

### 5.2 文字与思考

opencode 每一步（一次模型调用）新开一条 assistant 消息，它就是一个 `attemptId`；其中的 text / reasoning part 各是一个增量块（`blockIndex` 按出现的顺序）。

| opencode | AgentEvent |
|---|---|
| `message.part.updated`（text / reasoning，先来一条空文本的登记块） | 快照比已发的长时补出差的那一段作 `assistant.delta`（旧版本只发快照） |
| `message.part.delta`（`field: 'text'`） | `assistant.delta`（`kind` 是块的类型） |
| part 带上 `time.end` | `assistant.message` / `assistant.thought`（`messageId` 是 part ID，`replaces` 是这个块；没发过增量时为空） |
| `message.updated`（assistant，`time.completed`） | 提交这条消息里还没提交的块，再 `assistant.stream_ended`（`committed`）；用量见 §5.8 |
| 回合结束时还没提交的块（取消时 opencode 不再发 part 的最终快照） | 按已发的增量提交，结束流 |

`synthetic` / `ignored` 的 text part 不报；用户消息的 part 不报（子会话的除外，§5.7）。

### 5.3 工具

按 tool part 的 `callID`（与 `permission.asked` 的 `tool.callID` 相同）：

| tool part 的状态 | AgentEvent |
|---|---|
| `pending` 且没有输入 | 先不报（opencode 接着发带输入的 `running`） |
| 第一次有输入（`running`，或带输入的 `pending`） | `tool.started`（`toolName` 是 opencode 的工具名，`display` 见下，`input` 原样） |
| 输入变了 | `tool.updated`（`display`、`input`） |
| `running` 的 `metadata.output` 变了（bash 的实时输出） | `tool.updated`（`output` 是到目前为止的全文） |
| `completed` / `error` | `tool.finished`（`completed` 带 `output`；`failed` 带 `error` 的原文） |

展示类型（`tool-display.ts`，T3 的 `openCodeToolProjectionKind`）：`bash` → shell（命令）；`read` / `list` → read；`write` → write；`edit` / `apply_patch` → edit（apply_patch 从补丁的 `*** Add|Update|Delete File:` 行取路径）；`glob` / `grep` / `websearch` / `codesearch` / `lsp` → search；`webfetch` → fetch；`todowrite` → plan；`task` → sub_agent（摘要是描述）；其余（MCP 工具是 `<server>_<tool>`）→ unknown 带输入的摘要。`question` 工具不报：提问由 `question.asked` 报（§5.6），再报一遍工具会在界面上重复（T3 同）。

### 5.4 清单

todowrite 工具的输入 `todos` 报成 `todo.updated`（紧跟它的 `tool.started`，状态原样：pending、in_progress、completed、cancelled）。opencode 另发的 `todo.updated` 事件不用（它不带工具调用 ID，`TodoUpdatedEvent` 要）。

### 5.5 审批

`permission.asked { id, sessionID, permission, patterns, metadata, always, tool? }`：

- 有 `tool`：tool part 可能还是 pending（真实录音里 bash 的审批就在 running 之前），没报过 `tool.started` 时先报，输入用请求的 `metadata`（bash 是 `{ command }`），之后 tool part 的输入到了再 `tool.updated`。
- 没有 `tool`（死循环检测等）：合成一个工具调用（`permission:<请求 ID>`，工具名是 `permission`，输入是 `metadata` 加 `patterns`），回复后报它的 `tool.finished`。
- 报 `approval.requested`（`requestId` 是 opencode 的 `per_…`，选项 §4.3），等 `respondToApproval`。
- `permission.replied` 到了而不是经 `respondToApproval` 回的（拒绝时 opencode 把同一会话的其他请求一并拒掉，或者在别的客户端里回了）：`approval.cancelled`（`turn_ended`）。
- 没有回合时到的请求没人能回答：直接拒掉，不让 opencode 的会话一直等。

### 5.6 提问

`question.asked { id, sessionID, questions }` → `question.requested`：每个问题的 ID 是 `question-<序号>-<标题的 slug>`（T3 的 `openCodeQuestionId`），`header`、`question`、选项（`label`、`description`），`multiple` → `multiSelect`，`custom` 默认允许自己填（`allowOther`）。`respondToQuestion` 按问题的顺序交回 `question.reply`（没答的是空数组，T3 的 `toOpenCodeQuestionAnswers`）。`question.replied` / `question.rejected` 不是经 `respondToQuestion` 回的：`question.cancelled`（`turn_ended`）。

### 5.7 子 agent

- `session.created` 带的 `parentID` 是挂着的会话：登记成子会话（它的流在第一个订阅者之前缓冲），装上规则（§4.2）。
- 父会话的 task tool part 的 `metadata.sessionId` 报出了子会话：在父会话的流里，紧跟这个工具的 `tool.started` 之后报 `subagent.started`（`parentToolCallId` 是 task 的 `callID`，`title` 是描述，`prompt` 是任务原文，`modelId` 取 `metadata.model` 拼成 `<上游>/<模型>`，`role` 是 `subagent_type`）。task 工具本身照常是工具事件，完成时的输出是 opencode 的 `<task …>` 结果。
- 子会话的回合从 task 发来的用户消息开始：`turn.started`（`input` 是那条消息），之后同 §5.2–§5.6，idle 时 `turn.settled`。子会话的审批与提问在子会话自己的流里报，用子会话的 ID 回复（Host 交给父会话的界面）。T3 把它们挂到顶层会话上。
- 子会话不接受 `send` 与 `configureSession`（`invalid_input`），`cancel` 中断它自己的回合，父会话关闭时一并脱开。

### 5.8 用量

assistant 消息完成时报 `usage.updated`：`contextUsed` 是这次的 `input + cache.read + cache.write + output`（下一次请求要带上的），`contextSize` 是模型的 `limit.context`（来自 `provider.list`，不知道时不报），`totalTokens` 是这个会话累计的（每条 assistant 消息的 `tokens.total`）。

### 5.9 不映射的事件

`session.updated` / `session.deleted` / `session.diff` / `session.compacted`、`message.removed` / `message.part.removed`、opencode 的 `todo.updated`、`file.*`、`lsp.*`、`vcs.*`、`command.executed`、`mcp.tools.changed`、`project.updated`，以及 step-start / step-finish / snapshot / patch / agent / retry / compaction / file / subtask 这些 part 不映射也不保留。其余带 `sessionID` 的事件保留为 `engine.raw`（`protocol: 'opencode-sdk'`，`kind` 是事件类型）。`server.connected` 第二次出现说明事件流重连过（SDK 最多重连 3 次），记告警：中间的事件可能丢了。

### 5.10 插话（R11，`steer`）

T3 的 `steerTurn`：回合进行中再发一次 `promptAsync`（新的 `msg_…` 消息 ID，模型与变体同会话），opencode 收下即返回 204。真实 opencode 1.18.34 上（录音 `steer`）：插话的用户消息马上存下（`message.updated`，role user），正在跑的循环在这一步结束后重读消息，看到最新的用户消息比最后一条 assistant 消息新，就接着跑一步，中间没有 idle；那一步的 assistant 消息的 `parentID` 是插话的消息 ID，模型看到的请求里插话是一条普通的用户消息（不加包装）。

- **`turn.steered`** 在 `parentID` 是某条插话的 assistant 消息第一次出现时报，排在这一步的输出之前、终结事件之前。几条插话在同一步之前交出时 opencode 只回答最后一条，之前的一并报。
- **`steer_rejected`**：没有进行中的回合、回合正在取消，或 `promptAsync` 失败（Host 改为排队）。子会话 `invalid_input`。
- **交接期间的 idle**（T3 的 admission 状态机里 `idleDuringAdmission` 那一段）：opencode 的运行器（`SessionRunState.ensureRunning`）在会话忙时只把新的 prompt 并进正在跑的那次运行，不再排一次；插话若在循环最后一次读消息之后、运行结束之前存下，它不会被回答，接着就是 idle。所以插话的 `promptAsync` 还没返回、或它的用户消息还没出现时到的 idle 先压着；之后见到 busy（opencode 接着跑了，或者运行已结束、为插话另起了一次）就作废；`promptAsync` 返回后再等 250 毫秒还没见到 busy，就问 `session.status`：busy 接着等，idle 按完成结算。取消中的回合不压。
- **没用上的插话**：回合结算时已交给 opencode、却没有回答它的 assistant 消息的插话，在下一次 `send`（或分支）之前用 `session.deleteMessage` 从 opencode 的历史里删掉，失败只告警。Host 把它们改为排队（回合完成时随后发出，取消时暂停），删掉才不会让模型看到两遍。T3 不删。回合结算之后 `promptAsync` 才返回的插话（取消途中），没有新回合时先 `session.abort` 停下 opencode 可能为它另起的运行，再同样删掉。
- 取消时没返回的插话请求一并中止；回合被中断时不报 `turn.steered`。

### 5.11 会话标题（`generateTitle`，`title.ts`）

T3 的 `textGeneration.ts`：在会话的工作目录里建一个临时 opencode 会话（标题写成 `Wevir title`，opencode 就不再为它另生成标题），同步 `session.prompt` 一次，用会话的模型、这个模型最低的一档变体（`none`、`off`、`minimal`、`low`… 认不出时不给，用 opencode 的默认），Host 给的说明作 `system`（接在 opencode 自己的系统提示之后，opencode 没有不带 agent 提示的请求），Host 给的输入作唯一的文本 part，`format: { type: 'json_schema', schema: outputSchema }`。用完 `session.delete` 删掉临时会话（T3 不删，会留在用户的 opencode 会话列表里）。

- `format: json_schema` 时 opencode 给这一步加一个 `StructuredOutput` 工具、`tool_choice: required`，并在系统提示末尾要求模型调用它；模型调用后 opencode 把参数存进 assistant 消息的 `structured` 并结束循环。适配器交出 `JSON.stringify(structured)`，解析与整理在 Host。
- 临时会话的规则除了全部 `deny`（同 T3）还要放行 `StructuredOutput`：opencode 按规则过滤工具时不区分它，全部 deny 时模型收到的工具是空的，答完就是 `StructuredOutputError`（真实 opencode 上试过）。
- 模型没调用工具而是写了文本（`StructuredOutputError`）时交出文本，Host 照样试着解析；其他错误（assistant 消息的 `error`、请求失败、空输出）报 `engine_unavailable`，带原文。Host 中止（`signal`）时中止请求、`session.abort` 临时会话，照样删掉。
- 临时会话的事件也在这个目录的事件流里，它没有登记，适配器不管。

### 5.12 支线与补充说明（`fork`、`injectNote`，`side.ts`）

- **`fork`**（0.17.0，/btw）：`session.fork({ sessionID, messageID? })` 分出一个新会话，带着 `messageID` 之前（不含）的消息。回合进行中时 `messageID` 是这个回合的用户消息，只分到之前完成的回合（T3 的 `openCodeBoundaryAfterProviderTurn` 同样以下一条用户消息为界，fork 的边界不含它）；空闲时不给，带全部（先删掉没用上的插话，§5.10）。opencode 不复制规则，所以接着 `session.update` 装上支线配置的规则（同 T3 回滚时对 fork 出来的会话做的），再用 `noReply: true` 的同步 `prompt` 补一条边界消息（`SIDE_BOUNDARY_NOTE`，与 adapter-codex、adapter-claude 同样的措辞）：之前的历史只作参考，只答这之后的问题，不改文件、不派子 agent，除非用户在支线里明确要求。分出的是普通的 opencode 会话（标题 `<原标题> (fork #1)`，没有 `parentID`），持久化，可以恢复，也会出现在用户的 opencode 会话列表里（Codex 的支线是临时 thread）。没有完成的回合（新会话还没结算过回合）时报 `invalid_input`；恢复来的会话算有历史。子会话不能分。
- **`injectNote`**（0.16.0）：`noReply: true` 的同步 `prompt` 只把说明存成一条用户消息，不开回合（真实 opencode 上只有 `message.updated` 与 part，没有 busy / idle）。回合进行中不能这样写：正在跑的循环这一步之后会看到它比最后一条 assistant 消息新，接着回答它（同插话）。所以回合中补来的先留着，下一次 `send` 之前按顺序写进去；会话关掉时没写的就丢了（同 adapter-claude）。

## 6. 取消、关闭、恢复与退出

- **`cancel`**：标记取消，中止还没返回的 `promptAsync`，`session.abort`，再沿 `session.children` 把子孙会话一个个 abort（顶层的 abort 停不下子会话，T3 的 `abortDescendants`，最多 15 秒）。opencode 报 `session.error`（`MessageAbortedError`）与 idle 时以 `turn.settled`（`cancelled`）结算。回合没停下之前每秒再发一次 abort（abort 赶在 opencode 的循环开始之前到达时是空操作）；10 秒还没停就自己按取消结算、记告警。未决审批以 `approval.cancelled`（`turn_cancelled`）结束。
- **`close`**：有回合时先取消，然后脱开（子会话一并），这个目录没有会话了就停掉它的事件流。opencode 的会话不删，可以恢复。
- **`resumeSession`**：`session.get` 找到就按现在的配置 `session.update` 规则、重新挂上（新的事件流订阅，不回放历史，opencode 记得之前的对话）；404 或 ID 不是 `ses_…`（opencode 回 400）报 `session_lost`（`not_found`）。服务器不在时重起。
- **服务器退出 / 事件流断开**：挂着的会话（含子会话）以 `engine.exited` 脱开，进行中的回合在它之前提交已有的文字、结掉未决的审批（`engine_exited`），下次用到时重起服务器、恢复会话。
- **`dispose`**：结束全部回合与订阅（未决审批 `disposed`），停掉事件流与服务器，不发 `engine.exited`。

## 7. 错误归类

| 来源 | 结果 |
|---|---|
| `session.error` 的 `ProviderAuthError`，或 `APIError` 带 401 / 403 | `turn.failed`（`missing_credentials`） |
| `APIError`（其他状态码）、`ContextOverflowError`、`ContentFilterError`、`MessageOutputLengthError`、`StructuredOutputError` | `turn.failed`（`provider`；`code` 是 HTTP 状态码，`message` 是 `data.message` 原文） |
| `UnknownError`、没有错误内容 | `turn.failed`（`unknown`） |
| `MessageAbortedError` | `turn.settled`（`cancelled`，`stopReason: 'aborted'`；用户在别的客户端里停的也是这样） |
| 没装、版本不能用（建会话、恢复时） | `engine_unavailable` |
| 没接上游 | `missing_credentials`，提示 `opencode auth login` |
| SDK 请求失败、服务器起不来 | `engine_unavailable`，原文保留 |

## 8. 与 T3 Code 的差异

- Effect 改写成普通 TS，没有引入 `effect`；SDK 动态 import。
- 一个 Host 一个服务器、按目录分客户端（T3 每个会话一个服务器，账号检测另用一个共享的）；服务器总带随机密码；台账记在 Wevir 的数据目录。
- 不支持 OpenCode 2.x、不支持连外部服务器的网址与密码（T3 的设置里有 `serverUrl` / `serverPassword`）。
- 不搬：回滚、按指定回合分支（T3 的 `forkThread` 带 `providerTurnId`）、`/compact` 与 slash 命令、skills、附件、agent 选择（build / plan）、T3 自己的 MCP 服务、OpenCode Go 的用量。
- 应用级工具（§4.4）照 Paseo 用插件挂，不照 T3（T3 给每个会话一个绑在目录上的服务器，MCP 服务能按会话登记）。与 Paseo 的差异：工具定义与调用走 Host 的 `/mcp`（JSON-RPC）而不是另开一个桥；只读的工具不问；没有 `shell.env` 与按父会话找上下文；`isError` 时抛错。
- 插话（§5.10）：T3 的 `steerTurn` 与 admission 状态机里交接期间压着 idle 的那一段；变体同会话（T3 的插话不带变体）；没用上的插话从 opencode 的历史里删掉（T3 留着）；插话以回答它的 assistant 消息报 `turn.steered`（T3 的编排节点没有对应的事件）。
- 标题（§5.11）：说明经 `system`、输出经 `format: json_schema` 约束、取 `structured`，临时会话放行 `StructuredOutput`（T3 把说明与输入拼成一段文本、自己解析 JSON）；变体取最低的一档（T3 用选的那一档）；用完删掉临时会话。只做会话标题（T3 还生成提交信息、PR、分支名与审阅指南）。
- 支线（§5.12）：T3 的 `forkThread` 只在空闲时分；Wevir 回合进行中也能分（到之前完成的回合），并补一条边界消息；补充说明用 `noReply`（T3 没有）。
- 权限：去掉给子会话继承的 deny 前缀，改由服务器的权限配置兜住子会话的第一步（§4.2）；子会话的规则在 `session.created` 时就装；放行 `list`；审批选项照 Codex 的四个，“拒绝并继续”带反馈。
- 回合以见到 busy 为开始（§5.1），不用 T3 的 admission 状态机；取消在回合停下之前每秒重发 abort。
- 子 agent 照 Wevir 的子会话报，子会话的审批与提问在子会话的流里（T3 挂到顶层会话上）；清单取 todowrite 的输入（T3 用 `todo.updated` 事件）；bash 的实时输出作工具的增量输出。

## 9. 验证

自动化（`pnpm vitest run --project adapter-opencode`，不需要 opencode，不联网）：

- `mapping.test.ts`：把真实 opencode 1.18.34 录下的事件（`test-fixtures/events/*.jsonl`：一问一答、推理、工具、审批的允许 / 拒绝并继续 / 拒绝并停止、清单、提问、子 agent、子 agent 的审批、慢回合中途取消、慢回合中途插话、模型报错）逐条喂给 `OpenCodeTurnMapper` 核对 §5.2–§5.4、§5.8，插话的录音另核对 §5.10 的 `parentID`。
- `opencode-adapter.contract.test.ts`：runtime-adapter 的契约套件跑在假的 opencode 上（`test-fixtures/fake-opencode.ts` 按提示词回放同一批录音，审批按回复切换分支，ID 按出现顺序对齐；回放进行中的 `promptAsync` 是插话，在慢回合的 action 行上换到录音 `steer`，录下的插话消息 ID 换成适配器发来的），能力全开（含插话）。
- `opencode-adapter.test.ts`：规则集与权限模式、消息 ID 与模型拆分、提问、审批的三种回复、子会话（`subagent.started`、子会话的回合、装上的规则、子会话的审批）、模型报错、接受输入之前的旧 idle、服务器崩溃后脱开与重起、恢复时重装规则与 `session_lost`、空闲停服务器、没接上游；插话交接期间的 idle（opencode 另起循环时报 `turn.steered`、并进结束的运行时问过 status 再结算）、没用上的插话在下一次发送前删掉、取消中不收插话、子会话不能插话；标题（临时会话的规则、system、json_schema、最低变体、删掉临时会话、文本退路、错误、中止）；支线（没有完成的回合时报错、边界、规则、边界消息、回合进行中的边界）；补充说明（空闲时立刻写、回合中留到下一次发送之前）。
- `accounts.test.ts`：已登录与套餐、模型、没接上游、没装、2.x 与太旧、跑不起来、缓存与 `refresh`、指定路径、登录登出报错、读完还回服务器。
- `server.test.ts`：用一个假的 `opencode`（Node 脚本）核对就绪、随机密码与并进的权限配置、整组停掉（孙进程也退出）、启动前退出、超时、核对版本失败、台账清理主人不在的服务器而不动 pid 被复用的进程。
- `app-tools.test.ts`：插件文件（摘要命名、不重写、zod 的绝对地址、只有默认导出）、配置里的那一项与 `OPENCODE_CONFIG_CONTENT` 的合并；在 Node 里加载生成的插件对着记请求的假端点：列工具与参数的 zod shape（必填与可选、枚举、整数、可空）、只读的不问、要审批的先 `ask` 且拒绝时不调、请求头里的引擎令牌与会话 ID、`isError` 与 404 抛错、Host 不在时不挂工具；适配器声明 `appTools`、绑定后起的服务器带插件、绑定前起的那个空闲时换掉、给不出令牌时照常起；工具名。Host 侧的映射与拒绝（令牌不对、不认识的会话、别的引擎的会话、不带会话不能调用）在 host 的 `app-tools.test.ts`，路由只转给实现了的引擎、种类只限它自己的在 `engine-router.test.ts`。
- `units.test.ts`：找可执行文件、版本、规则集按 findLast 的求值、服务器配置的合并、审批回复、模型 ID、工具展示、消息 ID、`ps` 与就绪行的解析、提问与错误归类。
- Host 的 `cli.test.ts`：`--adapter codex` 的路由里有 OpenCode，构造时不起进程。

真实 opencode + 本机假模型（不用订阅、不联网；2026-10-15 在 macOS 上用 `opencode-darwin-arm64` 1.18.34 跑过，28 条全部通过，含插话；2026-10-16 加上应用级工具后 29 条全部通过）：

```bash
WEVIR_TEST_OPENCODE=1 WEVIR_TEST_OPENCODE_BIN="$(which opencode)" pnpm vitest run --project adapter-opencode contract.real
```

它起真实的 `opencode serve`，数据、配置、缓存都在临时目录里（`isolatedOpenCodeEnv`，不碰用户的登录与会话），模型是 `test-fixtures/mock-model.ts` 的 OpenAI 兼容假服务（`OPENCODE_CONFIG_CONTENT` 里的 `mock` Provider），跑完整的契约套件（含审批、子 agent 的审批、取消、插话、恢复、杀掉服务器进程后的 `engine.exited`、dispose 后进程退出），另有标题（假模型调用 StructuredOutput，请求里只有这个工具、`tool_choice: required`、说明在系统提示里）、支线（支线的请求里有主线到之前完成的回合的历史、边界消息在它们之后，主线的请求里没有支线的内容）、补充说明（不开回合，下一次请求里有它，回合中补的排在回合之后）、插话之后取消（下一次请求里没有那条插话）、应用级工具（对着一个记请求的假 Host 端点：插件列出工具，模型看到的参数照 JSON Schema；只读的不问，调用带着这个会话的 opencode 会话 ID，结果交到模型；要审批的在 `on_request` 下成为审批、拒绝了不调、允许了才调，工具名是 `mcp__wevir__…`；完全访问的不问）。2026-10-16 另用一个临时测试跑过整条链路：真实 Host（只有 OpenCode 的路由）+ 真实 opencode 1.18.34 + 假模型，模型调 `wevir_session_list`，插件带引擎令牌打到 Host 的 `/mcp`，Host 把 opencode 会话映射回发消息的那个 Wevir 会话（列表里只有它是 `isYou`）。重录事件（`-t steer` 只录一个场景）：

```bash
WEVIR_RECORD_OPENCODE=1 WEVIR_TEST_OPENCODE_BIN="$(which opencode)" pnpm vitest run --project adapter-opencode record-events
```

**待维护者验证**（需要装好 opencode 并接上一个订阅，自动化做不了）：

1. 装 opencode（`npm install -g opencode-ai` 或 `curl -fsSL https://opencode.ai/install | bash`），在终端里 `opencode auth login` 接上一个上游（例如 Anthropic 或 OpenCode Zen），`opencode models` 能列出模型。
2. `pnpm dev` 打开桌面端，设置 → 模型服务 → 订阅 → OpenCode：显示已安装、版本、路径，套餐是接上的上游名字；没接上游时显示登录命令，在终端里登录后点“重新检测”变成已登录。
3. 模型选择里出现 OpenCode 一组，模型名是 “上游 · 模型”，带推理档位的模型能选档位。选一个模型建会话，发一条要读文件、跑命令、改文件的消息：消息流里有思考、回答与工具调用，命令与改文件弹出审批；分别试允许、本会话不再询问、拒绝并继续、拒绝并停止。
4. 让它用 task 派一个子 agent 跑命令：子智能体出现在会话里，它的命令审批能回答，父回合等它结束再回答。
5. 回合进行中点停止：回合以停止结束，之后能接着发；`ps` 里只有一个 `opencode serve`（`--hostname=127.0.0.1`）。
6. 把权限模式换成完全访问再发一条：命令不再问。
7. 退出桌面端：`opencode serve` 进程随之退出。重新打开后回到这个会话接着发：会话恢复，opencode 记得之前的对话；用户自己的 `opencode` TUI 的会话列表里也能看到这个会话。
8. 用 `kill -9` 杀掉 Host 进程（模拟崩溃）后再打开桌面端：上一个 Host 留下的 `opencode serve` 在第一次用到 OpenCode 时被停掉。
9. 新会话的第一个回合开始后，会话列表里的标题换成模型起的（不再是首条消息的截断）；用户自己的 opencode 会话列表里没有留下 `Wevir title` 的临时会话。
10. 回合进行中再发一条（插话）：它进了同一个回合，模型接着回答它；在插话之后马上停止，再发下一条时模型不会看到两遍。
11. 在有过回合的会话里用 /btw 提一个支线问题：支线知道主线之前的对话，回答后主线照常继续，主线里看不到支线的内容。
12. 应用级工具：让 OpenCode 会话列出 Wevir 的会话（不弹审批，列表里它自己是 `isYou`），再让它新开一个会话做件小事：弹出“新开会话”的审批，允许后左栏出现新会话、带“来自”那一行，做完后回报回到原会话；换成完全访问再试一次不弹审批。
