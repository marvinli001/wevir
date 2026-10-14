# OpenAI Codex 研读与 app-server Spike：Wevir 自己的 Agent 运行时

> 日期：2026-10-14 · 上游：`upstream/codex` @ `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`（tag `rust-v0.162.1`，2026-10-14 时的最新 release）· 代码与结果：[`spikes/codex-app-server/`](../../spikes/codex-app-server/) · 设计草案：[ADR-0005](../adr/0005-agent-runtime-and-model-gateway.md)
>
> 结论先行：
> - **`codex app-server` 可以作为 Wevir 的默认引擎。** 锁定版本的独立二进制配合本地 mock，流式、apply_patch、两类审批、跨回合推理、子 agent、取消、resume、计划、报错恢复、密钥隔离全部跑通（12 个场景 × 3 种接法，155 项检查，全部通过）。
> - **Host 里的模型网关可行，不用 fork Codex。** 最小网关（约 490 行）把 Codex 的 Responses 请求转成 Chat Completions，同一组场景全部通过；Responses 原生的上游也经网关透传，Key 留在 Host，Codex 只拿到一次性令牌。
> - **订阅登录：** ChatGPT 订阅可以走 app-server 自己的登录，但限于本地开源应用。Google 已在 2026-06-18 停掉 Gemini CLI 面向个人、AI Pro 与 Ultra 的“Login with Google”，第 3 优先级按原设想做不了。xAI 有官方 CLI（Grok Build），支持 ACP，也能用订阅登录。
> - **真实 DeepSeek 上三种接法都跑通**（2026-10-14，§7.3）：apply_patch、跨回合推理、子 agent、取消在直连 Responses、经网关透传、经网关转 Chat 三条路上全部正常；`deepseek-flash` 与 `deepseek-v4-pro` 都能用。

## 0. 怎么读

- 路径不带仓库名的，都相对于 `upstream/codex/codex-rs/`（锁定提交下）；“Spike”指 `spikes/codex-app-server/`，每项检查的原始结果在 `fixtures/results.json`。
- 网上资料都在 2026-10-14 读取，来源列在 §12。没能确认的写“未核实”。
- 上一个会话的英文报告（`815ef9b`，`main` 上 10-13 的提交）在本次锁定的 release 提交上重新核对过；两者有出入的地方以本文为准。

## 1. 版本、许可与体积

| 项 | 值 | 依据 |
|---|---|---|
| 最新 release | `rust-v0.162.1`（2026-10-09），release 提交不在任何分支上：与 `main` 分叉，领先 4 个、落后 245 个提交 | GitHub API |
| 许可 | Apache-2.0，带 `NOTICE`（OpenAI 版权与 Ratatui 署名）；Linux 包随附的 `bwrap` 是 LGPL-2.0-or-later | [UPSTREAM.md §2.4](../upstream/UPSTREAM.md) |
| 独立 `codex-app-server` 二进制（macOS arm64） | 压缩包 tar.gz 72 MiB / zst 51 MiB；**解压后 181 MiB**（189,393,536 字节） | Spike `fetch-binary.sh` 实测 |
| 其他平台（tar.gz） | macOS x64 78 MiB、Linux x64 musl 82 MiB、Linux arm64 76 MiB、Windows x64 82 MiB（exe 解压后 243 MiB）、Windows arm64 75 MiB | GitHub API 的资产大小 |
| 冷启动 | 从 spawn 到 `initialize` 响应：5 次 47–203 ms，中位 49 ms | Spike 实测 |
| 内存 | `initialize` 后 RSS 50 MB；开 4 个 thread、跑 3 个回合后 93 MB | Spike 实测（`ps -o rss`） |
| 更新节奏 | 2026-01-06 的 0.78.0 到 2026-10-09 的 0.162.1，9 个月约 85 个小版本；同期删掉了 Chat 接口（02-03）、`codex mcp-server`（09-05）、`thread/rollback` | 上次报告；PR #10157、#42993 |

作为对照：Gemini CLI 0.64.0 的 npm 包解压后 98.6 MB（单个 bundle，要 Node ≥ 20）；Grok Build 的 darwin-arm64 二进制约 48 MB；dsh 的 npm 依赖闭包有 622 个包（UPSTREAM.md §2.1）。

## 2. app-server：接入面

### 2.1 传输与握手

- `codex-app-server [--listen stdio://]`，默认就是 stdio；逐行 JSON，形状像 JSON-RPC 2.0 但不带 `"jsonrpc"` 字段（`app-server-protocol/src/rpc.rs:1-2`）。独立二进制的帮助里没有 `generate-ts`，类型以锁定提交下 `app-server-protocol/schema/typescript/` 为准（完整的 `codex` CLI 才有 `codex app-server generate-ts`）。
- 握手：`initialize {clientInfo:{name,title,version}, capabilities:{experimentalApi, requestAttestation}}` → 响应 `{userAgent, codexHome, platformFamily, platformOs}`，再发通知 `initialized`。`clientInfo.name` 会成为发给模型服务的 `originator` 请求头和 User-Agent 前缀（`app-server/src/request_processors/initialize_processor.rs:130-131`），OpenAI 要求它写成应用自己的名字（§4.1）。
- 独立二进制默认 `--session-source vscode`；`--strict-config` 遇到未知配置键直接失败，Spike 用它确认了加固项的键名都存在。
- 进程回收：关 stdin 后 6 ms 内以退出码 0 退出（Spike `resume` 场景），与 adapter-dsh 的 EOF → SIGTERM → SIGKILL 顺序兼容。

### 2.2 Thread / Turn / Item

- `thread/start {cwd, model?, modelProvider?, approvalPolicy?, sandbox?, config?, baseInstructions?, developerInstructions?, ephemeral?}` → `result.thread.id`。`turn/start {threadId, input:[{type:"text", text, text_elements:[]}]}` → `result.turn.id`，**立即返回**，回合结果看 `turn/completed {threadId, turn:{status: completed|interrupted|failed, error}}`。这与 `AgentRuntimeAdapter.send` 的语义（引擎接受输入即返回）正好一致，不需要 adapter-dsh 那样绕开 ACP `session/prompt` 的阻塞。
- 一个回合里的通知（Spike `stream` 场景实测顺序）：`turn/started` → `item/started` / `item/completed`（userMessage）→ `item/reasoning/textDelta`… → `item/agentMessage/delta`… → `item/completed`（reasoning、agentMessage）→ `thread/tokenUsage/updated` → `turn/completed`。增量与已提交项共用 `itemId`，对齐是直接的，不需要 adapter-dsh 的 `DeltaMerger`。
- **原始推理默认就透出**：`show_raw_agent_reasoning` 不设时，DeepSeek 式的 `reasoning_text` 增量同样以 `item/reasoning/textDelta` 到达（Spike `stream-hidden-reasoning`）。
- 工具类 item：`commandExecution{command, cwd, status, commandActions, aggregatedOutput, exitCode, durationMs}`、`fileChange{changes[{path,kind,diff}], status}`、`mcpToolCall`、`dynamicToolCall`、`collabAgentToolCall`、`webSearch` 等；`status` 有 `completed` / `failed` / `declined`（Spike 实测 decline 后为 `declined`）。短命令的 `item/commandExecution/outputDelta` 可能一条也没有，输出只在 `aggregatedOutput` 里。
- 计划：`update_plan` 工具**默认关闭**，要 `tools.update_plan.enabled = true`（`core/src/config/mod.rs:2730-2736`）；打开后模型调用它，app-server 发 `turn/plan/updated`（Spike `plan`）。
- 中断后没提交的文本：取消发生在流式中途时，已发出的 `item/agentMessage/delta` 没有对应的 `item/completed`（Spike `cancel`）。这与 domain-model §6.3“interrupted 时保留已显示的增量”的约定相容。

### 2.3 审批

- 服务端向客户端发请求：`item/commandExecution/requestApproval {threadId, turnId, itemId, startedAtMs, kind, reason?, command?, cwd?, commandActions?, proposedExecpolicyAmendment?, …}`、`item/fileChange/requestApproval {threadId, turnId, itemId, startedAtMs, reason?, grantRoot?}`，另有 `item/permissions/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request`。
- 回复 `{decision}`：命令可以是 `accept`、`acceptForSession`、`decline`、`cancel`，或带 execpolicy / 网络策略修订的对象；文件改动是前四个。
- 什么时候会有审批（`approval_policy="on-request"` + `sandbox_mode="workspace-write"`，Spike 实测）：工作区内的补丁与沙箱内命令**不需要**审批；写工作区外的补丁、模型声明 `sandbox_permissions:"require_escalated"` 的命令需要。`acceptForSession` 之后同一命令不再询问。这比 dsh 只在“要越出沙箱”时才问的粒度细，界面上能看到命令原文、理由与解析后的动作。
- 审批收回：回合在审批未决时被 `turn/interrupt`，服务端发 `serverRequest/resolved`，**到达时间在 `turn/completed` 之后**（Spike 8 次全部如此）。适配器要在回合结算之后仍能把它映射为 `approval.cancelled`。
- 注意 workspace-write 默认把 `$TMPDIR` 与 `/tmp` 也列为可写（`thread/start` 响应里的 `sandbox` 有 `excludeTmpdirEnvVar`、`excludeSlashTmp` 两个开关），与 dsh 的行为相同。

### 2.4 子 agent

- 多 agent 默认开着：模型拿到一个 namespace 工具 `multi_agent_v1`，内含 `spawn_agent{message, items, fork_context, model, reasoning_effort}`、`send_input`、`resume_agent`、`wait_agent{targets, timeout_ms}`、`close_agent`（`core/src/tools/spec_plan.rs:1008-1057`）。模型必须带 `"namespace":"multi_agent_v1"` 调用。
- 子 agent 是独立的 thread。父 thread 上是两个 `collabAgentToolCall` item（`spawnAgent`、`wait`），带 `receiverThreadIds`、`agentsStates`（含子 agent 的最终回答）。
- **新 thread 自动挂到所有已初始化的连接**（`app-server/src/lib.rs:1291-1310`）：子 thread 的 `turn/started`、逐字增量、`item/completed`、`turn/completed` 都推到同一条连接上，按子 thread 的 `threadId` 区分；子回合的 `rootTurnId` 指向父回合。**子 thread 不发 `thread/started`**，父子关系要从 `collabAgentToolCall.receiverThreadIds` 或 `thread/read` 的 `parentThreadId` 得到。`thread/list {parentThreadId}` 要 `experimentalApi`（Spike `subagent`）。
- 子 agent 发给模型的请求带 `x-openai-subagent: collab_spawn` 请求头，走同一个 Provider、同一个模型（Spike 实测请求的 `model` 都是配置的模型）。
- 对 Wevir 的含义：`AgentEvent` 目前没有“子会话”的概念，要么把子 thread 的事件折叠成父会话里的一个工具卡片（最小改动），要么给协议加子会话（见 ADR-0005 未决事项）。ADR-0005 决策 6.1 选了子会话，R4 实现（codex-event-mapping.md §6.5）。
- **R4 补测（2026-10-14）**：父回合 `turn/interrupt` 不级联到子 thread（子回合照常跑完，子 thread 挂着的审批一直挂着，父回合的 `wait` 没有 `item/completed`）；对子 thread `turn/interrupt` 才结束子回合；`close_agent` 中断子回合并卸载子 thread；`wait_agent` 一个不存在的 ID 时 `item/started` 就列出它、`item/completed` 的 `agentsStates` 报 `notFound`；子 thread 的 `turn/started` 可能早于父 thread 上 spawn 的 `item/completed`。`thread/read` 子 thread 能拿到 `parentThreadId`、`agentNickname`、`agentRole`（都是稳定字段）。Wevir 由 Host 级联取消（domain-model §4.5）。

### 2.5 resume、fork 与持久化

- `CODEX_HOME` 下有 `sessions/YYYY/MM/DD/rollout-*.jsonl`（会话日志）和 7 个 SQLite 库（`state_5`、`logs_2`、`goals_1`、`memories_1`、`queue_1`、`thread_history_1` 等），首次启动还会写 `installation_id`、`skills/.system`（内置 skill 样例）、`shell_snapshots/`。
- 关掉进程再起一个，`thread/list` 能看到旧 thread，`thread/resume {threadId}` 后下一回合的模型请求带着完整历史（Spike `resume`）。不存在的 thread 报 `-32600 no rollout found for thread id …`，可以映射为 `session_lost`。
- 另有 `thread/fork`、`thread/archive`、`thread/name/set`、`thread/compact/start`、`turn/steer` 等，本次没有逐个验证。

### 2.6 稳定性

- 锁定版本的客户端请求约 173 个，其中约 69 处标 `#[experimental]`（`app-server-protocol/src/protocol/common.rs`；上次报告在 `main` 上数的是 175 / 67），要 `initialize` 时声明 `experimentalApi:true` 才能用；CLI 帮助里 app-server 本身仍标 `[experimental]`。Spike 全程用 `experimentalApi:false`，§7 的功能都不依赖实验面；需要实验面的有 `thread/list.parentThreadId`、`dynamicTools`、`multiAgentMode` 等。
- 升级时要做的：用新版本的 schema 与旧版本 diff、重跑 Spike 式的契约测试（真实二进制 + mock 模型），见 ADR-0005 §7。

### 2.7 Codex 自己的客户端怎么做（终端界面）

Codex 桌面端与 IDE 插件不开源；`codex-rs/tui` 是开源的，它和桌面端一样是 app-server 的客户端，交互语义可以照着看（路径相对于 `codex-rs/tui/src/`）：

- **它打开了实验面**：每条连接都发 `experimentalApi:true`（`lib.rs:501-508`）。它的子 agent 选择器靠 `thread/list` 的 `parentThreadId` / `ancestorThreadId` 与 `Thread.canAcceptDirectInput`，都是实验字段。Wevir 只用稳定面（ADR-0005 决策 5），子会话从 `collabAgentToolCall` 与子 thread 的事件识别，重启后靠 Host 自己的记录，不需要这几个字段。审批请求里的 `availableDecisions` 也是实验字段，Wevir 拿不到，用默认的四个选项。
- **子 agent**：父消息流里是一行行的“Spawned 〈昵称〉[角色]（模型 强度）└ 任务”“Waiting for …”“Finished waiting └ 〈昵称〉: Completed - 〈结果〉”“Closed …”（`multi_agents.rs:204-285,335-458`）；标签用昵称与角色，不用 thread 名称。子 thread 只能看：输入框提示“由父 agent 控制，不能直接输入”，但 Esc 可以直接中断它当前的回合（`app/thread_routing.rs:665-735`）。子 agent 的审批会冒到当前视图里，带“Thread: 〈名字〉”和“o 打开该 thread”（`bottom_pane/approval_overlay.rs:651-705`）。
- **审批选项与说法**：命令是“是，继续”（accept）、“是，本会话内这个命令不再问”（acceptForSession）、“否，不运行并继续”（decline）、“否，告诉 Codex 换个做法”（cancel，会中断回合）；文件改动是“是”“是，这些文件不再问”“否，告诉 Codex 换个做法”。收到 `serverRequest/resolved` 就把对应的审批从可见、排队、延后的各处删掉，不回任何决定（`chatwidget.rs:1003-1020`）。
- **计划**：`turn/plan/updated` 显示为“更新了计划”，完成的打勾划掉、进行中的高亮，紧凑形式是“n/m 完成”（`history_cell/plans.rs:230-336`）。**目标**（goals）功能默认开启，模型会拿到 `get_goal` / `create_goal` / `update_goal` 三个工具，界面上是页脚的目标状态（`bottom_pane/footer.rs:580-610`）；`features.goals` 是 Stable、默认 true（`features/src/lib.rs:1823-1827`），Wevir 不支持就要关掉。
- **命令与文件改动**：只读 / 列目录 / 搜索的命令合并成“探索”单元，其余显示“运行中 / 已运行”加命令与输出（输出缓冲 1 MiB，截断后保留首尾各 50 行）；文件改动在 `item/started` 时就显示 diff（`exec_cell/`、`diff_render.rs`）。
- **运行中再输入**：回车是 `turn/steer`（插进当前回合），Tab 是排队到回合结束后（`app_server_session.rs:1497-1517`）。Wevir 目前回合进行中拒绝新消息（`SESSION_BUSY`）。
- **标题**：服务端不生成标题；终端界面在第一条用户消息后开一个隐藏的临时 thread、用 `gpt-5.6-luna`（没有就用当前模型）生成不超过 36 个字符的标题，再 `thread/name/set`（`app/thread_title.rs:29-131`）。
- **其他**：`error` 带 `willRetry:true` 时只在状态栏短暂显示，不进消息流；“剩余上下文”按 `last.totalTokens` 与模型上下文窗口、扣掉 12k 基线计算（`chatwidget.rs:1132-1145`）；登录是 `account/login/start`（`chatgpt` 返回 `authUrl`，`chatgptDeviceCode` 返回 `verificationUrl` 与 `userCode`）、`account/login/completed`、`account/read`、`account/updated`、`account/logout`（`onboarding/auth.rs:936-1117`）。

## 3. 模型接口：只剩 Responses

### 3.1 Codex 发出的请求（Spike 实测 + 源码）

- `POST {base_url}/responses`，`base_url` 要带 `/v1`。HTTP 路径**无状态**：`store:false`，不用 `previous_response_id`，每次带完整历史。
- 请求体：`model`、`stream:true`、`tool_choice:"auto"`、`parallel_tool_calls:true`、`reasoning:{summary:"auto"}`、`store:false`、`include:["reasoning.encrypted_content"]`、`prompt_cache_key`（会话 id）、`client_metadata`（含 `x-codex-installation-id`、thread / turn id 与一段 turn 元数据 JSON）。**不发 `instructions`**：基础提示词是 `input` 里第一条 developer 消息（`core/src/client.rs:931-940`）。第一回合的 `input` 依次是：基础提示词（约 17 KB）、权限说明与 skills 列表（developer）、`<environment_context>`（user，含 cwd、shell、日期、时区、可写根目录）、用户输入。
- 请求头：`Authorization: Bearer <env_key 的值>`、`originator`、`User-Agent`、`session-id`、`thread-id`、`x-client-request-id`、`x-codex-window-id`、`x-codex-turn-metadata`（JSON：installation_id、session / thread / turn id、沙箱类型、模型）、`x-codex-beta-features: remote_compaction_v2`；子 agent 另带 `x-openai-subagent`、`x-codex-parent-thread-id`。**这些元数据都会发给第三方模型服务**，网关透传时应当剥掉（Spike `passthrough` 已验证）。
- 重试：5xx 与传输错误默认重试 4 次，**429 不重试**；流空闲超时 300 s（`model-provider-info/src/lib.rs:65-67,455-460`）。
- 默认工具（未知模型、Spike 的加固配置下）：`exec_command`、`write_stdin`（unified exec）、`request_user_input`、`view_image`、namespace `multi_agent_v1`、`get_goal` / `create_goal` / `update_goal`；模型目录声明 `apply_patch_tool_type:"freeform"` 才有 `apply_patch`；`update_plan` 要单独打开；`web_search` 默认是 `cached`，会发一个托管的 `web_search` 工具，要设 `web_search="disabled"`。

### 3.2 Codex 解析的流事件

`codex-api/src/sse/responses.rs:344-506`：只看 `data:` 里 JSON 的 `type`，`event:` 行忽略，非 JSON（如 `[DONE]`）跳过。

- 用到的：`response.created`、`response.output_item.added` / `.done`、`response.output_text.delta`、`response.custom_tool_call_input.delta`、`response.reasoning_text.delta`、`response.reasoning_summary_text.delta` / `.done`、`response.reasoning_summary_part.added`、`response.completed`、`response.incomplete`、`response.failed`。忽略 `response.function_call_arguments.*` 与 `content_part.*`。
- **历史与工具调用只取 `output_item.done`**；增量只驱动界面，而且之前必须有对应的 `output_item.added`。
- `response.completed` 必须有字符串 `response.id`；`usage` 可选，有就要有 `input_tokens`、`output_tokens`、`total_tokens`。流在 `response.completed` 之前断开算错误（会按 stream 重试次数重试）。
- 推理项带回：Codex 把上一轮的 reasoning 项原样放回 `input`，**包括 `content`（原始推理文本）**，有 `encrypted_content` 就一起带；同一回合的工具调用之后与下一回合都带（Spike `reasoning-carry` 两种变体）。这正是 DeepSeek 需要的：它把输入里推理项的 `content` 合并进相邻的 assistant 消息，不支持 `encrypted_content`。

### 3.3 模型目录

- `model_catalog_json = "<绝对路径>"` 指向 `{"models":[…]}`，查找按 slug 最长前缀匹配；有它就不再联网拉模型列表（`model-provider/src/provider.rs:390-397`）。
- 必填：`slug`、`display_name`、`supported_reasoning_levels`、`shell_type`、`visibility`、`supported_in_api`、`priority`、`support_verbosity`、`truncation_policy`、`experimental_supported_tools`，另外**必须有 `base_instructions` 或 `model_messages.instructions_template`**（Spike 第一次就因缺它被拒）。`supports_parallel_tool_calls` 不是字段，写了也被忽略。
- 未知模型用默认元数据：`unified_exec`、**没有 `apply_patch`**（模型只能经 `exec_command` 跑 `apply_patch <<'EOF'`，Codex 会拦截处理）、272k 上下文、Codex 自带的 `prompt.md` 作基础提示词。
- 内置的 OpenAI 专属模型名：记忆抽取与自动审批复核的首选模型写死为 `gpt-5.6-luna`（`model-provider/src/provider.rs:93-97`），子 agent 场景里能看到 “Unknown model gpt-5.6-luna” 的警告，但没有实际发出这个模型的请求。只要不开 `memories` 与 `approvals_reviewer=auto_review`，就不会把这个模型名发给第三方服务。

### 3.4 各家 Responses 兼容性

“官方 Codex 指南”指模型服务商自己发布的 Codex 接入文档。

| 服务 | Responses 端点（大陆可用） | 官方 Codex 指南 | 自定义工具（apply_patch） | namespace 工具 | 推理带回 | 备注 |
|---|---|---|---|---|---|---|
| DeepSeek | `https://api.deepseek.com`（只有这一个） | 有：`deepseek-flash`、`deepseek-v4-pro`，自带模型目录（`apply_patch_tool_type:"freeform"`） | 只接受 `apply_patch`，其他名字 400 | 文档未写明，**实测支持**（子 agent 正常） | 输入推理项的 `content` 并入相邻 assistant；不支持 `encrypted_content`、`include`、summary | `store` 恒 false；托管工具被忽略；两份文档对 v4-pro 的支持说法不一，**实测 v4-pro 的 Responses 可用** |
| Kimi | `https://api.moonshot.cn/v1` | 有：`kimi-k3` | 只有 `apply_patch`（Lark 语法） | 支持 | 接受推理项回放；`encrypted_content` 恒为 null | `tool_choice` 只能 `auto` |
| GLM（智谱） | `https://open.bigmodel.cn/api/v1` | 有，但只写了 Coding Plan | OpenAPI 里有 `custom` 工具，没有 `custom_tool_call` 输出与对应流事件（**未核实**） | 未写明 | 推理是纯文本 | 按量付费的 Key 能否用于 Codex **未核实** |
| 通义千问（百炼） | `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | 有：qwen3.8-max、qwen3.7-max 等 | 文档没写 `custom` 工具（**未核实**） | 未写明 | 推理项可回放 | Coding Plan 不支持 Responses |
| MiniMax | `https://api.minimax.cn/v1` | 有 | freeform | — | — | `effort:none` 报 400 |
| 阶跃星辰 | `https://api.stepfun.com/step_plan/v1` | 有（Step Plan 订阅） | freeform | — | — | 指南固定 Codex 0.154.0 |
| 火山方舟、百度千帆 | 有 `/responses` | 方舟只在 Coding Plan 工具列表里提到（**未核实**）；千帆没有 | — | — | — | |
| 硅基流动 | **没有** Responses | 指南让用 CC Switch 转接 | — | — | — | |
| OpenRouter | 有，只支持无状态 | 有 | 非 OpenAI 模型的透传**未核实** | — | — | `store:true` 报 400 |
| xAI | `https://api.x.ai/v1/responses`（主接口，Chat 已标 Legacy） | 没有；社区 issue #46773 报告可用 | 文档没提（大概率不支持） | — | 支持 `encrypted_content` | Codex 自动压缩发 `tools:[]` + `tool_choice:"auto"`，xAI 报 400（0.162.1 上确认） |
| Gemini API | **没有** Responses（只有 Chat 兼容端点，beta） | — | — | — | — | 大陆不可达 |
| Anthropic | **没有** Responses（OpenAI 兼容层只有 Chat，且官方说不适合生产） | — | — | — | — | |

小结：DeepSeek、Kimi、GLM、通义、MiniMax、阶跃都在 2026 年给 Codex 出了接入文档，主流国内服务已能直连；差异集中在自定义工具、namespace 工具、推理带回和少数参数上。这些差异正好可以由网关按服务修正（§5.3）。

### 3.5 只有 Chat / Messages 的上游

OpenAI 不推荐任何桥接（discussion #7782 只建议网关自己支持 `responses`）。社区里在用的转接实现，做法与 Spike 的网关一致：

| 项目 | 许可 | 自定义工具 | 推理 |
|---|---|---|---|
| LiteLLM `/v1/responses` | MIT（`enterprise/` 除外） | 转成只有一个字符串参数的函数，语法写进描述，回来再还原 | 推理项回放为 `reasoning_content`（代码注释说 DeepSeek V4 缺它会拒绝多轮请求）；Anthropic 的签名思考块放进 `encrypted_content` |
| CC Switch（Tauri 代理） | MIT | 同上（参数名 `input`） | 缓存并回放 `reasoning_content`，缺失时插占位，避免 DeepSeek 报错；另有 Responses → Anthropic Messages 模块 |
| CLIProxyAPI | MIT | 改写 apply_patch 及其历史 | 主要用途是包装订阅制 CLI，有条款风险 |
| new-api | AGPL-3.0 | 处理 `custom_tool_call` | **未核实** |

## 4. 登录与条款

### 4.1 OpenAI / ChatGPT 订阅

- app-server 原生支持 ChatGPT 登录（`account/*`：浏览器登录与设备码）。OpenAI 的 app-server 文档写明：**本地或开源应用**用 app-server 认证可以继续用，**商业或托管服务从来不允许**；`clientInfo.name` 要写应用自己的名字，OpenAI 用它做合规日志。
- 另一条路是 Sign in with ChatGPT（SIWC）：应用注册自己的 client ID，把令牌交给 app-server（实验性的 `chatgptAuthTokens` 模式）。2026-09-29 DevDay 起对开源应用开放；条款要求令牌只存在用户本地、不得冒充其他应用、不得把用户的套餐用量收费转卖、不得当作通用 API 代理。预览期限制：必须 `store:false` 与 `stream:true`，令牌由应用刷新、刷新后重启 app-server 再 `thread/resume`。
- 使用条款禁止共享账号凭据、禁止程序化抽取输出。没找到因第三方客户端使用 Codex 登录而封号的先例（**未核实**）；6 月有用户反映 Codex / Pro 账号被无故停用，官方称至少一例是误封。
- 对 Wevir：走 app-server 自己的登录流程即可，**不提取、不转用令牌**。注意 Wevir 若将来有商业或托管形态，这条路不能用。ChatGPT 登录时模型流量由 Codex 直连 OpenAI，不经网关。
- **R6 在真实二进制上核实（2026-10-14，`rust-v0.162.1`）**，细节见 codex-event-mapping.md §8：
  - `account/*` 与 `model/list` 都在稳定面。没登录时 `account/read` 是 `{account: null, requiresOpenaiAuth: true}`（Provider 是网关的进程里为 `false`），`account/rateLimits/read` 报 `-32600`，`model/list` 给二进制里打包的列表、不联网。
  - 浏览器登录：`{loginId, authUrl}`，`authUrl` 带 `originator=wevir`，回调是 app-server 在 `127.0.0.1:1455` 临时监听的端口，取消即关闭。设备码：先请求 `auth.openai.com/api/accounts/deviceauth/usercode`，返回 `{loginId, verificationUrl: "https://auth.openai.com/codex/device", userCode}`，再按 interval 轮询 15 分钟。取消、被新登录替换都以 `account/login/completed {success: false}` 结束；成功后跟一条 `account/updated {authMode: "chatgpt", planType}`。登出删 `auth.json` 并吊销刷新令牌。
  - 凭据：默认 `cli_auth_credentials_store = "file"` 写 `CODEX_HOME/auth.json`（0600）；还有 `keyring`、`auto`、`ephemeral`。Wevir 显式写 `file`（docs/security.md §3）。
  - **`model_catalog_json` 会整体替换 Codex 的模型目录**（`model/list` 只剩它的模型），所以 ChatGPT 登录要单独一个不设它的进程（ADR-0005 补记 10）。
  - 登录后 Codex 默认还会连 ChatGPT 的应用（connectors）MCP（`<chatgpt_base_url>/ps/mcp`），`features.apps = false` 关掉。
  - 没登录时在 openai Provider 上开回合，Codex 拿着空凭据去连 `api.openai.com` 并重试五次（另有 websocket 预连），Wevir 因此在没登录时不建 ChatGPT 会话。
  - 登录服务与后端可以经 `CODEX_APP_SERVER_LOGIN_ISSUER`、`CODEX_REFRESH_TOKEN_URL_OVERRIDE` 与 `chatgpt_base_url`、`openai_base_url` 换成本机 mock，测试用它走完设备码与浏览器登录（`test-fixtures/mock-chatgpt.ts`）。工作区路由（`/wham/accounts/check`）只接受 https 的源，所以登录后的回合仍发往 chatgpt.com，mock 不了。
  - **外连**（mock 登录服务 + 只记录、一律拒绝的代理）：没登录时零；登录后发往登录服务的是 `/api/accounts/deviceauth/*`、`/oauth/token`、`/oauth/revoke`，发往后端的是 `/backend-api/wham/accounts/check`、`/wham/usage`、`/wham/rate-limit-reset-credits`、`/codex/models`，建会话时预连 `wss://chatgpt.com/backend-api/codex/responses`。即只有 `auth.openai.com` 与 `chatgpt.com` 两个域名。进程启动时第一次拉模型列表的 `originator` 是 Codex 默认的 `codex_cli_rs`（在 `initialize` 之前），其余请求都是 `wevir`。**真实账号的外连审计**（代理放行并记录主机，维护者登录、一问一答）：待补。

### 4.2 Google：Gemini CLI / Code Assist

- **2026-06-18 起，Gemini CLI 不能再用“Login with Google”**，覆盖免费个人档、Google AI Pro 与 Ultra（Code Assist for individuals 的弃用页，2026-10-09 更新）；Standard / Enterprise 另有弃用时间表。7 月起 AI Pro 用户登录报 “client is no longer supported”（issue #28229）。
- Gemini CLI 的条款（2026-02-27 加入）明确：在第三方工具里复用 Gemini CLI 的 OAuth 凭据违反条款。Antigravity 的条款与 FAQ 同样禁止把它包进第三方 agent，并建议第三方 agent 用 AI Studio 或 Gemini Enterprise 的 API Key。
- 先例：2026-02 OpenClaw 用户因复用 Gemini / Antigravity OAuth 被批量封号（openclaw#14203），连 Gemini CLI 与 Code Assist 一起停用；Google 2-27 统一解封，并说明再犯永久封禁（gemini-cli discussion #20632）。
- 官方 `gemini --acp` 本身是受支持的接入方式（`--experimental-acp` 已弃用），但现在要 Gemini API Key、Vertex AI，或 Standard / Enterprise 授权。
- 对 Wevir：**原定的第 3 优先级“Gemini CLI 的登录”对个人订阅已经不存在**。能做的是 Gemini API Key（经网关走 Gemini 的 Chat 兼容端点，或驱动 Gemini CLI 的 ACP）；大陆不可达，需要用户自己的网络环境。

### 4.3 xAI：Grok

- 官方编码 agent **Grok Build**（`grok`，`xai-org/grok-build`，Rust，Apache-2.0，2026-07 建库，beta）：`grok agent stdio` 是完整的 ACP 实现（load / list / resume / close 会话、设模式、设模型、设配置项，外加 `x.ai/*` 扩展方法）；文档写明可以经 ACP 在其他应用里使用。
- 登录：浏览器登录、设备码、外部令牌命令，或 `XAI_API_KEY`；`GROK_HOME` 可以隔离。订阅用户的周用量在 Chat、Imagine、Voice、Build 之间共用；哪些档位包含 Build（SuperGrok、Premium+ 之外）**未核实**。
- xAI 主动支持嵌入：2026-05 宣布可在 Hermes Agent 里直接用 Grok 订阅，还出了驱动 `grok` 的 Claude Code 插件。没有面向第三方的 OAuth 客户端计划；可接受使用政策禁止“未经授权的自动化访问”与绕过限额，用订阅额度跑第三方编排算不算，没有明文（灰色）。没找到封号先例。
- xAI API：Responses 是主接口（`POST https://api.x.ai/v1/responses`），支持函数工具、`encrypted_content`；自定义工具没有文档；Chat 是 Legacy；Anthropic Messages 兼容已废弃。
- 对 Wevir：订阅用户走“通用 ACP 适配器 + Grok Build + `grok login`”；API Key 用户走 Codex + 网关（Responses 透传，网关修正 `tools:[]` 与自定义工具，§5.3）。

### 4.4 Anthropic（对照）

2026-01-09 起服务端拦截第三方客户端使用 Claude 订阅 OAuth（OpenCode 曾伪装 Claude Code 的请求头）；现行的法律与合规页写明第三方开发者不得在自己的应用里提供 Claude.ai 登录，也不得收集或中转其凭据，但用户可以用自己的订阅登录未修改的 Claude Code 二进制。

### 4.5 小结

四家划的线基本一致：**让用户在厂商自己的、未修改的客户端里登录，Wevir 只驱动这个客户端**，可以；**把令牌取出来给别的程序用**，Google 与 Anthropic 明令禁止并有封号先例，OpenAI 的条款禁止冒充其他应用，xAI 没有明文。Wevir 的做法因此是：ChatGPT → app-server 的 `account/*`；Grok → Grok Build 的 `grok login`（经 ACP 驱动）；Gemini → 只有 API Key。

## 5. 模型协议网关（Spike `src/gateway.ts`）

### 5.1 Responses → Chat Completions 的映射

| Responses（Codex 发的） | Chat Completions（发给上游的） |
|---|---|
| `instructions`（Codex 不发） | system |
| `message` role developer | system（可能出现在对话中间：权限变化等） |
| `message` role user（`input_text` / `input_image`） | user（纯文本拼成字符串，有图时用 parts） |
| `message` role assistant | assistant.content |
| `reasoning`（取 `content` 文本；没有时解网关自己写的 `encrypted_content`） | 挂到下一条 assistant 的 `reasoning_content` |
| `function_call` / `custom_tool_call` | assistant.tool_calls（同一段里相邻的合并成一条 assistant） |
| `function_call_output` / `custom_tool_call_output` | tool 消息 |
| 工具 `function` | function |
| 工具 `custom`（apply_patch，Lark 语法） | 只有一个字符串参数 `input` 的 function，语法全文写进描述 |
| 工具 `namespace`（multi_agent_v1） | 摊平成 `<ns>__<name>` 的 function |
| 托管工具（web_search 等）、`store`、`include`、`prompt_cache_key`、`client_metadata` | 丢弃 |

响应方向：`reasoning_content` 增量 → reasoning 项（`output_item.added` → `reasoning_text.delta` → `output_item.done`，`content` 放全文，`encrypted_content` 放网关自己编码的全文，保证无论 Codex 带回哪个字段都能还原）；`content` → message 项；`tool_calls` 按 `index` 拼接参数，结束时按原工具类型还原成 `function_call`（带 namespace）或 `custom_tool_call`（解出 `input`）；`usage` 映射到 `response.completed`（`prompt_tokens_details.cached_tokens`，没有时取 DeepSeek 的 `prompt_cache_hit_tokens`）。上游非 2xx 原样转给 Codex（让 Codex 按自己的策略重试或失败）；Codex 断开时网关中断上游请求。

### 5.2 已验证（mock 上游）与没验证的

- 已验证：逐字流式、推理增量、apply_patch 往返（模型回 `{"input": 补丁}` → Codex 收到 `custom_tool_call`）、两类审批、推理在同一回合与跨回合都回到 `reasoning_content`、namespace 工具（子 agent）往返、取消时网关跟着断开上游、resume、`update_plan`、上游 400 → 回合 failed 且之后可用。
- 真实模型验证过（§7.3）：DeepSeek 的 Chat 接口按函数描述里的 Lark 语法写出了合法补丁，`reasoning_content` 回传后多轮不报错。
- 没验证：图片输入；`response.incomplete`（`max_tokens` 截断）；上游流中途出错；并行工具调用的多个 `index` 交错到达；Anthropic Messages 与 Gemini 原生协议（没写）。
- 补记（R1，2026-10-14）：产品网关 `packages/model-gateway` 补上了上一条里除 Anthropic Messages、Gemini 之外的各项，用 mock 上游与录制的真实 Codex 请求测试；真实 `codex-app-server` 经产品网关跑本 Spike 的场景，gateway / passthrough 104 项检查全部通过（[model-gateway.md](../architecture/model-gateway.md) §9）。
- 补记（R10，2026-10-14）：Anthropic Messages 转换也补上了（[model-gateway.md](../architecture/model-gateway.md) §5）：思考块连同签名写进 reasoning 项的 `encrypted_content`，与 LiteLLM 的做法相同；用按 Anthropic 结构规则检查请求的 mock 上游测试，真实服务还没有跑过。

### 5.3 Responses 原生上游也经网关

透传模式（Spike `passthrough`）只做三件事：请求体去掉 `client_metadata`；请求头只带网关自己的（`x-codex-*`、`session-id`、`thread-id`、`originator`、`x-openai-*` 一律不转发）；用 Host 里的 Key 替换 Codex 的一次性令牌。同一组场景全部通过。在此之上可以按服务挂“方言修正”，都只在网关里改，不碰 Codex：

- xAI：自动压缩发 `tools:[]` + `tool_choice:"auto"` 会 400 → 网关删掉 `tool_choice`；没有自定义工具 → 把 `apply_patch` 按 §5.1 的办法转成函数工具再转回来。
- DeepSeek：未核实 namespace 工具 → 必要时同样摊平。
- MiniMax：`effort:none` 报 400 → 网关改写或去掉。
- 各家的思考开关、`reasoning_effort` 取值不同 → 按 Provider 配置改写。

### 5.4 fork Codex、加回 `wire_api="chat"` 的代价

| | Host 网关（推荐） | fork Codex 加 wire_api |
|---|---|---|
| 改动量 | 网关一个模块（Spike 约 490 行，产品化估计 1.5–2 千行含测试） | 恢复 PR #10157 删掉的 Chat 客户端，并让它跟上删除之后 8 个月里 Responses 路径的全部改动（工具形状、压缩、子 agent 等），每一处都要在 Chat 上另想等价做法 |
| 跟进上游 | 只依赖 Responses 线上协议（OpenAI 的公开 API，变化慢） | 每个 release 都要 rebase；Rust 工作区 155 个 crate、约 206 万行，每月约 10 个小版本 |
| 构建与分发 | 用官方 release 二进制（带签名、sha256） | 自建 6 个平台的 Rust 交叉编译、签名与公证，安装包与更新渠道全自理 |
| Key 的位置 | 只在 Host；Codex 只有一次性令牌 | 在 Codex 进程的环境变量里（需要额外的 shell 环境排除，§6.3） |
| 方言修正、元数据剥离 | 网关里统一做 | 要改 Codex 源码 |
| 代价 | 多一跳本机 HTTP（毫秒级）；协议转换的正确性由 Wevir 负责 | — |

结论：不 fork。fork 只在“网关无法表达某种上游能力”时才值得重新评估，目前没发现这种情况。

## 6. 隔离、外连与密钥

### 6.1 `CODEX_HOME`

环境变量 `CODEX_HOME` 指定的目录必须事先建好（`utils/home-dir/src/lib.rs`）。Spike 每个场景一个临时目录，进程 cwd 设为 `CODEX_HOME`，`HOME` 也指向临时目录，子进程环境按白名单构造。工作区里的 `.codex/config.toml` 与 `AGENTS.md` 仍会生效（与 dsh 读工作区的 AGENTS.md 一致）；`project_doc_max_bytes = 0` 可以关掉 AGENTS.md。

### 6.2 外连审计（Spike `network-audit.ts`）

方法：给 app-server 配一个只记录目标、一律拒绝的代理（`HTTP(S)_PROXY`、`ALL_PROXY`，本机地址走 `NO_PROXY`），同时每 200 ms 用 `lsof` 抓它的 TCP 对端；模型是本机 mock，每种配置跑一个回合后再等 8 s。

| 配置 | 经代理的目标 | 非本机 TCP 对端 |
|---|---|---|
| 只有 Provider（其余默认） | `chatgpt.com:443`、`github.com:443`、`api.github.com:443` | 无 |
| 只加 `check_for_update_on_startup=false` / `web_search="disabled"` / `analytics.enabled=false` 之一 | 同上 | 无 |
| 只加 `features.plugins=false` | **无** | 无 |
| 全部加固项 | 无 | 无 |

即：**三个外连都来自插件功能**（启动时从 `https://github.com/openai/plugins.git` 同步插件市场，另有 chatgpt.com），关掉 `features.plugins` 就没有外连。其余加固项仍然要设：`web_search` 默认会把托管搜索工具发给模型服务；`analytics` 在有 OpenAI 登录时会上报；`check_for_update_on_startup` 只影响 TUI，设上无害。模型列表在 `env_key` 型 Provider 下不联网拉取（存了 ChatGPT 登录时例外）。

### 6.3 密钥

- Spike `secrets` 场景（3 种接法）：用特征值作 Key / 令牌，跑完后 `grep -a` 整个临时目录（含 7 个 SQLite 库与 rollout）和 stderr，都没有出现；`RUST_LOG=debug,codex_core=trace` 下单独核对也没有。
- **但默认配置下，模型跑的命令能读到 Key 的环境变量**：`shell_environment_policy` 默认 `inherit=all`、`ignore_default_excludes=true`（`config/src/shell_environment_policy.rs:136`），Spike 里 `env | grep -c ^WEVIR_` 得到 1。设 `[shell_environment_policy] ignore_default_excludes=false` 或 `exclude=["WEVIR_*"]` 后为 0。这条对 dsh 也值得复查（dsh 的工具子进程环境本次没查）。
- 经网关时 Codex 只有一次性令牌，即使被读到，也只能访问本机网关、只在这次进程有效；Key 本身只在 Host。

### 6.4 OpenAI 专属的残留

- 发给模型服务的元数据：installation_id、会话与回合 id、沙箱类型（§3.1）。网关透传时剥掉。
- 不需要 OpenAI 账号：`env_key` 型 Provider（`requires_openai_auth` 默认 false）没有登录界面，Spike 全程没有登录。`account/rateLimits/updated`、`remoteControl/status/changed` 等通知照常出现，内容为空，适配器忽略即可。
- `is_openai()` 判断的是 Provider 的 `name == "OpenAI"`（`model-provider-info/src/lib.rs:616-618`），自定义 Provider 不要起这个名字。

### 6.5 沙箱

macOS 用 Seatbelt（`/usr/bin/sandbox-exec` + `.sbpl`），Linux 默认 bubblewrap（优先系统的 `bwrap`，没有则用随包的），Windows 有需要提权安装的旧沙箱与免安装的 MXC 两套；`workspace-write` 默认禁网，另有按域名放行的网络代理。Spike 只在 macOS 上跑过（`x-codex-turn-metadata` 里 `sandbox:"seatbelt"`）。dsh 的沙箱只限制写文件、不限网络（§8），Codex 在这点上更完整。

## 7. Spike 结果

### 7.1 场景与结果

`node src/run-all.ts`：每个场景在三种接法下各跑一次（`direct`：Codex 直连 Responses mock；`passthrough`：经网关透传到 Responses mock；`gateway`：经网关转换到 Chat mock）。**155 项检查全部通过**，用时约 15 秒。

| 场景 | 验证了什么 | 关键观测 |
|---|---|---|
| `stream` | 文本与推理逐片到达、已提交文本与增量一致、用量通知；透传时上游看不到 Codex 的元数据与令牌 | 通知顺序见 §2.2 |
| `stream-hidden-reasoning` | 默认配置下原始推理是否透出 | 透出（`textDelta` 2 条） |
| `apply-patch` | 工作区内补丁免审批；工作区外补丁触发 `fileChange` 审批，accept 写入、decline 不写且 status=`declined`；网关把 apply_patch 摊平成函数并带语法 | `custom_tool_call_output` 是 `Exit code: 0 … Success. Updated the following files` 这样的文本 |
| `exec-approval` | 沙箱内命令免审批；`require_escalated` 触发命令审批；decline / accept / acceptForSession | `acceptForSession` 后同一命令不再询问 |
| `reasoning-carry`（及 `-encrypted`） | 推理项在同一回合工具调用之后、在下一回合都被带回；网关把它们还原成 `reasoning_content` | 带回时含 `content`；有 `encrypted_content` 也原样带回 |
| `subagent` | spawn → 子 thread 跑完 → wait 拿到结果；子 thread 事件推到同一连接；`thread/read` 的 `parentThreadId` | 子 thread 不发 `thread/started`；`thread/list.parentThreadId` 要实验面 |
| `cancel` | 流式中取消、审批挂起时取消、取消后同一 thread 可继续 | `turn/interrupt` → `turn/completed(interrupted)` 4–7 ms；审批挂起时 3–12 ms；`serverRequest/resolved` 在回合结束后到达 |
| `resume` | stdin EOF 后退出、新进程 `thread/list` / `thread/resume`、历史完整、不存在的 thread 报错 | 退出 6 ms |
| `plan` | `tools.update_plan.enabled=true` 后有 `turn/plan/updated` | |
| `upstream-error` | HTTP 400 与 `response.failed` → 回合 failed，`error` 通知带上游原文，之后可用 | `codexErrorInfo:"other"`、`willRetry:false` |
| `secrets` | 工具读不到 `WEVIR_*`、Key / 令牌不落盘、不进日志 | §6.3 |

### 7.2 没有覆盖到的

`thread/fork`、`turn/steer`、`thread/compact/start` 与自动压缩、MCP、skills、hooks、`request_user_input`、图片输入、Windows 与 Linux 沙箱、长时间运行与并发多会话的资源占用、Codex 自己的重试与退避（Spike 关掉了重试）。

### 7.3 真实模型（DeepSeek，2026-10-14）

```bash
cd spikes/codex-app-server
WEVIR_SPIKE_KEY=<DeepSeek Key> node src/real.ts [--transport=direct,passthrough,gateway]
```

三种接法各做四件事：用 apply_patch 新建文件、下一回合改文件并复述上一轮（跨回合推理）、派子 agent、长回答中途取消。审批一律拒绝并记录（本轮没有出现审批请求）。这个 Key 的 `GET /models` 只列出 `deepseek-flash` 与 `deepseek-v4-pro`；Chat 接口用同样的模型名，没有加任何思考开关（`WEVIR_SPIKE_CHAT_EXTRA` 未设）。

| 接法 | 模型 | 回合 1：新建文件 | 回合 2：改文件、复述上一轮 | 回合 3：子 agent | 回合 4：取消 |
|---|---|---|---|---|---|
| `direct`（Codex → `api.deepseek.com/responses`） | `deepseek-flash` | completed，1 个 fileChange，内容正确；文本增量 18 条、推理增量 37 条 | completed，内容正确，复述准确 | completed：spawnAgent → wait → closeAgent | interrupted，6 ms |
| `passthrough`（经网关透传） | `deepseek-flash` | 同上（推理增量 28 条） | 同上 | 同上 | interrupted，6 ms |
| `passthrough` | `deepseek-v4-pro` | 同上（文本 25、推理 32 条） | 同上 | spawnAgent → wait | interrupted，6 ms |
| `gateway`（经网关转 `api.deepseek.com/chat/completions`） | `deepseek-flash` | 同上（文本 54、推理 70 条：Chat 的分片更细） | 同上（模型还自己 `cat` 了一次做只读校验） | spawnAgent → wait → closeAgent | interrupted，5 ms |

结论：

- DeepSeek 的 Responses 接口支持 Codex 的 namespace 工具（`multi_agent_v1`），文档没写的这一项实测可用。
- 网关的 Chat 转换在真实模型上成立：apply_patch 摊平成函数后，模型按描述里的 Lark 语法写出了合法补丁；推理以 `reasoning_content` 带回上游，同一回合的工具调用之后与跨回合都没有触发 DeepSeek 的 “reasoning_content is missing” 一类错误；网关没有丢弃任何输入项。
- Codex 读到 `response.completed` 就断开连接（`codex-api/src/sse/responses.rs:655-660`），网关透传时会看到上游流被中断；这是正常结束，网关已按正常处理。

## 8. dsh 的长处，逐条核实

在 `upstream/deepseek-harness` @ `d743267`（下表路径相对于其 `packages/`）与 Wevir 的 `packages/adapter-dsh` 上核对：

| 设想的长处 | 结论 | 依据 |
|---|---|---|
| 直接支持 Chat Completions 服务 | **成立，但不是 DeepSeek 官方那条路。** 通用的 pi-ai 适配器支持 `openai-completions`、`openai-responses`、`anthropic-messages` 三种协议（`llm/llm-pi-ai/src/provider.ts:47-51`）；DeepSeek 官方的原生适配器走的是 **Anthropic Messages**（`https://api.deepseek.com/anthropic`，`llm/llm-deepseek/src/config.ts:106`）。Wevir 的 overlay 目前拒绝 `anthropic-messages`（`provider-config.ts:42,143-151`） | 源码 |
| DeepSeek 专属能力（web-search-deepseek 等） | **部分成立。** `web-search-deepseek` 调 DeepSeek Anthropic 端点的服务端搜索工具（`web_search_20250305`，模型 `deepseek-v4-flash`），用同一个 DeepSeek Key（`web/web-search-deepseek/src/provider.ts:34,218,228`）；另有思考开关与强度、Files API 传图、DeepSeek 账号登录路由。没有 FIM、没有前缀缓存提示 | 源码 |
| Cordis 插件机制 | **成立。** profile + `cordis.patch.yml` 分层、`--patch` 与 `dsh plugin add`；插件能挂 agent 事件、审批中间件、工具、LLM 适配器、搜索提供方。Wevir 的 stream-tap 就是靠它 | `boot/app-boot/src/profile.ts:1-21` 等 |
| 办公文档工具 | **部分成立。** 是三个 skill（docx / pptx / xlsx，让模型用捆绑的 Python 库与 LibreOffice Kit），只装在 sdk-app bundle，**acp profile 里没有**；`dsh-office-to-pdf` 是给预览用的转换服务，不是模型工具。LibreOffice Kit 是 MPL-2.0 | `skill/skill-office/src/index.ts:13,69`、`bundle/sdk-app/cordis.patch.yml:24-31` |
| 现成的 ACP 接入 | **成立，但能力窄。** 实现 new / list / resume / close / set_config_option / prompt / cancel，没有 `session/load`、plan、模式；消息块是已提交的整块（不是逐字）；工具 kind 恒为 `other`；子 agent 不产生任何更新 | `acp/acp/src/index.ts:383-394`、`updates.ts:14-85` |
| 三层契约测试 | **成立，而且大半通用。** 三层都跑 `runAdapterContract`（回放 / 真实 dsh + mock / 真实模型）。`dsh-process.ts` 的 ACP 连接与进程回收、`acp-mapping.ts`、`session-events.ts`、`dsh-adapter.ts` 的会话与审批记账可以抽成通用 ACP 适配器；stream-tap、`DeltaMerger`、`paths.ts`、`env.ts`、`provider-config.ts`、`resume-error.ts`、`tool-display.ts` 是 dsh 专属 | Wevir 源码 |

其他：dsh 的沙箱 macOS 上是 `(allow default)(deny file-write*)`，**不限网络**；有子 agent（进程内，外加 ACP / Claude Code / Codex 后端）、skills、MCP（要另配）、压缩、实验性语音（sherpa-onnx）。

**新发现的隐私问题（不在本次范围，已另开任务）**：dsh 默认在发往 DeepSeek 官方端点的每个请求里附带会话日志（`dsh_session_log`，默认开启、每次最多 8 MiB，`session/session-log-deepseek/src/index.ts:50-53,187-203`）与已装插件清单，并带 `x-deepseek-harness-user-id` 请求头；两者都在 base bundle 里，Wevir 的 overlay 没有关掉。

## 9. ACP 侧的其他引擎

| | Gemini CLI | Grok Build | dsh |
|---|---|---|---|
| 版本 / 许可 | 0.64.0（2026-10-13），Apache-2.0 | beta，Apache-2.0 | 0.2.1-alpha.2，MIT |
| 入口 | `gemini --acp` | `grok agent stdio` | `dsh --profile acp` |
| 会话 | new / load / cancel / 设模式 / 设模型（无 list、resume、close） | load / list / resume / close / 设模式 / 设模型 / 设配置项 | new / list / resume / close / 设配置项 |
| 逐字流式 | 发消息与思考的 chunk（粒度**未核实**） | **未核实** | 没有（Wevir 用 stream-tap 补） |
| 工具 kind | read / edit / execute / search 等；子 agent 显示为 `think` | **未核实** | 恒为 `other` |
| 计划 | 不发 `plan` | **未核实** | 没有 |
| 审批 | allow_once / reject_once / allow_always | **未核实** | allow / reject once |
| 文件读写 | 客户端声明 `fs` 时经客户端 | **未核实** | Host 不代理 |
| 登录 | API Key / Vertex / Standard·Enterprise（个人订阅已停） | `grok login`（订阅）或 `XAI_API_KEY` | DeepSeek Key 或 DeepSeek 账号 |
| 隔离 | `GEMINI_CLI_HOME` | `GROK_HOME` | `DSH_HOME` |
| 体积 | npm 98.6 MB | 约 48 MB | 依赖闭包 622 个 npm 包 |
| 遥测 | 匿名用量统计默认开，`privacy.usageStatisticsEnabled:false` 关 | **未核实** | `DSH_TELEMETRY_DISABLED=1` |

## 10. Codex → `AgentEvent` 映射草案

在上次报告的表上按 Spike 实测修订：

| Codex | `AgentEvent` | 说明 |
|---|---|---|
| `item/agentMessage/delta` | `assistant.delta`（`kind:"text"`） | `attemptId` 用 `itemId`；不需要 `DeltaMerger` |
| `item/reasoning/textDelta`、`summaryTextDelta` | `assistant.delta`（`kind:"reasoning"`） | |
| `item/completed` agentMessage | `assistant.message`（`replaces` 同一 `itemId` 的增量）+ `assistant.stream_ended` | |
| `item/completed` reasoning | `assistant.thought` | `content` 是字符串数组 |
| `item/started` commandExecution / fileChange / mcpToolCall / dynamicToolCall / webSearch / collabAgentToolCall | `tool.started` | `display` 直接从 item 类型与 `commandActions` 得出，不必像 dsh 那样猜工具名 |
| `item/commandExecution/outputDelta`、`item/fileChange/patchUpdated`、`item/mcpToolCall/progress` | `tool.updated` | 短命令可能没有增量 |
| `item/completed` 同上各类 | `tool.finished` | `declined` 要映射：`tool.finished` 只有 completed / failed，拒绝的语义由审批事件承担，或给 `ToolFinishedEvent` 加状态 |
| `turn/plan/updated` | `todo.updated` | 需要 `tools.update_plan.enabled=true`；没有对应的工具调用 id，`toolCallId` 要另定 |
| `thread/tokenUsage/updated` | `usage.updated` | 上下文大小来自模型目录的 `context_window` |
| `item/*/requestApproval`（服务端请求） | `approval.requested` | 选项：accept / acceptForSession / decline / cancel |
| `serverRequest/resolved`（Wevir 没回复过的） | `approval.cancelled` | 在 `turn/completed` 之后才到 |
| `turn/completed` completed / interrupted / failed | `turn.settled`（completed / cancelled）/ `turn.failed` | `error.codexErrorInfo` 用来归类 |
| `error`（`willRetry:true`） | `engine.raw` 或新的“重试中”事件 | |
| 子 thread 的所有事件 | 折叠到父会话的工具卡片，或协议新增子会话 | 见 ADR-0005 未决事项 |
| `thread/name/updated` | 会话标题 | 生成标题的模型常量 `gpt-5.6-luna` 在 TUI 里（`tui/src/app/thread_title.rs:30`）；Spike 的 app-server 回合里没见到 `thread/name/updated`，标题大概要 Wevir 自己生成后调 `thread/name/set`（**未核实**） |
| 子进程退出 | `engine.exited` | |
| 其余 | `engine.raw` | |

## 11. 尚未核实

- 真实模型只跑了 DeepSeek，每种接法一轮：apply_patch 的成功率要多跑才有数；DeepSeek Chat 接口的思考开关与推理强度参数没试；其他服务（Kimi、GLM、通义、xAI）都没跑。
- GLM、通义对自定义工具的实际支持；GLM 按量付费 Key 能否用于 Codex。
- Grok Build 的 ACP 细节（流式、工具 kind、审批选项）与订阅档位。
- Windows（MXC）与 Linux（bwrap）沙箱在 Wevir 的分发方式下能否工作；macOS 上 Seatbelt 嵌在 Electron 应用里的签名与权限问题。
- SIWC（应用自己注册 client ID）对 Wevir 是否值得做，对比 app-server 自带登录。

## 12. 来源

- Codex 源码：`upstream/codex` @ `092d3ac`（文中路径）；`app-server-protocol/schema/typescript/`；`core/tests/common/responses.rs:753-1081`。上一会话的英文报告（`815ef9b`）。
- Codex 文档与讨论：learn.chatgpt.com/docs/app-server、learn.chatgpt.com/docs/auth、developers.openai.com/siwc/quickstart 与 token-sharing-open-source 系列、openai.com/policies/sign-in-with-chatgpt-terms、openai.com/policies/row-terms-of-use、github.com/openai/codex/discussions/7782、github.com/openai/codex/issues/46773。
- DeepSeek：api-docs.deepseek.com/quick_start/agent_integrations/codex、api-docs.deepseek.com/guides/responses_api/、api-docs.deepseek.com/updates。
- Kimi：platform.kimi.com/docs/guide/codex-kimi、platform.kimi.com/docs/api/responses。GLM：docs.bigmodel.cn/cn/coding-plan/tool/codex.md、docs.bigmodel.cn/openapi/openapi-responses.json。通义：help.aliyun.com/zh/model-studio/codex、help.aliyun.com/zh/model-studio/compatibility-with-openai-responses-api。MiniMax：platform.minimax.cn/docs/m-plan/codex.md。阶跃：platform.stepfun.com/docs/zh/guides/developer/integrations/codex。硅基流动：docs.siliconflow.cn/docs/usercases/use-siliconcloud-in-codex。OpenRouter：openrouter.ai/docs/cookbook/coding-agents/codex-cli.md。
- 桥接：github.com/BerriAI/litellm（`litellm/responses/litellm_completion_transformation/`）、github.com/farion1231/cc-switch（`src-tauri/src/proxy/providers/transform_codex_*.rs`）、github.com/router-for-me/CLIProxyAPI、github.com/QuantumNous/new-api。
- Google：developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals、github.com/google-gemini/gemini-cli（`docs/resources/tos-privacy.md`、`docs/cli/acp-mode.md`、discussions/20632、issues/28229；源码 @ `4a0749a`）、ai.google.dev/gemini-api/docs/openai、antigravity.google/terms、github.com/openclaw/openclaw/issues/14203。
- xAI：docs.x.ai（Responses 参考、build/overview、build/cli/headless-scripting、x-subscription/usage-limits）、github.com/xai-org/grok-build @ `2bdd1d6`、x.ai/news/grok-hermes、x.ai/legal/terms-of-service、x.ai/legal/acceptable-use-policy。
- Anthropic：code.claude.com/docs/en/legal-and-compliance、platform.claude.com/docs/en/api/openai-sdk。
- dsh：`upstream/deepseek-harness` @ `d743267`（文中路径）。
