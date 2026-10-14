# 模型协议网关

> 状态：v0.1（R1，R10 加 Anthropic Messages）· 日期：2026-10-14 · Codex `rust-v0.162.1`（`092d3ac`）
> 依据：[ADR-0005](../adr/0005-agent-runtime-and-model-gateway.md) 决策 2 与补记 3、4；[Codex 研读与 Spike](../research/codex-notes.md) §3、§5、§6.3、§7.3；[Provider 配置桥接](./providers.md) §2.3、§6；Anthropic Messages API 的流式、思考、工具使用文档（2026-10 版）
> 代码：`packages/model-gateway/src/`（`gateway.ts`、`upstream.ts`、`providers.ts`、`dialects.ts`、`tools.ts`、`chat/request.ts`、`chat/response.ts`、`messages/request.ts`、`messages/response.ts`、`errors.ts`、`provider-test.ts`）；原型是 `spikes/codex-app-server/src/gateway.ts`
> 样本：`packages/model-gateway/src/test-fixtures/codex-requests/`（真实 `codex-app-server` 发出的请求，§9）

Codex 只会说 OpenAI Responses（codex-notes §3）。网关在 Host 进程里，对 Codex 暴露一个 Responses 端点，按 Provider 的协议把请求透传或转换给上游：Codex 只拿到网关的一次性令牌，上游 Key 只在 Host；Codex 附带的安装 ID、会话与回合 ID 不发给第三方；各家 Responses 实现的差异（方言）在这里修正，不碰 Codex。R1 做了 Responses 透传与 Chat Completions 转换，R10 加了 Anthropic Messages 转换（§5）；接进 Host 与 adapter-codex 是 R2。

```text
codex-app-server ──POST /v1/p/<providerId>/responses──► 网关（Host 进程，127.0.0.1:随机端口）
  Authorization: Bearer <网关令牌>                         ├─ openai-responses / deepseek-official：透传 + 方言修正 ──► <上游>/responses
                                                           ├─ openai-completions：Responses ⇄ Chat 转换 ─────────────► <上游>/chat/completions
                                                           │    Authorization: Bearer <上游 Key>
                                                           └─ anthropic-messages：Responses ⇄ Messages 转换 ─────────► <上游>/v1/messages
                                                                x-api-key: <上游 Key>
```

## 1. 接口

```ts
import { startModelGateway, validateProvider, testProvider } from '@wevir/model-gateway';

const gateway = await startModelGateway({ logger });   // logger：info / warn，与 Host 的 Logger 兼容；可省略
gateway.setProviders(providers);                         // GatewayProvider[]（= ProviderConfig，含 Key）
gateway.baseURL('kimi');                                 // 'http://127.0.0.1:<port>/v1/p/kimi'，写进 Codex 的 base_url
gateway.token;                                           // Codex 的 env_key 的值
await gateway.testProvider(provider, modelId);           // ProviderTestResult（§7）
await gateway.close();                                   // 停止监听，中断所有进行中的上游请求
```

| 成员 | 说明 |
|---|---|
| `startModelGateway(options)` | 监听 `127.0.0.1` 的随机端口。`options.logger`（§8）；`options.deepseekBaseURL`：`deepseek-official` 的 Responses 地址，默认 `https://api.deepseek.com`，测试指向本地 mock；`options.testTimeoutMs`：testProvider 的时限，默认 20 s |
| `token` | 每个网关实例 `randomBytes(32)` 生成（base64url，43 个字符），只在内存里。比较两边的 SHA-256 用 `timingSafeEqual`（常量时间） |
| `baseURL(providerId)` | Codex 的 `base_url`；Codex 自己在后面加 `/responses`。ID 经 `encodeURIComponent` |
| `setProviders(providers)` | 换上整套 Provider（深拷贝，之后改传入的对象不影响网关）。每个请求在开始时取一次配置，所以之后的请求按新配置走，进行中的请求不受影响 |
| `testProvider(provider, modelId)` | provider.test（ADR-0005 决策 2.5），§7 |
| `close()` | 中断进行中的上游请求、断开所有连接、停止监听；可重复调用 |
| `validateProvider(provider)`（独立导出） | 网关处理不了的配置，返回 `ProviderIssue[]`：`openai-compatible` 缺 `api` / `baseURL` 或协议不认识、`baseURL` 带凭据或查询参数、§4.4 两个开关的取值、`anthropic-messages` 的 `thinkingFormat`（§5.4）。与 dsh 的检查（`adapter-dsh` 的 `validateProviderConfig`）无关，adapter-codex 用它；adapter-dsh 仍拒绝 `anthropic-messages`（dsh 不支持） |

`GatewayProvider` 就是 `@wevir/runtime-adapter` 的 `ProviderConfig`，只是 `compat` 可以多两个网关自己的开关（§4.4）。Host 协议与 `ProviderCompatConfig` 还没有这两个字段（ADR-0005 补记 3）。

## 2. 路由与处理方式

只有一个路由：`POST /v1/p/<providerId>/responses`（忽略查询串）。检查顺序与网关自己的回应：

| 情况 | 状态码 | 正文（`{"error":{"message":"wevir gateway: …"}}`） | 是否碰上游 |
|---|---|---|---|
| 令牌缺失或不对（不论路径） | 401 | `令牌不对`，`code: invalid_api_key` | 否 |
| 路径不是上面的形状 | 404 | `不支持 <方法> 这个路径` | 否 |
| 方法不是 POST | 405 | | 否 |
| 没有这个 Provider | 404 | `没有 Provider <id>`，`code: model_not_found` | 否 |
| Provider 没存 Key | 401 | `Provider <id> 没有 API Key` | 否 |
| 请求体超过 64 MiB | 413 | | 否 |
| `content-encoding` 不是 identity / gzip / deflate / br / zstd | 415 | Codex 只在 OpenAI 官方 + ChatGPT 登录时用 zstd 压缩请求体（`core/src/client.rs:1634-1642`），经网关的请求不压缩；解压留着以防万一 | 否 |
| 不是 JSON，或缺 `model` / `input` | 400 | | 否 |
| `validateProvider` 不通过的配置（不认识的协议等） | 400 | `api：不认识的协议 <api>` 等 | 否 |
| 连不上上游（DNS、拒绝连接、TLS） | 502 | `连不上上游：<原因>`；5xx 让 Codex 按自己的策略重试 | 是 |

处理方式按 Provider 选（`routeOf`）：

| Provider | 处理方式 | 上游地址 |
|---|---|---|
| `kind: deepseek-official` | Responses 透传（§3） | `https://api.deepseek.com/responses`（DeepSeek 的 Codex 接入文档）。Provider 的 `baseURL` **不用**：那是 dsh 的 Anthropic Messages 地址（providers.md §2.2），协议不同 |
| `openai-compatible` + `api: openai-responses` | Responses 透传（§3） | `<baseURL>/responses`（末尾斜线去掉） |
| `openai-compatible` + `api: openai-completions` | Chat 转换（§4） | `<baseURL>/chat/completions` |
| `openai-compatible` + `api: anthropic-messages` | Messages 转换（§5） | `<baseURL>/v1/messages`；`baseURL` 已以 `/v1` 结尾时只加 `/messages`（与 adapter-dsh 对 DeepSeek 的 Messages 地址同一拼法）。例：`https://api.deepseek.com/anthropic` → `…/anthropic/v1/messages` |

发给上游的请求头只有网关自己的：`content-type: application/json`、`accept: text/event-stream`、`user-agent: wevir-gateway/<包版本>`，加上认证：Responses 与 Chat 是 `authorization: Bearer <上游 Key>`，Messages 是 `x-api-key: <上游 Key>` 与 `anthropic-version: 2023-06-01`（Anthropic 官方与 DeepSeek 等兼容服务都认 `x-api-key`，不发 `authorization`）。另有 fetch 与 HTTP 本身的 `host`、`content-length`、`connection`、`accept-encoding`、`accept-language`、`sec-fetch-mode`。不跟随重定向。

## 3. Responses 透传

### 3.1 剥离的字段

- **请求体**：去掉 `client_metadata`（含 `x-codex-installation-id`、thread / turn ID、`x-codex-turn-metadata` 整段 JSON，codex-notes §3.1）。其余字段原样，包括 `prompt_cache_key`（值是 thread ID，上游用它做提示词缓存）、`include`、`store: false`、`reasoning`。
- **请求头**：Codex 的请求头一个都不转发，因为上游请求头由网关重新组装（§2）。录制样本里 Codex 发的是 `originator`、`user-agent`、`session-id`、`thread-id`、`x-client-request-id`、`x-codex-window-id`、`x-codex-turn-metadata`、`x-codex-beta-features`，子 agent 另有 `x-openai-subagent`、`x-codex-parent-thread-id`；`authorization` 里的网关令牌换成上游 Key。
- **响应**：状态码与正文原样转回；没有响应方向的方言修正时连字节都不动（`content-type` 用上游的），有时逐条解析 SSE、改写后重新编码（`text/event-stream`）。Codex 读到 `response.completed` 就断开（§6），这时上游的剩余字节不再转发。

### 3.2 方言修正

`dialects.ts` 的 `RESPONSES_DIALECTS` 是一个有序清单，每条声明对哪些 Provider 生效（`applies`），改请求体，必要时返回响应事件的改写函数。新的修正加在清单里，并在下表登记。

| ID | 对谁生效 | 请求 | 响应 | 依据 |
|---|---|---|---|---|
| `drop-tool-choice-without-tools` | 所有 Provider | `tools` 是空数组或没有时去掉 `tool_choice` | — | Codex 的压缩请求发 `tools: []` + `tool_choice: "auto"`（样本 `4-compact`），xAI 报 400（codex-notes §3.4）。没有工具时 `tool_choice` 本来就没有意义，所以不设开关 |
| `flatten-custom-tools` | `compat.supportsCustomTools === false` | `custom` 工具（apply_patch）→ `{type: function, name, description: 原描述 + 语法全文, parameters: {input: string}, strict: false}`，namespace 里的同样处理、namespace 本身不动；`tool_choice: {type: custom}` → `function`；历史里的 `custom_tool_call` → `function_call`（`arguments: {"input": …}`，不带 `id`：上游可能按前缀校验），`custom_tool_call_output` → `function_call_output` | `output_item.added` / `.done` 与 `response.completed.response.output` 里同名（同命名空间）的 `function_call` → `custom_tool_call`（`input` 从参数里取，取不到时原样当输入）；其余事件不动。`function_call_arguments.*` 增量 Codex 本来就忽略 | 不支持自定义工具的 Responses 实现（xAI 大概率如此，R8 核实）。规则与 Chat 转换的摊平相同（§4.3） |

还没做、留给以后按服务加的：MiniMax 的 `effort: none` 报 400；各家思考开关与 `reasoning.effort` 取值不同（codex-notes §5.3）；DeepSeek 的 namespace 工具已实测支持（§7.3），不用摊平。

## 4. Chat Completions 转换

### 4.1 请求：Responses → Chat

| Responses（Codex 发的） | Chat（发给上游的） |
|---|---|
| `model` | `model`（原样） |
| `input` 是字符串 | 一条 user 消息 |
| `instructions`（Codex 不发） | 开头的 system |
| `message` role `developer` / `system` | system，原位（对话中间也有：权限变化等，样本 `3-next-turn`）；`compat.systemMessageMode` 可改，§4.4；`compat.supportsDeveloperRole: true` 时 developer 保持 developer 角色 |
| `message` role `user`：`input_text` | user，纯文本时拼成字符串 |
| `message` role `user`：`input_image`（`image_url` 是 data URL 或网址） | 有图时 content 用 parts：`{type: image_url, image_url: {url, detail?}}`，`detail` 只保留 low / high / auto；`file_id` 引用的图片没法转，丢掉 |
| `message` role `assistant`（`output_text`） | assistant.content（同一段里的相邻项拼接） |
| `reasoning`：先取 `content` 的文本，没有时解网关自己写的 `encrypted_content`（前缀 `wevir-gw:v1:` + base64） | 挂到下一条 assistant 的 `reasoning_content`（DeepSeek 等要求带回）。推理之后没有任何 assistant 输出就换了说话人（回合被中断）：丢掉，不挂到下一回合的 assistant |
| `function_call` / `custom_tool_call` | assistant.tool_calls（同一段里相邻的合并成一条 assistant），`id` = `call_id`，函数名见 §4.3；custom 的参数是 `{"input": <原输入>}` |
| `function_call_output` / `custom_tool_call_output` | tool 消息（`tool_call_id` = `call_id`）。输出是部件数组时文本用换行拼接；图片（`view_image`）Chat 的 tool 消息放不了，**在这一批 tool 消息之后**补一条 user 消息：`[Images returned by the preceding tool call]` + 图片 parts，tool 消息只有图时内容就是这句说明 |
| 工具 `function` | `{type: function, function: {name, description, parameters}}`（`strict` 不发：有的上游不认） |
| 工具 `custom`（apply_patch，Lark 语法） | 只有一个字符串参数 `input` 的函数，描述 = 原描述 + `Put the raw tool input in the input string. It must match this lark grammar:` + 语法全文 |
| 工具 `namespace`（multi_agent_v1） | 里面的工具摊平成 `<ns>__<name>` 的函数 |
| 托管工具（web_search、image_generation 等） | 丢掉 |
| `tools` 为空或全被丢掉 | 不发 `tools` 与 `tool_choice` |
| `tool_choice`：`auto` / `none` / `required` / `{type: function \| custom, name}` | 同名；对象形式换成 `{type: function, function: {name: 摊平后的名字}}`；其他值按 `auto` |
| `reasoning.effort` | `reasoning_effort`（`none` 不发）。`reasoning.summary` 丢掉。各家的思考开关（`compat.thinkingFormat`）本任务不处理 |
| `max_output_tokens`（Codex 不发，testProvider 发） | `compat.maxTokensField`；没设时 OpenAI 官方地址用 `max_completion_tokens`，其他用 `max_tokens`（与 providers.md §2.3 同一判断） |
| `temperature`、`top_p` | 原样 |
| `text.format` 是 `json_schema` | `response_format: {type: json_schema, json_schema: {name, schema, strict}}` |
| `store`、`include`、`prompt_cache_key`、`client_metadata`、`service_tier`、`parallel_tool_calls`、`stream_options`、`truncation`、`previous_response_id`、`metadata`、`user` | 丢掉 |
| 其他输入项（`web_search_call`、`local_shell_call`、`compaction`、`tool_search_*` 等） | 丢掉 |
| — | 总是 `stream: true`、`stream_options: {include_usage: true}` |
| — | `compat.requiresReasoningContentOnAssistantMessages`（没设时按地址：`deepseek.com` 及其子域为 true）：没有推理的 assistant 消息补 `reasoning_content: ""` |

丢掉的东西记在 `toChatRequest(...).dropped`（`field:<字段>`、`tool:<类型>`、`<输入项类型>`、`input_image:file_id`、`reasoning:orphan`），只给测试与排查，不进日志。

### 4.2 流式响应：Chat → Responses 事件

事件形状以 Codex 的解析为准（`codex-api/src/sse/responses.rs`）：历史与工具调用只取 `response.output_item.done`；增量之前要有同一 `item_id` 的 `output_item.added`；`response.completed` 要有字符串 `response.id`，`usage` 有就要有三个 token 数；每条 SSE 带 `event:` 行（Codex 只看 data）。

| Chat（上游） | Responses（发给 Codex） |
|---|---|
| 收到 2xx | `response.created {response: {id: resp_wevir_<随机>, status: in_progress}}` |
| `delta.reasoning_content`（DeepSeek、Kimi、通义）或 `delta.reasoning`（OpenRouter 等） | 第一片：`output_item.added {type: reasoning, id, summary: []}`；每片：`response.reasoning_text.delta {item_id, output_index, content_index: 0, delta}`；结束：`output_item.done {type: reasoning, summary: [], content: [{type: reasoning_text, text: 全文}], encrypted_content: wevir-gw:v1:<base64 全文>}`（Codex 带回时 content 与 encrypted_content 都可能只剩一个，两处都放全文） |
| `delta.content` | 推理项先提交；`output_item.added {type: message, role: assistant, content: []}` → `response.output_text.delta` → `output_item.done {content: [{type: output_text, text}]}` |
| `delta.tool_calls[]` | 文本与推理先提交，分片按调用累积：按 `index` 归属（并行调用的分片可以交错）；带 `id` 的先按 `id` 找，同一个 `index` 来了另一个 `id` 时另开一个调用（有的上游每个调用都用 index 0）；既没有 `index` 也没有 `id` 的接到上一个调用；名字只在第一片或每片重复都行。流结束时**按 index 的顺序**提交：按 §4.3 的登记还原成 `custom_tool_call {call_id, name, namespace?, input}`（从 `{"input"}` 里取，取不到时原样）或 `function_call {call_id, name, namespace?, arguments}`；模型编的名字原样交给 Codex，由 Codex 报未知工具。上游没给 `id` 时网关补 `call_<随机>` |
| `finish_reason: stop` / `tool_calls` / 其他，或只有 `[DONE]` | 提交还开着的项与工具调用，然后 `response.completed {response: {id, status: completed, output: [全部已提交的项], usage?}}` |
| `finish_reason: length` | 已出的文本与推理照常提交，**截断的工具调用不提交**（参数多半不完整），然后 `response.incomplete {response: {incomplete_details: {reason: max_output_tokens}}}` |
| `finish_reason: content_filter` | 同上，`reason: content_filter` |
| `usage`（最后一个 chunk，`choices: []`） | `input_tokens` = `prompt_tokens`；`input_tokens_details.cached_tokens` = `prompt_tokens_details.cached_tokens`，没有时取 DeepSeek 的 `prompt_cache_hit_tokens`；`output_tokens` = `completion_tokens`；`output_tokens_details.reasoning_tokens` = `completion_tokens_details.reasoning_tokens`；`total_tokens`，没有时相加。上游没给 usage 时不带 `usage`（不填 0，免得上下文用量失真） |
| 流里的 `{"error": {...}}` 或 `{"error": "…"}` | `response.failed {response: {status: failed, error: {code: 上游的 code / type，没有时 upstream_error, message: 上游原文}}}`；开着的项不再提交，之后的 chunk 忽略 |
| 读流时连接被重置等异常 | `response.failed`，`code: upstream_stream_error`，`message: 上游的流中断：<原因>`（带 undici 的底层原因） |
| 流正常结束，但既没有 `finish_reason` 也没有 `[DONE]` | `response.failed`，`message: 上游的流在结束前断开…` |
| 不是 JSON 的 `data:` | `response.failed`，带原文前 300 字符 |
| 上游无视 `stream` 回了整个 `chat.completion`（`content-type` 是 JSON） | 按一个 chunk 处理（`choices[0].message` 当 delta），再按 `finish_reason` 收尾 |

Codex 怎样对待这些终结事件（`responses.rs:413-465`、`responses_error.rs`）：`response.incomplete` 的 `max_output_tokens` 是流错误（Codex 会按流重试的次数重试），`content_filter` 是 `ContentFilter` 错误；`response.failed` 按 `error.code` 归类，`context_length_exceeded`、`insufficient_quota` 等有专门处理，其余按可重试处理。

### 4.3 工具名

Chat 的函数名要符合 `^[A-Za-z0-9_-]{1,64}$`（OpenAI 的规则，多数兼容服务沿用），也没有命名空间。每个请求有一份 `ToolNames` 登记，工具定义、历史里的调用、响应里的调用用同一份：

- 合法就用原名，或 namespace 里的 `<ns>__<name>`（`multi_agent_v1__spawn_agent`）。
- 超过 64 个字符或含非法字符（MCP 的服务名常带 `.`、`:`）：非法字符换成 `_`，截到 55 个字符，再接 `_` 与原名的 SHA-256 前 8 位。**确定性的**：同一个原名每次都得到同一个结果，所以历史里的调用与本次的工具定义对得上，跨请求也不变。
- 撞名（例如函数 `a__b` 与 namespace `a` 里的 `b`）：后登记的那个改用以命名空间与名字为种子的哈希名。
- 响应里按登记还原工具类型（function / custom）、原名与命名空间。

### 4.4 网关的 compat 开关

`ProviderConfig.compat` 里网关读的开关。前四个是已有的（providers.md §2.3），后两个是网关新加的（ADR-0005 补记 3），取值由 `validateProvider` 检查。

| 开关 | 用于 | 含义 | 默认 |
|---|---|---|---|
| `supportsCustomTools` | Responses 透传 | `false`：上游不支持 `custom` 工具，打开 §3.2 的 `flatten-custom-tools` | `true` |
| `systemMessageMode` | Chat 转换 | 对话中间的 developer / system 消息：`inline` 原位转 system；`merge` 全部并进开头的一条 system（用空行分隔，保持顺序；代价是开头的内容一变，上游的提示词缓存就失效）；`user` 开头连续的并成一条 system，之后的转成 user 消息，开头一行注明 `[Developer instruction from the application, not written by the user]`。给只接受开头一条 system 的上游用 | `inline` |
| `supportsDeveloperRole` | Chat 转换 | `true` 且 `inline` 时 developer 消息保持 developer 角色 | system |
| `maxTokensField` | Chat 转换 | `max_output_tokens` 写成哪个字段 | 见 §4.1 |
| `requiresReasoningContentOnAssistantMessages` | Chat 转换 | 每条 assistant 都带 `reasoning_content` | `deepseek.com` 为 true |
| `thinkingFormat` | Messages 转换 | 只在 `anthropic-messages` 上读：`adaptive` / `enabled`（§5.4）。Chat 转换不读（各家思考开关的写法，以后按服务加） | 见 §5.4 |

## 5. Anthropic Messages 转换

`api: anthropic-messages` 的 Provider（ADR-0005 决策 2.3）。请求与流的形状以 Anthropic Messages API 的当前文档为准（流式事件、工具使用、思考与签名、错误）；做法参考 LiteLLM 的 Responses → Anthropic 转换（思考块签名放进 `encrypted_content` 带回，codex-notes §3.5），代码是自己写的。工具摊平与 Chat 转换是同一套规则（§4.3）。DeepSeek 的 Anthropic 端点（`https://api.deepseek.com/anthropic`）是真实模型测试的上游之一（§9）。

### 5.1 请求：Responses → Messages

| Responses（Codex 发的） | Messages（发给上游的） |
|---|---|
| `model` | `model`（原样） |
| `input` 是字符串 | 一条 user 消息 |
| `instructions`（Codex 不发） | 顶层 `system` 的第一段 |
| 开头连续的 `message` role `developer` / `system`（基础提示词、skills） | 顶层 `system`：每条一个 text 块，最后一块带 `cache_control`（§5.5） |
| 对话中间的 `developer` / `system`（权限变化等，样本 `3-next-turn`） | 默认转成 user 的 text 块，开头一行 `[Developer instruction from the application, not written by the user]`（与 Chat 的 `user` 模式同一句）。只追加，不改顶层 `system`：提示词缓存不失效，Anthropic 对思考块的前缀校验（preserved thinking：`system`、`tools` 或之前的消息一变，之后的思考块就失效）也不受影响。`compat.systemMessageMode: merge` 时并进顶层 `system`（代价就是上面两条）；`inline` 没有对应（Messages 的 `role: system` 消息只有最新的 Claude 支持，而且后面必须紧跟 assistant），按 `user` 处理 |
| `message` role `user`：`input_text` | user 的 text 块；空文本不发（Anthropic 拒收空 text 块） |
| `message` role `user`：`input_image` | image 块：base64 的 data URL → `source: {type: base64, media_type, data}`；http(s) 网址 → `source: {type: url, url}`；`detail` 丢掉；`file_id` 与非 base64 的 data URL 没法转，丢掉 |
| `message` role `assistant`（`output_text`） | assistant 的 text 块 |
| `reasoning` | 思考块，挂在下一段 assistant 内容的前面；只认网关自己写的 `encrypted_content`，而且必须是同一个 Provider 与模型产生的、带签名的（§5.3）。缺签名就不发。推理之后没有任何 assistant 输出就换了说话人（回合被中断）：丢掉 |
| `function_call` | assistant 的 `tool_use {id: call_id, name: 摊平后的名字, input: 参数解析成的对象}`；参数不是 JSON 对象时用 `{}`（与 dsh 相同） |
| `custom_tool_call`（apply_patch） | `tool_use`，`input: {input: <原输入>}` |
| `function_call_output` / `custom_tool_call_output` | user 的 `tool_result {tool_use_id: call_id, content}`：字符串原样，空串不带 `content`；部件数组里的文本与图片都放进 `content`（Messages 的 tool_result 收图片，不用像 Chat 那样另补 user 消息） |
| `call_id` 不合 Anthropic 的规则 `^[A-Za-z0-9_-]+$`（来自别的上游，例如 `functions.x:0`） | 换成 `toolu_wevir_<SHA-256 前 24 位>`；确定性的，`tool_use` 与 `tool_result` 对得上 |
| 相邻的同角色消息 | 合并成一条（不是每家兼容服务都自己合并）；同一条 user 消息里 `tool_result` 排在最前面（Anthropic 的规则） |
| 工具 `function` | `{name, description, input_schema: parameters}`（没有 `parameters` 时 `{type: object, properties: {}}`；`strict` 不发） |
| 工具 `custom` | 只有一个字符串参数 `input` 的工具，描述 = 原描述 + 语法全文（与 Chat 相同） |
| 工具 `namespace` | 摊平成 `<ns>__<name>`（与 Chat 相同，名字规则同 §4.3，64 个字符以内也满足 Anthropic 的限制） |
| 托管工具 | 丢掉 |
| `tools` 为空、但历史里有工具调用（压缩请求，样本 `4-compact`） | Anthropic 要求历史里有 `tool_use` / `tool_result` 的请求必须定义工具：按历史里用过的名字补占位工具（`input_schema: {type: object, properties: {}}`，描述写明本次不可用），`tool_choice: {type: none}` |
| `tool_choice`：`auto` / `none` / `required` / `{type: function \| custom, name}` | `auto` 是默认，不发；`none` → `{type: none}`；`required` → `{type: any}`；指定工具 → `{type: tool, name: 摊平后的名字}`。注意最新的 Claude（Opus 5.5、Sonnet 5.5、Fable 5.1）拒收 `any` / `tool`，Codex 只发 `auto` |
| `parallel_tool_calls: false` | `tool_choice` 带 `disable_parallel_tool_use: true`；`true`（Codex 的默认）不发 |
| `max_output_tokens`（Codex 不发，testProvider 发） | `max_tokens`（Messages 必填）；没有时取 Provider 里这个模型的 `models[].maxTokens`，再没有用 32000（§5.4） |
| `reasoning.effort` / `reasoning.summary` | `thinking` 与 `output_config.effort`（§5.4） |
| `temperature`、`top_p` | 原样（Codex 不发；较新的 Claude 拒收非默认值） |
| `text.format` 是 `json_schema` | `output_config.format: {type: json_schema, schema}` |
| `store`、`include`、`prompt_cache_key`、`client_metadata`、`service_tier`、`parallel_tool_calls`、`stream_options`、`truncation`、`previous_response_id`、`metadata`、`user` | 丢掉 |
| 其他输入项（`web_search_call`、`compaction` 等） | 丢掉 |
| — | 总是 `stream: true`；最后一条消息的最后一块带 `cache_control`（§5.5） |

丢掉的东西记在 `toMessagesRequest(...).dropped`（同 §4.1，另有 `reasoning:unsigned`、`reasoning:other_model`、`arguments:not_object`、`input_image:unsupported_url`），只给测试与排查。

### 5.2 流式响应：Messages → Responses 事件

Messages 的流：`message_start` → 每个内容块 `content_block_start` / `content_block_delta` / `content_block_stop` → `message_delta`（`stop_reason`、累计的 `usage`）→ `message_stop`，中间可能有 `ping` 与 `error`。只看 `data:` 里的 `type`（事件名与它相同）。

| Messages（上游） | Responses（发给 Codex） |
|---|---|
| 收到 2xx | `response.created {response: {id: resp_wevir_<随机>, status: in_progress}}` |
| `message_start` | 记下 `message.usage` |
| `content_block_start` `thinking` | `output_item.added {type: reasoning, id, summary: []}` |
| `content_block_delta` `thinking_delta` | `response.reasoning_text.delta`（空串不发：`display: omitted` 时只有一个空的 `thinking_delta`） |
| `content_block_delta` `signature_delta` | 累积签名 |
| `content_block_stop`（thinking） | `output_item.done {type: reasoning, summary: [], content: [{type: reasoning_text, text: 全文}]（全文为空时没有 content）, encrypted_content: 思考信封（§5.3）}` |
| `redacted_thinking` 块 | 块结束时 `output_item.done {type: reasoning, summary: [], encrypted_content: 信封（data）}`，没有可显示的文本 |
| `text` 块的 `text_delta` | 第一片：`output_item.added {type: message, role: assistant}`；每片：`response.output_text.delta`。相邻的 text 块（带引用时会被拆开）并进同一个 message 项；别的块开始时提交：`output_item.done {content: [{type: output_text, text}]}` |
| `citations_delta` 等 | 忽略 |
| `tool_use` 块 + `input_json_delta` | 参数按块拼接（一片都没有时取 `content_block_start` 里的 `input`）；流结束时按块的顺序提交，按 §4.3 的登记还原成 `custom_tool_call {call_id, name, namespace?, input}` 或 `function_call {call_id, name, namespace?, arguments}`；`call_id` 就是 Anthropic 的 `tool_use.id`，没有时补 `call_<随机>` |
| `server_tool_use` 等别的块 | 忽略（网关不声明服务端工具，正常不会出现） |
| `message_delta` | 记下 `stop_reason`；`usage` 是累计值，按字段覆盖 `message_start` 的 |
| `ping`、不认识的事件 | 忽略（Anthropic 的版本策略要求客户端容忍新事件） |
| `stop_reason`：`end_turn` / `tool_use` / `stop_sequence` / `pause_turn` | 提交工具调用，`response.completed {response: {id, status: completed, output, usage?}}`。`pause_turn` 只在服务端工具时出现，按完成处理 |
| `stop_reason: max_tokens` | 已出的文本与思考照常提交，截断的工具调用不提交，`response.incomplete {incomplete_details: {reason: max_output_tokens}}`（Codex 按流错误重试，§4.2） |
| `stop_reason: refusal` | 同上，`reason: content_filter`（Codex 的 `ContentFilter`） |
| `stop_reason: model_context_window_exceeded` | `response.failed`，`code: context_length_exceeded`（Codex 的 `ContextWindowExceeded`，不重试） |
| `usage` | `input_tokens` = `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens`（Anthropic 的 `input_tokens` 不含缓存，Codex 的是全部输入，它用 `input_tokens - cached_tokens` 算未命中的部分）；`input_tokens_details.cached_tokens` = `cache_read_input_tokens`；`input_tokens_details.cache_write_tokens` = `cache_creation_input_tokens`（Codex 的 `TokenUsage.cache_write_input_tokens`）；`output_tokens` 原样；`output_tokens_details.reasoning_tokens` = `output_tokens_details.thinking_tokens`（没有时 0）；`total_tokens` = 输入 + 输出。上游一直没给 usage 时不带 `usage` |
| 流里的 `{"type": "error", "error": {"type", "message"}}`（如 `overloaded_error`） | `response.failed`，`code` = Anthropic 的错误类型，`message` = 原文；开着的项不再提交，之后的事件忽略。Codex 对不认识的 code 按可重试处理（`Retryable`，指数退避） |
| 读流时连接被重置等异常 | `response.failed`，`code: upstream_stream_error`（同 Chat） |
| 流结束时既没有 `message_stop` 也没有 `stop_reason` | `response.failed`，`message: 上游的流在结束前断开…`；有 `stop_reason` 没有 `message_stop` 按正常结束 |
| 不是 JSON 的 `data:` | `response.failed`，带原文前 300 字符 |
| 有 JSON 但没有 `type`（别的协议的流，多半是协议选错了） | `response.failed`，`code: upstream_protocol_error`；testProvider 把它归为 `protocol`（§7） |
| 上游无视 `stream` 回了整个 Message（`content-type` 是 JSON） | 拆成与流相同的事件处理；回的是错误对象时 `response.failed` |

### 5.3 思考块的带回

Anthropic 要求同一个工具回合里的思考块“完整、未经修改”地带回（`thinking` 与 `signature` 一字不差，`redacted_thinking` 的 `data` 原样），否则 400；跨回合推荐也带回。Codex 只会把 reasoning 项原样放回 `input`（同一回合的工具调用之后与下一回合都会，codex-notes §3.2），所以网关把思考块整个存进 reasoning 项的 `encrypted_content`：

```text
wevir-gw:anthropic:v1:<base64(JSON)>
JSON = {provider: <Provider ID>, model: <请求的模型>, type: "thinking", thinking: <原文>, signature?: <签名>}
     | {provider, model, type: "redacted_thinking", data: <原样>}
```

- 原文也放进信封，因为 Codex 带回时 `content` 可能缺失（§4.2）；还原时以信封里的原文为准，保证一字不差。
- 记下 Provider 与模型：签名只对产生它的模型有效（Anthropic 对读不了的块默认静默丢弃，兼容服务的行为没有文档）。请求时只带回同一个 Provider ID、同一个模型名的思考块，其余记为 `reasoning:other_model` 不发；这与 dsh 对 DeepSeek 的做法相同（换了模型就不带签名）。
- **缺签名时不发思考块**（`reasoning:unsigned`）：来自 Chat 转换（`wevir-gw:v1:` 信封）或 Responses 上游（不认识的 `encrypted_content`）的推理，以及上游本身就没给签名的思考。影响：
  - 换 Provider、换模型或换协议后，之前的推理不再给模型看，模型只看到当时的文本与工具调用（Anthropic 自己换模型时也是丢弃）。
  - 不给签名的兼容服务，网关永远带不回它的思考。它若要求工具回合里带回思考（DeepSeek 的 Chat 接口就要求 `reasoning_content`），会在工具结果之后的请求里报错；这时应改用该服务的 Chat 或 Responses 接口。DeepSeek 的 Anthropic 端点给不给签名，由真实模型测试打印的“带签名”数量确认（§9）。
  - `thinkingFormat: enabled`（手动思考）时 Anthropic 要求思考开着的请求里最后一段 assistant 以思考块开头；同一个工具回合中途丢了思考块时，Anthropic 文档写明 API 不报错，只是这一次请求静默关掉思考。
- 带回的思考块不加 `cache_control`（Anthropic 不允许）。

### 5.4 思考开关与 `max_tokens`

各家的思考开关写法不同（Anthropic 4.6 起是 `adaptive`，4.7 起拒收 `enabled`；更早的 Claude 只认 `enabled` + `budget_tokens`；DeepSeek 认 `enabled` / `disabled`、忽略 `budget_tokens`，档位放在 `output_config.effort`，见 dsh 的 llm-deepseek）。网关按 Codex 发的 `reasoning` 与 Provider 的 `compat.thinkingFormat`（协议里已有的字段，Chat 不读它；`anthropic-messages` 上只接受下面两个值，`validateProvider` 检查）：

| `reasoning.effort` | 发给上游的 |
|---|---|
| 没有 | 不发 `thinking` 与 `output_config`（上游默认） |
| `none` | `thinking: {type: disabled}`（Opus 5.5 等拒收 `disabled`，这类模型的目录不该提供 `none`） |
| 其他 | `output_config: {effort}`（`minimal` 写成 `low`，其余原样，Anthropic 认 `low` / `medium` / `high` / `xhigh` / `max`），加上按 `thinkingFormat`：`adaptive` → `thinking: {type: adaptive}`，`reasoning.summary` 不是 `none` 时加 `display: summarized`（4.7 起默认 `omitted`，思考文本是空的）；`enabled` → `thinking: {type: enabled, budget_tokens}`，`budget_tokens` 按档位取 `minimal` 1024、`low` 4000、`medium` 10000、`high` 16000、`xhigh` / `max` 31999，不超过 `max_tokens - 1`；`max_tokens` 不到 1025 时不开思考（Anthropic 要求 `budget_tokens` ≥ 1024 且小于 `max_tokens`） |

`thinkingFormat` 没设时：模型 ID 以 `claude-` 开头用 `adaptive`，其余用 `enabled`（兼容服务多是照 Claude Code 对非 Claude 模型名的发法做的，DeepSeek 实际就是 dsh 发的 `enabled`）。Claude 4.5 及更早的模型要设 `thinkingFormat: enabled`；它们中的 Sonnet 4.5、Haiku 4.5 不认 `output_config.effort`，目前没有开关去掉它（§10）。

`max_tokens` 是 Messages 的必填项（思考 token 也算在里面）：Codex 不发 `max_output_tokens`，所以取 Provider 里这个模型的 `models[].maxTokens`（Provider 配置就是网关能看到的模型目录），没写时用 32000（Claude Code 的默认输出上限；当前的 Claude 都是 64K 以上）。上游的上限更低时要在 `models[].maxTokens` 里写明，否则上游回 400。

### 5.5 提示词缓存

Anthropic 官方只缓存显式标注的前缀。网关放两个断点：顶层 `system` 的最后一块（`tools` 在 `system` 之前，一起缓存），与最后一条消息的最后一块（整段历史；下一个请求在 20 个块的回看范围内找到上一次的断点）。DeepSeek 的文档写明忽略 `cache_control`。缓存读写的 token 按 §5.2 映射给 Codex。

## 6. 错误与取消

- **上游非 2xx**：状态码原样转给 Codex（429、5xx 由 Codex 自己的重试策略处理：5xx 与传输错误重试，429 不重试，codex-notes §3.1；Anthropic 过载的 529 也是 5xx），正文整理成 `{"error": {"message", "type"?, "code"?}}`：认 OpenAI 风格 `{error: {message, type, code}}`、`{error: "…"}`、Anthropic 风格 `{type: "error", error: {type, message}}`、`{message}`、`{detail}`，都不是时用原文，空正文写 `上游返回 HTTP <状态码>`；原文最多 4000 字符，**原文里出现的上游 Key 换成 `***`**（有的服务回显 Key）。保留 `type` / `code`，因为 Codex 靠它们认出额度用完、上下文超长等（`codex-api/src/api_bridge.rs`）。三种处理方式相同。
- **Responses 上游流里的 `response.failed`**：原样转回。Chat、Messages 流里的错误见 §4.2、§5.2。
- **Codex 断开**（读到 `response.completed` 就断开，`responses.rs:631-637`；取消回合时也断开）：网关中断上游请求，按正常结束处理，日志记 `client_closed`。Spike 与集成测试都核对了 mock 上游看到连接被中断（三种处理方式）。
- **网关关闭**（`close()`）：中断所有进行中的上游请求。
- 进行中的请求在 `setProviders` 之后仍用开始时的配置（§1）。

## 7. testProvider

用与正式请求相同的处理方式（`prepareUpstream`：透传加方言修正，或 Chat / Messages 转换）发一次最小的流式请求：

```json
{"model": "<modelId>", "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "ping"}]}],
 "stream": true, "store": false, "max_output_tokens": 16}
```

Chat 上游收到的是 `{model, messages: [{role: user, content: ping}], stream: true, stream_options: {include_usage: true}, max_tokens: 16}`（字段名按 compat）；Messages 上游收到的是 `{model, max_tokens: 16, messages: [{role: user, content: [{type: text, text: ping, cache_control}]}], stream: true}`，不开思考（没有 `reasoning`）。读处理后的 Responses 事件，跳过 `response.created` / `response.in_progress`（Chat 转换时它是网关自己发的；透传时上游也是先发它，之后才可能是 `response.failed`），第一条别的 `response.*` 事件就算成功，`latencyMs` 是从发出请求到这一刻；然后断开，不让模型继续生成。时限 20 s，不跟随重定向。

失败归类与 adapter-dsh 的口径相同（providers.md §6.2，代码是复制的：网关不能依赖 adapter-dsh）：没有 Key → `missing_key`（不发请求）；配置不完整 → `unknown`；401 / 403 → `auth`；429 → `rate_limited`；5xx → `server`；原文提到模型不存在 → `model_not_found`；其余 404 / 405、400 / 422 → `protocol`；连不上 → `network`；超时 → `timeout`；200 但是网页、或不是 Responses 事件、或 Messages 转换发现流不是 Messages 格式（`upstream_protocol_error`）→ `protocol`；200 但第一条是 `response.failed` / `error` 事件（Chat 转换时就是上游流里的错误）→ 按原文归为 `model_not_found` / `auth` / `unknown`。消息里的 Key 换成 `***`。

与 adapter-dsh 的差别：`deepseek-official` 走 DeepSeek 的 Responses 端点，而不是 dsh 用的 Anthropic Messages；`openai-responses` 的探测请求是 message 项的数组，不是字符串；adapter-dsh 不支持 `anthropic-messages`，网关支持（`max_tokens: 16`，dsh 对 DeepSeek 的 Messages 探测是 `max_tokens: 1` 加 `thinking: disabled`）。

## 8. 日志口径

每个到达路由的请求结束时一行 `info`（`msg: "gateway request"`），字段**只有**：`method`、`providerId`、`outcome`、`durationMs`，另按情况有 `upstreamStatus`（上游的状态码）、`status`（网关自己回的状态码）、`error`（连不上上游时的错误码，如 `ECONNREFUSED`，不记带地址的原文）。`outcome` 取值：`completed`、`client_closed`（Codex 断开或网关关闭，正常）、`upstream_error`（上游非 2xx）、`network_error`、`rejected`（§2 里网关自己回的 4xx）。令牌不对是一行 `warn`（`gateway request rejected`，`method` 与 `status: 401`）。网关内部异常是 `warn`（`gateway internal error`）。

不记请求体、响应体、上游错误原文、任何 Key 与令牌（集成测试核对：日志里没有 Key、令牌、模型的推理与回答、思考块的签名、请求里的文本）。三种处理方式同一口径。

## 9. 测试与样本

| 层 | 文件 | 内容 |
|---|---|---|
| 单元 | `chat/request.test.ts`、`chat/response.test.ts`、`messages/request.test.ts`、`messages/response.test.ts`、`tools.test.ts`、`dialects.test.ts`、`sse.test.ts`、`errors.test.ts`、`providers.test.ts` | §3、§4、§5 的每一项：录制样本的转换（快照在 `src/__snapshots__/codex-requests/*.chat.json` 与 `*.messages.json`）、对话中间的 developer 消息各模式、图片、工具输出里的图片、孤立的推理、长名字与撞名、length / content_filter、流中的错误与提前断开、交错的并行调用、没有 index 的上游、整段 JSON；Messages 另有思考信封的往返与不带回的各种情况、不合规则的 call_id、占位工具、思考开关与 `max_tokens` 的取值、redacted_thinking、相邻 text 块合并、各 stop_reason、usage 的缓存读写；每个事件序列都过一遍 `codexProblems`（按 Codex 的解析规则检查） |
| 集成 | `gateway.integration.test.ts`、`provider-test.integration.test.ts` | 真实 HTTP：令牌、路由、透传（请求体只少 `client_metadata`、请求头白名单、Key 替换）、deepseek-official、两条方言修正、gzip、Chat 转换（apply_patch 与 namespace 往返、交错的并行调用、incomplete、failed）、Messages 转换（请求头、工具调用与跨回合思考的三步往返、不给签名的上游、压缩请求、incomplete、failed、Anthropic 风格的错误正文）、上游错误（状态码与正文、Key 遮掉）、502、Codex 断开时中断上游（三种处理方式）、`setProviders` 不影响进行中的请求、`close()`、日志口径；testProvider 的成功与每种失败（三种处理方式）。Messages 的 mock（`test-fixtures/mock-messages.ts`）按 Anthropic 的结构规则检查请求，不合规则就回 400：`max_tokens`、`budget_tokens`、角色交替、空文本、思考块的签名（对原文哈希，改了就对不上）、`tool_result` 紧跟且排在最前、有工具调用就必须定义工具、名字与 id 的字符 |
| 真实模型（可选） | `gateway.real.integration.test.ts` | `WEVIR_TEST_API_KEY` + `WEVIR_TEST_PROVIDER=deepseek`（或 `deepseek-official`）时，DeepSeek 的透传、Chat 转换与 Messages 转换（`https://api.deepseek.com/anthropic`）各一次最小对话与 testProvider；Messages 另跑一次带工具调用与跨回合思考的对话（三个请求，打印推理项与带签名的数量）。模型默认 `deepseek-flash`，`WEVIR_TEST_MODEL` 可改。否则跳过并打印原因 |
| 端到端（手动） | `spikes/codex-app-server`：`WEVIR_SPIKE_GATEWAY=product node src/run-all.ts --transport=gateway,passthrough`（先 `pnpm --filter @wevir/model-gateway build`） | 真实 `codex-app-server` 经产品网关跑 Spike 的 12 个场景（流式、apply_patch 与审批、跨回合推理、子 agent、取消、resume、计划、上游错误、密钥）。2026-10-14：104 项检查全部通过。R2 的契约测试第 2 层建成后由它替代 |

运行：`pnpm --filter @wevir/model-gateway test`（或 `pnpm vitest run --project model-gateway --maxWorkers=2`）。

**请求样本**（`src/test-fixtures/codex-requests/`）由 `spikes/codex-app-server/src/record-requests.ts` 录制：锁定版本的 `codex-app-server` 直连本地 Responses mock，按 Wevir 将来的配置（加固项、`goals = false`、模型目录声明 apply_patch、图片输入与推理档位）跑两个回合和一次手动压缩，脱敏（本机路径、时区、UUID 换成占位符，约 2 万字符的基础提示词换成长度说明）后写入：

| 样本 | 内容 |
|---|---|
| `1-first-turn` | 第一回合的第一个请求：两条 developer（基础提示词、skills）、`<environment_context>`、用户输入；工具有 function、custom（apply_patch）、namespace（multi_agent_v1） |
| `2-tool-results` | 同一回合带着两个并行工具调用（apply_patch、exec_command）的结果：reasoning → custom_tool_call → function_call → 两个 output |
| `3-next-turn` | 第二回合：上一回合的推理与回答、改审批策略后对话中间的 developer 消息、带图片的用户输入 |
| `4-compact` | `thread/compact/start` 的压缩请求：`tools: []` + `tool_choice: "auto"` |

Codex 升级时重录（`node src/record-requests.ts`），再跑本包的测试：`__snapshots__/codex-requests/` 的变化就是转换结果的变化。根 `biome.json` 排除了这两个目录，保持录制原样。

## 10. 局限与没做的

- Gemini 原生协议；接进 Host 与 adapter-codex、Codex 侧的配置（R2）。
- 真实模型只在 Spike 里用 DeepSeek 跑过三条路（codex-notes §7.3）；本包的真实模型测试要 Key，R1、R10 都没有执行（Messages 转换没有对任何真实服务跑过）。其他服务的推理带回、自定义工具、namespace 要逐家验证（R8 起）。
- Messages：缺签名的思考不带回（§5.3）；`thinkingFormat` 只有 `adaptive` / `enabled` 两种，Sonnet 4.5、Haiku 4.5 不认 `output_config.effort` 却没有开关去掉；`max_tokens` 的默认值 32000 对上限更低的服务要在 Provider 里写明；Anthropic 的 HTTP 400 “prompt is too long”原样转回，Codex 不会把它认成上下文超长（只有流里的 `context_length_exceeded` 才会）；不发 `metadata.user_id`、`stop_sequences`、服务端工具；`custom_tool_call_input.delta` 同 Chat，不生成。
- Chat 转换不传 `parallel_tool_calls`、`strict`（为兼容性），不处理各家的思考开关；`reasoning.summary` 没有对应。
- 图片只支持 data URL 与网址，`file_id` 引用丢掉。
- `custom_tool_call_input.delta` 增量不生成（Chat 转换在流结束时才提交工具调用），apply_patch 的补丁内容不会边生成边显示。
- Host 进程里的 `fetch` 不读 `HTTPS_PROXY` 等代理变量（providers.md §6.3 的同一局限）。
