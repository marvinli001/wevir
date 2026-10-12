# ADR-0001：dsh 接入路径：ACP 子进程 + 增量流式旁路

- 状态：Accepted（2026-10-12）
- 日期：2026-10-12
- 任务：T0.6；影响 T1.1、T1.3、T3.1–T3.6、T4.2
- 依据：[dsh 接入 Spike](../research/dsh-integration-spike.md)（T0.3，`spikes/dsh-acp/`，dsh `0.2.1-alpha.2` = 上游 `d743267`）；[Paseo 研读](../research/paseo-notes.md) §7 与 A19、A20

## 背景

- dsh 是 developer preview，官方明确会有不兼容变更（计划 §1.2）。Wevir 只能在 `packages/adapter-dsh` 一个包里接触它（计划 §2.2）。
- dsh 有两条进程外接入路径：ACP（`dsh --profile acp`，标准 Agent Client Protocol v1）与 SDK（`dsh --profile sdk`，dsh 私有 JSON-RPC）。T0.3 用真实 dsh + 本地脚本化 mock 模型把两条路径都跑了一遍（52 项断言通过），结论：

| 骨架需要的能力 | ACP | SDK | 依据 |
|---|---|---|---|
| 取消 | `session/cancel`，3–64 ms 内结算为 `cancelled`，正在跑的子进程被杀 | 无，只能杀进程 | T0.3 §5.4、§7 |
| 审批 | `session/request_permission`，allow / reject / cancel 均可 | 无应答方，升级请求记为 `unavailable` | T0.3 §5、§7 |
| 会话生命周期 | `new` / `list` / `close` / `resume`；新进程 resume 后模型上下文完整 | 无 list / close | T0.3 §3.2、§8 |
| 增量流式 | **无**：一条已提交消息一个 chunk，170 字的回答 3.3 s 后一次性到达 | 同样没有 | T0.3 §4 |
| 标题、todo、子 agent、事件序号 | 无 | 有 | T0.3 §7 |
| 单进程多会话 | 3 个会话并发正常 | — | T0.3 §10 |
| 冷启动到 initialize 完成 | 中位 0.44–0.48 s | 0.42 s | T0.3 §2 |

- 增量流式的缺口可以不改 dsh 补上：dsh 进程内有 `agent/assistant-stream` 增量帧，T0.3 用一个 20 行的 Cordis 插件（`spikes/dsh-acp/stream-tap/`）把它写到额外 fd，首个分片 85 ms 到达（T0.3 §4）。

## 决策

### 1. 接入方式

- Host 以子进程运行 `dsh --profile acp`，经 stdio 走 ACP v1。ACP 客户端库用 `@agentclientprotocol/sdk`，**锁定 `1.4.0`**，与 dsh-acp 自己锁定的版本相同（npm latest 已是 1.8.0）；升级 dsh 时一起核对。
- dsh **锁定 `@deepseek-ai/dsh@0.2.1-alpha.2`**（npm `latest` 标签仍是 `0.2.0-rc.2`，必须写精确版本）。这两个依赖只由 `packages/adapter-dsh` 声明。
- `initialize` 的 `clientCapabilities` 不声明 `fs` 与 `terminal`（ACP 默认均为 false，T0.3 即以 `{}` 运行，`fixtures/acp/initialize.request.json`）：Host 不替引擎读写文件或执行命令，工具一律在 dsh 的沙箱里执行（Paseo A19、N5）。

### 2. 进程模型

- 一个 Host 一个 dsh 进程，承载该 Host 的全部会话；dsh 进程只由 `adapter-dsh` 管理，Host 是唯一调度者（计划 §8）。
- 一个 Wevir 会话对应一个工作区目录，即 `session/new` 的 `cwd`。dsh **进程**的 cwd 是 Wevir 自己的目录（`DSH_HOME`），不得是用户工作区：环境里没有 Key 时，dsh 会把 `<进程 cwd>/.env` 里的值发给 Provider（T0.3 §6.3）。
- 进程退出（无论是否在回合中）都上报为引擎错误，相关会话转 `error`（Paseo A19：Paseo 只在回合中上报）。重启策略在 T3.1 实现。
- 回收：先关 stdin（T0.3 实测 EOF 后 22–29 ms 退出），超时再 SIGTERM、SIGKILL。

### 3. 增量流式旁路（新任务 T3.2a）

- 把 stream-tap 产品化为 `packages/adapter-dsh` 内的 Cordis 插件：监听 `agent/assistant-stream`，以 NDJSON 写到 spawn 时额外打开的 fd 3，fd 号经环境变量 `WEVIR_STREAM_FD` 告知插件；不碰 stdout 上的 ACP 流量。插件只用 Cordis 的 `ctx`，不 import `@deepseek-ai/*`。
- 用 dsh 官方插件机制装配，不 fork、不改 dsh 源码：`dsh plugin --profile acp add link:<插件目录>` 写入 Wevir 专属 `DSH_HOME` 的 profile，`--patch` overlay 里 `insert` 该插件。
- 合并规则：适配器按会话实时产出增量；收到 ACP 已提交的 `agent_message_chunk` 后以它为准替换（`attemptId` 与 `messageId` 不同，按会话内顺序对齐，T0.3 §4）。
- 旁路是增强而不是依赖：插件缺失或 fd 无数据时，适配器只产出已提交消息，其余功能不受影响。

### 4. 进程环境

| 项 | 做法 | 原因（T0.3） |
|---|---|---|
| 子进程环境 | 按白名单构造，不继承用户 shell 里的 `DEEPSEEK_API_KEY`、`ANTHROPIC_*` 等 | 凭据解析顺序：继承的环境变量 > `$DSH_HOME/.credentials.yaml` > `<进程 cwd>/.env` > `$DSH_HOME/.env`（§6.3） |
| `DSH_HOME` | `<Wevir 数据目录>/engines/dsh`，不与用户自己的 dsh 混用 | §2 |
| `DSH_AGENTS_HOME` | 指向 Wevir 专属的空目录（骨架默认隔离） | 默认 `~/.agents` 的 skills 与 AGENTS.md 会进入每个会话的首个请求（本机约 15 KB，§10） |
| 遥测 | `DSH_TELEMETRY_DISABLED=1` | `dsh-base` 带 OTel 遥测（§10） |
| 权限模式 | `DSH_PERMISSION_MODE` 显式设为 `workspace-write`（进程级，与 dsh 当前默认相同），不依赖默认值 | §5.1 |
| 模型 Key | 只经子进程环境变量 `WEVIR_PROVIDER_<ID>_KEY` 传入；overlay 里只写 `apiKeyEnv` 变量名 | §6.1、计划 §2.8 |
| Provider 配置 | 由 Host 生成 `--patch` overlay（格式见 T0.3 §6.2，含 `compat`、`contextWindow` 与 `web-search-deepseek` 的 Key 引用） | §6.2 |
| 安装脚本 | 放行 dsh 依赖里必需的安装脚本（T0.3 在 npm 下是 5 个：`@deepseek-ai/dsh-subprocess-local`、`koffi`、`node-pty`、`protobufjs`、`@google/genai`），pnpm 下的写法见 ADR-0004 | §1 |

### 5. 产品层事实归 Host

ACP 给不了、或给得不完整的信息，由 Host / 适配器自己补，不等 dsh：

| # | 能力 | 做法 | 任务 |
|---|---|---|---|
| 1 | 增量流式 | 决策 3 | T3.2a、T3.2 |
| 2 | 历史回放、会话列表、标题、时间 | Wevir 事件库是唯一来源；不依赖 `session/list`（只有 `sessionId` + `cwd`，且不含活跃会话）与 resume（不回放 update） | T2.2、T3.5 |
| 3 | 事件序号 | Host 分配 `seq` | T2.2 |
| 4 | 标题 | 骨架由 Host 取首条提示词生成 | T2.3 / T3.2 |
| 5 | todo | 解析 `todo_write` 的 `tool_call.rawInput`（完整列表） | T3.2 |
| 6 | 审批详情 | `request_permission` 只带 `toolCallId`，详情取同一 `toolCallId` 之前那条 `tool_call` 的 `rawInput`（路径、内容、`sandbox_permissions`、`justification`） | T3.3 |
| 7 | 审批选项 | 原样携带 ACP 给的选项（dsh 只有 `allow_once` / `reject_once`）；“总是允许”只能由 Host 记规则自动应答，骨架不做 | T1.1、T3.3 |
| 8 | 工具展示类型 | ACP `kind` 恒为 `other`、无 `locations` / `diff`：按工具名映射展示类型（参考 Paseo A20 的分类），从 `rawInput` 提取路径 | T1.1、T3.2、T5.3 |
| 9 | 错误分类 | 轮次失败是 `-32603` 自由文本：按前缀归类（缺凭据、Provider 错误、未知），始终保留原文 | T3.2 |
| 10 | 子 agent 活动 | 骨架只显示父会话的 `subagent` 工具调用；子会话事件推迟到 Phase 1（同一插件补发） | Phase 1 |

### 6. 审批、取消与恢复的语义

- dsh 的审批**只来自沙箱升级**：`workspace-write` 下工作区内读写、系统临时目录写入都不需要审批；工作区外的操作先失败，模型带 `sandbox_permissions` 重试才触发 `request_permission`（T0.3 §5.1）。界面文案、验收用例都按这一点设计。
- 客户端取消时，挂起的审批必须以 `{"outcome":{"outcome":"cancelled"}}` 回复，否则 dsh 侧悬挂（T0.3 §5.4）。
- `session/resume` 只能用会话创建时的 `cwd`（按 realpath 比较），活跃会话不能 resume（`-32602 session is already active`，T0.3 §3.2）。

### 7. 适配器接口的调整（T1.3）

- `cancel` 幂等，只在无法确认已停止时失败；适配器能列出未决审批，供 Host 重启或客户端中途加入时对账（Paseo A19）。
- `AgentEvent` 区分“增量”与“已提交消息”，后者替换前者。
- 契约测试套件带能力声明开关（例如“支持增量流式”），引擎做不到的条款按开关跳过，不删条款。

## 备选方案

| 方案 | 结论 | 原因 |
|---|---|---|
| SDK JSON-RPC（`dsh --profile sdk` + `@deepseek-ai/dsh-sdk-client`） | 不作主路径 | 没有取消和审批，骨架最硬的两条需求都满足不了；它多出来的标题、todo、子 agent、`seq` 可以由旁路插件补发 |
| Web profile 的远程 RPC | 未采纳 | 是 `agent/assistant-stream` 唯一的远程消费方，但属于 dsh 自家 Web 界面的私有协议，T0.3 没有评估；ACP 加 20 行插件已够用 |
| 进程内嵌入（adapter-dsh 直接 import dsh 包，在 Host 进程里跑 Cordis 应用） | 不采纳 | Host 进程要加载 dsh 的原生模块和预览版内部实现，引擎崩溃会拖垮 Host；违背计划 §1.2“作为依赖运行（子进程）” |
| 修改 dsh 源码让 ACP 发增量 | 不采纳 | 计划 §7 不修改 dsh；官方插件机制已能做到 |
| 不补增量，只显示整条消息 | 不采纳 | 计划 §4.2 第 3 条要求流式输出；整条到达要等 3 s 以上 |
| 每会话一个 dsh 进程（Paseo 的做法） | 不采纳 | T0.3 已验证单进程多会话，所有 update 都能按 `sessionId` 归属；每会话一进程意味着每次建会话都多一次约 0.5 s 的冷启动和一份 dsh 运行时内存 |

## 后果

- 收益：取消、审批、会话生命周期走标准协议；同一套 ACP 映射以后可以复用到 Claude Code、Codex、Gemini CLI 等 ACP Agent。
- 旁路依赖 dsh 的**进程内**事件 `agent/assistant-stream`，它不是公开契约，dsh 升级可能改名或改形状。对策：升级检查清单（T3.6 写入 UPSTREAM.md）必须重跑旁路测试；旁路失效时只退化为整条消息，不影响其他功能。
- 错误按自由文本归类，dsh 改措辞就会落到“未知”。对策：保留原文，归类失败不影响会话状态转换。
- 审批卡片出现与否取决于模型是否按提示升级，真实模型是否可靠尚未验证（T0.3 §9 第 1 条）。计划 §4.2 第 4 条与 Gate M4 的用例必须包含一次工作区外、非系统临时目录的操作。
- `DSH_AGENTS_HOME` 隔离后，用户自己 `~/.agents` 里的 skills 在骨架阶段不可用。
- dsh 运行时带原生模块（`node-pty`、`koffi`）。骨架阶段只跑开发模式，用开发者本机的 Node；打包时 dsh 跑在哪个 Node 上见 ADR-0002 未决事项。
- dsh 的 npm 依赖闭包里有非宽松许可证（`@deepseek-ai/libreoffice-kit*` 为 MPL-2.0，`sharp` 的 libvips 为 LGPL-3.0-or-later），分发 dsh 时的义务记在 UPSTREAM.md §2.1，由 T6.3 与打包阶段处理。

## 未决事项

1. **OAuth 类 Provider**（Codex、Claude 等订阅账号登录）：ACP 没有登录入口；grant 的 refresh token 会轮换，只能留在 dsh 能写的 `DSH_HOME/.credentials.yaml`，与计划 §2.8“密钥不落 DSH_HOME”冲突（T0.3 §6.4）。Phase 1 前单独做 Spike 决定登录入口、存放位置和各家条款；在那之前 Wevir 只支持 API Key 类 Provider，§2.8 不改。
2. **`DSH_AGENTS_HOME` 是否共享用户的 `~/.agents`**：骨架隔离；Phase 1 做 Skills 管理时再定。
3. **真实模型下的待验证项**（T0.3 §9：模型是否按提示升级、真实流式节奏下的首字时间差、DeepSeek 官方路由、`usage_update` 数值）：有 Key 后执行 `WEVIR_SPIKE_API_KEY=... npm run spike`，结果补记到本 ADR。
4. **Provider 变更是否需要重启 dsh 进程**：T0.3 没有测；T3.4 验证后补记。

## 补记

（暂无）
