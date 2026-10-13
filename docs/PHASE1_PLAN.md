# Wevir Phase 1 规划

> 状态：**v1.0，范围与顺序已确认**（2026-10-14，维护者在 T6.4 中确认，§4）· 建立日期：2026-10-14（T6.4）· 维护者：marvinli001
> 配套：[PHASE1_PROMPTS.md](./PHASE1_PROMPTS.md)（每个候选任务的 prompt）· [retro/skeleton.md](./retro/skeleton.md)（骨架复盘）· [SKELETON_PLAN.md](./SKELETON_PLAN.md)（规则 §0、地基原则 §2 继续有效）

本文件回答：骨架之后先做什么、为什么、每一步怎么算完成。§3 是全部候选（含没选入 Phase 1、留给 Phase 2 的），§5 是确认后的任务表、里程碑与 Gate。

---

## 0. 规则

沿用 SKELETON_PLAN §0 与 AGENTS.md：一个任务一个会话一次提交；计划与现实不符先改计划和 ADR；引擎只在 `packages/adapter-dsh` 后面；`upstream/` 只读、移植要登记；密钥不落地。复盘新增三条：

1. **Gate 分两种。** 代码 Gate 用真实 dsh + 脚本化模型，阻塞下游任务；需要外部条件的检查（真实模型 Key、签名证书、真机、中继服务器）单列，写明负责人与期限，不阻塞下游，但阶段结束前必须补齐（复盘 §6 第 1 条）。
2. **并行任务用 git worktree**，不在同一个 checkout 里并行（复盘 §6 第 3 条）。
3. **验收可重跑。** 涉及界面的验收用 G2 的验收脚本，结果与截图存 `docs/research/phase1-acceptance/`。
4. **完成一个任务时**：运行验收、在 §5 的任务表里勾选并写备注、提交一次 commit（message 以任务 ID 开头，如 `A1: …`）。

---

## 1. 前置条件：骨架遗留（不属于 Phase 1，建议先关掉）

| # | 事项 | 现状 | 怎么关 |
|---|---|---|---|
| P0.1 | T4.2 提交、Gate M4 | CLI 代码与 28 条测试完成；Gate M4 要真实模型，在等 Key | 维护者提供一个测试用 Key（DeepSeek 官方或国内 OpenAI 兼容服务），T4.2 的会话跑完 Gate M4 后提交 |
| P0.2 | 真实模型补跑 | Gate M3 第 3 层、ADR-0001 未决事项 3（模型是否按沙箱提示升级、首字时间差、`usage_update`）、`provider.test` 真实端点、§4.2 第 8 条，全部“本机没有 Key，未运行” | 同一个 Key，一个会话跑完，结果补记 ADR-0001 与验收存档；模型不按提示升级时，审批的设计要回到 D1 重新考虑 |
| P0.3 | 推送与 CI | `31a91ea`（T6.1）之后的提交未推送 | 推送，CI 四个 job 通过 |

---

## 2. Phase 1 要回答的问题

骨架证明了“Host + dsh + 多端事件流”这条线走得通。Phase 1 让它**日常可用**：用户能看清 Agent 改了什么、打开它交付的文件、少被重复打断、用上自己的 Skills 与 MCP、看到计划与子 agent 的进度；同时把“装到别人电脑上”和“手机接续”的地基决策做掉。候选范围来自 SKELETON_PLAN §6 T6.4、§7 与 ADR 的未决事项；排序依据是价值、依赖和复盘里暴露的风险。

---

## 3. 候选任务

规模：S ≈ 一个会话，M ≈ 一到两个会话，L ≈ 需要拆分。价值从用户每天能否感到差别来判断。

### A 审阅与文件（工作台三件套）

**A1 工具结果结构化与回合改动记录**（基础）· 依赖：无 · 规模 M · 价值 高（A2、A3 的前提）
- 适配器按 dsh 的结果格式（`<path>…</path><type>…</type><content>…</content>`、bash 的退出码与输出）把 `read` / `write` / `edit` / `bash` 等工具的结果解析成结构化字段，`tool.finished` 增加可选的 `output`（路径、行数、退出码、摘要）；卡片不再显示原始包装（复验看到的问题）。
- Host 记录每个回合改动过的文件，新事件 `files.changed`（回合结束时写一次：路径、类型、增删行数、改动前后内容的引用）。dsh 自己有三处来源，ACP 都没交出来，由本任务选定并写进 ADR-0001 补记：
  1. `write` / `edit` 的工具结果带 `meta: {diffs: [{path, oldText, newText}], operation}`（上游 `packages/fs/tool-fs/src/diff.ts`），ACP 只发文本（`packages/acp/acp/src/updates.ts`），进程内 `session/event` 的 `tool/result` 里拿得到——只覆盖文件工具，`bash` 改的文件不在其中。
  2. `dsh-workspace-changes` 插件按回合记录工作区改动（git 快照 + 被工具改过的文件的整份副本），经 `ctx.workspaceChanges.summary()` / `diff()` 提供并追加 `workspace/changes` 事件（上游 `docs/subsystems/deliverables.md`）；只装在 web 的 bundle 里，acp 没有，可以经 overlay 插入。数据随 dsh 会话释放，Host 要在回合结束时取走存进自己的库。
  3. Host 在回合开始时自己做影子快照（不依赖 dsh，代价是大工作区的耗时）。
  dsh 没有撤销 / 回滚功能，A2 的还原由 Host 做。
- 协议升到 0.4.0（只加 optional 字段与新事件类型）。
- 验收：真实 dsh + 脚本化模型的回合里 `write` 新建、`edit` 修改、`bash` 删除各一个文件，`files.changed` 列出三者与正确的增删行数；工具卡片显示路径与摘要，不出现 `<path>`；0.3.0 的冻结样本仍能解析；dsh 改了结果格式时解析失败只降级为原文，有测试覆盖。

**A2 Git Diff 审阅** · 依赖：A1 · 规模 M · 价值 高
- 右栏“改动”标签（每会话一组标签的设计已在 T5.2）：按回合与会话累计列出改动文件，统一 diff 视图（新增 / 删除 / 修改、行号、折叠未改动段），大文件与二进制只给摘要。
- git 工作区额外提供“相对 `HEAD` 的全部改动”；按文件还原到回合开始前的内容（用 A1 记录的改动前内容，不用 `git restore`：后者回到 `HEAD`，会连用户在回合之前没提交的修改一起丢掉），还原前确认，文件在回合之后又被改过时提示冲突，还原写事件。
- diff 由 Host 计算，经 Host API 交给客户端；渲染进程不读文件（计划 §6 T5.1）。
- 验收：同一会话两个回合改了 4 个文件，“改动”标签按回合分组、行数与 `git diff --stat` 一致；还原一个文件后磁盘内容回到改动前；CLI 的 `wevir session diff <id>` 输出相同的统计（如范围包含 CLI）。

**A3 文件预览与成果面板** · 依赖：A1 · 规模 M · 价值 高
- 右栏“文件”标签：工作区文件树（Host 的 `files.list` / `files.read`，realpath 后判断仍在工作区内，移植 OpenWork #22）；预览 Markdown、代码（高亮）、CSV / 表格、图片、PDF、纯文本；超过上限只读开头。
- 成果：写类工具产出的文件与 dsh `present` 工具的文件列表在消息里显示为文件 chip（打开预览、在访达 / 资源管理器中显示、用默认应用打开，后两者经主进程）。
- 验收：§4.2 第 8 条的 `summary.md` 在消息里出现 chip，点开在右栏渲染为表格；工作区里的符号链接指向工作区外时拒绝读取（测试）；50 MB 的文件只读前 1 MB 并提示。

**A4 终端面板** · 依赖：无（打包时依赖 E2）· 规模 M · 价值 中
- 底部坞里用户自己的终端：Host 用 `node-pty` 在工作区目录开 shell，经 WebSocket 推送输出（新方法族 `terminal.*`，按终端 ID 订阅，断线续传用自己的序号或只保留最近 N KB 回放），多个标签，渲染进程用 xterm.js。
- 不是 Agent 的终端：dsh 的 `bash` 每次是一个新的 `bash -c`、没有 PTY，在自己的沙箱里执行，ACP 不给客户端终端能力（ADR-0001 §1）。dsh 进程内有作业事件（`ctx.jobs.events` 的 `output`，按偏移读字节），可以把 Agent 命令的输出实时显示出来，但作业没有对应的工具调用 ID，要自己关联；放不放进来看 B1 的结论。
- 权限：终端等于本机用户的全部权限，只给本机的桌面与 CLI；协议里留权限位，手机端默认没有。
- 验收：开两个终端标签运行 `ls`、`vim`、`top`，窗口缩放后列宽正确；渲染进程刷新后终端还在、最近输出补回；Host 退出时 shell 进程一并结束（进程树检查）；`node-pty` 是 Host 的新原生依赖，`allowBuilds` 登记并写明打包时的 ABI 处理归 E2。

### B 引擎富信息

**B1 Spike：用 stream-tap 补发标题、todo、plan、子 agent 与用量** · 依赖：无 · 规模 S · 价值 中（B2 的前提）
- 已知来源（上游文档，T6.4 核实）：`session/event`（每次会话日志追加后触发，不限定作用域的监听器能看到所有会话，含子 agent 的子会话）里有 `session/title`、`todo/write`、`plan/mode`、带 `usage` 的 `assistant/message`、`tool/result`（含工具私有的 `meta`）、区分人写的提示与注入上下文的 `user/message`；另有 `subagent/start` / `subagent/end`（带 `stopReason` 与子 agent 最后的回复）与 `agent/status`。这些都在 dsh 生成的目录里，算公开接口，但 dsh 声明公开 API 尚未稳定。acp profile 关掉了模型生成标题，只有取首条提示的兜底标题。
- 在 `spikes/` 里扩展 stream-tap 订阅它们，记录 payload、触发时机、与 ACP 更新的先后，子 agent 的事件能否按父会话归属；顺带评估作业输出（A4）与注入上下文（哪些 AGENTS.md、skills 进了请求）能否一并补发。
- 产出：报告 `docs/research/dsh-rich-events.md`，ADR-0001 补记（决策 5 第 10 条“子 agent 推迟到 Phase 1”的结论），以及 B2 的事件设计（对应复盘 §5 第 2 条）。
- 验收：真实 dsh + 脚本化模型跑一个含 `todo_write`、`subagent` 的场景，报告给出每类信息的来源、样本与稳定性评估；不改产品代码。

**B2 富信息事件与界面** · 依赖：B1 · 规模 M · 价值 中
- 协议新增 `plan.updated`、`subagent.started` / `subagent.finished` 与子 agent 活动的归属字段、引擎来源的标题（`session.title_changed.source`）；适配器从旁路产出，旁路失效时退化为现状（只有父会话的 `subagent` 工具卡片）。
- 界面：输入框上方的待办面板（折叠时显示“完成数 / 总数”，参考 OpenWork `TodoPanel`）；子 agent 卡片可展开看它的工具调用与最终回复；CLI 的 attach 显示同样的信息。
- 验收：脚本化场景里 todo 三次更新、两个子 agent 并行，桌面与 CLI 显示一致；去掉旁路后会话照常完成；dsh 升级检查清单（UPSTREAM.md §7）加上富信息旁路的测试。

### C 扩展（Skills / MCP）

**C1 决定是否共享用户的 `~/.agents`**（ADR-0001 未决事项 2）· 依赖：无 · 规模 S · 价值 高（C2 的前提）
- 现状：`DSH_AGENTS_HOME` 指向 Wevir 专属的空目录，用户 `~/.agents` 里的 skills 与 AGENTS.md 不进会话（ADR-0001 §4）。**隔离只覆盖用户级。** dsh 按会话 cwd 找项目根（最近的 `.git`，没有就是 cwd），项目级的 `<项目根>/.dsh/skills`、`<项目根>/.agents/skills` 与从项目根到 cwd 的 `AGENTS.md`、`CLAUDE.md`（及 `.local` 变体，上限 64 KB）现在就会进入 Wevir 的会话（上游 `docs/subsystems/skills.md`、`packages/context/agent-instructions/README.md`，acp 继承 base 的这两个插件）。打开不可信的仓库作为工作区，这些文件就是提示词注入面；`docs/security.md` 目前没写，本任务补上。
- dsh 的 skills 规则：根目录按优先级为项目 `.dsh/skills`、项目 `.agents/skills`、配置 `customSkillDirs`、`$DSH_HOME/skills`、`<agentsHome>/skills`、随附目录；布局 `<name>/SKILL.md` 或 `<name>.md`，不递归；frontmatter 必填 `name`（kebab-case）与 `description`；**不认 `.claude/skills`**。会话开始时只把名称与描述放进请求，模型调 `skill` 工具才加载正文。skills 插件的 `agentsHome` 是插件配置项，AGENTS.md 的用户级目录只认环境变量，两者可以分开。
- **已确认方向：①**（§4 第 3 题）。选项：① 继续隔离，扩展库提供“从 `~/.agents` / `~/.claude/skills` 导入”；② 只共享用户的 skills（经 overlay 设 skills 插件的 `agentsHome` 或 `customSkillDirs`），不共享 AGENTS.md；③ 完全共享；④ 每个工作区自己选（`DSH_AGENTS_HOME` 与 overlay 都是进程级，要靠 Wevir 的插件按会话注册 skills 提供方）。
- 产出：ADR-0005（按方向 ① 写定，含对 C2 的约束：导入只复制进 Wevir 管理的目录，导入后与原目录不再同步）与 `docs/security.md` 的项目级注入说明。
- 验收：ADR Accepted；用真实 dsh 验证选定方案下哪些 skills 进入会话、AGENTS.md 是否注入，记录请求体大小的变化。

**C2 Skills 管理** · 依赖：C1 · 规模 M · 价值 高
- 发现以 dsh 的规则为准（C1），Host 按同样的根目录与优先级列出给用户看，解析与校验 `SKILL.md` frontmatter（改写 OpenWork #26：坏条目带错误列出而不是跳过、同名先到先得并标出被遮蔽的条目）。`.claude/skills` 要支持的话由 Wevir 补：进程级用 `customSkillDirs`，按工作区要用 Wevir 的插件注册 skills 提供方。
- 启用 / 停用：dsh 没有按 skill 停用的开关，Wevir 管理的目录（可以就是 Wevir 自己的 `$DSH_HOME/skills`）里增删即可（dsh 监听目录变化，不用重启）；用户目录与项目目录里的 skill 只显示、不改。新建、从文件夹导入、编辑 `SKILL.md` 只写 Wevir 管理的目录。
- 验收：工作区里放一个 skill、全局放一个、再放一个 frontmatter 坏掉的，列表显示三项、坏的带错误；启用后真实 dsh 的会话里模型能调用它（脚本化模型调用 `skill` 工具，结果里有 skill 正文）；停用后不再进入。

**C3 MCP 管理（本地 stdio 与远程 HTTP，不含 OAuth）** · 依赖：无 · 规模 M · 价值 高
- Host 存 MCP 配置（全局与工作区两级，`local` / `remote` 联合类型，headers 与环境变量里的密钥进 SecretStore），会话创建与恢复时经 ACP `session/new` / `session/resume` 的 `mcpServers` 交给 dsh；接受 Claude Desktop 的 `command + args` 写法导入。dsh 的 ACP 只接受 stdio（`command` 必须是绝对路径）与 Streamable HTTP，拒绝 SSE（上游 `packages/acp/acp/src/mcp.ts`）；不支持 MCP 的 prompts、elicitation 与资源订阅。
- 状态：连接成功、失败（带原因）、需要授权（交给 C4）；工具列表。
- 验收：本地 stdio MCP（仓库里写一个测试用的最小服务）与远程 HTTP MCP 各一个，真实 dsh 的会话里模型调用到它们的工具；工作区级配置只出现在该工作区的会话；Key 不出现在 dsh 的命令行、日志与 `DSH_HOME`。

**C4 远程 MCP 托管 OAuth（加密保险库 + 本地网关）** · 依赖：C3、D2 · 规模 L · 价值 中
- dsh 的 MCP 客户端没有 OAuth，只支持静态 headers，所以这条路只能由 Host 做。做法照 OpenWork 的托管 OAuth（openwork-notes §5.2、候选 #28，只参考）：Host 当 OAuth 客户端（PKCE、动态客户端注册），第三方令牌存加密保险库（主密钥由 D2 定），Host 起本地网关 `http://127.0.0.1:<端口>/mcp/<工作区>/<名称>`，dsh 只看到网关地址与每会话的短期令牌，**第三方令牌永不进引擎**；刷新由 Host 做。
- 验收：本地起一个带 OAuth 的测试 MCP 服务，完成授权后会话能调用它的工具；dsh 的进程环境、命令行、`DSH_HOME` 与 Host 日志里都找不到第三方令牌（全文搜索）；令牌过期后自动刷新；撤销后网关返回 401、界面显示“需要授权”。

**C5 扩展库统一入口** · 依赖：C2、C3 · 规模 S · 价值 中
- 设置里的“扩展”页与右栏入口：Skills、MCP（以后加插件）一个列表，按来源、生效范围、状态筛选，坏条目与连接失败给原因与操作（参考 openwork-notes §5.4 与候选 #29 的清单 schema，只参考）。
- 验收：C2、C3 验收里的条目都出现在同一列表，筛选与开关可用；截图存档。

**C6 按工作区生效的授权目录** · 依赖：D1 · 规模 S · 价值 中
- 用户为一个工作区指定额外的目录（如 `~/Documents/报告`），Agent 在其中的操作不用每次审批。OpenWork 的授权目录对所有工作区同时生效，Wevir 按工作区（openwork-notes §4.5）。
- dsh 不能加可写根：`workspace-write` 的可写根固定为工作区、`/tmp` 与 `os.tmpdir()`（上游 `packages/sandbox/sandbox/src/roots.ts`），ACP 也不接受额外目录；能按会话切的只有整档权限预设（`read-only` / `workspace-write` / `danger-full-access`），太宽。所以只能做成 D1 的一种规则：升级请求的目标在授权目录下就自动允许并留审计。文件工具的目标路径在 `rawInput` 里；`bash` 的升级只有命令文本，判断不了路径，仍要审批。
- 验收：工作区 X 授权目录 D 后，`write` / `edit` 写 D 不出现审批卡片（但有审计记录）；写 D 之外、以及 `bash` 的升级仍要审批；工作区 Y 的会话写 D 仍要审批。

### D 审批与安全

**D1 “总是允许”审批规则** · 依赖：无 · 规模 M · 价值 中
- 前提：dsh 的审批只来自沙箱升级（工作区外、非系统临时目录的操作），选项只有 `allow_once` / `reject_once`（ADR-0001 §6）；dsh 自己没有“总是允许”、没有保存的规则，审批策略只有 `ask` / `never`（上游 `packages/interaction/user-approval/README.md`）。频率比通用 Agent 低，但每次出现都打断。
- Host 在引擎选项之外提供“本会话内允许同类操作”“在此工作区总是允许（按工具 + 路径前缀）”，命中规则时 Host 代为回复 `allow_once`，`approval.resolved` 记 `decidedBy` 为规则与规则 ID（复盘 §5 第 5 条）；设置里列出规则、可撤销；规则只能放宽到用户点过的范围，不提供“全部允许”。
- 一并处理复验看到的问题：审批前那次被沙箱拒绝的工具调用与随后的审批合并展示。
- 验收：同一会话第二次写同一目录不再出现卡片、事件里有规则 ID；撤销规则后恢复审批；Host 重启后规则仍在；规则不会让工作区 Y 的会话放行（测试）。

**D2 密钥迁移系统钥匙串**（ADR-0003 未决事项 2）· 依赖：无（打包相关的部分依赖 E2）· 规模 M · 价值 中（C4 与分发的前提）
- 选项：① Host 用原生钥匙串库（新原生模块，打包时处理 ABI）；② 桌面主进程用 Electron `safeStorage` 保护主密钥，拉起 Host 时经归属管道交给它（CLI 单独启动的 Host 拿不到，要有退路）；③ Host 调系统命令（macOS `security`，Windows DPAPI）不引入原生模块。产出 ADR，实现选定方案并迁移现有 `secrets.json`，`SecretStore` 接口不变。
- 验收：迁移后 `secrets.json` 删除、Key 只在系统钥匙串（或受其保护的密文）里；Provider 照常工作；在 macOS 与 Windows CI 上各跑一遍 SecretStore 测试；钥匙串不可用时的退路有测试。

### E 运行时与分发

**E1 Spike：OAuth 类 Provider**（ADR-0001 未决事项 1）· 依赖：无 · 规模 S · 价值 中
- 问题：订阅账号登录的 grant 会轮换，只能落 dsh 能写的 `DSH_HOME/.credentials.yaml`，与“密钥不落引擎文件”冲突；ACP 没有登录入口。
- 已知（上游，T6.4 核实）：dsh 没有登录命令，登录走 `ctx.authorization` 服务。DeepSeek 账号是浏览器 PKCE 登录，回调要 web profile 的 `/oauth/callback`，acp profile 没有装，令牌不过期、没有刷新；pi-ai 一类（如 Codex）注册了登录流程，但随附的代码里没有调用方，dsh 的用户文档也写着 OAuth 类 Provider 尚不支持。grant 存 `$DSH_HOME/.credentials.yaml` 的 `records`，pi-ai 加锁刷新；`dsh-credentials-local` 的 `path` 可以经 overlay 改位置，启动环境里的变量优先于存的 Key。
- 要回答：哪些国内外服务值得支持、各家条款是否允许第三方客户端；登录由 Wevir 自己驱动还是借 dsh 的流程；凭据改到 Wevir 管理的单独位置后与“密钥不落引擎文件”的关系；刷新能否由 Host 代做。
- 产出：`docs/research/oauth-providers.md` 与 ADR-0001 补记；不写产品代码。
- 验收：至少一个服务在 `spikes/` 里走通登录与一次对话，报告给出推荐方案与条款结论。

**E2 打包运行时与第一个安装包**（ADR-0002 未决事项 1、ADR-0003 未决事项 1、ADR-0001 补记 2 的打包待定项）· 依赖：无 · 规模 L · 价值 高（任何人装上 Wevir 的前提）
- 决定 Host 与 dsh 跑在哪个 Node 上：(a) Electron 自带的 Node（`ELECTRON_RUN_AS_NODE=1`），(b) 随安装包带一个独立 Node，(c) `utilityProcess`。本任务前的预备实测：Electron 44 自带 Node 24.21.0，`ELECTRON_RUN_AS_NODE=1` 下 `node:sqlite` 可以加载并建表（2026-10-14，只测了加载，没跑 storage 测试）。上游先例：dsh 自己的桌面端就用 (a)，以 `ELECTRON_RUN_AS_NODE=1 --expose-internals` 运行 dsh（上游 `apps/desktop/README.md`、`apps/desktop-host/src/cli.ts`；没有 `--expose-internals` 时 dsh 的加载器改用 `node-addon-require-builtin`）。
- 一并解决：dsh 的原生模块（`node-pty`、`koffi`、`@deepseek-ai/node-addon-system`（预编译只有 darwin 与 linux）、`sharp`、`node-addon-require-builtin`、`@vscode/ripgrep`）在选定 Node 上的 ABI 与 Windows 上的可用性；stream-tap 不靠 pnpm 按路径插入；dsh 依赖闭包的体积与 MPL / LGPL 分发义务（`docs/upstream/third-party-notices.md`）；`migrations/` 随包；大陆网络下的安装包下载。
- 产出：ADR-0006；macOS 与 Windows 的未签名安装包能在干净机器上装好并跑通 §4.2 第 1–6 条。签名、公证、自动更新不在本任务。
- 验收：干净的 macOS 与 Windows 虚拟机（没有 Node、没有 pnpm）安装后完成建会话、流式输出、审批、重启恢复；安装包大小与启动时间记录在 ADR。

**E3 Host 常驻 daemon**（ADR-0002 未决事项 2）· 依赖：E2 · 规模 M · 价值 低（手机端之前）/ 高（手机端之后）
- 设置项“关闭窗口后 Host 继续运行”与“登录时启动”（macOS LaunchAgent、Windows 计划任务或 Run 键）、菜单栏 / 托盘入口；桌面端由“拥有 Host”改为“附着常驻 Host”的状态迁移；Paseo D9 的 supervisor / worker 是否需要。
- 验收：开启后关闭桌面端，CLI 仍能 attach 并继续对话；注销重新登录后 Host 自动运行；关闭设置后恢复骨架的行为。

### F 手机端准备

**F1 设备与凭据模型** · 依赖：无 · 规模 M · 价值 中（手机端的前提）
- 实现领域模型里预留的 `Device`：一次性、会过期的配对邀请；按设备凭据（Host 只存哈希）；权限词表（参考 Paseo D3 的 principal / credential / grant 分离）；设备列表与撤销；`host.hello` 出示设备凭据。本机令牌（`host.json`）继续给本机客户端。
- 产出：ADR（Paseo 研读 D2、D3 与 ADR-0002 未决事项 3）；Host、协议、桌面“设备”设置页、CLI `wevir device list|revoke`。
- 验收：用 CLI 模拟第二台设备：凭邀请换得凭据后能 hello，邀请再次使用失败，过期失败；撤销后该设备的连接立即断开、再连被拒；权限不含 `terminal` 的设备调用终端方法被拒。

**F2 Spike：中继选型** · 依赖：F1 · 规模 M · 价值 中
- 要求：能在大陆自托管（计划 §2.7）；端到端加密，按 Paseo 研读 D1 补上会话内防重放、两个方向分开的密钥或 nonce 前缀、客户端认证（加密通道内出示 F1 的设备凭据）、Host 密钥轮换。
- 比较：自写最小中继（Node 或 Go）、沿用 Paseo 中继协议的做法（Apache-2.0，只参考或按规则移植）、现成隧道（frp 等）。
- 产出：报告与 ADR，`spikes/` 里的原型：一个 CLI 客户端经自托管中继 attach 到本机 Host。
- 验收：原型在两台不同网络的机器之间跑通 attach 与审批；抓包确认中继只见密文；重放一帧被拒绝。

**F3 会话列表变更推送** · 依赖：无 · 规模 S · 价值 中
- Host 级的订阅（如 `sessions.subscribe`，带游标、增量与墓碑，参考 Paseo D6），替掉桌面左栏“每会话一条订阅 + 每 10 s 重读列表”（复盘 §5 第 1 条）；CLI 的 `session list --watch`。
- 验收：另一个客户端新建、关闭会话、触发审批，左栏 1 s 内更新，不再有定时重读；100 个会话时桌面端的 WebSocket 订阅数为 1 而不是 100；断线重连按游标补齐。

### G 骨架遗留与工具

**G1 “基于历史新建会话”的 Host API** · 依赖：无 · 规模 S · 价值 低
- 落地 T3.5 定的 `SessionFromHistory`：Host 把只读会话的历史整理后交给新引擎会话（作为首条上下文），新会话记录来源；桌面端的“基于历史新建”从客户端做法改为调用它（domain-model §4.4、§10）。
- 验收：只读会话 → 基于历史新建 → 新会话第一轮回答能引用旧会话里的内容（脚本化模型检查首个请求里有旧历史）；新会话事件里有来源会话 ID。

**G2 验收工具化** · 依赖：无 · 规模 S · 价值 高（之后每个界面任务的验收都用它）
- 把骨架验收里每次重写的东西放进仓库：CDP 驱动（点击、按标签填表、等待、截图，处理窗口被遮挡时不出帧）、主进程 inspector 替换文件夹对话框、脚本化模型的场景库（读写、审批、长回答、多步骤 CSV）、`expect` 驱动的 CLI；`pnpm accept` 在全新数据目录里跑 §4.2 第 1–8 条（模型用脚本），产出截图与报告。
- 验收：`pnpm accept` 在本机从零跑完、全部通过、留下截图；运行结束没有残留进程与临时目录；文档写进 `docs/development.md`。

### 依赖一览

```text
A1 ──┬─> A2
     └─> A3
B1 ───> B2
C1 ───> C2 ──┐
C3 ──┬───────┴─> C5
     └─> C4 <── D2
D1 ───> C6
E2 ───> E3
F1 ───> F2
A4、E1、F3、G1、G2 无前置
```

---

## 4. 范围与顺序：选项与确认结果

**确认结果（2026-10-14）：**

| 题 | 选择 |
|---|---|
| 第 1 题 主线 | 一、先把工作台做顺手 |
| 第 2 题 附加项 | E1 OAuth 类 Provider 的 Spike、F3 会话列表变更推送、G1 “基于历史新建会话”的 Host API |
| 第 3 题 `~/.agents` | ① 继续隔离，提供导入 |
| 第 4 题 骨架状态 | A. 标为“已完成”，遗留项单列（§1） |

没有选入 Phase 1 的候选：C4、C6、D2、E2、E3、F1、F2，留给 Phase 2，prompt 保留在 PHASE1_PROMPTS.md。以下是当时给出的选项，保留作记录。

### 第 1 题：Phase 1 的主线

| 选项 | 内容（按顺序） | 推迟到 Phase 2 | Phase 1 的完成标准 |
|---|---|---|---|
| **一、先把工作台做顺手**（推荐） | G2 → A1 → A2、A3 并行 → D1 → B1 → B2 → A4；后半段 C1 → C3 → C2 → C5 | C4、C6、D2、E1、E2、E3、F1–F3（F3 可顺带做） | 用户在一个会话里能看到计划、审阅改动并还原、预览成果、少被重复审批，Skills / MCP 能用上 |
| 二、先能装到别人电脑上 | G2 → E2 → D2 → A1 → A2、A3 → D1 → E3 | B、C、F | macOS / Windows 未签名安装包在干净机器上跑通 §4.2 第 1–6 条，密钥在系统钥匙串 |
| 三、先接上用户的 Skills / MCP | C1 → C3 → C2 → C5 → D2 → C4 → C6 → A1 → A2 | B、E、F、A4 | 用户已有的 skills 与 MCP（含 OAuth 类远程 MCP）在 Wevir 里可用、可按工作区管理 |
| 四、先为手机端铺路 | F3 → E2 → E3 → F1 → F2 → A1 | A2–A4、B、C、D1 | 一台模拟的第二设备经自托管中继配对、attach、审批 |

推荐理由：骨架的短板在“看不清 Agent 做了什么”（工具卡片显示原始包装、没有 diff、没有成果预览、看不到计划），这些每天都用到；打包与手机端都依赖还没做的决策，且需要外部条件（签名、虚拟机、中继服务器），适合在工作台稳定后集中做。

### 第 2 题：主线之外还要纳入哪些（可多选）

- E1 OAuth 类 Provider 的 Spike（只出报告与 ADR，规模 S）
- F3 会话列表变更推送（规模 S，桌面立即受益，手机端的前提）
- G1 “基于历史新建会话”的 Host API（规模 S）
- E2 的预备 Spike（只定运行时方案与 ADR，不出安装包）

### 第 3 题：`~/.agents` 是否共享（C1 的方向，ADR-0001 未决事项 2）

| 选项 | 做法 | 好处 | 代价 |
|---|---|---|---|
| **① 继续隔离，提供导入**（推荐） | `DSH_AGENTS_HOME` 仍是 Wevir 专属目录；扩展库提供“从 `~/.agents/skills`、`~/.claude/skills` 导入” | 会话内容可预期、可审计；用户别的工具的 AGENTS.md 不会悄悄进每个请求（本机约 15 KB） | 用户改了原目录要重新导入 |
| ② 只共享 skills | 经 overlay 把 skills 插件的 `agentsHome` 指向 `~/.agents`，`DSH_AGENTS_HOME`（AGENTS.md）仍隔离 | 与其他 Agent 工具同步；进请求的只有名称与描述，正文按需加载 | 用户目录里的 skill 对所有工作区生效；`~/.claude/skills` 仍要另配 `customSkillDirs` |
| ③ 完全共享 | 指回 `~/.agents` | 最省事 | 与 ADR-0001 §4 的隔离理由冲突，用户级 AGENTS.md 进每个请求、内容不可控 |
| ④ 每个工作区自己选 | 工作区设置里开关 | 最灵活 | `DSH_AGENTS_HOME` 与 overlay 都是进程级，要写 Wevir 自己的插件按会话注册 skills，规模最大 |

无论选哪项，项目级的 `.agents/skills`、`.dsh/skills` 与 `AGENTS.md` / `CLAUDE.md` 现在就随工作区生效（C1 条目），这一题只管用户级。

### 第 4 题：骨架的收尾状态

| 选项 | 做法 |
|---|---|
| **A. 标为“已完成”，遗留项单列**（推荐，本草案按此改了 SKELETON_PLAN） | SKELETON_PLAN 状态为已完成，T6.4 勾选；T4.2、Gate M4、真实模型补跑作为 §1 的前置条件跟踪 |
| B. 等 Gate M4 通过再标“已完成” | SKELETON_PLAN 保持“收尾中”，拿到 Key 跑完 Gate M4、§4.2 第 8 条真实模型部分之后再改 |

---

## 5. 任务表、里程碑与 Gate

编号接着骨架的 M6。并行条件见各任务的 prompt；同一里程碑内不依赖彼此的任务可以并行（各用一个 worktree）。

| ID | 任务 | 依赖 | 状态 | 备注 |
|---|---|---|---|---|
| **前置** | **骨架遗留（§1）** | | | |
| P0.1 | T4.2 提交、Gate M4 | Key | [ ] | |
| P0.2 | 真实模型补跑 | Key | [ ] | |
| P0.3 | 推送与 CI | — | [ ] | |
| **M7** | **看得清：Agent 改了什么、交付了什么** | | | |
| G2 | 验收工具化（`pnpm accept`） | — | [ ] | 建议第一个做 |
| A1 | 工具结果结构化与回合改动记录 | — | [ ] | |
| A2 | Git Diff 审阅 | A1 | [ ] | |
| A3 | 文件预览与成果面板 | A1 | [ ] | 可与 A2 并行 |
| **M8** | **少打断、看得到进度** | | | |
| D1 | “总是允许”审批规则 | — | [ ] | 真实模型下的审批行为看 P0.2 |
| B1 | Spike：stream-tap 补发富信息 | — | [ ] | 可在 M7 期间开始 |
| B2 | 富信息事件与界面 | B1 | [ ] | |
| A4 | 终端面板 | — | [ ] | `node-pty` 的打包处理留给 Phase 2 的 E2 |
| **M9** | **用上自己的 Skills 与 MCP** | | | |
| C1 | `~/.agents` 继续隔离并提供导入（ADR-0005） | — | [ ] | 可在 M7 期间开始 |
| C3 | MCP 管理（本地 stdio 与远程 HTTP） | — | [ ] | |
| C2 | Skills 管理 | C1 | [ ] | 可与 C3 并行 |
| C5 | 扩展库统一入口 | C2、C3 | [ ] | |
| **附加** | **不占主线，有空档就做** | | | |
| F3 | 会话列表变更推送 | — | [ ] | 建议放在 M8 之前：B2 让每会话的事件变多 |
| G1 | “基于历史新建会话”的 Host API | — | [ ] | |
| E1 | Spike：OAuth 类 Provider | — | [ ] | 需要维护者自己的账号 |

- **Gate M7**：`pnpm accept` 在全新数据目录里跑通 SKELETON_PLAN §4.2 第 1–8 条（脚本化模型），并新增两个场景：回合改动在“改动”标签里按回合列出、还原一个文件；§4.2 第 8 条的 `summary.md` 在右栏预览为表格。
- **Gate M8**：`pnpm accept` 新增：同类审批第二次不再打断、撤销规则后恢复；todo 与两个子 agent 在桌面和 CLI 上一致；终端标签运行交互程序、刷新后仍在。
- **Gate M9**：从 `~/.claude/skills` 导入一个 skill 并在会话里被调用；stdio 与 HTTP MCP 各一个被调用；扩展库列出全部条目与坏条目的原因；`docs/security.md` 已写项目级注入。
- **Phase 1 完成**：M7–M9 的 Gate 通过；附加项完成或明确推迟；需要外部条件的检查（§0 第 1 条）全部补齐，其中 P0.2 的真实模型结论已经反映到 D1。

---

## 6. 风险

| 风险 | 对策 |
|---|---|
| B、A1 依赖更多 dsh 进程内事件与结果格式，私有接口面变大 | 旁路与解析都“失败即降级为现状”；升级检查清单逐项加测试；B1 先评估稳定性再做 B2 |
| 真实模型的行为一直没验证（审批依赖模型按提示升级） | P0.2 先做；不成立时 D1、C6 的设计要改 |
| 原生模块增多（`node-pty`、钥匙串库），打包 ABI 问题集中到 E2 | 新增原生依赖都在 ADR 里登记打包时的处理；能不用原生模块的方案优先（D2 选项 ③） |
| 托管 OAuth 与中继都是安全敏感面 | 各自先写 ADR 与威胁模型；验收里包含“令牌不进引擎”“中继只见密文”的反向检查 |
| 各家 OAuth 条款不允许第三方客户端 | E1 只出结论，不做产品化；不允许的服务不支持 |
| 大陆网络（中继、安装包下载、MCP 远程服务） | 中继必须可自托管；安装包下载走可配置的镜像；MCP 远程地址不预置海外服务 |

---

## 7. Phase 1 明确不做

- 多 Agent 并行、Git worktree 管理、长期记忆、插件 SDK、模型故障转移路由（SKELETON_PLAN §7，不变）。
- 手机 App 本体；F1、F2（Phase 1 只做 F3）。
- C4 托管 OAuth、C6 授权目录、D2 钥匙串、E2 打包与安装包、E3 常驻 daemon（留给 Phase 2，§4）。
- 签名、公证、自动更新、Linux 安装包。
- 修改 dsh 源码；需要时用补丁文件并登记（不变）。

---

## 8. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-14 | v0.1 草案（T6.4）：候选任务 A1–G2 与验收标准、依赖、四题待确认的选项 |
| 2026-10-14 | v1.0（T6.4）：维护者确认范围与顺序——主线“先把工作台做顺手”，附加 E1、F3、G1，`~/.agents` 继续隔离并提供导入，骨架标为已完成；新增 §5 任务表与 M7–M9 的 Gate；C4、C6、D2、E2、E3、F1、F2 留给 Phase 2 |
