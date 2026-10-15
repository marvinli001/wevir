# ADR-0005：Agent 运行时以 Codex app-server 为主，Host 内置模型协议网关

- 状态：Accepted（2026-10-14，维护者在对话中确认；基础提示词同日定下，见补记 2）
- 日期：2026-10-14
- 任务：Codex 运行时调研；影响：新包 `packages/adapter-codex`、`packages/model-gateway`，从 `adapter-dsh` 抽出通用 ACP 适配器，`AgentEvent` 与 Host 协议的子会话扩展，桌面端的子智能体界面，打包
- 依据：[Codex 研读与 Spike](../research/codex-notes.md)（`spikes/codex-app-server/`，codex `rust-v0.162.1` = 上游 `092d3ac`）；[ADR-0001](./0001-runtime-integration.md)；[dsh 接入 Spike](../research/dsh-integration-spike.md)；[ACP → Wevir 事件映射](../architecture/acp-event-mapping.md)

## 背景

- ADR-0001 选了 dsh 的 ACP 接入。用下来的缺口：ACP 没有逐字流式（靠 Wevir 自己的 fd 3 旁路插件补）、子 agent 不可见、没有计划与标题、工具 kind 恒为 `other`、只在要越出沙箱时才审批、沙箱不限网络（T0.3、acp-event-mapping.md，codex-notes §8）。
- 维护者的目标：以 OpenAI Codex 的 agent 运行时为主、吸收 dsh 的长处，做成 Wevir 自己的运行时；兼容大多数模型协议，优先级是 ① ChatGPT 订阅登录 ② Grok（若官方支持）③ Gemini CLI 的登录 ④ 用户自定义的 Anthropic Messages、OpenAI Responses、Chat Completions 服务。
- 已经定下、本 ADR 不再讨论的：Host 保留（以后对用户完全不可见，另开任务）；引擎继续隔在 `AgentRuntimeAdapter` 后面（ADR-0001、overview.md）；语音输入先不做。
- Spike 的事实（codex-notes §2、§3、§5–§7）：
  - `codex app-server` 是 stdio 上逐行 JSON 的单进程服务，一个进程承载多个 thread；锁定版本的独立二进制在 macOS arm64 上压缩包 72 MiB、解压 181 MiB，冷启动中位 49 ms，常驻 50–93 MB。
  - 流式、apply_patch、命令与文件两类审批、跨回合推理、子 agent、取消、resume、计划、报错恢复都能通过稳定面（`experimentalApi:false`）完成；155 项检查在三种接法下全部通过。
  - Codex 只会说 OpenAI Responses（Chat 接口 2026-02-03 删除）。国内主流服务都在 2026 年出了 Codex 接入文档，但各家对自定义工具、namespace 工具、推理带回的支持不一；只有 Chat 或 Anthropic Messages 的上游要转换。
  - 一个约 490 行的最小网关把 Responses 转成 Chat，同一组场景全部通过；Responses 上游经网关透传也全部通过。真实 DeepSeek（`deepseek-flash`、`deepseek-v4-pro`）上，直连、透传、转 Chat 三条路的补丁、跨回合推理、子 agent、取消都正常（codex-notes §7.3）。
  - 默认配置下 Codex 会连 `github.com`、`api.github.com`、`chatgpt.com`（都来自插件功能），模型跑的命令能读到 Key 的环境变量；加固配置后外连为零、命令读不到。
- 条款（codex-notes §4）：ChatGPT 订阅经 app-server 自己的登录，OpenAI 只允许本地或开源应用；Google 已停掉 Gemini CLI 面向个人订阅的登录，并禁止第三方复用其 OAuth；xAI 的官方 CLI Grok Build 支持 ACP 与订阅登录；四家都不允许把令牌取出来给别的程序用。

## 决策

### 1. 引擎分工

1. 新包 `packages/adapter-codex` 实现 `AgentRuntimeAdapter`，作为**默认引擎**：每个 Host 一个 `codex-app-server` 子进程，承载该 Host 上全部 Codex 会话；进程只由 adapter-codex 启动与回收（关 stdin → SIGTERM → SIGKILL），一个 Wevir 会话对应一个 thread，`threadId` 即 `engineSessionId`。
2. 锁定**精确版本**，与 `docs/upstream/upstream.lock` 的 codex 行一致（目前 `rust-v0.162.1`）。使用 OpenAI 发布的独立 `codex-app-server` 二进制，按 sha256 校验；`@openai/codex*` npm 包若要用，只能由 adapter-codex 声明（AGENTS.md 规则 2，已写进两道 lint 检查）。
3. 从 `adapter-dsh` 抽出**通用 ACP 适配器**（进程与连接、ACP → `AgentEvent` 映射、每会话事件队列、会话与审批记账，codex-notes §8 最后一行），用来接 dsh、Grok Build、Gemini CLI 与其他 ACP agent。dsh 专属的部分（stream-tap、`DeltaMerger`、`DSH_HOME` 布局、providers overlay、resume 的错误文案）留在 adapter-dsh，作为通用适配器的一份配置。抽取是单独的任务，**不改变 adapter-dsh 现有的行为**，以它现有的三层契约测试为准。
4. 会话在创建时绑定引擎，之后不换；跨引擎只有“基于历史新建会话”这一条路（已有的 `history-digest`）。
5. **dsh 保留为可选引擎，不再加新能力**：只做安全修复、隐私修复与跟进上游所需的升级（ADR-0001 的接入方式继续有效）；不随安装包分发，用户选用时再下载（决策 8）。

### 2. Host 内置模型协议网关

1. 新包 `packages/model-gateway`，在 Host 进程里监听 `127.0.0.1` 的随机端口，对 Codex 只暴露 `POST /v1/p/<providerId>/responses`。它只依赖公开的 Responses 线上协议，不依赖 Codex 的任何包。
2. **所有经 Codex 的自定义 Provider 都走网关**，Responses 原生的也不例外。adapter-codex 生成的 `config.toml` 里，每个 Wevir Provider 对应一个 `[model_providers.wevir_<id>]`：`base_url` 指向网关，`env_key` 是 `WEVIR_GATEWAY_TOKEN`；令牌由 Host 在每次启动 Codex 进程时随机生成，只在内存里，网关校验它。上游 Key 只在 Host（`SecretStore` → 网关），不进 Codex 的环境与 `CODEX_HOME`。
3. 网关按 Provider 的协议处理请求：
   - `openai-responses`：透传。去掉请求体的 `client_metadata`，不转发 `x-codex-*`、`session-id`、`thread-id`、`originator`、`x-openai-*` 等请求头，再按服务挂方言修正（例如 xAI 的 `tools:[]` + `tool_choice`、不支持自定义工具时把 `apply_patch` 转成函数工具）。
   - `openai-completions`：按 codex-notes §5.1 的规则转换请求与流式响应，推理以 `reasoning_content` 带回上游。
   - `anthropic-messages`：同样的转换思路，映射到 Messages（思考块与签名放进 `encrypted_content` 带回）。排在 Chat 之后实现。
   - Gemini：先走 Gemini 的 OpenAI Chat 兼容端点（按 `openai-completions` 处理），原生协议以后再说。
4. 上游的非 2xx 原样转给 Codex，由 Codex 的重试策略处理；Codex 断开时网关中断上游请求。
5. `provider.test` 改由网关实现：用与正式请求相同的转换发一次最小请求。
6. 实现顺序：先做 Responses 透传（含元数据剥离与方言修正的框架）与 Chat Completions 转换，再做 Anthropic Messages；Gemini 先按 Chat 走它的兼容端点。

### 3. 不 fork Codex

用官方 release 二进制，所有协议差异在网关里解决。理由见 codex-notes §5.4：fork 要自建 6 个平台的交叉编译、签名与更新渠道，并在每个 release 上 rebase 一个约 200 万行的 Rust 工作区；网关只依赖变化慢的公开协议。只有发现网关表达不了的上游能力时才重新评估。

### 4. 登录

不提取、不转用任何厂商的 OAuth 令牌；订阅登录只走厂商自己的、未修改的客户端的登录流程，Wevir 只驱动这个客户端。

| 优先级 | 来源 | 做法 | 模型流量 |
|---|---|---|---|
| ① | ChatGPT 订阅 | app-server 的 `account/login/start`（浏览器或设备码），凭据由 Codex 存在 Wevir 专属的 `CODEX_HOME`，Wevir 不读。`clientInfo.name` 写 `wevir`。只用于本地开源形态（OpenAI 不允许商业或托管服务用 app-server 认证） | Codex 直连 OpenAI，不经网关 |
| ② | Grok 订阅 | 通用 ACP 适配器驱动 Grok Build（`grok agent stdio`），登录用 Grok Build 自己的 `grok login`，`GROK_HOME` 指向 Wevir 专属目录。xAI 的条款对第三方编排订阅额度没有明文，维护者知悉这一风险后决定照做；界面上要说明它走的是用户自己的 Grok 账号 | Grok Build 直连 xAI |
| ②′ | xAI API Key | 同样要做：Codex + 网关（Responses 透传 + 方言修正） | 经网关 |
| ③ | Gemini | **个人订阅登录已不存在**（2026-06-18 起）。只做 API Key：Codex + 网关（Gemini 的 Chat 兼容端点），或通用 ACP 适配器驱动 `gemini --acp` | 经网关，或 Gemini CLI 直连 |
| ④ | 自定义服务 | Responses / Chat Completions / Anthropic Messages，Codex + 网关 | 经网关 |
| — | DeepSeek | DeepSeek 原生支持 Responses，走 ④ 的 Responses 透传；dsh（通用 ACP 适配器）保留为可选引擎 | 经网关，或 dsh 直连 |

### 5. Codex 的配置与隔离

- `CODEX_HOME=<Wevir 数据目录>/engines/codex`（事先建好），进程 cwd 也是它；子进程环境按白名单构造，与 adapter-dsh 的 `env.ts` 同一套做法。
- `config.toml` 由 adapter-codex 生成，至少包含（codex-notes §6）：
  - `[features] plugins = false`（唯一产生外连的开关）、`web_search = "disabled"`、`[analytics] enabled = false`、`check_for_update_on_startup = false`；
  - `[shell_environment_policy] ignore_default_excludes = false`，`exclude = ["WEVIR_*"]`；
  - `tools.update_plan.enabled = true`（计划默认关）；
  - `approval_policy = "on-request"`、`sandbox_mode = "workspace-write"`；不开 `memories` 与 `approvals_reviewer = "auto_review"`（它们会用写死的 OpenAI 模型名）；
  - `model_catalog_json` 指向由 Provider 的模型列表生成的目录（`apply_patch_tool_type:"freeform"`、上下文大小、推理档位、基础提示词）。
- **只用稳定面**：`initialize` 时 `experimentalApi:false`。子智能体界面（决策 6.1）用稳定面就能做：子 thread 的事件自动推到连接上，父子关系来自 `collabAgentToolCall.receiverThreadIds` 与 `thread/read` 的 `parentThreadId`。以后某项功能确实需要实验面，单独评估并在补记里写明。
- 首次启动后核对外连为零（Spike 的 `network-audit.ts` 做法），作为升级检查的一项。

### 6. 事件映射

按 codex-notes §10 的表实现。`AgentEvent` 与 Host 协议需要的扩展各开任务，先改 domain-model 与 host-api 文档再改代码。

#### 6.1 子 agent：协议里是子会话，界面照 Codex 桌面端

子 agent 在协议里是**父会话下的子会话**，不折叠成工具卡片。界面参照 Codex 桌面端（维护者 2026-10-14 给的截图）：

- **父会话的消息流**里，每个子 agent 有两条行内标记：“〈标题〉开始工作”与“〈标题〉已完成”（失败、被关闭同理），点开进入该子 agent。
- **右栏新增“子智能体”标签**（`right-panel-tabs.ts` 的每会话标签之一），按“已开启 · N”“完成 · N”分组列出，每项有图标、标题、相对时间；没有时显示“没有已开启的子智能体”。会话顶部的摘要卡片显示“子智能体 · N 完成”与头像。
- **子 agent 视图**：返回箭头、标题、模型与推理强度、用时，下面是它自己的消息流（逐字流式、工具卡片、审批与父会话相同）。只读，没有输入框；与它交互只经父 agent（`send_input` 等由模型发起），取消父回合即取消它。
- 标题：优先用 Codex 给的 thread 名称；没有时取 `spawn_agent` 的任务描述首行，再没有就用 `agentNickname`。

需要的改动（各自成任务）：
- `AgentEvent`：子会话的出现（父会话、触发它的工具调用、标题、模型、推理强度）与状态变化；子会话自己的事件照常按它的 `engineSessionId` 上报。adapter-codex 从 `collabAgentToolCall`（`receiverThreadIds`、`agentsStates`）与子 thread 的 `turn/started`（`rootTurnId`）识别子会话。
- Host 协议与存储：会话加 `parentSessionId`；子会话不出现在左栏的会话列表，`session.get` / 订阅照常可用，父会话快照带子会话摘要（数量、各自状态）。
- 通用 ACP 引擎没有子会话（dsh、Gemini CLI 的子 agent 不产生更新），这一块只对 Codex 生效。

#### 6.2 其他扩展

- 工具被拒绝：`tool.finished` 只有 completed / failed，Codex 有 `declined`。
- 计划：`turn/plan/updated` 没有工具调用 id，`todo.updated.toolCallId` 要放宽。
- 审批选项：accept / acceptForSession / decline / cancel 映射为 `approval.requested` 的选项；`serverRequest/resolved` 在回合结束之后才到，映射为 `approval.cancelled`。

### 7. 版本与升级

- 升级只改 adapter-codex、lock 与本 ADR 的补记。步骤：读 release 说明 → 用新版本的协议 schema（`codex-rs/app-server-protocol/schema/`）与旧版本 diff → 跑契约测试 → 外连审计 → 更新 UPSTREAM.md。
- 契约测试照 adapter-dsh 分三层：录制回放；真实 `codex-app-server` + 本地 mock 模型（Spike 的 harness 产品化）；真实模型（要 Key，不进 CI）。网关另有自己的转换测试（mock 上游）。

### 8. 分发

- 每个平台的安装包**内置**对应的 `codex-app-server`（压缩约 72–82 MiB、解压 181–243 MiB，codex-notes §1），随 Wevir 版本一起升级；不在运行时从网上下载 Codex。
- dsh **不随安装包分发**，改为用户在设置里选用时下载（需要国内镜像与完整性校验；具体做法由打包任务定，见未决事项）。
- 随包附 Codex 的 `LICENSE` 与 `NOTICE`；Linux 包若带 `bwrap`，按 LGPL-2.0 提供源码获取方式（UPSTREAM.md §2.4）。

## 备选方案

| 方案 | 不选的理由 |
|---|---|
| 继续只用 dsh | 缺口见背景；dsh 自己也是 developer preview，ACP 面窄 |
| Codex 经 `@agentclientprotocol/codex-acp` 接通用 ACP 适配器 | 现成可用、复用 ACP 管道，但多一层 Node 进程与一个更新很快的依赖；ACP 表达不了 thread list / fork、审批的细粒度选项、子 agent 关系 |
| `@openai/codex-sdk`（起 `codex exec --experimental-json`） | 一次一个回合的进程，没有服务端发起的审批往返与多会话 |
| app-server 的共享 daemon 模式 | 实验性，官方说明不提供按客户端的环境隔离，还带自动更新 |
| Responses 原生的上游直连 Codex、只有 Chat / Messages 走网关 | 少一跳，但 Key 进 Codex 的环境变量（模型跑的命令可能读到，要靠 shell 环境排除兜底），Codex 的元数据（installation_id 等）发给第三方，方言修正无处可放 |
| 嵌入现成网关（LiteLLM、CC Switch 的代理） | LiteLLM 是 Python 服务，CC Switch 的代理在 Tauri 应用里，都要另起进程、另管配置与 Key；转换规则本身不复杂（Spike 约 490 行），自己实现更可控 |
| fork Codex 加回 `wire_api="chat"` | 见决策 3 |

## 后果

收益：
- 逐字流式、推理、计划、子 agent、细粒度审批、跨平台沙箱（含网络限制）都由引擎原生提供，不再需要 stream-tap 这类旁路。
- 一个网关覆盖 Responses、Chat、Messages 三类上游；Key 只在 Host；发给第三方的元数据由 Wevir 控制。
- 订阅登录全部走厂商官方客户端，不碰令牌；Grok 订阅仍属条款上的灰色地带（决策 4）。

代价与风险：
- **体积**：每个平台的安装包多出 `codex-app-server` 的压缩约 72–82 MiB（解压 181–243 MiB）；dsh 移出安装包，抵掉它的依赖闭包（决策 8）。
- **上游节奏**：约每月 10 个小版本，app-server 仍标 experimental，2026 年已有三次删除。对策：锁版本、只用稳定面、三层契约测试、schema diff。
- **转换的正确性归 Wevir**：DeepSeek 上已验证（codex-notes §7.3：三种接法、两个模型），其他服务的推理带回与工具细节要逐家用真实模型验证。
- **OpenAI 专属残留**：写死的 OpenAI 模型名、ChatGPT 相关的通知与功能，靠配置关掉并在升级时复查。
- **ChatGPT 订阅的使用范围**：只限本地开源形态；Wevir 以后若有商业或托管形态，这条路要下线或改走 SIWC 的合规要求。
- **Windows 与 Linux 沙箱**：只在 macOS 上验证过；Windows 的旧沙箱要提权安装，MXC 依赖系统版本；Linux 随包的 `bwrap` 是 LGPL。

## 未决事项

1. ~~**基础提示词**~~：已定，经网关的第三方模型用 Wevir 自己的提示词，见补记 2。
2. **dsh 的可选下载**：从哪里下载（npm 镜像还是 Wevir 自己的发布物）、怎样校验与升级，由打包任务决定。在那之前开发环境照旧经 pnpm 安装 dsh。R9 起草时维护者选了 npm registry 逐包下载，随后决定推迟（[ADR-0007](./0007-packaging-and-runtime-distribution.md) 决策 6、未决事项 4）。
3. **Sign in with ChatGPT（应用自己注册 client ID）**：先不做，只用 app-server 自带的登录；Wevir 有了需要它的形态时再评估。
4. **Windows 与 Linux 沙箱**：由 adapter-codex 任务在两个平台上实测后补记（Windows 选 MXC 还是旧沙箱、Linux 是否随包带 `bwrap`）。
5. **计划模式怎样下发**：Codex 的协作模式（`turn/start.collaborationMode`、`thread/settings/update.collaborationMode`）是实验面。开这一项实验面（写补记）就能用上 Codex 原生的计划模式：只在计划模式提供的 `request_user_input`，以及把 `<proposed_plan>` 解析成计划条目；不开就由 Wevir 自己做，计划回合用稳定面的 `sandboxPolicy` 设为只读、把 `prompts/plan-mode.md` 放在用户消息前面，提问退回纯文本、计划要 Wevir 自己从消息里解析。做计划模式的任务决定。

## 补记

1. **2026-10-14，起草 R1–R10 的任务 prompt 时读了 Codex 的终端界面（codex-notes §2.7）。** 不改变决策，补三点：
   - Codex 自己的客户端打开了实验面（子 agent 选择器、`canAcceptDirectInput`、审批的 `availableDecisions` 都是实验字段）。Wevir 仍只用稳定面：子会话从 `collabAgentToolCall` 与子 thread 的事件识别，重启后靠 Host 自己的记录；审批用默认的四个选项。
   - `features.goals` 默认开启，模型会拿到三个目标工具。Wevir 暂不支持目标，配置里加 `[features] goals = false`（决策 5 的加固项之外新增一项，R2 核实）。
   - 子 agent 的审批要能在父会话里处理（决策 6.1 的子 agent 视图是只读的）；服务端不生成会话标题，标题由 Wevir 自己生成。
2. **2026-10-14，基础提示词定下（未决事项 1）。** 维护者决定 Wevir 写自己的提示词，放在仓库根目录的 [`prompts/`](../../prompts/README.md)：
   - 经网关的第三方模型用 `prompts/base.md`，由 adapter-codex 写进生成的模型目录的 `base_instructions`。它自称 Wevir 并如实报出底层模型与 Provider；工具说明按决策 5 与补记 1 的配置写（联网搜索、目标、插件关闭，`update_plan` 打开，子智能体用 `multi_agent_v1`），配置变了要同步改。ChatGPT 登录的 OpenAI 模型仍用 Codex 内置的、按模型调好的提示词。
   - 同时写了计划模式（`plan-mode.md`，下发方式见未决事项 5）、审批自动复核（`auto-review.md`，由 Host 调模型，替代决策 5 不开的 `approvals_reviewer = "auto_review"`；结论只映射为“本次允许”或“拒绝并说明理由”）、会话标题（`thread-title.md`，由 Host 用当前会话的模型生成，见补记 1），以及内置浏览器、Chrome、电脑操作三个插件的技能说明草稿（`prompts/plugins/`，插件未建，工具清单留占位）。MCP、skills、插件与联网搜索在 `base.md` 里留了占位。
   - `base.md`、`plan-mode.md`、`auto-review.md`、`thread-title.md` 改写自 Codex 开源仓库的模板（Apache-2.0），按 UPSTREAM.md §4、§5 登记并写文件头，`NOTICE` 收录 Codex 的署名与 Apache License 2.0 全文。
3. **2026-10-14，模型协议网关（R1，`packages/model-gateway`，[model-gateway.md](../architecture/model-gateway.md)）。** 决策 2 照做，以下是决策没写到或与字面不同的地方：
   - **两个新的 compat 开关只在网关里**：`supportsCustomTools`（Responses 上游不支持自定义工具时摊平）与 `systemMessageMode`（Chat 上游只认开头一条 system 时合并或转成 user），类型是网关的 `GatewayCompat`。Host 协议的 `ProviderCompat` 与 `@wevir/runtime-adapter` 的 `ProviderCompatConfig` 还没有它们：加进协议要升次版本；adapter-dsh 会拒绝它不认识的 compat 开关（dsh 拒绝整份 overlay），所以加的时候 adapter-dsh 要跳过这两个。留给接进 Host 的 R2（xAI 用得到，R8）。
   - **`deepseek-official` 固定透传到 `https://api.deepseek.com/responses`**，不用 Provider 的 `baseURL`：那个字段对 dsh 是 Anthropic Messages 的地址（providers.md §2.2），协议不同。要给 Codex 的 DeepSeek 换地址（代理等），用 `openai-compatible` + `openai-responses`。provider.test 对这类 Provider 因此测的是 Responses 端点，不再是 dsh 用的 Messages 端点。
   - **令牌每个网关实例生成一次**（`gateway.token`），不是每次启动 Codex 进程生成。要做到决策 2.2 的“每次启动 Codex 进程时随机生成”，adapter-codex 在启动 Codex 进程时新建一个网关实例（只是起一个本机 HTTP 监听），由 R2 决定。
   - **方言修正**：“没有工具时去掉 `tool_choice`”对所有 Provider 生效，不设开关（没有工具时它本来没有意义；样本证实 Codex 的压缩请求就是 `tools: []` + `tool_choice: "auto"`）。其余服务的修正（MiniMax 的 `effort: none`、思考开关）还没做。
   - **Chat 转换补的规则**：`reasoning.effort` 发成 `reasoning_effort`（`none` 不发），`compat.thinkingFormat` 不处理；`parallel_tool_calls` 与函数的 `strict` 不发（兼容性）；`finish_reason: length` → `response.incomplete`，Codex 把它当作流错误按自己的策略重试，与 OpenAI 上游相同；Provider 没有 Key 时网关直接回 401，不带空 Key 去请求上游（本机不校验 Key 的服务填任意值，与 dsh 相同）。
   - **验证**：除本包的单元与集成测试外，Spike 加了 `WEVIR_SPIKE_GATEWAY=product`，让真实 `codex-app-server` 经产品网关跑 12 个场景，gateway / passthrough 两种接法 104 项检查全部通过；真实模型的用例写好了，本次没有 Key，没有执行。
4. **2026-10-14，网关加 Anthropic Messages（R10，[model-gateway.md](../architecture/model-gateway.md) §5）。** 决策 2.3 照做（思考块与签名放进 `encrypted_content` 带回），以下是决策没写到的地方：
   - **信封记下 Provider 与模型**：`encrypted_content` 是 `wevir-gw:anthropic:v1:` 加 `{provider, model, type, thinking, signature}`（或 redacted 的 `data`）的 base64。只有同一个 Provider ID、同一个模型名的思考块才带回，与 dsh 对 DeepSeek 的做法相同（换了模型不带签名）。**缺签名时不发思考块**：来自 Chat 转换、Responses 上游、别的 Provider 或模型的推理，以及上游没给签名的思考，都不带回；影响写在 model-gateway.md §5.3。
   - **对话中间的 developer 消息默认转成 user 消息**（不是并进顶层 `system`）：只追加，提示词缓存不失效，也不触发 Anthropic 对思考块的前缀校验。`systemMessageMode: merge` 可改；`inline` 在 Messages 上没有对应，按 `user` 处理。
   - **思考开关复用协议已有的 `compat.thinkingFormat`**：`anthropic-messages` 上取 `adaptive` 或 `enabled`（`validateProvider` 检查），不设时模型 ID 以 `claude-` 开头用 `adaptive`，其余用 `enabled` + `budget_tokens`（DeepSeek 等兼容服务）；`reasoning.effort` 进 `output_config.effort`，`none` 发 `thinking: disabled`。协议与 Host 不用改。
   - **`max_tokens`**：Codex 不发，取 Provider 里这个模型的 `models[].maxTokens`，没写时 32000。
   - **补的规则**：认证头是 `x-api-key`（不发 `Authorization`）；地址 `<baseURL>/v1/messages`（已以 `/v1` 结尾时只加 `/messages`）；历史里有工具调用而本次没有工具时（压缩请求）补同名占位工具并 `tool_choice: none`；不合 Anthropic 规则的 `call_id` 换成确定性哈希；`system` 与最后一条消息各放一个 `cache_control` 断点；usage 的缓存读写进 Codex 的 `cached_tokens` / `cache_write_tokens`；`stop_reason: refusal` → `content_filter`，`model_context_window_exceeded` → `context_length_exceeded`。
   - **验证**：单元与集成测试用按 Anthropic 结构规则检查请求的 mock 上游（签名对不上、`tool_result` 位置不对、没定义工具都回 400）；DeepSeek Anthropic 端点的真实模型用例写好了（含工具调用与跨回合思考），本次没有 Key，没有执行。
5. **2026-10-14，adapter-codex（上）（R2，`packages/adapter-codex`，[codex-event-mapping.md](../architecture/codex-event-mapping.md)）。** 决策 1、2、5 照做，以下是决策没写到或与字面不同的地方：
   - **Provider 变更不总要重启**（决策 2.2 与“照 dsh 重启”的预设）：实测 `thread/start` 的 `config` 覆盖能带上进程启动之后新增的 `model_providers.<id>`，而 `base_url` 只取决于 Provider ID，上游地址、Key、协议的变化交给网关就够了，这些都不重启。但模型目录只在进程启动时读一次（`config` 里覆盖 `model_catalog_json` 实测无效，新模型拿到未知模型的默认元数据，没有 apply_patch），所以**模型目录变了**才照 dsh 的做法空闲时重启、会话以 `engine.exited`（`config_changed`）脱开。
   - **网关实例每次启动 codex-app-server 新建一个**（补记 3 留给 R2 的选择），令牌随之换新，满足决策 2.2 的字面；旧进程停了它的网关一起关。网关令牌经 Host 日志的 `addSecret` 抹掉。
   - **用户级目录**：`HOME` 用用户真实的家目录（命令的 shell 快照要读用户的 rc，PATH 等才完整）。核实下来 Codex 在 `CODEX_HOME` 之外只会把 `~/.agents/skills` 带进上下文（实测用户给别的工具装的 skills 全部列给了模型），没有 dsh `DSH_AGENTS_HOME` 那样的变量能改位置，所以在决策 5 的加固项之外新增 `skills.include_instructions = false` 与 `skills.bundled.enabled = false`（与 base.md“skills 列表为空”一致）；另外把默认就关的 `features.memories = false`、`approvals_reviewer = "user"` 写出来。缺口：用户在消息里显式写 `$<skill 名>` 时那个 skill 仍会进上下文；只给 app-server 换 HOME 能完全隔离，但 shell 快照读不到用户的 rc（实测 PATH 少条目），没有采用。Wevir 建自己的 skills 时要重新处理（codex-event-mapping.md §1.3）。
   - **基础提示词**：除了模型目录的 `base_instructions`，`thread/start` 的 `baseInstructions` 按会话的 Provider 与模型再给一次：模型目录按 slug 去重，同名模型只有一条，显示名可能是别的 Provider 的。
   - **R2 的审批**：服务端的审批请求一律回复 `decline` 并告警（越出沙箱的操作被拒绝，工作区内的补丁与沙箱内的命令不受影响），其余服务端请求回复“不支持”；R3 实现审批。子 thread 的通知按 `engine.raw`（`kind: child_thread`）挂在父会话上，增量丢弃，R4 改为子会话。
   - **还没做的**：补记 3 的两个网关 compat 开关（`supportsCustomTools`、`systemMessageMode`）仍没进 Host 协议与 `ProviderCompatConfig`（R2 的任务 prompt 没列这一项；加进协议要升版本、adapter-dsh 要跳过它们），留给用得到它们的 R8 或单独的协议任务。Windows 与 Linux 沙箱（未决事项 4）本次没有实测：只在 macOS 上跑过，CI 的 Windows job 下载二进制并跑契约第 2 层与外连、密钥检查，结果要看第一次 CI。
   - **验证**：单元测试（8 个真实二进制录的通知样本回放）、契约第 2 层（真实 `codex-app-server` + 网关 + mock 模型，不需要审批与恢复的 9 条全过）、集成测试（握手、Provider 变更的三种情况、审批回复、子 thread、版本核对）、外连与密钥（外连为零，反例打开 plugins 时抓到 3 个域名；令牌与 Key 不在数据目录任何文件、stderr 与日志里；命令里 `WEVIR_*` 为 0）；`wevir-host --adapter codex` 经 CLI 与桌面端（`pnpm dev` 附着）各跑通一问一答与一次工具调用。
6. **2026-10-14，`~/.agents/skills` 的取舍（补记 5 留下的缺口，维护者交给实现方定）。** 维持补记 5 的做法：skills 列表不进上下文（静默进入的路径关掉），用户在消息里显式写 `$<skill 名>` 时照 Codex 的语义把那个 skill 放进上下文。理由：显式点名是用户有意的动作，`~/.agents/skills` 是多个 Agent 共用的标准位置；要挡住它，Wevir 得照 Codex 的发现规则枚举用户的 skills 逐个写 `[[skills.config]]` 禁用规则，规则一变就漏、运行中新装的也挡不住；只给 app-server 换 HOME 会让命令丢掉用户 rc 里的 PATH，在 Windows 上也不成立。Codex 的 skill 检索实验（`features.skill_search`）只在本机打分记指标，不进上下文、不联网，不另外关。Wevir 做 skills 管理时再用 `[[skills.config]]` 把用户的选择交给 Codex、打开 `include_instructions`。adapter-codex 的外连与密钥测试里加了回归用例（canary skill 不被列出、显式点名时进入上下文），详见 codex-event-mapping.md §1.3。
7. **2026-10-14，网关的两个 compat 开关进 Host 协议（补记 3、5 留下的事，维护者交给实现方定）。** `supportsCustomTools` 与 `systemMessageMode` 加进协议的 `ProviderCompat`（协议 0.4.0，optional，冻结样本 `compat/0.4.0.json`）与 `@wevir/runtime-adapter` 的 `ProviderCompatConfig`；网关的 `GatewayCompat` 因此与协议同形。不选“只在网关里按地址自动判断”：经代理或自建网关接入时地址认不出服务，用户与国内服务模板（`provider-presets.ts`）都需要一个能写下来的开关；按地址补默认值可以以后在网关里加（xAI 在 R8）。adapter-dsh 接受但忽略这两个开关（`GATEWAY_ONLY_COMPAT`：不报错、不写进 overlay），同一个 Provider 可以在两个引擎之间共用。桌面端的 Provider 表单原样保留 compat，暂不提供编辑控件（模板在 R8 用得到时加）。验证：协议的 schema 与冻结样本测试、Host 原样保存并交给引擎、dsh 不写进 overlay 也不报错、真实 `codex-app-server` 在 `supportsCustomTools: false` 的 Responses 上游上照常应用补丁（apply_patch 摊平成函数）。
8. **2026-10-14，adapter-codex（下）（R3，`packages/adapter-codex`，[codex-event-mapping.md](../architecture/codex-event-mapping.md) §4、§6.6、§6.7、§7）。** 决策 6、7 照做，Host 的默认引擎改为 Codex（`wevir-host` 不带 `--adapter` 就是 codex，桌面端拉起的 Host 随之是 Codex；dsh 用 `--adapter dsh`）。以下是决策没写到或与字面不同的地方：
   - **审批选项**（决策 6.2）：`availableDecisions` 是实验字段，选项照 Codex 终端界面固定：命令四个（`accept`、`acceptForSession`、`decline`、`cancel`），补丁三个（没有 `decline`，与终端界面相同）。`optionId` 就是回给 app-server 的决定，`kind` 由适配器定为 `allow_accept`、`allow_accept_for_session`、`reject_decline`、`reject_cancel`（Host 按前缀判断批准与否），客户端不认识这些 kind，显示适配器给的中文 `label`（“是，继续”“否，告诉它换个做法”等）。“以后以这个前缀开头的命令不再问”（execpolicy 修订）与网络策略修订没做，要 Host 记规则。`item/permissions/requestApproval` 核实只来自 `request_permissions` 工具（`features.request_permissions_tool`，UnderDevelopment、默认关），不会出现，仍回复“不支持”。子 agent 的审批 R4 之前一律拒绝。
   - **审批详情的理由**：实测 app-server 在审批请求之前就发了这个 item 的 `item/started`（命令原文、cwd、commandActions，补丁的 diff），只有模型给的理由（`reason`）在请求里。没有改 `AgentEvent`：适配器在 `approval.requested` 之前发一条 `tool.updated`，输入加上 `justification: <reason>`（与模型调 `exec_command` 时的参数同名）；Host 改为审批详情取工具最新的展示与输入（`tool.updated` 也更新它记的工具），domain-model.md §3.4、§5 随之改。
   - **`serverRequest/resolved` 在 `turn/completed` 之后才到**（决策 6.2）：events.ts 规定回合之间只能有 `engine.raw` 与 `engine.exited`，所以回合结束时仍未决的审批在终结事件之前以 `approval.cancelled`（`turn_ended`）结束，适配器记得请求与审批的对应，之后到的 `serverRequest/resolved` 按已结束处理、不告警；取消时先结掉未决审批、不回复，`turn/interrupt` 让 app-server 自己收回。回合中途收回的（`serverRequest/resolved` 先到）同样以 `turn_ended` 结束。回合以 `interrupted` 结束时还没 `item/completed` 的工具（审批挂起时取消的命令、选了“告诉它换个做法”的补丁）按 `failed` 收尾。
   - **计划**（决策 6.2 写的是“`todo.updated.toolCallId` 要放宽”）：没有放宽，`toolCallId` 合成为 `plan:<回合 ID>`，客户端只按回合取最新的计划，不按它找工具；`AgentEvent` 不变。步骤状态 `inProgress` 换成 `in_progress`。
   - **回合失败的归类**：网关在 Provider 没有 Key 时回 401（`wevir gateway: Provider … 没有 API Key`）→ `missing_credentials`；`codexErrorInfo` 带上游状态码的变体、上游报的几类、`other` 而原文是上游错误体 → `provider`；其余 `unknown`。`turn.failed.code` 写上游的 HTTP 状态码。`error` 带 `willRetry: true` 的只留 engine.raw。
   - **恢复**：`thread/resume` 带与 `thread/start` 相同的设置与 `excludeTurns`。Codex 不比较 cwd（它是覆盖），所以没有 dsh 那样的“cwd 不一致”；`no rollout found` 与不是 UUID 的 ID → `session_lost`（`not_found`），rollout 读不出元数据 → `session_lost`（`corrupted`），thread 正在卸载时重试。缺口：Codex 在第一条用户消息时才写 rollout，建了会话、还没对话引擎就重启了，这个会话恢复时也是 `not_found`，会被标为只读（桌面端与 CLI 都是建会话后立即发送，很少遇到）。
   - **取消得不到确认**：时限沿用 4 s（先于 Host 的 5 s），到时重启进程，会话以 `engine.exited`（`cancel_unconfirmed`）脱开，与 dsh 相同。
   - **会话标题**（补记 1、2）：适配器加可选方法 `generateTitle`（`AgentRuntimeAdapter`），Host 读 `prompts/thread-title.md`、组输入、解析与整理输出（`packages/host/src/title.ts`），dsh 不实现、只有截断的标题。经网关的会话由适配器经自己持有的网关直接发一次不带工具的 Responses 请求（不占用会话的 thread）；不经网关的会话（R6 的 ChatGPT 登录）用临时 thread（`ephemeral` + `outputSchema`，照终端界面），现在只有测试走这条路。协议升到 0.5.0：`TitleSource` 加 `generated`，按 host-api.md §10 用能力位 `title_source_generated` 门控（旧客户端看到 `first_prompt`），`session.title_changed` 加 `description`。
   - **`engine.raw` 的协议**：R2 起 Host 只接受 `protocol: 'acp'` 的 engine.raw，Codex 的（`turn/diff/updated` 等）每条都被丢弃并记一条错误日志；默认引擎换成 Codex 前修掉：协议 0.5.0 把 `engine.raw.protocol` 放开为字符串，Host 原样写下。旧客户端跳过它认不出的那几条（engine.raw 只是调试信息，不门控）。
   - **验证**：契约第 1 层（新写的假 app-server 回放真实二进制录的样本，18 条全过）、第 2 层（真实 `codex-app-server` + 网关 + mock 模型，能力开关全开，18 条全过）、第 3 层（真实模型，本次没有 Key，跳过并打印原因）；审批、恢复与取消、计划与错误、标题的集成测试；Host 经 `wevir-host`（默认引擎）跑通一问一答、工具调用与模型生成的标题；桌面端走了一遍：工作区外写文件的审批（同意、拒绝、本会话同意后同一命令不再问、告诉它换个做法）、流式中途取消、停掉 Host 再启动后在同一会话继续（下一回合的模型请求带着完整的历史）。
9. **2026-10-14，子会话（R4，[domain-model.md](../architecture/domain-model.md) §3.3.1、§4.5、§5 第 8 条，[host-api.md](../architecture/host-api.md) 0.6.0，[codex-event-mapping.md](../architecture/codex-event-mapping.md) §6.5）。** 决策 6.1 的协议部分照做（子会话带 `parentSessionId`、不进默认的会话列表、`session.get` 与订阅照常、父会话快照带子会话摘要），以下是决策没写到或与字面不同的地方：
   - **取消父回合时 Codex 不动子 agent**（决策 6.1 写的是“取消父回合即取消它”）：在 `rust-v0.162.1` 上实测，对父 thread 发 `turn/interrupt` 只结束父回合（`wait` 没有 `item/completed`），子 thread 的回合照常跑到 `completed`，子 thread 挂着的审批一直挂着；对子 thread 发 `turn/interrupt` 才结束子回合。决策不变，由 **Host 级联**：对父会话的 `session.cancel`、`session.close` 与 Host 优雅退出，Host 同时按 #5 取消它每个活动中的子会话（递归，引擎侧是对子 thread 的 `turn/interrupt`），父会话空闲而子会话还在跑时 `session.cancel` 也会取消它们；子会话不随父会话关闭。
   - **子会话不能单独停止**：子会话只读，客户端对它的 `session.send` / `cancel` / `close` / `resume` 一律 `INVALID_STATE`（`data.parentSessionId`）。Codex 的终端界面允许在子 agent 视图里直接中断它的回合；要不要给子会话单独的停止按钮由维护者定，R4 不加（Host 级联取消已经用到对子会话的 `cancel`，加按钮只是放开这一条）。
   - **子会话的审批**（补记 1）：审批属于子会话（`approval.requested` / `approval.resolved` 在子会话的流里），父会话的流里每次随 `subagent.updated` 带上子会话全部未决审批的副本（摘要的 `pendingApprovals`），客户端在父会话里显示并用 `approval.respond` 回复，任何连接都能回；父会话的状态不因此变成 `awaiting_approval`。
   - **认出子 agent**（决策 5 写的是 `receiverThreadIds` 与 `thread/read` 的 `parentThreadId`）：父子关系只用 collab item——`spawnAgent` 的 receiver 立即认，`wait` / `closeAgent` / `sendInput` / `resumeAgent` 的 receiver 要等 `item/completed` 的 `agentsStates` 报出状态（`notFound` 的跳过，实测 `wait` 一个不存在的 ID 时 `item/started` 就列出了它）；子 thread 的 `turn/started` 早于 spawn 完成到达时按 `rootTurnId` 当场认出；认出之前的通知先存着。`thread/read`（稳定面）只用来补昵称、角色与名称，`parentThreadId` 不需要读。Codex 默认 `agents.max_depth = 1`，Wevir 不改；协议与 Host 支持嵌套。
   - **标题**：兜底照决策 6.1 的顺序（thread 名称 → `spawn_agent` 任务描述首行 → `agentNickname`），`titleSource` 记为 `first_prompt`（与首条消息截断的标题同属“自动的兜底”，之后可被生成的标题替换）；认出时只有任务描述，名称与昵称来自随后的 `thread/read`。Wevir 不给子 thread 设名称，实际几乎总是任务描述首行。之后照 R3 用会话的模型生成标题，输入是任务描述。
   - **事件**：`AgentEvent` 加 `subagent.started`、`subagent.updated`（父会话的流）与 `turn.started`（子会话的流：引擎开始的回合，带 `input`）；`WevirEvent` 加 `subagent.started`、`subagent.updated`（父会话的流，完整摘要），`session.created` 加 `parent`、`turn.started` 加 `input`（子会话没有 `user.message`）。协议 0.6.0，都是新类型、新事件或 optional 字段，不需要能力位；旧客户端看不到子会话，也回不了子会话的审批。存储加迁移 `0002_subagents`（`parent_session_id`、`parent_tool_call_id`）。契约测试加能力开关 `subagents`（Codex、echo 为 true，ACP 引擎为 false），第 1 层的假 app-server 不模拟子 thread 的审批与中断，子会话的条款在第 2 层跑。
   - **验证**：协议的 schema 与冻结样本 `compat/0.6.0.json`；契约（echo 全过；Codex 第 2 层 21 条全过，含子会话 3 条）；adapter-codex 的回放（3 个子 agent 样本，含按 rootTurnId 认出）与真实二进制测试（spawn → wait、不等子 agent、`close_agent`、取消父回合时子 agent 不受影响、notFound）；Host 的状态机、审批、级联取消、关闭、重启后的子会话；Host + 真实二进制的端到端（`cli.codex.subagent.integration.test.ts`）；CLI attach 的“子 agent 开始工作 / 完成”与子会话的审批。界面（R5）没做。
10. **2026-10-14，桌面端子智能体界面（R5，[desktop-layout.md](../architecture/desktop-layout.md) §2.1、§5.2、§10，[domain-model.md](../architecture/domain-model.md) §8）。** 决策 6.1 的界面部分照 Codex 桌面端的截图做（`design-refs/` 01–04、06–08），放进 R12 的窗格布局（ADR-0006）。以下是决策没写到或与字面不同的地方：
   - **“子智能体”是一种窗格**（决策写的是 `right-panel-tabs.ts` 的一个标签，R12 已把右栏换成窗格区）：列表与详情在同一个标签里，详情由 URL `/workspace/:wid/session/:sid/agent/:childId` 决定，主窗格仍是父会话（截图 04 的样子）；进出详情是路由的变化，“后退”能撤回，关掉这个标签回到父会话的地址。
   - **“已完成”在子 agent 真正结束的位置**：client-sdk 的投影在子会话离开 `running` 时，于父会话当时的回合（父会话空闲时是一条系统消息）加一个“结束”部件，所以“开始工作”与“已完成”之间可以夹着父 agent 的其他活动（截图 01）。完成之后被父 agent 关闭不再多一行；运行中被关闭、取消或失败各有说法（“已关闭”“已取消”“运行失败”）。
   - **藏起 collab 工具卡片的规则不认引擎的工具名**：派出了某个子会话的那次调用总是藏起来；会话有子会话时，其余 `sub_agent` 展示类型的调用（等待、关闭、发消息等）也藏起来，失败的除外（它没有对应的子会话，卡片是唯一的线索）。没有子会话的会话（dsh 等 ACP 引擎）照常显示子 agent 的工具卡片。
   - **子会话的审批**（补记 1、9）：父会话输入框上方的审批区把自己的与子会话的审批按请求先后排在一起，来自子会话的标出“来自子智能体 〈标题〉”与头像，并能跳到它的视图；子 agent 视图里同样能处理（只读指的是没有输入框）。子会话的审批被另一端处理后，父会话这边不提示由谁处理（父会话的流里只有摘要）。
   - **头像**：由会话 ID 确定地选出 Wevir 调色板里的七种颜色之一与八种几何形状之一（`session/avatar.ts`），不用 Codex 的图标；为此调色板加了青、紫、湖蓝、粉四个 Radix 色系，只给头像用（tokens.css 的 `--avatar-N`）。U1（2026-10-14）起改为方向稿「A 静器」的头像配色，不再用 Radix（docs/design/desktop-tokens.md §2）。
   - **没做**：子会话单独的停止按钮（补记 9，仍待维护者定）；Codex 详情里的复制、朗读、反馈按钮与“用时 ›”的展开（Wevir 的消息流还没有这些）。
   - **验证**：纯逻辑的单元测试（标题与状态的说法、分组与排序、相对时间与用时、要藏的工具卡片、审批合并、头像选择、路由）；投影的“结束”部件；`pnpm dev` 连真实 Host（Codex 引擎 + mock 模型的 spawn → wait）经 CDP 截图，亮暗两套。
10. **2026-10-14，ChatGPT 订阅登录（R6，[codex-event-mapping.md](../architecture/codex-event-mapping.md) §8，[host-api.md](../architecture/host-api.md) 0.7.0，[domain-model.md](../architecture/domain-model.md) §3.6）。** 决策 4 第 ① 行照做（app-server 自己的 `account/login/start`，浏览器与设备码两种；`clientInfo.name` 是 `wevir`；Wevir 不读、不转交令牌；模型流量由 Codex 直连 OpenAI），以下是决策没写到或与字面不同的地方：
   - **两个 codex-app-server 进程**（改写决策 1.1 的“每个 Host 一个进程”，维护者 2026-10-14 定）：网关进程照旧（`engines/codex`，Wevir 的模型目录），另起 ChatGPT 进程（`engines/codex-chatgpt`，Codex 内置的 `openai` Provider 与它自己的模型目录），Host 用 `CodexRuntime` 按 Provider 的种类分配会话，两个进程都在第一次用到时才启动。原因：`model_catalog_json` 一设，Codex 就整体换成这份静态目录（`model/list` 只剩 Wevir 的模型，OpenAI 模型拿不到按模型调好的元数据与提示词），而目录只在进程启动时读一次（补记 5），R6 在真实二进制上核实。备选的“单进程、ChatGPT 模型按未知模型降级”与“单进程、把 Codex 源码里打包的 OpenAI 目录抄进 Wevir 的目录”都没选：前者没有 apply_patch、不用 Codex 的提示词，后者要随版本同步、拿不到按账号套餐变化的远端列表。附带的好处：网关进程里没有 ChatGPT 凭据，它的外连仍为零；ChatGPT 进程里没有网关令牌。
   - **凭据存放**：`cli_auth_credentials_store = "file"`，`auth.json`（Codex 以 0600 写入）只在 ChatGPT 进程的 `CODEX_HOME`，与 `secrets.json` 同一个保护级别（docs/security.md §3）；不用系统钥匙串（未签名的二进制访问钥匙串会弹系统提示，Wevir 自己的 Key 也还没进钥匙串，ADR-0003 未决事项），迁移时一起换成 `keyring`。另写 `forced_login_method = "chatgpt"`、`mcp_oauth_credentials_store = "file"`。
   - **加固项新增 `[features] apps = false`**（两个进程都写）：ChatGPT 登录后 Codex 会连 ChatGPT 的应用（connectors）MCP，把连接器的工具给模型；Wevir 不支持。决策 5 的外连审计只覆盖了没有 ChatGPT 凭据的进程，这一项是 R6 用 mock 后端发现的。
   - **ChatGPT 是一种 Provider**（`kind: 'chatgpt'`，`id` 固定为 `chatgpt`）：登录成功时 Host 自己建它，模型列表来自 ChatGPT 进程的 `model/list`（登录后按账号从后端取），客户端只改显示名与默认模型。`ProviderKind` 加值按能力位 `provider_kind_chatgpt` 门控；账号的状态不存库，每次向引擎读。
   - **没登录时不发请求**：实测没登录的 ChatGPT 进程会拿着空凭据向 `api.openai.com` 预连并重试，所以 ChatGPT 会话的建立、恢复与发送之前先看账号状态，不是已登录就报 `missing_credentials`（`AdapterError` 新增这个码）。
   - **条款的提醒**：桌面端在登录按钮旁、CLI 在 `wevir provider login` 开头写明“仅供个人在本机使用 Wevir 时登录”（codex-notes §4.1）。
   - **验证**：协议的 schema、冻结样本 `compat/0.7.0.json` 与文档表；adapter-codex 的账号单元测试与真实二进制 + mock 登录服务的集成测试（设备码与浏览器登录、取消、登出与吊销、`model/list`、会话分到哪个进程、`auth.json` 的位置与权限、外连经拒绝的代理只剩 chatgpt.com）；Host 的 `account.*`、`account.updated` 只发给调过的连接、`chatgpt` Provider 的自动建与刷新、旧客户端看不到它；client-sdk 的 `watchAccount`；CLI 的 login / status / logout；桌面端经 CDP 走了一遍未登录 → 设备码 → 已登录 → 改默认模型 → 登出、设备码 → 取消。用真实 ChatGPT 账号登录并一问一答要维护者在场，结果另记。
11. **2026-10-14，xAI 与 Gemini 的 API Key 经网关（R8 的网关部分，[model-gateway.md](../architecture/model-gateway.md) §3.2、§4.5，[providers.md](../architecture/providers.md) §7.6、§7.7）。** 决策 2.3、决策 4 第 ②′、③ 行的网关部分照做（xAI 透传，Gemini 走它的 OpenAI 兼容端点做 Chat 转换）；R8 的其余部分（Grok Build、Gemini CLI 经通用 ACP 适配器、新建会话选引擎）维护者 2026-10-14 决定暂缓，没有合入。以下是决策没写到或与字面不同的地方：
   - **xAI 的方言按地址默认生效**（补记 7 留的“按地址补默认值，xAI 在 R8”）：`api.x.ai`（及子域）上 `compat.supportsCustomTools` 没写时按 `false` 处理（xAI 的 OpenAPI 没有 `custom` 工具），并新增 `flatten-namespace-tools`，把 Codex 的 `multi_agent_v1` 命名空间摊平成 `<ns>__<name>` 函数（OpenAPI 同样没有 `namespace`；没有 Key 实测，摊平对认命名空间的上游也可用，所以不设开关）。国内服务模板里的 xAI 显式写 `supportsCustomTools: false`，经代理改了地址也生效；namespace 的摊平只认地址。
   - **推理项的 `content: null` 对所有 Provider 去掉**：Codex 回放只有 `encrypted_content` 的推理项时写 `content: null`，xAI 报 422（openai/codex#47733）。
   - **Gemini 的 thought signature**：Gemini 3 起函数调用必须带回签名，否则 400。网关按地址（`generativelanguage.googleapis.com`）把签名收进一个 reasoning 项的 `encrypted_content`（`wevir-gw:gemini:v1:` 信封，记下 Provider 与模型），Codex 带回时挂回原来的工具调用；换过模型或缺签名时填文档给的占位值 `skip_thought_signature_validator`。思考内容不要求返回（只发 `reasoning_effort`），界面上没有 Gemini 的推理。
   - **验证**：网关的单元测试（xAI 地址的两条摊平与相反顺序的还原、`content: null`、Gemini 签名信封的往返与占位值）、桌面端模板的 compat；没有 xAI 与 Gemini 的 Key，真实服务没有跑过，命令见 docs/development.md §6.3。
12. **2026-10-14，运行时分发（R9，[ADR-0007](./0007-packaging-and-runtime-distribution.md)）。** 决策 8 的前半照做：安装包内置锁定版本的 `codex-app-server`，构建时由 `pnpm --filter @wevir/desktop resources` 按目标平台取（与开发缓存同一张 sha256 表），连同 Codex 的 `LICENSE`、`NOTICE` 放进资源目录；adapter-codex 的解析顺序是 `WEVIR_CODEX_BIN` → 资源目录（`WEVIR_RESOURCES_DIR`）→ 开发缓存。Linux 随包带 `bwrap`（未决事项 4 没有结论之前的默认做法）。决策 8 的后半（dsh 改为用户选用时下载）维护者决定推迟，未决事项 2 照旧（ADR-0007 决策 6）。打包工具、签名公证与更新渠道的选型记在 ADR-0007，配置另开任务。

12. **2026-10-15，Responses 工具方言通用化（P0a）。** 在补记 7、11 的机制上增加 optional 的 `supportsNamespaceTools` 与 `toolChoice`（Host 协议 0.12.0，冻结样本 `compat/0.12.0.json`）；Provider 声明优先于地址默认，地址表本次只有 xAI，保留原有摊平行为，显式 true 可覆盖。`toolChoice: auto_only` 用于 Responses / Chat：required 与具名改 auto，none 只去掉 tool_choice、保留 tools。dsh 接受但忽略新开关。所有 Responses 上游回放推理时去掉 `encrypted_content: null`，保留明文与 summary。锁定版本在 Wevir 的配置下不发 additional_tools、configuration_update、collaboration，依据与升级复查要求见 [model-gateway.md](../architecture/model-gateway.md) §10。本次不改变引擎或任何厂商模板。

13. **2026-10-15，Chat 的思考格式与推理回传。** 补记 3 留下的 thinkingFormat 现由网关读取，复用协议已有的 optional string，不改线缆协议与 Codex。openai / deepseek / qwen / zai 沿用 pi-ai 的开关语义，minimax / tencent 是当前仅用于 Codex 网关的扩展；none 与不能关闭思考的模型、预算映射见 [model-gateway.md](../architecture/model-gateway.md) §4.4。流式响应读取 reasoning_content、reasoning 与 reasoning_details 的文本，结构化块与 MiniMax 的原始正文另经 Provider、模型、格式绑定的 wevir-gw:chat:v1 信封带回。显示时拆 MiniMax 的前缀 think 标签，回传时恢复原始 content；只收 auto 的服务复用 toolChoice。服务模板与已存 Profile 不迁移。本地验证使用录制请求与 HTTP mock，没有真实 Key 时不算逐服务验收。
14. **2026-10-15，订阅来源：照 T3 Code 接三方订阅（协议 0.19.0，[host-api.md](../architecture/host-api.md) §3.1、§10，[domain-model.md](../architecture/domain-model.md) §3.2、§3.6）。** 维护者定：像 T3 Code（github.com/pingdotgg/t3code，MIT）那样让用户直接用自己已有的订阅，Claude（Claude Agent，经 `@anthropic-ai/claude-agent-sdk` 驱动用户装的 `claude`）、Cursor（`@cursor/sdk`）、OpenCode（`opencode serve`）、Grok（`grok` CLI 的 ACP）、Antigravity（Google 的 ACP 运行体）各是一个引擎，实现直接移植 T3 的做法；ChatGPT 仍是决策 4 与补记 10 的 Codex 自带登录。
   - **一个订阅来源 = 一个 Provider 种类 + 一个引擎 + 一种账号。** `SUBSCRIPTION_KINDS` 同时加进 `ProviderKind` 与 `AccountKind`，Provider 的 ID 固定等于种类，账号第一次读到已登录时 Host 建它、之后刷新模型列表（规则同 `chatgpt`）。Host 用 `EngineRouter`（`packages/host/src/engine-router.ts`）把 Codex 与各订阅引擎拼成一个适配器：会话按 Provider 的种类交给引擎，之后按引擎会话 ID 找回（子会话跟着派出它的引擎），账号按种类合并；订阅引擎登记在 `packages/host/src/engines.ts`，每个引擎一个适配器包，只声明自己引擎的 npm 包（AGENTS.md 规则 2）。决策 1.4“会话创建后不换引擎”不变：跨来源换模型照 T3 的接力（新引擎会话 + 历史摘要）另做。
   - **登录分两种。** `signIn: in_app` 的种类在应用里登录（Cursor 的 SDK 登录、Antigravity 的 ACP `authenticate`，网址交给界面）；`signIn: command` 的种类用用户自己在终端里的登录（`claude auth login`、`grok login`、`opencode auth login`），Wevir 只检测、不读它们存的凭据，用户登录后 `account.get` 带 `refresh` 重新检测。可执行文件自动查找，用户可以 `account.setPath` 指定（存在数据目录的 `engines.json`）；Wevir 能下载的（Antigravity）用 `account.install`。
   - **Claude 的条款。** Anthropic 的 Agent SDK 文档写明：未经批准，第三方产品不得提供 claude.ai 登录或订阅额度，产品里也不能叫 “Claude Code”。T3 的做法是自己不登录、只用用户本机已有的登录；维护者知情后决定照做，界面叫 “Claude Agent” 并注明用的是用户自己的登录。风险由项目承担，以后 Anthropic 收紧时只关掉这一种来源。
   - **开发与测试。** Host 的 `--adapter echo` 在 `WEVIR_ECHO_SUBSCRIPTIONS` 设了时挂上 `EchoAccounts`（runtime-adapter 的 echo-accounts.ts）：五种订阅的已登录、未登录、没装、可下载四种情形，应用内登录与下载过一会儿自己完成，订阅来源的会话由 echo 回答。真实引擎的验证在各引擎的适配器包里。
   - **启用开关。** 任何 Provider 都可以 `provider.setEnabled` 停用（存储迁移 0007），停用的不出现在模型选择里，已有会话照常能用。
   - **Claude Agent 引擎（2026-10-15，`packages/adapter-claude`，[claude-event-mapping.md](../architecture/claude-event-mapping.md)）。** 移植 T3 的 `ClaudeAdapterV2` 与 Claude 的账号检测：`@anthropic-ai/claude-agent-sdk` 0.3.286 驱动用户的 `claude`（不装 SDK 随带的 Claude Code 二进制），每个会话一个常驻进程，模型清单用 T3 随包的那份、不联网拉。与 T3 或别的引擎不同的地方：Wevir 的三种权限模式对到 `default` / `auto` / `bypassPermissions`；插话用 priority `next`（不打断输出，没有工具调用时 Claude 答完再以它开一轮，Wevir 算同一个回合）；关掉 Claude 的后台任务（`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`），子 agent 在回合里跑完——后台的子 agent 做完后由 Claude 自己再开一轮，顶层会话没有引擎开的回合；进程中途退出以 `turn.failed` 结束回合、下次发消息以 `resume` 重起，不报 `engine.exited`。协议不变。
   - **Cursor（2026-10-15）。** `packages/adapter-cursor` 移植 T3 的 `provider-cursor`（`@cursor/sdk` 1.0.35，SDK 在 Host 进程里跑本地 agent）：应用内登录铸出的 API Key 存在 `<数据目录>/engines/cursor/auth.json`；SDK 没有审批，权限模式映射到 Cursor 的沙箱与 Auto-review；协议不变。见 [cursor-event-mapping.md](../architecture/cursor-event-mapping.md)。

15. **2026-10-15，Google Cloud Vertex 的服务账号认证。** 维护者指定服务账号 JSON 由 SecretStore 保存，Host 网关用 RS256 JWT bearer 换取 OAuth 访问令牌。新增独立 google-vertex Provider（协议 0.21.0，客户端能力位 provider_kind_google_vertex、Host 功能 google_vertex），避免普通 API Key 配置携带私钥或自定义认证地址。Gemini 复用 Chat 转换；Claude 复用 Messages 转换、模型移进 URL、正文携带 vertex-2023-10-16 版本。令牌按凭据共用、提前刷新，只在 Host 内存里；不读取 ADC / gcloud，不接 express Key 或其他第三方模型。既有决策与普通 API Key 路由不变；详见 domain-model.md §3.2、model-gateway.md §2 与 providers.md §7.11。当前只有本地 mock 验证，真实服务账号验收尚缺凭据。
