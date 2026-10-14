# Codex 运行时任务 Prompt（R1–R10）

> 建立日期：2026-10-14 · 依据：[ADR-0005](adr/0005-agent-runtime-and-model-gateway.md)（Accepted）、[Codex 研读与 Spike](research/codex-notes.md)
> 用法：每个任务开一个新会话，先粘贴下面的「通用前缀」，再粘贴任务 prompt。顺序与依赖见任务表；做完一项，在任务表里把它改成 [x]，备注写提交号。
> 维护者 2026-10-14 给出的实现顺序是 8 项，这里把其中两项各拆成两个任务（adapter-codex 拆成 R2、R3；通用 ACP 适配器与接 Grok / Gemini 拆成 R7、R8），保证一个会话做得完、一次提交只做一件事。同日维护者又定了两件事，各加一个任务：回合进行中可以插话或排队（R11），整体界面混合 Codex 与 Claude Code 桌面端、窗格可调尺寸并随数量动态布局（R12）。

## 任务表

| ID | 任务 | 依赖 | 可并行 | 状态 |
|---|---|---|---|---|
| R1 | 模型协议网关 `packages/model-gateway`：Responses 透传 + Chat Completions 转换 | — | 与 R7 并行 | [x] `06e2894` |
| R2 | `packages/adapter-codex`（上）：进程、配置、会话、回合与流式事件，Host 接 `--adapter codex` | R1 | 与 R7 并行 | [x] `4c7fbed` |
| R3 | `packages/adapter-codex`（下）：审批、取消、恢复、计划、错误归类、三层契约测试，默认引擎改为 Codex | R2 | 与 R7 并行 | [x] `e9365b8` |
| R4 | 子会话：领域模型、Host 协议与存储、`AgentEvent`，adapter-codex 上报 | R3 | — | [ ] |
| R5 | 桌面端：子智能体界面（照 Codex 桌面端） | R4、R12 | 与 R6 并行 | [ ] |
| R6 | ChatGPT 订阅登录与设置页 | R3；界面风格随 R12 | 与 R5 并行 | [ ] |
| R7 | 从 adapter-dsh 抽出通用 ACP 适配器（行为不变） | — | 与 R1–R3 并行 | [x] `1f5e918` |
| R8 | 经通用 ACP 适配器接 Grok Build 与 Gemini CLI；xAI 与 Gemini 的 API Key 经网关 | R3、R7 | — | [ ] |
| R9 | 运行时分发：`codex-app-server` 随应用，dsh 改为可选下载 | R3、R7 | — | [ ] |
| R10 | 网关加 Anthropic Messages | R1 | 任意时间 | [x] `5f2b3eb` |
| R11 | 回合进行中发消息：插话与排队，设置里选默认行为 | R3 | 与 R4–R6 并行 | [ ] |
| R12 | 工作台布局：混合 Codex 与 Claude Code 桌面端，窗格可调尺寸、按数量与种类动态布局 | — | 与 R1–R4 并行；R5 之前做完 | [x] 设计 `c5ce1a9`，实现 `906fa63` |

基础提示词已定（ADR-0005 补记 2）：经网关的第三方模型用 [`prompts/base.md`](../prompts/README.md)，由 R2 加载。还没定的：计划模式怎样下发（ADR-0005 未决事项 5），不在 R1–R10 里。

### 界面参考

整体界面**混合参考 Codex 桌面端与 Claude Code 桌面端**（维护者 2026-10-14）。两者都不开源：`openai/codex` 里只有终端界面（`codex-rs/tui`，Rust），没有桌面前端代码；Claude Code 桌面端也没有公开的前端源码。所以：

- **视觉与布局**：以维护者的截图为准。维护者 2026-10-14 给的截图存在本机仓库根目录的 `design-refs/`（gitignore，不进仓库，见下表）；不够就向维护者要，没有就先问。
- **布局原则**：窗格（会话、子智能体、文件、后台任务、清单等）都能拖动调尺寸、最大化、关闭；整体布局随打开的窗格种类与数量动态变化（截图 05–07）。细节见 R12 的 [desktop-layout.md](architecture/desktop-layout.md) 与 [ADR-0006](adr/0006-desktop-workbench-panes.md)。
- **交互语义**（子 agent 怎样出现、审批有哪些选项、计划怎样更新、中断、插话与排队）：先读 codex-notes §2.7 的摘要，细节再看 `upstream/codex/codex-rs/tui/` 的源码，它和桌面端一样是 app-server 的客户端。注意它打开了实验面，Wevir 不开（ADR-0005 决策 5、补记 1）。
- **不拷贝任何闭源代码与素材**（包括从安装包里解出来的脚本、图标、字体），也不把截图提交进仓库；只照着截图用 Wevir 自己的设计 token 与组件实现。

| `design-refs/` 下的文件 | 内容 |
|---|---|
| `01-codex-parent-subagent-markers.png` | Codex 父会话消息流：子 agent 的“〈标题〉开始工作”“〈标题〉已完成”两行 |
| `02-codex-pinned-summary.png` | 左上角的置顶摘要卡片：项目名、“变更 +N −M”、“子智能体 · 2 完成”与头像 |
| `03-codex-subagents-tab.png` | “子智能体”标签：“已开启 · 0 / 没有已开启的子代理”“完成 · 2”，每项头像、标题、相对时间 |
| `04-codex-subagent-detail.png`、`06-codex-subagent-detail-with-summary.png` | 子 agent 详情：返回箭头、头像、标题、右上“模型 · 推理强度”、“用时 3m 14s ›”、回答正文（带代码块的语言标签、换行与复制按钮）、复制 / 朗读 / 反馈按钮；没有输入框 |
| `05-claude-code-desktop-panes.png` | Claude Code 桌面端的多窗格：后台任务列表（分组“Finished 17”、每项状态 / 用时 / token / 工具次数 / “View transcript”）、文件预览（大纲、搜索、菜单、最大化、关闭，滚动时顶部有“Continued from …”）、清单窗格；每个窗格可最大化、关闭，按数量排布 |
| `07-codex-open-tabs-menu.png` | 右上角的计数按钮展开“已打开的标签页”列表 |
| `08-codex-toggle-pinned-summary.png` | “切换置顶摘要”按钮的提示 |

---

## 通用前缀

````text
你在 Wevir 仓库（/Users/marvin/Developer/wevir）工作。Wevir 是面向中国大陆用户的本地优先、开源、多模型、可跨设备接续的 Agent 工作台，Wevir 自己拥有 Local Agent Host、会话协议和客户端。引擎方向已经定了（ADR-0005，Accepted）：默认引擎是 OpenAI Codex 的 codex-app-server，Host 内置模型协议网关；dsh 保留为可选引擎，不再加新能力。目前代码里的引擎仍是 dsh，本系列任务（docs/CODEX_RUNTIME_PROMPTS.md 的 R1–R10）把它迁过去。方向与范围由维护者决定，你负责实现、补充遗漏，遇到需要拍板的事先问。

开始前先读：
- AGENTS.md
- docs/adr/0005-agent-runtime-and-model-gateway.md（全文）
- docs/research/codex-notes.md 中本任务 prompt 点到的章节
- docs/CODEX_RUNTIME_PROMPTS.md 的任务表与「界面参考」
- 本任务 prompt 中「先读」列出的文件

硬性规则：
1. 只做本任务。发现 ADR 或架构文档与现实不符，先改文档（ADR 已 Accepted，只能在「补记」里追加；决策要变就停下来问维护者），再改代码；不擅自扩大范围或提前做后续任务。
2. 引擎边界（AGENTS.md 规则 2）：@deepseek-ai/* 只在 packages/adapter-dsh，@openai/codex* 只在 packages/adapter-codex；产品代码不得引用 spikes/。
3. upstream/ 是只读参考（含 upstream/codex，锁定 rust-v0.162.1 = 092d3ac）。移植上游代码时文件头写明来源仓库、路径、提交 SHA、许可证，登记到 docs/upstream/UPSTREAM.md §4，并更新 NOTICE。OpenWork 的 ee/ 禁止参考和移植。Codex 桌面端是闭源的，不拷贝它的任何代码与素材。
4. 密钥不落地：模型 Key 等不得写入仓库、日志、测试快照、CODEX_HOME 或 DSH_HOME；Codex 只拿网关的一次性令牌。测试用的真实 Key 只从环境变量读（WEVIR_TEST_API_KEY / WEVIR_TEST_PROVIDER），不打印。
5. 先查文档再写 API：Codex 的协议以 upstream/codex/codex-rs/app-server-protocol/schema/ 与源码为准，其他第三方库查当前文档，不凭记忆写。
6. 协议只加不减（docs/architecture/host-api.md §10）：新字段 optional、新事件类型直接发；改协议就升版本并加冻结样本。
7. 代码风格与仓库已有代码一致，格式交给 Biome；不加与任务无关的抽象。
8. 同一个 checkout 里可能有并行会话：开工和提交前看 git status，只暂存自己的文件（显式写路径，不用 git add -A），pnpm-lock.yaml 只提交自己那部分改动；别人的半成品让 lint 或测试失败时，按 project 单独跑，并在汇报里说明。
9. 机器内存偏紧：vitest 加 --maxWorkers=2；后台起的进程（Host、app-server、开发服务器、mock）用完就关；测试产生的临时目录、探针脚本、一次性输出都删干净，汇报里说明保留了什么。

完成后：
- 运行本任务的验收步骤，贴出命令和结果（失败就如实说明）。需要外部条件（真实模型 Key、Windows 机器、截图）而没有执行的，写明缺什么，不算通过。
- 影响到的 ADR 补记、架构文档、docs/development.md、AGENTS.md 的目录说明一并更新。
- 在 docs/CODEX_RUNTIME_PROMPTS.md 的任务表里把本任务改为 [x]，备注写提交号。
- 提交 commit，message 以任务 ID 开头，例如 "R1: add the model gateway with Responses passthrough and Chat translation"。
- 最后用中文汇报：做了什么；验收结果；与 ADR 的偏离及原因；给下一个任务的注意事项。
````

---

## R1：模型协议网关

依赖：无 · 可并行：与 R7

````text
任务 R1：新建 packages/model-gateway，实现 ADR-0005 决策 2 的模型协议网关的第一批协议：Responses 透传与 Chat Completions 转换。

先读：codex-notes §3（Codex 发出的请求与它解析的流事件）、§3.4（各家兼容性）、§5（映射规则、已验证与没验证的、方言修正）、§6.3；spikes/codex-app-server/src/gateway.ts、mock-responses.ts、mock-chat.ts、model-script.ts、run-all.ts（这些是验证过的原型，可以改写进产品代码，文件头写“改写自 spikes/codex-app-server/…”）；upstream/codex/codex-rs/codex-api/src/sse/responses.rs（Codex 解析 SSE 的规则）；packages/runtime-adapter/src/types.ts 的 ProviderConfig 与 ProviderTestResult；packages/adapter-dsh/src/provider-test.ts（失败归类的口径）；docs/architecture/providers.md。

要做：
1. 包结构照 packages/protocol 抄（AGENTS.md「新建一个库包」）。只用 Node 内置模块与全局 fetch，不加运行时依赖；不依赖任何 Codex 的包。
2. 对外接口（形状可以调整，写进文档）：
   - startModelGateway({ logger }) → { baseURL(providerId), token, setProviders(providers), testProvider(provider, modelId), close() }。
   - 监听 127.0.0.1 的随机端口；路由 POST /v1/p/<providerId>/responses；Authorization: Bearer <token>，令牌每个网关实例随机生成、只在内存，比较用常量时间。
   - setProviders 接收完整的 ProviderConfig 列表（含 Key），之后的请求按新配置走；进行中的请求不受影响。
3. 按 Provider 选处理方式：
   - kind=deepseek-official → Responses 透传到 https://api.deepseek.com（与 DeepSeek 的 Codex 接入文档一致）。
   - openai-compatible 且 api=openai-responses → 透传到 baseURL。
   - api=openai-completions → Chat 转换。
   - api=anthropic-messages → 本任务不支持：validate 时报问题、请求时回 400 并写明“R10 之后支持”。
4. 透传：请求体去掉 client_metadata；请求头只发网关自己的（content-type、accept、user-agent: wevir-gateway/<版本>、上游 Key），x-codex-*、session-id、thread-id、originator、x-client-request-id、x-openai-* 一律不转发；响应流原样转回。留一个按 Provider 挂“方言修正”的位置，先实现两条并写测试：tools 为空数组时去掉 tool_choice（xAI 会 400，codex-notes §3.4）；Provider 声明不支持自定义工具时，把 custom 工具按 Chat 转换的办法摊平成函数、响应里再还原（Responses 版本的同一套规则）。Provider 的这类声明放在 ProviderConfig.compat 里，字段名在文档里定。
5. Chat 转换按 codex-notes §5.1 的表实现，并补上原型没做的：
   - finish_reason=length → response.incomplete（reason: max_output_tokens），content_filter 同理；
   - 上游流中途出错或断开 → response.failed（带上游原文）；
   - 并行工具调用多个 index 交错到达；
   - 函数名超过 64 个字符或含非法字符时（namespace 摊平后可能出现）的可逆映射；
   - 图片输入（input_image → image_url parts）；
   - developer 消息出现在对话中间时的处理（转 system；某些上游只接受开头一条 system 的，用 compat 开关合并或转成 user 并注明）。
6. 上游非 2xx：状态码原样转给 Codex，正文整理成 {"error":{"message":…}}；Codex 断开时中断上游，按正常结束处理（Codex 读到 response.completed 就会断开，codex-notes §7.3）。
7. testProvider：用与正式请求相同的处理方式发一次最小的流式请求，失败归类与 ProviderTestFailure 一致（missing_key、network、timeout、auth、model_not_found 等，按现有类型来）。
8. 日志只记方法、Provider ID、上游状态码与耗时，不记请求体、响应体与任何 Key。

测试（vitest --maxWorkers=2）：
- 单元：请求映射与流式响应映射的逐项用例，含上面第 5 点每一条。
- 集成：把原型里的 Responses mock 与 Chat mock 改写成 src/test-fixtures/ 下的测试服务，覆盖透传、转换、令牌校验、元数据剥离、方言修正、abort 传播、上游错误。
- 请求样本：用 spikes/codex-app-server 的二进制（bash spikes/codex-app-server/scripts/fetch-binary.sh）录一份真实的 Codex 请求体（第一回合、带工具调用的第二回合、跨回合的第三回合），去掉本机路径与 id 后放进 test-fixtures，作为映射测试的输入。
- 真实模型（可选）：WEVIR_TEST_API_KEY + WEVIR_TEST_PROVIDER=deepseek 时，各跑一次透传与 Chat 转换的最小对话，否则跳过并打印原因。

文档：新建 docs/architecture/model-gateway.md（接口、路由、两种处理方式的完整映射表、剥离的字段、方言修正清单、错误与取消、日志口径）；overview.md 的包表加一行；AGENTS.md 目录说明加这个包；ADR-0005 补记写下与决策不同或决策没写到的地方。

不做：Anthropic Messages（R10）、Gemini 原生协议；接进 Host 或 adapter-codex（R2）；Codex 侧的任何配置。

验收：pnpm --filter @wevir/model-gateway test、pnpm typecheck、pnpm lint 通过；贴出用录制的 Codex 请求跑转换得到的 Chat 请求（脱敏）各一份。
````

## R2：adapter-codex（上）

依赖：R1 · 可并行：与 R7

````text
任务 R2：新建 packages/adapter-codex，实现 AgentRuntimeAdapter 的基础部分：codex-app-server 进程管理、CODEX_HOME 与配置、会话、回合与流式事件；Host 支持 --adapter codex。审批、取消、恢复与完整的契约测试留给 R3。

先读：ADR-0005 决策 1、2、5、6、7；codex-notes §2（app-server 接入面）、§3.1、§3.3（模型目录）、§6（隔离、外连、密钥）、§10（事件映射草案）；spikes/codex-app-server/src/app-server.ts、codex-home.ts、harness.ts；packages/runtime-adapter/src/{adapter,events,types,contract}.ts；packages/adapter-dsh/src/{paths,env,dsh-process,dsh-adapter,capabilities}.ts（同类问题的现有做法）；packages/host/src/cli.ts 的 createAdapter；prompts/README.md 与 prompts/base.md；upstream/codex/codex-rs/app-server-protocol/schema/typescript/（以及 v2/）中用到的类型。

要做：
1. 二进制：
   - 版本常量 CODEX_VERSION = 'rust-v0.162.1'，与 docs/upstream/upstream.lock 一致；启动前跑 codex-app-server --version 核对，不一致就报错（同 dsh 的 DSH_VERSION）。
   - 解析顺序：环境变量 WEVIR_CODEX_BIN → 开发缓存目录。把 spikes/codex-app-server/scripts/fetch-binary.sh 改写成 scripts/fetch-codex.sh，写全 6 个平台（含 Windows 的 .exe）的资产名与 sha256（从 GitHub API 的 digest 取），下载到开发缓存（例如 .wevir-dev/bin/，gitignore），支持 WEVIR_GITHUB_MIRROR。打包后的位置留给 R9。
2. 进程（参照 DshProcess）：每个 Host 一个 codex-app-server，第一个会话时启动；CODEX_HOME=<数据目录>/engines/codex 事先建好，进程 cwd 也是它；环境按白名单构造，Key 不进环境，只有网关令牌（WEVIR_GATEWAY_TOKEN）。HOME 用用户真实的家目录（模型跑的命令要用到 git 等配置），但要核实 Codex 在 CODEX_HOME 之外还读哪些用户级目录（例如 ~/.agents/skills），读到就像 dsh 的 DSH_AGENTS_HOME 那样隔离，并写进文档。回收：关 stdin → SIGTERM → SIGKILL；意外退出给每个会话报 engine.exited，有限次重启。
3. 握手：initialize 的 clientInfo.name 写 'wevir'、version 写 Host 版本，experimentalApi:false；再发 initialized。协议类型手写本包用到的子集，每个类型注明对应的 schema 文件；不整批拷贝生成的类型。
4. 配置：生成 CODEX_HOME/config.toml 与模型目录（ADR-0005 决策 5 列出的全部加固项，外加补记 1 的 features.goals = false；update_plan 打开；approval_policy on-request、sandbox_mode workspace-write）。每个 Wevir Provider 一个 [model_providers.wevir_<id>]，base_url 是 R1 网关的 baseURL(providerId)，env_key=WEVIR_GATEWAY_TOKEN，名字不能是 "OpenAI"（codex-notes §6.4）。模型目录由 ProviderConfig.models 生成：apply_patch_tool_type "freeform"、上下文大小、推理档位；基础提示词用 prompts/base.md（ADR-0005 补记 2）：按 prompts/README.md 的模板语法渲染（先删 HTML 注释，再替换 model_display_name、provider_display_name，渲染结果不得残留 {{），写进每个模型条目的 base_instructions；ChatGPT 登录的 OpenAI 模型不覆盖。启动时带 --strict-config，配置写错就失败。
5. Provider 变更（configureProviders）：先核实 thread/start 的 config 覆盖能不能带上新增的 model_providers 条目；能就不重启进程，不能就照 dsh 的做法空闲时重启、会话以 engine.exited(config_changed) 脱开。网关实例由 adapter-codex 创建并持有（在 Host 进程里），configureProviders 时同步给网关；testProvider 转给网关；validateProvider 报出网关不支持的协议。
6. 会话与回合：createSession → thread/start {cwd, model, modelProvider, approvalPolicy, sandbox}，threadId 即 engineSessionId；send → turn/start，引擎接受就返回；close 先用 thread/unsubscribe（核实语义）。
7. 事件：按 codex-notes §10 映射 assistant.delta / assistant.message / assistant.stream_ended / assistant.thought、tool.started / tool.updated / tool.finished（declined 先映射为 failed，拒绝的语义由审批事件承担）、usage.updated（上下文大小取模型目录）、turn.settled / turn.failed、engine.exited；不认识的进 engine.raw。工具的 display 直接由 item 类型与 commandActions 得出（不需要 dsh 那样按工具名猜，docs/architecture/domain-model.md §7；只读、列目录、搜索的命令归为读取 / 搜索类，与桌面端已有的聚合规则对上）。usage.updated 的已用量取 thread/tokenUsage/updated 的 last.totalTokens（codex-notes §2.7 的口径）。error 通知里 willRetry 为 true 的不当作回合失败。子 thread 的事件本任务先按 engine.raw 上报，R4 再处理。
8. Host：cli.ts 的 --adapter 加 codex（默认值本任务不改，R3 改）；CLI 与桌面端都能用 --adapter codex 跑通一问一答与一次工具调用。

测试（vitest --maxWorkers=2）：
- 映射单元测试：用真实二进制录下的通知序列（JSONL，放 src/test-fixtures/app-server/，去掉本机路径）回放。
- 契约测试第 2 层：真实 codex-app-server + R1 网关 + mock 模型，runAdapterContract 的能力开关先开 incrementalStream、toolCalls、concurrentSessions，approvals 与 resume 留给 R3；二进制不存在时跳过并打印 fetch 命令。CI（.github/workflows）里下载并缓存二进制，macOS 与 Windows 都跑。
- 外连与密钥：把 Spike 的 network-audit 与 secrets 两个检查改写成本包的集成测试（默认配置外连为零；令牌不落盘、不进日志；模型跑的命令看不到 WEVIR_*）。

文档：新建 docs/architecture/codex-event-mapping.md（照 acp-event-mapping.md 的结构：进程、握手、配置、会话、事件逐条映射、Provider）；overview.md、AGENTS.md 目录说明、docs/development.md（fetch-codex、WEVIR_CODEX_BIN、--adapter codex）、UPSTREAM.md §1.2（产品开始用这个二进制）、ADR-0005 补记。

不做：审批、取消、恢复（R3）；子会话（R4）；ChatGPT 登录（R6）；打包（R9）；回合进行中的追加输入（turn/steer。Wevir 目前回合中拒绝新消息，要不要支持另问维护者）。

验收：上述测试通过；pnpm typecheck、pnpm lint 通过；用 pnpm dev（Host 以 --adapter codex 启动，配一个指向 mock 或真实 DeepSeek 的 Provider）在桌面端完成一次带工具调用的对话，贴截图或 CDP 读到的消息流文本。
````

## R3：adapter-codex（下）

依赖：R2 · 可并行：与 R7

````text
任务 R3：补齐 adapter-codex：审批、取消、关闭与恢复、计划、错误归类、三层契约测试；完成后把 Host 的默认引擎改为 codex。

先读：R2 的提交与 docs/architecture/codex-event-mapping.md；ADR-0005 决策 6、7；codex-notes §2.3（审批）、§2.5（resume）、§7.1 的 cancel / resume / upstream-error / plan 几行；docs/architecture/acp-event-mapping.md §5、§6（dsh 的审批与恢复规则，Host 一侧的约定不变）；docs/architecture/domain-model.md §4.4、§5；packages/adapter-dsh/src/dsh-adapter.contract*.test.ts 与 test-fixtures/（三层契约测试的组织方式）；upstream/codex/codex-rs/tui/src/{approval_events.rs,app_server_approval_conversions.rs} 与 bottom_pane 下的审批界面（Codex 自己怎样呈现审批选项）。

要做：
1. 审批：item/commandExecution/requestApproval、item/fileChange/requestApproval（以及 item/permissions/requestApproval，先核实什么时候出现）→ approval.requested。availableDecisions 是实验字段拿不到，选项按 codex-notes §2.7 固定：命令是“是，继续”（accept）、“是，本会话内这个命令不再问”（acceptForSession）、“否，不运行并继续”（decline）、“否，告诉它换个做法”（cancel，会中断回合）；文件改动是“是”“是，这些文件本会话不再问”“否，告诉它换个做法”（以 TUI 为准）。详情带命令原文、cwd、理由、commandActions，文件改动带同一 itemId 的 fileChange 的 changes（diff）。respondToApproval 回 {decision}；listPendingApprovals 可用；serverRequest/resolved 而 Wevir 没回复过的 → approval.cancelled，注意它在 turn/completed 之后才到（codex-notes §2.3），回合结算后仍要能映射。execpolicy 修订（“以后以这个前缀开头的命令不再问”）先不做，留在文档里。
2. 取消：turn/interrupt；5 秒内等不到 turn/completed(interrupted) 就重启进程、会话以 engine.exited(cancel_unconfirmed) 脱开（与 dsh 相同的约定）。审批挂起时取消、流式中途取消都要覆盖。
3. 关闭与恢复：resumeSession → thread/resume；“no rollout found” 一类错误 → session_lost（原因写清楚），cwd 不一致等 → session_unavailable；恢复后下一回合带完整历史。
4. 计划：turn/plan/updated → todo.updated。toolCallId 没有来源，用一个可识别的合成 ID（例如 plan:<turnId>），在 codex-event-mapping.md 写明；如果你认为必须改 AgentEvent，先停下来问。
5. 错误归类：turn/completed(failed) 与 error 通知（willRetry 为 true 的只记日志或 engine.raw，Codex 自己也只在状态栏短暂显示）→ turn.failed，category 按 codexErrorInfo 与上游状态码归类（missing_credentials、provider、unknown）。
6. 会话标题：维护者定为用当前会话的模型自动生成（Codex 服务端不生成，codex-notes §2.7）。规则与提示词照 prompts/README.md「会话标题」与 prompts/thread-title.md：第一个回合开始后由 Host 生成，推理档位取最低；生成出来之前用 session-manager.ts 的 makeTitle 截断兜底；输出 {"title","description"}，去掉首尾引号与结尾标点后截断，description 先存下；用户改过名（titleSource 'user'）就不再自动生成；协议的 TitleSource 加一个“模型生成”的值（升版本、加冻结样本）。调用路径：经网关的会话由 Host 经网关直接发一次不带工具的请求；ChatGPT 登录的会话不经网关，用 Codex 的临时 thread（thread/start 的 ephemeral 加 turn/start 的 outputSchema，照终端界面 app/thread_title.rs 的做法）。这一块用一个可选的适配器方法（例如 generateTitle）暴露给 Host，dsh 等不实现的引擎继续用截断标题。
7. 三层契约测试（照 adapter-dsh）：第 1 层回放录制的 JSONL（写一个假的 app-server 进程，像 fake-dsh.mjs）；第 2 层真实二进制 + 网关 + mock 模型，能力开关全开；第 3 层真实模型（WEVIR_TEST_API_KEY + WEVIR_TEST_PROVIDER，没有就跳过并打印原因）。
8. Host 默认引擎改为 codex（cli.ts、docs/development.md、README 的现状描述）；dsh 仍可 --adapter dsh。
9. 升级检查清单：在 docs/upstream/UPSTREAM.md 加「Codex 升级检查清单」一节（照 §7 dsh 的写法：读 release 说明、schema diff、三层契约测试、外连审计、密钥检查、更新 lock 与 fetch-codex.sh 的校验和）。

验收：三层契约测试（第 3 层有 Key 时）、全部测试、typecheck、lint 通过；用桌面端走一遍：工作区外写文件触发审批（同意 / 拒绝 / 本会话同意各一次）、流式中途取消、关掉 Host 再打开后继续同一会话，贴结果。
````

## R4：子会话（协议、Host、adapter-codex）

依赖：R3

````text
任务 R4：让 Codex 的子 agent 成为 Wevir 的“子会话”：先改领域模型与 Host 协议文档，再改 runtime-adapter、storage、host、client-sdk 与 adapter-codex。界面在 R5 做。

先读：ADR-0005 决策 6.1（子会话的定义与界面要求）；codex-notes §2.4（子 agent 在 app-server 里的样子）与 §7.1 的 subagent 行；spikes/codex-app-server/src/run-all.ts 的 subagent 场景；docs/architecture/domain-model.md（§3.3 Session、§4 状态机、§6 事件目录）、docs/architecture/host-api.md（§4 订阅、§10 兼容规则）；packages/protocol、packages/storage/migrations、packages/host/src/session-manager.ts、packages/client-sdk/src/{projection,session-state}.ts；upstream/codex/codex-rs/tui/src/multi_agents.rs 与 src/app/ 下 agent_picker、agents_overview_*、agent_navigation、thread_routing（Codex 怎样发现、命名、导航子 agent，只读语义，不拷代码）。

要做：
1. 文档先行：domain-model 加子会话（parentSessionId、触发它的父会话工具调用、标题、模型与推理强度、状态：运行中 / 完成 / 失败 / 已关闭 / 已取消、开始与结束时间），写清它的状态机与父会话的关系（父回合取消时子会话怎样，先在真实二进制上实测）；host-api 写清：session.list 默认不含子会话、怎样列出某会话的子会话、子会话能订阅与 session.get、不能 send（只读）、父会话快照里的子会话摘要；协议版本升一个次版本并加冻结样本。
2. runtime-adapter：加子会话事件（例如 subagent.started / subagent.updated，名字在文档里定），带父 engineSessionId、子 engineSessionId、父工具调用 ID、标题、模型、推理强度、状态。子会话自己的事件照常按子 engineSessionId 上报。echo 假引擎加一个能产生子会话的提示词，契约测试加对应条款（能力开关 subagents，dsh 为 false）。
3. adapter-codex：从 collabAgentToolCall（receiverThreadIds、agentsStates、tool）与子 thread 的 turn/started（rootTurnId）识别子会话，不用实验面（Codex 的终端界面用 thread/list.parentThreadId，那是实验字段，codex-notes §2.7）；agentsStates 里 notFound 的跳过；标题同样用模型生成（输入是 spawn_agent 的任务描述，走 R3 的生成路径），生成出来之前按 ADR-0005 决策 6.1 的顺序兜底（thread 名称 → 任务描述首行 → 昵称），在 ADR-0005 补记里写明；子 thread 的通知改为按子会话上报（R2 里先进了 engine.raw）。
4. 子会话的审批：子 thread 发来的审批要在父会话里也能看到并处理（ADR-0005 补记 1；Codex 的终端界面把它冒到当前视图并标出来自哪个子 agent）。协议上审批仍属于子会话，父会话的快照与订阅能知道“有子会话在等审批”；写清楚它在哪个会话的事件流里出现、谁能 approval.respond。
5. 子会话的中断：Codex 的终端界面允许直接中断子 agent 的当前回合，ADR 定的是子 agent 视图只读。本任务先实测父回合取消时子回合会怎样，把结果和“要不要给子会话单独的停止按钮”一起交给维护者，不自行加。
6. storage 与 host：sessions 表加 parent_session_id 等列（新迁移）；SessionManager 在收到子会话事件时建子会话记录并把它的事件写进它自己的事件流；Host 重启后子会话按只读历史可读。
7. client-sdk：会话列表推导与投影支持子会话（父会话能拿到子会话列表与各自状态）；CLI 的 attach 至少能显示“子 agent 开始 / 完成”两行。

验收：协议冻结样本、契约测试（echo 与 codex 第 2 层）、host 与 client-sdk 测试、typecheck、lint 通过；用 Spike 同样的 mock 脚本（spawn → wait）在 Host 上跑一遍，贴出父会话与子会话各自的事件流。
````

## R5：桌面端子智能体界面

依赖：R4 · 可并行：与 R6

````text
任务 R5：在桌面端实现子智能体的界面，整体照 Codex 桌面端（ADR-0005 决策 6.1，本文件「界面参考」），放进 R12 定下的窗格布局里。

开始前：看 design-refs/ 的 01–04、06–08（父会话消息流里的“开始工作 / 已完成”两行、“子智能体”标签、子 agent 详情、置顶摘要卡片），不够再向维护者要。Codex 桌面端不开源，不拷贝它的代码与素材。

先读：R4 的协议与 client-sdk 改动；R12 的布局文档与代码；apps/desktop/src/renderer/src 下 layout/（right-panel-tabs.ts、right-panel.tsx、workbench-layout.tsx）、routes/、session/（transcript-view.tsx、tool-card.tsx、tool-model.ts、message-view.tsx、session-status.tsx）、data/transcript-store.ts、i18n、styles/tokens.css；upstream/codex/codex-rs/tui/src/multi_agents.rs 与 src/app/agents_overview_*、agent_picker.rs、agent_navigation.rs（状态的说法、排序、导航）；docs/development.md 里桌面端的调试说明（开发模式的远程调试端口 WEVIR_DESKTOP_DEBUG_PORT，默认 9339，可以用 CDP 驱动渲染进程、截图）。

要做：
1. 父会话消息流：每个子会话两条行内标记“〈标题〉开始工作”“〈标题〉已完成”（失败、已关闭、已取消各有说法），带子会话的图标，点击进入子 agent 视图。spawn / wait / close 这几个 collab 工具调用不再显示成普通工具卡片（终端界面的措辞见 codex-notes §2.7，可以参考，界面以截图为准）。子会话的审批在父会话的输入框上方照常出现，标出来自哪个子 agent，并能跳到子 agent 视图（R4 的协议）。
2. 新增“子智能体”窗格（按 R12 的窗格模型注册一种窗格）：按“已开启 · N”“完成 · N”分组，每项图标、标题、相对时间；没有时显示“没有已开启的子智能体”。置顶摘要卡片（R12 的框架）加一节“子智能体 · N 完成”与头像，点开打开这个窗格。
3. 子 agent 视图：路由挂在父会话下（例如 /workspace/:wid/session/:sid/agent/:childId，URL 是唯一事实）；顶部返回箭头、标题、模型 · 推理强度、用时；下面复用父会话的消息流组件（逐字流式、工具卡片、审批卡片），只读、没有输入框。
4. 图标：每个子会话一个确定性的头像（由会话 ID 选 Wevir 调色板里的颜色与形状），不用 Codex 的图标。
5. 文案全部经 t()，源语言 zh-CN；暗色与亮色都要对。

测试与验收：纯逻辑（分组、排序、标题与状态文案、头像选择）有单元测试；用 pnpm dev 连真实 Host（--adapter codex + mock 模型脚本 spawn → wait），经 CDP 截下父会话、右栏列表、子 agent 视图三张图，与维护者给的截图并排放进汇报；typecheck、lint、相关测试通过。
````

## R6：ChatGPT 订阅登录与设置页

依赖：R3 · 可并行：与 R5

````text
任务 R6：支持用 ChatGPT 订阅登录 Codex（ADR-0005 决策 4 第 ① 行）：Host 协议、adapter-codex、设置页。

先读：ADR-0005 决策 4；codex-notes §4.1（条款：只限本地或开源形态；clientInfo.name 写应用自己的名字；不提取、不转用令牌）；upstream/codex/codex-rs/app-server-protocol/schema/typescript/v2/ 中 account 相关的类型（登录、登录完成、账号读取、登出、rateLimits）；upstream/codex/codex-rs/tui/ 中 onboarding / login 的实现（Codex 自己怎样走浏览器登录与设备码）；apps/desktop/src/renderer/src/settings/（provider-settings.tsx、provider-editor.tsx、provider-presets.ts）；docs/security.md。

要做：
1. 先在真实二进制上核实（mock 不了的部分如实记录）：account/login/start 的浏览器方式（{type:"chatgpt"} → {loginId, authUrl}）与设备码方式（{type:"chatgptDeviceCode"} → {loginId, verificationUrl, userCode}）、account/login/cancel、account/login/completed {loginId, success, error}、account/read（requiresOpenaiAuth）、account/updated、account/logout（codex-notes §2.7）；凭据存在哪里（CODEX_HOME 下的文件还是系统钥匙串，cli_auth_credentials_store 一类配置），选一种写进 security.md；登录后外连会多出哪些域名（再跑一次外连审计）。
2. 领域模型与协议：ChatGPT 订阅作为一种 Provider（例如 kind: 'chatgpt'，没有 Key、没有 baseURL），会话用 Codex 内置的 openai Provider 与它自己的模型列表（model/list），不经网关。Host 加账号相关的方法（开始登录、取消、状态、登出）与状态事件，协议升版本、加冻结样本。
3. adapter-codex：转发登录流程；浏览器方式把 URL 交给桌面端经 openExternal 打开，设备码方式把码与网址交给界面显示；登录状态变化上报；登出。
4. 设置页：Provider 列表里加“ChatGPT 账号”入口：未登录时显示登录按钮与“仅供个人在本机使用 Wevir 时登录”的说明，登录中显示进度与取消，已登录显示账号与套餐、登出；模型选择用 model/list 的结果。界面风格照 Codex 与 Claude Code 桌面端（向维护者要设置页截图；R12 先做完的话沿用它的样式）。
5. CLI：wevir provider 下加最小的登录 / 状态 / 登出命令（设备码方式）。

验收：协议与 Host、adapter-codex、设置页的测试通过；维护者用自己的 ChatGPT 账号在桌面端登录一次并完成一问一答（需要维护者在场，你不要输入任何账号密码）；外连审计结果写进 codex-notes 或 security.md；typecheck、lint 通过。
````

## R7：通用 ACP 适配器

依赖：无 · 可并行：与 R1–R3

````text
任务 R7：把 packages/adapter-dsh 里与 dsh 无关的 ACP 部分抽成通用的 packages/adapter-acp，adapter-dsh 变成它的一份配置加 dsh 专属的部分。dsh 的行为一点都不能变。

先读：ADR-0005 决策 1.3、1.5；codex-notes §8 最后两行（哪些是通用的、哪些是 dsh 专属的）与 §9（Gemini CLI、Grok Build 的 ACP 能力对照）；ADR-0001；docs/architecture/acp-event-mapping.md；packages/adapter-dsh/src 全部源码与三层契约测试。

要做：
1. 通用部分进 adapter-acp：ACP 进程与连接（启动、initialize 超时、有限重启、stdin EOF → SIGTERM → SIGKILL、在 ACP SDK 之前截下 session/update）、ACP → AgentEvent 映射（工具展示与路由解码改为注入）、每会话事件队列、会话与审批记账、能力表。@agentclientprotocol/sdk 改由 adapter-acp 声明，版本不变。
2. 留在 adapter-dsh：dsh 可执行入口与版本、DSH_HOME 布局、白名单环境、stream-tap 与 DeltaMerger、providers.yml overlay 与 provider.test、resume 的错误文案、工具展示表、route 编码与配置变更时重启。
3. 引擎差异用一份“引擎描述”表达（可执行入口与参数、环境、能力、错误归类、工具展示、可选的增量旁路），为 R8 的 Grok Build 与 Gemini CLI 留好位置，但本任务不接它们。
4. acp-event-mapping.md 改成“通用 ACP 映射 + dsh 专属补充”两部分；overview.md、AGENTS.md 目录说明同步。

验收：adapter-dsh 的三层契约测试（第 3 层有 Key 时）与全部测试原样通过，测试代码只改 import 路径；pnpm lint（含引擎边界检查）、typecheck 通过；用 pnpm dev --adapter dsh 跑一问一答与一次审批，确认行为没变。
````

## R8：Grok Build、Gemini CLI 与对应的 API Key

依赖：R3、R7

````text
任务 R8：经通用 ACP 适配器接入 Grok Build（xAI 订阅）与 Gemini CLI（只用 API Key）；另在网关与 Provider 预设里加 xAI 与 Gemini 的 API Key 接法（ADR-0005 决策 4 第 ②、②′、③ 行）。

先读：ADR-0005 决策 4；codex-notes §3.4 的 xAI、Gemini 两行，§4.2、§4.3（条款与登录），§9（两者的 ACP 能力对照，标“未核实”的要在本任务核实）；R7 的引擎描述；packages/model-gateway 的方言修正；apps/desktop/src/renderer/src/settings/provider-presets.ts。

要做：
1. 先核实并补进 codex-notes §9：Grok Build（`grok agent stdio`）与 Gemini CLI（`gemini --acp`）的当前版本、安装方式与体积、ACP 的流式粒度、工具 kind、审批选项、会话方法、隔离目录（GROK_HOME、GEMINI_CLI_HOME）、遥测开关、登录方式。Grok 的订阅登录用 Grok Build 自己的 `grok login`（浏览器或设备码），Wevir 只启动它、把网址交给界面，不读它存的凭据；界面上说明用的是用户自己的 Grok 账号、条款对第三方编排没有明文。Gemini 只用 API Key（个人订阅登录已停），关掉匿名用量统计。
2. 两个引擎都是可选组件，不随安装包分发：本任务先支持“用户已安装或指定路径”（设置里填路径或从 PATH 找，版本核对），下载机制随 R9。不在任何 package.json 里声明它们的 npm 包；若必须声明，先扩展引擎边界检查并问维护者。
3. 会话创建时可选引擎（Codex / dsh / Grok Build / Gemini CLI），Host 与桌面端的新建会话入口加引擎选择；不支持的能力（例如子会话、计划）在界面上不显示。
4. 网关：xAI 的 Responses 透传（https://api.x.ai/v1）加 tool_choice 方言修正；核实 xAI 是否支持自定义工具，不支持就打开 R1 的“自定义工具摊平”开关。Gemini 的 API Key 走 Chat 转换（https://generativelanguage.googleapis.com/v1beta/openai/）。两者加 Provider 预设。
5. 契约测试：两个引擎各跑通用 ACP 的契约测试第 2 层（真实可执行文件 + 能用 mock 的地方用 mock；不能 mock 模型的，标出只能第 3 层验证的条款）。

验收：测试、typecheck、lint 通过；有 Key 或账号时（维护者提供，只从环境变量读）各完成一次带工具调用的对话；没有的写明缺什么。
````

## R9：运行时分发

依赖：R3、R7

````text
任务 R9：让 codex-app-server 随应用分发，dsh（以及 R8 的 Grok Build、Gemini CLI）改为用户选用时下载（ADR-0005 决策 8、未决事项 2）。

先读：ADR-0005 决策 8；docs/upstream/UPSTREAM.md §1.2、§2.4（Codex 的 LICENSE、NOTICE，Linux 包随附 bwrap 的 LGPL 义务）与 §2.1（dsh 依赖闭包里的 MPL / LGPL）；docs/upstream/third-party-notices.md；apps/desktop 的构建配置；scripts/fetch-codex.sh（R2）；packages/adapter-dsh/src/paths.ts。

要做：
1. 先确认仓库现在有没有打包配置（electron-builder 之类）。没有就停下来，把“第一个安装包”的选型（打包工具、签名与公证、更新渠道）写成方案问维护者，本任务只做下面不依赖打包工具的部分。
2. codex-app-server：构建时按目标平台取锁定版本的二进制（复用 fetch-codex.sh 的校验和），放进应用资源目录；adapter-codex 的解析顺序变成 WEVIR_CODEX_BIN → 应用资源目录 → 开发缓存。随附 Codex 的 LICENSE 与 NOTICE，第三方声明里加上 Codex；Linux 是否随附 bwrap 按 ADR-0005 未决事项 4 的结论。
3. 可选组件的下载：设计并实现一个“组件管理”（下载、完整性校验、版本锁定、升级、删除、国内镜像），dsh 是第一个组件。下载来源（npm 镜像还是 Wevir 自己的发布物）先列出方案与体积问维护者再实现。开发环境照旧经 pnpm 安装 dsh。
4. 设置页：引擎列表显示每个引擎是否已安装、版本、占用空间，可安装与删除。

验收：在 macOS 上从干净的数据目录启动（docs/development.md 的干净环境做法），不联网也能用 Codex；dsh 下载、校验、启用、删除走一遍；测试、typecheck、lint 通过；Windows 上没验证的写明。
````

## R10：网关加 Anthropic Messages

依赖：R1 · 可并行：任意时间

````text
任务 R10：在 packages/model-gateway 里加 Anthropic Messages 上游（ADR-0005 决策 2.3），让 api=anthropic-messages 的 Provider 能接 Codex。

先读：docs/architecture/model-gateway.md；codex-notes §3.5（LiteLLM、CC Switch 怎样把 Responses 转成 Messages，尤其思考块签名放进 encrypted_content 带回）；Anthropic Messages API 的当前文档（流式事件、tool_use / tool_result、thinking 块与 signature、system、图片、stop_reason）；R1 的 Chat 转换与测试结构。

要做：
1. 请求：developer / system → system；user / assistant 消息与图片；function_call / custom_tool_call → tool_use，*_output → tool_result；custom 工具摊平成只有 input 字符串参数的工具（与 Chat 相同的规则）；namespace 摊平；reasoning 项 → thinking 块（签名从 encrypted_content 还原，缺签名时不发 thinking 块并在文档写明影响）；max_tokens 必填，取模型目录或 Provider 配置。
2. 响应：message_start / content_block_start / content_block_delta（text_delta、thinking_delta、signature_delta、input_json_delta）/ content_block_stop / message_delta / message_stop → Responses 事件；thinking 的签名放进 reasoning 项的 encrypted_content；stop_reason=max_tokens → response.incomplete；usage 映射（含缓存读写的 token）。
3. 错误、取消、日志口径与 R1 相同；testProvider 支持这种协议；adapter-dsh 的 validateProvider 不受影响。
4. DeepSeek 的 Anthropic 端点（https://api.deepseek.com/anthropic）可作为真实模型测试的上游之一。

验收：单元与集成测试（mock Messages 上游）、typecheck、lint 通过；有 Key 时跑一次带工具调用与跨回合思考的对话；model-gateway.md 补上完整映射表。
````

## R11：回合进行中发消息：插话与排队

依赖：R3 · 可并行：与 R4–R6

````text
任务 R11：让用户在回合进行中也能发消息（维护者 2026-10-14 定）。两种方式：
- 插话：像 Claude Code 那样不打断当前回合，等正在进行的这一步（模型这一段输出或这次工具调用）结束后，把消息插进同一个回合，模型接着往下做。Codex 上对应 turn/steer；引擎做不到时退化为排队。
- 排队：当前回合结束后，作为下一个回合发出。
设置里选“回合进行中按发送”的默认行为（插话或排队），另一种用快捷键或按钮。现在的 Host 在回合进行中拒收新消息（SESSION_BUSY），本任务把它改掉。

开工前先向维护者确认一句：“插话”是指“当前这一步结束后插进本回合”（Claude Code 与 Codex 的 steer 都是这样），而不是“整轮结束后再发”（那就是排队）。按回答写文档。

先读：codex-notes §2.7（运行中再输入）；upstream/codex/codex-rs/tui/src/app_server_session.rs（turn/steer {threadId, input, expectedTurnId}，以及 clientUserMessageId）、app/thread_routing.rs（不能插话时转到回合结束后）、app/app_server_events.rs（带同一 clientId 的 userMessage 完成即算插话已送达）、bottom_pane/pending_input_preview.rs（“下次工具调用后提交”“回合结束时提交”“排队的后续输入”三段预览）、chatwidget/interaction.rs（有待插话时按 Esc 会中断回合并立刻发出）；app-server-protocol/schema/typescript/v2/TurnSteerParams.ts 与响应；docs/architecture/domain-model.md §4（状态机与各状态下的命令）、host-api.md（session.send、错误码、§10 兼容规则）；packages/host/src/session-manager.ts；apps/desktop/src/renderer/src/session/composer.tsx；apps/cli/src/attach.ts。

要做：
1. 文档先行：domain-model 写清待发消息（id、内容、方式 steer / queue、状态：等待 / 已插入 / 已转为排队 / 已发送 / 已取消、顺序）、在状态机里的位置、回合以完成 / 失败 / 取消结束时排队消息怎么处理（建议：完成后自动发下一条；失败与取消后暂停，等用户确认或编辑，与 Codex 的做法对照后写定）、Host 重启后是否保留；host-api 写清 session.send 的新参数（例如 delivery: 'steer' | 'queue'，旧客户端不带时按旧行为报 SESSION_BUSY，保证兼容）、列出 / 修改 / 取消待发消息的方法与事件、默认行为设置放在哪（Host 的设置，CLI 与桌面共用）。协议升版本、加冻结样本。
2. runtime-adapter：加可选的 steer(engineSessionId, input) 与能力位；adapter-codex 用 turn/steer（带 expectedTurnId），以同一 clientId 的 userMessage 完成作为送达确认，被拒（回合不能插话）时报一个可识别的错误，由 Host 转为排队；通用 ACP 引擎与 dsh 不实现，Host 一律排队。
3. Host：每会话的待发队列与持久化；回合结束时按第 1 点的规则发下一条；待发消息的增删改事件；契约测试与 Host 测试覆盖插话成功、插话被拒转排队、排队自动发送、取消回合时的处理。
4. 桌面端：回合进行中输入框照常可用；输入框上方的待发区按“插话（等这一步结束）”“排队（回合结束后）”分组显示，可以编辑、删除、改方式；发送按钮与快捷键按设置决定默认行为（参考 Codex：回车插话、Tab 排队；以维护者确认的为准）；设置页加这一项；文案经 t()。
5. CLI：attach 里回合进行中也能输入，默认行为同设置。

验收：协议冻结样本、契约测试（codex 第 2 层用 mock 脚本做一个慢回合，中途插话与排队各一次）、Host、client-sdk、桌面端相关测试、typecheck、lint 通过；用桌面端在真实 Host 上各走一遍插话与排队，贴结果。
````

## R12：工作台布局：混合 Codex 与 Claude Code 桌面端

依赖：无 · 可并行：与 R1–R4；R5 之前做完

````text
任务 R12：把桌面端的工作台改成维护者定的样子（2026-10-14）：整体界面混合参考 Codex 桌面端与 Claude Code 桌面端；各个窗格都能调尺寸，布局随打开的窗格种类与数量动态变化。本任务先出设计、经维护者确认后再实现，两步各提交一次。

先读：本文件「界面参考」与 design-refs/ 全部截图（不够就向维护者要：Claude Code 桌面端与 Codex 桌面端的主会话视图、左栏、设置页、窄窗口下的样子）；AGENTS.md 中 apps/desktop 的目录说明；apps/desktop/src/renderer/src 下 layout/（workbench-layout.tsx、layout-rules.ts、layout-state.ts、right-panel.tsx、right-panel-tabs.ts、sidebar.tsx、sidebar-resizer.tsx、window-chrome.ts）、routes/、styles/（palette、tokens、theme）、components/ui；docs/architecture/overview.md；docs/development.md 的桌面端调试说明（远程调试端口，可用 CDP 截图）。

第一步：设计（提交一次，然后停下来等维护者确认）
1. 写 docs/architecture/desktop-layout.md：
   - 窗格模型：有哪些窗格种类（会话消息流、子智能体、文件预览、变更 / Diff、后台任务、计划与清单、设置……现在没有的写成以后的种类），每种窗格的最小尺寸、能否多开、属于哪个会话。
   - 操作：打开、关闭、拖动分隔条调尺寸、最大化与还原、拆分、窗格内标签、“已打开的标签页”列表（截图 07）、置顶摘要卡片与它的开关（截图 02、08）、键盘快捷键。
   - 动态布局规则：按打开的窗格种类与数量、窗口宽高决定排布（单窗格、左右、上下、网格、折叠到标签），给出断点与例子；窄窗口下怎样退化。
   - 状态的保存：每个工作区 / 会话记住哪些窗格与尺寸；URL 与窗格状态的关系（现在“URL 是唯一事实”的约定怎样延续）。
   - 与现有三栏布局、layout-rules.ts 的对应和迁移；macOS 红绿灯与顶栏拖动区的处理。
   - 每种布局一张线框图（ASCII 或 SVG 都行，放在文档里）。
2. 如果这改变了已有的设计依据（AGENTS.md 原来写的“以 OpenWork 为桌面交互参考”、T5.2 的三栏布局），写一份 ADR（新编号）说明。
3. 把文档与线框图交给维护者确认，确认之前不写实现代码。

第二步：实现（确认后，提交一次）
4. 布局的纯逻辑（窗格树、尺寸约束、按数量与种类排布、保存与恢复）写成不依赖 React 的模块并有单元测试，替换 layout-rules.ts 的对应部分。
5. 组件：可拖动的分隔条、窗格头（标题、标签、最大化、关闭、更多菜单）、已打开的标签页列表、置顶摘要卡片框架（内容由各功能填：变更、子智能体等）。把现有的会话视图、概览、设置放进新框架，现有功能一个不少。
6. 文案经 t()，暗色与亮色都对；用 Wevir 自己的设计 token，不拷贝截图里的素材。

不做：子智能体窗格的内容（R5）；文件预览、Diff、后台任务、终端等新窗格的内容（只留种类与占位，以后的任务做）。

验收：布局逻辑的单元测试、桌面端已有测试、typecheck、lint 通过；用 pnpm dev 在三种窗口宽度、一 / 二 / 三个窗格下各截一张图（经 CDP），与 design-refs/ 并排放进汇报。
````

