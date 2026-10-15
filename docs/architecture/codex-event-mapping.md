# Codex app-server → Wevir 事件映射

> 状态：v0.4（R2：进程、握手、配置、会话、回合与流式事件；R3：审批、取消的兜底、关闭与恢复、计划、错误归类、会话标题、三层契约测试；R4：子会话；R6：ChatGPT 进程与账号，§8）· 日期：2026-10-14
> 依据：[ADR-0005](../adr/0005-agent-runtime-and-model-gateway.md) 决策 1、2、4、5、6、7 与补记（R2 的偏离见补记 5，R3 的见补记 8，R6 的两个进程见补记 10）；[Codex 研读与 Spike](../research/codex-notes.md) §2、§3.1、§3.3、§6、§10；[领域模型](./domain-model.md) §4.4、§5、§6、§7；[ACP 映射](./acp-event-mapping.md) §1.3、§1.4（Host 一侧的审批与恢复约定，Codex 照用）；[模型协议网关](./model-gateway.md)
> 代码：`packages/adapter-codex/src/`（`paths.ts`、`env.ts`、`config.ts`、`prompts.ts`、`protocol.ts`、`codex-process.ts`、`mapping.ts`、`tool-display.ts`、`turn-error.ts`、`resume-error.ts`、`title.ts`、`subagents.ts`、`codex-adapter.ts`、`account.ts`、`codex-runtime.ts`）
> 样本：`packages/adapter-codex/src/test-fixtures/app-server/`，真实 `codex-app-server`（`rust-v0.162.1`）+ 网关 + mock 模型录的通知序列、审批对话与错误，录制方法见同目录的 README.md

本文件写 Codex 引擎（`codex-app-server`）怎样被 Wevir 驱动，以及它的通知怎样变成 `AgentEvent`（`packages/runtime-adapter/src/events.ts`），Host 再照 domain-model.md §6 写成 `WevirEvent`。协议类型以锁定提交下的 `upstream/codex/codex-rs/app-server-protocol/schema/typescript/`（及 `v2/`）为准，本包用到的子集手写在 `protocol.ts`，每个类型注明对应的 schema 文件。只用稳定面（`experimentalApi: false`）。

## 0. 事件路径

```text
codex-app-server stdout（逐行 JSON，不带 "jsonrpc"）
  ├─ 响应 ──▶ CodexProcess 按 id 配对 ──▶ request() 的结果（thread/start、thread/resume、turn/start、turn/interrupt、thread/unsubscribe）
  ├─ 服务端请求 ──▶ CodexAdapter（§6.6）
  │     ├─ 命令 / 补丁的审批，属于挂着的会话（含子会话）进行中的回合 ──▶ tool.updated（理由）+ approval.requested，等 respondToApproval
  │     ├─ 没有挂着的 thread、不属于进行中回合的 ──▶ 回复 decline
  │     ├─ request_user_input，属于进行中的回合 ──▶ question.requested，等 respondToQuestion（不属于的回空回答）
  │     └─ 其余（MCP 等）──▶ 回复“不支持”
  └─ 通知（按写出顺序同步交付）──▶ CodexAdapter 按 threadId 路由
        ├─ serverRequest/resolved ──▶ 仍未决的审批以 approval.cancelled、未答的提问以 question.cancelled 结束（§6.6）
        ├─ 生成标题的临时 thread ──▶ TitleCollector（§4.4）
        ├─ 挂着的会话（含子会话）──▶ collab item 认出子 agent（§6.5）+ 会话的 CodexEventMapper（mapping.ts）──▶ EventHub ──▶ subscribe()
        ├─ 没认出来的 thread（多半是子 agent）──▶ 先存着，认出后按子会话补上；按 rootTurnId 当场认出（§6.5）
        └─ 其余 ──▶ 告警一次后丢弃（thread/started、thread/status/changed 不告警）
进程退出 / 有计划的重启 ──▶ 每个挂着的会话：未决审批 approval.cancelled（engine_exited），再 engine.exited，订阅结束
```

通知在响应之前交付：同一条流里 `turn/start` 的结果兑现时，它之前的通知都已映射。Host 在调用 `send` 之前就建好回合（session-manager.ts），所以 `turn/start` 的结果到达之前的通知也能归到这个回合，适配器不缓存。

## 1. 进程

R6 起 Host 用的是 `CodexRuntime`（`codex-runtime.ts`）：两个 codex-app-server 进程，各是一个 `CodexAdapter`——**网关进程**（本节到 §7 说的都是它）承载经网关的 Provider，**ChatGPT 进程**承载 ChatGPT 登录（§8）。两者用同一个二进制，各有自己的 `CODEX_HOME`，都在第一次用到时才启动。

### 1.1 二进制与版本

- 锁定 `CODEX_VERSION = 'rust-v0.162.1'`（`paths.ts`），与 `docs/upstream/upstream.lock` 的 codex 行、`scripts/fetch-codex.sh` 一致。
- 解析顺序（`resolveCodexBinary`）：环境变量 `WEVIR_CODEX_BIN`（必须是存在的绝对路径）→ 应用资源目录 `<WEVIR_RESOURCES_DIR>/engines/codex/`（安装包随附的那份，打包后的桌面端拉起 Host 时设这个变量；`pnpm --filter @wevir/desktop resources` 准备，R9，ADR-0007 决策 5）→ 开发缓存 `<仓库>/.wevir-dev/bin/codex-app-server[.exe]`（`bash scripts/fetch-codex.sh` 下载，6 个平台的资产名与 sha256 写在脚本里）。不查 PATH，不碰用户自己装的 Codex。同一目录里要有 `codex-code-mode-host[.exe]`：code mode 的 `exec` 在这个独立进程里跑，codex-app-server 在自己旁边找它；`codex-adapter.code-mode.integration.test.ts` 用 `features.code_mode_only` 检查它在。
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
- 有计划的重启还有一种：取消得不到确认（`cancel_unconfirmed`，§4.1）。
- 脱开的会话要 `resumeSession` 才能接回（`thread/resume`，§4.2）。

## 2. 握手

`initialize { clientInfo: { name: 'wevir', title: null, version: <Host 版本> }, capabilities: { experimentalApi: false, requestAttestation: false } }`，15 s 内没有响应算启动失败；随后发通知 `initialized`。`clientInfo.name` 会成为发给模型服务的 `originator` 与 User-Agent 前缀（实测 `userAgent` 是 `wevir/0.162.1 (Mac OS …; arm64) unknown (wevir; <Host 版本>)`），网关透传时剥掉（model-gateway.md）。

## 3. 配置

每次启动进程之前重写（`config.ts`），文件 0600，不含任何 Key 或令牌：

| 项 | 值 | 依据 |
|---|---|---|
| `approval_policy` / `sandbox_mode` | `on-request` / `workspace-write` | 决策 5 |
| `approvals_reviewer` | `user`（默认值，写出来防默认变化） | 决策 5：不开 auto_review |
| `[windows] sandbox` | `unelevated`（只在 Windows 上写） | ADR-0005 补记 17：没有它时 Codex 在 Windows 上认为没有沙箱，工作区内的命令与补丁也要审批 |
| `check_for_update_on_startup` | `false` | 决策 5 |
| `web_search` | `disabled` | 决策 5：托管搜索由 OpenAI 服务端执行，经网关的模型用不了，custom provider 默认又会把它发给上游；联网改用 `wevir_web`（§6.12）。ChatGPT 会话在 `thread/start` 里按 Wevir 的联网开关改成 `cached` |
| `[analytics] enabled` | `false` | 决策 5 |
| `[features] plugins / goals / memories` | `false` / `false` / `false` | 决策 5（plugins 是唯一产生外连的开关）、补记 1（goals）、决策 5（memories 默认就关） |
| `[features] instant_interrupt` | `false` | R11：插话等这一步结束再进回合（§4.5；这个开关默认开，开着时插话立刻掐断正在流式输出的采样） |
| `[features] default_mode_request_user_input` | `true` | U11：普通回合也给模型 `request_user_input` 工具（默认只在计划模式给），模型可以向用户提问（§6.6）。功能阶段是 UnderDevelopment |
| `suppress_unstable_features_warning` | `true` | U11：开了开发中的功能时，app-server 每个 thread 开头发一条 warning 通知（会成为 `engine.raw`），关掉它 |
| `[tools.update_plan] enabled` | `true` | 决策 5（计划默认关） |
| `[skills] include_instructions`、`[skills.bundled] enabled` | `false`、`false` | §1.3 |
| `[shell_environment_policy]` | `ignore_default_excludes = false`，`exclude = ["WEVIR_*"]` | 决策 5：命令看不到令牌 |
| `model` / `model_provider` | 第一个 Provider 的默认模型 / `wevir_<id>`（没有 Provider 时不写） | 会话总在 `thread/start` 里指定自己的；这只是不让进程落到 OpenAI 的默认 Provider |
| `model_catalog_json` | `<CODEX_HOME>/wevir-models.json`（没有模型时不写：Codex 拒绝空目录） | 决策 5 |
| `[model_providers."wevir_<id>"]` | `name = "Wevir/<显示名>"`、`base_url = <网关>/v1/p/<id>`、`wire_api = "responses"`、`env_key = "WEVIR_GATEWAY_TOKEN"` | 决策 2.2；名字加前缀，避免恰好叫 `OpenAI` 被当成 OpenAI 自己的 Provider（codex-notes §6.4） |

**模型目录**：Provider 的每个模型一条，按 slug 去重（Codex 按 slug 精确查找，同名模型以先出现的 Provider 为准）。字段与 Codex 给未知模型的默认元数据一致（`model_info_from_slug`），另外：`apply_patch_tool_type: "freeform"`（否则没有 apply_patch 工具）、`context_window`（Provider 的 `contextWindow`，没填写 128k，见下文“上下文大小”）、`supported_reasoning_levels`（Wevir 的推理档位，`off` 换成 Codex 的 `none`）、`input_modalities`（`supportsImages` 时加 image）、`include_apps_usage_instructions: false`、`visibility: "list"`，以及必填的 `base_instructions`。

**上下文大小**：模型目录的 `context_window` 与 `thread/start` 的 `model_context_window` 总是写（`contextWindowOf`）：Provider 模型填了 `contextWindow` 用它，没填用 `DEFAULT_CONTEXT_WINDOW`（128k）。模型目录里的模型没有 `context_window` 时 Codex 既不自动压缩，也不报上下文大小（`auto_compact_token_limit()`、`usable_context_window()` 都是 None，`openai_models.rs` 516-540；272k 的兜底只给目录里没有的 slug），只能等上游报超长（`contextWindowExceeded`）。128k 是现在多数模型都有的大小，宁可早压缩；窗口更小的模型（例如默认 4096 的本机 Ollama）要在 Provider 里填真实值，桌面端的 Provider 表单在没填的模型下面提示“未填写，按 128k 估算”。不写 `model_auto_compact_token_limit`：阈值就是窗口的九成。

**基础提示词**：`prompts/base.md`（补记 2），按 prompts/README.md 的模板语法渲染（先删 HTML 注释，再展开 `{{> }}` 与变量 `model_display_name`、`provider_display_name`，结果残留 `{{` 就报错）。写进模型目录的 `base_instructions`，并在 `thread/start` 的 `baseInstructions` 里按会话自己的 Provider 与模型再给一次（目录里同名模型只有一条，显示名可能是别的 Provider 的）。ChatGPT 登录的 OpenAI 模型（R6）不覆盖。提示词目录默认是仓库的 `prompts/`（`CodexAdapterOptions.promptsDir`）；wevir-host 传 `resolvePromptsDir` 的结果：安装包里是资源目录的 `prompts/`（`<WEVIR_RESOURCES_DIR>/prompts/` 有 `base.md` 时，ADR-0007 补记 1），否则是仓库的。

## 4. 会话与回合

| Wevir | Codex | 说明 |
|---|---|---|
| `createSession` | `thread/start { cwd, model, modelProvider: 'wevir_<id>', approvalPolicy: 'on-request', sandbox: 'workspace-write', baseInstructions, config }` | `threadId` 即 `engineSessionId`；`config` 是按点分路径的覆盖：`model_providers.wevir_<id>`（这个会话的 Provider 条目，§5.2）、`model_context_window`（同模型目录的 `context_window`，没填写 128k）、`model_reasoning_effort`（会话给了推理强度时）。返回 `modelId`（`thread/start` 结果的 `model`）、`reasoningEffort`（`none` 换回 `off`）、`engineVersion = CODEX_VERSION`。Provider 或模型不在配置里报 `invalid_input` |
| `send` | `turn/start { threadId, input: [{ type: 'text', text, text_elements: [] }, { type: 'localImage', path }…] }` | 立即返回（引擎接受输入即返回，正好是 `send` 的语义）。回合结果看 `turn/completed`。图片（0.28.0）是 Host 存在数据目录里的文件，Codex 读它、按 `input_image`（data URL，`detail: high`）发给模型；`acceptsImages` 只对标了 `supportsImages` 的模型回答收——目录里只有它们的 `input_modalities` 有 image，别的模型 Codex 会把图片换成占位文字（`core/src/context_manager/normalize.rs`）。ChatGPT 进程的模型列表来自 `model/list` 的 `inputModalities`，不在列表里的交给 Codex 判断。`turn/steer` 的输入同样 |
| `cancel` | `turn/interrupt { threadId, turnId }` | 未决审批先以 `approval.cancelled`（`turn_cancelled`）结束；等回合结算（Spike 4–7 ms），4 s 内等不到就重启进程并报 `cancel_unconfirmed`（§4.1） |
| `close` | 先 `cancel`，再 `thread/unsubscribe { threadId }` | 语义（`thread_processor.rs` 的 `thread_unsubscribe_response_inner` 与 `thread_lifecycle.rs`）：本连接不再收这个 thread 的通知；thread 没有订阅者且空闲满 `thread_unload_delay_secs`（默认 60 s）后才卸载，rollout 留在磁盘上，之后可以 `thread/resume`。返回 `notLoaded` / `notSubscribed` 都按成功处理；失败只告警，不阻止关闭 |
| `resumeSession` | `thread/resume { threadId, cwd, model, modelProvider, approvalPolicy, sandbox, baseInstructions, config, excludeTurns: true }` | §4.2 |
| `respondToApproval` | 服务端请求的回复 `{ decision }` | §6.6 |
| `listPendingApprovals` | — | 适配器自己记的未决审批（§6.6） |
| `generateTitle` | 经网关的一次 Responses 请求，或临时 thread | §4.4 |
| `compact`（0.24.0） | `thread/compact/start { threadId }` | §4.9 |
| `review`（0.24.0） | `review/start { threadId, target, delivery: 'inline' }` | §4.9 |

### 4.1 取消得不到确认：重启进程

`cancel` 发出 `turn/interrupt` 后 4 s（`CANCEL_TIMEOUT_MS`，先于 Host 的 5 s）内回合没有结算，适配器重启 codex-app-server：卡住的回合随旧进程结束，挂在这个进程上的会话都以 `engine.exited`（`reason: cancel_unconfirmed`，`exitCode` 与 `signal` 为 null，之前每个未决审批一条 `approval.cancelled`（`engine_exited`））脱开，同时 `cancel` 报 `cancel_unconfirmed`。Host 照 domain-model.md §4.1 #9、#10 处理：取消的那个会话转 `error`，其余挂着的会话按引擎退出转 `error`，之后 `thread/resume` 到新进程上（rollout 在磁盘上）。约定与 dsh 相同（acp-event-mapping.md §1.4）。审批挂起时取消与流式中途取消都只是 `turn/interrupt`，app-server 4–12 ms 内结算（codex-notes §7.1），这条路径只为进程卡住兜底；`codex-adapter.resume.integration.test.ts` 把时限设为 0 走一遍。

### 4.2 恢复：`thread/resume`

- 已挂在本进程上的会话直接成功，不发请求。其余的会话（已 `close`、进程退出或重启后脱开、适配器根本不认识它——Host 重启后就是这样）发 `thread/resume`：`cwd` 是会话创建时的工作区，模型、Provider、审批与沙箱、基础提示词与 `config` 覆盖与 `thread/start` 相同（Provider 配置可能换过）；`excludeTurns: true`，Codex 不把历史回给 Wevir（界面历史在 Host 的事件库），模型的上下文由 rollout 恢复，下一回合的请求带着完整的历史（`codex-adapter.resume.integration.test.ts` 换一个进程后检查 mock 收到的请求）。结果带 `engineVersion = CODEX_VERSION`。
- thread 关闭后仍加载在进程里（60 s 内）时 app-server 重新订阅它；覆盖与当前设置不同、而它空闲没有订阅者时，app-server 先卸载再按新设置从 rollout 恢复（`collect_resume_override_mismatches`）。
- 与 dsh 不同，Codex 不比较 `cwd`：它是覆盖，不一致时按新的 cwd 继续（Wevir 总是传创建时的工作区）。所以没有“cwd 不一致”一类。

失败按 `resume-error.ts` 归类（自上而下第一条匹配的生效；`AdapterError.message` 是 `thread/resume 失败：` 加 app-server 原文，`session_lost` 再加原因说明）：

| 归类 | 错误码 | 原文（正则） | 来源 | 适配器 | 样本 |
|---|---|---|---|---|---|
| `lost` `not_found` | `-32600` | `/^no rollout found for (?:thread\|conversation) id /` | `ThreadStoreError::ThreadNotFound`：CODEX_HOME 里没有这个 thread 的 rollout（被删除，或会话一次都没对话过，见下） | `session_lost`，说明“Codex 找不到这个会话的记录…” | `errors/resume-not-found.json` |
| `lost` `not_found` | `-32600` | `/^invalid (?:session\|thread) id: /` | 不是 Codex 的 thread ID（UUID） | `session_lost` | `errors/resume-invalid-id.json` |
| `lost` `corrupted` | `-32603` | `/^failed to read thread: thread-store internal error: failed to read session metadata /` | rollout 读不出会话的元数据（文件空了、没有一行能解析） | `session_lost` | `errors/resume-corrupted.json` |
| 卸载中 | `-32600` | `/^thread \S+ is closing; retry thread\/resume after the thread is closed/` | thread 正在卸载 | 每 200 ms 重试，最多 10 次；仍不行报 `session_unavailable` | — |
| `rejected` | `-32600` 的其余 | — | app-server 拒绝（已归档等，Wevir 不会触发） | `session_unavailable` | — |
| `unknown` | 其余 | — | 进程退出、内部错误 | `engine_unavailable` | — |

- `incompatible`（rollout 由更新的 Codex 写入）还没见过对应的措辞，归 `unknown`；Codex 升级时留意（UPSTREAM.md「Codex 升级检查清单」）。
- **一次都没对话过的会话**：Codex 在第一条用户消息时才写 rollout，所以建了会话、还没发消息，引擎就重启了（Host 重启、模型目录变了的有计划重启、进程崩溃），这个会话恢复时也是 `no rollout found`，Host 把它标为只读（没有历史可丢，用户新建一个会话即可）。桌面端与 CLI 都是建会话后立即发送，实际很少遇到。
- 样本由 `record-app-server.test.ts` 用真实二进制录制，`resume-error.test.ts` 逐条核对；假的 app-server（§7）回放同样的措辞。

### 4.3 关闭

见上表。`close` 之后未决审批已随取消结束；会话的 `hub` 结束，`send` 报 `session_closed`，`resumeSession` 接回。

### 4.4 会话标题：`generateTitle`

Host 在第一个回合开始后调用（规则与提示词在 prompts/README.md「会话标题」与 prompts/thread-title.md，Host 一侧在 `packages/host/src/title.ts`）：Host 组好说明与输入、解析与整理输出，适配器只负责用**会话当前的 Provider 与模型**发一次不带工具的请求，推理档位取这个模型最低的一档（`lowestEffort`：Wevir 档位从 off 到 max 里模型支持的第一个，`off` 换成 Codex 的 `none`；模型不推理时不带），返回模型的最终文本。两条路（`title.ts`）：

| 会话 | 怎么请求 | 说明 |
|---|---|---|
| 经网关（R6 之前的全部会话） | 适配器直接经自己持有的网关 `POST <网关>/v1/p/<providerId>/responses`：`{ model, instructions, input: [user 消息], stream: true, store: false, reasoning? }`，没有 `tools`；读流，拼 `response.output_text.delta`，`response.completed` 里有完整消息时以它为准 | 与 Codex 的请求同样的处理（透传、方言修正，或 Chat / Messages 转换），不经 codex-app-server，不占用会话的 thread。网关的请求日志照常记一条 |
| 不经网关（ChatGPT 登录，R6） | 照终端界面（`tui/src/app/thread_title.rs`、`temporary_structured_request.rs`）开临时 thread：`thread/start { ephemeral: true, cwd, model, modelProvider, approvalPolicy: 'never', sandbox: 'read-only', baseInstructions: <说明>, config: <Provider 条目> + TITLE_THREAD_CONFIG }`，再 `turn/start { input, outputSchema, effort }`，取最后一条已提交的 agentMessage，最后 `thread/unsubscribe` | `ephemeral` 不写 rollout、不进 thread 列表；`TITLE_THREAD_CONFIG` 关掉命令、子 agent、计划、图片等工具与联网搜索（取自终端界面的同名键），标题输入是不可信的对话内容。这个 thread 的通知只交给 `TitleCollector`，不进会话、不告警。用 `CodexAdapterOptions.titleVia: 'thread'` 选这条路；R6 之前只有测试用它 |

都只用稳定面（`ephemeral`、`outputSchema`、`effort` 不是实验字段）。适配器不实现 `generateTitle` 的引擎（dsh、echo）只有首条消息截断的标题。

### 4.5 插话：`turn/steer`（R11）

`steer(engineSessionId, steerId, input)`（领域模型 §4.6）：

- **请求。** `turn/steer {threadId, input, expectedTurnId, clientUserMessageId: steerId}`。`expectedTurnId` 是 `turn/start` 结果里的回合 ID；`turn/start` 的结果还没到、或会话没有进行中的回合时不发请求，直接报 `steer_rejected`。`turn/steer` 与 `clientUserMessageId` 都是稳定面（`app-server-protocol/src/protocol/common.rs`、`v2/turn.rs` 的 `TurnSteerParams`；实验的只有 `responsesapiClientMetadata`、`additionalContext`，不用）。子会话由父 agent 驱动，报 `invalid_input`。
- **接受与拒绝。** 成功的响应是 `{turnId}`：输入进了这个回合的待处理输入，`steer` 返回。错误（`app-server/src/request_processors/turn_processor.rs` 的 `turn_steer_inner`）：`no active turn to steer`、`expected active turn id … but found …`（回合恰好结束或换了）、`cannot steer a review turn` / `cannot steer a compact turn`（`codexErrorInfo.activeTurnNotSteerable`），以及输入过大等，一律报 `steer_rejected`，原文放进 `message`，Host 转为排队。Codex 终端界面遇到“回合不能插话”同样放到回合结束后（`tui/src/app/thread_routing.rs`），遇到“没有进行中的回合”直接开始新回合；Wevir 的 Host 在回合结束时发出排队的消息，效果相同。
- **等这一步结束：关掉 `instant_interrupt`。** 锁定版本里 `features.instant_interrupt` 默认开（`features/src/lib.rs`，Stage::UnderDevelopment）：插话一到就掐断正在流式输出的这次采样（`core/src/session/turn.rs` 的 `preempt`），已输出的半段留在对话里，立刻带着插话重新采样。R11 实测：慢回答流出第一片就被打断，半段回答在回合末尾才提交。维护者定的插话是“这一步结束后插进本回合”，所以 config.toml 写 `instant_interrupt = false`（§3 的加固项）：这次采样照常流完，插话在下一次采样之前进对话。工具调用不受这个开关影响，等这批工具结束。回合刚开始、第一次采样还没发出时到达的插话，会和回合的输入一起进第一次请求（实测），这时它在模型的第一段输出之前。
- **送达。** Codex 在下一次采样之前把待处理输入记进对话：发 `item/started` 与 `item/completed` 的 userMessage，`clientId` 就是 `clientUserMessageId`。适配器在 `item/completed` 时报 `turn.steered {steerId}`（终端界面同样以它确认，`tui/src/app/app_server_events.rs`）；回合的第一条 userMessage（`turn/start` 的输入）没有我们给的 `clientId`，照旧不上报（`mapping.ts` 的 `SILENT_ITEMS`）。一次采样结束、还有待处理输入时，回合接着再采样（`core/src/tasks/regular.rs`），所以插话总在当前这一步（模型这一段输出，或这批工具调用与结果）之后。
- **回合结束时没用上的。** 回合以错误结束时，Codex 在任务结束时把剩下的待处理输入照样记进对话（`core/src/tasks/mod.rs`，`take_pending_input_for_turn_state` 之后 `run_hooks_and_record_inputs`），适配器照样报 `turn.steered`；被中断（`turn/interrupt`）的回合丢掉它们，不报，Host 按“回合结束时还没插进去”处理。

### 4.6 换模型与推理档位（0.9.0，U8）

`configureSession(engineSessionId, {modelId, reasoningEffort?})`（host-api.md §3.1 的 `session.configure`）：

- **记在会话上，下一个 `turn/start` 带上。** 锁定版本的 `TurnStartParams` 有稳定字段 `model` 与 `effort`，含义是“这个回合及之后”（`app-server-protocol/src/protocol/v2/turn.rs`）。适配器按会话的 Provider 找到模型（`#route`，Provider 没有这个模型报 `invalid_input`），之后每个 `turn/start` 都带 `model` 与 `effort`：进程重启、`thread/resume` 之后 thread 的设置回到 `thread/start` 时的值，所以每次都带，不只带一次。没给档位时 `effort` 是 `null`（不覆盖，沿用 thread 的设置）。
- **不重渲染基础提示词。** `baseInstructions` 是 `thread/start` 时按原模型渲染的（§3），换模型不改它；模型目录里每个 Provider 的模型都有条目，Codex 按新模型的条目取上下文大小、推理档位与工具类型。事件映射的上下文大小跟着换（`CodexEventMapper` 的 `contextSize`）。
- **子会话** 由父 agent 驱动，报 `invalid_input`。
- 验证：`codex-adapter.configure.test.ts`（假 app-server 记下的 `turn/start`）与 `codex-adapter.turn.integration.test.ts`（真实二进制 + 网关 + mock 模型：换了之后的请求是新模型与新档位）。

### 4.7 权限模式（0.11.0，U15）

会话的 `permissionMode`（domain-model §3.9）在 `createSession` / `resumeSession` 的配置与 `configureSession` 里给出，记在会话上，之后每个 `turn/start` 都带全三项（换回 `on_request` 时把之前的覆盖改回来；锁定版本里这三个字段的含义都是“这个回合及之后”，`app-server-protocol/src/protocol/v2/turn.rs`）：

| 模式 | `approvalPolicy` | `approvalsReviewer` | `sandboxPolicy` |
|---|---|---|---|
| `on_request` | `on-request` | `user` | `{type: workspaceWrite}`（其余字段取默认，与 config.toml 的 `sandbox_mode = "workspace-write"` 相同） |
| `auto_review` | `on-request` | `auto_review` | `{type: workspaceWrite}` |
| `full_access` | `never` | `user` | `{type: dangerFullAccess}` |

对照 Codex 内置的 approval preset（`utils/approval-presets`：Default 是 on-request + workspace，Full Access 是 never + 不用沙箱）。`approvalPolicy` 字段标的是 `experimental(nested)`，只有 granular 一种要 experimentalApi，字符串值不用；`approvalsReviewer`、`sandboxPolicy` 是稳定字段。config.toml 仍写 `approval_policy = "on-request"`、`sandbox_mode = "workspace-write"`、`approvals_reviewer = "user"`，是 thread 的起点。

- **模型知道当前的模式。** 换了之后 Codex 在请求里放新的权限说明（`<permissions instructions>`：`sandbox_mode` is `danger-full-access`…、Approval policy is currently never…），经网关的模型也有（Wevir 的 base.md 在它之前，§3）。完全访问下 Codex 拒绝模型申请提权（“approval policy is Never; reject command”），模型照说明直接运行。
- **自动批准用会话自己的模型。** Codex 的审查子 agent 优先用它偏好的审查模型；模型目录里没有时回落到父 thread 的模型（`ext/guardian-reviewer` 的 `select_review_model`）。经网关的 Provider 的目录里都没有，所以审查请求经网关发给会话所用的模型，带 Codex 的审查说明（`prompts/templates/guardian/policy_template.md`），模型回 `{"outcome":"allow"|"deny", "risk_level", "rationale"…}`。允许的照常执行；拒绝的不产生审批请求，命令以失败结束，输出里是“This action was rejected due to unacceptable risk. Reason: …”。ChatGPT 进程的目录里有偏好的审查模型，用的是它。审查过程的通知 `item/autoApprovalReview/started` / `completed` 与 `guardianWarning` 在 `IGNORED_NOTIFICATIONS` 里（§9 留了投影审查结论）。Wevir 自己的 `prompts/auto-review.md`（Host 侧复核员）仍未接入。
- **子会话** 由 Codex 驱动、不经 `turn/start`，沿用父回合的设置；`configureSession` 对子会话报 `invalid_input`。
- 验证：`codex-adapter.configure.test.ts`（假 app-server 记下的三项）与 `codex-adapter.permissions.integration.test.ts`（真实二进制 + 网关 + mock 模型：完全访问下越界命令不审批直接执行、权限说明随之更新；自动批准下审查请求发给会话的模型，允许的执行、拒绝的失败，都不问用户；换回请求批准后照常审批）。


### 4.8 环境的额外文件夹（0.15.0，U22.1）

环境会话（domain-model §3.10）除主文件夹外的文件夹是 `SessionConfig.additionalRoots`（适配器声明 `additionalRoots: true`）。adapter-codex：请求批准、自动批准两种模式下每个 `turn/start` 的 `sandboxPolicy` 是 `{type: workspaceWrite, writableRoots: [...]}`（稳定字段，没有额外目录时照旧省略）；`thread/start` 与 `thread/resume` 的 `developerInstructions` 写一句“这个会话还可以读写这些文件夹：…”，让模型知道它们。完全访问不受影响（不用沙箱）。
### 4.9 压缩上下文与代码审查（0.24.0）

两种回合都由 app-server 开始，没有 `turn/start`（domain-model §4.7）。

- **`compact`**：`thread/compact/start { threadId }`（`thread_processor.rs` 的 `thread_compact_start_inner` 提交 `Op::Compact`），结果是空对象、不带回合 ID。适配器先登记回合（同 `send`），回合 ID 等这个 thread 的 `turn/started` 带来；之前就要取消的，等它到了才发 `turn/interrupt`。在那之前，`turnId` 等于上一个回合的通知不算这个回合的。回合里一个 `contextCompaction` item：`item/started` → `context.compacting`，`item/completed` → `context.compacted`，`compactionId` 是 itemId，`trigger: 'manual'`。经网关的 Provider 用 Codex 的本地压缩（`core/src/compact.rs`）：一次不带工具的 Responses 请求，最后一条用户消息是 `templates/compact/prompt.md`（“You are performing a CONTEXT CHECKPOINT COMPACTION …”），回答成为之后的上下文；压缩完 Codex 发一条带 threadId 的 `warning`（长 thread 与多次压缩会降低准确度），留作 `engine.raw`。
- **自动压缩**：上下文用量过了模型的自动压缩线（`ModelInfo::auto_compact_token_limit`：上下文窗口的九成，Wevir 不写 `model_auto_compact_token_limit`），Codex 在回合开始前（或中间）照样做一次压缩，同样是 `contextCompaction` item，映射成 `trigger: 'auto'`（`compact` 开的回合之外的都是 `auto`，映射器的 `reset('manual' | 'auto')`）。用到窗口的 95%（`effective_context_window_percent`）时不论阈值都会压缩。窗口取 Provider 模型的 `contextWindow`，没填按 128k（§3“上下文大小”）；`usage.updated` 的 `autoCompactAt`（0.29.0）就是这条线。弃用的 `thread/compacted` 通知按设计忽略。
- **压缩之后的上下文**：本地压缩换掉的是对话历史：之后的请求里是摘要（Codex 在前面加上 `templates/compact/summary_prefix.md` 的“Another language model started to solve this problem …”）与最近的用户消息（`COMPACT_USER_MESSAGE_MAX_TOKENS`，20k 以内），初始上下文由 `build_compaction_replacement_history` 重建，`developerInstructions`（§4.8 额外文件夹的说明）随它回来；`baseInstructions`（base.md）不在历史里，每次请求都带（经网关的模型是第一条 developer 消息）。所以 Wevir 不需要像 T3 Code 那样在压缩后用 `thread/inject_items` 补回说明（T3 的 CodexAdapterV2.ts 1754-1790 补的是它自己的 additionalContext）；支线的边界说明（§6.9）是注入的一条用户消息，随历史进摘要。`codex-adapter.command.integration.test.ts` 核对了压缩后的请求里摘要、base.md 与额外文件夹说明都在。base.md 的“压缩之后怎样接着做”告诉模型那份摘要是它之前的工作、怎样接着做。
- **`review`**：`review/start { threadId, target, delivery: 'inline' }`，`target` 是 `{ type: 'uncommittedChanges' }` 或 `{ type: 'baseBranch', branch }`（Host 给的基础分支），结果带回合 ID（`turn.id`）。`detached` 已弃用，不用。Codex 在一个子对话里审查（`core/src/tasks/review.rs`：审查专用的基础提示词、审批固定 `never`、关掉 web search 与子 agent），子对话的工具调用转到这个 thread、照常映射；它的 agentMessage 不转（只有开始的 `item/started`，映射器不发事件）。回合里另有 `enteredReviewMode`（在 `turn/started` 之前就到）与 `exitedReviewMode` 两个 item，不出事件；审查结果是随后的 agentMessage（`render_review_output_text`：结构化的 findings 渲染成文字，模型没给 JSON 时就是原文）。审查回合同样拒绝 `turn/steer`（`ActiveTurnNotSteerable`），Host 本来就不对命令回合插话。

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
| `thread/tokenUsage/updated` | `usage.updated` | `totalTokens` = `tokenUsage.total.totalTokens`（0.14.0，这个 thread 累计的，子 thread 各算各的）；`contextUsed` = `tokenUsage.last.totalTokens`（codex-notes §2.7 的口径）；`contextSize` = 交给 Codex 的上下文窗口（Provider 的 `contextWindow`，没填是 128k，§3）；ChatGPT 进程的模型用 Codex 报的 `modelContextWindow`（扣掉 5% 余量的有效窗口），没有就是 `engine.raw`；`autoCompactAt`（0.29.0）= 窗口的九成（`autoCompactLimit`，Codex 自动压缩的线），ChatGPT 进程的模型不报 |
| `turn/plan/updated` | `todo.updated` | `update_plan` 不产生 item，没有工具调用 ID：`toolCallId` 合成为 `plan:<turnId>`（`PLAN_TOOL_CALL_PREFIX`），可以一眼认出、在回合内唯一；客户端只按回合取最新的计划（`TranscriptProjection` 不按 toolCallId 找工具），没有对应的 `tool.started`。`items` 每步一条：`content` = `step`，`status` 的 `inProgress` 换成 `in_progress`（与 dsh 的 `todo_write` 同一套），`explanation` 不进事件 |
| `turn/completed` | `turn.settled` / `turn.failed` | `completed` → settled（`completed`），`interrupted` → settled（`cancelled`），`stopReason` 是 Codex 的状态原文；`failed` → `turn.failed`，`message` = `turn.error.message` + `additionalDetails`，`category` 与 `code` 见 §6.7。之前先收尾没提交的增量（§6.4）；`interrupted` 时还没结束的工具按 `failed` 收尾（§6.6） |
| `error` | `engine.raw` | `willRetry: true` 不算回合失败（Codex 自己也只在状态栏短暂显示），只留 engine.raw，已经流出的增量以 `abandoned` 结束；`willRetry: false` 随后有 `turn/completed`（failed），以它为准 |
| `serverRequest/resolved` | （无）或 `approval.cancelled` | 由适配器处理，不进映射器（§6.6） |
| `turn/started`、`item/reasoning/summaryPartAdded`、`thread/status/changed`、`thread/started`、`thread/compacted` | （无） | 按设计忽略：Host 自己写 `turn.started`、维护会话状态；块号已在增量里；`thread/compacted` 已弃用，压缩照 item 报（§4.9）。回合之外到达时同样忽略（R4 起，子会话在两个回合之间的状态变化很多）。子会话的 `turn/started` 例外，见 §6.5；`compact` 开的回合从它拿回合 ID（§4.9） |
| `thread/name/updated`（子会话） | 父会话流里的 `subagent.updated`（`title`） | §6.5 |
| `turn/diff/updated`、`thread/name/updated`（普通会话）等其余带 threadId 的 | `engine.raw` | |
| 不带 threadId 的（`account/*`、`remoteControl/*`、`mcpServer/*` 等） | （无） | `warning`、`configWarning`、`deprecationNotice` 写一次告警，其余忽略（codex-notes §6.4） |

不属于进行中回合的通知（没有回合，或 `turnId` 是别的回合）：用量照常映射，其余一律 `engine.raw`（events.ts 的顺序约定：回合之间只有 `engine.raw` 与 `engine.exited`）。

### 6.2 item

| item 类型 | `item/started` | `item/completed` |
|---|---|---|
| `agentMessage` | （无） | `assistant.message`（`messageId` = itemId，`replaces` 是它的全部增量块）+ 每个增量流一条 `assistant.stream_ended`（`committed`）。没有增量且文本为空时不发 |
| `reasoning` | （无） | `assistant.thought`，文本是原始推理（`content`），没有时用摘要（`summary`）；`replaces` 与 `stream_ended` 同上 |
| `commandExecution`、`fileChange`、`mcpToolCall`、`dynamicToolCall`、`collabAgentToolCall`、`webSearch`、`imageView` | `tool.started`（`toolCallId` = itemId，`input` 是原样的 item，`toolName` 与 `display` 见 §6.3） | 展示变了先发 `tool.updated`，再 `tool.finished`：`completed` → completed，`failed` / `declined` / `interrupted` → failed（`declined` 先映射为 failed，拒绝的语义由审批事件承担，决策 6.2）。没有 `item/started` 时先补一条 `tool.started` |
| `userMessage` | （无） | （无）：Host 自己记 `user.message` |
| `contextCompaction`（0.24.0） | `context.compacting`（`compactionId` = itemId） | `context.compacted`；`trigger` 见 §4.9 |
| `enteredReviewMode`、`exitedReviewMode`（0.24.0） | （无） | （无）：Host 的 `turn.started.command` 表示审查，结果是随后的 agentMessage（§4.9） |
| 其余（`plan`、`hookPrompt`、`subAgentActivity` 等） | `engine.raw` | `engine.raw` |

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
| `mcpToolCall` | `mcp__<server>__<tool>` | `unknown`；Wevir 的 `wevir_web` 是 `search` / `fetch`（§6.12） | `mcpServer`；`wevir_web` 另有 `query` / `url`，输出是工具回的文字 |
| `dynamicToolCall` | `<namespace>.<tool>` | `unknown` | |
| `collabAgentToolCall` | `collabAgentToolCall.<tool>` | `sub_agent` | `summary` 取任务描述的第一行 |
| `webSearch` | `webSearch` | `search` | `query`（只在 ChatGPT 会话里出现：经网关的会话关了托管搜索，§6.12） |
| `imageView` | `imageView` | `read` | `paths` |

`item.command` 是 Codex 实际执行的、带 shell 外壳的形式（样本里是 `/bin/zsh -lc 'cat README.md'`）。`display.command` 与 `summary` 去掉 `<sh|bash|zsh> -lc '…'` 外壳；认不出外壳（例如 Windows 的 PowerShell）时，只有一个解析出的动作就用它的命令，否则原样。`input` 里保留原样。

### 6.4 增量与已提交消息

Codex 的增量与已提交项共用 itemId，对齐是直接的，不需要 adapter-dsh 的 `DeltaMerger`：每个 agentMessage / reasoning item 是一个 attempt，`item/completed` 时提交消息替换它全部的增量块并结束流。

取消或出错发生在流式中途时，已发出的增量没有 `item/completed`（codex-notes §2.2，样本 `cancel.jsonl`）。`turn/completed` 时这些增量：含非空白字符的按已提交消息补发（`assistant.message` / `assistant.thought` + `stream_ended committed`），保留已经显示的输出，与 dsh 取消时一次性补发已生成部分的做法一致；只有空白的以 `abandoned` 结束。`error` 带 `willRetry: true` 时 Codex 会重发整个请求，已流出的增量以 `abandoned` 结束，不再补发。

### 6.5 子 agent → 子会话（R4，`subagents.ts`、`codex-adapter.ts`）

子 agent 是独立的 thread，它的通知自动推到同一连接，不发 `thread/started`（codex-notes §2.4）。R4 把它做成 Wevir 的**子会话**（domain-model §3.3.1、§4.5）：子 thread 是一个子会话（`engineSessionId` = 子 thread ID），它的通知按子会话上报；父会话的流里报出它。只用稳定面：`thread/list.parentThreadId` 是实验字段（Codex 的终端界面靠它），不用；父子关系来自 collab item，昵称来自 `thread/read`（稳定）。

**认出子 agent。**

| 依据 | 做法 |
|---|---|
| 父会话（或子会话自己）里 `collabAgentToolCall` 的 `receiverThreadIds` | `spawnAgent` 的 receiver 一出现就认（`item/completed` 时才填上）；`wait`、`closeAgent`、`sendInput`、`resumeAgent` 的 receiver 可能是不存在的 ID，要等 `item/completed` 的 `agentsStates` 报出它的状态才认，报 `notFound` 的跳过 |
| 没认出来的 thread 的 `turn/started`，其 `rootTurnId` 等于某个挂着的会话进行中的回合 | 那个会话正好只有一个进行中的派出类工具调用（`spawnAgent` / `resumeAgent` / `sendInput`）时当场认出，父工具调用就是它。Codex 不保证两个 thread 的通知谁先到（样本 `subagent-early-child.jsonl`）；默认 `agents.max_depth = 1`，`rootTurnId` 就是父回合 |

认出之前，没认出来的 thread 的通知先存着（每个 thread 至多 1000 条，30 s 认不出就丢掉并告警一次）；认出之后按子会话补上。认出时适配器：登记子会话（Provider 与父会话相同；模型取 collab item 的 `model`，Provider 里没有这个模型就用父会话的模型配置），子会话的 `EventHub` 在第一个订阅者之前缓冲（`bufferUntilSubscribed`）；在父会话的流里发 `subagent.started`（在这条通知自己的事件之后，所以总在派出它的 `tool.started` 之后）；再异步 `thread/read` 子 thread，有昵称、角色或名称时发 `subagent.updated`。进程重启后脱开的子会话再被 collab item 指到时同样重新登记，Host 按 C5 重新挂上。

**`subagent.started` 的字段**：`childEngineSessionId`、`parentToolCallId`（collab item ID）、`title`（兜底标题，`subagentTitle`：thread 名称 → 任务描述首行 → 昵称；认出时只有任务描述，名称与昵称晚到）、`prompt`（`spawnAgent` 的任务描述，Host 用它生成标题）、`modelId`（item 的 `model`，`spawnAgent` 进行中时为空则用父会话的）、`reasoningEffort`（item 的，`none` 换成 `off`）。**`subagent.updated`**：`thread/read` 的 `agentNickname` / `agentRole`，以及名称（`name`，或子 thread 的 `thread/name/updated`）作为新的兜底标题；没有任务描述时昵称也作兜底标题；`closeAgent` 完成时 `closed: true`。

**子会话自己的流。** 子 thread 的 `turn/started` 开始一个由引擎发起的回合：适配器记下回合，等这个回合的下一条通知——是 userMessage 的 `item/started` 就把它的文本作 `turn.started` 的 `input`（任务描述，或 `send_input` 发来的消息），否则不带输入——再发 `turn.started`；之后与普通会话相同（增量、工具、审批、计划、用量，`turn/completed` 是终结事件）。子会话不接受 `send`（`invalid_input`）；`cancel` 是对子 thread 的 `turn/interrupt`（Host 级联取消用；0.14.0 起用户也能单独停一个子会话，这时 `cancel` 带 `notifyParent`，适配器在子回合结算后用稳定的 `thread/inject_items` 往父 thread 补一条 user 消息，说明用户停止了这个子 agent、不要再等它——Codex 把客户端中断的子 agent 记为 `Interrupted`，不算结束，父 agent 不会自己知道，`wait_agent` 仍会等到它自己的超时；注入失败只记日志）；`generateTitle` 用子会话的 Provider 与模型。子 thread 两个回合之间的 `thread/status/changed` 不再变成 engine.raw。

**实测（`rust-v0.162.1`，R4，脚本与 Spike 的 subagent 场景相同）。**

| 场景 | 观测 |
|---|---|
| spawn → wait | 子 thread：`thread/status/changed`（idle、active）、`turn/started`（`rootTurnId` = 父回合）、userMessage、增量、`turn/completed`；父 thread 的 `wait` 在子回合结束之后 `item/completed`，`agentsStates` 带子 agent 的回答。`thread/read` 子 thread：`parentThreadId`、`agentNickname`（如 Kuhn）、`agentRole` null、`name` null、`reasoningEffort` null（item 上是请求的 `medium`） |
| 父回合不等子 agent | 父回合先 `turn/completed`，子 thread 的回合之后照常跑完 |
| 父回合中途 `turn/interrupt` | 父回合 interrupted，`wait` 没有 `item/completed`；**子回合照常跑完**（completed）。子 thread 挂着审批时，审批一直挂着（`waitingOnApproval`） |
| 对子 thread `turn/interrupt` | 子回合 interrupted，挂着的审批随后 `serverRequest/resolved`；父回合的 `wait` 不因此结束（等到 `timeout_ms`） |
| `close_agent` | 子回合 interrupted，子 thread `notLoaded`；`closeAgent` 的 `agentsStates` 是关之前的状态（running） |
| `wait_agent` 一个不存在的 ID | `item/started` 的 receiver 已有这个 ID、`agentsStates` 为空；`item/completed` 报 `notFound` |

Host 据此自己级联取消（domain-model §4.5）。录制样本 `subagent.jsonl`（不等子 agent）、`subagent-wait.jsonl`（spawn → wait），以及由前者调整顺序得到的 `subagent-early-child.jsonl`；假的 app-server 把样本里的子 thread 与子回合换成新 ID（`codex-adapter.subagent.test.ts`）。

### 6.6 审批与其他服务端请求

代码在 `codex-adapter.ts`（`#answerServerRequest`、`respondToApproval`、`#endApproval`）与 `mapping.ts`（`approvalPrelude`、`#failOpenTools`）。Host 一侧的审批状态机不变（domain-model.md §4.3、§5；与 dsh 的桥接同一套约定，acp-event-mapping.md §1.3）。

**什么时候有审批**（`approval_policy = "on-request"` + `sandbox_mode = "workspace-write"`，codex-notes §2.3）：工作区内的补丁与沙箱内的命令不需要审批（`$TMPDIR`、`/tmp` 也可写）；写工作区外的补丁、模型声明 `sandbox_permissions: "require_escalated"` 的命令需要。所以测试与验收要写工作区外、且不在系统临时目录的地方（adapter-codex 的 `.test-outside/`，gitignore）。

| 服务端请求 | 处理 |
|---|---|
| `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`，属于会话进行中的回合 | 先发 `approvalPrelude` 的事件，再 `approval.requested`（下面），等 `respondToApproval` |
| 同上，回合已开始取消 | 照常上报，随即 `approval.cancelled`（`turn_cancelled`），不回复（app-server 中断回合时自己收回） |
| 同上，属于子会话（子 agent 的 thread） | 与普通会话相同，`approval.requested` 在子会话的流里，按子会话的 ID 回复（R4）。Host 把它放进父会话摘要的 `pendingApprovals`，客户端在父会话里显示并回复（domain-model §5 第 8 条） |
| 同上，不属于进行中的回合、或 thread 没挂着（含还没认出来的子 thread） | 回复 `decline` 并告警 |
| `item/permissions/requestApproval` | 回复“不支持”（`-32601`）。核实（锁定提交）：只来自 `request_permissions` 工具，要 `features.request_permissions_tool`（UnderDevelopment，默认关），Wevir 不开，不会出现 |
| `item/tool/requestUserInput`，属于会话进行中的回合（0.10.0，U11） | `question.requested`（下面），等 `respondToQuestion` |
| 同上，回合已开始取消、不属于进行中的回合、或 thread 没挂着 | 回复空的回答 `{ answers: {} }`（Codex 当作用户没答，模型自己往下做）并告警 |
| 其余（`mcpServer/elicitation/request` 等） | 回复“不支持”（`-32601`） |

**`approval.requested`。** `requestId` 由适配器分配（`codex-<n>`，实例内唯一；不用 app-server 的请求 id，它每个进程从 0 起），`toolCallId` 是请求的 `itemId`（与工具调用同一个 ID）。`availableDecisions` 是实验字段拿不到（codex-notes §2.7），选项照 Codex 终端界面（`tui/src/bottom_pane/approval_overlay.rs` 的 `exec_options`、`patch_options`）固定；`optionId` 就是回给 app-server 的决定，`kind` 以 `allow_` / `reject_` 开头决定 Host 记为批准还是拒绝，客户端不认识这些 kind，按 `label` 显示：

| 请求 | `optionId` | `label` | `kind` | Codex 的结果 |
|---|---|---|---|---|
| 命令 | `accept` | 允许 | `allow_accept` | 执行，回合继续 |
| 命令 | `acceptForSession` | 允许，本会话不再询问此命令 | `allow_accept_for_session` | 执行；同一个命令之后不再问（进程内有效，进程重启后重新问） |
| 命令 | `decline` | 拒绝并继续 | `reject_decline` | item `declined`（→ `tool.finished` failed），模型拿到“rejected by user”继续 |
| 命令 | `cancel` | 拒绝并停止 | `reject_cancel` | item `declined`，回合中断（→ `turn.settled` cancelled），用户接着说该怎么做 |
| 补丁 | `accept` | 允许 | `allow_accept` | 应用补丁 |
| 补丁 | `acceptForSession` | 允许，本会话不再询问这些文件 | `allow_accept_for_session` | 应用；这些文件之后不再问 |
| 补丁 | `cancel` | 拒绝并停止 | `reject_cancel` | 回合中断；补丁的 item **没有** `item/completed`，回合结算前按 `failed` 收尾 |

补丁没有“拒绝并继续”，与终端界面相同。“以后以这个前缀开头的命令不再问”（`acceptWithExecpolicyAmendment`，请求带 `proposedExecpolicyAmendment` 时终端界面才给）与网络策略修订先不做：它们改的是 Codex 的执行策略文件，属于“总是允许”一类，要 Host 记规则（domain-model.md §3.4），以后单独做。

**详情。** Host 从同一 `toolCallId` 的工具取审批详情（domain-model.md §3.4、§5 第 1 条）。实测（`approval-exec.jsonl`、`approval-patch.jsonl`）app-server 在请求之前已发了这个 item 的 `item/started`：命令的 item 有命令原文（带 shell 外壳）、`cwd`、`commandActions`；补丁的 item 有 `changes`（每个文件的 `diff`），请求本身不带补丁内容。请求里另有模型给的理由（`reason`，即模型调 `exec_command` 时的 `justification`），所以 `approvalPrelude` 在 `approval.requested` 之前发一条 `tool.updated`，`input` 是原样的 item 加上 `justification: <reason>`；Host 收到 `tool.updated` 时更新它记的工具输入，审批详情因此带上理由（桌面端显示为“Agent 给出的理由”）。请求没有理由（补丁通常如此）时不发。没见过这个 item 时（防御）按请求合成一条 `tool.started`。

**回复与收回。** `respondToApproval` 先把审批移出未决表，再以 `{ decision: optionId }` 回复，同一请求只回复一次；`optionId` 不在选项里报 `invalid_option`（审批保持未决）。app-server 每结束一个服务端请求都发 `serverRequest/resolved { threadId, requestId }`：Wevir 回复过的随即就到，已不在未决表里，忽略；仍未决的是 app-server 自己收回的，以 `approval.cancelled`（`turn_ended`）结束、不再回复（`CodexProcess` 的 `NO_REPLY`）。

**挂起审批的结束**（适配器不给审批设时限，等用户决定）：

| 触发 | 适配器 | `approval.cancelled.reason` |
|---|---|---|
| `cancel`、`close` | 先结掉未决审批（不回复），再 `turn/interrupt`；app-server 中断回合时自己收回请求，`serverRequest/resolved` 在 `turn/completed` **之后**才到（codex-notes §2.3，样本 `approval-exec.interrupt.jsonl`），那时已不在未决表里，忽略，也不告警 | `turn_cancelled` |
| 回合在审批未决时结束（`turn/completed` 到了） | 在终结事件之前结掉，事件顺序仍合 events.ts 的约定（回合之间只有 engine.raw 与 engine.exited）；之后到的 `serverRequest/resolved` 忽略 | `turn_ended` |
| app-server 回合中途收回（`serverRequest/resolved` 先到） | 结掉 | `turn_ended` |
| 进程退出、有计划的重启（`config_changed`、`cancel_unconfirmed`） | 在 `engine.exited` 之前结掉 | `engine_exited` |
| `dispose` | 结掉，不再回复（进程随之回收） | `disposed` |

**提问（0.10.0，U11，`#onUserInputRequest`、`respondToQuestion`、`#endQuestion`）。** 模型调 `request_user_input` 时 app-server 发 `item/tool/requestUserInput`（`threadId`、`turnId`、`itemId`、`questions`）。这个工具默认只在计划模式提供，Wevir 打开 `default_mode_request_user_input`（§3）让普通回合也有；请求与回复的字段属于实验 API，但握手不必声明 `experimentalApi`（`rust-v0.162.1` 实测）。适配器分配 `requestId`（`codex-q-<n>`），上报 `question.requested`：`toolCallId` 是 `itemId`；每个问题的 `id`、`header`、`question` 原样，`options` 取 `label` 与 `description`，`isOther` → `allowOther`，`isSecret` → `secret`；Codex 的问题都是单选（没有 `multiSelect`，多选只在协议里，留给以后的引擎）。`respondToQuestion` 以 `{ answers: { <问题 id>: { answers: [...] } } }` 回复（选中的选项 `label` 或用户填的文字，跳过的题为空数组），同一请求只回复一次；已不在未决表里时报 `question_not_found`。结束方式与审批相同（上表）：`cancel` / `close` 结为 `turn_cancelled`，回合先结束或 app-server 收回（`serverRequest/resolved`）结为 `turn_ended`，进程退出结为 `engine_exited`，`dispose` 结为 `disposed`，都不再回复；对应的事件是 `question.cancelled`，Host 据此写 `question.resolved`（`cancelled`，domain-model §3.8）。

**中断时还没结束的工具。** 回合以 `interrupted` 结束时，`turn/completed` 之前还没 `item/completed` 的工具（审批挂起时取消的命令、选了“告诉它换个做法”的补丁）不会再有结果，`#failOpenTools` 在终结事件之前给它们发 `tool.finished`（`failed`）；取消期间 Host 把它记为 `cancelled`（domain-model.md §6.4），选了“告诉它换个做法”时界面显示为被拒绝。

### 6.8 建议的后续任务（0.16.0，U23）

Codex 没有“向用户建议后续任务”的功能（`followup_task` 是 agent 之间的，设计提案附 4），Wevir 自己给它一个工具：一个本机 MCP 服务（`suggest-tasks.ts`，stdio、一行一条 JSON-RPC，只用 Node 内置模块），只有一个工具 `suggest_tasks({ tasks: [{ title, prompt, reason? }] })`（最多 5 项），调用只回“已交给用户”，不做别的事。脚本的源码在 `suggest-tasks.ts` 里，每次启动 codex-app-server 之前写进 CODEX_HOME（`wevir-suggest-tasks.mjs`，0600），打包时不必另带文件；两种进程（网关、ChatGPT）的 config.toml 都登记为 `[mcp_servers.wevir_tasks]`：`command` 是 Host 自己的 Node（`process.execPath`，Electron 里靠 `env = { ELECTRON_RUN_AS_NODE = "1" }`），`default_tools_approval_mode = "approve"`（不问用户）、`enabled_tools = ["suggest_tasks"]`、`startup_timeout_sec = 10`。

rust-v0.162.1 实测（`codex-adapter.tasks.integration.test.ts`）：模型看到的是命名空间 `mcp__wevir_tasks` 里的 `suggest_tasks`（工具部件的 `toolName` 是 `mcp__wevir_tasks__suggest_tasks`），调用不出审批；每个 thread 第一次用到时 Codex 发两条 `mcpServer/startupStatus/updated`（`starting`、`ready`），Wevir 自己的服务正常启动的这两条不出事件，起不来（`failed` 等）的照常留 `engine.raw`。适配器在这个工具调用的 `item/completed`（`mcpToolCall`，`server` 是 `wevir_tasks`、`tool` 是 `suggest_tasks`、`status` 是 `completed`）时从 `arguments` 取出建议（去掉标题或说明为空的），紧跟在它的 `tool.finished` 之后报 `tasks.suggested`；工具调用本身照常是一个工具部件。说明怎么用在工具的描述里，prompts/base.md 也有一段（只有网关进程用它）。

回报（`injectNote`）：用户开出的任务会话第一个回合结束时，Host 让适配器往提出建议的会话的 thread 补一条 user 消息（`thread/inject_items`，同 §6.5 停止子 agent 的说明），写明任务、结局与回答摘要；实测不开回合，下一次请求里就有它。

### 6.9 支线会话（0.17.0，U23.1）

照 Codex 终端界面的 `/side`、`/btw`（`codex-rs/tui/src/app/side.rs`）：`fork` 用稳定的 `thread/fork`——`threadId` 是被分的 thread，`ephemeral: true`（不落盘），模型、Provider、`cwd`、审批与沙箱和 `thread/start` 一样按会话的配置给（经网关的会话带上 Provider 条目的 `config` 覆盖，§5）；被分的 thread 有回合在进行时带 `lastTurnId`（适配器记下的最近一个结束的回合），只分到那里。返回的 thread 是新的引擎会话，适配器像 `thread/start` 一样订阅它，再用 `thread/inject_items` 补一条 user 消息作“支线边界”：之前的历史只作参考，不要接着做主线的事，只答边界之后的问题，不派子 agent，不改文件，除非用户在支线里明确要求（措辞是 Wevir 自己的，`side.ts`）。主 thread 不受影响。

rust-v0.162.1 实测（`codex-adapter.side.integration.test.ts`）：支线的请求里依次是主线的说明（base.md、权限、环境，环境会话的额外目录说明也在其中）、继承的对话、边界消息、支线的问题；fork 时给的 `developerInstructions` 不进继承的上下文（终端界面也给，同样无效），所以支线说明全靠边界消息。主线回合进行中分出的支线不含进行中的那个回合；之后主线的请求里没有支线的内容。

主 thread 还没有完成的回合时 Host 不调 `fork`（Codex 在没有第一条用户消息时 fork 失败）。临时 thread 在 app-server 进程退出后就没了：Host 重启或进程重启后恢复报 `no rollout found`（§6.3 的 `session_lost`），支线变只读。

### 6.10 读历史的工具（0.25.0，接力）

会话从别的来源接力过来时（domain-model §3.14），摘要每条只有 240 字，模型要原文时用 Wevir 的读历史服务 `wevir_history`（`@wevir/runtime-adapter/history-tool`，stdio、只用 Node 内置模块，读 Host 写的 `<数据目录>/history/<会话 ID>.json`）。Host 给 `CodexRuntime` 一个 `historyTool`（脚本位置、历史目录、运行它的 Node），每次启动 codex-app-server 之前把脚本写进 `<数据目录>/mcp/wevir-history.mjs`，两种进程的 config.toml 都登记 `[mcp_servers.wevir_history]`：`command` 是 Host 自己的 Node，`args` 是脚本与历史目录，`env = { ELECTRON_RUN_AS_NODE = "1" }`，`default_tools_approval_mode = "approve"`，`enabled_tools = ["read_session_history"]`。每个会话都看得到这个工具（没接力过的会话调它只得到“没有历史”）。

实测（rust-v0.162.1，经网关的 mock 模型，2026-10-15）：模型看到命名空间 `mcp__wevir_history` 里的 `read_session_history`；调用不出审批，`mcpToolCall` 完成后输出是历史的 JSON（`total`、`items`、`nextPosition`）。接力回来的 thread 是 `thread/resume` 恢复的原来那个，下一条用户消息开头是 `Context handoff (delta_since_target_last_seen)` 的摘要。

### 6.11 应用级工具（0.30.0）

Host 的 `wevir` MCP 服务（domain-model §3.15）是 HTTP 的、每个会话一个令牌，不能像 §6.8、§6.10 那样写进进程共用的 config.toml。`thread/start`、`thread/resume` 与 `thread/fork` 都接受 `config` 覆盖（app-server-protocol `v2/thread.rs`），`#threadSettings` 在会话带 `SessionConfig.appTools` 时往里加 `mcp_servers.wevir`（`config.ts` 的 `appToolsConfig`）：`url`，`http_headers = { Authorization = "Bearer <令牌>" }`（Codex 不接受 HTTP 服务的行内 `bearer_token`，`bearer_token_env_var` 又是整个进程共用），`startup_timeout_sec = 10`，`tool_timeout_sec = 660`（`wevir_session_wait` 最多等 10 分钟），`default_tools_approval_mode = "auto"`。thread 还挂在 app-server 里时 `thread/resume` 的覆盖被忽略，令牌在 Host 运行期间不变，所以不受影响；Host 重启后 app-server 也是新的。

批准：`auto` 时 Codex 对只读的工具（`readOnlyHint`）、或既不破坏也不对外（`destructiveHint` 与 `openWorldHint` 都是 false）的工具直接调；其余按 thread 的审批策略：`never` 且完全访问时直接调，否则发服务端请求 `mcpServer/elicitation/request`（功能 `tool_call_mcp_elicitation`，稳定、默认开）。它的 `_meta.codex_approval_kind` 是 `mcp_tool_call`，表单没有字段，也不带 item id。适配器只认 `serverName` 是 `wevir` 的这种请求（别的回 `decline`，Wevir 不显示 MCP 表单），属于挂着的会话进行中的回合时上报为 `approval.requested`：`toolCallId` 是这个 thread 里还没完成的 `wevir` 的 `mcpToolCall`（调用在请求之前已经以 `item/started` 报出，mapping 的 `openMcpCall`），选项只有 `accept`（允许）与 `decline`（拒绝），回复分别是 `{ action: 'accept', content: {} }` 与 `{ action: 'decline' }`；回合取消时同别的审批一样不回复（`NO_REPLY`，app-server 自己收回）。之前没有处理这个请求时，它回 METHOD_NOT_FOUND，Codex 当作拒绝。`mcpServer/startupStatus/updated` 里 Wevir 自己的三个服务（`wevir_tasks`、`wevir_history`、`wevir`）正常启动不出事件。

实测（rust-v0.162.1，经网关的 mock 模型，测试里的 HTTP MCP 服务扮演 Host，`codex-adapter.app-tools.integration.test.ts`，2026-10-16）：模型看到命名空间 `mcp__wevir` 里的工具，`tool.started` 的工具名是 `mcp__wevir__wevir_session_list`；请求带这个会话的令牌；请求批准时只读的工具不问，`wevir_session_create` 先出审批、允许后才调用、拒绝时不调用；完全访问时不问。

0.33.0 的浏览器工具（domain-model §3.15.1）同在 `wevir` 服务里，只读的五个带 `readOnlyHint`，不问。Codex 把 MCP 工具结果交给模型时，有 `structuredContent` 就只把它序列化成文本、丢掉内容项（codex-rs protocol 的 `CallToolResult::as_function_call_output_payload`），所以浏览器工具的结果只给文本与图片，截图才能作为图片到达模型。

### 6.12 联网工具（0.34.0）

Wevir 自己的联网工具 `wevir_web`（docs/architecture/web-tools.md）：桥脚本 `<数据目录>/mcp/wevir-web.mjs`（`@wevir/runtime-adapter/web-tool`，stdio、只用 Node 内置模块）把 `tools/call` 转给 Host 进程里的端点，搜索与抓取都在 Host 里做。`CodexRuntime` 拿到 Host 给的 `webTool`（脚本位置、运行它的 Node、`endpoint()` 与 `state()`），每次启动 codex-app-server 之前写脚本，把端点的令牌放进进程环境的 `WEVIR_WEB_TOKEN`，config.toml 登记：

```toml
[mcp_servers.wevir_web]
command = "<Host 的 Node>"
args = ["<数据目录>/mcp/wevir-web.mjs", "http://127.0.0.1:<端口>"]
env = { ELECTRON_RUN_AS_NODE = "1" }
env_vars = ["WEVIR_WEB_TOKEN"]
default_tools_approval_mode = "approve"
enabled_tools = ["web_search", "web_fetch"]   # ChatGPT 进程只有 "web_fetch"
startup_timeout_sec = 10
tool_timeout_sec = 60

[mcp_servers.wevir_web.tools.web_search]
output_token_limit = 4000

[mcp_servers.wevir_web.tools.web_fetch]
output_token_limit = 12000
```

- `env_vars` 让 Codex 把自己环境里的这个变量转给 MCP 服务（rmcp-client `create_env_for_mcp_server`：默认只转 HOME、PATH 等几个），令牌不进文件；`shell_environment_policy` 排除 `WEVIR_*`，模型跑的命令看不到它。
- 每个会话的 `thread/start` / `thread/resume` 按 `state()` 覆盖 `mcp_servers.wevir_web.enabled` 与 `enabled_tools`（`webToolThreadConfig`）：联网关着时 `enabled = false`，没配所选搜索服务的 Key 时只有 `web_fetch`。ChatGPT 会话另外覆盖 `web_search`：联网开着 `cached`、关着 `disabled`（web-tools.md §5.2）。进程启动时没拿到端点（Host 还没监听）就不登记，也不发覆盖（`--strict-config` 下给没登记的服务发覆盖会出错）。
- 展示：`server` 是 `wevir_web` 的 `mcpToolCall`，`web_search` 报 `search`（摘要与 `query` 是查询词），`web_fetch` 报 `fetch`（摘要与 `url` 是网址）；输出取 MCP 结果里的文字段落，不是整个结果的 JSON。

实测（rust-v0.162.1，经网关的 mock 模型与假端点，2026-10-15，`codex-adapter.web.integration.test.ts`）：`--strict-config` 接受上面的配置（含 `env_vars`、`tool_timeout_sec` 与每个工具的 `output_token_limit`）；模型看到命名空间 `mcp__wevir_web` 里的两个工具；调用不出审批，桥脚本带着 `Bearer <令牌>` 把 `{ name, arguments }` 发到端点，回答作为工具结果回到模型；`thread/start` 的覆盖只影响那个会话——没有 Key 时请求里只有 `web_fetch`，关着时两个都没有，托管的 `web_search` 也没有。

### 6.7 回合失败的归类（`turn-error.ts`）

`turn/completed` 的 `turn.error` 带 `codexErrorInfo`（v2/CodexErrorInfo.ts：字符串，或带上游 `httpStatusCode` 的对象）。所有 Provider 都经网关：网关把上游的状态码原样转给 Codex，自己拒绝的请求带 `wevir gateway:` 前缀的原文。自上而下第一条匹配的生效；`message` 始终是完整原文，`code` 是上游的 HTTP 状态码（有时）。

| 类别 | 条件 | 例子（样本 `errors/turn-*.json`） |
|---|---|---|
| `missing_credentials` | 原文含 `wevir gateway: Provider … 没有 API Key`（网关在 Provider 没有 Key 时回 401） | `turn-missing-key`：`httpConnectionFailed`（401） |
| `provider` | `codexErrorInfo` 是带 `httpStatusCode` 的变体（`httpConnectionFailed`、`responseStreamConnectionFailed`、`responseStreamDisconnected`、`responseTooManyFailedAttempts`），不论状态码 | `turn-401`（Key 无效）、`turn-429`（重试用完）、`turn-unreachable`（网关连不上上游，502） |
| `provider` | 字符串：`unauthorized`、`badRequest`、`internalServerError`、`serverOverloaded`、`rateLimitExceeded`、`usageLimitExceeded`、`contextWindowExceeded`、`flexUnavailable`、`cyberPolicy`、`misalignmentPolicyViolation` | `turn-500`：`internalServerError`（Codex 换成了自己的说明，上游原文不在） |
| `provider` | `other`，而原文是上游的 JSON 错误体（`{"error": …}`，Codex 对 400 等直接给出响应体） | `turn-400`、`upstream-error.jsonl` |
| `unknown` | 其余：`sandboxError`、`threadRollbackFailed`、`tooManyDenials`、`other` 的其他原因、没有 error | — |

401 是 Key 无效，归 `provider`，与 dsh 相同（acp-event-mapping.md §3）。`error` 通知带 `willRetry: true` 的只留 engine.raw（§6.1），回合失败以随后的 `turn/completed` 为准。样本由 `record-app-server.test.ts` 用真实二进制 + 网关 + mock 上游录制，`turn-error.test.ts` 逐条核对；Codex 改了 `codexErrorInfo` 或措辞时先在那里失败。

## 7. 测试

三层契约测试照 adapter-dsh（ADR-0005 决策 7），三层跑同一套 `runAdapterContract`（`@wevir/runtime-adapter/contract`），能力开关全开（`capabilities.ts`）：

| 层 | 文件 | 内容 |
|---|---|---|
| 契约第 1 层：录制回放 | `codex-adapter.contract.test.ts` | 适配器用 node 跑 `test-fixtures/fake-app-server.mjs`（`binaryArgs`），它回放真实二进制录的样本：plain 是 `stream`，toolCall 是 `tool-shell`，approval 是 `approval-exec` 到审批请求为止、再按回复接 accept / decline / cancel 分支，审批挂起时取消接 interrupt 分支；有过回合的 thread 记在 CODEX_HOME，进程被杀后能恢复，没见过的回放真实的 `no rollout found`。子会话与插话的条款跳过（`subagents: false`：假的 app-server 只回放子 thread 的通知，不模拟子 thread 的审批与中断；`steer: false`：没有录 `turn/steer`）。不需要二进制、模型或 Key，CI 默认跑 |
| 契约第 2 层 | `codex-adapter.contract.integration.test.ts` | 真实 `codex-app-server` + 网关（Responses 透传）+ mock 模型；审批用例让 mock 调一次越出沙箱的 `touch`（工作区外、且不在系统临时目录）；子会话用例让父 agent spawn → wait，子 agent 一问一答或请求审批；插话用例（R11）在 mock 的慢回答（“慢”）流出时 `steer`，等它流完再进同一回合，回合之外 `steer` 报 `steer_rejected` 后照常 `send`（Host 据此排队） |
| 契约第 3 层 | `codex-adapter.contract.real.integration.test.ts` | 真实二进制 + 网关 + 真实模型：`WEVIR_TEST_API_KEY` 与 `WEVIR_TEST_PROVIDER`（`deepseek-official`，或 `openai-compatible` 另加 `WEVIR_TEST_BASE_URL`、`WEVIR_TEST_MODEL`、`WEVIR_TEST_API`），没有就跳过并打印原因；保留 Codex 自己的重试；不进 CI |
| 映射单元测试 | `mapping.test.ts` | 回放 `test-fixtures/app-server/` 的通知样本（一问一答、只读 / 搜索 / 普通命令、补丁、上游 400、流式中途取消、子 agent、计划）与审批对话（命令的四个分支、补丁的两个分支），另有边界情况 |
| 归类单元测试 | `turn-error.test.ts`、`resume-error.test.ts`、`title.test.ts` | 回合失败与恢复失败的样本逐条归类；最低推理档位、临时 thread 的结果 |
| 其他单元测试 | `tool-display.test.ts`、`config.test.ts`、`prompts.test.ts`、`env.test.ts`、`paths.test.ts` | 展示类型、生成的配置与模型目录、base.md 渲染、白名单环境、二进制解析与版本核对 |
| 集成测试 | `codex-adapter.integration.test.ts` | 握手、会话与基础提示词、新增 Provider 不重启、模型目录变了空闲时重启 / 等回合结束、版本核对 |
| 子会话 | `codex-adapter.subagent.test.ts`（回放）、`codex-adapter.subagent.integration.test.ts`（真实二进制） | §6.5：回放三个子 agent 样本（含按 rootTurnId 认出），`thread/read` 不可用时降级；spawn → wait、不等子 agent、`close_agent`、取消父回合时子 agent 不受影响、notFound 不认 |
| 审批 | `codex-adapter.approval.integration.test.ts` | 详情与理由、四个决定、本会话同意后不再问、补丁的“告诉它换个做法”、审批挂起时取消（之后到的 `serverRequest/resolved` 没有多余事件与告警）、工作区内不需要审批 |
| 恢复与取消 | `codex-adapter.resume.integration.test.ts` | 关闭后恢复、换进程后恢复且下一回合带完整历史、`not_found` 与 `corrupted`、没对话过的会话、`cancel_unconfirmed` 时重启并能恢复 |
| 计划、提问、错误、标题 | `codex-adapter.turn.integration.test.ts` | `todo.updated`；提问（U11：mock 模型调 `request_user_input`，回答回到模型、回合接着做，开发中功能的 warning 不出现）；缺 Key / 401 / 400 的归类、标题经网关与经临时 thread |
| 建议的后续任务 | `suggest-tasks.test.ts`、`codex-adapter.tasks.integration.test.ts` | §6.8：MCP 脚本的 initialize / tools/list / tools/call、两种 config.toml 的登记、参数的整理与映射；真实二进制下模型看到 `mcp__wevir_tasks` 里的 `suggest_tasks`、调用不问用户、完成后紧跟 `tasks.suggested`、MCP 服务正常启动不出 `engine.raw`；`injectNote` 不开回合、下一次请求里有它 |
| 压缩与审查（0.24.0） | `codex-adapter.command.integration.test.ts` | §4.9：`compact` 的回合里 manual 的 compacting / compacted、压缩请求不带工具、之后照常；上下文窗口 1100 时第二个回合开始前自动压缩（auto）；`review` 的未提交改动与基础分支，结构化的 findings 渲染进助手消息、没有 `engine.raw`；`compact` 之后马上取消，回合 ID 到了才中断、以 cancelled 结算 |
| 支线会话 | `codex-adapter.side.integration.test.ts` | §6.9：支线的请求里有主线的历史、边界消息在它们之后、问题在最后，主线的请求里没有支线的内容；主线回合进行中分出的支线不含进行中的回合；换进程后支线恢复报 `session_lost`、主线照常恢复 |
| 外连、密钥与 skills | `codex-adapter.isolation.integration.test.ts` | 改写自 Spike 的 `network-audit.ts` 与 secrets 场景，另加 §1.3 的 skills 回归：没有 Provider 只启动进程、有 Provider 跑一个带工具调用的回合，经只记录目标的代理与 lsof 看外连为零（反例：打开 plugins 时抓到 chatgpt.com、github.com、api.github.com）；网关令牌与上游 Key 不在数据目录的任何文件、stderr 与日志里；模型跑的命令看不到 `WEVIR_*` |
| ChatGPT 进程（R6） | `account.test.ts`（假的 app-server，状态机与 `model/list` 的换算）、`codex-runtime.chatgpt.integration.test.ts`（真实二进制 + `test-fixtures/mock-chatgpt.ts` 的登录服务与后端） | §8：没登录时 ChatGPT 会话建不起来；设备码登录 → 邮箱、套餐与用量 → `model/list` → ChatGPT 会话落在 ChatGPT 进程、网关会话照旧在网关进程 → 登出（凭据删除、令牌吊销）；浏览器登录（回调打到本机 1455）与取消；`auth.json` 0600 只在 ChatGPT 进程的目录；外连经拒绝的代理只剩 chatgpt.com |
| Host | `packages/host/src/cli.codex.integration.test.ts`、`cli.codex.subagent.integration.test.ts`、`cli.codex.pending.integration.test.ts` | `wevir-host`（默认引擎就是 codex）：provider.upsert、一问一答、一次工具调用、模型生成的标题与旧客户端的降级、SIGTERM 回收；子会话（派出、子会话的审批经父会话处理、取消父会话时级联取消）；插话与排队（R11：慢回合里插话一次，等慢回答流完再进同一回合；排队一次，回合结束后作为下一回合发出） |

二进制不在时第 2、3 层与集成测试跳过并打印下载命令；CI 下载并缓存二进制，macOS 与 Windows 都跑。录样本：`WEVIR_RECORD_CODEX=1 pnpm vitest run --project adapter-codex record-app-server`（升级 Codex 后重录，再看映射、归类测试与第 1 层；`-t` 可以只录其中一组）。Codex 升级的完整步骤见 docs/upstream/UPSTREAM.md「Codex 升级检查清单」。

## 8. ChatGPT 进程与账号（R6，`account.ts`、`codex-runtime.ts`）

ADR-0005 决策 4 第 ① 行：ChatGPT 订阅经 app-server 自己的 `account/*` 登录，模型流量由 Codex 直连 OpenAI，不经网关。

### 8.1 为什么是第二个进程

网关进程写了 `model_catalog_json`（apply_patch、上下文、base.md 都靠它，§3），而 Codex 只要有这个键就整体换成静态目录（`model-provider/src/provider.rs` 的 `create_models_manager` 直接建 `StaticModelsManager`）：`model/list` 只剩 Wevir 的模型，OpenAI 模型拿不到 Codex 按模型调好的元数据与提示词。目录只在进程启动时读一次（§5.2），按会话覆盖无效。R6 在真实二进制上核实了这一点，维护者定了两个进程（ADR-0005 补记 10）。

| | 网关进程 | ChatGPT 进程 |
|---|---|---|
| `CODEX_HOME` | `<数据目录>/engines/codex` | `<数据目录>/engines/codex-chatgpt` |
| Provider | 每个 Wevir Provider 一个 `wevir_<id>`，`base_url` 指向网关 | Codex 内置的 `openai`（`model_provider = "openai"`） |
| 模型目录 | Wevir 生成的 `wevir-models.json` | Codex 自己的：没登录时是二进制里打包的，登录后从 `<chatgpt_base_url>/codex/models` 按账号取 |
| 基础提示词 | `prompts/base.md`（`baseInstructions`） | Codex 内置的（不覆盖） |
| 环境 | 白名单 + `WEVIR_GATEWAY_TOKEN` | 白名单，没有网关令牌 |
| 凭据 | 没有 | `auth.json`（0600，§8.2） |
| 会话标题 | 经网关直接请求 | 临时 thread（§4.4） |

`CodexRuntime` 按 Provider 的种类把会话交给其中一个进程（`kind: 'chatgpt'` → ChatGPT 进程），之后的调用按引擎会话 ID 找回它（子会话由派出它的进程认出，`hasSession`）；`configureProviders` 把 `chatgpt` 类 Provider 交给 ChatGPT 进程、其余交给网关进程，`validateProvider` 与 `testProvider` 同理。两个进程都在第一次用到时才启动：只用 ChatGPT 的用户不起网关进程，反之亦然。

### 8.2 ChatGPT 进程的配置（`renderChatgptConfigToml`）

§3 的加固项照写，另外：

- `cli_auth_credentials_store = "file"`：凭据存在 `CODEX_HOME/auth.json`（Codex 以 0600 写入），与 Wevir 的 `secrets.json` 同一个保护级别，不碰系统钥匙串（docs/security.md §3）。Codex 另有 `keyring`、`auto`、`ephemeral`；Wevir 迁到系统钥匙串时（ADR-0003 未决事项）再一起换。
- `forced_login_method = "chatgpt"`：只允许 ChatGPT 登录。
- `mcp_oauth_credentials_store = "file"`：MCP 的 OAuth 凭据默认 `auto`，会先试钥匙串（R6 在日志里看到它尝试），同样改成文件。
- `[features] apps = false`（两个进程都写）：ChatGPT 登录后 Codex 会连 ChatGPT 的应用（connectors）MCP（`POST <chatgpt_base_url>/ps/mcp`），把连接器的工具给模型。Wevir 不支持，关掉（R6 用 mock 后端实测关掉后不再请求）。
- 不写 Wevir 的 Provider、模型目录与网关令牌。

测试用的 `chatgptEndpoints`（`{issuer, backend}`）把登录服务与后端指向本机 mock：`issuer` 经 app-server 的环境变量 `CODEX_APP_SERVER_LOGIN_ISSUER` 与 `CODEX_REFRESH_TOKEN_URL_OVERRIDE`，`backend` 写进 `chatgpt_base_url` 与 `openai_base_url`。产品代码不设它。

### 8.3 账号：`account/*` → `AccountState`

全部在稳定面（`common.rs` 里没有 `#[experimental]`，只有 `chatgptAuthTokens` 与 Bedrock 两种登录是实验的，Wevir 不用）。R6 在真实二进制上核实（没登录的部分直连 OpenAI；登录成功之后的部分用 `test-fixtures/mock-chatgpt.ts` 扮演登录服务与后端）：

| app-server | 行为（实测） | Wevir |
|---|---|---|
| `account/read {}` | 没登录：`{account: null, requiresOpenaiAuth: true}`（网关进程里是 `false`，它的 Provider 不要 OpenAI 认证）；登录后 `{account: {type: "chatgpt", email, planType}}`，要先请求 `<backend>/wham/accounts/check`（工作区路由，只接受 https 的源，连不上时报 `workspace routing discovery failed`） | `signed_out` / `signed_in`（`email`、`plan`）；读失败时用上次的状态 |
| `account/rateLimits/read` | 没登录：`-32600 codex account authentication required to read rate limits`；登录后 `rateLimits.primary`（5 小时）与 `secondary`（每周）：`usedPercent`、`windowDurationMins`、`resetsAt`（Unix 秒），请求 `<backend>/wham/usage` 与 `/wham/rate-limit-reset-credits` | `rateLimits`（尽力而为，读不到就不带；`resetsAt` 换成 ISO 时间）；`account/rateLimits/updated` 是稀疏更新，合进去 |
| `account/login/start {type: "chatgpt"}` | 立即返回 `{loginId, authUrl}`，app-server 在 `127.0.0.1:1455` 起回调服务；`authUrl` 是 `https://auth.openai.com/oauth/authorize?…&redirect_uri=http://127.0.0.1:1455/auth/callback&…&originator=wevir`。浏览器回调后它用授权码换令牌，再用 token-exchange 换一个 API Key，把浏览器带到本机的 `/success`，加载了才算完成；超时由 app-server 定 | `signing_in`，`login.authUrl`；桌面端交给系统浏览器（`openExternal`），浏览器要在 Host 这台机器上 |
| `account/login/start {type: "chatgptDeviceCode"}` | 先请求 `<issuer>/api/accounts/deviceauth/usercode`（连不上就是 JSON-RPC 错误），返回 `{loginId, verificationUrl: "https://auth.openai.com/codex/device", userCode}`；之后按 `interval` 轮询 `…/deviceauth/token`（15 分钟内） | `signing_in`，`login.verificationUrl` 与 `userCode`；CLI 只用这种 |
| `account/login/cancel {loginId}` | `{status: "canceled"}`，随后 `account/login/completed {success: false, error: "Login server error: Login was not completed"}`（设备码是 `"Login was not completed"`），1455 端口随即关闭；ID 对不上是 `notFound`，不是 UUID 是 `-32600 invalid login id` | 先回到原来的状态，随后的失败通知不记错误 |
| 再次 `account/login/start` | 新的替换旧的：旧的以 `success: false` 结束 | 同上，旧的不记错误 |
| `account/login/completed {loginId, success, error}` | 成功后紧跟 `account/updated {authMode: "chatgpt", planType}` | 成功就重读账号；失败把原文记进 `lastError` |
| `account/logout` | `{}`，随后 `account/updated {authMode: null, planType: null}`；删除 `auth.json`，并向 `<issuer>/oauth/revoke` 吊销刷新令牌（失败也照样删）；没登录时同样成功 | `signed_out` |
| `model/list {}` | 没登录：二进制里打包的列表（不联网）；登录后从 `<backend>/codex/models?client_version=…` 按账号取，取不到退回打包的。`supportedReasoningEfforts` 里可能有 Wevir 没有的档位（`ultra`） | `accountModels`：`model` 作 ID、显示名、`inputModalities` 含 image 时 `supportsImages`、只留 Wevir 认得的推理档位（`none` → `off`），默认取 `isDefault` |

进程退出时进行中的登录随之没了（登录任务在 app-server 里），`lastError` 记一条“登录没有完成”。

### 8.4 会话

- ChatGPT 会话（`providerId` 的 Provider 是 `chatgpt` 类）：`thread/start` / `thread/resume` 带 `model`、`modelProvider: "openai"`、审批与沙箱，`config` 只有推理档位（`chatgptThreadConfig`），不覆盖 `baseInstructions`。模型不在 Provider 存的列表里时照样交给 Codex（列表随账号变化，可能过期）。
- **没登录时不建 thread、不开回合**：`createSession`、`resumeSession`、`send` 之前看账号状态（缓存，没读过就读一次），不是已登录就报 `missing_credentials`（Host 归为 `missing_credentials`）。实测没登录的 ChatGPT 进程会拿着空凭据向 `api.openai.com/v1/responses` 预连 websocket 并重试五次，这样也就不发生。
- 登录后的 `thread/start` 会按工作区路由预连 `wss://chatgpt.com/backend-api/codex/responses`（R6 实测，测试里被代理拒绝），回合走同一个地址。
- 标题：临时 thread（§4.4），用会话的模型。

### 8.5 外连

网关进程不变（§3，外连为零；没有 ChatGPT 凭据，`account/*` 与 `model/list` 都不联网）。ChatGPT 进程：

| 时机 | 目标（实测或由 mock 核实的路径） |
|---|---|
| 启动（已登录） | `chatgpt.com`：`/backend-api/codex/models`（这一次的 `originator` 与 User-Agent 是 Codex 默认的 `codex_cli_rs`：它在 `initialize` 之前发出，Wevir 改不了），`/backend-api/wham/accounts/check` |
| 设备码登录 | `auth.openai.com`：`/api/accounts/deviceauth/usercode`、`/deviceauth/token`（轮询）、`/oauth/token` |
| 浏览器登录 | 用户的浏览器访问 `auth.openai.com`；app-server 访问 `auth.openai.com/oauth/token`（换令牌与 token-exchange） |
| 读账号、用量 | `chatgpt.com`：`/backend-api/wham/accounts/check`、`/wham/usage`、`/wham/rate-limit-reset-credits` |
| 会话与回合 | `chatgpt.com`：`wss://…/backend-api/codex/responses`（不行时 https） |
| 刷新与吊销令牌 | `auth.openai.com`：`/oauth/token`、`/oauth/revoke` |

除了启动时那一次模型列表，发往 ChatGPT 后端的请求 User-Agent 都以 `wevir/<版本>` 开头、`originator: wevir`（`clientInfo.name`，codex-notes §4.1）。用真实账号登录后的外连审计（代理放行并记录主机）结果写在 codex-notes §4.1。

## 9. 留给后续任务

- ~~R4：子 thread 改为子会话（§6.5），子 agent 的审批在父会话里处理（§6.6）~~ 已做。子会话要不要单独的停止按钮（Codex 终端界面允许直接中断子 agent）留给维护者；`send_input`、`resume_agent` 让子会话再开始回合已按 C2 / C5 处理，但没有录到样本。
- ~~R6：ChatGPT 登录的会话不经网关，标题走临时 thread（§4.4 的 `titleVia`）~~ 已做（§8）。ChatGPT 会话的回合没有自动化测试（工作区路由要求 https 的后端，mock 不了），靠维护者用真实账号验收。
- “以后以这个前缀开头的命令不再问”（execpolicy 修订）与网络策略修订：要 Host 记规则（§6.6）。U15 起审批卡片只给“拒绝 / 允许”，长期放开改用权限模式（§4.7）。
- 自动批准的审查结论（`item/autoApprovalReview/completed` 的 `riskLevel`、`rationale`）投影到对应工具的那一行，以及审查拒绝后用户再批准（`thread/approveGuardianDeniedAction`）：U15 没做（§4.7）。
- ~~`turn/steer`（回合进行中追加输入）~~ R11 已接上（§4.5）。
