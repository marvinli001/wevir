# Wevir 任务 Prompt 库

> 配套：[SKELETON_PLAN.md](./SKELETON_PLAN.md) · 建立日期：2026-10-12
> 每个 prompt 对应计划里的一个任务 ID。复制后粘贴到一个**新会话**中执行。

---

## 使用方法

1. 打开新会话，工作目录为仓库根目录。
2. 粘贴 **[通用前缀](#通用前缀)**，紧接着粘贴目标任务的 prompt。
3. 一个会话只做一个任务。会话变长或任务做不完时，用 [P-HANDOFF](#p-handoff会话交接) 生成交接说明，再开新会话继续。
4. 任务完成后，用 [P-REVIEW](#p-review任务验收审查) 在另一个新会话里做一次独立验收（可选，但 Gate 任务建议必做）。
5. 标注「可并行」的任务可以同时开多个会话执行。

### 维护规则

- 计划变了（ADR 推翻假设、上游接口变化），**先改 SKELETON_PLAN.md，再改这里对应的 prompt**。
- 某个 prompt 实际执行后发现缺信息，直接在 prompt 里补，并在文末[变更记录](#变更记录)写一行。
- 新增任务时，按 [P-TEMPLATE](#p-template新增任务模板) 写 prompt。

---

## 通用前缀

````text
你在 Wevir 仓库（/Users/marvin/Developer/wevir）工作。Wevir 是面向中国大陆用户的本地优先、开源、多模型、可跨设备接续的 Agent 工作台：以 DeepSeek Harness（dsh）为 Agent 执行内核，以 OpenWork 为桌面交互参考，以 Paseo 为多端与远程架构参考，Wevir 自己拥有 Local Agent Host、会话协议和客户端。

开始前先读：
- AGENTS.md（如果已存在）
- docs/SKELETON_PLAN.md 的 §0–§4，以及本任务所在里程碑的 §6 小节
- 本任务 prompt 中「先读」列出的文件

硬性规则：
1. 只做本任务。发现计划有问题，写进最后的汇报，不擅自扩大范围或提前做后续任务。
2. 除 packages/adapter-dsh 外，任何代码不得 import '@deepseek-ai/*'。
3. upstream/ 是只读参考，不修改。移植上游代码时，在文件头写明来源仓库、路径、提交 SHA、许可证，并登记到 docs/upstream/UPSTREAM.md。OpenWork 的 ee/ 目录禁止参考和移植。
4. 不要读取 ~/Downloads 下的原始调研聊天记录（约 7MB），需要的结论已经在 SKELETON_PLAN.md 里。
5. 密钥不得写入仓库、日志、测试快照或 DSH_HOME。
6. 涉及第三方库、框架或上游项目的 API 时，先查当前文档或 upstream/ 中的源码，不凭记忆写。
7. 代码风格与仓库已有代码保持一致；不加与任务无关的抽象。

完成后：
- 运行本任务的验收步骤，贴出命令和结果（失败就如实说明）。
- 在 docs/SKELETON_PLAN.md §5 把本任务改为 [x]，备注写主要产出。
- 提交一次 commit，message 以任务 ID 开头，例如 "T1.2: add Host API v0 schemas"。
- 最后用中文汇报：做了什么；验收结果；与计划的偏离及原因；给下一个任务的注意事项。
````

---

## 辅助 Prompt

### P-NEXT：自动选取下一个任务

````text
读 docs/SKELETON_PLAN.md §5，找出依赖已全部完成、状态仍为 [ ] 的任务，列出来并说明哪些可以并行。然后从 docs/TASK_PROMPTS.md 中找到排在最前面那个任务的 prompt，按它执行。若当前里程碑的 Gate 尚未通过，先只做 Gate 检查并汇报结果，不开始下一个里程碑。
````

### P-REVIEW：任务验收审查

````text
你是 Wevir 仓库的独立审查者，不参与实现。审查任务 <任务ID>。
1. 读 docs/SKELETON_PLAN.md 中该任务的产出与验收标准，读 docs/TASK_PROMPTS.md 中该任务的 prompt。
2. 用 git log / git diff 找到该任务的提交，逐条核对产出是否齐全。
3. 亲自运行验收步骤，不采信提交说明里的结论。
4. 检查硬性规则：@deepseek-ai/* 的 import 边界、upstream 来源登记、密钥是否泄露、是否超出任务范围。
5. 输出：通过 / 不通过；不通过的每一项给出文件位置和具体问题；建议的修复方式。不要直接修改代码。
````

### P-HANDOFF：会话交接

````text
本会话即将结束，任务 <任务ID> 尚未完成。请把当前进度写入 docs/handoff/<任务ID>.md，包含：
- 已完成的部分（文件路径）
- 未完成的部分与下一步具体操作
- 已确认的事实（含命令输出要点）与尚未验证的假设
- 踩过的坑和放弃的方案及原因
- 新会话开头应该粘贴的 prompt（= 通用前缀 + 本任务 prompt + “先读 docs/handoff/<任务ID>.md”）
提交为 "WIP <任务ID>: handoff"。
````

### P-PLAN-SYNC：计划维护

````text
对照仓库现状同步 docs/SKELETON_PLAN.md 与 docs/TASK_PROMPTS.md：
1. 检查 §5 的勾选状态与 git log 是否一致。
2. 读 docs/adr/ 与 docs/research/ 的最新结论，找出计划中已被推翻或需要细化的地方，直接修改计划文字和对应 prompt。
3. 在两个文件的变更记录中各加一行。
4. 汇报：改了哪些地方，为什么；有没有需要我做决定的问题（列为选项，不要替我决定）。
````

### P-TEMPLATE：新增任务模板

````text
### P-<任务ID>：<任务名>
依赖：<任务ID 列表> · 可并行：<是/否>

目标：<一句话>
先读：<文件或上游目录>
要做：
1. ...
不要做：
- ...
验收：
- <可执行的命令或可观察的结果>
````

---

## M0 — 地基准备

### P-T0.1：初始化 monorepo 与工程规范

依赖：无 · 可并行：否

````text
任务 T0.1：初始化 Wevir monorepo 与工程规范。

先读：docs/SKELETON_PLAN.md §1.4、§2、§4.1。

要做：
1. git init，默认分支 main。
2. pnpm workspace（apps/*、packages/*），根 package.json 设 "private": true、"type": "module"、engines.node ">=22.19"，packageManager 写当前 pnpm 版本。
3. tsconfig.base.json：strict、ESM、NodeNext 或 Bundler 解析（说明理由）、declaration。
4. Biome（lint + format）、Vitest（根配置 + workspace 模式）。
5. 一条 lint 规则：除 packages/adapter-dsh 外禁止 import '@deepseek-ai/*'。若 Biome 无法表达，用一个小脚本 scripts/check-engine-boundary.mjs 实现并接入 pnpm lint。
6. 建一个占位包 packages/protocol（只导出 PROTOCOL_VERSION = '0.0.0'，带一个测试），用来验证构建链。库构建用 tsdown。
7. 根脚本：build、dev（暂可为空实现）、lint、format、typecheck、test。
8. 文件：LICENSE（MIT，版权人 Wevir contributors）、README.md（一段定位 + 指向 docs/）、AGENTS.md（把通用前缀里的硬性规则改写为仓库规则，并说明目录结构与常用命令）、CLAUDE.md（一行：参见 AGENTS.md）、.gitignore（node_modules、dist、upstream/、.wevir-dev/、spikes/**/.dsh-home/ 等）、.node-version、.editorconfig。
9. .npmrc：默认不改 registry，用注释写清如何切到国内镜像（npmmirror）以及 Electron 二进制镜像变量 ELECTRON_MIRROR。

不要做：不建 apps/、不装 Electron/React、不写业务代码。

验收：
- pnpm install && pnpm build && pnpm lint && pnpm typecheck && pnpm test 全部通过。
- 在 packages/protocol 里临时加一行 import '@deepseek-ai/dsh'（不必真的安装），pnpm lint 应当失败；验证后删除。
````

### P-T0.2：上游参考快照与许可证核实

依赖：T0.1 · 可并行：否

````text
任务 T0.2：建立上游参考快照，核实许可证。

要做：
1. scripts/upstream-sync.sh：读取 docs/upstream/upstream.lock（每行：名称 仓库URL 分支 提交SHA），对每个仓库在 upstream/<名称>/ 做浅克隆并 checkout 到锁定提交。支持环境变量 WEVIR_GITHUB_MIRROR 替换 https://github.com 前缀（大陆网络）。脚本可重复执行。
2. 首次锁定：用 gh api 或 git ls-remote 取三个仓库默认分支的最新提交：
   - deepseek-harness  https://github.com/deepseek-ai/deepseek-harness  master
   - openwork          https://github.com/different-ai/openwork         dev
   - paseo             https://github.com/getpaseo/paseo                main
3. 执行脚本完成克隆。
4. 核实许可证并写入 docs/upstream/UPSTREAM.md：
   - dsh：根 LICENSE、THIRD_PARTY_NOTICES.md 的位置。
   - OpenWork：根 LICENSE、LICENSES/ 目录、ee/LICENSE 的实际内容与适用范围。明确写出“哪些目录可以按 MIT 参考移植”。
   - Paseo：GitHub API 把它识别为 NOASSERTION，打开根 LICENSE（及可能存在的 NOTICE）确认实际许可证，按实际情况写明移植时的义务。
5. UPSTREAM.md 结构：仓库表（名称、URL、锁定提交、日期、许可证结论）；各仓库的参考重点目录（见 SKELETON_PLAN §3）；移植登记表（目前为空：Wevir 文件 | 来源路径 | 来源提交 | 许可证 | 修改说明）；升级流程（改 lock → 同步 → 看上游 CHANGELOG → 跑契约测试）。

不要做：不修改 upstream/ 中的任何文件；不移植代码。

验收：
- rm -rf upstream && bash scripts/upstream-sync.sh 能复现，三个仓库 git rev-parse HEAD 与 lock 一致。
- UPSTREAM.md 中三份许可证结论都有对应的原文文件路径。
````

### P-T0.3：dsh 接入 Spike（ACP vs SDK）

依赖：T0.2 · 可并行：可与 T0.4、T0.5 并行

````text
任务 T0.3：验证 Wevir 以 ACP 方式接入 DeepSeek Harness 的可行性。这是骨架阶段最关键的验证，结论会写进 ADR-0001。

先读：
- upstream/deepseek-harness/docs/architecture.zh.md（Profile、应用启动、事件、轮次流程）
- upstream/deepseek-harness/packages/acp/acp/README.zh.md（ACP 协议约定与已知限制）
- upstream/deepseek-harness/packages/sdk/README.zh.md、packages/sdk/client/README.zh.md、packages/sdk/protocol/README.zh.md
- upstream/deepseek-harness/docs/user/guide/providers.md（自定义 Provider、apiKeyEnv）
- upstream/deepseek-harness/SAFETY.md
- ACP 官方文档 https://agentclientprotocol.com 中 initialize、session/new、session/prompt、session/update、session/request_permission、session/cancel 的定义

要做（全部放在 spikes/dsh-acp/，独立 package.json，不加入 pnpm workspace 的产品构建）：
1. 精确安装 @deepseek-ai/dsh@0.2.1-alpha.2（npm latest 标签仍是 0.2.0-rc.2，必须写死版本）与 @agentclientprotocol/sdk（先查 dsh 自己锁的版本，优先用同一主版本）。
2. 所有运行都使用 spikes/dsh-acp/.dsh-home 作为 DSH_HOME，不碰 ~/.dsh 或用户已有配置。
3. Provider 注入实验：写一个 --patch overlay，声明一个 OpenAI 兼容 Provider（baseURL + 模型 + apiKeyEnv: WEVIR_SPIKE_API_KEY），密钥只经环境变量传入；同时测试 DeepSeek 官方 Provider 的最小配置方式。确认 DSH_HOME 下没有写入明文 Key。
4. ACP 全流程脚本：spawn `dsh --profile acp` → initialize → session/new（cwd 指向一个临时工作区）→ session/prompt（让它读取并写入一个文件，以触发工具调用和权限请求）→ 收集所有 session/update → 对 request_permission 分别测试 allow 和 deny → 再发一个长任务并 session/cancel → session/close → session/list → session/resume → 再发一个追问，确认模型是否记得之前的内容。
5. 把每一类 session/update、request_permission、initialize 结果的真实 JSON 存到 spikes/dsh-acp/fixtures/（去除密钥和个人路径）。
6. SDK 对照：用 @deepseek-ai/dsh-sdk-client 的 HarnessClient 跑同样的提示，记录事件粒度与 ACP 的差异（尤其是：ACP 拿不到、SDK 能拿到的信息，如 todo、plan、subagent、标题）。
7. 测量：dsh 冷启动到 initialize 完成的耗时；单次进程同时开 3 个会话是否正常。

产出：docs/research/dsh-integration-spike.md，包含：
- 环境与版本；每一步的实际结果（成功/失败 + 关键输出）
- ACP 事件类型清单与示例（引用 fixtures 文件）
- 权限请求的结构，以及 allow/deny/cancel 后工具结果的记录方式
- resume 后的上下文保留情况
- Provider 注入的可行配置（可直接复制的 overlay 样例，密钥用占位符）
- ACP vs SDK 对比表
- 结论：ACP 能否作为骨架主路径；必须由 Wevir 补足的能力清单；对 SKELETON_PLAN §3、§6 M3 的修改建议

不要做：不写 packages/ 下的任何产品代码；不改 SKELETON_PLAN（修改建议写进报告，由 T0.6 落实）。

验收：
- spikes/dsh-acp 下有可以一条命令重跑的脚本（需要 WEVIR_SPIKE_API_KEY 时给出明确提示）。
- 报告中每个结论都能对应到 fixtures 或命令输出。
- grep 确认 fixtures 与 .dsh-home 中没有密钥。
````

### P-T0.4：Paseo 架构研读

依赖：T0.2 · 可并行：可与 T0.3、T0.5 并行

````text
任务 T0.4：研读 Paseo 的多端架构，为 Wevir Host 协议与将来的移动端提供依据。只读，不写产品代码。

先读：upstream/paseo/README.md、public-docs/ 下的架构与 SDK 文档、packages/protocol、packages/server、packages/client、packages/relay、packages/app（Expo）、packages/desktop 中与连接相关的代码。

回答以下问题，每个回答都给出源码路径（文件:行号）作为依据：
1. daemon 如何启动、被发现（端口、锁文件、运行时文件）、如何被桌面端拉起或连接、如何退出。
2. 协议怎么组织：消息格式、请求/响应/推送的区分、版本号与兼容策略、schema 的定义方式。
3. 事件流：是否有序号、断线后如何补发、是否有状态快照、客户端如何从中途加入一个正在运行的会话。
4. 多个客户端同时操作同一会话（例如两端同时审批）时如何处理冲突。
5. 设备配对流程、令牌的作用域与撤销、手机端拿到的权限范围。
6. 中继（relay）的加密方式与信任模型；本地直连与中继的切换。
7. Agent Provider 抽象与进程管理的边界在哪里（这部分 Wevir 不采纳，但要清楚它和 dsh 的冲突点）。
8. Expo 客户端与桌面端共享了哪些代码（client 包、类型、状态管理）。

产出：docs/research/paseo-notes.md，最后附三栏表格：
- 骨架阶段直接采纳（写进 Host API / 事件设计）
- 推迟到移动端阶段采纳
- 不采纳（及原因）

验收：所有结论有源码路径支撑；三栏表格中“直接采纳”的每一项都能落到 SKELETON_PLAN 中某个具体任务。
````

### P-T0.5：OpenWork 架构研读

依赖：T0.2 · 可并行：可与 T0.3、T0.4 并行

````text
任务 T0.5：研读 OpenWork 的桌面产品结构，为 Wevir 的信息架构和将来的选择性移植做准备。只读，不写产品代码。

先读：upstream/openwork/README.md、docs/architecture/、apps/app、apps/desktop、apps/server、packages/ui、packages/types、packages/sdk。不读 ee/。确认 docs/upstream/UPSTREAM.md 中对其许可证边界的结论。

回答以下问题，给出源码路径作为依据：
1. 信息架构：工作区、会话、文件、Skills、MCP、设置在界面上如何组织；主要页面与导航结构（可以用文字线框图描述）。
2. apps/desktop、apps/app、apps/server 三者的关系与通信方式；与 OpenCode 的耦合点在哪里（这些是 Wevir 不能直接带走的）。
3. 会话视图如何渲染流式消息、工具调用、审批、文件成果。
4. 工作区模型：如何添加目录、权限范围、多工作区切换。
5. Skills 与 MCP 管理的数据模型和界面流程。
6. packages/ui 的组件组织与设计 Token 方式（Tailwind v4 配置、主题切换）。

产出：docs/research/openwork-notes.md，包含：
- 以上问题的回答
- 「可移植组件候选清单」表格：路径 | 用途 | 许可证（必须为 MIT 区域）| 外部依赖 | 与 OpenCode 的耦合程度 | 建议（直接移植 / 改写 / 只参考）
- 对 Wevir 骨架 UI（M5）的布局建议

验收：候选清单中没有任何 ee/ 下的路径；每项都有许可证判断。
````

### P-T0.6：首批 ADR 定稿

依赖：T0.3、T0.4、T0.5 · 可并行：否 · **Gate M0**

````text
任务 T0.6：根据 M0 的三份研究报告，写出并接受首批架构决策记录，然后更新计划。

先读：docs/research/dsh-integration-spike.md、paseo-notes.md、openwork-notes.md、docs/upstream/UPSTREAM.md。

要做：
1. 建立 docs/adr/README.md（ADR 格式说明：背景、决策、备选方案、后果、状态）和以下 ADR：
   - 0001-runtime-integration.md：dsh 接入路径（ACP / SDK / 其他），以 Spike 证据为依据；写明 Wevir 必须自行补足的能力。
   - 0002-host-transport-and-process-model.md：Host 与客户端用 JSON-RPC 2.0 over WebSocket；监听 127.0.0.1 随机端口；首帧 hello 携带 token、protocolVersion、clientKind、deviceId；骨架阶段 Host 由桌面拉起并随桌面退出，但 Host 可独立运行，为常驻 daemon 留路。吸收 paseo-notes 中“直接采纳”的内容。
   - 0003-storage.md：better-sqlite3 与 node:sqlite 的取舍（Node 版本要求、Electron 原生模块重编译、事务与性能）；密钥骨架阶段存 0600 文件，后续迁移系统钥匙串。
   - 0004-repo-tooling.md：确认或修改 SKELETON_PLAN §1.4。
2. 按 ADR 结论修改 docs/SKELETON_PLAN.md §1.4、§3、§6（尤其 M3），并在变更记录中写一行。
3. 若 ADR 改变了某些任务的做法，同步修改 docs/TASK_PROMPTS.md 中对应 prompt。

Gate M0 检查（逐条汇报）：
- ADR 0001–0004 状态为 Accepted
- 计划与 prompt 已同步
- upstream 快照可复现，许可证结论齐全
有任何一条无法确定，列出选项交给我决定，不要自行拍板。
````

---

## M1 — 契约先行

### P-T1.1：领域模型 v0

依赖：T0.6 · 可并行：否

````text
任务 T1.1：定义 Wevir 领域模型 v0（文档 + 类型草案）。

先读：SKELETON_PLAN §2、§6 M1；docs/adr/0001、0002；docs/research/dsh-integration-spike.md 中的事件样本。

要做：
1. docs/architecture/domain-model.md：
   - 实体：Workspace、ProviderProfile、Session、ApprovalRequest、WevirEvent。每个实体写字段、类型、含义、谁创建、谁修改。
   - 预留实体：Task、Artifact、Device，只写用途和与现有实体的关系，不实现。
   - 区分「产品层事实（Wevir 拥有）」与「引擎事实的投影」，并说明 Wevir 会话 ID 与引擎会话 ID 的映射。
   - 会话状态机：idle、running、awaiting_approval、cancelling、error、closed，画 mermaid 状态图，列出每个转换的触发事件。
   - 审批生命周期：pending → approved / denied / expired / cancelled；幂等规则（首个决定生效）。
   - 事件类型目录 v0：assistant.delta、assistant.message、assistant.thought、tool.started、tool.updated、tool.finished、approval.requested、approval.resolved、session.state_changed、usage.updated、engine.raw 等，按 Spike 实际看到的内容调整。
2. 不写实现代码；类型以 TS 代码块写在文档里，供 T1.2 落地。

验收：文档中每个 ACP 事件样本（spikes/dsh-acp/fixtures）都能对应到某个 Wevir 事件类型或 engine.raw。
````

### P-T1.2：Host API v0（protocol 包）

依赖：T1.1 · 可并行：可与 T1.3 并行

````text
任务 T1.2：在 packages/protocol 实现 Host API v0 的类型与 schema。

先读：docs/architecture/domain-model.md；docs/adr/0002；SKELETON_PLAN §6 T1.2。

要做：
1. PROTOCOL_VERSION 改为 '0.1.0'，并写明兼容规则（主版本不同拒绝连接，次版本向后兼容）。
2. 用 zod 定义：领域实体 schema；JSON-RPC 2.0 请求/响应/通知封装；每个方法的 params 与 result；WevirEvent 封装及按 type 区分的 payload（discriminated union）；错误码表（如 VERSION_MISMATCH、UNAUTHORIZED、SESSION_NOT_FOUND、INVALID_STATE、ALREADY_DECIDED）。
3. 方法 v0：host.hello、workspace.list/add/remove、provider.list/upsert/remove/test、session.create/list/get/send/cancel/close/resume、approval.respond、events.subscribe/unsubscribe；服务端推送 events.event。
4. 导出一个方法注册表（方法名 → params schema / result schema），供 Host 与 client-sdk 共用，避免两边各写一份。
5. docs/architecture/host-api.md：方法表、示例报文、订阅语义（sinceSeq 先补发后实时、不丢不重）、错误码。
6. 单测：每个 schema 至少一个合法样例和一个非法样例；事件 payload 联合类型的穷尽性检查。

不要做：不写服务端或客户端实现。

验收：pnpm --filter @wevir/protocol test 与 typecheck 通过；host-api.md 与代码中的方法注册表一致（写一个测试比对方法名列表）。
````

### P-T1.3：AgentRuntimeAdapter 接口、契约测试与 EchoAdapter

依赖：T1.1 · 可并行：可与 T1.2 并行

````text
任务 T1.3：建立 packages/runtime-adapter：引擎适配接口、实现无关的契约测试套件、以及用于开发的 EchoAdapter。

先读：docs/architecture/domain-model.md；docs/adr/0001；SKELETON_PLAN §6 T1.3（接口起点）。

要做：
1. 定义 AgentRuntimeAdapter 及相关类型（SessionConfig、EngineSession、AgentInput、AgentEvent、ApprovalDecision）。AgentEvent 是引擎无关的中间表示，Host 再把它写成 WevirEvent。按 ADR-0001 和 Spike 结论调整接口，并在代码注释里说明与 SKELETON_PLAN 中草案的差异。
2. 契约测试套件：导出 runAdapterContract(createAdapter) 函数，覆盖：建会话、发送、收到至少一条助手输出并以完成事件结束、审批允许与拒绝、取消、关闭后再发送报错、dispose 后资源释放、并发两个会话互不干扰。
3. EchoAdapter：回显输入；输入包含 "tool" 时模拟一次工具调用；包含 "approve" 时先发审批请求，等待决定后继续；支持取消。用可控的假时钟或微小延迟模拟流式输出。
4. EchoAdapter 跑通契约测试。

不要做：不接触 dsh；不写 Host。

验收：pnpm --filter @wevir/runtime-adapter test 通过；契约测试套件可以被其他包导入使用。
Gate M1：本任务与 T1.2 都完成后，确认 protocol 与 runtime-adapter 两个包的测试与类型检查全部通过，并在汇报中注明。
````

---

## M2 — Local Agent Host 核心

### P-T2.1：storage

依赖：T1.2 · 可并行：否

````text
任务 T2.1：实现 packages/storage：SQLite schema、迁移与仓储。

先读：docs/adr/0003-storage.md；docs/architecture/domain-model.md。

要做：
1. 按 ADR-0003 选定的 SQLite 驱动建立连接管理（WAL 模式、外键开启、busy timeout）。
2. 手写 SQL 迁移（migrations/0001_init.sql 等）+ schema_version 表 + 启动时自动迁移。
3. 表：workspaces、provider_profiles（只存 secretRef，不存密钥）、sessions（含 engine、engine_session_id、state）、events（session_id、seq、ts、type、source、payload JSON；(session_id, seq) 唯一）、approvals。
4. 密钥存储：SecretStore 接口 + 骨架实现（数据目录下 secrets.json，权限 0600，Windows 上说明等效做法）。
5. 每张表的仓储函数与测试（使用临时数据库文件）。

验收：pnpm --filter @wevir/storage test 通过；测试覆盖迁移可重复执行、唯一约束生效、secrets 文件权限为 0600（非 Windows）。
````

### P-T2.2：事件库与回放

依赖：T2.1 · 可并行：否

````text
任务 T2.2：在 packages/host 中实现事件库（EventStore）与会话快照推导。

先读：docs/architecture/domain-model.md 的事件目录与状态机；packages/storage。

要做：
1. EventStore.append(sessionId, event)：在事务中原子分配 seq 并写入，返回完整 WevirEvent；同一会话并发 append 不出现重复或空洞。
2. readSince(sessionId, sinceSeq, limit)。
3. 进程内事件总线：append 成功后通知订阅者（为 T2.4 的“先补发后实时”打基础）。
4. 会话快照：由事件推导状态、标题、最后活动时间、未决审批列表；sessions 表中的冗余字段与快照一致。
5. 测试：并发 append；重开数据库后 readSince 结果一致；快照推导覆盖每一种状态转换。

验收：pnpm --filter @wevir/host test 通过。
````

### P-T2.3：会话管理器与审批状态机

依赖：T2.2、T1.3 · 可并行：否

````text
任务 T2.3：实现 SessionManager，把 AgentRuntimeAdapter 与事件库连起来。

先读：docs/architecture/domain-model.md（状态机、审批生命周期）；packages/runtime-adapter；packages/host 中的 EventStore。

要做：
1. SessionManager：create / send / cancel / close / resume / respondToApproval；维护 Wevir 会话 ID ↔ 引擎会话 ID；消费 adapter.subscribe 的 AgentEvent 并写成 WevirEvent。
2. 状态机严格按文档执行，非法操作返回 INVALID_STATE（例如 running 时再 send：按文档决定是排队还是拒绝，并写明）。
3. 审批：approval.requested 事件写入 approvals 表；respondToApproval 幂等，首个决定生效，后续返回 ALREADY_DECIDED 及已有决定，记录 decidedBy（deviceId）。
4. 引擎异常：adapter 抛错或流中断时，会话转 error 并写入错误事件，历史保留。
5. Host 启动时把未决审批标记为 expired，把 running 状态的会话修正为 error 或 idle（按文档）。
6. 使用 EchoAdapter 完成测试，并跑一遍 runAdapterContract 确认 EchoAdapter 仍然通过。

验收：测试覆盖每条状态转换、审批幂等、引擎异常、启动修复。
````

### P-T2.4：WebSocket JSON-RPC 服务

依赖：T2.3 · 可并行：否

````text
任务 T2.4：实现 Host 的 WebSocket JSON-RPC 服务。

先读：docs/adr/0002；docs/architecture/host-api.md；packages/protocol 的方法注册表。

要做：
1. 使用 ws 库监听 127.0.0.1，端口默认 0（系统分配）。
2. 连接的首个请求必须是 host.hello：校验 token（常量时间比较）与主版本号，失败返回对应错误码并关闭连接；hello 之前的其他请求一律拒绝。
3. 基于方法注册表做 params 校验与分发，result 输出前同样校验（开发模式下严格，生产模式下记录告警）。
4. events.subscribe(sessionId, sinceSeq)：先补发 readSince 的历史，再切换到实时推送，保证不丢不重（补发期间产生的新事件要正确衔接）。同一连接可订阅多个会话；多个连接可订阅同一会话。
5. 连接断开时清理订阅；服务关闭时通知客户端并等待在途请求结束（有上限）。

验收：集成测试（真实 WebSocket + EchoAdapter）覆盖：鉴权失败、版本不符、订阅补发与实时衔接（在补发过程中并发写入事件）、两个客户端同时订阅、一个客户端审批另一个客户端收到 approval.resolved。
````

### P-T2.5：Host 进程入口

依赖：T2.4 · 可并行：否 · **Gate M2**

````text
任务 T2.5：把 Host 组装成可独立运行的进程。

先读：docs/adr/0002；SKELETON_PLAN §6 T2.5。

要做：
1. packages/host 提供 bin：wevir-host。参数：--home、--adapter echo|dsh（dsh 暂未实现时给出明确错误）、--port、--log-level。
2. 数据目录解析：WEVIR_HOME > --home > 平台默认（macOS ~/Library/Application Support/Wevir，Windows %APPDATA%\Wevir，Linux $XDG_DATA_HOME/wevir）；开发脚本使用 ./.wevir-dev。
3. 启动时生成随机 token，写 <home>/run/host.json（pid、port、token、protocolVersion、startedAt），权限 0600；退出时删除。检测到旧的 host.json 时判断 pid 是否存活，存活则拒绝启动并提示。
4. 结构化日志（JSON 行）写到 <home>/logs/，对 token 与密钥字段脱敏。
5. SIGINT/SIGTERM 优雅退出：停止接收新连接 → 关闭会话 → dispose adapter → 刷盘。
6. 根脚本 pnpm dev:host 以 echo 适配器启动。

Gate M2（写一个 scripts/gate-m2.ts 自动化执行并在汇报中贴结果）：
用最小 WebSocket 客户端完成：hello → workspace.add → session.create → session.send → 收到流式事件 → 触发审批并允许 → 再发一条并 cancel → 杀掉 Host 进程 → 重启 → events.subscribe(sinceSeq=0) 回放的事件与之前完全一致。
````

---

## M3 — dsh 适配器

### P-T3.1：dsh 进程管理

依赖：T2.5 · 可并行：否

````text
任务 T3.1：创建 packages/adapter-dsh，实现 dsh 运行时的定位、启动与回收。

先读：docs/adr/0001；docs/research/dsh-integration-spike.md；spikes/dsh-acp/ 中的启动代码；upstream/deepseek-harness/packages/acp/acp/README.zh.md。

要做：
1. 精确依赖 dsh（版本与 Spike 一致，写在 docs/upstream/UPSTREAM.md），以及 ADR 选定的 ACP 客户端库。
2. 解析 dsh 可执行入口（从依赖包中解析，不依赖全局 PATH）。
3. 独立 DSH_HOME：<Wevir 数据目录>/engines/dsh；首次启动时初始化所需目录。
4. DshProcess：启动 `dsh --profile acp`（再加上 T3.4 将生成的 --patch overlay 的插槽）；stdout 只走协议，stderr 保留有界尾部用于诊断；initialize 超时（默认 15 秒）；崩溃检测与有限次数的自动重启（指数退避）；dispose 时 shutdown → 关 stdin → SIGTERM → SIGKILL 阶梯。
5. 单个 dsh 进程承载多个会话（Spike 已验证则采用；否则按 Spike 结论改为每会话一个进程，并在 ADR-0001 补记）。

验收：
- 单测：可执行入口解析、DSH_HOME 初始化、dispose 阶梯（用假子进程模拟）。
- 集成测试（需要本机能运行 dsh，不需要模型 Key）：启动 → initialize 成功 → dispose 后无残留进程。
````

### P-T3.2：ACP → Wevir 事件映射

依赖：T3.1 · 可并行：可与 T3.4 并行

````text
任务 T3.2：把 ACP 的 session/update 映射为 AgentEvent。

先读：spikes/dsh-acp/fixtures/ 全部样本；docs/architecture/domain-model.md 的事件目录；packages/runtime-adapter 中 AgentEvent 定义；ACP 官方文档中 session/update 的各类型。

要做：
1. 纯函数 mapAcpUpdate(update) → AgentEvent[]，覆盖：助手消息分片、thought、工具调用开始/更新/结束（含状态和结果摘要）、上下文用量、配置变化。
2. 未识别类型映射为 engine.raw，原样保留 payload，不丢弃，并记录一次告警日志。
3. 在 adapter 中接入：每个引擎会话一个有序事件队列，保证事件顺序与 ACP 交付顺序一致。
4. docs/architecture/acp-event-mapping.md：ACP 类型 → Wevir 事件类型 → 说明，每行附 fixture 文件名。

验收：以 fixtures 为输入的快照测试；每个 fixture 都有对应测试；映射文档与代码一致。
````

### P-T3.3：审批桥接

依赖：T3.2 · 可并行：否

````text
任务 T3.3：把 ACP 的 session/request_permission 桥接到 Wevir 审批流程。

先读：spike 报告中权限请求的部分与 fixtures；docs/architecture/domain-model.md 的审批生命周期；packages/host 的 SessionManager。

要做：
1. 收到 request_permission 时生成 AgentEvent(approval.requested)：requestId、关联的工具调用、人类可读摘要、可选项（allow once / deny 等，以 ACP 实际提供的选项为准）。
2. respondToApproval 把决定转换为 ACP 响应；会话被取消或关闭时，按 ACP 语义回复 cancelled。
3. 未决审批的超时策略：默认不超时（等待用户），但 Host 退出时统一回复 cancelled，保证 dsh 侧不悬挂。
4. 与 T2.3 的幂等规则配合：重复决定不重复发送给 dsh。

验收：用 fixtures 回放的单测覆盖 allow、deny、取消时的未决审批、重复决定；真实 dsh 集成测试（需 WEVIR_TEST_API_KEY，否则跳过）覆盖一次 allow 与一次 deny。
````

### P-T3.4：Provider 配置桥接

依赖：T3.1 · 可并行：可与 T3.2 并行

````text
任务 T3.4：把 Wevir 的 ProviderProfile 转换为 dsh 配置，并实现 provider.test。

先读：spike 报告中 Provider 注入部分；upstream/deepseek-harness/docs/user/guide/providers.md；upstream/deepseek-harness/docs/config-catalog.zh.md 中 dsh-llm-pi-ai 与 DeepSeek 官方适配器的字段。

要做：
1. ProviderProfile 支持两种 kind：deepseek（官方）与 openai-compatible（baseURL、API 协议 chat-completions/responses、模型列表含上下文窗口与最大输出、是否支持图片、推理档位）。anthropic-messages 协议只预留类型。
2. 生成 dsh overlay 文件（写在 DSH_HOME 下的 Wevir 专用目录，内容只含 apiKeyEnv 变量名，不含密钥）；启动 dsh 时以 --patch 传入，并通过子进程 env 注入密钥（变量名形如 WEVIR_PROVIDER_<id>_KEY）。
3. Provider 变更后的生效策略：按 Spike 结论决定是热更新还是重启 dsh 进程，并在文档中写明对运行中会话的影响。
4. provider.test：用最小请求验证连通性与 Key 有效性，返回可读的错误（网络不可达、401、模型不存在、协议不兼容）。
5. 在 docs/architecture/providers.md 给出国内常用服务的 openai-compatible 示例配置（DeepSeek、通义千问 DashScope、Kimi、智谱 GLM），注明 baseURL 需以各服务当前文档为准。

验收：单测确认 overlay 中无密钥、子进程 env 包含密钥；集成测试（有 Key 时）provider.test 成功，错误 Key 返回 401 类错误。
````

### P-T3.5：会话恢复

依赖：T3.3 · 可并行：否

````text
任务 T3.5：实现基于 ACP session/resume 的会话恢复。

先读：spike 报告中 resume 的发现；packages/host 的 SessionManager 与启动修复逻辑。

要做：
1. resumeSession：对已关闭或 Host 重启后的会话调用 ACP session/resume（使用保存的 engine_session_id 与工作区路径）。
2. 界面历史始终从 Wevir 事件库读取，不依赖引擎回放。
3. 引擎会话已不存在（DSH_HOME 被清理、版本升级导致不兼容）时：会话标记为只读并给出明确原因，允许用户基于历史新建会话（新建逻辑只需留接口）。
4. 写入一条 session.resumed 事件，记录引擎版本，便于将来排查跨版本问题。

验收：集成测试（有 Key 时）：建会话 → 对话 → 重启 Host → resume → 追问能引用之前的内容；无 Key 时用 fixtures 覆盖引擎会话丢失的分支。
````

### P-T3.6：适配器契约测试

依赖：T3.5、T3.4 · 可并行：否 · **Gate M3**

````text
任务 T3.6：让 dsh 适配器通过与 EchoAdapter 相同的契约测试，并建立 dsh 升级流程。

要做：
1. 用 runAdapterContract 跑 DshAdapter：真实模式需 WEVIR_TEST_API_KEY 与 WEVIR_TEST_PROVIDER（无则跳过并打印原因）；回放模式使用录制的 ACP 交互（实现一个基于 fixtures 的假 dsh 进程或传输层替身），CI 默认跑回放模式。
2. 若某些契约条款 dsh 无法满足（例如并发会话限制），在契约套件中加入能力声明开关，而不是删除条款，并在 ADR-0001 补记。
3. docs/upstream/UPSTREAM.md 增加「dsh 升级检查清单」：读上游 CHANGELOG 与 ACP README 的已知限制变化 → 更新锁定版本 → 重新录制 fixtures → 跑契约测试 → 对比事件映射表。
4. 把 Host 的 --adapter dsh 接通。

Gate M3：回放模式契约测试全绿；真实模式在本机跑通一次并贴出结果；wevir-host --adapter dsh 能启动。
````

---

## M4 — 竖切联通：CLI

### P-T4.1：client-sdk

依赖：T2.4 · 可并行：可在 M3 期间进行

````text
任务 T4.1：实现 packages/client-sdk，供 CLI、桌面端以及将来的手机端共用。

先读：docs/architecture/host-api.md；packages/protocol 的方法注册表；docs/research/paseo-notes.md 中关于客户端重连与事件补发的内容。

要做：
1. WevirClient：connect({ url, token } 或从 run/host.json 读取)；自动发送 host.hello（clientKind、deviceId）；基于方法注册表的类型安全 request；请求超时；错误映射为类型化错误。
2. subscribe(sessionId, { sinceSeq }) 返回异步迭代器；客户端记录每个会话收到的最大 seq；断线后指数退避重连，重连后自动以最大 seq 续订，对上层透明且保证不重复。
3. 连接状态事件（connecting、connected、reconnecting、closed）供 UI 显示。
4. 运行环境：Node 与浏览器（Electron 渲染进程）都能用，不依赖 Node 专有 API（读取 host.json 的功能放在单独的 node 入口）。

验收：针对真实 Host（echo 适配器）的集成测试：正常流程；在流式输出中途强制断开连接，重连后事件完整且无重复。
````

### P-T4.2：`wevir` CLI

依赖：T4.1、T3.6 · 可并行：否 · **Gate M4**

````text
任务 T4.2：实现 apps/cli，完成第一条真正可用的竖切流程。

先读：packages/client-sdk；SKELETON_PLAN §6 T4.2 与 §4.2。

要做：
1. 命令：wevir host start|status|stop；wevir workspace add|list <path>；wevir provider add|list|test（交互式输入 Key，不回显，不写入 shell 历史）；wevir session new -w <path> "<prompt>"；wevir session list；wevir session attach <id>。
2. attach：实时渲染助手输出和工具调用摘要；遇到审批时交互式询问 允许/拒绝；Ctrl-C 第一次取消当前运行，第二次退出 attach。
3. 输出中文为主，错误信息给出下一步建议（例如 Host 未启动时提示 wevir host start）。
4. 依赖尽量少（参数解析与交互输入各选一个轻量库）。

Gate M4（真实 dsh + 真实模型，逐条执行并在汇报中贴输出）：
- 在临时目录放几个 CSV，执行 wevir session new 让它汇总并写 summary.md，过程中至少出现一次审批；文件内容正确。
- 另开一个终端 wevir session attach 同一会话，两端看到相同的事件；在第二个终端审批，第一个终端同步显示结果。
- wevir host stop → start → session list 历史完整 → attach 后继续追问，模型能引用之前的内容。
````

---

## M5 — 桌面壳

### P-T5.1：Electron 壳与 Host 生命周期

依赖：T4.2 · 可并行：否

````text
任务 T5.1：创建 apps/desktop 的 Electron 壳，负责拉起或连接 Host。

先读：docs/adr/0002；docs/research/openwork-notes.md 中 apps/desktop 的部分；upstream/openwork/apps/desktop 与 upstream/deepseek-harness/apps/desktop 的主进程代码（只作参考）；Electron 官方安全清单。

要做：
1. 使用 electron-vite（或 ADR-0004 选定的方案）建立 main / preload / renderer 三段结构；renderer 为 React + Tailwind v4。
2. 主进程：读取 run/host.json，Host 在运行就连接；否则以子进程启动 wevir-host（开发时用 workspace 中的源码，打包后用内置产物，本任务只需打通开发模式），等待就绪；应用退出时关闭自己拉起的 Host。
3. preload 只通过 contextBridge 暴露最小接口：getHostConnection()（url、token）、选择文件夹对话框、打开外部链接。
4. 安全基线：contextIsolation true、sandbox true、nodeIntegration false、严格 CSP、禁止任意导航与新窗口。
5. 如果 ADR-0003 选择了 better-sqlite3，确认 Host 以独立 Node 进程运行时不需要 Electron 重编译；若 Host 运行在 Electron 的 Node 模式下，配置重编译。
6. 渲染进程暂时只显示连接状态和 Host 版本。
7. 根脚本 pnpm dev 同时启动桌面端（由桌面端负责拉起 Host）。

验收：pnpm dev 打开窗口显示“已连接 + 协议版本”；关闭窗口后无残留 Host 进程；手动先启动 Host 再开桌面端，桌面端连接已有 Host 且退出时不关闭它。
````

### P-T5.2：设计 Token 与布局骨架

依赖：T5.1 · 可并行：否

````text
任务 T5.2：建立 Wevir 自己的设计 Token 和三栏布局骨架。

先读：docs/research/openwork-notes.md 中信息架构与布局建议。

要做：
1. Token（CSS 变量 + Tailwind v4 theme）：颜色（背景层级、文字层级、边框、强调色、成功/警告/危险）、字号、行高、间距、圆角、阴影；亮色与暗色两套，跟随系统并可手动切换。中文字体栈优先（PingFang SC、Microsoft YaHei 等）与等宽字体栈。
2. 布局：左栏（工作区切换 + 会话列表，可折叠）、中栏（会话区域）、右栏（面板占位，可折叠）；窗口最小尺寸下的折叠规则。
3. 基础组件：Button、IconButton、Input、Textarea、Dialog、Tooltip、ScrollArea、StatusDot。可以参考 openwork-notes 中标为可移植的组件，移植时按规则登记来源。
4. 文案集中在一个模块中，默认中文，为 i18n 留口（不必接入 i18n 库）。

不要做：不实现会话逻辑；不复制 OpenWork 的视觉风格（颜色、图标风格）。

验收：亮/暗主题切换正常；三栏在 1280px 与 900px 宽度下布局合理（附截图到 docs/research/skeleton-acceptance/）。
````

### P-T5.3：会话视图

依赖：T5.2 · 可并行：可与 T5.4 并行

````text
任务 T5.3：实现会话视图：流式消息、工具调用卡片、审批、取消。

先读：packages/client-sdk；docs/architecture/domain-model.md 的事件目录；docs/research/openwork-notes.md 中会话视图的部分。

要做：
1. 会话列表（左栏）：按最近活动排序，显示标题与状态；新建会话（选择工作区）。
2. 消息流：订阅事件并按 seq 渲染；助手消息 Markdown 渲染（代码块高亮、可复制）；thought 默认折叠；流式输出时不跳动（只在用户位于底部时自动滚动）。
3. 工具调用卡片：工具名、参数摘要、状态（进行中/成功/失败/被拒绝）、结果摘要，默认折叠，可展开看完整内容。
4. 审批卡片：显示请求内容与选项，允许/拒绝；其他客户端已处理时显示“已在其他设备处理”。
5. 输入框：Enter 发送，Shift+Enter 换行，运行中显示“停止”按钮（调用 session.cancel）。
6. 会话状态指示：空闲、运行中、等待审批、出错（显示错误摘要）。
7. 未识别的 engine.raw 事件以低调的调试样式展示（开发模式可见，生产模式隐藏）。
8. 长会话性能：消息列表虚拟化或分段渲染，1000 条事件时滚动流畅。

验收：用真实 dsh 走一遍：发送任务 → 看到流式输出与工具卡片 → 审批允许 → 再一次审批拒绝 → 运行中取消；附截图。
````

### P-T5.4：设置（Provider 与工作区）

依赖：T5.2 · 可并行：可与 T5.3 并行

````text
任务 T5.4：实现设置页：Provider 管理与工作区管理。

先读：docs/architecture/providers.md；packages/protocol 中 provider.* 与 workspace.* 方法。

要做：
1. Provider 列表、新增、编辑、删除；表单支持 deepseek 与 openai-compatible 两类；Key 输入框为密码类型，保存后只显示“已设置”，不回显。
2. “测试连接”按钮调用 provider.test，结果用可读的中文展示。
3. 新增 openai-compatible Provider 时提供国内常用服务的预设模板（来自 providers.md），用户只需填 Key。
4. 工作区：通过系统文件夹选择器添加，显示路径，支持移除（不删除磁盘文件，确认对话框中写清楚）。
5. 首次启动没有 Provider 或工作区时，主界面显示引导，指向设置页。

验收：从全新数据目录启动 → 按引导配置 Provider 并测试成功 → 添加工作区 → 新建会话可用；附截图。
````

### P-T5.5：重启恢复与断线重连

依赖：T5.3 · 可并行：否 · **Gate M5**

````text
任务 T5.5：保证桌面端在重启和 Host 断线时体验连续。

要做：
1. 记住上次打开的工作区与会话（存在渲染进程本地设置即可），重启后恢复。
2. Host 断开时顶部显示连接状态，client-sdk 自动重连，重连后按 seq 补齐，界面不重复、不丢消息。
3. Host 意外退出时，由桌面端主进程重新拉起（仅限自己拉起的 Host），最多重试 3 次，失败后显示错误与日志路径。
4. 会话处于 error 或只读状态时，界面给出原因与可执行操作（恢复 / 基于历史新建）。

Gate M5（逐条手动验收，截图或录屏存到 docs/research/skeleton-acceptance/，并在汇报中逐条说明）：执行 SKELETON_PLAN §4.2 第 1–7 条。
````

---

## M6 — 骨架收尾

### P-T6.1：开发文档

依赖：M5 · 可并行：可与 T6.3 并行

````text
任务 T6.1：编写 docs/development.md 与 docs/architecture/overview.md。

要做：
1. development.md：环境要求（Node、pnpm 版本）；首次安装；pnpm dev 与各包单独开发方式；数据目录与日志位置；如何用 echo 适配器离线开发；如何跑 dsh 真实测试（需要哪些环境变量）；常见问题。
2. 大陆网络专节：npm registry 切换到 npmmirror；ELECTRON_MIRROR；WEVIR_GITHUB_MIRROR 用于 upstream 同步；模型服务选择建议。每一项都在干净环境里实际验证一次，写明验证日期。
3. overview.md：架构图（mermaid：客户端 → client-sdk → Host → AgentRuntimeAdapter → dsh(ACP) → LLM），各包职责，一次请求的完整数据流，事件从引擎到界面的路径。
4. README.md 更新：项目定位、当前状态（骨架阶段）、快速开始链接。

验收：按 development.md 在一个全新克隆中从零跑起 pnpm dev（记录实际耗时与遇到的问题）。
````

### P-T6.2：CI

依赖：T0.1 · 可并行：可提前到 M1 之后任何时间

````text
任务 T6.2：建立 GitHub Actions CI。

要做：
1. .github/workflows/ci.yml：在 macos-latest 与 windows-latest 上执行 pnpm install（带缓存）、lint、typecheck、test。
2. dsh 相关测试在 CI 中只跑回放模式；真实模型测试不在 CI 中运行。
3. 引擎边界检查（禁止非 adapter 包 import @deepseek-ai/*）作为独立步骤，失败信息清晰。
4. 若 Windows 上有路径、换行或权限（0600）相关测试失败，修正测试或实现，不跳过。

验收：推送到分支后 CI 两个平台均通过（贴出运行链接）。
````

### P-T6.3：上游来源与 NOTICE 核查

依赖：M5 · 可并行：可与 T6.1 并行

````text
任务 T6.3：核查所有移植代码的来源登记，生成 NOTICE。

要做：
1. 在仓库中搜索所有带来源头部的文件，与 docs/upstream/UPSTREAM.md 的移植登记表逐一核对，补齐遗漏。
2. 检查是否存在未登记但明显来自上游的代码（对照 upstream/ 做相似度检查，例如用 jscpd 或简单的 diff 抽样）。
3. 生成根目录 NOTICE：列出移植代码的来源、许可证与版权声明；Apache-2.0 来源需按其 NOTICE 要求处理。
4. 确认没有任何 OpenWork ee/ 来源的代码。

验收：登记表、文件头、NOTICE 三者一致；汇报中列出全部移植文件。
````

### P-T6.4：骨架复盘与 Phase 1 规划

依赖：全部 · 可并行：否 · **Gate M6**

````text
任务 T6.4：骨架阶段复盘，并规划 Phase 1。

要做：
1. 逐条执行 SKELETON_PLAN §4.2 的九条验收，汇报结果。
2. 复盘：哪些估计偏差大、哪些假设被推翻、dsh 接入的实际痛点、事件模型是否需要调整。写入 docs/retro/skeleton.md。
3. 编写 docs/PHASE1_PLAN.md，候选范围：终端面板、Git Diff 审阅、文件预览、Skills/MCP 管理、富信息（计划/todo/标题）的获取方案、Host 常驻 daemon 化、手机端准备（设备令牌、中继选型）。按价值与依赖排序，并为每个任务写好验收标准。
4. 在 TASK_PROMPTS.md 后追加 Phase 1 的 prompt，或新建 docs/PHASE1_PROMPTS.md。
5. 更新 SKELETON_PLAN 状态为“已完成”，在变更记录中写一行。

Phase 1 的范围和优先级需要我确认：用选项列出，不要自行定稿。
````

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-12 | v0.1 初稿：覆盖 T0.1–T6.4，以及 P-NEXT、P-REVIEW、P-HANDOFF、P-PLAN-SYNC、P-TEMPLATE |
