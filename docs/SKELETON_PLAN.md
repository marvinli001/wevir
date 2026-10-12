# Wevir 初步骨架规划

> 状态：v0.2（M0 的 ADR 已定稿）· 建立日期：2026-10-12 · 维护者：marvinli001
> 配套文档：[TASK_PROMPTS.md](./TASK_PROMPTS.md)（每个任务可直接粘贴执行的 prompt）· [adr/](./adr/README.md)（架构决策记录）

本文件回答三件事：**骨架阶段要做到什么程度、按什么顺序做、每一步怎么算完成。**
具体执行时，一个任务开一个新会话，从 `TASK_PROMPTS.md` 复制对应 prompt。

---

## 0. 使用与维护规则

1. **一个任务 = 一个会话 = 一次提交（或一个小 PR）。** 不在同一会话里连做多个任务，避免上下文爆掉。
2. 任务完成后，在 [§5 任务总览](#5-任务总览进度看板) 勾选，并在「备注」列写提交号或产出文件。
3. 每个里程碑（M0–M6）末尾有一个 **Gate**。Gate 没过，不进入下一个里程碑。
4. 发现计划与现实不符（上游接口变了、Spike 推翻了假设），先改本文件和对应 ADR，再改代码。
5. 原始调研聊天记录（`~/Downloads/Wevir_%E5%A4%8D%E5%88%B6%E5%86%85%E5%AE%B9.txt`，即“Wevir_复制内容.txt”，约 7MB）**不要再整篇喂给模型**。其中有效结论已经提炼进 §1–§3；确需回查时，只读第 6291–6528 行（最终技术路线）或第 6182–6290 行（候选项目对比）。

---

## 1. 决策基线（已冻结）

### 1.1 产品定位

- **Wevir**：面向中国大陆用户的 **本地优先、开源、多模型、可跨设备接续的 Agent 工作台**。
- 覆盖范围：通用工作助手 = 代码开发 + 文件 + 资料 + 办公任务。
- 不是另一个 OpenCode GUI，也不是 Claude Code 套壳；拥有自己的 Host、会话协议和多端客户端。

### 1.2 三个上游“轮子”的分工

数据于 2026-10-12 通过 GitHub API 复核。

| 上游 | Stars | 许可证 | 默认分支 | 在 Wevir 中的角色 | 使用方式 |
|---|---:|---|---|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh） | 247,521 | MIT | `master` | **Agent 执行内核**：Agent Loop、工具、模型适配、会话日志、审批、沙箱、Cordis 插件 | **作为依赖运行**（锁定版本，子进程），不 fork |
| [OpenWork](https://github.com/different-ai/openwork) | 24,004 | 核心 MIT，`ee/` 另行许可 | `dev` | **桌面产品与交互参考**：工作区、文件交付、Skills/MCP 管理、任务展示 | **只读参考**，必要时按文件选择性移植（仅 MIT 部分） |
| [Paseo](https://github.com/getpaseo/paseo) | 20,517 | Apache-2.0（T0.2 核实；API 显示 NOASSERTION 是因为根 LICENSE 前加了适用范围说明） | `main` | **多端与远程架构参考**：daemon、WebSocket 协议、设备配对、加密中继、Expo 手机端 | **只读参考**，骨架阶段不移植代码 |

> dsh 仍是 developer preview，官方明确会有不兼容变更。所以：**Wevir 的 UI 和 Host 业务代码不得直接依赖 dsh 内部类型**，只有 `adapter-dsh` 一个包可以碰它。

### 1.3 冻结的技术决策

| 决策项 | 方案 |
|---|---|
| 主 Agent Runtime | DeepSeek Harness，经 `AgentRuntimeAdapter` 隔离 |
| 桌面端 | Electron + React + TypeScript |
| 移动端（骨架阶段不做） | Expo / React Native |
| Host ↔ 客户端通信 | 独立版本化的 JSON-RPC 2.0 over WebSocket |
| 本地持久化 | SQLite（Node 内置 `node:sqlite`，ADR-0003）+ 文件系统 |
| Agent 扩展机制 | Cordis Plugin（dsh 侧） |
| LLM 集成 | Provider Adapter + 模型能力注册 |
| 首版平台 | macOS、Windows；Linux 后续 |
| 许可证 | MIT；移植代码各自遵循原条款并保留来源 |

### 1.4 骨架阶段的工具链（[ADR-0004](./adr/0004-repo-tooling.md) 已确认）

| 项 | 决定 | 理由 / 出处 |
|---|---|---|
| 包管理 | pnpm workspace（pnpm 12）；依赖的构建脚本在 `pnpm-workspace.yaml` 的 `allowBuilds` 中逐个登记，保持 `strictDepBuilds` 默认开启 | 与 dsh、OpenWork 一致；pnpm v11 起 `allowBuilds` 取代 `onlyBuiltDependencies` |
| Node | `>=22.19`；开发与 CI 基线为 `.node-version` 的 24 LTS；`@types/node` 跟下限用 22.x | dsh 要求 `^22.19.0 \|\| >=24.0.0` |
| 语言 | TypeScript 7 strict，ESM，`nodenext` 解析 | — |
| 库构建 | tsdown | 与 dsh 一致 |
| 桌面构建 | electron-vite 最新正式版（2026-10 为 5.x，配 Vite 7）；preload 打成单个 CJS 文件以满足 `sandbox: true`；打包工具不在骨架范围 | main/preload/renderer 一套配置 |
| UI | React + Tailwind v4；原语用 shadcn CLI 生成的 Base UI 版本，图标 lucide，色阶取自 `@radix-ui/colors` | 与 OpenWork `apps/app` 同栈，便于参考；视觉不复制 |
| 校验/Schema | zod 4，schema 只做结构声明 | 协议类型与运行时校验共用（ADR-0002） |
| 测试 | Vitest（按包划分 projects） | — |
| Lint/Format | Biome（含引擎边界规则）+ `scripts/check-engine-boundary.mjs` | 单工具，速度快 |
| 引擎依赖 | `@deepseek-ai/dsh@0.2.1-alpha.2`、`@agentclientprotocol/sdk@1.4.0`，精确锁定，只在 `packages/adapter-dsh` 声明 | ADR-0001 |
| Host 服务端 | `ws` | ADR-0002 |
| SQLite | Node 内置 `node:sqlite` | ADR-0003 |

---

## 2. 地基原则

1. **一个事实来源。** 会话、任务、审批的状态以 Wevir Host 的事件库为准。dsh 的会话日志是引擎层事实，Host 负责把它翻译成产品层事实。
2. **引擎在适配器后面。** `packages/adapter-dsh` 之外的任何包不得 `import '@deepseek-ai/*'`，也不得声明这类依赖（T0.1 用 Biome 规则 + `scripts/check-engine-boundary.mjs` 强制）。`spikes/` 不属于产品代码，豁免；但产品代码不得反向引用 `spikes/`。
3. **契约先行。** 先有 `packages/protocol` 的类型与 schema，再写 Host 和客户端；协议带版本号，握手时校验。
4. **先竖切，再铺开。** 先打通“建会话 → 发提示 → 看流式输出 → 审批 → 取消 → 重启恢复”这一条线，再加功能。
5. **先 CLI 后 GUI。** CLI 客户端能完整走通，才开始做桌面 UI。CLI 同时证明“多客户端共享同一事件流”，这是将来手机端的地基。
6. **上游代码：参考优先，移植从严。** 移植的文件头部必须写明来源仓库、路径、提交号和许可证，并登记到 `docs/upstream/UPSTREAM.md`。
7. **大陆网络可替换。** npm registry、Electron 二进制、模型 API 地址都必须可配置；不把海外服务设为强制依赖。
8. **密钥不落引擎文件。** 模型 API Key 由 Host 管理，通过子进程环境变量传给 dsh（dsh 支持 `apiKeyEnv`），不写进 `$DSH_HOME`。（OAuth 类 Provider 的 grant 与这一条冲突，见 ADR-0001 未决事项 1；骨架只支持 API Key 类 Provider。）

---

## 3. 已核实的上游接入点（2026-10-12）

### 3.1 DeepSeek Harness

- 运行入口统一是 `dsh --profile <name>`，随附 profile：`web`、`headless`、`sdk`、`sdk-minimal`、`acp`。
- 仓库版本 `0.2.1-alpha.2`；npm `@deepseek-ai/dsh` 的 `latest` 标签仍是 `0.2.0-rc.2`，必须写精确版本。ACP 客户端库锁定与 dsh-acp 相同的 `@agentclientprotocol/sdk@1.4.0`（npm latest 为 1.8.0），升级 dsh 时一起核对。
- `$DSH_HOME` 决定 profile、凭据与数据位置 → Wevir 给 dsh 一个**独立的 DSH_HOME**（`<数据目录>/engines/dsh`），不与用户自己装的 dsh 混用。
- 两条进程外接入路径（T0.3 实测，见 [dsh-integration-spike.md](./research/dsh-integration-spike.md)）：

| 路径 | 能力 | 缺口 |
|---|---|---|
| **ACP**（`dsh --profile acp`，stdio，标准 Agent Client Protocol v1，TS 库 `@agentclientprotocol/sdk`） | `session/new`、`list`、`resume`、`close`、`cancel`（结算为 `cancelled`，并杀掉正在跑的子进程）、`set_config_option`（模型/推理强度）、`session/update` 更新、`session/request_permission` 审批（allow / reject / cancel）、MCP 挂载；单进程可并发承载多个会话；冷启动到 initialize 约 0.5 s | **没有增量流式**：一条已提交消息一个 chunk，取消时一次补发已生成部分；不回放历史（无 `session/load`，resume 不发 update）；`session/list` 只有 `sessionId` + `cwd` 且不含活跃会话；审批只来自沙箱升级，请求只带 `toolCallId`，选项仅 `allow_once` / `reject_once`；没有标题、plan、todo 事件，子 agent 活动不可见；工具 `kind` 恒为 `other`，无 `locations` / `diff`；轮次失败以 `-32603` 自由文本返回；无终端、客户端文件系统；仅一个主 workspace；没有登录入口 |
| **SDK JSON-RPC**（`dsh --profile sdk`，`@deepseek-ai/dsh-sdk-client`） | 打开会话、发提示、订阅会话事件与 subagent 通知、`session/wait`；标题、todo、子 agent 事件、会话内事件 `seq`、运行状态 | **无取消、无审批**（取消只能杀进程）；同样没有增量流式；没有 list / close |

**接入路径（[ADR-0001](./adr/0001-runtime-integration.md)，T0.3 已验证）：以 ACP 为主路径，增量流式由 Wevir 自己的 Cordis 插件旁路补齐**（监听 dsh 进程内的 `agent/assistant-stream`，经额外 fd 输出，T3.2a）。历史回放、会话列表、标题与 `seq` 由 Wevir 事件库负责。

- 进程环境要点（T0.3 §6.3、§10，ADR-0001 §4）：子进程环境按白名单构造，因为 dsh 的凭据解析顺序是“继承的环境变量 > `$DSH_HOME/.credentials.yaml` > `<进程 cwd>/.env` > `$DSH_HOME/.env`”；dsh 进程的 cwd 必须是 Wevir 自己的目录，不能是用户工作区；`DSH_AGENTS_HOME`（默认 `~/.agents`，其中的 skills 与 AGENTS.md 会进入每个会话）骨架阶段指向空目录；`DSH_TELEMETRY_DISABLED=1`；`DSH_PERMISSION_MODE=workspace-write`（工作区内读写、系统临时目录写入都不需要审批）。
- Provider 配置：自定义 Provider 走 `dsh-llm-pi-ai`，在 `--patch` overlay 中声明 `baseURL`、协议（`openai-completions` / `openai-responses` / `anthropic-messages`）、`compat`、模型（含 `contextWindow`）和 `apiKeyEnv`；DeepSeek 官方走 `llm-deepseek`，`web-search-deepseek` 另有自己的 Key 引用。可复制的 overlay 见 T0.3 §6.2。OAuth 类 Provider（订阅账号登录）推迟，见 ADR-0001 未决事项 1。
- 关键文档：`docs/architecture.zh.md`、`docs/agent-lifecycle.zh.md`、`docs/capability-seams.zh.md`、`packages/acp/acp/README.zh.md`、`packages/sdk/*/README.zh.md`、`docs/user/guide/providers.md`。

### 3.2 OpenWork（参考重点目录）

`apps/app`（React + Vite + Tailwind v4 主界面）、`apps/desktop`（Electron 壳）、`apps/server`、`packages/ui`、`packages/sdk`、`packages/types`、`docs/architecture`。**`ee/` 整个目录排除**。研读结论（信息架构、可移植候选 32 项、M5 布局建议）见 [openwork-notes.md](./research/openwork-notes.md)；会话数据、事件流与配置格式都是 OpenCode 的，Wevir 只借界面层与做法。

### 3.3 Paseo（参考重点目录）

`packages/server`（daemon）、`packages/protocol`（`@getpaseo/protocol`）、`packages/client`、`packages/relay`、`packages/app`（Expo）、`packages/desktop`、`packages/cli`、`public-docs/sdk`。研读结论见 [paseo-notes.md](./research/paseo-notes.md)；骨架阶段直接采纳的 A1–A21 已写进 ADR-0002 与 §6 各任务。

---

## 4. 骨架阶段的终点

### 4.1 目标仓库结构

```text
wevir/
├─ apps/
│  ├─ desktop/            Electron + React（M5）
│  └─ cli/                wevir 命令行客户端（M4，开发调试与多端验证用）
├─ packages/
│  ├─ protocol/           Host API：领域类型、zod schema、事件封装、协议版本（M1）
│  ├─ runtime-adapter/    AgentRuntimeAdapter 接口 + 契约测试套件 + echo 假适配器（M1）
│  ├─ storage/            SQLite schema、迁移、仓储（M2）
│  ├─ host/               Local Agent Host：会话管理、事件库、审批、RPC 服务（M2）
│  ├─ adapter-dsh/        dsh 适配器：进程管理、ACP 映射、Provider 桥接（M3）
│  └─ client-sdk/         Host 的 TS 客户端：连接、请求、订阅、断线续传（M4）
├─ docs/
│  ├─ SKELETON_PLAN.md    本文件
│  ├─ TASK_PROMPTS.md     任务 prompt 库
│  ├─ adr/                架构决策记录
│  ├─ architecture/       领域模型、协议、事件映射等
│  ├─ research/           上游研读笔记与 Spike 结论
│  └─ upstream/UPSTREAM.md  上游锁定提交与移植登记
├─ scripts/upstream-sync.sh
├─ spikes/                一次性验证代码（不进入产品构建）
└─ upstream/              上游仓库只读克隆（gitignore）
```

`apps/mobile` 与 `packages/relay` 骨架阶段不建，但协议要为它们预留字段（`deviceId`、`clientKind`）。

### 4.2 “骨架完成”的验收定义

全部满足才算骨架完成：

1. `pnpm install && pnpm dev` 能启动 Host 与桌面应用。
2. 在桌面端添加一个本地文件夹作为工作区，配置一个 Provider（DeepSeek 官方，或任一 OpenAI 兼容地址 + Key）。
3. 新建会话、发送提示，能看到**流式**助手输出和工具调用过程。
4. dsh 发起权限请求时，桌面端出现审批卡片，允许/拒绝能正确传回。
5. 运行中可以取消。
6. 完全退出应用再打开，会话列表与完整历史都在，能在原会话上继续对话。
7. 同时用 `wevir session attach <id>` 连到同一会话，CLI 与桌面看到同一事件流；在 CLI 中审批，桌面状态同步更新。
8. 能在临时工作区完成一个真实的多步骤文件任务（例如“读取目录下的 CSV，汇总后写一个 summary.md”）。
9. CI 在 macOS 与 Windows 上跑通 lint、typecheck、test。

---

## 5. 任务总览（进度看板）

| ID | 任务 | 依赖 | 状态 | 备注 |
|---|---|---|---|---|
| **M0** | **地基准备** | | | |
| T0.1 | 初始化 monorepo 与工程规范 | — | [x] | pnpm 12 workspace、TS 7（NodeNext）、Biome 2.5 `noRestrictedImports` + `scripts/check-engine-boundary.mjs` 守引擎边界（`spikes/` 豁免、不得被反向引用）、Vitest 5 projects、tsdown；占位包 `packages/protocol`；AGENTS.md |
| T0.2 | 上游参考快照与许可证核实 | T0.1 | [x] | `scripts/upstream-sync.sh` + `docs/upstream/upstream.lock`（dsh `d743267` = tag `dsh-v0.2.1-alpha.2`、OpenWork `ad22cdc`、Paseo `dc7bc8d`）；`docs/upstream/UPSTREAM.md`：Paseo 实为 Apache-2.0，OpenWork `ee/` 之外 MIT；`.gitignore` 改为 `/upstream/`（原写法误忽略了 `docs/upstream/`） |
| T0.3 | dsh 接入 Spike（ACP vs SDK） | T0.2 | [x] | `2ce30c0`：`docs/research/dsh-integration-spike.md` + `spikes/dsh-acp/`；ACP 可作骨架主路径，缺增量流式，用 Cordis 插件旁路（stream-tap）补齐；报告 §11.3 的计划修改建议交 T0.6 |
| T0.4 | Paseo 架构研读 | T0.2 | [x] | `docs/research/paseo-notes.md`（Paseo `dc7bc8d`）：8 个问题逐条附源码行号；§9 三栏结论，直接采纳 A1–A21 各自落到 T1.1–T5.1；§10 对 ADR-0002 与 T1.2–T5.1 的修改建议交 T0.6 |
| T0.5 | OpenWork 架构研读 | T0.2 | [x] | `docs/research/openwork-notes.md`（OpenWork `ad22cdc`）：6 个问题逐条附源码行号；§8 可移植候选 32 项（全在 `ee/` 之外，逐项给许可证、依赖、OpenCode 耦合与建议）；§9 M5 布局建议；§10 对 T5.1–T5.4、T1.1 与 UPSTREAM.md 的修改建议交 T0.6 |
| T0.6 | 首批 ADR 定稿 | T0.3–T0.5 | [x] | `docs/adr/` README + 0001–0004 Accepted：ACP + stream-tap 旁路、JSON-RPC/WS 与进程模型（吸收 Paseo A1–A21）、`node:sqlite`（附基准实测）、工具链确认；§1.4、§3、§6 同步，新增 T3.2a；UPSTREAM.md 补 OpenWork 许可证三点与 dsh 依赖闭包初核 |
| **M1** | **契约先行** | | | |
| T1.1 | 领域模型 v0 | T0.6 | [x] | `docs/architecture/domain-model.md`：五个实体与三个预留实体、产品层事实 / 引擎投影划分与会话 ID 映射、会话与审批状态机（mermaid）、事件目录 v0（新增 `user.message`、`turn.*`、`assistant.stream_ended`、`todo.updated`）、增量合并与工具收尾规则、dsh 工具名 → 展示类型、不直接采用 `UIMessage`；§9 逐项对照全部 ACP 样本 |
| T1.2 | Host API v0（protocol 包） | T1.1 | [x] | `packages/protocol`（zod 4.6）：协议 `0.1.0` 与版本协商、领域实体、JSON-RPC 封装、20 个方法 + `events.event` 的注册表 `MethodSchemas` / `NotificationSchemas`、19 种事件的判别联合、错误码与关闭码、截断与连接健康常量；`docs/architecture/host-api.md`（表格由测试与代码比对）；冻结样本 `src/compat/0.1.0.json`；ADR-0002 补记能力门控不扣事件 |
| T1.3 | AgentRuntimeAdapter 接口 + 契约测试 + echo 适配器 | T1.1 | [x] | `packages/runtime-adapter`：接口按 ADR-0001 §7 调整（`cancel` 幂等、`listPendingApprovals`、增量与已提交消息 `replaces`、`engine.exited`、审批选项 ID），与草案的差异写在 `src/adapter.ts`，`AgentEvent` 定稿回写 domain-model §6.2；`./contract` 导出 `runAdapterContract`（18 条，按能力开关跳过）；`./echo` 导出 `EchoAdapter`（`tool` / `approve` / `think` / `fail` 关键词、`simulateEngineExit`）。**Gate M1 通过**：protocol 与 runtime-adapter 的 test、typecheck 全绿 |
| **M2** | **Local Agent Host 核心** | | | |
| T2.1 | storage：SQLite schema 与迁移 | T1.2 | [ ] | |
| T2.2 | 事件库与回放 | T2.1 | [ ] | |
| T2.3 | 会话管理器与审批状态机 | T2.2, T1.3 | [ ] | |
| T2.4 | WebSocket JSON-RPC 服务 | T2.3 | [ ] | |
| T2.5 | Host 进程入口与运行时文件 | T2.4 | [ ] | |
| **M3** | **dsh 适配器** | | | |
| T3.1 | dsh 进程管理（定位、启动、独立 DSH_HOME） | T2.5 | [ ] | |
| T3.2a | 增量流式旁路（stream-tap 插件） | T3.1 | [ ] | T0.6 新增（ADR-0001）；可与 T3.4 并行 |
| T3.2 | ACP → Wevir 事件映射 | T3.1, T3.2a | [ ] | |
| T3.3 | 审批桥接 | T3.2 | [ ] | |
| T3.4 | Provider 配置桥接 | T3.1 | [ ] | 可与 T3.2a、T3.2 并行 |
| T3.5 | 会话恢复 | T3.3 | [ ] | |
| T3.6 | 适配器契约测试（真实 dsh + 录制回放） | T3.5, T3.4 | [ ] | |
| **M4** | **竖切联通：CLI** | | | |
| T4.1 | client-sdk | T2.4 | [ ] | 可在 M3 期间开始 |
| T4.2 | `wevir` CLI | T4.1, T3.6 | [ ] | |
| **M5** | **桌面壳** | | | |
| T5.1 | Electron 壳与 Host 生命周期 | T4.2 | [ ] | |
| T5.2 | 设计 Token 与布局骨架 | T5.1 | [ ] | |
| T5.3 | 会话视图（流式、工具卡片、审批、取消） | T5.2 | [ ] | |
| T5.4 | 设置：Provider 与工作区 | T5.2 | [ ] | |
| T5.5 | 重启恢复与断线重连 | T5.3 | [ ] | |
| **M6** | **骨架收尾** | | | |
| T6.1 | 开发文档（含大陆镜像配置） | M5 | [ ] | |
| T6.2 | CI（macOS + Windows） | T0.1 | [ ] | 可提前做 |
| T6.3 | 上游来源与 NOTICE 核查 | M5 | [ ] | |
| T6.4 | 骨架复盘，规划 Phase 1 | 全部 | [ ] | |

---

## 6. 里程碑与任务细节

### M0 — 地基准备

目标：仓库能构建、上游能复现、关键假设被验证。**本里程碑基本不写产品代码。**

**T0.1 初始化 monorepo 与工程规范**
- 产出：`git init`；pnpm workspace；根 `tsconfig.base.json`（strict）；Biome；Vitest；`.node-version`；`LICENSE`（MIT）；`README.md`；`AGENTS.md`（给 AI 助手的仓库规则，`CLAUDE.md` 指向它）；`.gitignore`（含 `upstream/`、`.wevir-dev/`）；`.npmrc` 注释说明如何切换国内镜像。
- 一条 lint 规则：除 `packages/adapter-dsh` 外禁止 import `@deepseek-ai/*`。
- 验收：`pnpm -r build`、`pnpm lint`、`pnpm test` 在只有一个占位包时全部通过。

**T0.2 上游参考快照与许可证核实**
- 产出：`scripts/upstream-sync.sh`（按锁定提交浅克隆三个仓库到 `upstream/`，支持通过环境变量换 GitHub 镜像）；`docs/upstream/UPSTREAM.md`（仓库、提交 SHA、日期、许可证原文位置、参考目录、移植登记表）。
- 必须核实：Paseo 根许可证的实际内容；OpenWork `LICENSES/` 与 `ee/LICENSE` 的边界。
- 验收：删掉 `upstream/` 后执行脚本能复现同一批提交。

**T0.3 dsh 接入 Spike（最关键的一步）**
- 在 `spikes/dsh-acp/` 写一次性脚本，锁定 `@deepseek-ai/dsh@0.2.1-alpha.2`，使用独立临时 `DSH_HOME`：
  1. 用 `@agentclientprotocol/sdk` 启动 `dsh --profile acp`，走完 `initialize → session/new → session/prompt → session/update 流 → request_permission → session/cancel → session/close → session/list → session/resume`。
  2. 验证 Provider 注入：通过 `--patch` overlay + `apiKeyEnv` 环境变量配置 DeepSeek 官方与一个 OpenAI 兼容地址，Key 不写入 `DSH_HOME`。
  3. 用 `@deepseek-ai/dsh-sdk-client` 跑一个对照，记录与 ACP 的差异。
  4. 记录：冷启动耗时、各类 `session/update` 的真实 payload 样本、权限请求的结构、resume 后哪些信息丢失。
- 产出：`docs/research/dsh-integration-spike.md` + 录制的 JSON 样本（`spikes/dsh-acp/fixtures/`）。
- 验收：能给出“ACP 是否可作为骨架主路径”的明确结论；若否，给出替代方案。

**T0.4 Paseo 架构研读**（只读，不写代码）
- 关注：daemon 生命周期与发现机制；协议版本化；事件序号、断线补发、状态快照；多客户端并发操作；设备配对与令牌作用域；中继加密。
- 产出：`docs/research/paseo-notes.md`，结尾列出“Wevir 骨架直接采纳 / 推迟到移动端阶段 / 不采纳”三栏。

**T0.5 OpenWork 架构研读**（只读，不写代码）
- 关注：信息架构（工作区、会话、文件、Skills、MCP 的组织方式）；桌面壳与服务端的关系；UI 组件中值得移植的部分（仅 MIT 区域）；它与 OpenCode 的耦合点（Wevir 不能带走的部分）。
- 产出：`docs/research/openwork-notes.md`，含“可移植组件候选清单”（路径 + 许可证 + 依赖）。

**T0.6 首批 ADR 定稿**（索引与格式见 [docs/adr/README.md](./adr/README.md)）
- `docs/adr/0001-runtime-integration.md`：ACP 子进程为主路径，增量流式由 stream-tap 插件旁路补齐；单进程多会话；进程环境白名单；Wevir 必须自行补足的能力清单（依据 T0.3）。
- `docs/adr/0002-host-transport-and-process-model.md`：JSON-RPC 2.0 over WebSocket，监听 127.0.0.1 随机端口；令牌每次启动随机生成，在首帧 `host.hello` 的参数里出示，不用 `Authorization` 头（Electron 渲染进程的浏览器 WebSocket 设不了请求头）；骨架阶段 Host 由桌面端拉起、随桌面退出，桌面只停止本次自己拉起的 Host（按 `{pid, startedAt}` 判定），附着到 CLI 启动的 Host 时不停止；Host 代码独立可运行，为将来常驻 daemon 留路；吸收 Paseo 研读“直接采纳”的 A1–A21。
- `docs/adr/0003-storage.md`：选 `node:sqlite`（dsh 自身也用它；better-sqlite3 13 已改 N-API，作为可切换的备选）；密钥骨架阶段存 0600 文件，后续迁移系统钥匙串。
- `docs/adr/0004-repo-tooling.md`：确认 §1.4 的工具链，补充 `allowBuilds`、引擎依赖精确锁定、electron-vite 版本规则。
- **Gate M0**：ADR 0001–0004 状态为 Accepted；本文件 §3、§6 已按 Spike 结论更新。

### M1 — 契约先行

**T1.1 领域模型 v0**
- 实体：`Workspace`、`ProviderProfile`、`Session`、`ApprovalRequest`、`WevirEvent`；预留但不实现：`Task`、`Artifact`、`Device`。
- 明确划分：哪些是产品层实体（Wevir 拥有），哪些只是引擎事实的投影。
- 会话状态机：`idle → running ⇄ awaiting_approval → cancelling → idle`，以及 `error`、`closed`。
- `Workspace` 至少含 `id`、`rootPath`（realpath 规范化，Host 按它去重）、`displayName`、`createdAt`；`Session` 恰属一个工作区（ACP 只有一个主 workspace）。
- `ApprovalRequest` 原样携带引擎给的选项列表（id、标签、allow / reject 类别），`approval.respond` 回传所选选项 ID；审批详情来自同一 `toolCallId` 的工具调用输入（ADR-0001 §5）。审批决定记录 `decidedBy`（`deviceId`、`clientKind`）。
- 事件目录区分助手文本的增量（来自 T3.2a 旁路）与已提交消息（替换增量）；工具调用带展示类型，参考 Paseo `ToolCallDetail` 的分类（shell / read / edit / write / search / fetch / plan / unknown），因为 dsh 的 ACP `kind` 恒为 `other`。
- 客户端消息投影是否直接采用 AI SDK `UIMessage` 的部件形状（`ai` 包为 Apache-2.0，只用类型），在本任务决定（OpenWork 研读 §3.2）。
- 产出：`docs/architecture/domain-model.md`（含状态图）。

**T1.2 Host API v0**
- `packages/protocol`：协议版本常量；所有方法的请求/响应 zod schema；事件封装：

  ```ts
  interface WevirEvent {
    seq: number            // 会话内单调递增
    sessionId: string
    ts: string             // ISO 时间
    type: string           // 如 'assistant.delta'、'tool.started'、'approval.requested'
    source: 'host' | 'engine'
    payload: unknown       // 按 type 区分的 schema
  }
  ```
- 方法 v0：`host.hello`、`host.ping`、`host.shutdown`、`workspace.list/add/remove`、`provider.list/upsert/remove/test`、`session.create/list/get/send/cancel/close/resume`、`approval.respond`、`events.subscribe(sessionId, sinceSeq)` / `events.unsubscribe(subscriptionId)`；推送 `events.event`。
- 按 ADR-0002 落地：
  - `host.hello` 参数 `token`、`protocolVersion`、`clientKind`、`deviceId`、`clientId`、`capabilities`；结果 `hostId`、`hostVersion`、协商后的 `protocolVersion`、`minProtocolVersion`、`features`、`permissions`。
  - `events.subscribe` 返回 `subscriptionId` 和回放结束标记（或 `replayedThroughSeq`），事件通知带 `subscriptionId`。
  - `session.get` 返回快照 `{state, pendingApprovals, activeTurn, lastSeq, …}`；`session.send` 带可选 `clientMessageId`；事件 `approval.resolved` 带 `decidedBy`。
  - 错误码覆盖 `unauthorized`、`incompatible_protocol`、`session_busy`、`already_decided`、`client_message_conflict` 等；hello 失败时的关闭码。
  - `host-api.md` 含“兼容规则”（只增不减、新字段 optional、不收窄、`COMPAT` 标签）、“错误码与关闭码表”、“工具输出截断上限”三节；schema 单测保留“旧消息仍能解析”的样本。
- 产出：`docs/architecture/host-api.md` + 包 + schema 单测。

**T1.3 AgentRuntimeAdapter 接口**
- 以决策基线中的接口为起点，按 T0.3 结论调整：

  ```ts
  interface AgentRuntimeAdapter {
    createSession(config: SessionConfig): Promise<EngineSession>
    resumeSession(engineSessionId: string, config: SessionConfig): Promise<EngineSession>
    send(engineSessionId: string, input: AgentInput): Promise<void>
    subscribe(engineSessionId: string): AsyncIterable<AgentEvent>
    respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void>
    cancel(engineSessionId: string): Promise<void>
    close(engineSessionId: string): Promise<void>
    dispose(): Promise<void>
  }
  ```
- 按 ADR-0001 §7 调整：`cancel` 幂等，只在无法确认已停止时失败；增加列出未决审批的方法，供 Host 对账；`AgentEvent` 区分增量与已提交消息；引擎进程退出（含回合之间）作为事件上报；契约测试带能力声明开关（例如是否支持增量流式），引擎做不到的条款按开关跳过，不删条款。
- 产出：接口包 + 一套与实现无关的**契约测试套件** + `EchoAdapter`（假引擎：回显文本并先发增量再发已提交消息、按关键词模拟一次工具调用和一次审批），让 M2 不依赖 dsh 就能开发。
- **Gate M1**：EchoAdapter 通过契约测试；protocol 包有完整 schema 测试。

### M2 — Local Agent Host 核心

**T2.1 storage**：驱动用 Node 内置 `node:sqlite`（ADR-0003），只在 storage 的一个驱动模块里 import，兼容 `Database` / `DatabaseSync` 两个类名、只用 Node 22.19 已有的 API；`journal_mode=WAL`、`synchronous=NORMAL`、外键开启、busy timeout 5000 ms；自带同步的 `transaction(fn)`（`BEGIN IMMEDIATE`，事务内不得 `await`）。表 `workspaces`（`root_path` 唯一）、`provider_profiles`（不含密钥，只存 `secretRef`）、`sessions`、`events`（追加写，`(session_id, seq)` 唯一）、`approvals`，以及 `clientMessageId` 的发送回执（`(session_id, client_message_id)` 唯一，ADR-0002 §4）；手写 SQL 迁移 + 版本表。密钥：`SecretStore` 接口，骨架实现为数据目录下的 `secrets.json`（0600，先以 0600 写临时文件再 rename；Windows 依赖 `%APPDATA%` 的按用户 ACL），后续迁移到系统钥匙串（ADR-0003）。

**T2.2 事件库与回放**：原子分配 seq；`append`、`readSince(sessionId, seq)`；助手文本增量先在 Host 内按短窗口合并（Paseo 取 60 ms，首尾各 flush 一次）再分配 seq 落库，不能合并的事件先 flush 保序；工具输出入库前按统一上限截断；从事件推导会话快照（状态、标题、最后消息时间、未决审批、当前回合、`lastSeq`）；Host 重启后状态一致。

**T2.3 会话管理器**：Wevir Session ↔ 引擎 Session 映射；状态机落地；每个会话的命令串行执行，会话非 `idle` 时 `session.send` 返回 `session_busy` 和当前状态（不排队、不打断）；审批幂等（同一 `requestId` 首个决定生效，提交到引擎期间暂扣引擎侧的“已解决”事件，成功后写 `approval.resolved` 并记录 `decidedBy`；之后的响应返回 `already_decided` 和既有决定）；取消、关闭、引擎退出时未决审批结为 `cancelled`；`clientMessageId` 幂等，Host 重启后对“已接受、未确认引擎收到”的发送标为结果未知、不自动重发；引擎崩溃时会话转 `error` 并保留历史（ADR-0002 §4）。

**T2.4 RPC 服务**：`ws` 监听 127.0.0.1 随机端口；升级时校验 `Host` 头（缺失也拒绝）与 `Origin` 白名单；首个请求必须是 `host.hello`（15 s 超时），校验 token（常量时间比较）与协议主版本，失败先回错误再以专用关闭码关闭；按客户端能力门控新事件类型；`events.subscribe` 返回 `subscriptionId`，先补发 `sinceSeq` 之后的历史，再无缝切换到实时（不能丢、不能重），带回放结束标记；多个客户端同时订阅同一会话；`host.ping` 心跳租约 45 s；每条连接设发送缓冲上限（ADR-0002 §1–§5）。

**T2.5 Host 进程入口**：`wevir-host` 可执行入口，不依赖桌面即可运行；数据目录（macOS `~/Library/Application Support/Wevir`，Windows `%APPDATA%\Wevir`，`WEVIR_HOME` 覆盖，开发模式 `./.wevir-dev`）；令牌每次启动生成 32 字节随机数；运行时文件 `run/host.json`（pid、startedAt、url、token、protocolVersion、hostVersion；目录 0700、文件 0600；排他创建占位，监听就绪后原子写入 url；用 `kill(pid, 0)` 加 `startedAt` 判断陈旧；退出时只删自己的）；由桌面拉起时可按启动参数持有 stdin 归属管道，读到 EOF 即优雅退出；`host.shutdown` 与 SIGINT / SIGTERM 触发优雅退出，顺序按 ADR-0002 §6（整体 10 s 上限）；结构化日志。
- **Gate M2**：使用 EchoAdapter，用一个最小测试客户端完成：建会话 → 发消息 → 收流式事件 → 审批 → 取消 → 杀掉 Host → 重启 → 回放全部历史。

### M3 — dsh 适配器

本里程碑的做法以 [ADR-0001](./adr/0001-runtime-integration.md) 为准，事实依据是 T0.3 报告与 `spikes/dsh-acp/fixtures/`。

**T3.1 进程管理**：`adapter-dsh` 精确锁定 `@deepseek-ai/dsh@0.2.1-alpha.2` 与 `@agentclientprotocol/sdk@1.4.0`；dsh 依赖里的构建脚本在 `allowBuilds` 中逐个登记（T0.3 在 npm 下是 5 个，pnpm 下以实际输出为准，ADR-0004）；从依赖包解析 dsh 可执行入口，不依赖全局 PATH；独立 `DSH_HOME`（`<数据目录>/engines/dsh`）；按 ADR-0001 §4 构造白名单环境（`DSH_AGENTS_HOME` 指向空目录、`DSH_TELEMETRY_DISABLED=1`、`DSH_PERMISSION_MODE=workspace-write`），进程 cwd 为 `DSH_HOME`（先建目录，不存在会 `ENOENT`）；启动 `dsh --profile acp`，预留 `--patch` 插槽（T3.4）和 fd 3（T3.2a）；`clientCapabilities` 不声明 `fs` 与 `terminal`；initialize 超时（实测约 0.5 s）与 stderr 尾部诊断；一个 dsh 进程承载全部会话（T0.3 已验证）；进程任何时候退出都上报为引擎错误，有限次数指数退避重启；`dispose` 先关 stdin（EOF 后约 25 ms 退出），超时再 SIGTERM、SIGKILL。开发模式下 dsh 跑在系统 Node 上；打包后的运行时见 ADR-0002 未决事项 1。

**T3.2a 增量流式旁路**（T0.6 新增）：把 `spikes/dsh-acp/stream-tap` 产品化为 `packages/adapter-dsh` 内的 Cordis 插件（只用 `ctx`，不 import `@deepseek-ai/*`）：监听 `agent/assistant-stream`，以 NDJSON 写到 `WEVIR_STREAM_FD` 指定的 fd 3；用 `dsh plugin --profile acp add link:<插件目录>` 装进 Wevir 的 `DSH_HOME`，overlay 中 `insert`；适配器读取 fd 3，按会话产出增量事件。插件缺失或没有数据时退化为只有已提交消息，其他功能不受影响。§4.2 第 3 条依赖本任务。

**T3.2 事件映射**：ACP `session/update` 各类型 → `AgentEvent`，以 `spikes/dsh-acp/fixtures/acp/mock/` 为输入；合并 T3.2a 的增量与 ACP 的已提交消息（后者到达时替换前者，按会话内顺序对齐）；工具名 → 展示类型，并从 `rawInput` 提取路径；解析 `todo_write` 的 `rawInput`；取消时一次补发的半段消息；`-32603` 错误文本按前缀归类（缺凭据、Provider 错误、未知）并保留原文；未识别类型映射为 `engine.raw` 保留下来，不丢弃；映射表写入 `docs/architecture/acp-event-mapping.md`。

**T3.3 审批桥接**：`session/request_permission` → `ApprovalRequest` 事件 → 等待 `approval.respond` → 回复 ACP。请求只带 `toolCallId`，详情取同一 `toolCallId` 之前那条 `tool_call` 的 `rawInput`；选项原样携带（dsh 只有 `allow_once` / `reject_once`）。客户端取消或会话关闭时必须以 `cancelled` 回复挂起的审批；Host 退出时同样回复 `cancelled`，重启后残留的未决审批标记为 `expired`。dsh 的审批只来自沙箱升级（工作区外、且不在系统临时目录的操作，模型按提示带 `sandbox_permissions` 重试时才出现），UI 文案与测试用例据此设计。

**T3.4 Provider 桥接**：`ProviderProfile` → dsh 配置 overlay（格式见 T0.3 §6.2：`baseURL`、`api`（`openai-completions` / `openai-responses` / `anthropic-messages`）、`compat`、模型列表与 `contextWindow`、`apiKeyEnv`；`web-search-deepseek` 的 Key 引用一并处理）；Provider ID 会写进 dsh 会话日志，创建后不可改名；密钥仅通过子进程环境变量 `WEVIR_PROVIDER_<ID>_KEY` 传入；首批支持 DeepSeek 官方 + OpenAI 兼容（覆盖通义、Kimi、智谱等国内服务）；`provider.test` 做一次最小请求验证；Provider 变更后是否要重启 dsh 进程，本任务实测后补记到 ADR-0001。OAuth 类 Provider 不做。

**T3.5 会话恢复**：`session.resume` → ACP `session/resume`，必须使用会话创建时的工作区路径（dsh 按 realpath 比较），活跃会话不能 resume；界面历史、会话列表与标题始终来自 Wevir 事件库；记录 resume 前后上下文差异（T0.3：新进程 resume 后模型可见的上下文完整，只缺界面层信息）。

**T3.6 适配器契约测试**：同一套 T1.3 契约测试分三层跑 dsh 适配器：(1) 用 T0.3 录制的样本离线回放；(2) 真实 dsh + 本地 mock Provider（复用 `spikes/dsh-acp/src/mock-llm.ts` 的做法），不需要 Key 就能端到端覆盖工具、审批、取消、resume 与增量旁路（T0.3 的 mock 套件约 25 秒）；(3) 真实模型，由环境变量开关（无 Key 时跳过）。
- **Gate M3**：第 1、2 层契约测试全绿，第 3 层在本机跑通一次；升级 dsh 时的检查清单写入 `docs/upstream/UPSTREAM.md`（含重跑旁路测试、重新核对依赖闭包的许可证）。

### M4 — 竖切联通：CLI

**T4.1 client-sdk**：连接（读取 `run/host.json` 或显式地址；只连 `host.json` 里的地址，不回退默认端口）、`host.hello`（声明穷举的默认能力表）、类型安全的请求、订阅（按 `seq` 去重，发现缺口以 `sinceSeq = lastSeq` 重新订阅，收到回放结束标记才算追平）、断线自动重连并带 `sinceSeq` 续传、`host.ping` 心跳、请求 / 连接 / 心跳超时分开配置。只依赖 `packages/protocol`，不 import Node 内置模块，WebSocket 由调用方注入；读取 `host.json` 的功能放在单独的 Node 入口（ADR-0002 §7）。重连状态机可参考 OpenWork 的 `sync-stream-lifecycle.ts`（OpenWork #1，改写需登记来源）。

**T4.2 `wevir` CLI**：`wevir host start|status|stop`（`start` 以分离方式启动 Host，桌面附着后不会停止它；`stop` 走 `host.shutdown`）、`wevir workspace add <path>`、`wevir provider add`、`wevir session new -w <path> "<prompt>"`、`wevir session list`、`wevir session attach <id>`（实时输出、交互式审批、Ctrl-C 取消）。
- **Gate M4（第一次真正可用）**：真实 dsh + 真实模型，完成 §4.2 第 8 条的多步骤文件任务；两个 CLI 同时 attach 看到同一事件流；重启 Host 后历史完整、可继续对话。dsh 只在沙箱升级时请求审批（ADR-0001 §6），所以要验证审批的用例必须包含一次工作区外、且不在系统临时目录的操作。

### M5 — 桌面壳

**T5.1 Electron 壳**：主进程先读 `run/host.json` 并探活，已有 Host 就附着；否则拉起 Host 并记下 `{pid, startedAt}`、持有其 stdin 归属管道；退出时只停止自己拉起的 Host（ADR-0002 §6）。连接信息 `{url, token}` 通过 preload 交给渲染进程；`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`，preload 打成单个 CJS 文件（沙箱里的 preload 不能用 ESM）；远程调试端口只在开发模式开启；外部链接经 `shell.openExternal`，拦截 `will-navigate` 与 `window.open`；渲染进程只通过 client-sdk 与 Host 通信，不直接读写文件和数据库。存储用 `node:sqlite`（ADR-0003），开发模式 Host 跑在系统 Node 上，不涉及 Electron 原生模块重编译。

**T5.2 设计 Token 与布局骨架**：Wevir 自己的颜色、字号、间距、圆角 Token（亮/暗两套），三层结构：`@radix-ui/colors` 色阶 → 一套语义变量 → Tailwind `@theme inline`；暗色只认 `<html data-theme="dark">`；正文 14px / 行高 1.6，系统字体栈，不引入网络字体。三栏布局：左侧“工作区 → 会话”两级树（会话行带运行中 / 待审批 / 出错 / 未读标记，底部放设置与 Host 连接状态）、中间对话、右侧面板默认收起（按“每会话一组标签”设计，将来放文件、Diff、成果）。路由 `/workspace/:wid/session/:sid`、`/workspace/:wid/session`（新会话草稿）、`/settings/:tab`，URL 是当前工作区与会话的唯一事实。参考 OpenWork 的信息架构（openwork-notes §9），不复制其视觉。

**T5.3 会话视图**：流式消息渲染（Markdown + 代码块，流式时只重渲染末尾块，代码高亮等流式结束后再做）；可折叠的工具调用卡片（名称、参数摘要、状态、结果；回合已结束而工具未收尾时显示“状态未知”）；审批卡片内联在输入框上方而不是模态框，一次显示一个，内容取同一 `toolCallId` 的 `rawInput`，按请求携带的选项渲染按钮，另一端已处理时按 `approval.resolved` 收起并提示；取消按钮；会话状态指示；输入框（Enter 发送、Shift+Enter 换行、输入法合成期间不发送，运行中不允许再发送）。

**T5.4 设置**：Provider 增删改 + 测试连接；工作区添加（系统文件夹选择器，Host 按 realpath 去重）与移除（只注销，不删文件）；中文为默认语言与源语言，所有导航文案走集中管理的文案模块，为 i18n 留口。

**T5.5 恢复与重连**：应用重启后恢复会话列表与当前会话；Host 断开时显示状态并自动重连，重连后按 `sinceSeq` 补齐；Host 意外退出时只重新拉起自己拥有的 Host。
- **Gate M5**：§4.2 第 1–7 条全部通过（手动验收，录屏或截图存档到 `docs/research/skeleton-acceptance/`）。

### M6 — 骨架收尾

- **T6.1** `docs/development.md`：环境要求、启动、调试、大陆镜像（npm registry、`ELECTRON_MIRROR`、GitHub 镜像）。
- **T6.2** GitHub Actions：macOS + Windows 上 lint、typecheck、test（可提前到 M1 做）；Node 用 `.node-version`，另跑一次 `engines` 下限 22.19，覆盖 `node:sqlite` 在各版本间的 API 差异（ADR-0003）。
- **T6.3** 检查所有移植文件的来源头部与 `UPSTREAM.md` 登记；生成 `NOTICE`；核对 dsh 依赖闭包中的 MPL-2.0 / LGPL-3.0 组件（UPSTREAM.md §2.1）与 OpenWork 区域里第三方派生内容的署名（§2.2）。
- **T6.4** 复盘：更新本文件，产出 `docs/PHASE1_PLAN.md`（终端、Git Diff、文件预览、Skills/MCP 管理（扩展库统一入口、远程 MCP 的托管 OAuth）、OAuth 类 Provider 的 Spike、“总是允许”审批规则、手机端准备）。
- **Gate M6**：§4.2 全部九条通过。

---

## 7. 骨架阶段明确不做

- 手机 App、远程中继、设备配对（协议里只预留 `deviceId` / `clientKind`）。
- Tauri、Linux 安装包、自动更新、代码签名与公证。
- 多 Agent 并行、Git worktree。
- 长期记忆、办公成果生成、插件 SDK、模型故障转移路由。
- OAuth 类 Provider（订阅账号登录）；“总是允许”一类的审批规则（ADR-0001）。
- 终端面板、Git Diff、文件预览（Phase 1 第一批）。
- 整体 fork OpenWork 或 Paseo；修改 dsh 源码（确有必要时用补丁文件并登记）。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| dsh 预览版不兼容变更 | 精确锁版本；只有 `adapter-dsh` 接触 dsh；契约测试 + 录制样本；升级检查清单 |
| ACP 不回放历史、无增量流式、无终端/计划/todo 等富信息 | 历史由 Wevir 事件库负责；增量流式用 Cordis 插件旁路补齐（T0.3 已验证，T3.2a）；富信息在 Phase 1 评估：ACP `_meta` 扩展、同一插件补发事件，或切换到 SDK/Web RPC |
| 旁路依赖 dsh 进程内事件 `agent/assistant-stream`，不是公开契约 | 升级检查清单必须重跑旁路测试；旁路失效时退化为整条消息，不影响其他功能（ADR-0001） |
| dsh 读取 `~/.agents` 的 skills / AGENTS.md，以及进程 cwd 的 `.env` | `DSH_AGENTS_HOME` 指向空目录；dsh 进程 cwd 用 `DSH_HOME`；子进程环境白名单（T3.1） |
| OAuth 类 Provider 的 grant 只能落 `DSH_HOME` | 骨架只支持 API Key 类 Provider；Phase 1 前单独 Spike（ADR-0001 未决事项 1） |
| 审批只来自沙箱升级，真实模型是否按提示升级未验证 | 验收用例包含工作区外的操作；有 Key 后补跑 T0.3 的真实模型步骤 |
| ACP 只支持一个主 workspace | 骨架阶段一个会话对应一个工作区目录，足够；多目录在后续阶段评估 |
| 引擎生命周期归属冲突 | dsh 进程只由 `adapter-dsh` 管理；Host 是唯一调度者；不引入 Paseo daemon 或 OpenWork server 作为第二套执行体系 |
| 许可证混用 | `ee/` 全部排除；Paseo 许可证在 T0.2 核实；移植文件逐个登记 |
| 大陆网络 | 镜像可配置；CI 与本地均验证一次镜像安装路径 |
| 密钥泄露 | 密钥只在 Host 内存与 0600 文件中（Windows 依赖 `%APPDATA%` 的按用户 ACL）；日志脱敏；后续迁移系统钥匙串（ADR-0003） |
| `node:sqlite` 在 Node 22 仍是 1.1 阶段、各版本 API 有差异 | 只在 storage 的驱动模块里使用，只用 22.19 已有的 API；better-sqlite3 13 作为可切换的备选（ADR-0003） |
| dsh 运行时带原生模块（`node-pty`、`koffi`）与安装脚本 | `allowBuilds` 逐个登记（ADR-0004）；骨架只跑开发模式，打包后的 Node 运行时在打包阶段决定（ADR-0002 未决事项 1） |

---

## 9. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-12 | v0.1 初稿：基于调研结论与 dsh / OpenWork / Paseo 当前仓库核实 |
| 2026-10-12 | T0.1：§2.2 引擎边界补充“不得声明依赖”与 `spikes/` 豁免（产品代码不得反向引用 spikes/） |
| 2026-10-12 | T0.2：§1.2 Paseo 许可证核实为 Apache-2.0；上游锁定提交与许可证结论见 `docs/upstream/UPSTREAM.md` |
| 2026-10-12 | T0.4：§6 T0.6 的 ADR-0002 由“Bearer token”改为令牌在 `host.hello` 中出示，并写明桌面只停止自己拉起的 Host；§5 补勾 T0.3 |
| 2026-10-12 | T0.6：ADR-0001–0004 Accepted；§1.4 按 ADR-0004 改写（补版本、`allowBuilds`、引擎依赖、`ws`、`node:sqlite`）；§3.1 按 T0.3 实测改写 ACP / SDK 能力与缺口和进程环境要点；§6 M1–M6 吸收 ADR-0001–0003 与 Paseo A1–A21、OpenWork 布局建议，M3 新增 T3.2a 增量流式旁路（§5 同步）、T3.6 增加“真实 dsh + mock Provider”层，Gate M4 写明审批用例要有工作区外操作；§1.3、§2.8、§7、§8 相应补充 |
