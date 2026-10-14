# Wevir 提示词

这里是 Wevir 自己的提示词：Agent 的基础提示词、计划模式、审批自动复核、会话标题，以及内置浏览器、Chrome、电脑操作三个插件的技能说明。它们是 ADR-0005 未决事项 1（基础提示词）的结果（补记 2）：经网关的第三方模型不再用 Codex 的 `prompt.md` 原文，改用 Wevir 自己的。

`base.md` 从 R2 起由 adapter-codex 加载（`packages/adapter-codex/src/prompts.ts`），`thread-title.md` 从 R3 起由 Host 加载（`packages/host/src/title.ts`），其余还只是文本。谁来加载、什么时候加载，见下面的表；MCP、插件、skills 这些还没开始建设的部分在文件里留了占位。

## 文件

| 文件 | 用途 | 由谁加载 | 状态 |
|---|---|---|---|
| [`base.md`](base.md) | Codex 引擎的基础提示词，给经网关的第三方模型用 | adapter-codex（R2）：渲染后写进生成的模型目录的 `base_instructions`，并按会话的 Provider 与模型写进 `thread/start` 的 `baseInstructions`（两者都是稳定面，docs/architecture/codex-event-mapping.md §3） | 已接入；联网搜索、skills、插件、MCP 是占位 |
| [`plan-mode.md`](plan-mode.md) | 计划模式的协作说明 | 下发方式未定，见“未决” | 可用 |
| [`auto-review.md`](auto-review.md) | 审批自动复核员 | Host（新功能），与引擎无关 | 可用；只读工具是占位 |
| [`thread-title.md`](thread-title.md) | 会话标题与检索摘要 | Host（R3，`packages/host/src/title.ts`）：去掉注释作为说明；请求由适配器的 `generateTitle` 用会话的模型发（Codex 引擎，docs/architecture/codex-event-mapping.md §4.4） | 已接入（Codex 引擎） |
| [`plugins/in-app-browser/SKILL.md`](plugins/in-app-browser/SKILL.md) | 内置浏览器插件的技能说明 | 插件（未建） | 草稿；工具清单是占位 |
| [`plugins/chrome/SKILL.md`](plugins/chrome/SKILL.md) | Chrome 插件的技能说明 | 插件（未建） | 草稿；工具清单是占位 |
| [`plugins/computer-use/SKILL.md`](plugins/computer-use/SKILL.md) | 电脑操作插件的技能说明 | 插件（未建） | 草稿；工具清单与授权是占位 |
| [`plugins/shared/browser-operation.md`](plugins/shared/browser-operation.md) | 两个浏览器插件共用的操作要领与安全规则 | 被引入 | 可用 |
| [`plugins/shared/ui-action-confirmations.md`](plugins/shared/ui-action-confirmations.md) | 三个插件共用的界面操作确认规则 | 被引入 | 可用 |

## 用在哪些模型上

- **Codex 引擎 + 经网关的第三方模型**（DeepSeek、通义、Kimi、GLM、自定义服务等）：`base.md`。
- **ChatGPT 订阅登录 + OpenAI 模型**：继续用 Codex 模型目录里按模型调好的提示词（ADR-0005 未决事项 1 原先的建议）。那些提示词针对 OpenAI 模型调过，Wevir 不替换。
- **dsh、Grok Build、Gemini CLI 等通用 ACP 引擎**：用各自的提示词。`base.md` 里的工具名都是 Codex 的，不适用。
- **`auto-review.md` 与 `thread-title.md`**：与引擎无关，由 Host 直接调模型。

## Codex 一回合里模型看到的说明

按顺序：

1. `base.md`（第一条 developer 消息；Codex 不发 Responses 的 `instructions` 字段，codex-notes §5）。
2. Codex 生成的权限说明：沙箱模式与审批策略（`codex-rs/prompts/templates/permissions/`），Wevir 不改。
3. 用户自定义指令：经 `thread/start` 的 `developerInstructions` 下发（占位，未做）。
4. 协作模式说明：默认模式用 Codex 内置的；计划模式用 `plan-mode.md`。
5. Codex 生成的 skills 列表：adapter-codex 用 `skills.include_instructions = false` 关掉了（否则会把用户 `~/.agents/skills` 里给别的工具装的 skills 列出来，codex-event-mapping.md §1.3），Wevir 的 skills 建好后再开。
6. AGENTS.md 内容与 `<environment_context>`（Codex 生成）。
7. 用户消息。

`base.md` 按 Wevir 给 Codex 的配置写：联网搜索、目标（goals）、插件都是关的（ADR-0005 决策 5 与补记），`update_plan` 是开的，子智能体用 `multi_agent_v1`。配置变了要同步改 `base.md` 的“工具”一节。

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

## 来源与许可

改写自 OpenAI Codex 开源仓库（Apache-2.0，`rust-v0.162.1` = `092d3ac`）的部分，文件头写明了来源与修改，并登记在 [UPSTREAM.md §4](../docs/upstream/UPSTREAM.md) 与根目录 [`NOTICE`](../NOTICE)：

| Wevir 文件 | Codex 来源 |
|---|---|
| `base.md` | `codex-rs/protocol/src/prompts/base_instructions/default.md` |
| `plan-mode.md` | `codex-rs/collaboration-mode-templates/templates/plan.md` |
| `auto-review.md` | `codex-rs/prompts/templates/guardian/{policy_template,policy,node_repl_policy}.md` |
| `thread-title.md` | `codex-rs/tui/src/app/thread_title.rs` 里的说明文字 |

`base.md` 的授权与确认、自主与坚持、写作与最终回答等部分，以及三个插件的说明和共用规则，是 Wevir 自己写的。写的时候参考了维护者提供的 Codex 桌面版提示词资料（非开源），只借鉴做法，没有摘抄原文。这些文件按 Wevir 的 MIT 许可发布；从 Codex 改写的四个文件按 Apache-2.0。

## 改提示词时

- 改 `base.md` 或 `plan-mode.md` 要在至少一家真实模型上跑一遍 adapter-codex 的第三层契约测试（随 adapter-codex 建立）；改 `auto-review.md` 与 `thread-title.md` 要跑各自的用例集（随 Host 的实现建立）。
- 改了 Codex 来源的文件，更新文件头的“由 Wevir 修改”；升级 Codex 时对照上面四个来源的变化，决定要不要跟进。
- 新增引擎配置（打开某个工具或功能）时，同步改 `base.md` 的“工具”一节，并删掉对应的占位。

## 未决

1. **计划模式怎样下发**（ADR-0005 未决事项 5）。Codex 的协作模式是实验面，而 ADR-0005 决策 5 只用稳定面。开这一项实验面，就能用上只在计划模式提供的 `request_user_input` 和 Codex 对 `<proposed_plan>` 的解析；不开就由 Wevir 自己做：计划回合把稳定面的 `sandboxPolicy` 设为只读、把 `plan-mode.md` 放在用户消息前面，提问退回纯文本，计划由 Wevir 从消息里解析。
2. **自动复核用哪个模型、是否经网关、默认开不开。** 随 Host 的实现任务决定。
3. **三个插件的形态。** 浏览器放在桌面端哪里、用什么驱动、Chrome 用扩展还是 CDP、电脑操作先做哪个平台、工具怎样暴露给 Codex（MCP 还是动态工具），建插件时决定，再补各 SKILL.md 的占位。
