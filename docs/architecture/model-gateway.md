# 模型协议网关

> 状态：v0（R1）· 日期：2026-10-14 · Codex `rust-v0.162.1`（`092d3ac`）
> 依据：[ADR-0005](../adr/0005-agent-runtime-and-model-gateway.md) 决策 2 与补记 3；[Codex 研读与 Spike](../research/codex-notes.md) §3、§5、§6.3、§7.3；[Provider 配置桥接](./providers.md) §2.3、§6
> 代码：`packages/model-gateway/src/`（`gateway.ts`、`upstream.ts`、`providers.ts`、`dialects.ts`、`tools.ts`、`chat/request.ts`、`chat/response.ts`、`errors.ts`、`provider-test.ts`）；原型是 `spikes/codex-app-server/src/gateway.ts`
> 样本：`packages/model-gateway/src/test-fixtures/codex-requests/`（真实 `codex-app-server` 发出的请求，§8）

Codex 只会说 OpenAI Responses（codex-notes §3）。网关在 Host 进程里，对 Codex 暴露一个 Responses 端点，按 Provider 的协议把请求透传或转换给上游：Codex 只拿到网关的一次性令牌，上游 Key 只在 Host；Codex 附带的安装 ID、会话与回合 ID 不发给第三方；各家 Responses 实现的差异（方言）在这里修正，不碰 Codex。本任务（R1）做了 Responses 透传与 Chat Completions 转换；Anthropic Messages 是 R10，接进 Host 与 adapter-codex 是 R2。

```text
codex-app-server ──POST /v1/p/<providerId>/responses──► 网关（Host 进程，127.0.0.1:随机端口）
  Authorization: Bearer <网关令牌>                         ├─ openai-responses / deepseek-official：透传 + 方言修正 ──► <上游>/responses
                                                           └─ openai-completions：Responses ⇄ Chat 转换 ─────────────► <上游>/chat/completions
                                                              Authorization: Bearer <上游 Key>
```

## 1. 接口

```ts
import { startModelGateway, validateProvider, testProvider } from '@wevir/model-gateway';

const gateway = await startModelGateway({ logger });   // logger：info / warn，与 Host 的 Logger 兼容；可省略
gateway.setProviders(providers);                         // GatewayProvider[]（= ProviderConfig，含 Key）
gateway.baseURL('kimi');                                 // 'http://127.0.0.1:<port>/v1/p/kimi'，写进 Codex 的 base_url
gateway.token;                                           // Codex 的 env_key 的值
await gateway.testProvider(provider, modelId);           // ProviderTestResult（§6）
await gateway.close();                                   // 停止监听，中断所有进行中的上游请求
```

| 成员 | 说明 |
|---|---|
| `startModelGateway(options)` | 监听 `127.0.0.1` 的随机端口。`options.logger`（§7）；`options.deepseekBaseURL`：`deepseek-official` 的 Responses 地址，默认 `https://api.deepseek.com`，测试指向本地 mock；`options.testTimeoutMs`：testProvider 的时限，默认 20 s |
| `token` | 每个网关实例 `randomBytes(32)` 生成（base64url，43 个字符），只在内存里。比较两边的 SHA-256 用 `timingSafeEqual`（常量时间） |
| `baseURL(providerId)` | Codex 的 `base_url`；Codex 自己在后面加 `/responses`。ID 经 `encodeURIComponent` |
| `setProviders(providers)` | 换上整套 Provider（深拷贝，之后改传入的对象不影响网关）。每个请求在开始时取一次配置，所以之后的请求按新配置走，进行中的请求不受影响 |
| `testProvider(provider, modelId)` | provider.test（ADR-0005 决策 2.5），§6 |
| `close()` | 中断进行中的上游请求、断开所有连接、停止监听；可重复调用 |
| `validateProvider(provider)`（独立导出） | 网关处理不了的配置，返回 `ProviderIssue[]`：`anthropic-messages`（“R10 之后支持”）、`openai-compatible` 缺 `api` / `baseURL`、`baseURL` 带凭据或查询参数、§4.4 两个开关的取值。与 dsh 的检查（`adapter-dsh` 的 `validateProviderConfig`）无关，adapter-codex 用它 |

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
| `anthropic-messages` 等不支持的配置 | 400 | `api：Codex 引擎的模型网关暂不支持 anthropic-messages 协议（R10 之后支持）` | 否 |
| 连不上上游（DNS、拒绝连接、TLS） | 502 | `连不上上游：<原因>`；5xx 让 Codex 按自己的策略重试 | 是 |

处理方式按 Provider 选（`routeOf`）：

| Provider | 处理方式 | 上游地址 |
|---|---|---|
| `kind: deepseek-official` | Responses 透传（§3） | `https://api.deepseek.com/responses`（DeepSeek 的 Codex 接入文档）。Provider 的 `baseURL` **不用**：那是 dsh 的 Anthropic Messages 地址（providers.md §2.2），协议不同 |
| `openai-compatible` + `api: openai-responses` | Responses 透传（§3） | `<baseURL>/responses`（末尾斜线去掉） |
| `openai-compatible` + `api: openai-completions` | Chat 转换（§4） | `<baseURL>/chat/completions` |
| `openai-compatible` + `api: anthropic-messages` | 不支持（R10） | — |

发给上游的请求头只有网关自己的四个：`content-type: application/json`、`accept: text/event-stream`、`user-agent: wevir-gateway/<包版本>`、`authorization: Bearer <上游 Key>`（另有 fetch 与 HTTP 本身的 `host`、`content-length`、`connection`、`accept-encoding`、`accept-language`、`sec-fetch-mode`）。不跟随重定向。

## 3. Responses 透传

### 3.1 剥离的字段

- **请求体**：去掉 `client_metadata`（含 `x-codex-installation-id`、thread / turn ID、`x-codex-turn-metadata` 整段 JSON，codex-notes §3.1）。其余字段原样，包括 `prompt_cache_key`（值是 thread ID，上游用它做提示词缓存）、`include`、`store: false`、`reasoning`。
- **请求头**：Codex 的请求头一个都不转发，因为上游请求头由网关重新组装（§2）。录制样本里 Codex 发的是 `originator`、`user-agent`、`session-id`、`thread-id`、`x-client-request-id`、`x-codex-window-id`、`x-codex-turn-metadata`、`x-codex-beta-features`，子 agent 另有 `x-openai-subagent`、`x-codex-parent-thread-id`；`authorization` 里的网关令牌换成上游 Key。
- **响应**：状态码与正文原样转回；没有响应方向的方言修正时连字节都不动（`content-type` 用上游的），有时逐条解析 SSE、改写后重新编码（`text/event-stream`）。Codex 读到 `response.completed` 就断开（§5），这时上游的剩余字节不再转发。

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
| `thinkingFormat` | — | 本任务不读（各家思考开关的写法，以后按服务加） | — |

## 5. 错误与取消

- **上游非 2xx**：状态码原样转给 Codex（429、5xx 由 Codex 自己的重试策略处理：5xx 与传输错误重试，429 不重试，codex-notes §3.1），正文整理成 `{"error": {"message", "type"?, "code"?}}`：认 OpenAI 风格 `{error: {message, type, code}}`、`{error: "…"}`、Anthropic 风格 `{type: "error", error: {type, message}}`、`{message}`、`{detail}`，都不是时用原文，空正文写 `上游返回 HTTP <状态码>`；原文最多 4000 字符，**原文里出现的上游 Key 换成 `***`**（有的服务回显 Key）。保留 `type` / `code`，因为 Codex 靠它们认出额度用完、上下文超长等（`codex-api/src/api_bridge.rs`）。两种处理方式相同。
- **Responses 上游流里的 `response.failed`**：原样转回。
- **Codex 断开**（读到 `response.completed` 就断开，`responses.rs:631-637`；取消回合时也断开）：网关中断上游请求，按正常结束处理，日志记 `client_closed`。Spike 与集成测试都核对了 mock 上游看到连接被中断。
- **网关关闭**（`close()`）：中断所有进行中的上游请求。
- 进行中的请求在 `setProviders` 之后仍用开始时的配置（§1）。

## 6. testProvider

用与正式请求相同的处理方式（`prepareUpstream`：透传加方言修正，或 Chat 转换）发一次最小的流式请求：

```json
{"model": "<modelId>", "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "ping"}]}],
 "stream": true, "store": false, "max_output_tokens": 16}
```

Chat 上游收到的是 `{model, messages: [{role: user, content: ping}], stream: true, stream_options: {include_usage: true}, max_tokens: 16}`（字段名按 compat）。读处理后的 Responses 事件，跳过 `response.created` / `response.in_progress`（Chat 转换时它是网关自己发的；透传时上游也是先发它，之后才可能是 `response.failed`），第一条别的 `response.*` 事件就算成功，`latencyMs` 是从发出请求到这一刻；然后断开，不让模型继续生成。时限 20 s，不跟随重定向。

失败归类与 adapter-dsh 的口径相同（providers.md §6.2，代码是复制的：网关不能依赖 adapter-dsh）：没有 Key → `missing_key`（不发请求）；配置不完整（含 `anthropic-messages`）→ `unknown`；401 / 403 → `auth`；429 → `rate_limited`；5xx → `server`；原文提到模型不存在 → `model_not_found`；其余 404 / 405、400 / 422 → `protocol`；连不上 → `network`；超时 → `timeout`；200 但是网页、或不是 Responses 事件 → `protocol`；200 但第一条是 `response.failed` / `error` 事件（Chat 转换时就是上游流里的错误）→ 按原文归为 `model_not_found` / `auth` / `unknown`。消息里的 Key 换成 `***`。

与 adapter-dsh 的差别：`deepseek-official` 走 DeepSeek 的 Responses 端点，而不是 dsh 用的 Anthropic Messages；`openai-responses` 的探测请求是 message 项的数组，不是字符串。

## 7. 日志口径

每个到达路由的请求结束时一行 `info`（`msg: "gateway request"`），字段**只有**：`method`、`providerId`、`outcome`、`durationMs`，另按情况有 `upstreamStatus`（上游的状态码）、`status`（网关自己回的状态码）、`error`（连不上上游时的错误码，如 `ECONNREFUSED`，不记带地址的原文）。`outcome` 取值：`completed`、`client_closed`（Codex 断开或网关关闭，正常）、`upstream_error`（上游非 2xx）、`network_error`、`rejected`（§2 里网关自己回的 4xx）。令牌不对是一行 `warn`（`gateway request rejected`，`method` 与 `status: 401`）。网关内部异常是 `warn`（`gateway internal error`）。

不记请求体、响应体、上游错误原文、任何 Key 与令牌（集成测试核对：日志里没有 Key、令牌、模型的推理与回答、请求里的文本）。

## 8. 测试与样本

| 层 | 文件 | 内容 |
|---|---|---|
| 单元 | `chat/request.test.ts`、`chat/response.test.ts`、`tools.test.ts`、`dialects.test.ts`、`sse.test.ts`、`errors.test.ts`、`providers.test.ts` | §3、§4 的每一项：录制样本的转换（快照在 `src/__snapshots__/codex-requests/*.chat.json`）、对话中间的 developer 消息三种模式、图片、工具输出里的图片、孤立的推理、长名字与撞名、length / content_filter、流中的错误与提前断开、交错的并行调用、没有 index 的上游、整段 JSON；每个事件序列都过一遍 `codexProblems`（按 Codex 的解析规则检查） |
| 集成 | `gateway.integration.test.ts`、`provider-test.integration.test.ts` | 真实 HTTP：令牌、路由、透传（请求体只少 `client_metadata`、请求头白名单、Key 替换）、deepseek-official、两条方言修正、gzip、Chat 转换（apply_patch 与 namespace 往返、交错的并行调用、incomplete、failed）、上游错误（状态码与正文、Key 遮掉）、502、Codex 断开时中断上游（两种处理方式）、`setProviders` 不影响进行中的请求、`close()`、日志口径；testProvider 的成功与每种失败 |
| 真实模型（可选） | `gateway.real.integration.test.ts` | `WEVIR_TEST_API_KEY` + `WEVIR_TEST_PROVIDER=deepseek`（或 `deepseek-official`）时，DeepSeek 的透传与 Chat 转换各一次最小对话与 testProvider；模型默认 `deepseek-flash`，`WEVIR_TEST_MODEL` 可改。否则跳过并打印原因 |
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

## 9. 局限与没做的

- Anthropic Messages（R10）、Gemini 原生协议；接进 Host 与 adapter-codex、Codex 侧的配置（R2）。
- 真实模型只在 Spike 里用 DeepSeek 跑过三条路（codex-notes §7.3）；本包的真实模型测试要 Key，本次没有执行。其他服务的推理带回、自定义工具、namespace 要逐家验证（R8 起）。
- Chat 转换不传 `parallel_tool_calls`、`strict`（为兼容性），不处理各家的思考开关；`reasoning.summary` 没有对应。
- 图片只支持 data URL 与网址，`file_id` 引用丢掉。
- `custom_tool_call_input.delta` 增量不生成（Chat 转换在流结束时才提交工具调用），apply_patch 的补丁内容不会边生成边显示。
- Host 进程里的 `fetch` 不读 `HTTPS_PROXY` 等代理变量（providers.md §6.3 的同一局限）。
