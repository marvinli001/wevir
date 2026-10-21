# Wevir 提示词

这里是 Wevir 自己的提示词：Agent 的基础提示词、计划模式、审批自动复核、会话标题、输入建议、离开后摘要、你应该知道、任务回顾摘要、自动修复、用户说明的开头与输出风格，以及内置浏览器、Chrome、电脑操作三个插件的技能说明。它们是 ADR-0005 未决事项 1（基础提示词）的结果（补记 2）：经网关的第三方模型不再用 Codex 的 `prompt.md` 原文，改用 Wevir 自己的。

`base.md` 从 R2 起由 adapter-codex 加载（`packages/adapter-codex/src/prompts.ts`），`thread-title.md` 从 R3 起由 Host 加载（`packages/host/src/title.ts`），`prompt-suggestion.md` 从 0.53.0 起由 Host 加载（`packages/host/src/prompt-suggestion.ts`），`session-recap.md` 从 0.54.0 起由 Host 加载（`packages/host/src/recap.ts`），`session-insight.md` 从 0.79.0 起由 Host 加载（`packages/host/src/insight.ts`），`verification-repair.md` 从 0.65.0 起由 Host 加载（`packages/host/src/verification/service.ts`），`session-retro.md` 从 0.76.0 起由 Host 加载（`packages/host/src/retro/summary.ts`），`user-instructions.md` 与 `output-styles/` 从 0.78.0 起由 Host 加载（`packages/host/src/custom-instructions.ts`），`plan-mode.md` 从 0.36.0 起由 adapter-codex 加载，其余还只是文本。谁来加载、什么时候加载，见下面的表；0.41.0 起 MCP 与 skills 由 Host 全局注册表接入，格式与默认禁用外部项的规则见 docs/architecture/plugins.md；三个内置插件草稿仍是占位。

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
| [`session-insight.md`](session-insight.md) | 你应该知道：旁观会话，偶尔提出一件用户大概没注意到、但有后果的事 | Host（0.79.0，`packages/host/src/insight.ts`）：去掉注释作为说明；回合结束后按频率限制由适配器的 `generateTitle` 用会话的模型发；设置里默认关 | 已接入（带 `generateTitle` 的引擎：Codex、Claude、OpenCode） |
| [`session-retro.md`](session-retro.md) | 任务回顾的模型摘要：把确定性生成的回顾压成几点，每点引用回顾里的行 ID | Host（0.76.0，`packages/host/src/retro/summary.ts`）：去掉注释作为说明；只在用户点“生成摘要”时由适配器的 `generateTitle` 用会话的模型发一次，输入是脱敏后的回顾；输出不覆盖回顾本身，没有有效出处的点标“推断” | 已接入（带 `generateTitle` 的引擎：Codex、Claude、OpenCode） |
| [`verification-repair.md`](verification-repair.md) | 自动修复：回合后的项目检查没通过时交给 Agent 的说明与失败材料 | Host（0.65.0，`packages/host/src/verification/service.ts`）：去掉注释，替换 `attempt`、`max_attempts`、`failures` 后作为一条带 `from.repair` 的消息开修复回合；读不到时 Host 照常启动，只是没有回合后验证 | 已接入，与引擎无关 |
| [`review-comments.md`](review-comments.md) | 行级批注：用户在“变更”窗格写的一组审阅意见，0.83.0 起也包括用户选了要处理的审查发现 | Host（0.67.0，`packages/host/src/review/service.ts`）：去掉注释，替换 `count`、`directory`、`version`、`comments` 后作为一条用户消息发给用户选的会话；读不到时 Host 照常启动，只是没有批注 | 已接入，与引擎无关 |
| [`second-opinion.md`](second-opinion.md) | 第二意见：另一个来源只读地审阅一个会话当前的改动 | Host（0.75.0，`packages/host/src/second-opinion.ts`）：去掉注释，替换 `session`、`directory`、`version`、`diff`、`material` 后接在 reviewer 角色说明后面，作为意见会话的第一条消息；读不到时 Host 照常启动，只是没有第二意见 | 已接入，与引擎无关 |
| [`user-instructions.md`](user-instructions.md) | 用户说明的开头：交给引擎的“用户的说明”最前面那段，说明优先级与边界 | Host（0.78.0，`packages/host/src/custom-instructions.ts`）：去掉注释，后面接用户的说明与风格的正文 | 已接入，与引擎无关 |
| [`output-styles/`](output-styles/) | 输出风格：`concise`（简洁）、`explanatory`（讲解）、`learning`（边做边学）、`proactive`（主动）、`pragmatic`（务实）、`friendly`（友好） | Host（0.78.0）：用户在设置里选了哪种就接哪份的正文；开头 `---` 块里的 `reminder` 在每条新回合的消息末尾附上（只有简洁与主动有） | 已接入，与引擎无关 |
| [`plugins/in-app-browser/SKILL.md`](plugins/in-app-browser/SKILL.md) | 内置浏览器插件的技能说明 | 插件（未建） | 草稿；工具清单是占位 |
| [`plugins/chrome/SKILL.md`](plugins/chrome/SKILL.md) | Chrome 插件的技能说明 | 插件（未建） | 草稿；工具清单是占位 |
| [`plugins/computer-use/SKILL.md`](plugins/computer-use/SKILL.md) | 电脑操作插件的技能说明 | 插件（未建） | 草稿；工具清单与授权是占位 |
| [`plugins/shared/browser-operation.md`](plugins/shared/browser-operation.md) | 两个浏览器插件共用的操作要领与安全规则 | 被引入 | 可用 |
| [`plugins/shared/ui-action-confirmations.md`](plugins/shared/ui-action-confirmations.md) | 三个插件共用的界面操作确认规则 | 被引入 | 可用 |

## 用在哪些模型上

- **Codex 引擎 + 经网关的第三方模型**（DeepSeek、通义、Kimi、GLM、自定义服务等）：`base.md`。
- **ChatGPT 订阅登录 + OpenAI 模型**：继续用 Codex 模型目录里按模型调好的提示词（ADR-0005 未决事项 1 原先的建议）。那些提示词针对 OpenAI 模型调过，Wevir 不替换。
- **dsh、Grok Build、Gemini CLI 等通用 ACP 引擎**：用各自的提示词。`base.md` 里的工具名都是 Codex 的，不适用。
- **`auto-review.md`、`thread-title.md`、`prompt-suggestion.md`、`session-recap.md`、`session-insight.md` 与 `session-retro.md`**：与引擎无关，由 Host 直接调模型。
- **`verification-repair.md`**：与引擎无关，不单独调模型，是修复回合里交给会话自己的模型的一条消息。
- **`compact.md`**：只在 Codex 引擎 + 经网关的第三方模型的 thread 上生效，用 `compact_prompt` 下发。
- **`user-instructions.md` 与 `output-styles/`**：与引擎无关，用在所有引擎上（下面「用户说明与输出风格」）。

## Codex 一回合里模型看到的说明

按顺序：

1. `base.md`（第一条 developer 消息；Codex 不发 Responses 的 `instructions` 字段，codex-notes §5）。
2. Codex 生成的权限说明：沙箱模式与审批策略（`codex-rs/prompts/templates/permissions/`），Wevir 不改。
3. Host 补给的规则文件与用户的说明（0.78.0）：经 `thread/start` / `thread/resume` 的 `developerInstructions` 下发，见下面「用户说明与输出风格」。
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

SKILL.md 开头的 YAML 头（`name`、`description`）保持在文件第一行，供插件系统读取。`output-styles/` 下的文件同样可以在第一行开一个 `---` 块，Host 只认其中的 `reminder: …` 一行（每回合提醒），渲染前去掉整个块。

### 变量

| 文件 | 变量 | 值 |
|---|---|---|
| `base.md` | `model_display_name` | 模型的显示名，来自 Provider 的模型列表 |
| `base.md` | `provider_display_name` | Provider 的显示名 |
| `auto-review.md` | `trusted_destinations` | 用户配置的可信目的地列表；没有配置时填“（无）” |
| `auto-review.md` | `user_policy` | 用户补充的复核规则；没有时填“（无）” |
| `review-comments.md` | `count` | 批注条数 |
| `review-comments.md` | `directory` | 批注所在的目录（仓库或会话的 worktree） |
| `review-comments.md` | `version` | diff 的两侧：基线提交，以及快照提交或“工作树” |
| `review-comments.md` | `comments` | 逐条的位置、原文代码块与意见，由 Host 拼好 |
| `second-opinion.md` | `session` | 原会话的 ID |
| `second-opinion.md` | `directory` | 快照所在的目录（意见会话的 worktree） |
| `second-opinion.md` | `version` | 快照对应的分支与提交 |
| `second-opinion.md` | `diff` | 看改动的命令：与默认分支的分叉点 `git diff <base>`，找不到时 `git diff HEAD` |
| `second-opinion.md` | `material` | 原会话的标题、目标、最近的用户消息、最后的回答、计划、任务清单、检查状态、侧重点与改动的文件，由 Host 拼好，最后替换 |

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

## 你应该知道

- 触发（0.79.0，docs/architecture/domain-model.md §3.33）：设置 → 常规的“旁观提示”开着（默认关）时，回合正常结束或出错后 Host 判断要不要检查。会话是子智能体、支线、agent 或第二意见开的、只读或归档的，回合结束后不空闲、有待审批 / 待回答的提问或排着的消息，还有一条没处理的提示，距上次检查不到 10 分钟，或上次检查之后 agent 做的事（命令、文件改动）不到 3 件，都不检查。Host 重启后频率限制从会话里最近一条提示的位置接着算。
- 输入：`<conversation>`（最近至多 60 条用户消息、助手回答与 `<action>` 命令 / 文件改动 / 错误，撤回与撤销的回合不算；用户消息截到 800 个字符、助手回答两头各留约 600 个字符、动作截到 300 个字符，总长约 16 KB 以内，丢最早的；`<`、`>`、`&` 转义）、`<state>`（`last_turn` 的结局）、`<offered>`（之前提过的一句话，最近 10 条）与 `<known>`（用户标为已知的标题与一句话，最近 10 条）。
- 输出：`{"show": …, "tag": …, "summary": …, "title": …, "detail": …}`，五个字段都必填（有的服务的结构化输出不接受可空字段），没有值得说的事时 `show` 为 `false`。Host 取第一个 `{` 到最后一个 `}` 之间的 JSON；`show` 不是 `true`、`tag` 不是 `heads_up` / `should_know`、三段文字有一段为空都算没有；一句话与标题折叠成一行、去掉首尾引号（标题再去掉句末标点），说明只去掉外层代码块；超长的截断（300 / 120 / 3000 个字符）；像密钥的片段换成 `[REDACTED]`。
- 成功后写 `insight.updated`（`open`）；用户点“已知”或“忽略”后经 `session.respondInsight` 再写一条（`known` / `dismissed`），已知的进之后检查的 `<known>`。提示不随撤回、撤销作废：说的是已经发生的事。请求失败、超时（60 s）只记告警，不影响会话。
- 模型：用当前会话的模型，推理档位取最低，经适配器的 `generateTitle`（不新开引擎连接，不排进会话的命令队列，不影响状态机）。每次检查都是一次额外的请求，所以默认关。

## 任务回顾摘要

- 触发（0.76.0，`retro.summarize`）：只在用户点“生成摘要”时调一次，不在后台生成。会话还在运行回合、子会话、没有回合、引擎没有 `generateTitle` 时不生成，结果里写明原因。
- 输入：脱敏后的回顾（与导出同一套正则检查）写成 `<retro>`，每行 `[ID] 种类: 内容`，`<`、`>`、`&` 转义，每行截到 300 个字符。目标、完成与未完成项、验证记录、改动、提交、批注、交付状态与下一步总是保留；回合、用户的决定与 Agent 的命令按时间放，总长超过约 12 KB 时丢掉较早的，并注明省略了几行。
- 输出：`{"points": [{"text": "…", "refs": ["…"]}]}`。Host 取第一个 `{` 到最后一个 `}` 之间的 JSON，最多留六点、每点 200 个字符；`refs` 只留输入里出现过的 ID（去重），一个都不剩的点标“推断”；没有可用的点就算失败，不保存。
- 模型：用当前会话的模型，经适配器的 `generateTitle`（不新开引擎连接，不影响状态机）。超时 60 s。拿得到 token 用量时一起显示。
- 存储：单独存一份（替换上一份），不写进事件库，也不改回顾本身；之后会话又有了新内容时标“早于最新事件”。

## 来源与许可

改写自 OpenAI Codex 开源仓库（Apache-2.0，`rust-v0.162.1` = `092d3ac`）的部分，文件头写明了来源与修改，并登记在 [UPSTREAM.md §4](../docs/upstream/UPSTREAM.md) 与根目录 [`NOTICE`](../NOTICE)：

| Wevir 文件 | Codex 来源 |
|---|---|
| `base.md` | `codex-rs/protocol/src/prompts/base_instructions/default.md` |
| `plan-mode.md` | `codex-rs/collaboration-mode-templates/templates/plan.md` |
| `auto-review.md` | `codex-rs/prompts/templates/guardian/{policy_template,policy,node_repl_policy}.md` |
| `thread-title.md` | `codex-rs/tui/src/app/thread_title.rs` 里的说明文字 |

`base.md` 的授权与确认、自主与坚持、写作与最终回答等部分，以及三个插件的说明和共用规则，是 Wevir 自己写的。`prompt-suggestion.md` 也是 Wevir 自己写的，参考了网上流传的 Claude Code 输入建议提示词（asgeirtj/system_prompts_leaks，没有许可证）的做法——预测用户而不是助手、简短、拿不准就不输出、不评价不提问——只借鉴做法，没有摘抄原文。写的时候参考了维护者提供的 Codex 桌面版提示词资料（非开源），只借鉴做法，没有摘抄原文；“联网与外部信息”一节参考的是网上流传的 Codex gpt-6.1-sol 提示词（asgeirtj/system_prompts_leaks，没有许可证），同样只借鉴做法、用自己的话写。2026-10-18 起，`compact.md`、`plan-mode.md`、`thread-title.md`、`base.md` 的子智能体与 `update_plan` 两节，以及 Host 内置角色（`packages/host/src/roles.ts`）的说明，参考了同一个仓库里网上流传的 Claude Code 压缩、计划模式、会话标题与重命名、Explore / Plan / general-purpose 子智能体、advisor 工具、`/btw` 的提示词，也只借鉴做法（分节的交接摘要、先找可复用的、标题写成名词短语、只读探查角色的边界、第二意见的用法等）、用自己的话写，没有摘抄。`output-styles/` 里简洁、讲解、边做边学、主动四份参考网上流传的 Claude Code 输出风格（Concise、Explanatory、Learning、Proactive，同一个仓库，没有许可证），务实与友好两份参考网上流传的 Codex 性格说明（`personality_pragmatic`、`personality_friendly`，同一个仓库，没有许可证；开源的 Codex 已把 `personality` 参数标为不再选择风格）：只借鉴条目、结构与做法（先说结果、写代码前后的要点、留一处 `TODO(human)` 请用户动手、主动但破坏性操作仍要确认、看重什么与提出异议的方式等），按 Wevir 的工具与计划模式改写，措辞与示例是自己的，没有摘抄原文。`session-recap.md` 参考的是网上流传的 Claude Code 离开后摘要提示词（同一个仓库，没有许可证），只借鉴“先说高层任务、再说具体的下一步、不做状态播报”的思路，措辞、结构与示例都是 Wevir 的。`session-insight.md` 参考的是同一个仓库里网上流传的 Claude Code “You should know” 提示词，只借鉴“旁观者默认不说话、只挑一件有后果的事、按用户表现出的水平说、收起时一句话展开后再讲清楚、两种口吻”的思路，措辞、结构与示例都是 Wevir 的。这些文件按 Wevir 的 MIT 许可发布；从 Codex 改写的文件（`base.md`、`plan-mode.md`、`auto-review.md`、`thread-title.md`）按 Apache-2.0。

## 改提示词时

- 改 `base.md` 或 `plan-mode.md` 要在至少一家真实模型上跑一遍 adapter-codex 的第三层契约测试（随 adapter-codex 建立）；改 `auto-review.md`、`thread-title.md`、`prompt-suggestion.md`、`session-recap.md` 与 `session-insight.md` 要跑各自的用例集（随 Host 的实现建立）。
- 改了 Codex 来源的文件，更新文件头的“由 Wevir 修改”；升级 Codex 时对照上面四个来源的变化，决定要不要跟进。
- 新增引擎配置（打开某个工具或功能）时，同步改 `base.md` 的“工具”一节，并删掉对应的占位。

## 未决

1. ~~**计划模式怎样下发**~~（ADR-0005 未决事项 5）：已定（2026-10-15，ADR-0005 补记 21）。开实验面，用 Codex 原生的协作模式：`plan-mode.md` 作为计划模式的 `developer_instructions`（经网关的模型），`<proposed_plan>` 由 Codex 解析成计划条目，`request_user_input` 照常；计划回合不改沙箱，只读靠说明约束（同 Codex）。
2. **自动复核用哪个模型、是否经网关、默认开不开。** 随 Host 的实现任务决定。
3. **三个插件的形态。** 浏览器放在桌面端哪里、用什么驱动、Chrome 用扩展还是 CDP、电脑操作先做哪个平台、工具怎样暴露给 Codex（MCP 还是动态工具），建插件时决定，再补各 SKILL.md 的占位。

## 用户说明与输出风格

用户在设置 → 个性化里写的“给 Agent 的说明”与选的输出风格（各一份，对所有项目有效），由 Host 在建会话、恢复与接力时拼成一段交给会话的引擎（0.78.0）：

1. `user-instructions.md` 的正文：这些说明优先于项目说明文件与 skill 的一般性要求，用户在对话里的明确要求优先于这里的一切；不放宽沙箱、审批与安全规则；回复语言照常跟随用户。
2. 用户的说明，包在 `<user_instructions>` 里；去掉首尾空白后为空就不放。
3. 输出风格的正文；选“默认”时不放。

这一段接在 Host 补给的规则文件后面，走同一个通道：Codex 进 `developerInstructions`，Claude 进 `systemPrompt` 的 `append`，OpenCode 进每条消息的 `system`；Cursor、Grok、Antigravity、WorkBuddy 没有可放的位置，放在下一条用户消息的开头。说明对所有会话都给；风格只给用户直接对话的会话，Agent 开的、带预设角色的、第二意见与自动化开的会话不给（“边做边学”会停下等人写代码，那些会话没有人在看）。

选了带 `reminder` 的风格（简洁、主动）时，每个新回合交给引擎的消息末尾多一段 `<system-reminder>`，消息记录里没有。插话不带。

已经开着的会话不跟着设置变：下一次恢复或接力时按当时的设置重新给。

## 自动修复

用户在项目设置里打开自动修复后，回合结束后 Host 跑的检查没有通过时，Host 用 `verification-repair.md` 开一个修复回合（默认最多 2 次，另有总时长与用量上限）。失败材料由 Host 拼好：每个失败的检查一个 `<check-output>` 块，属性里是检查名称、版本、命令、目录、状态、退出码、测试计数、代码状态、原回合与完整输出的路径，正文是输出的尾部（每个检查最多 6000 字，整份最多 24000 字，正文里的 `</check-output>` 会被改写）。说明里写明这些块是数据、不是指令。修复回合结束后 Host 重跑同样的检查，以那次结果为准；修复回合本身不再触发回合后检查。

## 第二意见

用户在会话里用 `/second-opinion`、或会话里的 agent 用 `wevir_second_opinion` 请另一个来源看这个会话当前的改动。Host 把原会话目录当时的样子（HEAD 加上没提交的改动与未跟踪文件）放进一个新的 worktree，在那里开一个 reviewer 角色的会话，第一条消息是角色说明加 `second-opinion.md`。材料放在 `<session-material>` 块里，说明里写明是数据、不是指令。意见会话第一个回合的最后一段回答就是意见，挂回原会话成一张卡片；用户点“引用”时 Host 再拼一条消息交给原会话的 agent，agent 自己请的意见好了自动引用。
