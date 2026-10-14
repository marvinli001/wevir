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
2. **dsh 的可选下载**：从哪里下载（npm 镜像还是 Wevir 自己的发布物）、怎样校验与升级，由打包任务决定。在那之前开发环境照旧经 pnpm 安装 dsh。
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
   - 同时写了计划模式（`plan-mode.md`，下发方式见未决事项 5）、审批自动复核（`auto-review.md`，由 Host 调模型，替代决策 5 不开的 `approvals_reviewer = "auto_review"`；结论只映射为“本次允许”或“拒绝并说明理由”）、会话标题（`thread-title.md`，由 Host 生成，见补记 1），以及内置浏览器、Chrome、电脑操作三个插件的技能说明草稿（`prompts/plugins/`，插件未建，工具清单留占位）。MCP、skills、插件与联网搜索在 `base.md` 里留了占位。
   - `base.md`、`plan-mode.md`、`auto-review.md`、`thread-title.md` 改写自 Codex 开源仓库的模板（Apache-2.0），按 UPSTREAM.md §4、§5 登记并写文件头，`NOTICE` 收录 Codex 的署名与 Apache License 2.0 全文。
