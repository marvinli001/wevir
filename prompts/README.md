# Wevir 提示词

这里是 Wevir 自己的提示词：Agent 的基础提示词、计划模式、审批自动复核、会话标题、输入建议、离开后摘要、自动修复，以及内置浏览器、Chrome、电脑操作三个插件的技能说明。它们是 ADR-0005 未决事项 1（基础提示词）的结果（补记 2）：经网关的第三方模型不再用 Codex 的 `prompt.md` 原文，改用 Wevir 自己的。

`base.md` 从 R2 起由 adapter-codex 加载（`packages/adapter-codex/src/prompts.ts`），`thread-title.md` 从 R3 起由 Host 加载（`packages/host/src/title.ts`），`prompt-suggestion.md` 从 0.53.0 起由 Host 加载（`packages/host/src/prompt-suggestion.ts`），`session-recap.md` 从 0.54.0 起由 Host 加载（`packages/host/src/recap.ts`），`verification-repair.md` 从 0.65.0 起由 Host 加载（`packages/host/src/verification/service.ts`），`plan-mode.md` 从 0.36.0 起由 adapter-codex 加载，其余还只是文本。谁来加载、什么时候加载，见下面的表；0.41.0 起 MCP 与 skills 由 Host 全局注册表接入，格式与默认禁用外部项的规则见 docs/architecture/plugins.md；三个内置插件草稿仍是占位。

## 文件

| 文件 | 用途 | 由谁加载 | 状态 |
|---|---|---|---|
| [`base.md`](base.md) | Codex 引擎的基础提示词，给经网关的第三方模型用 | adapter-codex（R2）：渲染后写进生成的模型目录的 `base_instructions`，并按会话的 Provider 与模型写进 `thread/start` 的 `baseInstructions`（两者都是稳定面，docs/architecture/codex-event-mapping.md §3） | 已接入；skills 与 MCP 0.41.0 起由 Host 注册表交给 Codex（联网搜索 0.34.0 起是 `wevir_web`） |
| [`plan-mode.md`](plan-mode.md) | 计划模式的协作说明 | adapter-codex（0.36.0，ADR-0005 补记 21）：经网关的第三方模型在计划模式的回合里，作为 `turn/start` 的协作模式（`collaborationMode.settings.developer_instructions`）下发；ChatGPT 登录的 OpenAI 模型用 Codex 内置的模板 | 已接入（Codex 引擎） |
| [`compact.md`](compact.md) | 上下文压缩说明（交接摘要） | adapter-codex（2026-10-18）：经网关的第三方模型的 thread 在 `thread/start` / `resume` / `fork` 时带 `config.compact_prompt`，替换 Codex 自带的那条短说明；用户的 `/compact` 与自动压缩读同一个配置；ChatGPT 登录的 OpenAI 模型仍用 Codex 内置的说明 | 已接入（Codex 引擎） |
| [`auto-review.md`](auto-review.md) | 审批自动复核员 | Host（新功能），与引擎无关 | 可用；只读工具是占位 |
| [`thread-title.md`](thread-title.md) | 会话标题与检索摘要 | Host（R3，`packages/host/src/title.ts`）：去掉注释作为说明；请求由适配器的 `generateTitle` 用会话的模型发（Codex 引擎，docs/architecture/codex-event-mapping.md §4.4） | 已接入（Codex 引擎） |
| [`prompt-suggestion.md`](prompt-suggestion.md) | 输入建议：预测用户接着会发的一句话 | Host（0.53.0，`packages/host/src/prompt-suggestion.ts`）：去掉注释作为说明；请求同样由适配器的 `generateTitle` 用会话的模型发（不带工具的单次生成，不另开引擎连接） | 已接入（有 `generateTitle` 的引擎：Codex、Claude、OpenCode） |
| [`session-recap.md`](session-recap.md) | 离开后摘要：回到离开过的会话时的一到三句话小结 | Host（0.54.0，`packages/host/src/recap.ts`）：去掉注释作为说明；请求同样由适配器的 `generateTitle` 用会话的模型发 | 已接入（带 `generateTitle` 的引擎：Codex、Claude、OpenCode） |
| [`verification-repair.md`](verification-repair.md) | 自动修复：回合后的项目检查没通过时交给 Agent 的说明与失败材料 | Host（0.65.0，`packages/host/src/verification/service.ts`）：去掉注释，替换 `attempt`、`max_attempts`、`failures` 后作为一条带 `from.repair` 的消息开修复回合；读不到时 Host 照常启动，只是没有回合后验证 | 已接入，与引擎无关 |
| [`plugins/in-app-browser/SKILL.md`](plugins/in-app-browser/SKILL.md) | 内置浏览器插件的技能说明 | 插件（未建） | 草稿；工具清单是占位 |
| [`plugins/chrome/SKILL.md`](plugins/chrome/SKILL.md) | Chrome 插件的技能说明 | 插件（未建） | 草稿；工具清单是占位 |
| [`plugins/computer-use/SKILL.md`](plugins/computer-use/SKILL.md) | 电脑操作插件的技能说明 | 插件（未建） | 草稿；工具清单与授权是占位 |
| [`plugins/shared/browser-operation.md`](plugins/shared/browser-operation.md) | 两个浏览器插件共用的操作要领与安全规则 | 被引入 | 可用 |
| [`plugins/shared/ui-action-confirmations.md`](plugins/shared/ui-action-confirmations.md) | 三个插件共用的界面操作确认规则 | 被引入 | 可用 |

## 用在哪些模型上

- **Codex 引擎 + 经网关的第三方模型**（DeepSeek、通义、Kimi、GLM、自定义服务等）：`base.md`。
- **ChatGPT 订阅登录 + OpenAI 模型**：继续用 Codex 模型目录里按模型调好的提示词（ADR-0005 未决事项 1 原先的建议）。那些提示词针对 OpenAI 模型调过，Wevir 不替换。
- **dsh、Grok Build、Gemini CLI 等通用 ACP 引擎**：用各自的提示词。`base.md` 里的工具名都是 Codex 的，不适用。
- **`auto-review.md`、`thread-title.md`、`prompt-suggestion.md` 与 `session-recap.md`**：与引擎无关，由 Host 直接调模型。
- **`verification-repair.md`**：与引擎无关，不单独调模型，是修复回合里交给会话自己的模型的一条消息。
- **`compact.md`**：只在 Codex 引擎 + 经网关的第三方模型的 thread 上生效，用 `compact_prompt` 下发。

## Codex 一回合里模型看到的说明

按顺序：

1. `base.md`（第一条 developer 消息；Codex 不发 Responses 的 `instructions` 字段，codex-notes §5）。
2. Codex 生成的权限说明：沙箱模式与审批策略（`codex-rs/prompts/templates/permissions/`），Wevir 不改。
3. 用户自定义指令：经 `thread/start` 的 `developerInstructions` 下发（占位，未做）。
4. 协作模式说明（`<collaboration_mode>`，0.36.0 起每个回合都带）：默认模式用 Codex 内置的 `default.md`；计划模式经网关的模型用 `plan-mode.md`，ChatGPT 登录的模型用 Codex 内置的 `plan.md`。它是单独的一条 developer 消息，不替换第 3 条。
5. Codex 生成的 skills 列表：0.41.0 起 Host 绑定注册表时打开 skills.include_instructions，逐路径禁用未获 Host 启用的外部 skills（codex-event-mapping.md §10）；未绑定注册表的独立适配器保留关闭默认值。
6. AGENTS.md 内容与 `<environment_context>`（Codex 生成）。
7. 用户消息。

经网关的第三方模型有一个额外的坑：Codex 只把 MCP 服务的 `instructions`（`wevir` 的应用级工具说明与跨会话记忆索引都在里面）写进该服务命名空间工具的 `description`，网关摊平命名空间时会丢掉它。所以网关把 `mcp__` 开头的命名空间的说明接进请求的 system 消息，一节 `# Instructions from MCP servers`（docs/architecture/model-gateway.md §4.1）；ChatGPT 登录的模型走原生 Responses，不受影响。

`base.md` 按 Wevir 给 Codex 的配置写：Codex 托管的联网搜索、插件都是关的（ADR-0005 决策 5 与补记），联网用 Wevir 自己的 `wevir_web`（0.34.0，docs/architecture/web-tools.md），目标（goals，0.35.0 起，补记 20）与 `update_plan` 是开的，子智能体用 `multi_agent_v1`。配置变了要同步改 `base.md` 的“工具”一节。

## 模板语法

文件在交给模型之前由加载方渲染，规则只有四条：

1. 先删除所有 HTML 注释 `<!-- … -->`。注释只给维护者看：文件头的来源说明、占位说明都写在注释里。注释里不要写 `{{`。
2. `{{> 路径 }}` 引入另一个文件，路径相对 `prompts/`；被引入的文件同样先删注释。
3. `{{ 变量 }}` 替换成变量的值。变量缺失时报错，不要留空。
4. 渲染结果里不得残留 `{{`。Codex 自己也用 `{{ }}` 作模板变量（模型目录的 `instructions_template`），残留会被它误处理。

SKILL.md 开头的 YAML 头（`name`、`description`）保持在文件第一行，供插件系统读取。

### 变量

| 文件 | 变量 | 值 |
|---|---|---|
| `base.md` | `model_display_name` | 模型的显示名，来自 Provider 的模型列表 |
| `base.md` | `provider_display_name` | Provider 的显示名 |
| `auto-review.md` | `trusted_destinations` | 用户配置的可信目的地列表；没有配置时填“（无）” |
| `auto-review.md` | `user_policy` | 用户补充的复核规则；没有时填“（无）” |

## 审批自动复核

- 触发：引擎发来审批请求、并且用户为这个会话打开了自动复核时（开关与默认值未定）。
- 输入：一条用户消息，内含 `<transcript>`（对话记录，每项标明来源，可信与不可信分开）与 `<planned_action>`（`kind` 为 `command`、`file_change`、`network`、`permission`，以后加 `mcp_tool`、`browser`、`computer_use`）。记录过长时 Host 截断并插入 `<truncated … />` 标记。
- 输出：一个 JSON 对象 `{risk_level, user_authorization, outcome, rationale}`。服务支持结构化输出时用 JSON Schema 约束，否则解析失败按 `deny` 处理并交给用户。
- 结论只映射为“本次允许”或“拒绝并说明理由”，不会替用户选“本会话都允许”。被拒绝的操作照常出现在会话里，`rationale` 显示给用户；用户可以在对话里明确再次批准（`auto-review.md` 有对应规则）。
- 不用 Codex 自带的 `approvals_reviewer = "auto_review"`：它用写死的 OpenAI 模型名（ADR-0005 决策 5）。

## 会话标题

- 第一个回合开始后（引擎接受了第一条消息），Host 用会话第一条用户消息生成标题；生成出来之前先用现有的截断规则（`session-manager.ts` 的 `makeTitle`）兜底，用户手动改过标题（`titleSource: 'user'`）就不再自动生成，生成失败或超时（60 s）只记告警、保留截断的标题。协议 0.5.0 的 `TitleSource` 加了 `generated`（旧客户端看到 `first_prompt`，host-api.md §10）。适配器不实现 `generateTitle` 的引擎（dsh）只有截断的标题。
- 输入：`<user_prompt>` 或 `<conversation>`（最近几条 user 与 assistant 消息，`<`、`>`、`&` 转义）。总长度建议限制在 1 KB 左右，与 Codex 的做法一致。
- 输出：`{"title", "description"}`（支持结构化输出的路径用 JSON Schema 约束）。Host 取第一个 `{` 到最后一个 `}` 之间的 JSON，去掉首尾引号与结尾标点、折叠空白，标题截到 36 个字符、摘要截到 100 个字符；`description` 存在 `session.title_changed` 事件里，等有会话搜索时用。
- 模型：用当前会话的模型（维护者 2026-10-14 定），推理档位取最低。经网关的会话由适配器经网关直接发一次不带工具的请求；ChatGPT 登录的会话（R6）用 Codex 的临时 thread（`ephemeral` + `outputSchema`）。

## 输入建议

- 触发：会话的一个回合以 `completed` 结束后（`turn.finished` 写入之后，异步），Host 设置 `promptSuggestions` 开着（默认开）。顶层的会话才生成：子会话、支线、agent 开的会话、计划模式的回合、命令开的回合（压缩、审查）与目标续跑不生成；会话不空闲，或有待审批、待回答、排着的消息时也不生成；这个回合没有助手的回答时省掉请求。同一个回合只生成一次。
- 输入：一条用户消息，内含 `<conversation>`——最近至多 8 条（用户消息、助手回答、`<action>` 命令 / 文件改动 / 错误），`<`、`>`、`&` 转义，单条至多 700 个字符（助手的回答留结尾，其余留开头），总长约 3 KB 以内。
- 输出：`{"suggestion": "…"}`，没有合适的建议时 `suggestion` 为空串（服务支持结构化输出时用 JSON Schema 约束）。Host 取第一个 `{` 到最后一个 `}` 之间的 JSON，折叠空白、去掉首尾引号；空、占位词（“无”“none”）、过长（80 个字符或 15 个词）、提问、助手的口吻、评价与致谢、带 Markdown 的一律丢弃，不显示、不记告警。
- 成功后写 `suggestion.updated`；用户有了新消息、回合重新开始或被撤回 / 撤销 / 重做时作废（生成到一半的请求被中止）。请求失败、超时（30 s）只记告警，不影响会话。
- 模型：用当前会话的模型，推理档位取最低——与会话标题同一条路径，所以订阅来源（Claude）每个回合会多一次轻量请求；用户可以在设置 → 常规里关掉。

## 离开后摘要

- 触发（0.54.0，docs/architecture/domain-model.md §3.24）：桌面端报告“用户回到这个会话，离开了 `awayMs`，离开时看到的最后一个事件是 `seenSeq`”（`session.recap`），Host 判断要不要生成。离开不足 3 分钟、期间没有新的助手输出（没有 `assistant.message` 或 `turn.finished` 落在 `seenSeq` 之后）、会话还在运行回合或有待审批 / 待回答的提问、子智能体或支线会话、看得见的完整回合少于 2 个、设置里关了，都不生成，结果里写明原因。
- 输入：`<conversation>`（最近至多 8 条用户与助手消息，较早的省略，用户消息截到 400 字符、助手消息保留最后 700 字符，总长限制在约 6 KB，`<`、`>`、`&` 转义）与 `<state>`（`last_turn` 的结局，有未做完的清单项时加 `open_todos`）。
- 输出：`{"recap": "…"}`。Host 取第一个 `{` 到最后一个 `}` 之间的 JSON（解析不了时把整段输出当作摘要），去掉代码块、首尾引号、`摘要：` 这类前缀与 Markdown 记号，折叠空白，最多留三句、240 个字符；整理后为空就算失败。
- 模型：用当前会话的模型，推理档位取最低，经适配器的 `generateTitle`（不新开引擎连接，不排进会话的命令队列，不影响状态机）。超时 30 s、失败静默（只记告警）。
- 缓存：只在 Host 内存里、按会话存，不写事件库；同一次“看得见的最后一个回合”只生成一次，并发的请求共用同一次生成，之后的请求直接拿缓存。

## 来源与许可

改写自 OpenAI Codex 开源仓库（Apache-2.0，`rust-v0.162.1` = `092d3ac`）的部分，文件头写明了来源与修改，并登记在 [UPSTREAM.md §4](../docs/upstream/UPSTREAM.md) 与根目录 [`NOTICE`](../NOTICE)：

| Wevir 文件 | Codex 来源 |
|---|---|
| `base.md` | `codex-rs/protocol/src/prompts/base_instructions/default.md` |
| `plan-mode.md` | `codex-rs/collaboration-mode-templates/templates/plan.md` |
| `auto-review.md` | `codex-rs/prompts/templates/guardian/{policy_template,policy,node_repl_policy}.md` |
| `thread-title.md` | `codex-rs/tui/src/app/thread_title.rs` 里的说明文字 |

`base.md` 的授权与确认、自主与坚持、写作与最终回答等部分，以及三个插件的说明和共用规则，是 Wevir 自己写的。`prompt-suggestion.md` 也是 Wevir 自己写的，参考了网上流传的 Claude Code 输入建议提示词（asgeirtj/system_prompts_leaks，没有许可证）的做法——预测用户而不是助手、简短、拿不准就不输出、不评价不提问——只借鉴做法，没有摘抄原文。写的时候参考了维护者提供的 Codex 桌面版提示词资料（非开源），只借鉴做法，没有摘抄原文；“联网与外部信息”一节参考的是网上流传的 Codex gpt-6.1-sol 提示词（asgeirtj/system_prompts_leaks，没有许可证），同样只借鉴做法、用自己的话写。2026-10-18 起，`compact.md`、`plan-mode.md`、`thread-title.md`、`base.md` 的子智能体与 `update_plan` 两节，以及 Host 内置角色（`packages/host/src/roles.ts`）的说明，参考了同一个仓库里网上流传的 Claude Code 压缩、计划模式、会话标题与重命名、Explore / Plan / general-purpose 子智能体、advisor 工具、`/btw` 的提示词，也只借鉴做法（分节的交接摘要、先找可复用的、标题写成名词短语、只读探查角色的边界、第二意见的用法等）、用自己的话写，没有摘抄。`session-recap.md` 参考的是网上流传的 Claude Code 离开后摘要提示词（同一个仓库，没有许可证），只借鉴“先说高层任务、再说具体的下一步、不做状态播报”的思路，措辞、结构与示例都是 Wevir 的。这些文件按 Wevir 的 MIT 许可发布；从 Codex 改写的文件（`base.md`、`plan-mode.md`、`auto-review.md`、`thread-title.md`）按 Apache-2.0。

## 改提示词时

- 改 `base.md` 或 `plan-mode.md` 要在至少一家真实模型上跑一遍 adapter-codex 的第三层契约测试（随 adapter-codex 建立）；改 `auto-review.md`、`thread-title.md`、`prompt-suggestion.md` 与 `session-recap.md` 要跑各自的用例集（随 Host 的实现建立）。
- 改了 Codex 来源的文件，更新文件头的“由 Wevir 修改”；升级 Codex 时对照上面四个来源的变化，决定要不要跟进。
- 新增引擎配置（打开某个工具或功能）时，同步改 `base.md` 的“工具”一节，并删掉对应的占位。

## 未决

1. ~~**计划模式怎样下发**~~（ADR-0005 未决事项 5）：已定（2026-10-15，ADR-0005 补记 21）。开实验面，用 Codex 原生的协作模式：`plan-mode.md` 作为计划模式的 `developer_instructions`（经网关的模型），`<proposed_plan>` 由 Codex 解析成计划条目，`request_user_input` 照常；计划回合不改沙箱，只读靠说明约束（同 Codex）。
2. **自动复核用哪个模型、是否经网关、默认开不开。** 随 Host 的实现任务决定。
3. **三个插件的形态。** 浏览器放在桌面端哪里、用什么驱动、Chrome 用扩展还是 CDP、电脑操作先做哪个平台、工具怎样暴露给 Codex（MCP 还是动态工具），建插件时决定，再补各 SKILL.md 的占位。

## 自动修复

用户在项目设置里打开自动修复后，回合结束后 Host 跑的检查没有通过时，Host 用 `verification-repair.md` 开一个修复回合（默认最多 2 次，另有总时长与用量上限）。失败材料由 Host 拼好：每个失败的检查一个 `<check-output>` 块，属性里是检查名称、版本、命令、目录、状态、退出码、测试计数、代码状态、原回合与完整输出的路径，正文是输出的尾部（每个检查最多 6000 字，整份最多 24000 字，正文里的 `</check-output>` 会被改写）。说明里写明这些块是数据、不是指令。修复回合结束后 Host 重跑同样的检查，以那次结果为准；修复回合本身不再触发回合后检查。
