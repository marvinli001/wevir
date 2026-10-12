# Wevir 初步骨架规划

> 状态：草案 v0.1 · 建立日期：2026-10-12 · 维护者：marvinli001
> 配套文档：[TASK_PROMPTS.md](./TASK_PROMPTS.md)（每个任务可直接粘贴执行的 prompt）

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
| [Paseo](https://github.com/getpaseo/paseo) | 20,517 | 待核实（API 显示 NOASSERTION，早前调研为 Apache-2.0） | `main` | **多端与远程架构参考**：daemon、WebSocket 协议、设备配对、加密中继、Expo 手机端 | **只读参考**，骨架阶段不移植代码 |

> dsh 仍是 developer preview，官方明确会有不兼容变更。所以：**Wevir 的 UI 和 Host 业务代码不得直接依赖 dsh 内部类型**，只有 `adapter-dsh` 一个包可以碰它。

### 1.3 冻结的技术决策

| 决策项 | 方案 |
|---|---|
| 主 Agent Runtime | DeepSeek Harness，经 `AgentRuntimeAdapter` 隔离 |
| 桌面端 | Electron + React + TypeScript |
| 移动端（骨架阶段不做） | Expo / React Native |
| Host ↔ 客户端通信 | 独立版本化的 JSON-RPC 2.0 over WebSocket |
| 本地持久化 | SQLite + 文件系统 |
| Agent 扩展机制 | Cordis Plugin（dsh 侧） |
| LLM 集成 | Provider Adapter + 模型能力注册 |
| 首版平台 | macOS、Windows；Linux 后续 |
| 许可证 | MIT；移植代码各自遵循原条款并保留来源 |

### 1.4 骨架阶段的工具链默认值（T0.1 / T0.6 可在 ADR 中推翻）

| 项 | 默认 | 理由 |
|---|---|---|
| 包管理 | pnpm workspace | 与 dsh、OpenWork 一致 |
| Node | ≥ 22.19（本机 v26 可用） | dsh 要求 `^22.19.0 \|\| >=24.0.0` |
| 语言 | TypeScript strict，ESM | — |
| 库构建 | tsdown | 与 dsh 一致 |
| 桌面构建 | electron-vite | main/preload/renderer 一套配置 |
| UI | React + Tailwind v4 | 与 OpenWork `apps/app` 一致，便于参考 |
| 校验/Schema | zod | 协议类型与运行时校验共用 |
| 测试 | Vitest | — |
| Lint/Format | Biome | 单工具，速度快 |

---

## 2. 地基原则

1. **一个事实来源。** 会话、任务、审批的状态以 Wevir Host 的事件库为准。dsh 的会话日志是引擎层事实，Host 负责把它翻译成产品层事实。
2. **引擎在适配器后面。** `packages/adapter-dsh` 之外的任何包不得 `import '@deepseek-ai/*'`，也不得声明这类依赖（T0.1 用 Biome 规则 + `scripts/check-engine-boundary.mjs` 强制）。`spikes/` 不属于产品代码，豁免；但产品代码不得反向引用 `spikes/`。
3. **契约先行。** 先有 `packages/protocol` 的类型与 schema，再写 Host 和客户端；协议带版本号，握手时校验。
4. **先竖切，再铺开。** 先打通“建会话 → 发提示 → 看流式输出 → 审批 → 取消 → 重启恢复”这一条线，再加功能。
5. **先 CLI 后 GUI。** CLI 客户端能完整走通，才开始做桌面 UI。CLI 同时证明“多客户端共享同一事件流”，这是将来手机端的地基。
6. **上游代码：参考优先，移植从严。** 移植的文件头部必须写明来源仓库、路径、提交号和许可证，并登记到 `docs/upstream/UPSTREAM.md`。
7. **大陆网络可替换。** npm registry、Electron 二进制、模型 API 地址都必须可配置；不把海外服务设为强制依赖。
8. **密钥不落引擎文件。** 模型 API Key 由 Host 管理，通过子进程环境变量传给 dsh（dsh 支持 `apiKeyEnv`），不写进 `$DSH_HOME`。

---

## 3. 已核实的上游接入点（2026-10-12）

### 3.1 DeepSeek Harness

- 运行入口统一是 `dsh --profile <name>`，随附 profile：`web`、`headless`、`sdk`、`sdk-minimal`、`acp`。
- 仓库版本 `0.2.1-alpha.2`；npm `@deepseek-ai/dsh` 的 `latest` 标签仍是 `0.2.0-rc.2`，alpha 版本需要显式指定。
- `$DSH_HOME` 决定 profile、凭据与数据位置 → Wevir 应给 dsh 一个**独立的 DSH_HOME**，不与用户自己装的 dsh 混用。
- 两条进程外接入路径：

| 路径 | 能力 | 缺口 |
|---|---|---|
| **ACP**（`dsh --profile acp`，stdio，标准 Agent Client Protocol v1，TS 库 `@agentclientprotocol/sdk`） | `session/new`、`list`、`resume`、`close`、`cancel`、`set_config_option`（模型/推理强度）、`session/update` 流式更新、`session/request_permission` 审批、MCP 挂载 | 不回放历史（无 `session/load`）；无终端、计划、todo、客户端文件系统；仅一个主 workspace |
| **SDK JSON-RPC**（`dsh --profile sdk`，`@deepseek-ai/dsh-sdk-client`） | 打开会话、发提示、订阅会话事件与 subagent 通知、`session/wait` | **无取消、无审批**（取消只能杀进程） |

**骨架阶段的接入假设：以 ACP 为主路径**（有取消和审批，且是标准协议，将来接 Claude Code、Codex、Gemini CLI 等 ACP Agent 时可复用同一套适配逻辑）。历史回放由 Wevir 自己的事件库负责。此假设需要 **T0.3 Spike** 验证后写入 ADR-0001。

- Provider 配置：自定义 Provider 走 `dsh-llm-pi-ai`，可在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 或 `--patch` overlay 中声明 `baseURL`、协议、模型和 `apiKeyEnv`。
- 关键文档：`docs/architecture.zh.md`、`docs/agent-lifecycle.zh.md`、`docs/capability-seams.zh.md`、`packages/acp/acp/README.zh.md`、`packages/sdk/*/README.zh.md`、`docs/user/guide/providers.md`。

### 3.2 OpenWork（参考重点目录）

`apps/app`（React + Vite + Tailwind v4 主界面）、`apps/desktop`（Electron 壳）、`apps/server`、`packages/ui`、`packages/sdk`、`packages/types`、`docs/architecture`。**`ee/` 整个目录排除**。

### 3.3 Paseo（参考重点目录）

`packages/server`（daemon）、`packages/protocol`（`@getpaseo/protocol`）、`packages/client`、`packages/relay`、`packages/app`（Expo）、`packages/desktop`、`packages/cli`、`public-docs/sdk`。

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
| T0.2 | 上游参考快照与许可证核实 | T0.1 | [ ] | |
| T0.3 | dsh 接入 Spike（ACP vs SDK） | T0.2 | [ ] | 可与 T0.4、T0.5 并行 |
| T0.4 | Paseo 架构研读 | T0.2 | [ ] | 可并行 |
| T0.5 | OpenWork 架构研读 | T0.2 | [ ] | 可并行 |
| T0.6 | 首批 ADR 定稿 | T0.3–T0.5 | [ ] | |
| **M1** | **契约先行** | | | |
| T1.1 | 领域模型 v0 | T0.6 | [ ] | |
| T1.2 | Host API v0（protocol 包） | T1.1 | [ ] | |
| T1.3 | AgentRuntimeAdapter 接口 + 契约测试 + echo 适配器 | T1.1 | [ ] | 可与 T1.2 并行 |
| **M2** | **Local Agent Host 核心** | | | |
| T2.1 | storage：SQLite schema 与迁移 | T1.2 | [ ] | |
| T2.2 | 事件库与回放 | T2.1 | [ ] | |
| T2.3 | 会话管理器与审批状态机 | T2.2, T1.3 | [ ] | |
| T2.4 | WebSocket JSON-RPC 服务 | T2.3 | [ ] | |
| T2.5 | Host 进程入口与运行时文件 | T2.4 | [ ] | |
| **M3** | **dsh 适配器** | | | |
| T3.1 | dsh 进程管理（定位、启动、独立 DSH_HOME） | T2.5 | [ ] | |
| T3.2 | ACP → Wevir 事件映射 | T3.1 | [ ] | |
| T3.3 | 审批桥接 | T3.2 | [ ] | |
| T3.4 | Provider 配置桥接 | T3.1 | [ ] | 可与 T3.2 并行 |
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

**T0.6 首批 ADR 定稿**
- `docs/adr/0001-runtime-integration.md`：dsh 接入路径（依据 T0.3）。
- `docs/adr/0002-host-transport-and-process-model.md`：JSON-RPC over WebSocket，监听 127.0.0.1 随机端口 + Bearer token；骨架阶段 Host 由桌面端拉起、随桌面退出，但 Host 代码独立可运行，为将来常驻 daemon 留路（依据 T0.4）。
- `docs/adr/0003-storage.md`：`better-sqlite3` vs `node:sqlite`（考虑 Electron 原生模块重编译）。
- `docs/adr/0004-repo-tooling.md`：确认 §1.4 的工具链。
- **Gate M0**：ADR 0001–0004 状态为 Accepted；本文件 §3、§6 已按 Spike 结论更新。

### M1 — 契约先行

**T1.1 领域模型 v0**
- 实体：`Workspace`、`ProviderProfile`、`Session`、`ApprovalRequest`、`WevirEvent`；预留但不实现：`Task`、`Artifact`、`Device`。
- 明确划分：哪些是产品层实体（Wevir 拥有），哪些只是引擎事实的投影。
- 会话状态机：`idle → running ⇄ awaiting_approval → cancelling → idle`，以及 `error`、`closed`。
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
- 方法 v0：`host.hello`（版本协商，携带 `clientKind`、`deviceId`）、`workspace.list/add/remove`、`provider.list/upsert/remove/test`、`session.create/list/get/send/cancel/close/resume`、`approval.respond`、`events.subscribe(sessionId, sinceSeq)` / `events.unsubscribe`。
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
- 产出：接口包 + 一套与实现无关的**契约测试套件** + `EchoAdapter`（假引擎：回显文本、按关键词模拟一次工具调用和一次审批），让 M2 不依赖 dsh 就能开发。
- **Gate M1**：EchoAdapter 通过契约测试；protocol 包有完整 schema 测试。

### M2 — Local Agent Host 核心

**T2.1 storage**：表 `workspaces`、`provider_profiles`（不含密钥，只存 `secretRef`）、`sessions`、`events`（追加写，`(session_id, seq)` 唯一）、`approvals`；手写 SQL 迁移 + 版本表。骨架阶段密钥存独立文件（权限 0600），在 ADR-0003 记录“后续迁移到系统钥匙串”。

**T2.2 事件库与回放**：原子分配 seq；`append`、`readSince(sessionId, seq)`；从事件推导会话快照（状态、标题、最后消息时间）；Host 重启后状态一致。

**T2.3 会话管理器**：Wevir Session ↔ 引擎 Session 映射；状态机落地；审批幂等（同一 `requestId` 首个决定生效，之后的响应返回 `already_decided` 和既有决定，并记录决定来自哪个 `deviceId`）；引擎崩溃时会话转 `error` 并保留历史。

**T2.4 RPC 服务**：`ws` 监听 127.0.0.1 随机端口；首帧 `host.hello` 校验 token 与协议版本；`events.subscribe` 先补发 `sinceSeq` 之后的历史，再无缝切换到实时（不能丢、不能重）；多个客户端同时订阅同一会话。

**T2.5 Host 进程入口**：`wevir-host` 可执行入口；数据目录（macOS `~/Library/Application Support/Wevir`，Windows `%APPDATA%\Wevir`，`WEVIR_HOME` 覆盖，开发模式 `./.wevir-dev`）；运行时文件 `run/host.json`（pid、port、token、protocolVersion，权限 0600）；结构化日志；优雅退出。
- **Gate M2**：使用 EchoAdapter，用一个最小测试客户端完成：建会话 → 发消息 → 收流式事件 → 审批 → 取消 → 杀掉 Host → 重启 → 回放全部历史。

### M3 — dsh 适配器

**T3.1 进程管理**：`adapter-dsh` 精确锁定 dsh 版本；解析 dsh 可执行入口；为 Wevir 准备独立 `DSH_HOME`（`<数据目录>/engines/dsh`）；启动 `dsh --profile acp`；initialize 超时与 stderr 尾部诊断；崩溃后的重启策略；`dispose` 时可靠回收进程。

**T3.2 事件映射**：ACP `session/update` 各类型 → `AgentEvent`；未识别类型映射为 `engine.raw` 保留下来，不丢弃；映射表写入 `docs/architecture/acp-event-mapping.md`。

**T3.3 审批桥接**：`session/request_permission` → `ApprovalRequest` 事件 → 等待 `approval.respond` → 回复 ACP；处理超时、取消与审批交错、Host 重启时未决审批的处理（标记为 `expired`）。

**T3.4 Provider 桥接**：`ProviderProfile` → dsh 配置 overlay（`baseURL`、协议、模型列表、`apiKeyEnv`）；密钥仅通过子进程环境变量传入；首批支持 DeepSeek 官方 + OpenAI 兼容（覆盖通义、Kimi、智谱等国内服务）；`provider.test` 做一次最小请求验证。

**T3.5 会话恢复**：`session.resume` → ACP `session/resume`；界面历史始终来自 Wevir 事件库；记录 resume 前后上下文差异（与 T0.3 的发现对照）。

**T3.6 适配器契约测试**：同一套 T1.3 契约测试跑 dsh 适配器；真实模型测试由环境变量开关（无 Key 时跳过）；另用 T0.3 录制的样本做离线回放测试，保证 CI 不需要模型 Key。
- **Gate M3**：契约测试全绿；升级 dsh 时的检查清单写入 `docs/upstream/UPSTREAM.md`。

### M4 — 竖切联通：CLI

**T4.1 client-sdk**：连接（读取 `run/host.json` 或显式地址）、`host.hello`、类型安全的请求、订阅、断线自动重连并带 `sinceSeq` 续传、请求超时。

**T4.2 `wevir` CLI**：`wevir host start|status|stop`、`wevir workspace add <path>`、`wevir provider add`、`wevir session new -w <path> "<prompt>"`、`wevir session list`、`wevir session attach <id>`（实时输出、交互式审批、Ctrl-C 取消）。
- **Gate M4（第一次真正可用）**：真实 dsh + 真实模型，完成 §4.2 第 8 条的多步骤文件任务；两个 CLI 同时 attach 看到同一事件流；重启 Host 后历史完整、可继续对话。

### M5 — 桌面壳

**T5.1 Electron 壳**：主进程负责发现或拉起 Host，把连接信息通过 preload 交给渲染进程；`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；渲染进程只通过 client-sdk 与 Host 通信，不直接读写文件和数据库。

**T5.2 设计 Token 与布局骨架**：Wevir 自己的颜色、字号、间距、圆角 Token（亮/暗两套）；三栏布局：左侧工作区与会话列表、中间对话、右侧面板占位（将来放文件、Diff、成果）。参考 OpenWork 的信息架构，不复制其视觉。

**T5.3 会话视图**：流式消息渲染（Markdown + 代码块）；可折叠的工具调用卡片（名称、参数摘要、状态、结果）；审批卡片（允许/拒绝，显示请求内容）；取消按钮；会话状态指示；输入框（Enter 发送、Shift+Enter 换行）。

**T5.4 设置**：Provider 增删改 + 测试连接；工作区添加（系统文件夹选择器）与移除；中文为默认语言，文案集中管理，为 i18n 留口。

**T5.5 恢复与重连**：应用重启后恢复会话列表与当前会话；Host 断开时显示状态并自动重连，重连后按 `sinceSeq` 补齐。
- **Gate M5**：§4.2 第 1–7 条全部通过（手动验收，录屏或截图存档到 `docs/research/skeleton-acceptance/`）。

### M6 — 骨架收尾

- **T6.1** `docs/development.md`：环境要求、启动、调试、大陆镜像（npm registry、`ELECTRON_MIRROR`、GitHub 镜像）。
- **T6.2** GitHub Actions：macOS + Windows 上 lint、typecheck、test（可提前到 M1 做）。
- **T6.3** 检查所有移植文件的来源头部与 `UPSTREAM.md` 登记；生成 `NOTICE`。
- **T6.4** 复盘：更新本文件，产出 `docs/PHASE1_PLAN.md`（终端、Git Diff、文件预览、Skills/MCP 管理、手机端准备）。
- **Gate M6**：§4.2 全部九条通过。

---

## 7. 骨架阶段明确不做

- 手机 App、远程中继、设备配对（协议里只预留 `deviceId` / `clientKind`）。
- Tauri、Linux 安装包、自动更新、代码签名与公证。
- 多 Agent 并行、Git worktree。
- 长期记忆、办公成果生成、插件 SDK、模型故障转移路由。
- 终端面板、Git Diff、文件预览（Phase 1 第一批）。
- 整体 fork OpenWork 或 Paseo；修改 dsh 源码（确有必要时用补丁文件并登记）。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| dsh 预览版不兼容变更 | 精确锁版本；只有 `adapter-dsh` 接触 dsh；契约测试 + 录制样本；升级检查清单 |
| ACP 不回放历史、无终端/计划/todo 等富信息 | 历史由 Wevir 事件库负责；富信息在 Phase 1 评估：ACP `_meta` 扩展、自写 Cordis 插件补发事件，或切换到 SDK/Web RPC |
| ACP 只支持一个主 workspace | 骨架阶段一个会话对应一个工作区目录，足够；多目录在后续阶段评估 |
| 引擎生命周期归属冲突 | dsh 进程只由 `adapter-dsh` 管理；Host 是唯一调度者；不引入 Paseo daemon 或 OpenWork server 作为第二套执行体系 |
| 许可证混用 | `ee/` 全部排除；Paseo 许可证在 T0.2 核实；移植文件逐个登记 |
| 大陆网络 | 镜像可配置；CI 与本地均验证一次镜像安装路径 |
| 密钥泄露 | 密钥只在 Host 内存与 0600 文件中；日志脱敏；后续迁移系统钥匙串 |
| Electron 原生模块（SQLite） | ADR-0003 先做选择；如选 `better-sqlite3`，在 T5.1 处理重编译 |

---

## 9. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-10-12 | v0.1 初稿：基于调研结论与 dsh / OpenWork / Paseo 当前仓库核实 |
| 2026-10-12 | T0.1：§2.2 引擎边界补充“不得声明依赖”与 `spikes/` 豁免（产品代码不得反向引用 spikes/） |
