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
2. 除 packages/adapter-dsh 外，任何代码不得 import 或声明依赖 '@deepseek-ai/*'（spikes/ 一次性验证代码豁免，但产品代码不得引用 spikes/）。
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

先读：SKELETON_PLAN §2、§6 M1；docs/adr/0001、0002；docs/research/dsh-integration-spike.md 中的事件样本；docs/research/paseo-notes.md §7.1（ToolCallDetail 与审批选项结构）；docs/research/openwork-notes.md §3.2、§3.9、§4.5。

要做：
1. docs/architecture/domain-model.md：
   - 实体：Workspace、ProviderProfile、Session、ApprovalRequest、WevirEvent。每个实体写字段、类型、含义、谁创建、谁修改。
     - Workspace 至少含 id、rootPath（realpath 规范化，Host 按它去重）、displayName、createdAt；Session 恰属一个工作区。
     - ApprovalRequest 原样携带引擎给的选项列表（id、标签、allow/reject 类别），approval.respond 回传所选选项 ID；详情来自同一 toolCallId 的工具调用输入（ADR-0001 §5）；决定记录 decidedBy（deviceId、clientKind）。
     - ProviderProfile 的 Provider ID 会写进 dsh 会话日志，创建后不可改名（T0.3 §6.2）。
   - 预留实体：Task、Artifact、Device，只写用途和与现有实体的关系，不实现。
   - 区分「产品层事实（Wevir 拥有）」与「引擎事实的投影」，并说明 Wevir 会话 ID 与引擎会话 ID 的映射。标题、seq、会话列表、todo 都是 Wevir 自己推导的（ADR-0001 §5）。
   - 会话状态机：idle、running、awaiting_approval、cancelling、error、closed，画 mermaid 状态图，列出每个转换的触发事件。running 时再 send 返回 session_busy（ADR-0002 §4），写进状态机说明。
   - 审批生命周期：pending → approved / denied / expired / cancelled；幂等规则（首个决定生效，后到者得到 already_decided 与既有决定）；取消、关闭、引擎退出 → cancelled；Host 重启 → expired。
   - 事件类型目录 v0：assistant.delta（来自 T3.2a 旁路的增量）、assistant.message（已提交消息，替换同一回合的增量）、assistant.thought、tool.started、tool.updated、tool.finished、approval.requested、approval.resolved（带 decidedBy）、session.state_changed、usage.updated、engine.error、engine.raw 等，按 Spike 实际看到的内容调整。
   - 工具调用的展示类型：参考 Paseo ToolCallDetail 的分类（shell / read / edit / write / search / fetch / plan / unknown），给出 dsh 工具名（read、write、bash、todo_write、subagent…）到展示类型的映射草案。
   - 决定客户端消息投影是否直接采用 AI SDK UIMessage 的部件形状（ai 包为 Apache-2.0，只用类型），写明理由。
2. 不写实现代码；类型以 TS 代码块写在文档里，供 T1.2 落地。

验收：文档中每个 ACP 事件样本（spikes/dsh-acp/fixtures）都能对应到某个 Wevir 事件类型或 engine.raw。
````

### P-T1.2：Host API v0（protocol 包）

依赖：T1.1 · 可并行：可与 T1.3 并行

````text
任务 T1.2：在 packages/protocol 实现 Host API v0 的类型与 schema。

先读：docs/architecture/domain-model.md；docs/adr/0002（协议部分以它为准）；SKELETON_PLAN §6 T1.2；docs/research/paseo-notes.md §2（兼容纪律的出处）。

要做：
1. PROTOCOL_VERSION 改为 '0.1.0'，并写明兼容规则（主版本不同拒绝连接，次版本向后兼容）。
2. 用 zod 4 定义：领域实体 schema；JSON-RPC 2.0 请求/响应/通知封装（v0 不支持批量）；每个方法的 params 与 result；WevirEvent 封装及按 type 区分的 payload（z.discriminatedUnion）；错误码表（至少 UNAUTHORIZED、INCOMPATIBLE_PROTOCOL、HELLO_REQUIRED、SESSION_NOT_FOUND、INVALID_STATE、SESSION_BUSY、ALREADY_DECIDED、CLIENT_MESSAGE_CONFLICT，命名风格自定但全表统一）；hello 失败时使用的 WebSocket 关闭码。schema 只做结构声明：不用 transform / preprocess / catch，default 只放在原始类型叶子上（ADR-0002 §2）。
3. 方法 v0：host.hello、host.ping、host.shutdown、workspace.list/add/remove、provider.list/upsert/remove/test、session.create/list/get/send/cancel/close/resume、approval.respond、events.subscribe/unsubscribe；服务端推送 events.event。按 ADR-0002：
   - host.hello params：token、protocolVersion、clientKind（desktop、cli，预留 mobile）、deviceId、clientId、capabilities；result：hostId、hostVersion、协商后的 protocolVersion、minProtocolVersion、features、permissions。
   - events.subscribe(sessionId, sinceSeq) 返回 subscriptionId 与回放结束标记（或 replayedThroughSeq）；events.event 带 subscriptionId；events.unsubscribe(subscriptionId)。
   - session.get 返回快照 {state, pendingApprovals, activeTurn, lastSeq, …}；session.send 带可选 clientMessageId；approval.resolved 事件带 decidedBy {deviceId, clientKind}。
4. 导出一个方法注册表（方法名 → params schema / result schema），供 Host 与 client-sdk 共用，避免两边各写一份。
5. docs/architecture/host-api.md：方法表、示例报文、订阅语义（sinceSeq 先补发后实时、不丢不重、回放结束标记）、错误码与关闭码表；另设三节：“兼容规则”（只增不减、新字段 optional、不收窄类型、不再发送的字段继续接受、COMPAT(name) 标签、客户端 capabilities 门控与 features 一处判断）、“工具输出截断上限”、“连接健康”（hello 15 s 超时、host.ping 每 10 s、租约 45 s）。
6. 单测：每个 schema 至少一个合法样例和一个非法样例；事件 payload 联合类型的穷尽性检查；保留“旧消息仍能解析”的样本（新增 optional 字段后旧样本依然通过）。

不要做：不写服务端或客户端实现。

验收：pnpm --filter @wevir/protocol test 与 typecheck 通过；host-api.md 与代码中的方法注册表一致（写一个测试比对方法名列表）。
````

### P-T1.3：AgentRuntimeAdapter 接口、契约测试与 EchoAdapter

依赖：T1.1 · 可并行：可与 T1.2 并行

````text
任务 T1.3：建立 packages/runtime-adapter：引擎适配接口、实现无关的契约测试套件、以及用于开发的 EchoAdapter。

先读：docs/architecture/domain-model.md；docs/adr/0001；SKELETON_PLAN §6 T1.3（接口起点）。

要做：
1. 定义 AgentRuntimeAdapter 及相关类型（SessionConfig、EngineSession、AgentInput、AgentEvent、ApprovalDecision）。AgentEvent 是引擎无关的中间表示，Host 再把它写成 WevirEvent。按 ADR-0001 §7 调整接口，并在代码注释里说明与 SKELETON_PLAN 中草案的差异：
   - cancel 幂等，只在无法确认已停止时失败；
   - 增加列出未决审批的方法，供 Host 重启或客户端中途加入时对账；
   - AgentEvent 区分助手文本增量与已提交消息（后者替换前者）；
   - 引擎进程退出（含回合之间）作为事件上报；
   - 审批请求携带引擎给的选项列表，决定回传所选选项 ID。
2. 契约测试套件：导出 runAdapterContract(createAdapter, capabilities) 函数，覆盖：建会话、发送、收到至少一条助手输出并以完成事件结束、增量之后必有对应的已提交消息、审批允许与拒绝、审批挂起时取消（审批以 cancelled 结束）、取消幂等、关闭后再发送报错、列出未决审批、dispose 后资源释放、并发两个会话互不干扰。capabilities 是能力声明开关（例如 incrementalStream），引擎做不到的条款按开关跳过，不删条款。
3. EchoAdapter：回显输入，先分片发增量再发已提交消息；输入包含 "tool" 时模拟一次工具调用；包含 "approve" 时先发审批请求，等待决定后继续；支持取消。用可控的假时钟或微小延迟模拟流式输出。
4. EchoAdapter 以全部能力开启跑通契约测试。

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
1. 按 ADR-0003 使用 Node 内置 node:sqlite（不加任何 SQLite npm 依赖）。只在一个驱动模块里 import 它：兼容 Database（Node 26.11 起的类名）与 DatabaseSync；只用 Node 22.19 已有的 API，较新的选项先判断是否存在。连接设置：journal_mode=WAL、synchronous=NORMAL、外键开启（显式设置）、busy timeout 5000 ms。数据库文件 <数据目录>/wevir.db。
2. 事务辅助函数 transaction(fn)：BEGIN IMMEDIATE → fn() → COMMIT，抛错 ROLLBACK；fn 必须同步（事务内不得 await），不支持嵌套；在代码注释和测试里写明这条规则。
3. 手写 SQL 迁移（migrations/0001_init.sql 等）+ schema_version 表 + 启动时在事务里自动迁移。
4. 表：workspaces（root_path 唯一）、provider_profiles（只存 secretRef，不存密钥）、sessions（含 engine、engine_session_id、state）、events（session_id、seq、ts、type、source、payload JSON；(session_id, seq) 唯一）、approvals（含 decided_by）、以及 session.send 的 clientMessageId 回执（(session_id, client_message_id) 唯一，存请求指纹与结果状态，ADR-0002 §4）。
5. 密钥存储：SecretStore 接口（get/set/delete by secretRef）+ 骨架实现：数据目录下 secrets.json，权限 0600；写入时先以 0600 创建临时文件再 rename；Windows 上 chmod 不生效，依赖 %APPDATA% 的按用户 ACL，在代码注释与测试里写明。
6. 每张表的仓储函数与测试（使用临时数据库文件）。

验收：pnpm --filter @wevir/storage test 通过；测试覆盖迁移可重复执行、唯一约束生效、事务回滚、secrets 文件权限为 0600（非 Windows）；package.json 中没有 SQLite 相关依赖。
````

### P-T2.2：事件库与回放

依赖：T2.1 · 可并行：否

````text
任务 T2.2：在 packages/host 中实现事件库（EventStore）与会话快照推导。

先读：docs/architecture/domain-model.md 的事件目录与状态机；packages/storage。

要做：
1. EventStore.append(sessionId, event)：在事务中原子分配 seq 并写入，返回完整 WevirEvent；同一会话并发 append 不出现重复或空洞。
2. 助手文本增量合并：增量先在 Host 内按短窗口合并（参考 Paseo 60 ms，窗口首尾各 flush 一次）再分配 seq 落库；遇到不能合并的事件先 flush 缓冲，保证顺序。工具输出在入库前按 host-api.md 的统一上限截断，并标记已截断。
3. readSince(sessionId, sinceSeq, limit)。
4. 进程内事件总线：append 成功后通知订阅者（为 T2.4 的“先补发后实时”打基础）。
5. 会话快照：由事件推导状态、标题、最后活动时间、未决审批列表、当前回合、lastSeq（供 session.get 使用，ADR-0002 §3）；sessions 表中的冗余字段与快照一致。
6. 测试：并发 append；增量合并后的 seq 连续且顺序正确；重开数据库后 readSince 结果一致；快照推导覆盖每一种状态转换。

验收：pnpm --filter @wevir/host test 通过。
````

### P-T2.3：会话管理器与审批状态机

依赖：T2.2、T1.3 · 可并行：否

````text
任务 T2.3：实现 SessionManager，把 AgentRuntimeAdapter 与事件库连起来。

先读：docs/architecture/domain-model.md（状态机、审批生命周期）；docs/adr/0002 §4；packages/runtime-adapter；packages/host 中的 EventStore。

要做：
1. SessionManager：create / send / cancel / close / resume / respondToApproval；维护 Wevir 会话 ID ↔ 引擎会话 ID；消费 adapter.subscribe 的 AgentEvent 并写成 WevirEvent。
2. 每个会话的命令（send、cancel、approval.respond、close）在 Host 内串行执行。状态机严格按文档执行，非法操作返回 INVALID_STATE；会话非 idle 时 send 返回 SESSION_BUSY 和当前状态，不排队、不打断（ADR-0002 §4）。
3. 审批：approval.requested 事件写入 approvals 表；respondToApproval 幂等，首个决定生效：提交到引擎期间暂扣引擎侧的“已解决”事件，成功后写 approval.resolved（带 decidedBy：deviceId、clientKind）；后续响应返回 ALREADY_DECIDED 及已有决定。
4. 取消、关闭会话、引擎退出时，未决审批统一结为 cancelled 并写事件。
5. send 的 clientMessageId：同一 ID 重发返回原结果、不再发给引擎；请求体不同返回 CLIENT_MESSAGE_CONFLICT。
6. 引擎异常：adapter 抛错、流中断或上报进程退出时，会话转 error 并写入错误事件，历史保留。
7. Host 启动时：未决审批标记为 expired；running 状态的会话修正为 error 或 idle（按文档）；“已接受、未确认引擎收到”的发送标为结果未知，不自动重发。
8. 使用 EchoAdapter 完成测试，并跑一遍 runAdapterContract 确认 EchoAdapter 仍然通过。

验收：测试覆盖每条状态转换、SESSION_BUSY、两个客户端并发审批（一个生效、一个 ALREADY_DECIDED）、取消时未决审批结为 cancelled、clientMessageId 重放与冲突、引擎异常、启动修复。
````

### P-T2.4：WebSocket JSON-RPC 服务

依赖：T2.3 · 可并行：否

````text
任务 T2.4：实现 Host 的 WebSocket JSON-RPC 服务。

先读：docs/adr/0002；docs/architecture/host-api.md；packages/protocol 的方法注册表。

要做：
1. 使用 ws 库监听 127.0.0.1，端口默认 0（系统分配）。
2. WebSocket 升级时校验 Host 头（只允许 127.0.0.1:<port> 与 localhost:<port>，缺 Host 头也拒绝）与 Origin（不带 Origin 的放行，带 Origin 的只放行配置的白名单，桌面的 origin 由 T5.1 补充），不合格一律 403（ADR-0002 §1）。
3. 连接的首个请求必须是 host.hello（15 s 超时）：校验 token（常量时间比较）与协议主版本，失败先回 JSON-RPC 错误（UNAUTHORIZED / INCOMPATIBLE_PROTOCOL）再以 host-api.md 规定的关闭码关闭；hello 之前的其他请求回错误后关闭；未知方法回 -32601，data 带 hostVersion 与“请升级 Host”提示。记录每条连接 hello 中的 clientKind、deviceId、capabilities，Host 发出新事件类型前按 capabilities 门控。
4. 基于方法注册表做 params 校验与分发，result 输出前同样校验（开发模式下严格，生产模式下记录告警）。
5. events.subscribe(sessionId, sinceSeq)：返回 subscriptionId；先补发 readSince 的历史，再切换到实时推送，保证不丢不重（补发与追加在同一把会话锁下衔接）；回放结束时给出结束标记；事件通知带 subscriptionId。同一连接可订阅多个会话；多个连接可订阅同一会话；events.unsubscribe(subscriptionId) 释放。
6. 连接健康：host.ping；超过 45 s 没有任何消息的连接断开；每条连接设发送缓冲上限，超限只断这一条。
7. 连接断开时清理订阅（不为断开的客户端保留状态）；服务关闭时通知客户端并等待在途请求结束（有上限）。

验收：集成测试（真实 WebSocket + EchoAdapter）覆盖：缺 Host 头与非法 Origin 被拒、hello 前发其他请求、hello 超时、鉴权失败、版本不符、订阅补发与实时衔接（在补发过程中并发写入事件）、两个客户端同时订阅、一个客户端审批另一个客户端收到 approval.resolved（带 decidedBy）、心跳租约到期断开。
````

### P-T2.5：Host 进程入口

依赖：T2.4 · 可并行：否 · **Gate M2**

````text
任务 T2.5：把 Host 组装成可独立运行的进程。

先读：docs/adr/0002；SKELETON_PLAN §6 T2.5。

要做：
1. packages/host 提供 bin：wevir-host，不依赖桌面即可运行。参数：--home、--adapter echo|dsh（dsh 暂未实现时给出明确错误）、--port（仅调试）、--log-level，以及一个让 Host 持有 stdin 归属管道的参数（名字自定：由桌面拉起时使用，读到 stdin EOF 即优雅退出，ADR-0002 §6）。
2. 数据目录解析：WEVIR_HOME > --home > 平台默认（macOS ~/Library/Application Support/Wevir，Windows %APPDATA%\Wevir，Linux $XDG_DATA_HOME/wevir）；开发脚本使用 ./.wevir-dev。
3. 启动时生成 32 字节随机 token（base64url），只存在于内存与 <home>/run/host.json。host.json 内容：pid、startedAt、url、token、protocolVersion、hostVersion；run/ 目录 0700、文件 0600。启动时以排他创建（wx）占位，监听就绪后再原子写入 url（临时文件 + rename）；已有文件时用 kill(pid, 0) 加 startedAt 判断是否陈旧，活着就拒绝启动并提示，陈旧则回收；退出时只删除 {pid, startedAt} 仍是自己的文件。
4. 结构化日志（JSON 行）写到 <home>/logs/，对 token 与密钥字段脱敏。
5. 优雅退出由 host.shutdown、SIGINT/SIGTERM、归属管道 EOF 触发，顺序：停止接受新连接 → 取消运行中的回合、未决审批结为 cancelled → dispose adapter（回收引擎进程树）→ 刷写 SQLite → 关闭 WebSocket 连接 → 删除 host.json；整体超过 10 s 强制退出。
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

先读：docs/adr/0001（尤其 §2、§4）、docs/adr/0004 §2；docs/research/dsh-integration-spike.md §1、§6.3、§10；spikes/dsh-acp/src/acp.ts 与 src/env.ts 中的启动与环境代码；upstream/deepseek-harness/packages/acp/acp/README.zh.md。

要做：
1. 精确依赖 @deepseek-ai/dsh@0.2.1-alpha.2 与 @agentclientprotocol/sdk@1.4.0（与 dsh-acp 锁定的版本相同），版本写在 docs/upstream/UPSTREAM.md。
2. 构建脚本：pnpm install 后按输出把 dsh 依赖里需要构建的包逐个写进 pnpm-workspace.yaml 的 allowBuilds（T0.3 在 npm 下是 @deepseek-ai/dsh-subprocess-local、koffi、node-pty、protobufjs、@google/genai，pnpm 的范围以实际输出为准），每一项写明允许或拒绝的理由；不用 dangerouslyAllowAllBuilds。同时按 UPSTREAM.md §2.1 用 pnpm 的安装结果重新核对一次依赖闭包的许可证。
3. 解析 dsh 可执行入口（从依赖包中解析，不依赖全局 PATH）。
4. 独立 DSH_HOME：<Wevir 数据目录>/engines/dsh；首次启动时初始化所需目录。
5. 子进程环境按白名单构造（ADR-0001 §4）：不继承用户 shell 里的 Provider Key；注入 DSH_HOME、DSH_AGENTS_HOME（指向 Wevir 专属的空目录）、DSH_TELEMETRY_DISABLED=1、DSH_PERMISSION_MODE=workspace-write；进程 cwd 为 DSH_HOME（必须先建好，否则 spawn 报 ENOENT），绝不能是用户工作区。
6. DshProcess：启动 `dsh --profile acp`，预留 T3.4 的 --patch overlay 插槽，以及 T3.2a 要用的第 4 个 stdio 管道（fd 3）；initialize 的 clientCapabilities 不声明 fs 与 terminal；stdout 只走协议，stderr 保留有界尾部用于诊断；initialize 超时（默认 15 秒，T0.3 实测约 0.5 秒）；进程在任何时候退出（包括回合之间）都上报为引擎错误；有限次数的自动重启（指数退避）；dispose 时关 stdin（T0.3：EOF 后约 25 ms 退出）→ SIGTERM → SIGKILL 阶梯，整个阶梯 5 s 内返回（Host 退出时可能卡住的步骤共用 7 s 预算，超出的被跳过，ADR-0002 补记 3）。ACP 没有 shutdown 方法。Host 被强杀（或跳过 dispose）时，dsh 必须因 stdin EOF 自行退出，它拉起的工具子进程（如 bash 命令）也要随之结束；做不到就改用进程组等办法并写进 ADR-0001。
7. 单个 dsh 进程承载全部会话（T0.3 已验证 3 会话并发，ADR-0001 §2）。

验收：
- 单测：可执行入口解析、DSH_HOME 初始化、白名单环境（用户 shell 的 DEEPSEEK_API_KEY 等不会传入）、dispose 阶梯（用假子进程模拟）。
- 集成测试（需要本机能运行 dsh，不需要模型 Key）：启动 → initialize 成功 → dispose 后无残留进程；运行一个长时间的工具命令时 SIGKILL 掉 Host（wevir-host 子进程），确认 dsh 及其工具子进程都退出。
- pnpm install 在 strictDepBuilds 默认开启下通过。
````

### P-T3.2a：增量流式旁路

依赖：T3.1 · 可并行：可与 T3.4 并行

````text
任务 T3.2a：把 T0.3 的 stream-tap 原型产品化，补上 ACP 没有的增量流式输出。

先读：docs/adr/0001 §3；docs/research/dsh-integration-spike.md §4；spikes/dsh-acp/stream-tap/ 与 spikes/dsh-acp/src/steps/stream-tap.ts；spikes/dsh-acp/fixtures/stream-tap/；upstream/deepseek-harness 中 agent/assistant-stream 事件与插件机制的文档（docs/architecture.zh.md、dsh plugin 命令）。

要做：
1. 在 packages/adapter-dsh 内实现 Cordis 插件（产品代码不得引用 spikes/，照原型重写）：监听 agent/assistant-stream，把 start / chunk / end 帧连同 sessionId 以 NDJSON 写到 WEVIR_STREAM_FD 指定的 fd；不写 stdout；只用 Cordis 的 ctx，不 import @deepseek-ai/*。
2. 装配：首次初始化 DSH_HOME 时用 `dsh plugin --profile acp add link:<插件目录>` 安装，overlay 中 insert 该插件；启动时开 fd 3 并设 WEVIR_STREAM_FD=3（T3.1 已预留）。插件目录在开发模式下指向 workspace 中的包；打包后的路径留接口。
3. 适配器读取 fd 3：逐行解析，按会话产出增量 AgentEvent（文本与推理分开）；畸形行记录告警并跳过。
4. 退化：插件未加载、fd 无数据或解析失败时，适配器只产出 ACP 的已提交消息，其他功能不受影响；在契约测试的能力声明里体现。

不要做：不修改 dsh 源码；不做增量与已提交消息的合并（属于 T3.2）。

验收：
- 单测：NDJSON 解析（含分片跨行、畸形行）。
- 集成测试（真实 dsh + 本地 mock Provider，复用 spikes/dsh-acp/src/mock-llm.ts 的做法，不需要 Key）：首个增量明显早于 ACP 的整条消息到达（T0.3：85 ms 对 3317 ms）；去掉插件后会话照常完成。
````

### P-T3.2：ACP → Wevir 事件映射

依赖：T3.1、T3.2a · 可并行：可与 T3.4 并行

````text
任务 T3.2：把 ACP 的 session/update 映射为 AgentEvent，并与 T3.2a 的增量合并。

先读：spikes/dsh-acp/fixtures/ 全部样本（主要输入是 fixtures/acp/mock/）；docs/research/dsh-integration-spike.md §3、§4、§11.2；docs/adr/0001 §5；docs/architecture/domain-model.md 的事件目录与工具展示类型；packages/runtime-adapter 中 AgentEvent 定义；ACP 官方文档中 session/update 的各类型。

要做：
1. 纯函数 mapAcpUpdate(update) → AgentEvent[]，覆盖 dsh 实际发送的类型：agent_message_chunk（一条已提交消息一个 chunk）、agent_thought_chunk、tool_call / tool_call_update（含状态和结果摘要）、usage_update、config_option_update。
2. 合并增量：T3.2a 的增量按会话实时产出；ACP 的 agent_message_chunk 到达时以它为准替换同一回合的增量（attemptId 与 messageId 不同，按会话内顺序对齐）；取消时 ACP 一次补发的半段消息同样替换增量。
3. 工具调用：ACP 的 kind 恒为 other、没有 locations / diff，按工具名（title 字段）映射到 domain-model.md 的展示类型，并从 rawInput 提取路径；todo_write 的 rawInput 解析为完整 todo 列表事件。
4. 错误归类：session/prompt 以 -32603 失败时，按错误文本前缀归类（缺凭据、Provider 错误、未知），始终保留原文（样本见 fixtures/acp/errors/）。
5. 未识别类型映射为 engine.raw，原样保留 payload，不丢弃，并记录一次告警日志。
6. 在 adapter 中接入：每个引擎会话一个有序事件队列，保证事件顺序与 ACP 交付顺序一致。
7. docs/architecture/acp-event-mapping.md：ACP 类型 → Wevir 事件类型 → 说明，每行附 fixture 文件名；另列工具名 → 展示类型表与错误归类表。

验收：以 fixtures 为输入的快照测试；每个 fixture 都有对应测试；增量被已提交消息替换的测试（含取消时的半段消息）；映射文档与代码一致。
````

### P-T3.3：审批桥接

依赖：T3.2 · 可并行：否

````text
任务 T3.3：把 ACP 的 session/request_permission 桥接到 Wevir 审批流程。

先读：spike 报告 §5（权限请求）与 fixtures/acp/mock/permission/、transcripts/B-permission-allow.jsonl；docs/adr/0001 §5–§6；docs/architecture/domain-model.md 的审批生命周期；packages/host 的 SessionManager。

要做：
1. 收到 request_permission 时生成 AgentEvent(approval.requested)：requestId、关联的工具调用、人类可读摘要、可选项。请求本身只带 toolCallId，摘要与详情（路径、内容摘要、sandbox_permissions、模型给的 justification）取同一 toolCallId 之前那条 tool_call 的 rawInput；选项原样携带 ACP 给的列表（dsh 只有 allow_once / reject_once，没有 always 类选项）。
2. respondToApproval 把决定转换为 ACP 响应（{"outcome":{"outcome":"selected","optionId":…}}）；客户端取消或会话关闭时，必须以 {"outcome":{"outcome":"cancelled"}} 回复挂起的审批，否则 dsh 侧悬挂。
3. 未决审批的超时策略：默认不超时（等待用户），但 Host 退出时统一回复 cancelled；Host 重启后残留的未决审批标记为 expired。
4. 与 T2.3 的幂等规则配合：重复决定不重复发送给 dsh。
5. 在 acp-event-mapping.md 里写明：dsh 的审批只来自沙箱升级（workspace-write 下，工作区内读写与系统临时目录写入都不需要审批；工作区外的操作先失败，模型带 sandbox_permissions 重试才触发审批）。UI 文案与测试用例据此设计。

验收：用 fixtures 回放的单测覆盖 allow、deny、取消时的未决审批、重复决定；真实 dsh + mock Provider 的集成测试覆盖一次 allow 与一次 deny（不需要 Key）；真实模型集成测试（需 WEVIR_TEST_API_KEY，否则跳过）的提示必须包含一次工作区外、且不在系统临时目录的写入。
````

### P-T3.4：Provider 配置桥接

依赖：T3.1 · 可并行：可与 T3.2 并行

````text
任务 T3.4：把 Wevir 的 ProviderProfile 转换为 dsh 配置，并实现 provider.test。

先读：spike 报告 §6（Provider 注入，§6.2 有可直接复制的 overlay）与 spikes/dsh-acp/overlays/、src/overlays.ts；docs/adr/0001 §4 与未决事项；upstream/deepseek-harness/docs/user/guide/providers.md；upstream/deepseek-harness/docs/config-catalog.zh.md 中 dsh-llm-pi-ai 与 DeepSeek 官方适配器的字段。

要做：
1. ProviderProfile 支持两种 kind：deepseek（官方，走 llm-deepseek）与 openai-compatible（走 llm-pi-ai：baseURL、api 取 openai-completions / openai-responses、compat（非 OpenAI 官方地址多数需要 supportsDeveloperRole: false、maxTokensField: max_tokens）、模型列表含 contextWindow 与最大输出、是否支持图片、推理档位）。anthropic-messages 协议只预留类型。Provider ID 小写连字符，会写进 dsh 会话日志，创建后不可改名。
2. 生成 dsh overlay 文件（写在 DSH_HOME 下的 Wevir 专用目录，内容只含 apiKeyEnv 变量名，不含密钥）；web-search-deepseek 的 Key 引用（默认 DEEPSEEK_API_KEY）一并改为 Wevir 的变量；DeepSeek 的 OpenAI 兼容端点若走 pi-ai，加 compat.thinkingFormat: deepseek 与 requiresReasoningContentOnAssistantMessages: true（T0.3 §6.2）。启动 dsh 时以 --patch 传入，并通过子进程 env 注入密钥（变量名形如 WEVIR_PROVIDER_<ID>_KEY）。
3. Provider 变更后的生效策略：T0.3 没有测过，本任务实测是热更新还是必须重启 dsh 进程，在文档中写明对运行中会话的影响，并补记到 ADR-0001。
4. OAuth 类 Provider（订阅账号登录）不做（ADR-0001 未决事项 1）。
5. provider.test：用最小请求验证连通性与 Key 有效性，返回可读的错误（网络不可达、401、模型不存在、协议不兼容）。
6. 在 docs/architecture/providers.md 给出国内常用服务的 openai-compatible 示例配置（DeepSeek、通义千问 DashScope、Kimi、智谱 GLM），注明 baseURL 需以各服务当前文档为准。

验收：单测确认 overlay 中无密钥、子进程 env 包含密钥；集成测试（有 Key 时）provider.test 成功，错误 Key 返回 401 类错误。
````

### P-T3.5：会话恢复

依赖：T3.3 · 可并行：否

````text
任务 T3.5：实现基于 ACP session/resume 的会话恢复。

先读：spike 报告 §3.2 与 §8（resume 的发现）；packages/host 的 SessionManager 与启动修复逻辑。

要做：
1. resumeSession：对已关闭或 Host 重启后的会话调用 ACP session/resume（使用保存的 engine_session_id 与会话创建时的工作区路径；dsh 按 realpath 比较 cwd，不一致会被拒）。同一 dsh 进程里仍活跃的会话不能 resume（-32602 session is already active），要先按状态机处理。
2. 界面历史、会话列表与标题始终从 Wevir 事件库读取，不依赖引擎回放（resume 不发任何 update，session/list 只有 sessionId 与 cwd）。
3. 引擎会话已不存在（DSH_HOME 被清理、版本升级导致不兼容）时：会话标记为只读并给出明确原因，允许用户基于历史新建会话（新建逻辑只需留接口）。
4. 写入一条 session.resumed 事件，记录引擎版本，便于将来排查跨版本问题。

验收：集成测试（有 Key 时）：建会话 → 对话 → 重启 Host → resume → 追问能引用之前的内容；无 Key 时用 fixtures 覆盖引擎会话丢失的分支。
````

### P-T3.6：适配器契约测试

依赖：T3.5、T3.4 · 可并行：否 · **Gate M3**

````text
任务 T3.6：让 dsh 适配器通过与 EchoAdapter 相同的契约测试，并建立 dsh 升级流程。

要做：
1. 用 runAdapterContract 分三层跑 DshAdapter：
   - 回放模式：使用 T0.3 录制的 ACP 交互（实现一个基于 fixtures 的假 dsh 进程或传输层替身），CI 默认跑。
   - 真实 dsh + 本地 mock Provider：照 spikes/dsh-acp/src/mock-llm.ts 的做法在测试里实现一个脚本化的 OpenAI Chat Completions 流式 mock（不得 import spikes/），不需要 Key 即可端到端覆盖工具、审批、取消、resume 与增量旁路（T0.3 的同类套件约 25 秒）。是否进 CI 由 T6.2 按耗时决定。
   - 真实模型：需 WEVIR_TEST_API_KEY 与 WEVIR_TEST_PROVIDER（无则跳过并打印原因）。
2. 若某些契约条款 dsh 无法满足，用契约套件的能力声明开关跳过，而不是删除条款，并在 ADR-0001 补记。
3. docs/upstream/UPSTREAM.md 增加「dsh 升级检查清单」：读上游 CHANGELOG、docs/persistence-changes/releases/ 与 ACP README 的已知限制变化 → 更新锁定版本（dsh 与 @agentclientprotocol/sdk 一起核对）→ 重新录制 fixtures → 跑三层契约测试（必须包含增量旁路，它依赖的 agent/assistant-stream 不是公开契约）→ 对比事件映射表与错误文本归类 → 重新核对依赖闭包的许可证与 allowBuilds。
4. 把 Host 的 --adapter dsh 接通。

Gate M3：回放模式与“真实 dsh + mock Provider”两层契约测试全绿；真实模型模式在本机跑通一次并贴出结果；wevir-host --adapter dsh 能启动。
````

---

## M4 — 竖切联通：CLI

### P-T4.1：client-sdk

依赖：T2.4 · 可并行：可在 M3 期间进行

````text
任务 T4.1：实现 packages/client-sdk，供 CLI、桌面端以及将来的手机端共用。

先读：docs/architecture/host-api.md；docs/adr/0002 §2、§3、§5、§7；packages/protocol 的方法注册表；docs/research/paseo-notes.md §3（事件补发）与 §9.1 的 A4、A6、A16、A21；docs/research/openwork-notes.md §3.1 与候选 #1（重连状态机）。

要做：
1. WevirClient：connect({ url, token } 或从 run/host.json 读取；只连 host.json 里的 url，不回退到任何默认端口）；自动发送 host.hello（token、protocolVersion、clientKind、deviceId、clientId、capabilities）；client-sdk 维护一份穷举的默认能力表，CLI 与桌面继承；按 hello 结果的 features 一处判断功能是否可用；基于方法注册表的类型安全 request；错误映射为类型化错误。
2. subscribe(sessionId, { sinceSeq }) 返回异步迭代器：按 seq 应用事件（seq == lastSeq + 1 接受，<= 丢弃，更大视为缺口并以 sinceSeq = lastSeq 重新订阅）；收到回放结束标记前不算追平；断线后指数退避重连，重连后自动以最大 seq 续订（拿到新的 subscriptionId），对上层透明且保证不重复。
3. 连接健康：每 10 s 发 host.ping；请求超时、连接超时、心跳超时分开配置，在本任务定默认值。
4. 连接状态事件（connecting、connected、reconnecting、closed）供 UI 显示。阶段与退避可参考 OpenWork 的 sync-stream-lifecycle.ts（鉴权类失败走慢速重试、静默看门狗）；若改写其代码，按规则写文件头并登记到 UPSTREAM.md。
5. 运行环境：Node 与浏览器（Electron 渲染进程）都能用：只依赖 packages/protocol，不 import Node 内置模块，WebSocket 由调用方注入，传输层是可替换接口；读取 host.json 的功能放在单独的 node 入口。

验收：针对真实 Host（echo 适配器）的集成测试：正常流程；在流式输出中途强制断开连接，重连后事件完整且无重复；人为制造 seq 缺口时自动补齐；构建产物的浏览器入口不含 node: 导入。
````

### P-T4.2：`wevir` CLI

依赖：T4.1、T3.6 · 可并行：否 · **Gate M4**

````text
任务 T4.2：实现 apps/cli，完成第一条真正可用的竖切流程。

先读：packages/client-sdk；SKELETON_PLAN §6 T4.2 与 §4.2。

要做：
1. 命令：wevir host start|status|stop；wevir workspace add|list <path>；wevir provider add|list|test（交互式输入 Key，不回显，不写入 shell 历史）；wevir session new -w <path> "<prompt>"；wevir session list；wevir session attach <id>。
   - host start 以分离方式启动 Host（不持有归属管道），桌面之后附着到它、退出时不会停止它；host stop 走 host.shutdown RPC（Windows 上无法用信号优雅停止，ADR-0002 §6）；host status 读 host.json 并探活。
2. attach：实时渲染助手输出（增量）和工具调用摘要；遇到审批时交互式询问（按请求携带的选项）；另一端已审批时显示“已由 <clientKind/deviceId> 处理”；会话忙时发送得到 SESSION_BUSY，给出提示；Ctrl-C 第一次取消当前运行，第二次退出 attach。
3. 输出中文为主，错误信息给出下一步建议（例如 Host 未启动时提示 wevir host start）。
4. 依赖尽量少（参数解析与交互输入各选一个轻量库）。

Gate M4（真实 dsh + 真实模型，逐条执行并在汇报中贴输出）：
- 在临时目录放几个 CSV，执行 wevir session new 让它汇总并写 summary.md，过程中至少出现一次审批；文件内容正确。dsh 只在沙箱升级时请求审批：工作区内的写入和系统临时目录的写入都不会触发（ADR-0001 §6），所以提示里要再要求一次工作区外、且不在系统临时目录的写入（例如把 summary.md 另存一份到用户主目录下的一个测试目录）。若真实模型没有按提示带 sandbox_permissions 重试、审批始终不出现，如实汇报，并列出备选做法交我决定。
- 另开一个终端 wevir session attach 同一会话，两端看到相同的事件；在第二个终端审批，第一个终端同步显示结果。
- wevir host stop → start → session list 历史完整 → attach 后继续追问，模型能引用之前的内容。
````

---

## M5 — 桌面壳

### P-T5.1：Electron 壳与 Host 生命周期

依赖：T4.2 · 可并行：否

````text
任务 T5.1：创建 apps/desktop 的 Electron 壳，负责拉起或连接 Host。

先读：docs/adr/0002 §6–§7、docs/adr/0004 §3；docs/research/openwork-notes.md §2（apps/desktop、Electron 安全设置）；docs/research/paseo-notes.md §1.4（桌面先发现后拉起、只停自己拉起的）；upstream/openwork/apps/desktop、upstream/paseo/packages/desktop/src/daemon 与 upstream/deepseek-harness/apps/desktop 的主进程代码（只作参考）；Electron 官方安全清单与 “ES Modules” 文档。

要做：
1. 按 ADR-0004 §3 选版本：electron-vite 最新正式版及它支持的最高 Vite 主版本（2026-10 为 electron-vite 5 + Vite 7），Electron 用开工时的最新稳定版；不用 beta。建立 main / preload / renderer 三段结构；renderer 为 React + Tailwind v4。
2. 主进程：读取 run/host.json 并探活（连接 + hello），Host 在运行就附着；否则用开发者本机的 Node 以子进程启动 workspace 中的 wevir-host（带归属管道参数 --exit-on-stdin-eof，主进程持有其 stdin），记下 {pid, startedAt}，等待 stdout 的就绪行或 host.json 出现 url（退出码 3 表示已有 Host 在运行，改为附着；见 ADR-0002 补记 3）；应用退出时只停止自己拉起的 Host（关闭归属管道，超时再 host.shutdown），附着的 Host 不停。打包后的运行时不在本任务范围（ADR-0002 未决事项 1）。
3. preload 只通过 contextBridge 暴露最小接口：getHostConnection()（url、token）、选择文件夹对话框、打开外部链接。preload 打成单个 CJS 文件（沙箱里的 preload 不能用 ESM；多入口时用 electron-vite 的 isolatedEntries）。渲染进程不读 host.json，令牌只放内存。
4. 安全基线：contextIsolation true、sandbox true、nodeIntegration false、严格 CSP；拦截 will-navigate 与 window.open，外部链接经 shell.openExternal；Chrome 远程调试端口只在开发模式开启。把渲染进程的 origin（开发服务器与打包后的协议）补进 Host 的 Origin 白名单与 host-api.md。
5. 在 allowBuilds 中登记 electron（postinstall 下载二进制，镜像见 .npmrc 的 ELECTRON_MIRROR）。存储用 node:sqlite（ADR-0003），Host 跑在系统 Node 上，不涉及 Electron 原生模块重编译。
6. 渲染进程暂时只显示连接状态和 Host 版本。
7. 根脚本 pnpm dev 同时启动桌面端（由桌面端负责拉起 Host）。

验收：pnpm dev 打开窗口显示“已连接 + 协议版本”；关闭窗口后无残留 Host 进程；强制杀掉桌面主进程后 Host 因归属管道 EOF 自行退出；手动先用 wevir-host（或 wevir host start）启动 Host 再开桌面端，桌面端附着到已有 Host 且退出时不关闭它。
````

### P-T5.2：设计 Token 与布局骨架

依赖：T5.1 · 可并行：否

````text
任务 T5.2：建立 Wevir 自己的设计 Token 和三栏布局骨架。

先读：docs/research/openwork-notes.md §1（信息架构）、§6（Token 架构与它的问题）、§8（候选 #13、#14、#17–#21）、§9.1 与 §9.3（布局与 Token 建议）；docs/adr/0004 §4。

要做：
1. Token 三层：原始色阶取自 @radix-ui/colors npm 包（只取一个中性色系、一个强调色和红 / 琥珀 / 绿三个状态色）→ 一套语义变量（背景层级、文字层级、边框、强调色、成功/警告/危险、sidebar 等，只保留一套，不像 OpenWork 那样两套并存）→ Tailwind v4 的 @theme inline；字号、行高、间距、圆角（由一个 --radius 推导阶梯）、阴影；亮色与暗色两套，暗色只认 <html data-theme="dark">（@custom-variant dark），跟随系统并可手动切换；首帧前脚本与运行时读同一个存储 key，并同步 Electron nativeTheme（可参考 OpenWork 候选 #17 的 theme.ts，移植时修掉它的两处问题并登记来源）。正文 14px / 行高 1.6，代码 13px；系统字体栈（-apple-system、PingFang SC、Microsoft YaHei 等）与等宽字体栈，不引入网络字体。
2. 布局：左栏（“工作区 → 会话”两级树，会话行带运行中 / 待审批 / 出错 / 未读标记，底部放设置与 Host 连接状态；220–400 可拖，可折叠）、中栏（会话区域，内容限宽居中）、右栏（默认收起，数据结构按“每会话一组标签 {type, …}”设计，骨架只放占位）；窗口最小宽度约 960px 下的折叠规则。路由 /workspace/:wid/session/:sid、/workspace/:wid/session（新会话草稿）、/settings/:tab，URL 是当前工作区与会话的唯一事实，资源不存在时显示“未找到”，不回落到第一个工作区。
3. 基础组件：Button、IconButton、Input、Textarea、Dialog、Tooltip、ScrollArea、StatusDot。用 shadcn CLI 从官方 registry 生成 Base UI 版本的原语（不从 OpenWork 拷贝），图标用 lucide。
4. 文案集中在一个模块中，默认中文且中文为源语言，所有导航文案都走这个模块，为 i18n 留口（不必接入 i18n 库）。

不要做：不实现会话逻辑；不复制 OpenWork 的视觉风格（颜色、图标风格）。

验收：亮/暗主题切换正常；三栏在 1280px 与 900px 宽度下布局合理（附截图到 docs/research/skeleton-acceptance/）。
````

### P-T5.3：会话视图

依赖：T5.2 · 可并行：可与 T5.4 并行

````text
任务 T5.3：实现会话视图：流式消息、工具调用卡片、审批、取消。

先读：packages/client-sdk；docs/architecture/domain-model.md 的事件目录；docs/research/openwork-notes.md §3（会话视图）、§3.9（与 dsh 数据的对照）、§8 候选 #3、#4、#6、#9。

要做：
1. 会话列表（左栏）：按最近活动排序，显示标题与状态（含“待审批”，审批可能来自另一个客户端）；新建会话（选择工作区）。
2. 消息流：订阅事件并按 seq 渲染；助手消息 Markdown 渲染（代码块高亮、可复制），流式时只重新渲染末尾的块、已定的块复用（参考 OpenWork 候选 #4，改写需登记来源），代码高亮等流式结束且进入视口后再做；可见会话按帧冲刷增量；thought 默认折叠；贴底 / 手动两种滚动模式，离开底部时出现“跳到最新”（参考候选 #3）。
3. 工具调用卡片：工具名、参数摘要、状态（进行中/成功/失败/被拒绝）、结果摘要，默认折叠，可展开看完整内容；回合已结束而工具未收尾时显示“状态未知”，不无限转圈；连续的读取 / 搜索类调用可聚合成一张。
4. 审批卡片：内联在输入框上方，不用模态框；一次显示一个，标出“还有 N 个待审批”；内容取同一 toolCallId 的 rawInput（路径、内容摘要、模型给的理由）；按请求携带的选项渲染按钮（骨架只有“允许一次 / 拒绝”）；另一端先处理时按 approval.resolved 收起并提示“已由 <设备> 处理”。
5. 输入框：Enter 发送，Shift+Enter 换行，输入法合成期间不发送；运行中不允许再发送（Host 会返回 SESSION_BUSY），发送键变为“停止”（调用 session.cancel），Esc 也可停止。
6. 会话状态指示：空闲、运行中、等待审批、出错（显示错误摘要）。
7. 未识别的 engine.raw 事件以低调的调试样式展示（开发模式可见，生产模式隐藏）。
8. 长会话性能：消息列表虚拟化或分段渲染，1000 条事件时滚动流畅。

验收：用真实 dsh 走一遍：发送任务 → 看到流式输出与工具卡片 → 审批允许 → 再一次审批拒绝 → 运行中取消；附截图。（触发审批的任务要包含工作区外、且不在系统临时目录的操作，原因同 Gate M4。）
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
4. 工作区：通过系统文件夹选择器添加（Host 按 realpath 去重，重复添加返回已有工作区），显示路径，支持移除（只注销、不删除磁盘文件，确认对话框中写清楚）。
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
3. Host 意外退出时，由桌面端主进程重新拉起（仅限自己拉起的 Host；附着的 Host 只显示断开并等待它回来），最多重试 3 次，失败后显示错误与日志路径。重新拉起前按 host.json 的 {pid, startedAt} 确认旧进程已退出。
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
3. overview.md：架构图（mermaid：客户端 → client-sdk → Host → AgentRuntimeAdapter → dsh(ACP + 增量旁路) → LLM），各包职责，一次请求的完整数据流，事件从引擎到界面的路径。
4. 安全说明（放在 development.md 或单独文件）：信任边界是操作系统用户（同一用户的进程都能读 run/host.json 里的令牌）；secrets.json 在 Windows 上依赖 %APPDATA% 的按用户 ACL；dsh 的 workspace-write 模式允许写系统临时目录且不需要审批；DSH_AGENTS_HOME 被隔离（见 docs/adr/0001、0002、0003）。
5. README.md 更新：项目定位、当前状态（骨架阶段）、快速开始链接。

验收：按 development.md 在一个全新克隆中从零跑起 pnpm dev（记录实际耗时与遇到的问题）。
````

### P-T6.2：CI

依赖：T0.1 · 可并行：可提前到 M1 之后任何时间

````text
任务 T6.2：建立 GitHub Actions CI。

要做：
1. .github/workflows/ci.yml：在 macos-latest 与 windows-latest 上执行 pnpm install（带缓存，strictDepBuilds 保持开启）、lint、typecheck、test。Node 用 .node-version；另加一个 engines 下限 Node 22.19 的 job（至少跑 storage 与 host 的测试），覆盖 node:sqlite 在各版本间的 API 差异（ADR-0003）。
2. dsh 相关测试在 CI 中默认跑回放模式；“真实 dsh + mock Provider”一层（T3.6，不需要 Key）按耗时决定是否进 CI，写明理由；真实模型测试不在 CI 中运行。
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
3. 生成根目录 NOTICE：列出移植代码的来源、许可证与版权声明；Apache-2.0 来源需按其 NOTICE 要求处理；从 OpenWork MIT 区域移植的文件若含第三方派生内容（Radix Colors、shadcn 生成的组件等，UPSTREAM.md §2.2），一并保留原始声明。
4. 确认没有任何 OpenWork ee/ 来源的代码。
5. 依赖许可证：按 UPSTREAM.md §2.1 用当前 lockfile 重新核对 dsh 依赖闭包（MPL-2.0 的 @deepseek-ai/libreoffice-kit*、LGPL-3.0 的 sharp libvips 等），以及 Wevir 自己引入的非 MIT 依赖，整理成第三方声明草稿与分发义务清单（打包阶段使用）。

验收：登记表、文件头、NOTICE 三者一致；汇报中列出全部移植文件。
````

### P-T6.4：骨架复盘与 Phase 1 规划

依赖：全部 · 可并行：否 · **Gate M6**

````text
任务 T6.4：骨架阶段复盘，并规划 Phase 1。

要做：
1. 逐条执行 SKELETON_PLAN §4.2 的九条验收，汇报结果。
2. 复盘：哪些估计偏差大、哪些假设被推翻、dsh 接入的实际痛点、事件模型是否需要调整。写入 docs/retro/skeleton.md。
3. 编写 docs/PHASE1_PLAN.md，候选范围：终端面板、Git Diff 审阅、文件预览、Skills/MCP 管理（扩展库统一入口、SKILL.md 兼容 .claude/skills 与 ~/.agents/skills、远程 MCP 的“加密保险库 + 本地网关”托管 OAuth、按工作区生效的授权目录，见 openwork-notes §5.4）、是否共享用户的 ~/.agents（ADR-0001 未决事项 2）、富信息（计划/todo/标题/子 agent）的获取方案（同一 Cordis 插件补发事件）、“总是允许”审批规则、OAuth 类 Provider 的 Spike（ADR-0001 未决事项 1）、密钥迁移系统钥匙串（ADR-0003 未决事项 2）、Host 常驻 daemon 化与打包运行时（ADR-0002 未决事项）、手机端准备（设备令牌、中继选型）。按价值与依赖排序，并为每个任务写好验收标准。
4. 在 TASK_PROMPTS.md 后追加 Phase 1 的 prompt，或新建 docs/PHASE1_PROMPTS.md。
5. 更新 SKELETON_PLAN 状态为“已完成”，在变更记录中写一行。

Phase 1 的范围和优先级需要我确认：用选项列出，不要自行定稿。
````

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-12 | v0.1 初稿：覆盖 T0.1–T6.4，以及 P-NEXT、P-REVIEW、P-HANDOFF、P-PLAN-SYNC、P-TEMPLATE |
| 2026-10-12 | 通用前缀规则 2：补充“不得声明依赖”与 spikes/ 豁免，与 SKELETON_PLAN §2.2 一致 |
| 2026-10-12 | T0.6：按 ADR-0001–0004 同步 P-T1.1–P-T6.4：协议细节（hello 参数与结果、subscriptionId、快照、clientMessageId、SESSION_BUSY、approval.resolved/decidedBy、兼容规则、Host/Origin 校验、心跳）、host.json 与归属管道、node:sqlite 与 SecretStore、dsh 进程环境与 allowBuilds、新增 P-T3.2a 增量流式旁路、T3.2 合并增量、T3.6 三层契约测试、Gate M4 审批用例需工作区外操作、T5.1 preload CJS 与版本规则、T5.2/T5.3 的 OpenWork 布局建议、T6.2 Node 下限 job、T6.3 依赖许可证、T6.4 候选范围 |
| 2026-10-13 | T2.5：P-T5.1 写明归属管道参数名 `--exit-on-stdin-eof`、就绪行与退出码 3（ADR-0002 补记 3） |
| 2026-10-13 | T2.5：P-T3.1 补 dispose 阶梯 5 s 上限，以及 Host 被强杀时 dsh 与工具子进程随 stdin EOF 退出的要求与验收 |
