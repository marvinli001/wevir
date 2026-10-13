# 骨架阶段复盘

> 2026-10-14 · T6.4 · 覆盖 T0.1–T6.3 · 维护者：marvinli001
> 依据：`git log`、[SKELETON_PLAN.md](../archive/skeleton/SKELETON_PLAN.md) 的任务备注与变更记录、ADR-0001–0004 的补记、[验收存档](../research/skeleton-acceptance/README.md)（含本任务的 §4.2 九条复验）。

## 1. 结果

| 项 | 数据 |
|---|---|
| 时间 | 第一个提交 2026-10-12 14:26，最后一个（T6.1）2026-10-14 11:06，日历时间约 45 小时；多个会话在同一 checkout 里并行 |
| 提交 | 31 个任务提交 + 5 个 chore；T4.2 未提交 |
| 代码 | 约 4.65 万行（`.ts` / `.tsx` / `.mjs` / `.js` / `.sql`，不含录制样本与 lockfile），其中测试约 1.92 万行；文档约 6250 行 |
| 测试 | 1038 通过、9 跳过（真实模型层，没有 Key）；CI 在 macOS、Windows × Node 24 / 22.19 四个 job 通过 |
| §4.2 九条 | 第 1–7、9 条通过，第 7 条用的是未提交的 T4.2 CLI；第 8 条真实 dsh 通过、真实模型未跑 |
| Gate | M1、M2、M5 通过；M3 缺第 3 层（真实模型）；**M4 没有通过**（T4.2 卡在要真实模型的 Gate）；M6（§4.2 九条全过）差第 8 条的真实模型部分 |

按里程碑看提交时间（并行会话互相重叠，只能粗看）：M0 约 7 h（含 T0.3 的 Spike 约 2 h），M1 约 2.5 h，M2 约 12.5 h（含一夜），M3 约 5 h，M5 约 3.5 h，M6 的三个任务半小时内先后提交。

## 2. 估计偏差

计划没有写工时，偏差体现在任务边界、依赖顺序和验收前提上。

1. **“先 CLI 后 GUI”（计划 §2.5）没有守住。** T4.2 的代码 10-13 19:24 就写完了，卡在 Gate M4 要真实模型、本机没有 Key，一直没提交；T5.1–T5.5 在这期间照常推进。T5.1 依赖 T4.2 新增的 `@wevir/host/runtime`，经确认随 T5.1 一并提交；Gate M5 第 7 条与本任务的复验都用未提交的 CLI。根因是 Gate 把“需要外部条件（Key）的检查”和“代码完成”绑在一起：Key 不到，下游任务只能绕开依赖。
2. **“需要 Key 的检查”一路推迟，没有任务对它负责。** T3.3、T3.4、T3.5、T3.6、Gate M3 第 3 层、Gate M4、本任务第 8 条，以及 ADR-0001 未决事项 3（模型是否按沙箱提示升级、首字时间差、`usage_update`），每一处都写着“本机没有 Key，未运行”。审批的整条路径都建立在“模型被沙箱拒绝后会带 `sandbox_permissions` 重试”上，这一点至今只在脚本化模型上成立。
3. **有接口、没认领的工作。** 中途补认领的有：工作区与 Provider 方法的 Host 侧执行（T2.4 认领）、`DshAdapter` 本身（T3.2 认领，T3.1 只有进程管理）、客户端消息投影（原定 T4.1，T5.3 落地）。至今没认领的：“基于历史新建会话”的 Host API（T3.5 只定了接口，T5.5 先用客户端做法）。
4. **M6 比计划重。** 计划把 M6 当作收尾，实际 T6.1 在全新克隆上发现 `pnpm dev` 坏了两处（主进程的 `@wevir/source` 条件写错位置、Electron 44 不会懒下载），都被开发机上已有的构建产物与缓存掩盖，Gate M5 第 1 条当时是在这样的 checkout 上通过的；T6.2 首跑 Windows 有 10 个失败、另有 2 个与平台无关的竞态。计划写了 CI “可提前到 M1 做”，没有提前。
5. **协议比预想动得多。** v0 定稿后 M3 内升到 0.2.0（T3.4）、0.3.0（T3.5），都只加 optional 字段与新事件类型，冻结样本保证旧消息仍能解析，兼容纪律守住了；但“v0 就是 Phase 1 的协议”这个隐含预期不成立。
6. **规模集中在两处。** T0.3（+1.7 万行，绝大部分是 ACP 录制样本）和 T3.1（+1.1 万行，主要是 dsh 依赖闭包进 lockfile）。样本的投入回报很高：回放层契约测试、映射快照测试、错误归类都以它为输入。
7. **低估了“发现一个坑要补两次”的成本。** pnpm 命令 shim 导出 `NODE_PATH`，让没声明的 `@deepseek-ai/*` 在测试里能解析、生产里解析不到，T3.1 期间两个 chore 提交才堵住（ADR-0004 补记 3）。

## 3. 被推翻或修正的假设

| 原假设 | 实际 | 记录在 |
|---|---|---|
| Provider 与模型由 overlay 的 `acp` 默认路由决定 | 一个 dsh 进程承载多个 Provider，每个会话在 `session/new` 之后用 `set_config_option` 选 | ADR-0001 补记 5 |
| 改 overlay 能热加载 | dsh 不热加载，Provider 变更必须重启 dsh，挂着的会话以 `engine.exited (config_changed)` 脱开、resume 后继续 | ADR-0001 补记 5 |
| ACP SDK 会原样交出不认识的更新 | SDK 1.4.0 的 zod 校验丢掉不认识的类型、删掉不认识的字段；改为在 SDK 之前截下 `session/update` | ADR-0001 补记 3 |
| 一个 attempt 一条已提交消息 | 按内容块各发一条；增量与已提交消息要按会话内顺序 + 前缀对齐 | ADR-0001 补记 3、acp-event-mapping §4 |
| 审批请求会超时或被撤回 | dsh 不设时限、不撤回，不回复就一直等；由适配器在取消、关闭、回合结束、退出时结掉 | ADR-0001 补记 4 |
| 引擎会话丢失只有“找不到”一种 | 三种（日志删除、格式 v5 不兼容、日志损坏），统一为 `session_lost`、会话只读 | ADR-0001 补记 6 |
| 回合结束时丢掉没被替换的增量 | Host 崩溃（`interrupted`）时已提交消息不会再来，这条规则会删掉已显示的文字；改为 `interrupted` 保留增量 | domain-model §6.3 规则 4（T5.5） |
| 拉起方被强杀时 Host 读到 stdin EOF 优雅退出 | 只在 POSIX 上成立；Windows 的 job object 直接结束 Host 与 dsh | ADR-0002 补记 7 |
| pnpm 的依赖隔离让违规 `require()` 在运行时失败 | 命令 shim 的 `NODE_PATH` 让它在测试里通过；设 `extendNodePath: false` 并由 lint 检查 shim | ADR-0004 补记 3 |
| shadcn / Base UI、Shiki 能在严格 CSP 下用 | Base UI 的内联 `<style>` 被拦，改 `disableStyleElements`；Shiki 的内联样式与 WASM 不放行，改 highlight.js | ADR-0004 补记 5、6 |
| 全新克隆上 `pnpm dev` 与开发机一样 | 主进程打包的一直是 `dist/`；Electron 二进制不会自动下载 | 验收存档 T6.1 |
| `DSH_AGENTS_HOME` 指向空目录，会话就不带外部的 skills 与 AGENTS.md | 只隔离了用户级。dsh 按会话 cwd 找项目根，工作区里的 `.agents/skills`、`.dsh/skills` 与从项目根到 cwd 的 `AGENTS.md`、`CLAUDE.md` 都会进会话（T6.4 读上游源码确认，`docs/security.md` 还没写） | PHASE1_PLAN C1 |
| Host 不推送会话列表也够用 | 桌面端给每个会话开一条订阅跟状态与标题，另每 10 s 与获得焦点时重读列表；会话多了、或到了手机网络上就不够 | SKELETON_PLAN 变更记录 T5.3 |

被证实的关键假设：ACP + stream-tap 旁路能撑起骨架（契约 18 条在真实 dsh 上全部通过，首个增量 82 ms 对整条消息约 2.4 s）；单进程多会话可行（冷启动约 0.5 s）；stdin EOF 回收可靠（Host 被强杀后 dsh 51 ms 内退出、工具子进程一并结束）；Wevir 事件库作为唯一事实来源，让重启恢复、断线补齐、多端同步都只靠 `seq`。

## 4. dsh 接入的实际痛点

按影响排序：

1. **没有 Key 就验证不了模型行为。** 审批完全依赖模型按沙箱提示升级重试，这一点、真实流式节奏、`usage_update` 数值、DeepSeek 官方路由都没在真实模型上跑过。脚本化 mock 让绝大多数路径可测，但它“总会按提示重试”。
2. **ACP 给的信息少。** 没有增量（旁路补齐）、没有标题 / plan / todo 事件、看不到子 agent 会话、工具 `kind` 恒为 `other` 且没有 `locations` / diff、回合失败是 `-32603` 自由文本、审批只来自沙箱升级且只有 `allow_once` / `reject_once`。Wevir 为此写了工具名映射、`rawInput` 解析、错误文本归类，dsh 一改措辞就会落到“未知”。
3. **依赖私有接口。** 增量来自进程内事件 `agent/assistant-stream`，不是公开契约；`dsh plugin add` 要 PATH 上有 pnpm（打包后不一定有，按路径插入插件已实测可行，待打包时定）。升级检查清单（UPSTREAM.md §7）是唯一防线。
4. **进程级的副作用。** 配置变更、取消得不到确认都要重启整个 dsh 进程，同一进程上其他会话的回合被打断、要 resume。单进程多会话省了冷启动，代价在这里。
5. **工具结果的包装漏到界面。** 读写工具的结果是 `<path>…</path><type>…</type><content>…</content>` 的文本，工具卡片直接显示了第一行；审批前那次被沙箱拒绝的写入显示为红色“失败”与英文原文（本任务复验时看到，截图在验收存档）。
6. **依赖重。** dsh 闭包 622 个包，含原生模块（`node-pty`、`koffi`）、5 个构建脚本（`allowBuilds` 按版本逐个放行）、MPL-2.0 与 LGPL-3.0 组件的分发义务；npm 的 `latest` 标签落后于实际版本，ACP 的 `agentInfo.version` 恒为 0.0.1，版本只能读包。
7. **隔离要自己做全。** 凭据解析会读继承的环境变量、`<进程 cwd>/.env`；`~/.agents` 的 skills 与 AGENTS.md 会注入每个会话（本机约 15 KB）。白名单环境、独立 `DSH_HOME` / `DSH_AGENTS_HOME`、cwd 用 `DSH_HOME`，缺一项就会泄漏或串配置。工作区自己的 `AGENTS.md`、`CLAUDE.md` 与项目级 skills 不在隔离范围内，打开不可信的仓库时是提示词注入面。
8. **ACP 丢掉了现成的富数据。** `write` / `edit` 的结果带逐块 diff（`meta.diffs`），dsh 还有按回合记录工作区改动的插件（只在 web bundle 里）、标题 / todo / plan / 子 agent 的进程内事件，ACP 一概不转发；Phase 1 的 diff、富信息都要经 stream-tap 一类的旁路取，私有接口面会变大。

## 5. 事件模型要不要调整

**核心不用改。** 会话内 `seq`、显式订阅与回放结束标记、增量被已提交消息替换、回合边界事件、审批“首个决定生效 + `decidedBy`”在骨架全程没有出现需要破坏性修改的情况；三次调整（`session.resumed` / `session.read_only`、`engine.exited.reason`、`interrupted` 保留增量）都是新增或投影规则的修正。

Phase 1 需要的增量（都按 host-api §10 只加不减，新事件类型直接发、客户端忽略不认识的 `type`）：

| # | 调整 | 为什么 | 对应的 Phase 1 候选 |
|---|---|---|---|
| 1 | Host 级的会话列表变更推送（如 `sessions.subscribe`，带游标） | 替掉“每会话一条订阅 + 10 s 轮询”；手机经中继时必需（Paseo D6） | F3 |
| 2 | 富信息事件：`plan.updated`、`subagent.started` / `subagent.finished`、子 agent 事件归属（父会话事件带 `subagentId`，或子会话作为独立会话并带 `parentSessionId`）、引擎来源的标题 | ACP 拿不到，由 stream-tap 补发 | B1、B2 |
| 3 | `tool.finished` 加可选的结构化结果（路径、行数、退出码、diff 摘要），由适配器按 dsh 的结果格式解析 | 文件预览、Diff 审阅、卡片不再显示原始包装 | A1 |
| 4 | 回合级的文件改动事件（如 `files.changed`：路径、增删行数、改动前后的快照引用） | Diff 审阅以回合为单位 | A1、A2 |
| 5 | 审批按规则自动应答：`approval.resolved.decidedBy` 增加“规则”来源与规则 ID | “总是允许”要能审计、能撤销 | D1 |
| 6 | 已被替换的增量是否在库里压缩 | 1205 条事件的会话打开 354 ms、滚动 p95 8.3 ms，暂时不需要；长会话变多时再评估 | 暂不 |

## 6. 流程

做得对的：一个任务一个会话一次提交；每个任务先改计划与 ADR 再改代码（4 份 ADR 共 22 条补记，计划变更记录 15 行，事后都能查到为什么）；契约先行让 EchoAdapter 撑起 M2 与桌面端开发；真实 dsh + 脚本化 mock 让不需要 Key 的端到端测试进了 CI。

要改的：

1. **把“需要外部条件的检查”单列。** Gate 分成“代码 Gate”（mock 模型，阻塞下游）与“真实环境检查”（Key、签名证书、真机，单独跟踪、有负责人和期限），不让下游任务绕开依赖。
2. **尽早拿到一个测试用的模型 Key。** Phase 1 第一件事。
3. **并行会话用 worktree。** 同一 checkout 里并行，`pnpm install` 会把别人的 importer 写进 lockfile、`pnpm lint` 被别人的半成品挡住；骨架靠“只暂存自己的文件”绕过去。
4. **验收脚本进仓库。** §4.2 的复验靠每个会话在临时目录里重写 CDP 驱动与 mock 脚本，用完删掉，下一次又写一遍。Phase 1 把驱动、脚本化模型的场景与步骤放进 `scripts/`，Gate 能一条命令重跑。
5. **全新环境验证提前。** 第 1 条验收以后在干净 HOME + 全新克隆上跑（T6.1 的做法），不在开发机上判定。
6. **会话结束前清理后台进程。** 复验时本机还有其他会话留下的 mock 模型（运行约 10 h）和 Gate M4 的 Host。

## 7. 进入 Phase 1 之前的遗留

| 项 | 状态 | 需要 |
|---|---|---|
| T4.2 提交、Gate M4 | 代码与测试完成，Gate 在等 Key | 维护者提供 Key 或决定 Gate M4 的处理方式 |
| Gate M3 第 3 层、ADR-0001 未决事项 3、`provider.test` 真实端点、§4.2 第 8 条真实模型 | 未运行 | 同一个 Key，一次补跑 |
| `31a91ea`（T6.1）及之后的提交推送、CI | 未推送 | 推送后看 CI |
| “基于历史新建会话”的 Host API | 未排期，桌面端用客户端做法 | 列入 Phase 1 候选（G1） |
| 复验时看到的两处界面问题（工具结果包装、审批前的“失败”卡片） | 未改 | 列入 Phase 1 候选（A1、D1） |
