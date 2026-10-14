# Codex app-server → Wevir 事件映射

> 状态：v0.1（R2：进程、握手、配置、会话、回合与流式事件；审批、取消的兜底、恢复、计划与错误归类由 R3 补）· 日期：2026-10-14
> 依据：[ADR-0005](../adr/0005-agent-runtime-and-model-gateway.md) 决策 1、2、5、6、7 与补记（R2 的偏离见补记 5）；[Codex 研读与 Spike](../research/codex-notes.md) §2、§3.1、§3.3、§6、§10；[领域模型](./domain-model.md) §6、§7；[模型协议网关](./model-gateway.md)
> 代码：`packages/adapter-codex/src/`（`paths.ts`、`env.ts`、`config.ts`、`prompts.ts`、`protocol.ts`、`codex-process.ts`、`mapping.ts`、`tool-display.ts`、`codex-adapter.ts`）
> 样本：`packages/adapter-codex/src/test-fixtures/app-server/*.jsonl`，真实 `codex-app-server`（`rust-v0.162.1`）+ 网关 + mock 模型录的通知序列，录制方法见同目录的 README.md

本文件写 Codex 引擎（`codex-app-server`）怎样被 Wevir 驱动，以及它的通知怎样变成 `AgentEvent`（`packages/runtime-adapter/src/events.ts`），Host 再照 domain-model.md §6 写成 `WevirEvent`。协议类型以锁定提交下的 `upstream/codex/codex-rs/app-server-protocol/schema/typescript/`（及 `v2/`）为准，本包用到的子集手写在 `protocol.ts`，每个类型注明对应的 schema 文件。只用稳定面（`experimentalApi: false`）。

## 0. 事件路径

```text
codex-app-server stdout（逐行 JSON，不带 "jsonrpc"）
  ├─ 响应 ──▶ CodexProcess 按 id 配对 ──▶ request() 的结果（thread/start、turn/start、turn/interrupt、thread/unsubscribe）
  ├─ 服务端请求（审批等）──▶ CodexAdapter：R2 一律回复 decline / 不支持（§6.6）
  └─ 通知（按写出顺序同步交付）──▶ CodexAdapter 按 threadId 路由
        ├─ 挂着的会话 ──▶ 会话的 CodexEventMapper（mapping.ts）──▶ EventHub ──▶ subscribe()
        ├─ 子 thread ──▶ 父会话的 engine.raw（kind: child_thread，增量丢弃，§6.5）
        └─ 其余 ──▶ 告警一次后丢弃（thread/started、thread/status/changed 不告警）
进程退出 / 有计划的重启 ──▶ 每个挂着的会话一条 engine.exited，订阅结束
```

通知在响应之前交付：同一条流里 `turn/start` 的结果兑现时，它之前的通知都已映射。Host 在调用 `send` 之前就建好回合（session-manager.ts），所以 `turn/start` 的结果到达之前的通知也能归到这个回合，适配器不缓存。

## 1. 进程

### 1.1 二进制与版本

- 锁定 `CODEX_VERSION = 'rust-v0.162.1'`（`paths.ts`），与 `docs/upstream/upstream.lock` 的 codex 行、`scripts/fetch-codex.sh` 一致。
- 解析顺序（`resolveCodexBinary`）：环境变量 `WEVIR_CODEX_BIN`（必须是存在的绝对路径）→ 开发缓存 `<仓库>/.wevir-dev/bin/codex-app-server[.exe]`（`bash scripts/fetch-codex.sh` 下载，6 个平台的资产名与 sha256 写在脚本里）。不查 PATH，不碰用户自己装的 Codex。打包后的位置由 R9 定。
- Host 以 `--adapter codex` 构造适配器时就解析路径，找不到即启动失败并给出下载命令；第一次启动进程之前跑 `codex-app-server --version`，输出（`codex-app-server 0.162.1`）与锁定版本不一致就启动失败（`engine_unavailable`，说明锁定的版本）。

### 1.2 目录与环境

- `CODEX_HOME = <数据目录>/engines/codex`（0700，事先建好），进程的 cwd 也是它，不是用户工作区。里面除了 Wevir 生成的 `config.toml` 与 `wevir-models.json`，都是 Codex 自己写的（`sessions/` 下的 rollout、7 个 SQLite 库、`installation_id`、`shell_snapshots/` 等，codex-notes §2.5）。
- 环境按白名单构造（`env.ts`，与 adapter-dsh 同一套做法）：PATH、HOME、用户与区域、临时目录、代理与 CA（含 `SSL_CERT_FILE`、`SSL_CERT_DIR`），以及 Windows 的系统变量；固定注入 `CODEX_HOME`、`WEVIR_GATEWAY_TOKEN`（网关令牌，§5.1）、`RUST_LOG=warn`、`NO_COLOR=1`。用户 shell 里的 `OPENAI_API_KEY`、`CODEX_API_KEY`、`CODEX_ACCESS_TOKEN`、`CODEX_SQLITE_HOME` 等不继承。模型 Key 不进 Codex 的环境。
- 启动参数只有 `--strict-config`（配置里有不认识的键就启动失败）。POSIX 上 detached（自成进程组，回收时信号发给整个组），Windows 上不分离。

### 1.3 用户级目录：只有 `~/.agents/skills`，关掉 skills 列表

`HOME` 用用户真实的家目录：模型跑的命令要用 git 等用户配置，而 Codex 给命令建环境时会用登录 shell 读用户的 rc 做快照（`shell_snapshots/`），rc 里的 PATH 等只有这样才能带上。R2 在锁定提交里查了 Codex 在 `CODEX_HOME` 之外读的用户级位置（`dirs::home_dir()` 的调用方）：

| 位置 | 谁读 | 处理 |
|---|---|---|
| `~/.agents/skills/` | skills 扩展（`ext/skills/src/host_roots.rs`），用户级 skill 根 | **会进上下文**：R2 实测，真实 HOME 下用户给别的工具装的 skills 全部列在模型的 `<skills_instructions>` 里。config 里 `[skills] include_instructions = false`（列表不进上下文）与 `[skills.bundled] enabled = false`（不往 CODEX_HOME 装内置 skills）。base.md 也写的是“skills 列表现在为空” |
| `~/.agents/plugins`、`~/.cache` | 插件市场（`core-plugins`） | `features.plugins = false`，不读 |
| `/etc/codex/`（config、skills、requirements） | 系统级配置层 | 管理员级配置，不是用户级；Wevir 不覆盖，写在这里备查 |
| `~/.codex` | Codex 的默认 CODEX_HOME | 设了 `CODEX_HOME` 就不用 |

没有像 dsh 的 `DSH_AGENTS_HOME` 那样的变量能把 `~/.agents` 指到别处。取舍（维护者交给实现方定，ADR-0005 补记 6）：

- **静默进入的路径关掉**：skills 列表不进上下文，这是用户没有察觉就会发生的那条路。Codex 的 skill 检索实验（`features.skill_search`，默认开）只在本机给 skills 打分、记指标，不进上下文、不联网（`ext/skills/src/shadow_selection_experiment/`），不另外关。
- **显式点名照 Codex 的语义生效**：用户在消息里写 `$<skill 名>`（或 `[$名字](路径)`）时，Codex 把那个 skill 放进上下文（`collect_explicit_skill_mentions`，只选启用的 skill；`$PATH` 这类常见环境变量名不算）。这是用户有意的动作，用的是 Codex 公开的写法；`~/.agents/skills` 又是多个 Agent 共用的标准位置，用户点名时多半就是想用它。挡住它要 Wevir 自己照 Codex 的发现规则枚举 skills 再逐个写禁用规则，规则一变就漏，运行中新装的 skill 也挡不住，代价大于收益。
- **不换 HOME**：只给 app-server 换一个 Wevir 专属的 HOME、再用 `[shell_environment_policy] set = { HOME = "<真实家目录>" }` 把命令的 HOME 改回来，能让 skills 不被扫描，但 Codex 的 shell 快照用 app-server 自己的环境跑登录 shell（`core/src/shell_snapshot.rs` 的 `run_script_with_timeout`），读不到用户的 rc，命令的 PATH 少了 rc 里加的条目（R2 实测本机 20 条变 18 条）。Windows 上 Codex 找家目录不读环境变量（`dirs::home_dir`），这个办法本来也不成立。
- **以后**：Wevir 做 skills 管理时，用 `[[skills.config]]`（按路径或名字启用 / 禁用，Codex 的 `SkillConfig`）把用户在设置里的选择交给 Codex，再打开 `include_instructions`；`~/.agents/skills` 里的 skills 是否默认可见在那时定。

回归测试：`codex-adapter.isolation.integration.test.ts` 用测试专用的 HOME 放一个 canary skill，断言普通回合的请求里没有它、显式写 `$wevir-canary` 的回合里有它的正文（反例：打开 `include_instructions` 时第一条断言失败）。

### 1.4 回收与重启

`codex-process.ts` 照 adapter-acp 的 `AcpProcess` 写：

- 第一个会话（`createSession`）时启动；`dispose` 关 stdin → SIGTERM → SIGKILL（每步 2 s / 1.5 s / 1 s），进行中的请求以 `disposed` 失败，不发 `engine.exited`。
- 意外退出：每个挂着的会话一条 `engine.exited`（退出码、信号、stderr 尾部），订阅结束；之后自动重启，最多连续 3 次（500 ms 起指数退避，就绪后稳定运行 60 s 计数清零），用完停在 `failed`，下一次 `createSession` 再试。
- 有计划的重启（模型目录变了，§5.2）：先让挂着的会话以 `engine.exited`（`reason: 'config_changed'`）脱开，再回收旧进程、启动新进程。
- 脱开的会话要 `resumeSession` 才能接回；R2 的 `resumeSession` 报 `session_unavailable`（Host 记一条引擎错误、不标只读），`thread/resume` 由 R3 实现。

## 2. 握手

`initialize { clientInfo: { name: 'wevir', title: null, version: <Host 版本> }, capabilities: { experimentalApi: false, requestAttestation: false } }`，15 s 内没有响应算启动失败；随后发通知 `initialized`。`clientInfo.name` 会成为发给模型服务的 `originator` 与 User-Agent 前缀（实测 `userAgent` 是 `wevir/0.162.1 (Mac OS …; arm64) unknown (wevir; <Host 版本>)`），网关透传时剥掉（model-gateway.md）。

## 3. 配置

每次启动进程之前重写（`config.ts`），文件 0600，不含任何 Key 或令牌：

| 项 | 值 | 依据 |
|---|---|---|
| `approval_policy` / `sandbox_mode` | `on-request` / `workspace-write` | 决策 5 |
| `approvals_reviewer` | `user`（默认值，写出来防默认变化） | 决策 5：不开 auto_review |
| `check_for_update_on_startup` | `false` | 决策 5 |
| `web_search` | `disabled` | 决策 5 |
| `[analytics] enabled` | `false` | 决策 5 |
| `[features] plugins / goals / memories` | `false` / `false` / `false` | 决策 5（plugins 是唯一产生外连的开关）、补记 1（goals）、决策 5（memories 默认就关） |
| `[tools.update_plan] enabled` | `true` | 决策 5（计划默认关） |
| `[skills] include_instructions`、`[skills.bundled] enabled` | `false`、`false` | §1.3 |
| `[shell_environment_policy]` | `ignore_default_excludes = false`，`exclude = ["WEVIR_*"]` | 决策 5：命令看不到令牌 |
| `model` / `model_provider` | 第一个 Provider 的默认模型 / `wevir_<id>`（没有 Provider 时不写） | 会话总在 `thread/start` 里指定自己的；这只是不让进程落到 OpenAI 的默认 Provider |
| `model_catalog_json` | `<CODEX_HOME>/wevir-models.json`（没有模型时不写：Codex 拒绝空目录） | 决策 5 |
| `[model_providers."wevir_<id>"]` | `name = "Wevir/<显示名>"`、`base_url = <网关>/v1/p/<id>`、`wire_api = "responses"`、`env_key = "WEVIR_GATEWAY_TOKEN"` | 决策 2.2；名字加前缀，避免恰好叫 `OpenAI` 被当成 OpenAI 自己的 Provider（codex-notes §6.4） |

**模型目录**：Provider 的每个模型一条，按 slug 去重（Codex 按 slug 精确查找，同名模型以先出现的 Provider 为准）。字段与 Codex 给未知模型的默认元数据一致（`model_info_from_slug`），另外：`apply_patch_tool_type: "freeform"`（否则没有 apply_patch 工具）、`context_window`（Provider 给了才写）、`supported_reasoning_levels`（Wevir 的推理档位，`off` 换成 Codex 的 `none`）、`input_modalities`（`supportsImages` 时加 image）、`include_apps_usage_instructions: false`、`visibility: "list"`，以及必填的 `base_instructions`。

**基础提示词**：`prompts/base.md`（补记 2），按 prompts/README.md 的模板语法渲染（先删 HTML 注释，再展开 `{{> }}` 与变量 `model_display_name`、`provider_display_name`，结果残留 `{{` 就报错）。写进模型目录的 `base_instructions`，并在 `thread/start` 的 `baseInstructions` 里按会话自己的 Provider 与模型再给一次（目录里同名模型只有一条，显示名可能是别的 Provider 的）。ChatGPT 登录的 OpenAI 模型（R6）不覆盖。提示词目录默认是仓库的 `prompts/`（`CodexAdapterOptions.promptsDir`，打包后的位置由 R9 定）。

## 4. 会话与回合

| Wevir | Codex | 说明 |
|---|---|---|
| `createSession` | `thread/start { cwd, model, modelProvider: 'wevir_<id>', approvalPolicy: 'on-request', sandbox: 'workspace-write', baseInstructions, config }` | `threadId` 即 `engineSessionId`；`config` 是按点分路径的覆盖：`model_providers.wevir_<id>`（这个会话的 Provider 条目，§5.2）、`model_context_window`（Provider 给了上下文大小时）、`model_reasoning_effort`（会话给了推理强度时）。返回 `modelId`（`thread/start` 结果的 `model`）、`reasoningEffort`（`none` 换回 `off`）、`engineVersion = CODEX_VERSION`。Provider 或模型不在配置里报 `invalid_input` |
| `send` | `turn/start { threadId, input: [{ type: 'text', text, text_elements: [] }] }` | 立即返回（引擎接受输入即返回，正好是 `send` 的语义）。回合结果看 `turn/completed` |
| `cancel` | `turn/interrupt { threadId, turnId }` | 等回合结算（Spike 4–7 ms），4 s 内等不到报 `cancel_unconfirmed`。R3 补：那时重启进程让会话可以恢复 |
| `close` | 先 `cancel`，再 `thread/unsubscribe { threadId }` | 语义（`thread_processor.rs` 的 `thread_unsubscribe_response_inner` 与 `thread_lifecycle.rs`）：本连接不再收这个 thread 的通知；thread 没有订阅者且空闲满 `thread_unload_delay_secs`（默认 60 s）后才卸载，rollout 留在磁盘上，之后可以 `thread/resume`（R3）。返回 `notLoaded` / `notSubscribed` 都按成功处理；失败只告警，不阻止关闭 |
| `resumeSession` | — | R3（`thread/resume`）。R2 对没挂着的会话报 `session_unavailable` |
| `listPendingApprovals` / `respondToApproval` | — | R3。R2 没有未决审批（§6.6） |

## 5. Provider

### 5.1 网关实例与令牌

所有 Provider 都经网关（决策 2.2，Responses 原生的也不例外）。网关实例由 adapter-codex 在 Host 进程里创建并持有：**每次启动 codex-app-server 新建一个**（监听 127.0.0.1 的随机端口），令牌随实例生成、只在内存，经 `WEVIR_GATEWAY_TOKEN` 交给这个进程，这就是决策 2.2 的“每次启动 Codex 进程时随机生成”（补记 3 留给 R2 的选择）。旧进程停了之后它的网关一起关掉。令牌经 Host 日志的 `addSecret` 登记，出现在日志里会被抹掉。

### 5.2 `configureProviders`：先核实，能不重启就不重启

R2 实测（真实二进制）：

- `thread/start` 的 `config` 覆盖**能**带上进程启动之后新增的 `model_providers.<id>` 条目：请求确实发到了新 Provider 的 `base_url`。
- 但模型目录只在进程启动时读一次：`config` 里覆盖 `model_catalog_json` 没有效果，新模型拿到的是未知模型的默认元数据（没有 apply_patch、Codex 自己的 prompt.md、272k 上下文）。`baseInstructions` 与 `model_context_window` 能按 thread 覆盖，`apply_patch_tool_type` 与推理档位不能。

所以规则是：

1. 新的一整套 Provider 立即交给运行中的网关（`setProviders`，进行中的请求用开始时的配置）。上游地址、Key、协议、compat 的变化到此为止，不需要动 Codex（`base_url` 只取决于 Provider ID）。
2. 每个会话的 Provider 条目总在 `thread/start` 的 `config` 里带上，新增的 Provider 不需要重启。
3. 只有**模型目录**变了（新增或删除模型、上下文大小、推理档位、显示名或 Provider 显示名变了）才重启：没有回合、没有进行中的 `createSession` 时立即重启（返回时新进程已就绪）；有回合时等最后一个回合结束；挂着的会话以 `engine.exited`（`config_changed`）脱开。与 dsh 的做法相同。
4. 不合法的 Provider（见 §5.3）抛 `invalid_input`，什么都不改。

### 5.3 `validateProvider` 与 `testProvider`

- `validateProvider`：网关的检查（`@wevir/model-gateway` 的 `validateProvider`：协议、地址、网关自己的 compat 开关），加上模型列表不能为空。Host 在 `provider.upsert` 写库之前调用。
- `testProvider`：网关的 `testProvider`，用与正式请求相同的处理方式发一次最小请求（决策 2.5）。不需要 Codex 进程在运行。
- 网关的两个 compat 开关（`supportsCustomTools`、`systemMessageMode`）协议 0.4.0 起是 `ProviderCompat` 的字段（ADR-0005 补记 7），随 Provider 原样交给网关；集成测试里 `supportsCustomTools: false` 时 Codex 的 apply_patch 摊平成函数，补丁照常生效。

## 6. 事件逐条映射（`mapping.ts`）

一个会话一个 `CodexEventMapper`，回合开始时清空 item 状态。输入是原始通知参数，不做 schema 校验，只检查要读的字段；对不上的整条保留为 `engine.raw`（`protocol: 'codex-app-server'`，`method` 原样，item 通知的 `kind` 是 item 类型）。

### 6.1 通知

| Codex 通知 | AgentEvent | 说明 |
|---|---|---|
| `item/agentMessage/delta` | `assistant.delta`（`kind: 'text'`） | `attemptId` = itemId，`blockIndex` 0 |
| `item/reasoning/textDelta` | `assistant.delta`（`kind: 'reasoning'`） | `attemptId` = itemId，`blockIndex` = `contentIndex`。原始推理默认就透出（codex-notes §2.2） |
| `item/reasoning/summaryTextDelta` | `assistant.delta`（`kind: 'reasoning'`） | `attemptId` = `<itemId>/summary`，`blockIndex` = `summaryIndex` |
| `item/started` / `item/completed` | 见 §6.2 | |
| `item/commandExecution/outputDelta`、`item/mcpToolCall/progress` | `tool.updated`（`output` 是到目前为止的累积） | 短命令可能一条都没有，输出只在 `item/completed` 的 `aggregatedOutput` |
| `item/fileChange/patchUpdated` | `tool.updated`（新的 `display` 与 `input`） | |
| `thread/tokenUsage/updated` | `usage.updated` | `contextUsed` = `tokenUsage.last.totalTokens`（codex-notes §2.7 的口径）；`contextSize` = 模型目录的 `context_window`（Provider 的 `contextWindow`），没有时用 Codex 报的 `modelContextWindow`（那是扣掉 5% 余量的有效窗口），都没有就是 `engine.raw` |
| `turn/completed` | `turn.settled` / `turn.failed` | `completed` → settled（`completed`），`interrupted` → settled（`cancelled`），`stopReason` 是 Codex 的状态原文；`failed` → `turn.failed`，`message` = `turn.error.message` + `additionalDetails`，`category` R2 一律 `unknown`（按 `codexErrorInfo` 与上游状态码归类是 R3）。之前先收尾没提交的增量（§6.4） |
| `error` | `engine.raw` | `willRetry: true` 不算回合失败（Codex 自己也只在状态栏短暂显示），已经流出的增量以 `abandoned` 结束；`willRetry: false` 随后有 `turn/completed`（failed），以它为准 |
| `turn/started`、`item/reasoning/summaryPartAdded`、`thread/status/changed`、`thread/started` | （无） | 按设计忽略：Host 自己写 `turn.started`、维护会话状态；块号已在增量里 |
| `turn/diff/updated`、`turn/plan/updated`、`thread/name/updated` 等其余带 threadId 的 | `engine.raw` | `turn/plan/updated` → `todo.updated` 是 R3 |
| 不带 threadId 的（`account/*`、`remoteControl/*`、`mcpServer/*` 等） | （无） | `warning`、`configWarning`、`deprecationNotice` 写一次告警，其余忽略（codex-notes §6.4） |

不属于进行中回合的通知（没有回合，或 `turnId` 是别的回合）：用量照常映射，其余一律 `engine.raw`（events.ts 的顺序约定：回合之间只有 `engine.raw` 与 `engine.exited`）。

### 6.2 item

| item 类型 | `item/started` | `item/completed` |
|---|---|---|
| `agentMessage` | （无） | `assistant.message`（`messageId` = itemId，`replaces` 是它的全部增量块）+ 每个增量流一条 `assistant.stream_ended`（`committed`）。没有增量且文本为空时不发 |
| `reasoning` | （无） | `assistant.thought`，文本是原始推理（`content`），没有时用摘要（`summary`）；`replaces` 与 `stream_ended` 同上 |
| `commandExecution`、`fileChange`、`mcpToolCall`、`dynamicToolCall`、`collabAgentToolCall`、`webSearch`、`imageView` | `tool.started`（`toolCallId` = itemId，`input` 是原样的 item，`toolName` 与 `display` 见 §6.3） | 展示变了先发 `tool.updated`，再 `tool.finished`：`completed` → completed，`failed` / `declined` / `interrupted` → failed（`declined` 先映射为 failed，拒绝的语义由审批事件承担，决策 6.2）。没有 `item/started` 时先补一条 `tool.started` |
| `userMessage` | （无） | （无）：Host 自己记 `user.message` |
| 其余（`plan`、`contextCompaction`、`hookPrompt`、`subAgentActivity` 等） | `engine.raw` | `engine.raw` |

`tool.finished.output`：命令是 `aggregatedOutput`（没有时用累积的增量）；文件改动是各个 diff 相连；MCP 是结果或错误的 JSON；动态工具是文本内容；子 agent 是 `agentsStates` 的 JSON。

### 6.3 工具的展示类型（`tool-display.ts`）

Codex 的 item 自带类型，命令还有解析好的 `commandActions`，不必像 dsh 那样按工具名猜（domain-model.md §7）。只读、列目录、搜索的命令归为 read / search，与桌面端把连续的读取 / 搜索合并成一组的规则（`tool-model.ts`）对上，也与 Codex 终端界面的“探索”单元一致。

| item | `toolName` | `display.kind` | 其余字段 |
|---|---|---|---|
| `commandExecution`，`commandActions` 全是 `read` | `commandExecution` | `read` | `paths`（各 action 的 path）、`command` |
| `commandExecution`，全是 read / listFiles / search，且至少一个 listFiles 或 search | `commandExecution` | `search` | `query`（第一个搜索词）、`paths`、`command` |
| `commandExecution`，其余（含 `unknown`、空列表） | `commandExecution` | `shell` | `command` |
| `fileChange`，全是新建 | `fileChange` | `write` | `paths`（移动的取目标路径） |
| `fileChange`，其余 | `fileChange` | `edit` | `paths` |
| `mcpToolCall` | `mcp__<server>__<tool>` | `unknown` | `mcpServer` |
| `dynamicToolCall` | `<namespace>.<tool>` | `unknown` | |
| `collabAgentToolCall` | `collabAgentToolCall.<tool>` | `sub_agent` | `summary` 取任务描述的第一行 |
| `webSearch` | `webSearch` | `search` | `query`（Wevir 关了联网搜索，不会出现） |
| `imageView` | `imageView` | `read` | `paths` |

`item.command` 是 Codex 实际执行的、带 shell 外壳的形式（样本里是 `/bin/zsh -lc 'cat README.md'`）。`display.command` 与 `summary` 去掉 `<sh|bash|zsh> -lc '…'` 外壳；认不出外壳（例如 Windows 的 PowerShell）时，只有一个解析出的动作就用它的命令，否则原样。`input` 里保留原样。

### 6.4 增量与已提交消息

Codex 的增量与已提交项共用 itemId，对齐是直接的，不需要 adapter-dsh 的 `DeltaMerger`：每个 agentMessage / reasoning item 是一个 attempt，`item/completed` 时提交消息替换它全部的增量块并结束流。

取消或出错发生在流式中途时，已发出的增量没有 `item/completed`（codex-notes §2.2，样本 `cancel.jsonl`）。`turn/completed` 时这些增量：含非空白字符的按已提交消息补发（`assistant.message` / `assistant.thought` + `stream_ended committed`），保留已经显示的输出，与 dsh 取消时一次性补发已生成部分的做法一致；只有空白的以 `abandoned` 结束。`error` 带 `willRetry: true` 时 Codex 会重发整个请求，已流出的增量以 `abandoned` 结束，不再补发。

### 6.5 子 thread（子 agent）

子 agent 是独立的 thread，它的通知自动推到同一连接（codex-notes §2.4）。R2 从父会话 `collabAgentToolCall` item 的 `receiverThreadIds` 记下子 thread → 父会话，子 thread 的通知作为父会话的 `engine.raw`（`kind: 'child_thread'`）上报，增量（方法名以 delta 结尾）丢弃，免得把逐字增量写满事件库。子 thread 的第一条通知（`thread/status/changed`）早于父会话的 `item/completed`，这时还不认识它，按设计丢弃。样本 `subagent.jsonl` 里父回合在子 thread 的回合之前结束，所以子 thread 的事件多数落在父会话的回合之间。R4 改为子会话。

### 6.6 服务端请求

| 请求 | R2 的回复 |
|---|---|
| `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` | `{ decision: 'decline' }`，会话里留一条 `engine.raw`（`kind: 'server_request'`），日志告警一次。工作区内的补丁与沙箱内的命令不需要审批（codex-notes §2.3），只有越出沙箱的操作会被拒绝。R3 实现审批 |
| 其余（`item/tool/requestUserInput`、`item/permissions/requestApproval`、`mcpServer/elicitation/request` 等） | JSON-RPC 错误 `-32601`（Wevir 不支持） |

## 7. 测试

| 层 | 文件 | 内容 |
|---|---|---|
| 映射单元测试 | `mapping.test.ts` | 回放 `test-fixtures/app-server/` 的 8 个样本（一问一答、只读 / 搜索 / 普通命令、补丁、上游 400、流式中途取消、子 agent），另有边界情况（`willRetry`、只有空白的增量、摘要与原始推理、`declined`、字段不合预期） |
| 其他单元测试 | `tool-display.test.ts`、`config.test.ts`、`prompts.test.ts`、`env.test.ts`、`paths.test.ts` | 展示类型、生成的配置与模型目录、base.md 渲染、白名单环境、二进制解析与版本核对 |
| 契约测试第 2 层 | `codex-adapter.contract.integration.test.ts` | 真实 `codex-app-server` + 网关（Responses 透传）+ mock 模型跑 `runAdapterContract`，能力开关 `incrementalStream`、`toolCalls`、`concurrentSessions` 开，`approvals`、`resume` 留给 R3 |
| 集成测试 | `codex-adapter.integration.test.ts` | 握手、会话与基础提示词、新增 Provider 不重启、模型目录变了空闲时重启 / 等回合结束、R2 的审批回复、子 thread 的事件、版本核对 |
| 外连、密钥与 skills | `codex-adapter.isolation.integration.test.ts` | 改写自 Spike 的 `network-audit.ts` 与 secrets 场景，另加 §1.3 的 skills 回归：没有 Provider 只启动进程、有 Provider 跑一个带工具调用的回合，经只记录目标的代理与 lsof 看外连为零（反例：打开 plugins 时抓到 chatgpt.com、github.com、api.github.com）；网关令牌与上游 Key 不在数据目录的任何文件、stderr 与日志里；模型跑的命令看不到 `WEVIR_*` |
| Host | `packages/host/src/cli.codex.integration.test.ts` | `wevir-host --adapter codex`：provider.upsert、一问一答、一次工具调用、SIGTERM 回收 |

二进制不在时这些集成测试跳过并打印下载命令；CI 下载并缓存二进制，macOS 与 Windows 都跑。录样本：`WEVIR_RECORD_CODEX=1 pnpm vitest run --project adapter-codex record-app-server`（升级 Codex 后重录，再看映射测试）。

## 8. 留给后续任务

- R3：审批（选项照 codex-notes §2.7，`serverRequest/resolved` 在 `turn/completed` 之后才到）、取消得不到确认时重启、`thread/resume` 与 `session_lost` 的归类、`turn/plan/updated` → `todo.updated`、`turn.failed` 的归类、第 1 层（假 app-server 回放）与第 3 层（真实模型）契约测试、默认引擎改为 codex。
- R4：子 thread 改为子会话（§6.5）。
- R9：打包后二进制与提示词的位置（`binary`、`promptsDir` 选项）。
- `turn/steer`（回合进行中追加输入）：Wevir 目前回合中拒绝新消息（R11）。
