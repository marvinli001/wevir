# Wevir Phase 1 任务 Prompt 库

> 配套：[PHASE1_PLAN.md](./PHASE1_PLAN.md) · 建立日期：2026-10-14（T6.4）
> 状态：v1.0。范围与顺序以 [PHASE1_PLAN §5](./PHASE1_PLAN.md) 的任务表为准（2026-10-14 确认）；标“Phase 2”的 prompt 没有选入 Phase 1，保留备用，执行前先按当时的计划复核。
> 每个 prompt 对应 PHASE1_PLAN §3 的一个候选任务 ID。用法与骨架阶段相同（[TASK_PROMPTS.md](./TASK_PROMPTS.md#使用方法)）：新会话，先粘贴下面的通用前缀，再粘贴任务 prompt。

---

## 通用前缀

````text
你在 Wevir 仓库（/Users/marvin/Developer/wevir）工作。Wevir 是面向中国大陆用户的本地优先、开源、多模型、可跨设备接续的 Agent 工作台：以 DeepSeek Harness（dsh）为 Agent 执行内核，Wevir 自己拥有 Local Agent Host、会话协议和客户端。骨架阶段已完成，现在是 Phase 1。

开始前先读：
- AGENTS.md
- docs/PHASE1_PLAN.md 的 §0–§2（规则、前置条件、目标）、§3 中本任务的条目、§5（任务表、里程碑与 Gate）
- docs/retro/skeleton.md（骨架复盘，尤其 §3 被推翻的假设、§4 dsh 的痛点）
- 本任务 prompt 中「先读」列出的文件

硬性规则：
1. 只做本任务。发现计划有问题，先改 docs/PHASE1_PLAN.md 与对应 ADR，再改代码；不擅自扩大范围或提前做后续任务。
2. 除 packages/adapter-dsh 外，任何代码不得 import 或声明依赖 '@deepseek-ai/*'（spikes/ 豁免，但产品代码不得引用 spikes/）。
3. upstream/ 是只读参考。移植上游代码时，文件头写明来源仓库、路径、提交 SHA、许可证，并登记到 docs/upstream/UPSTREAM.md；同时更新 NOTICE。OpenWork 的 ee/ 目录禁止参考和移植。
4. 不要读取 ~/Downloads 下的原始调研聊天记录。
5. 密钥不得写入仓库、日志、测试快照或 DSH_HOME。
6. 涉及第三方库、框架或上游项目的 API 时，先查当前文档或 upstream/ 中的源码，不凭记忆写。
7. 代码风格与仓库已有代码保持一致；不加与任务无关的抽象。
8. 协议只加不减（docs/architecture/host-api.md §10）：新字段 optional、新事件类型直接发；改协议就升版本并加冻结样本。
9. 在自己的 git worktree 里工作（与其他并行任务隔离）；新增原生依赖要登记 allowBuilds，并在 ADR 里写明打包时的处理。

完成后：
- 运行本任务的验收步骤，贴出命令和结果（失败就如实说明）。需要外部条件（真实模型 Key、虚拟机、证书）而没有执行的，写明缺什么，不算通过。
- 在 docs/PHASE1_PLAN.md §5 的任务表里把本任务改为 [x]，备注写主要产出或提交号。
- 提交一次 commit，message 以任务 ID 开头，例如 "A1: parse dsh tool results into structured output"。
- 最后用中文汇报：做了什么；验收结果；与计划的偏离及原因；给下一个任务的注意事项。
````

---

## 前置

### P-P0.2：真实模型补跑

依赖：维护者提供的测试 Key · 可并行：否

````text
任务 P0.2：用真实模型补跑骨架阶段因为没有 Key 而跳过的检查。

先读：docs/adr/0001-runtime-integration.md 的未决事项 3 与补记 3–7；docs/development.md 中真实模型测试的环境变量；docs/research/skeleton-acceptance/README.md 的 T6.4 一节。

Key 由维护者在终端里设置为环境变量（WEVIR_TEST_API_KEY 等），你不要读取、打印或写入它的值。

要做：
1. 跑 adapter-dsh 第 3 层契约测试与 T3.3–T3.5 的真实模型用例、provider.test 的真实端点用例，贴出结果。
2. 按 ADR-0001 未决事项 3 记录：模型被沙箱拒绝后是否带 sandbox_permissions 重试（至少 5 次，统计成功率）、首个增量与整条消息的时间差、usage_update 的数值、DeepSeek 官方路由。
3. 用桌面端（docs/development.md 的 pnpm dev）在临时工作区完成 SKELETON_PLAN §4.2 第 8 条的多步骤 CSV 任务，存截图。
4. 结果补记到 ADR-0001（关闭未决事项 3 或写明仍不成立的部分）与验收存档；模型不按提示升级时，在 PHASE1_PLAN 的 D1、C6 下写明影响。

验收：以上测试的命令与结果；ADR-0001 补记；验收存档里的第 8 条真实模型截图。
````

---

## A 审阅与文件

### P-A1：工具结果结构化与回合改动记录

依赖：无 · 可并行：可与 B1、C1、C3、D1、G2 并行

````text
任务 A1：把 dsh 工具的结果解析成结构化字段，并让 Host 记录每个回合改动过的文件。

先读：docs/architecture/acp-event-mapping.md；docs/architecture/domain-model.md §6–§7；packages/adapter-dsh/src/{acp-mapping,tool-display}.ts；packages/adapter-dsh/src/test-fixtures/acp/ 的样本；upstream/deepseek-harness 中 read / write / edit / bash 工具的实现与结果格式；docs/research/skeleton-acceptance/README.md T6.4 一节末尾的两个界面问题。

要做：
1. 适配器按 dsh 的结果格式解析 read / write / edit / bash（以及 glob / grep 的命中列表）：路径、类型、行数、退出码、摘要；tool.finished 增加可选的结构化 output。格式对不上时保留原文、不报错，告警一次。
2. 改动前内容的来源，比较 PHASE1_PLAN A1 条目列出的三处（write / edit 工具结果的 meta.diffs 经 session/event 旁路取得；把 dsh-workspace-changes 插件经 overlay 装进 acp 并在回合结束时取走 summary / diff；Host 自己的影子快照），考虑 bash 改的文件、dsh 会话释放后数据消失、大工作区的耗时，选定做法并写 ADR-0001 补记；旁路新增的内容按 stream-tap 的规则“失败即降级”。
3. Host 在回合结束时写 files.changed（路径、新建 / 修改 / 删除、增删行数、改动前后内容的引用）；改动前内容的存放位置、上限与清理规则写进 domain-model。
4. 协议升到 0.4.0，加冻结样本 compat/0.4.0.json；client-sdk 投影与桌面工具卡片改用结构化 output（不再显示 <path> 包装），CLI 的 render 同步。

不要做：diff 界面（A2）、文件预览（A3）。

验收：真实 dsh + 脚本化模型的一个回合里 write 新建、edit 修改、bash 删除各一个文件，files.changed 列出三者与正确的增删行数；工具卡片截图没有 <path>；0.1.0–0.3.0 的冻结样本仍能解析；解析失败降级为原文的测试。
````

### P-A2：Git Diff 审阅

依赖：A1 · 可并行：可与 A3 并行

````text
任务 A2：在右栏实现“改动”标签，按回合与会话审阅 Agent 改动的文件，并支持按文件还原。

先读：A1 的产出（files.changed、ADR-0001 的补记）；apps/desktop/src/renderer/src/layout/right-panel-tabs.ts；docs/research/openwork-notes.md §1.4、§3.6、候选 #8（简易 diff 着色，只参考）。

要做：
1. Host API：按会话 / 回合取改动列表与单个文件的 diff（Host 计算，渲染进程不读文件）；git 工作区另给“相对 HEAD 的全部改动”。
2. 右栏“改动”标签：按回合分组的文件列表（新增 / 修改 / 删除、增删行数），统一 diff 视图（行号、折叠未改动段、长行处理），大文件与二进制只显示摘要；消息里的写类工具卡片可跳到对应 diff。
3. 按文件还原到回合开始前的内容：用 A1 记录的改动前内容，不用 git restore（它回到 HEAD，会丢掉用户在回合之前没提交的修改）；确认对话框写明会覆盖磁盘文件，文件在回合之后又被改过时提示冲突；还原写一条事件，另一端同步。
4. diff 库的选择按 ADR-0004 的规则查 npm 当前版本与许可证，登记在 ADR-0004 补记。

验收：同一会话两个回合改 4 个文件，“改动”标签按回合分组、行数与 git diff --stat 一致；还原一个文件后磁盘内容回到改动前，另一个客户端看到还原事件；截图存 docs/research/phase1-acceptance/（用 G2 的验收脚本）。
````

### P-A3：文件预览与成果面板

依赖：A1 · 可并行：可与 A2 并行

````text
任务 A3：右栏“文件”标签与消息里的成果文件 chip。

先读：A1 的产出；docs/research/openwork-notes.md §3.6、候选 #11、#22；apps/desktop/src/main/index.ts 的安全基线与 CSP。

要做：
1. Host API files.list / files.read：只服务工作区内的路径（realpath 后判断，移植 OpenWork #22 并登记来源，Windows 大小写不敏感），读取设上限（如 1 MB，超出只读开头并说明）。
2. 右栏“文件”标签：工作区文件树（懒加载、忽略 .git 与 node_modules 等），预览 Markdown、代码（高亮）、CSV / 表格、图片、PDF、纯文本；在 CSP 下可行的做法写进 ADR-0004 补记（图片与 PDF 的来源、是否需要新的协议处理）。
3. 成果：写类工具的路径与 dsh present 工具的文件列表在消息里显示为文件 chip：打开预览、在访达 / 资源管理器中显示、用默认应用打开（后两者经主进程 IPC，校验路径仍在工作区内）。

验收：§4.2 第 8 条的 summary.md 出现 chip，点开在右栏渲染为表格；指向工作区外的符号链接被拒绝（测试）；50 MB 文件只读前 1 MB 并提示；截图存档。
````

### P-A4：终端面板

依赖：无（打包时依赖 E2）· 可并行：是

````text
任务 A4：桌面端底部坞里的用户终端，由 Host 管理 PTY。

先读：docs/adr/0002-host-transport-and-process-model.md（连接、权限位、发送缓冲）；docs/architecture/host-api.md；node-pty 与 xterm.js 的当前文档；B1 的结论（是否同时显示 Agent 后台任务的输出）。

要做：
1. Host：terminal.create / write / resize / close 与按终端 ID 的输出订阅（输出带自己的序号，断线后补发最近 N KB）；shell 的 cwd 是工作区；Host 退出时结束所有 PTY 进程组；node-pty 登记 allowBuilds，打包时的 ABI 处理写进 ADR（交给 E2）。
2. 权限：hello 的 permissions 里加终端权限，本机的桌面与 CLI 默认有，将来的手机端默认没有；没有权限时方法返回 UNAUTHORIZED。
3. 桌面：底部坞（可收起、可调高度、多个标签），xterm.js 渲染，主题跟随 Token；渲染进程刷新后重新附着。
4. CSP 与 xterm.js 的兼容（是否需要内联样式）写进 ADR-0004 补记。

验收：两个终端标签运行 ls、vim、top，缩放窗口后列宽正确；刷新渲染进程后终端仍在、最近输出补回；Host 退出后 shell 进程不在（进程树检查，Windows 另验）；没有终端权限的连接调用被拒（测试）。
````

---

## B 引擎富信息

### P-B1：Spike：stream-tap 补发富信息

依赖：无 · 可并行：是

````text
任务 B1：评估用 Wevir 的 Cordis 插件（stream-tap）补发标题、todo、plan、子 agent 活动与用量的可行性。只做 Spike，不改产品代码。

先读：docs/adr/0001-runtime-integration.md 决策 3、5 与补记 2；docs/research/dsh-integration-spike.md §7（ACP 与 SDK 的差异）；packages/adapter-dsh/stream-tap/；upstream/deepseek-harness 中 SDK profile 的事件来源（session/title、todo/write、subagent.*、user/message）与 Cordis 事件的定义。

要做：
1. 在 spikes/ 里写一个扩展版插件，订阅与上述信息有关的进程内事件，按会话输出 NDJSON；真实 dsh + 脚本化模型跑一个含 todo_write、两个 subagent、计划模式（若能触发）的场景，录样本。
2. 逐项记录：事件名与 payload、触发时机、与 ACP 更新的先后、是否能归属到父会话、在 dsh 源码里是公开契约还是内部实现（引用文件与行号）。
3. 给出 B2 的事件设计草案（复盘 §5 第 2 条）与“旁路失效时的退化”。

产出：docs/research/dsh-rich-events.md，ADR-0001 补记（决策 5 第 10 条），样本在 spikes/。

验收：报告覆盖标题、todo、plan、子 agent、用量五类，每类有样本与稳定性评估；不改 packages/ 与 apps/。
````

### P-B2：富信息事件与界面

依赖：B1 · 可并行：否

````text
任务 B2：把 B1 选定的富信息做进产品：适配器产出、协议事件、桌面与 CLI 的展示。

先读：docs/research/dsh-rich-events.md；docs/architecture/domain-model.md §6；packages/adapter-dsh/stream-tap/；docs/upstream/UPSTREAM.md §7（dsh 升级检查清单）。

要做：
1. stream-tap 按 B1 的设计输出富信息帧；适配器映射为 plan.updated、subagent.started / subagent.finished（含子 agent 活动的归属字段）、引擎来源的标题；旁路失效时退化为现状并告警。
2. 协议升版本并加冻结样本；domain-model 的事件目录与 acp-event-mapping 同步（由测试核对）。
3. 桌面：输入框上方的待办面板（折叠显示“完成数 / 总数”）、计划展示、子 agent 卡片可展开看它的工具调用与最终回复；CLI attach 显示同样的信息。
4. UPSTREAM.md §7 加上富信息旁路的测试。

验收：脚本化场景里 todo 三次更新、两个子 agent 并行，桌面与 CLI 显示一致（截图与 CLI 记录）；去掉插件后会话照常完成；契约测试与升级清单通过。
````

---

## C 扩展

### P-C1：决定是否共享用户的 ~/.agents

依赖：无 · 可并行：是

````text
任务 C1：按已确认的方向 ①（继续隔离，扩展库提供导入；PHASE1_PLAN §4 第 3 题），写 ADR-0005 关闭 ADR-0001 未决事项 2（DSH_AGENTS_HOME 是否共享用户的 ~/.agents）。

先读：docs/adr/0001-runtime-integration.md §4 与补记 1；docs/research/openwork-notes.md §5.1、§5.4；upstream/deepseek-harness 中 skills 与 AGENTS.md 的发现与注入逻辑。

要做：
1. 复核 PHASE1_PLAN C1 条目里 T6.4 记下的 dsh 规则（skills 根目录与优先级、skills 插件的 agentsHome 与 AGENTS.md 的环境变量分开、项目级 .agents/skills 与 AGENTS.md / CLAUDE.md 已随工作区生效、不认 .claude/skills），用真实 dsh + 脚本化模型测量请求体在各方案下的变化（dsh 的 user/message 带 source.kind，可以分出注入的上下文）。
2. 写 ADR-0005：选定方案、对 C2 的约束（发现根目录、生效粒度、变更是否要重启 dsh）、安全考虑（AGENTS.md、CLAUDE.md 与项目级 skills 都是提示词注入面，不可信仓库作为工作区时怎么提示用户）。
3. docs/security.md 补上项目级文件会进入会话这一点。
4. 只改配置所需的最小代码（如 overlay 里 skills 插件的 agentsHome），完整的 Skills 管理留给 C2。

验收：ADR-0005 Accepted；真实 dsh 验证选定方案下哪些 skills 进入会话、用户级与项目级 AGENTS.md 是否注入，附请求体大小对比；security.md 已更新。
````

### P-C2：Skills 管理

依赖：C1 · 可并行：可与 C3 并行

````text
任务 C2：Host 侧的 Skills 发现、校验、启用与编辑，以及桌面的 Skills 列表。

先读：docs/adr/0005-*.md（C1）；docs/research/openwork-notes.md §5.1、候选 #26（改写需登记来源）。

要做：
1. Host 按 ADR-0005 的根目录发现 skills，解析与校验 SKILL.md frontmatter（名称、描述、触发说明；名称与目录名一致；坏条目带错误列出而不是跳过；同名先到先得并标出被遮蔽的条目）。
2. 启用 / 停用与生效范围按 ADR-0005 的粒度；变更要重启 dsh 时走 ADR-0001 补记 5 的路径（没有回合时重启，会话 resume）。
3. 新建、从文件夹导入、编辑 SKILL.md（写入只到 Wevir 管理的目录，不改用户的 ~/.agents）。
4. Host API 与桌面列表（扩展库的统一入口在 C5，这里先做设置里的一页）。

验收：工作区放一个 skill、全局放一个、再放一个 frontmatter 坏掉的，列表显示三项且坏的带错误；启用后脚本化模型在真实 dsh 里调用 skill 工具、结果里有 skill 正文；停用后不再出现。
````

### P-C3：MCP 管理（本地 stdio 与远程 HTTP）

依赖：无 · 可并行：是

````text
任务 C3：Host 管理 MCP 配置并在会话创建 / 恢复时挂到 dsh；不含 OAuth（C4）。

先读：docs/research/openwork-notes.md §5.2（配置结构、状态枚举、Claude Desktop 写法）；@agentclientprotocol/sdk 1.4.0 中 session/new、session/resume 的 mcpServers 类型；upstream/deepseek-harness 中 ACP 对 mcpServers 的处理（支持哪些传输）。

要做：
1. storage 迁移：MCP 配置表（全局与工作区两级，local / remote，headers 与环境变量里的密钥只存 SecretStore 引用）。
2. 适配器在 session/new 与 session/resume 时传 mcpServers；配置变更对已开会话的影响（下次 resume 生效，还是要重启）实测后写 ADR-0001 补记。
3. 状态：连接成功、失败（原因）、需要授权；工具列表；Claude Desktop 的 command + args 写法导入。
4. Host API 与桌面设置页（C5 再合并进扩展库）；CLI wevir mcp list|add|remove。

验收：仓库里写一个最小的 stdio MCP 测试服务，另起一个本地 HTTP MCP，真实 dsh 的会话里脚本化模型调用到两者的工具；工作区级配置只出现在该工作区的会话；Key 不出现在 dsh 的命令行、日志与 DSH_HOME（全文搜索）。
````

### P-C4：远程 MCP 托管 OAuth（Phase 2）

依赖：C3、D2 · 可并行：否

````text
任务 C4：远程 MCP 的托管 OAuth：Host 当 OAuth 客户端，令牌存加密保险库，dsh 只看到本地网关。

先读：docs/research/openwork-notes.md §5.2 第 4 条与候选 #28（只参考，不移植）；MCP 授权规范的当前版本（PKCE、动态客户端注册、受保护资源元数据）；D2 的 ADR（主密钥）。

要做：
1. 先写 ADR 与威胁模型：网关只监听 127.0.0.1、每会话短期令牌、令牌与第三方令牌的生命周期、撤销。
2. Host：OAuth 授权流程（系统浏览器打开授权页、本地回调、PKCE），令牌加密存放（主密钥按 D2），自动刷新；本地网关把 dsh 的请求转发给远程 MCP 并带上第三方令牌。
3. C3 的 MCP 配置加“托管 OAuth”类型；桌面显示“需要授权 / 已授权 / 已过期”与授权、撤销操作。

验收：本地起一个带 OAuth 的测试 MCP 服务，授权后会话能调用它的工具；dsh 的进程环境、命令行、DSH_HOME 与 Host 日志里都搜不到第三方令牌；令牌过期后自动刷新；撤销后网关返回 401、界面显示“需要授权”。
````

### P-C5：扩展库统一入口

依赖：C2、C3 · 可并行：否

````text
任务 C5：把 Skills 与 MCP 合并成一个“扩展”入口（设置页与右栏）。

先读：C2、C3 的产出；docs/research/openwork-notes.md §1.4、§5.4、候选 #29（扩展清单 schema，只参考）。

要做：
1. 统一的扩展列表：类型、来源（Wevir / 工作区 / 用户目录）、生效范围、状态，坏条目与连接失败给原因与操作；筛选与搜索。
2. 右栏的扩展入口（当前会话生效的扩展一览）。
3. 文案全部走 i18n；为将来的插件类型留数据模型的位置，不实现。

验收：C2、C3 验收里的条目都出现在同一列表，筛选与开关可用；截图存档。
````

### P-C6：按工作区生效的授权目录（Phase 2）

依赖：D1 · 可并行：否

````text
任务 C6：用户为某个工作区授权额外的目录，Agent 在其中的操作不必每次审批。

先读：docs/research/openwork-notes.md §4.3、§4.5；docs/adr/0001-runtime-integration.md §6 与补记 4；upstream/deepseek-harness 中沙箱可写根（packages/sandbox）的配置方式；D1 的产出。

要做：
1. dsh 不能加可写根（T6.4 核实：packages/sandbox/sandbox/src/roots.ts 固定为工作区、/tmp 与 os.tmpdir()），所以做成 D1 的规则类型：write / edit 的升级请求目标在授权目录下时自动允许并留审计；bash 的升级判断不了路径，仍要审批。复核后写进 ADR-0001 补记。
2. 工作区设置里管理授权目录（系统文件夹选择器，realpath 规范化，不能是系统目录或用户主目录本身）。
3. 审计：每次自动放行都有事件，界面可见。

验收：工作区 X 授权目录 D 后写 D 不出现审批卡片、事件里有审计记录；写 D 之外仍要审批；工作区 Y 的会话写 D 仍要审批（测试）。
````

---

## D 审批与安全

### P-D1：“总是允许”审批规则

依赖：无 · 可并行：是

````text
任务 D1：Host 侧的审批规则，让用户对同类操作不必重复审批；同时改进审批前“被沙箱拒绝”的展示。

先读：docs/adr/0001-runtime-integration.md §5 第 7 条、§6、补记 4；docs/architecture/acp-event-mapping.md §5；docs/architecture/domain-model.md §5；packages/host/src/session-manager.ts 的审批部分；apps/desktop/src/renderer/src/session/approval-*.ts(x)；P0.2 的结论（真实模型是否按提示升级）。

要做：
1. 规则模型：作用域（本会话 / 本工作区）、匹配条件（工具 + 路径前缀，或 dsh 申请的权限级别），只能放宽到用户点过的范围；存储迁移；Host 重启后仍在。
2. 审批卡片在引擎选项之外加“本会话内允许同类操作”“在此工作区总是允许”；命中规则时 Host 代为回复 allow_once，approval.resolved 的 decidedBy 记规则与规则 ID（协议升版本）；规则在设置里列出、可撤销。
3. 审批之前那次被沙箱拒绝的工具调用与随后的审批合并展示（不再是红色“失败”卡片）。
4. CLI attach 的审批提示同样提供规则选项。

验收：同一会话第二次写同一目录不再出现卡片、事件有规则 ID；撤销后恢复审批；Host 重启后规则仍在；工作区 Y 的会话不受工作区 X 的规则影响（测试）；截图存档。
````

### P-D2：密钥迁移系统钥匙串（Phase 2）

依赖：无 · 可并行：是

````text
任务 D2：按 ADR-0003 未决事项 2，把 Host 的密钥从 0600 的 secrets.json 迁到系统钥匙串。

先读：docs/adr/0003-storage.md；packages/storage 的 SecretStore；docs/research/openwork-notes.md 候选 #25（safeStorage 主密钥，改写需登记）；Electron safeStorage 与候选钥匙串库的当前文档。

要做：
1. ADR：比较 ① Host 用原生钥匙串库、② 桌面主进程用 safeStorage 保护主密钥并经归属管道交给 Host（CLI 单独启动时的退路）、③ Host 调系统命令（macOS security、Windows DPAPI）；考虑 CLI 启动的 Host、打包（E2）、Windows ACL、钥匙串弹窗。
2. 实现选定方案，SecretStore 接口不变；首次启动把 secrets.json 迁移过去并删除原文件；钥匙串不可用时的退路与提示。
3. C4 的令牌保险库主密钥用同一机制。

验收：迁移后 secrets.json 不在、Provider 照常工作；macOS 与 Windows CI 上 SecretStore 测试通过；钥匙串不可用的退路有测试；ADR Accepted。
````

---

## E 运行时与分发

### P-E1：Spike：OAuth 类 Provider

依赖：无 · 可并行：是

````text
任务 E1：按 ADR-0001 未决事项 1，评估订阅账号登录类 Provider。只做 Spike，不改产品代码。

先读：docs/adr/0001-runtime-integration.md 未决事项 1；docs/research/dsh-integration-spike.md §6.4；upstream/deepseek-harness 中登录命令与凭据存放（.credentials.yaml）的实现；docs/architecture/providers.md。

要做：
1. 列出值得支持的服务（国内优先），逐家查条款是否允许第三方客户端使用订阅账号。
2. 核实 dsh 的登录流程、grant 的存放与刷新，能否重定向凭据位置或由环境变量注入、刷新能否由 Host 代做。
3. 在 spikes/ 里至少走通一家的登录与一次对话（用维护者自己的账号，凭据不进仓库）。
4. 给出推荐方案与 SKELETON_PLAN §2.8“密钥不落引擎文件”是否需要修改的结论。

产出：docs/research/oauth-providers.md、ADR-0001 补记。

验收：报告含条款结论、技术方案与一次走通的记录；仓库里没有任何凭据。
````

### P-E2：打包运行时与第一个安装包（Phase 2）

依赖：无 · 可并行：可与 A、B、C 组并行

````text
任务 E2：决定打包后 Host 与 dsh 跑在哪个 Node 上，做出 macOS 与 Windows 的未签名安装包。

先读：docs/adr/0002-host-transport-and-process-model.md 未决事项 1 与补记 5、7；docs/adr/0003-storage.md 未决事项 1；docs/adr/0001-runtime-integration.md 补记 2 的“待定（打包）”；docs/upstream/third-party-notices.md；PHASE1_PLAN E2 条目里的预备实测；electron-builder 或 electron-forge 的当前文档。

要做：
1. 比较 (a) ELECTRON_RUN_AS_NODE、(b) 随包带独立 Node、(c) utilityProcess：node:sqlite 与 storage 全部测试、dsh 原生模块（node-pty、koffi）的 ABI、stream-tap 按路径插入（不依赖 pnpm）、启动时间、安装包大小、Windows 上 job object 与优雅退出（ADR-0002 补记 7）。
2. 写 ADR-0006 定方案；打包配置进仓库；migrations/ 与 stream-tap 随包；第三方声明与 MPL / LGPL 义务按 third-party-notices.md 落实。
3. 安装包的下载地址可配置镜像（大陆网络）。

不要做：签名、公证、自动更新、Linux。

验收：干净的 macOS 与 Windows 虚拟机（没有 Node、没有 pnpm）安装后完成建会话、流式输出、审批、重启恢复（§4.2 第 1–6 条，模型用脚本化 mock 或真实 Key）；安装包大小与冷启动时间记录在 ADR-0006。需要的虚拟机由维护者提供，没有就如实写明未执行。
````

### P-E3：Host 常驻 daemon（Phase 2）

依赖：E2 · 可并行：否

````text
任务 E3：让 Host 可以在桌面端关闭后继续运行、登录时启动。

先读：docs/adr/0002-host-transport-and-process-model.md 决策 6、未决事项 2、补记 5–7；docs/research/paseo-notes.md §1（D9）；ADR-0006（E2）。

要做：
1. ADR：常驻模式下的归属（桌面从“拥有”改为“附着”）、单实例、升级时的替换、日志轮转、是否需要 supervisor / worker。
2. 设置项“关闭窗口后 Host 继续运行”“登录时启动”（macOS LaunchAgent，Windows 计划任务或 Run 键）；菜单栏 / 托盘入口（打开窗口、退出 Host）。
3. 关闭设置后恢复骨架行为（桌面拉起、随桌面退出）。

验收：开启后关闭桌面端，CLI 仍能 attach 并继续对话；注销重新登录后 Host 自动运行；关闭设置后行为与骨架一致；macOS 与 Windows 各验一次。
````

---

## F 手机端准备

### P-F1：设备与凭据模型（Phase 2）

依赖：无 · 可并行：是

````text
任务 F1：实现 Device 实体、一次性配对邀请、按设备凭据、权限与撤销。

先读：docs/architecture/domain-model.md §3.6（Device）；docs/adr/0002-host-transport-and-process-model.md 未决事项 3；docs/research/paseo-notes.md §5、§9 的 D2、D3。

要做：
1. ADR：principal / credential / grant 分离、权限词表（含 A4 的终端权限）、邀请的有效期与一次性、凭据只存哈希、撤销后的连接处理。
2. storage 迁移、Host API（device.invite / list / revoke）、host.hello 出示设备凭据（本机令牌仍给本机客户端）、方法按权限检查。
3. 桌面“设备”设置页；CLI wevir device invite|list|revoke，以及用邀请换凭据的测试客户端。

验收：模拟的第二台设备凭邀请换得凭据后能 hello，邀请再用失败、过期失败；撤销后该设备的连接立即断开、再连被拒；缺少某权限的方法调用被拒（测试）。
````

### P-F2：Spike：中继选型（Phase 2）

依赖：F1 · 可并行：否

````text
任务 F2：选定手机端经中继连接 Host 的方案，并做出原型。只做 Spike。

先读：docs/research/paseo-notes.md §6、§9 的 D1、D4；SKELETON_PLAN §2.7（大陆网络可替换）；F1 的 ADR。

要做：
1. 比较：自写最小中继、参考 Paseo 中继协议（Apache-2.0）、现成隧道（frp 等）；条件是能在大陆自托管、不默认指向海外地址。
2. 端到端加密按 Paseo D1 补上：会话内防重放、两个方向分开的密钥或 nonce 前缀、客户端在加密通道内出示 F1 的设备凭据、Host 密钥轮换。
3. spikes/ 里的原型：CLI 客户端经自托管中继 attach 到本机 Host。

产出：报告与 ADR（中继与加密）。

验收：两台不同网络的机器之间跑通 attach 与审批；抓包确认中继只见密文；重放一帧被拒绝。需要的服务器由维护者提供，没有就在本机两个网络命名空间或容器里模拟并写明。
````

### P-F3：会话列表变更推送

依赖：无 · 可并行：是

````text
任务 F3：Host 级的会话列表订阅，替掉桌面左栏的每会话订阅与定时重读。

先读：docs/architecture/host-api.md §4（订阅）；apps/desktop/src/renderer/src/data/workbench-store.ts；docs/research/paseo-notes.md §3.4、§9 的 D6。

要做：
1. 协议：sessions.subscribe（游标、增量、墓碑、游标过期时给全量快照），升版本并加冻结样本。
2. Host 实现；client-sdk 的订阅与断线续传；桌面左栏改用它（不再每 10 s 重读、不再每会话一条订阅）；CLI session list --watch。

验收：另一个客户端新建、关闭会话、触发审批，左栏 1 s 内更新；100 个会话时桌面端的订阅数为 1；断线重连按游标补齐（测试）。
````

---

## G 骨架遗留与工具

### P-G1：“基于历史新建会话”的 Host API

依赖：无 · 可并行：是

````text
任务 G1：落地 T3.5 定下的 SessionFromHistory 接口，桌面端改用它。

先读：docs/architecture/domain-model.md §4.4、§10；packages/host 中 SessionFromHistory 的定义；apps/desktop/src/renderer/src/session/history-digest.ts。

要做：
1. Host API 方法与 HOST_FEATURES 项：从只读（或任意）会话的事件库整理历史，作为新引擎会话的首条上下文；新会话记录来源会话 ID。
2. 桌面“基于历史新建会话”改调这个方法；CLI 提供同样的命令。

验收：只读会话 → 基于历史新建 → 脚本化模型检查新会话首个请求里有旧历史；新会话事件里有来源会话 ID；截图存档。
````

### P-G2：验收工具化

依赖：无 · 可并行：是（建议第一个做）

````text
任务 G2：把骨架验收中每次临时重写的驱动与脚本放进仓库，让 §4.2 第 1–8 条可以一条命令重跑。

先读：docs/research/skeleton-acceptance/README.md（Gate M5、T6.1、T6.4 各节的做法与踩过的坑）；docs/development.md；packages/adapter-dsh/src/testing.ts（startMockModel）。

要做：
1. scripts/accept/：CDP 驱动（点击、按标签填表、键入、等待、截图；窗口被遮挡时强制出帧）、主进程 inspector 替换文件夹对话框、脚本化模型的场景库（读写、审批、长回答、多步骤 CSV、上下文计数）、expect 或 node-pty 驱动的 CLI。
2. pnpm accept：全新临时数据目录与工作区 → pnpm dev → 逐条跑 §4.2 第 1–8 条（模型用脚本）→ 截图与报告写到指定目录 → 关闭应用、停掉 mock、删掉临时目录与工作区外的测试文件。
3. 写进 docs/development.md；CI 暂不跑（需要图形环境），本机运行。

验收：pnpm accept 在本机从零跑完、全部通过、留下截图与报告；结束后没有残留进程（pgrep 检查）与临时目录。
````

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-14 | v0.1 草案（T6.4）：通用前缀与 A1–G2、P0.2 的 prompt |
| 2026-10-14 | v1.0（T6.4）：范围确认后改状态；通用前缀改读 PHASE1_PLAN §5 的任务表；C1 写明方向 ①；没选入 Phase 1 的七个 prompt 标“Phase 2” |
