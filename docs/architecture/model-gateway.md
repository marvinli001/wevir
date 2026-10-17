# 模型协议网关

> 状态：v0.11（含 Kimi Responses 方言）· 日期：2026-10-17 · Codex `rust-v0.162.1`（`092d3ac`）
> 依据：[ADR-0005](../adr/0005-agent-runtime-and-model-gateway.md) 决策 2 与补记 3、4；[Codex 研读与 Spike](../research/codex-notes.md) §3、§5、§6.3、§7.3；[Provider 配置桥接](./providers.md) §2.3、§6；Anthropic Messages API 的流式、思考、工具使用文档（2026-10 版）；xAI 的 Responses 参考与 OpenAPI、Gemini 的 OpenAI 兼容与 thought signature 文档（2026-10-13 版，R8）
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
| `validateProvider(provider)`（独立导出） | 网关处理不了的配置，返回 `ProviderIssue[]`：`openai-compatible` 缺 `api` / `baseURL` 或协议不认识、`baseURL` 带凭据或查询参数、§4.4 网关开关的取值、`anthropic-messages` 的 `thinkingFormat`（§5.4）。与 dsh 的检查（`adapter-dsh` 的 `validateProviderConfig`）无关，adapter-codex 用它；adapter-dsh 仍拒绝 `anthropic-messages`（dsh 不支持） |

`GatewayProvider` 与 `@wevir/runtime-adapter` 的 `ProviderConfig` 同形；`GatewayCompat` 与 Host 协议的 `ProviderCompat` 同形。0.4.0 起含 `supportsCustomTools` / `systemMessageMode`，0.12.0 起另含 `supportsNamespaceTools` / `toolChoice`，0.26.0 起有默认关闭的 `geminiToolSchema`（§4.4；ADR-0005 补记 7、12、16）。

## 2. 路由与处理方式

### Google Cloud 服务账号认证

认证实现在 `vertex-auth.ts`；对应测试为 `vertex-auth.test.ts`（JWT、刷新与取消）、`vertex.test.ts`（录制请求、路由与限制）和 `vertex.integration.test.ts`（HTTP 交换、共享令牌、工具签名与脱敏）。

`google-vertex`（协议 0.21.0）由 Host 从 SecretStore 取整份 serviceAccountJson，只交给进程内网关；project / location 存 ProviderProfile.vertex，location 默认 global，不读取 ADC、gcloud 或 express API Key。网关固定向 https://oauth2.googleapis.com/token 发 RS256 JWT bearer（scope 为 https://www.googleapis.com/auth/cloud-platform、aud 为令牌端点、有效期一小时），不跟随重定向、不使用 JSON 自带的其他 token_uri。按整份凭据的 SHA-256 缓存令牌，在剩余五分钟内的下一次请求刷新，同一凭据的并发请求与 testProvider 共用一次交换。取消一条模型请求只取消它的等待，不影响其他等待者；网关关闭会取消交换、清空缓存。替换凭据不复用旧令牌。交换或签名失败统一为 auth（网关 HTTP 401 / invalid_api_key），不把令牌服务的响应原文、JWT 或私钥放进错误与日志。

Gemini 走现有 Chat 转换：global 为 https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/endpoints/openapi/chat/completions；其他 location 为 https://{location}-aiplatform.googleapis.com/v1beta1/projects/{project}/locations/{location}/endpoints/openapi/chat/completions。模型需 google/gemini- 前缀，thought signature 沿用 §4.5，按 Vertex kind 启用。Gemini 3.8 Flash 不认 minimal（降为 low），xhigh / max 降为 high；显式 compat 仍优先于地址默认。模板只列 low / medium / high。

Claude 走 Messages 变体：https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/publishers/anthropic/models/{model}:streamRawPredict；其他 location 的域名为 {location}-aiplatform.googleapis.com，仍用 v1。模型必须 claude- 开头，模型进 URL、正文去掉 model、加 anthropic_version: vertex-2023-10-16，认证仅 Authorization: Bearer，不发 x-api-key / anthropic-version。思考块与工具历史沿用 §5；不接受 URL 图片（在请求上游前报 400，不悄悄丢图），转换后的请求体超过 30,000,000 字节报 413。当前模板模型用 global 或 us / eu；具体地域仅旧模型可用，详见 providers.md §7.11。

Vertex 专用方言登记（只在生成的 Google 官方地址生效，显式 compat 优先）：

| 方言 | 生效条件 | 请求变化 |
|---|---|---|
| Gemini thought signature | google-vertex 的 Chat 路由 | 复用 §4.5，签名按 Provider 与模型绑定 |
| Gemini 推理档位 | 同上，未显式设置 thinkingFormat | 3.8 Flash 的 minimal / none 降 low，其他 Gemini 的 none 用 minimal；xhigh / max 降 high |
| Claude Messages 变体 | google-vertex 的 Messages 路由 | model 进 URL、版本字段进正文、只用 Bearer；当前 Claude 的模型限制同 §5，URL 图片与 30 MB 限制见上文 |

正式请求与 testProvider 共用认证与 prepareUpstream。只对 google-vertex 应用这些规则，不改变普通 Messages / Chat 服务。官方依据与核对日期见 providers.md §7.11。

只有一个路由：`POST /v1/p/<providerId>/responses`（忽略查询串）。检查顺序与网关自己的回应：

| 情况 | 状态码 | 正文（`{"error":{"message":"wevir gateway: …"}}`） | 是否碰上游 |
|---|---|---|---|
| 令牌缺失或不对（不论路径） | 401 | `令牌不对`，`code: invalid_api_key` | 否 |
| 路径不是上面的形状 | 404 | `不支持 <方法> 这个路径` | 否 |
| 方法不是 POST | 405 | | 否 |
| 没有这个 Provider | 404 | `没有 Provider <id>`，`code: model_not_found` | 否 |
| Provider 没存 Key 或 Vertex 服务账号 | 401 | `Provider <id> 没有 API Key`，Vertex 为“没有服务账号 JSON” | 否 |
| 请求体超过 64 MiB | 413 | | 否 |
| `content-encoding` 不是 identity / gzip / deflate / br / zstd | 415 | Codex 只在 OpenAI 官方 + ChatGPT 登录时用 zstd 压缩请求体（`core/src/client.rs:1634-1642`），经网关的请求不压缩；解压留着以防万一 | 否 |
| 不是 JSON，或缺 `model` / `input` | 400 | | 否 |
| `validateProvider` 不通过的配置（不认识的协议等） | 400 | `api：不认识的协议 <api>` 等 | 否 |
| 连不上上游（DNS、拒绝连接、TLS） | 502 | `连不上上游：<原因>`；5xx 让 Codex 按自己的策略重试 | 是 |

处理方式按 Provider 选（`routeOf`）：

| Provider | 处理方式 | 上游地址 |
|---|---|---|
| `kind: deepseek-official` | Responses 透传（§3） | `https://api.deepseek.com/responses`（DeepSeek 的 Codex 接入文档）。Provider 的 `baseURL` **不用**：那是 dsh 的 Anthropic Messages 地址（providers.md §2.2），协议不同 |
| `google-vertex` + `api: openai-completions` | Chat 转换 + 服务账号令牌 | 本节 Google Cloud 路由 |
| `google-vertex` + `api: anthropic-messages` | Messages 变体 + 服务账号令牌 | 本节 Google Cloud 路由 |
| `openai-compatible` + `api: openai-responses` | Responses 透传（§3） | `<baseURL>/responses`（末尾斜线去掉） |
| `openai-compatible` + `api: openai-completions` | Chat 转换（§4） | `<baseURL>/chat/completions` |
| `openai-compatible` + `api: anthropic-messages` | Messages 转换（§5） | `<baseURL>/v1/messages`；`baseURL` 已以 `/v1` 结尾时只加 `/messages`（与 adapter-dsh 对 DeepSeek 的 Messages 地址同一拼法）。例：`https://api.deepseek.com/anthropic` → `…/anthropic/v1/messages` |

发给上游的请求头只有网关自己的：`content-type: application/json`、`accept: text/event-stream`、`user-agent: wevir-gateway/<包版本>`，加上认证：Responses 与 Chat 是 `authorization: Bearer <上游 Key>`，Messages 是 `x-api-key: <上游 Key>` 与 `anthropic-version: 2023-06-01`（Anthropic 官方与 DeepSeek 等兼容服务都认 `x-api-key`，不发 `authorization`）。另有 fetch 与 HTTP 本身的 `host`、`content-length`、`connection`、`accept-encoding`、`accept-language`、`sec-fetch-mode`。不跟随重定向。

## 3. Responses 透传

### 3.1 剥离的字段

- **请求体**：去掉 `client_metadata`（含 `x-codex-installation-id`、thread / turn ID、`x-codex-turn-metadata` 整段 JSON，codex-notes §3.1）。其余字段原样，包括 `prompt_cache_key`（值是 thread ID，上游用它做提示词缓存）、`include`、`store: false`、`reasoning`（§3.2 的通用修正除外）。
- **请求头**：Codex 的请求头一个都不转发，因为上游请求头由网关重新组装（§2）。录制样本里 Codex 发的是 `originator`、`user-agent`、`session-id`、`thread-id`、`x-client-request-id`、`x-codex-window-id`、`x-codex-turn-metadata`、`x-codex-beta-features`，子 agent 另有 `x-openai-subagent`、`x-codex-parent-thread-id`；`authorization` 里的网关令牌换成上游 Key。
- **响应**：2xx 的正文原样转回；没有响应方向的方言修正时连字节都不动（`content-type` 用上游的），有时逐条解析 SSE、改写后重新编码（`text/event-stream`）。非 2xx 的状态码保留、错误正文按 §6 整理。Codex 读到 `response.completed` 就断开（§6），这时上游的剩余字节不再转发。

### 3.2 方言修正

`dialects.ts` 的 `RESPONSES_DIALECTS` 是一个有序清单，每条声明对哪些 Provider 生效（`applies`），改请求体，必要时返回响应事件的改写函数。新的修正加在清单里，并在下表登记。

| ID | 对谁生效 | 请求 | 响应 | 依据 |
|---|---|---|---|---|
| `drop-tool-choice-without-tools` | 所有 Provider | `tools` 是空数组或没有时去掉 `tool_choice` | — | Codex 的压缩请求发 `tools: []` + `tool_choice: "auto"`（样本 `4-compact`），xAI 报 400（codex-notes §3.4）。没有工具时 `tool_choice` 本来就没有意义，所以不设开关 |
| `strip-null-reasoning-content` | 所有 Provider | 历史里 reasoning 项的 `content: null` 去掉这个键 | — | Codex 回放上游没给 `content` 的推理项（xAI 只给 `encrypted_content`）时写 `"content": null`，xAI 回 422 `expected a sequence`，去掉就是 200（openai/codex#47733，2026-09）。schema 里 `content` 是数组，null 对谁都不合法 |
| `strip-null-reasoning-encrypted-content` | 所有 Provider | 历史里 reasoning 项的 `encrypted_content: null` 去掉这个键，明文 `content`、`summary` 保留 | — | 锁定 Codex 的 `ResponseItem::Reasoning.encrypted_content` 是 `Option<String>`，没有 skip-serialize：上游省略或给 null，下一步都写 null（`protocol/src/models.rs:1051–1063`）。不把它当成可带回的加密推理 |
| `azure-namespace-description` | Azure 全球三个资源域名的 Responses（§3.5） | 顶层 tools 中 namespace 的 description 缺失、空串或纯空白时补 `Tools in this namespace.`；已有描述不变 | — | [Codex #37952](https://github.com/openai/codex/issues/37952) 报告 Azure 拒收缺失或空的 namespace 描述；锁定配置不开 Responses Lite，修正普通 tools，不处理尚不发出的 additional_tools |
| `azure-encrypted-reasoning` | 同上，store 为 false | include 缺少 reasoning.encrypted_content 时追加，保留其他 include 项且不重复 | — | [Azure Responses 无状态推理](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses#encrypted-reasoning-items)要求显式 include；正式请求与 testProvider 共用 |
| `kimi-data-images-only` | moonshot.cn / moonshot.ai 及子域的 Responses（§3.8） | message.content 与工具结果 output 数组里的 input_image 只保留 data URL，丢掉网址与 file_id 图片；其他部件、工具调用和推理不变，不下载图片 | — | [Kimi Responses](https://platform.kimi.com/docs/api/responses.md)只收 data URL |
| `auto-only-tool-choice` | 生效的 `compat.toolChoice === auto_only`（§4.4） | 有工具时 `required`、具名与其他非 auto 值改为 `auto`；`none` 去掉 `tool_choice`，工具保留；没有 `tool_choice` 时不补 | — | [Kimi Responses](https://platform.kimi.com/docs/api/responses.md) 的枚举只有 auto；[MiniMax Responses](https://platform.minimax.io/docs/api-reference/responses-create) 认 none / auto（2026-10-15 重核）。用共同的 auto_only 规则兼容两种；去掉 none 后允许模型自行调用工具 |
| `flatten-custom-tools` | 生效的 `compat.supportsCustomTools === false`（§4.4：声明优先，其次地址默认） | `custom` 工具（apply_patch）→ `{type: function, name, description: 原描述 + 语法全文, parameters: {input: string}, strict: false}`，namespace 里的同样处理、namespace 本身不动；`tool_choice: {type: custom}` → `function`；历史里的 `custom_tool_call` → `function_call`（`arguments: {"input": …}`，不带 `id`：上游可能按前缀校验），`custom_tool_call_output` → `function_call_output` | `output_item.added` / `.done` 与 `response.completed.response.output` 里同名（同命名空间）的 `function_call` → `custom_tool_call`（`input` 从参数里取，取不到时原样当输入）；其余事件不动。`function_call_arguments.*` 增量 Codex 本来就忽略 | 不支持自定义工具的 Responses 实现。xAI（R8 核实）：OpenAPI（docs.x.ai/openapi.json）的 `tools` 只有 function 与托管工具，没有 `custom`；第三方 2026-08 的现网对照也是 custom 被拒、摊平后通过。国内服务模板里 xAI 显式写了 `false`（经代理改了地址也生效）。规则与 Chat 转换的摊平相同（§4.3） |
| `flatten-namespace-tools` | 生效的 `compat.supportsNamespaceTools === false`（§4.4） | `namespace` 工具里的每个工具摊平成 `<ns>__<name>`（与 §4.3 同一套命名，`ToolNames`），工具类型不变；具名 `tool_choice` 同样改名并去掉 `namespace`；历史里带 `namespace` 的 `function_call` / `custom_tool_call` 换成摊平的名字、去掉 `namespace`。排在 `flatten-custom-tools` 之后 | 同名的调用还原名字与 `namespace`。响应的改写按清单的**相反顺序**套用：先还原命名空间，`flatten-custom-tools` 才认得出 namespace 里的 custom 工具 | xAI 的 OpenAPI 没有 `namespace` 类型的工具，函数调用也没有 `namespace` 字段，而 Codex 的子 agent 工具在 `multi_agent_v1` 里（样本 `1-first-turn`）。没找到直接的 400 报告（R8 没有 xAI 的 Key），但摊平对认命名空间的上游同样可用，所以地址默认仍是 false；P0a 加了显式开关，经代理换地址也能生效，true 可覆盖地址默认 |

还没做、留给以后按服务加的：MiniMax 的 `effort: none` 报 400；各家思考开关与 `reasoning.effort` 取值不同（codex-notes §5.3；xAI 的模型目录只列它认的档位，见国内服务模板）；DeepSeek 的 namespace 工具已实测支持（§7.3），不用摊平；Chat / Messages 转换写的推理信封（`wevir-gw:` 开头的 `encrypted_content`）在会话中途换成 Responses 上游时原样透传（跨来源接力通过历史摘要衔接，不保证原始信封在 Responses 上游可用，仍未做通用解封）；xAI 错误体顶层的 `code`（`{"code","error":"…"}`）经 §6 的整理会丢掉。

### 3.3 OpenAI 官方 API 核对

**2026-10-15 已核对**当前官方 Responses 文档与锁定 Codex 的请求，`https://api.openai.com/v1` 继续走透传，无需新增方言或 compat 字段：

- 只剥离 `client_metadata`，不把它混进公开的 `metadata`。Codex 的内部请求头（包括 `X-OpenAI-Internal-Codex-Responses-Lite`）仍不转发，使用普通 Responses 端点；Wevir 自定义模型目录不会开启 Responses Lite 或新的输入项，触发条件见 §10。
- `prompt_cache_key` 原样保留。官方缓存指南说明：GPT-5.6 起由服务自动路由缓存，该键仍可用于区分用量；不改成网关或 Provider ID。`prompt_cache_options`（包括 `ttl: "30m"`）原样透传；旧的 `prompt_cache_retention` 已标为弃用，但两者表达不同的保留策略，网关不自行互换、注入或删掉它。
- `store: false` 时 reasoning 输出默认包含 `encrypted_content`，旧的 `include: ["reasoning.encrypted_content"]` 仍接受。两种请求写法都保留；响应字节不变，加密字符串不解码、不改写为网关信封。后续工具结果与下一回合的完整历史照常带回，仅清理 Codex 序列化的两个 null 键（§3.2）。
- `reasoning.context`（auto / current_turn / all_turns）与 `reasoning.mode`（standard / pro）出现时原样透传，不主动补值。GPT-5.6 系列默认 all_turns，Sol 也支持；`store: false` 时依赖完整历史才能复用之前的推理，不能只带最后一条 reasoning。模型实际选用的 context 以上游响应为准。
- `max_output_tokens` 的最小值 **16 已在官方参考中声明**，现有 `testProvider` 的 16 不变。连接探测只证明最小请求可达，不能证明工具调用与加密推理的跨回合往返。

来源：[Responses create](https://developers.openai.com/api/reference/resources/responses/methods/create)、[推理与无状态历史](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-without-stored-responses)、[提示词缓存](https://developers.openai.com/api/docs/guides/prompt-caching)。模型与地域说明见 [providers.md §7.8](./providers.md#78-openairesponses)。

本地测试用四份录制请求确认只发生已有的字段清理，用 HTTP mock 确认加密推理在工具结果与下一回合都完整带回、响应 SSE 字节不变。新参数是按文档补入测试请求的，不声称锁定 Codex 已发送它们。真实 Key 的 Sol / Luna 契约第 3 层与桌面端工具对话尚未执行（§10）。

对应测试：`upstream.test.ts`（四份录制请求与新旧缓存参数），`openai.integration.test.ts`（有 / 无 include 的三步历史、null 清理、原始 SSE 与请求头隔离）。

### 3.4 阿里云百炼 Responses 核对

2026-10-15 按[官方 Codex 指南](https://help.aliyun.com/zh/model-studio/codex)选择按量 Responses 透传。北京旧域名与国际站旧域名仍可用，业务空间专属域名和地域见 [providers.md §7.2](./providers.md#72-阿里云百炼dashscope)。只给按量地址补 §4.4 的默认 compat，不为 Coding Plan / Token Plan 的域名补值。

[Responses 参数](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)只列 function 与内置工具，没有声明 custom / namespace；required 限单个工具，[Qwen 工具指南](https://help.aliyun.com/zh/model-studio/qwen-function-calling)另说明思考模式不支持 required。缺真实 Key，保守启用已有的 custom / namespace 摊平与 auto_only；显式 compat 可以逐字段覆盖。auto_only 会去掉 none 并保留工具，不能据此保证禁止调用工具。

`reasoning.effort` 原样透传，优先于将淘汰的 enable_thinking；Qwen3.8 模板只列 off（Codex 发 none）、low、medium、xhigh。保留 Codex 的 store: false，不启用服务端默认的七天响应存储。历史中的 reasoning id / summary 原样保留，只清理已有的两个 null 键，不改成 Chat / Messages 信封。官方还说明 Responses 输入约限模型窗口的 80%，超限会自动截断；模型目录的 1M 是模型窗口，不保证可输入同样多的历史。

`bailian.test.ts` 的录制请求与 `bailian.integration.test.ts` 的严格 HTTP mock 覆盖工具摊平、响应还原、工具结果和下一回合的推理回放，以及同路由的 testProvider；不能代替真实 custom / namespace / tool_choice 能力探测。真实契约与桌面 apply_patch 待验收（§10）。

### 3.5 Azure OpenAI / Microsoft Foundry

2026-10-15 按微软的 [Codex 指南](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/codex)使用 `/openai/v1/responses`，不加 api-version。`isAzureHost` 只识别资源子域 `*.openai.azure.com`、`*.services.ai.azure.com`、`*.cognitiveservices.azure.com`，不识别 Azure 中国或相似域名。前两种写法由 [v1 生命周期](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)明确列出；第三种仅保留域名识别，须使用部署详情页实际给出的 v1 端点，本次未从该页面独立确认其等价性。

认证保持网关现有的 Bearer API Key：微软的 OpenAI SDK 示例将资源 Key 交给普通 OpenAI 客户端，Codex 示例使用 env_key；据客户端的 Bearer 行为推断 v1 接受它。REST 示例使用 api-key。当前没有真实 Key，尚未实测确认，不增加认证字段或协议版本。Foundry Claude 走现有 Messages 转换，baseURL 为 `https://<resource>.services.ai.azure.com/anthropic`，认证是 x-api-key 与 anthropic-version: 2023-06-01。

只增加上表两条 Azure 请求修正。锁定版本按 §10 使用 multi_agent_v1，不发保留的 collaboration 命名空间，因而不删除或摊平子 agent 工具。Responses Lite 内部头仍不转发。custom apply_patch、prompt_cache_key、非空加密推理与响应 content_filters 原样透传；Codex 的响应解析忽略未知字段，HTTP 400 content_filter 的状态码与错误 code 按 §6 保留。

模型字段在两条路上均是部署名，原样发送。模板用可替换占位标明部署名，替换后保留窗口、输出与推理档位；不会把部署别名猜成模型 ID。Foundry Messages 地址默认使用 adaptive（显式 thinkingFormat 优先），避免自定义部署别名被当成旧的 enabled 格式；模板另显式声明 adaptive / inline，代理同样可用。已知型号的特殊限制仍按 §5 的模型名识别；使用完全自定义别名时无型号推断，中途指令回退为 user、默认 effort 交由服务决定，需真实部署验证。旧 Claude 部署需要手动声明 enabled。只提供当前 GA 的 Opus / Sonnet / Haiku 5.5，不加入预览模型与仅 Entra 的 Mythos。

来源、部署要求与手动配置见 [providers.md §7.12](./providers.md#712-azure-openai--microsoft-foundry)。`azure.test.ts` 使用四份录制请求，`azure.integration.test.ts` 用本机 HTTP mock 检查命名空间限制、认证、加密推理与工具往返、content_filters、内容过滤错误和 provider.test。mock 不证明真实 Azure 的认证或工具支持。

### 3.6 DeepSeek Responses 与 Chat

2026-10-16 按[官方 Codex 指南](https://api-docs.deepseek.com/quick_start/agent_integrations/codex)继续使用 `https://api.deepseek.com/responses` 透传，`deepseek-official` 与同地址的 openai-responses 均不摊平 apply_patch / namespace。custom 只认 apply_patch，其他 custom 名字会 400；锁定 Codex 的 freeform 工具范围见 §10。namespace 的历史 Spike 与本轮两个模型的子智能体契约均通过；官方指南未单列，当前配置保留 multi_agent_v1，不切到官方目录示例的 V2。

[Responses 参数](https://api-docs.deepseek.com/api/create-response)列出 none / auto / required / 具名选择，没有写思考时的例外；[Chat 参数](https://api-docs.deepseek.com/api/create-chat-completion)则明确思考时 required / 具名会 400。**2026-10-16 真实 Key 复现：Flash 与 V4 Pro 的 Responses 在 high 下，两种 forced choice 均回 HTTP 400、invalid_request_error，原因为 Thinking mode does not support this tool_choice；同请求 auto 均为 200 并调用工具。** 据此给 DeepSeek 的 Responses 与 Chat 路由补 `toolChoice: auto_only` 地址默认（§4.4），Chat 模板也显式声明；deepseek-official 按其固定 Responses 地址取默认，不读取供 dsh 使用的 baseURL。Messages 的工具选择保持原规则。显式 compat 优先，代理地址可手动 auto_only；none 的退化语义同 §3.2。

Responses 不存历史：store / include / previous_response_id 等静默忽略，每次仍带完整 input。明文 reasoning content 与原生 custom 调用、结果原样保留，只清理通用 null 字段；encrypted_content / summary 不受支持，不伪造加密信封。Chat 沿用 §4.4 的思考开关和所有 assistant 推理的回传。Messages 仍使用 `/anthropic/v1/messages`，预算忽略、模型映射与无签名局限见 §5 和 [官方兼容表](https://api-docs.deepseek.com/guides/anthropic_api)。

官方 models.json 为两个模型都列 low / high / max、context_window 1048576；模板另按 API 支持提供 off。`adapter-codex` 已生成 freeform apply_patch 与相应输入模态，新建官方 Provider 现在明确保存非空模型目录；旧 Profile 不迁移，手动更新见 providers.md §7.1。maxTokens 不填：Codex 不发 max_output_tokens，Responses / Chat 路由也不从模型目录补它；填 384K 不会解除服务默认的截断。Chat 默认的 8K / 64K / 128K 不能视为 Responses 的实测值，Responses 的实际默认与长回答仍未实测。

`deepseek.test.ts` 使用四份录制请求，`deepseek.integration.test.ts` 的 HTTP mock 检查 Responses 原生工具和推理往返、非 auto 拒绝与修正、显式 any / 代理覆盖、provider.test。`gateway.real.integration.test.ts` 提供三条路的工具与跨回合验证，以及 Responses 在显式 any 时 forced choice 的 400 与默认修正后的 200 对照；缺 Key 时明确跳过，不把 mock 结果当成服务能力证明。

### 3.7 Ollama 本机与 Cloud

2026-10-16 对照 [Codex 指南](https://docs.ollama.com/integrations/codex)使用无状态 Responses：本机 `http://127.0.0.1:11434/v1`，Cloud `https://ollama.com/v1`。Responses 从 0.13.3 起可用；不使用 previous_response_id、conversation 或 truncation，每步携带完整历史。占位 Key 也照常放入 Bearer 头，本机 Ollama 忽略它。

[0.40.4 源码](https://github.com/ollama/ollama/blob/v0.40.4/openai/responses.go)支持 namespace 的声明与调用还原，但 custom 工具声明没有 format / grammar 支持；历史能解析 custom 调用不等于能声明 freeform 工具。故本机只摊平 custom，保留 namespace；Cloud 官方明确不支持 custom/freeform 回放，namespace 尚未真实验证，保守摊平两者。两种地址的 Responses 默认 toolChoice: auto_only，Provider 显式 compat 逐字段优先；只识别本机 11434 端口及精确的 ollama.com，不识别套餐或其他域名。当前 OpenAI 兼容文档已经列出 Chat 的 tool_choice，与旧调研不同，Chat 路由不加这个默认值。

模型发现由 Host 的 provider.discoverModels 读取固定的 /api/tags、/api/show 与本机 /api/ps，不经过渲染进程。只允许回环地址或 HTTPS ollama.com，禁止凭据、查询串、非 /v1 路径与重定向；不会访问 tags 返回的 remote_host。响应体、模型数、并发数与请求时限均受限，Key 与上游原文不返回客户端。详情缺失时仍列出模型，但不猜思考档位或实际窗口。model_info 的 context_length 只是模型上限；运行中 /api/ps 的 context_length 优先，其次 /api/show 的 num_ctx。Cloud 使用模型上限；本机未知实际值时提醒核对，已知小于 65536 时提示 OLLAMA_CONTEXT_LENGTH。只提示、不修改服务或已存 Provider。

### 3.8 Kimi 开放平台

2026-10-17 核对[官方 Codex 指南](https://platform.kimi.com/docs/guide/codex-kimi.md)，使用国内按量端点 `https://api.moonshot.cn/v1/responses` 透传；国际端点为 `https://api.moonshot.ai/v1/responses`，两站 Key 不通用。地址识别只匹配 moonshot.cn / moonshot.ai 及子域，不匹配 Kimi Code 会员域名。默认 `toolChoice: auto_only` 仅用于 Responses，显式 compat 优先；保留原生 custom apply_patch（Lark 语法）与 namespace，不摊平。

图片只收 data URL。锁定 Codex 的 `core/src/tools/handlers/view_image.rs` 将 view_image 结果写成工具 output 中的 input_image，`protocol/src/models.rs` 的本地图片路径同样编码为 data URL；Wevir 的附件经 localImage 交给 Codex（`adapter-codex/src/codex-adapter.images.integration.test.ts`）。网关只在 Kimi Responses 上过滤 message.content 与工具 output 数组中的非 data URL 图片，不访问外部地址；只含被过滤图片的数组会变空，其他文本与工具结果保留。普通 Chat / Messages 路由的图片规则不变。

完整历史每步带回：reasoning 的明文 content 与 summary 保留，上游回放时 content 优先于 summary；encrypted_content 固定为 null，Codex 带回的两个 null 键由通用方言清理，不生成网关推理信封。store: false 原样保留，不依赖 previous_response_id。K3 的 reasoning.effort 仅 low / high / max（默认 max），不发 Chat 的 thinking 或 reasoning_effort。不注入 max_output_tokens，服务默认 131072、可设置的最大值为 1048576；模型目录的 maxTokens 不会改变透传请求的输出预算。

当前 Responses 参数页明确只支持 kimi-k3，K2.7-code 与 K2.6 的 Chat 参数不能据此推断为 Responses 能力。锁定 Codex 不发 prompt_cache_breakpoint；若外部调用带入该项，网关保持原值，Kimi 按文档返回 400。`kimi.test.ts` 的录制请求与 `kimi.integration.test.ts` 的本机 HTTP mock 检查工具选择、原生工具、图片与推理往返及 provider.test，不替代真实服务验收。来源、模型范围与手动修改见 providers.md §7.3。

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
| `tool_choice`：`auto` / `none` / `required` / `{type: function \| custom, name}` | 同名；对象形式换成 `{type: function, function: {name: 摊平后的名字}}`；其他值按 `auto`；`compat.toolChoice: auto_only` 时 required / 具名改 auto，none 只去掉 tool_choice、保留 tools（与透传相同） |
| `reasoning.effort` | 按 `compat.thinkingFormat` 发思考开关、力度或预算（§4.4）；没有 effort 时保留上游默认。`reasoning.summary` 丢掉 |
| `max_output_tokens`（Codex 不发，testProvider 发） | `compat.maxTokensField`；没设时 OpenAI 官方地址用 `max_completion_tokens`，其他用 `max_tokens`（与 providers.md §2.3 同一判断） |
| `temperature`、`top_p` | 原样 |
| `text.format` 是 `json_schema` | `response_format: {type: json_schema, json_schema: {name, schema, strict}}` |
| `store`、`include`、`prompt_cache_key`、`client_metadata`、`service_tier`、`parallel_tool_calls`、`stream_options`、`truncation`、`previous_response_id`、`metadata`、`user` | 丢掉 |
| 其他输入项（`web_search_call`、`local_shell_call`、`compaction`、`tool_search_*` 等） | 丢掉 |
| — | 总是 `stream: true`、`stream_options: {include_usage: true}` |
| — | `compat.requiresReasoningContentOnAssistantMessages`：没有推理的 assistant 补 `reasoning_content: ""`；显式值优先，其次按思考格式与 DeepSeek 地址补默认（§4.4） |

丢掉的东西记在 `toChatRequest(...).dropped`（`field:<字段>`、`tool:<类型>`、`<输入项类型>`、`input_image:file_id`、`reasoning:orphan`），只给测试与排查，不进日志。

### 4.2 流式响应：Chat → Responses 事件

事件形状以 Codex 的解析为准（`codex-api/src/sse/responses.rs`）：历史与工具调用只取 `response.output_item.done`；增量之前要有同一 `item_id` 的 `output_item.added`；`response.completed` 要有字符串 `response.id`，`usage` 有就要有三个 token 数；每条 SSE 带 `event:` 行（Codex 只看 data）。

| Chat（上游） | Responses（发给 Codex） |
|---|---|
| 收到 2xx | `response.created {response: {id: resp_wevir_<随机>, status: in_progress}}` |
| `delta.reasoning_content`、`delta.reasoning` 或 `delta.reasoning_details[]` 的 `text` / `summary` | 按这个顺序取第一种非空文本，同一个 chunk 不重复显示别名（阶跃同时给前两个字段）。第一片：`output_item.added {type: reasoning, id, summary: []}`；每片：`response.reasoning_text.delta {item_id, output_index, content_index: 0, delta}`；结束：`output_item.done {type: reasoning, summary: [], content: [{type: reasoning_text, text: 全文}], encrypted_content: wevir-gw:v1:<base64 全文>}`（Codex 带回时 content 与 encrypted_content 都可能只剩一个，两处都放全文） |
| MiniMax 的 `content` 以 `<think>` 开头（允许前导空白，标签可跨 chunk） | 拆成推理与回答供 Codex 显示；保留完整原始 content，下一步原样回传。其他格式不解析正文里的标签，代码示例里的 `<think>` 原样显示。回传元数据见下文 |
| `delta.content` | 推理项先提交；`output_item.added {type: message, role: assistant, content: []}` → `response.output_text.delta` → `output_item.done {content: [{type: output_text, text}]}` |
| `delta.tool_calls[]` | 文本与推理先提交，分片按调用累积：按 `index` 归属（并行调用的分片可以交错）；带 `id` 的先按 `id` 找，同一个 `index` 来了另一个 `id` 时另开一个调用（有的上游每个调用都用 index 0）；既没有 `index` 也没有 `id` 的接到上一个调用；名字只在第一片或每片重复都行。流结束时**按 index 的顺序**提交：按 §4.3 的登记还原成 `custom_tool_call {call_id, name, namespace?, input}`（从 `{"input"}` 里取，取不到时原样）或 `function_call {call_id, name, namespace?, arguments}`；模型编的名字原样交给 Codex，由 Codex 报未知工具。上游没给 `id` 时网关补 `call_<随机>` |
| `finish_reason: stop` / `tool_calls` / 其他，或只有 `[DONE]` | 提交还开着的项与工具调用，然后 `response.completed {response: {id, status: completed, output: [全部已提交的项], usage?}}` |
| `finish_reason: length` | 已出的文本与推理照常提交，**截断的工具调用不提交**（参数多半不完整），然后 `response.incomplete {response: {incomplete_details: {reason: max_output_tokens}}}` |
| `finish_reason: content_filter` | 同上，`reason: content_filter` |
| `usage`（最后一个 chunk，`choices: []`） | `input_tokens` = `prompt_tokens`；`input_tokens_details.cached_tokens` = `prompt_tokens_details.cached_tokens`，没有时取 DeepSeek 的 `prompt_cache_hit_tokens`；`output_tokens` = `completion_tokens`；`output_tokens_details.reasoning_tokens` = `completion_tokens_details.reasoning_tokens`；`total_tokens`，没有时相加。上游没给 usage 时不带 `usage`（不填 0，免得上下文用量失真）。Codex 用它算上下文用量与自动压缩（窗口取 Provider 模型的 `contextWindow`，没填按 128k，codex-event-mapping.md §3、§4.9） |
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

`ProviderConfig.compat` 里网关读的开关，都属于 Host 协议 `ProviderCompat`，可经 `provider.upsert` 设置。`supportsCustomTools` / `systemMessageMode` 从 0.4.0 起，`supportsNamespaceTools` / `toolChoice` 从 0.12.0 起；这些网关专用开关 dsh 接受但不检查、不写进 overlay（ADR-0005 补记 7、12）。取值由协议 schema 与网关 `validateProvider` 检查。

`providers.ts` 的 `effectiveCompat` 按每个字段取值：**Provider 显式 compat > 地址默认 > 全局默认**（undefined 视为没写）。`PROVIDER_COMPAT_DEFAULTS` 是地址识别表；经代理地址认不出时必须显式设开关。全局 supportsCustomTools / supportsNamespaceTools 为 true，toolChoice 为 any。现有 Chat 的 maxTokensField、DeepSeek reasoning_content 与 Gemini 签名判断保持原有规则。

| 地址识别 | 默认 compat | 依据 |
|---|---|---|
| `isXaiHost`：`x.ai` 及子域 | `supportsCustomTools: false`、`supportsNamespaceTools: false` | §3.2 |
| `isBailianHost`：`dashscope.aliyuncs.com`、`dashscope-intl.aliyuncs.com`、`*.maas.aliyuncs.com`（排除 coding / token-plan 套餐域名） | `supportsCustomTools: false`、`supportsNamespaceTools: false`、`toolChoice: auto_only` | §3.4；未有真实 Key，保守默认 |
| `isDeepSeekHost`：`deepseek.com` 及子域的 Responses / Chat，含固定地址的 deepseek-official | `toolChoice: auto_only` | §3.6；Responses 两模型已实测思考时 required / 具名 400；Messages 保持原选择 |
| `isOllamaHost`：回环主机的 11434 端口或精确 HTTPS ollama.com，仅 Responses | `supportsCustomTools: false`、`toolChoice: auto_only`；Cloud 另有 `supportsNamespaceTools: false` | §3.7；本机 namespace 保留，Cloud 保守摊平 |
| `isKimiHost`：moonshot.cn / moonshot.ai 及子域，仅 Responses | `toolChoice: auto_only`；custom 与 namespace 保持支持 | §3.8；Kimi Code 域名不匹配 |

| 开关 | 用于 | 含义 | 默认 |
|---|---|---|---|
| `supportsCustomTools` | Responses 透传 | `false`：上游不支持 `custom` 工具，打开 §3.2 的 `flatten-custom-tools` | `true`；xAI、百炼按量与 Ollama 地址为 `false` |
| `supportsNamespaceTools` | Responses 透传 | `false`：打开 §3.2 的 `flatten-namespace-tools`；Chat / Messages 始终摊平 | `true`；xAI、百炼按量与 Ollama Cloud 地址为 `false` |
| `toolChoice` | 三种处理方式 | `any` 保持原有选择；`auto_only` 按 §3.2 限制到 auto（none 只去掉 tool_choice、保留 tools）。这不是禁止工具调用的保证。Messages 未声明时还按模型限制 forced choice（§5.1） | `any`；百炼按量、DeepSeek Responses / Chat、Ollama 与 Kimi Responses 为 `auto_only`；Messages 的模型默认见 §5.1 |
| `systemMessageMode` | Chat、Messages 转换 | Chat：`inline` 原位转 system；`merge` 全部并进开头的一条 system；`user` 开头连续的并成一条 system，之后的转成注明应用来源的 user 消息。Messages：当前四款 Claude 的 `inline` 在 user 输入之后追加 system（§5.1），旧模型仍按 user；merge 会改变顶层前缀 | Chat 为 `inline`；Messages 按 §5.1 的地址与模型判断 |
| `supportsDeveloperRole` | Chat 转换 | `true` 且 `inline` 时 developer 消息保持 developer 角色 | system |
| `maxTokensField` | Chat 转换 | `max_output_tokens` 写成哪个字段 | 见 §4.1 |
| `requiresReasoningContentOnAssistantMessages` | Chat 转换 | 每条 assistant 都带 `reasoning_content`，没有推理时补空串；false 只停止补空串，已有推理仍带回 | `deepseek` / `zai` / `minimax` / `tencent` 格式、Kimi 模型或 DeepSeek 地址为 true，其他 false；显式值优先 |
| `thinkingFormat` | Chat、Messages 转换 | Chat 读下表的六种格式；Messages 读 `adaptive` / `enabled`（§5.4）。仍是 optional string，不收窄协议类型 | Chat 的 DeepSeek 地址默认 `deepseek`；其他未设时沿用旧规则（非 none 的 effort 发 reasoning_effort）。Messages 见 §5.4 |
| `geminiToolSchema` | Chat 转换 | `true`：递归去掉工具参数 Schema 的 `additionalProperties`，空对象补一个可省略的占位参数（§4.5）。只影响工具定义，不清洗结构化输出 | 省略或 false 都关闭，Gemini 官方地址也不自动开启；协议 0.26.0，dsh 忽略 |

**Chat 的思考格式（2026-10-15 核对）。** 同名的 `openai` / `deepseek` / `qwen` / `zai` 沿用 dsh 所用 pi-ai 1.1.0 的参数位置与开关语义；网关另处理模型限制与推理回传。`minimax` / `tencent` 是网关扩展，当前只用于 Codex，不能直接写进 dsh 的 pi-ai overlay。未实现的 pi-ai 格式仍接受保存，Chat 按旧规则发送，不能当成已支持的方言。本次不更新任何服务模板，也不迁移已存 Provider。

| thinkingFormat | 非 none 的 effort | none 与不能关闭的模型 |
|---|---|---|
| `openai` | 顶层 `reasoning_effort`；阶跃使用同一格式，`minimal`→low、`xhigh` / max→high；`step-3.5-flash-2603` 的 medium→high | 显式 openai 发 `reasoning_effort: none`（Ollama 的兼容端点认它）；阶跃改 low。未设格式的旧 Provider 仍省略 none |
| `deepseek` | `thinking: {type: enabled}` + `reasoning_effort`；minimal→low，medium / xhigh→high，low / high / max 保持。Kimi K2.6 改发 `thinking: {type: enabled, keep: all}`，不发 effort；K2.7-code 按官方指南省略 thinking 与 effort；K3 只发 low / high / max 的 effort，不发 thinking（medium / xhigh→high） | DeepSeek / K2.6 发 `thinking: {type: disabled}`；K3 改 low；K2.7-code 省略开关与 effort，保留强制思考 |
| `qwen` | `enable_thinking: true`、`preserve_thinking: true` 与 `thinking_budget`：minimal 1024、low 4096、medium 8192、high 16384、xhigh / max 32768。这是 Wevir 的预算映射，不是厂商的力度枚举。Kimi K3 只发 effort，不发预算 | `enable_thinking: false`；模型目录声明了非空档位且不含 off 时降到声明的最低档；Kimi K3 改 low |
| `zai` | `thinking: {type: enabled, clear_thinking: false}` + 顶层 `reasoning_effort`。GLM-5.3 系列 minimal→low、medium / xhigh→high；其他模型 effort 原样（GLM-5.2 由上游按文档映射） | 发 `thinking: {type: disabled}`，不发 effort；GLM-5.3 系列强制思考，改 enabled + low |
| `minimax` | 始终 `reasoning_split: true`；发 `thinking: {type: adaptive}`。M3.1 的 effort 原样（minimal→low）；M3 / M2.x 不发无效的 effort | M3 发 disabled；M3.1 改 adaptive + low；M2.x 省略关闭参数，保留强制思考 |
| `tencent` | `thinking: {type: enabled}` + 顶层 `reasoning_effort`（minimal→low、xhigh / max→high）；不只给 budget_tokens，避免缺 type 的 400 | `thinking: {type: disabled}`；托管的 GLM-5.3 / Kimi K3 改 enabled + low，K2.7-code 省略关闭参数 |

此外，Provider 的 `models[].reasoningEfforts` 非空且没有 off 时，none 取目录中最小的有效档；空数组与未声明不据此推断能力。没有 effort 时不发思考控制（MiniMax 仍发输出格式 reasoning_split）。只收 auto 的服务显式设 `toolChoice: auto_only`，复用已有规则；思考格式不擅自改工具选择，也不为订阅套餐的域名加默认值。

**推理回传元数据。** `reasoning_details` 不只取文本：其 id、format、index、签名与未知字段也保留。流中同一文本 / summary 块的连续分片合并，其他块原样保留。流结束、工具调用提交前，另提交一个没有可显示文本的 reasoning 项，`encrypted_content = wevir-gw:chat:v1:<base64(JSON)>`，内容是 `{provider, model, format, reasoning_details?, content?}`；content 只在 MiniMax 实际给了前缀 `<think>` 时保存。请求方向只为同一个 Provider、模型与格式恢复这些字段，普通推理仍从明文或旧的 wevir-gw:v1 信封读出。不跨模型带回签名，也不把正文中的字面标签重新包装。

来源：[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode)、[百炼深度思考](https://help.aliyun.com/zh/model-studio/deep-thinking)、[Z.ai 思考模式](https://docs.z.ai/guides/capabilities/thinking-mode)、[Z.ai Chat 参数](https://docs.z.ai/api-reference/llm/chat-completion)、[Kimi 思考模型](https://platform.kimi.com/docs/guide/use-thinking-models.md)、[MiniMax Chat 参数](https://platform.minimax.io/docs/api-reference/text-openai-api)、[MiniMax 工具指南](https://platform.minimax.cn/docs/guides/text-m3-function-call)、[阶跃工具调用](https://platform.stepfun.com/docs/zh/api-reference/tool-call.md)、[Ollama OpenAI 兼容](https://docs.ollama.com/api/openai-compatibility)、[TokenHub Chat 字段](https://intl.cloud.tencent.com/zh/document/product/1300/82345)。MiniMax 两页仍分别写 reasoning_content 与 reasoning_details，网关兼容两者，实际按量端点返回哪一种待真实 Key 验证；Ollama 当前已列 tool_choice 支持，不自动删除它。

### 4.5 Gemini API Key 的 Chat 方言

Gemini API 没有 Responses，按 ADR-0005 决策 2.3 走它的 OpenAI 兼容端点（`https://generativelanguage.googleapis.com/v1beta/openai/`，`api: openai-completions`）。Gemini 3 起，函数调用的多轮对话**必须**带回模型给的 thought signature：当前回合（从最近一条带文本的用户消息算起）里每一步的第一个函数调用缺签名就是 400（`Function call is missing a thought_signature in functionCall parts…`），并行调用只有第一个带签名（ai.google.dev 的 thought-signatures 页，2026-10-13）。兼容端点上签名在 `tool_calls[i].extra_content.google.thought_signature`，回传时放回同一个位置。网关按地址（`isGeminiHost`：主机名是 `generativelanguage.googleapis.com`）或 Vertex 的 Chat 路由处理，做法与 §5.3 的思考信封相同：

- **响应**（`ChatStreamTranslator` 的 `signatures` 选项）：工具调用分片里的签名记在调用上；流结束提交调用时，在这些调用之前先提交一个 reasoning 项（只有 `output_item.done`，没有 `content` 与 `summary`），`encrypted_content` 是 `wevir-gw:gemini:v1:` 加 `{provider, model, signatures: {<call_id>: <签名>}}` 的 base64。没有签名就不加这一项。Gemini 的流式工具调用一个 chunk 给全、没有 `index`，带工具调用时 `finish_reason` 是 `stop`（python-genai#2868），§4.2 的规则本来就能处理。
- **请求**：历史里的这种 reasoning 项不变成 `reasoning_content`（Gemini 不认这个字段），只把签名挂回同一 `call_id` 的工具调用；Provider 或模型与信封里的不同（换过模型）就不带（`dropped` 记 `reasoning:foreign_signature`）。最后每条带工具调用的 assistant 消息，第一个调用还没有签名的（换过模型、网关之外来的历史、上游当时没给）填文档给的占位值 `skip_thought_signature_validator`（`dropped` 记 `signature:placeholder`）；文档说它会降低效果，只是让请求不被拒。
- **思考**：网关照 §4.1 发 `reasoning_effort`（兼容端点把它映射成 Gemini 3 的 `thinking_level`、2.5 的 `thinking_budget`），不发 `extra_body.google.thinking_config.include_thoughts`，所以 Gemini 不返回思考内容，界面上没有推理（兼容端点把思考包在 content 的 `<thought>` 标签里返回，要拆开才能用，没做）。模型目录里的档位只列它认的（3.8 Flash、4 Argon 不认 `minimal`），见国内服务模板。

**2026-10-15 复核。** 仅 Gemini 官方地址、未显式设置 `thinkingFormat` 时，把 `minimal` 降为 `low`；`none` 仍省略，保留服务默认思考。其他地址与显式格式保持自己的规则，Vertex 沿用 §2 的映射。不同时发送 `reasoning_effort` 与 `extra_body.google.thinking_config`。官方兼容表仍泛称 Gemini 3 Flash 支持 minimal，但 [3.8 Flash 模型页](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)明确写出 minimal 会报错，以型号文档为准。

同一步的所有调用合在一条 assistant 消息，之后连续排放所有 tool 结果；工具返回的图片在整批结果之后另放 user 消息。流式签名可以在空文本、只有签名的最后一个工具分片里到达，不能因文本为空或参数已完整就收尾；仍读到 finish_reason / [DONE] 或流结束后才提交调用与签名信封。同一回合的下一步保留每一步自己的签名，不能拿最近的签名覆盖前一步。

工具 Schema 是否拒收 `additionalProperties` 或空对象尚无真实服务证据。可选 `compat.geminiToolSchema: true` 是默认关闭的兼容办法：只遍历 Schema 的子结构，保留同名业务属性与 enum / default 等数据；删掉 `additionalProperties`（会放宽对象约束），空对象的 properties 补 `_wevir_unused: {type: boolean}`，该参数可省略。开关只在 Chat 转换生效，经代理也可显式开启；模板不预启用，也不自动迁移已有 Provider。确实遇到相应 400 再启用，真实验收前不据此声称 Gemini 必须清洗 Schema。

来源：[OpenAI 兼容](https://ai.google.dev/gemini-api/docs/openai)、[思考档位](https://ai.google.dev/gemini-api/docs/thinking)、[工具签名与顺序](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)（旧 thought-signatures 链接现已移到以 Interactions 为主的 Thinking guide，Chat 的细节在 generate-content 文档）。

2026-10-15 没有 `WEVIR_TEST_API_KEY`：3.8 Flash / 3.1 Pro Preview / 4 Argon 的契约第 3 层与桌面 apply_patch 均未验收。AI Studio auth key 的 Bearer 认证、占位签名、Schema 两项与对话中间的 system（默认 inline）仍待真实服务验证。表单和 provider.test 不按 Key 前缀校验；连接探测没有工具，不能证明签名或 Schema 可用。官方 FAQ 的空文本签名例子针对无函数调用的响应；当前信封只保存工具调用签名，纯文本末片签名尚未映射，需真实 Chat 样本再核对，不把工具末片测试当作这项已验收。

## 5. Anthropic Messages 转换

`api: anthropic-messages` 的 Provider（ADR-0005 决策 2.3）。请求与流的形状以 Anthropic Messages API 的当前文档为准（流式事件、工具使用、思考与签名、错误）；做法参考 LiteLLM 的 Responses → Anthropic 转换（思考块签名放进 `encrypted_content` 带回，codex-notes §3.5），代码是自己写的。工具摊平与 Chat 转换是同一套规则（§4.3）。DeepSeek 的 Anthropic 端点（`https://api.deepseek.com/anthropic`）是真实模型测试的上游之一（§9）。

**2026-10-15 官方限制核对。** 模型限制只用于 Anthropic 官方地址 `api.anthropic.com`，或显式设置 `compat.thinkingFormat: adaptive` 的 Claude 模型（代理可用；不为其他兼容服务套用 Claude 限制）。采样参数按 `claude-<系列>-<版本>` 的 4.7 及以后版本去掉；forced choice 与关闭思考按下文列出的四个当前模型判断，不推测未来模型。显式 `toolChoice`、`systemMessageMode`、`thinkingFormat` 优先于默认值。模板声明 adaptive 与 inline，已有 Provider 不自动改写。

来源：[模型目录](https://platform.claude.com/docs/en/models/overview)、[思考与兼容限制](https://platform.claude.com/docs/en/build-with-claude/thinking)、[effort](https://platform.claude.com/docs/en/build-with-claude/effort)、[中途 system 的位置规则](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)、[思考前缀校验](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)。认证仍用官方支持的 legacy `x-api-key`，不影响其他 Messages 兼容服务；未实现 `anthropic-workspace-id`，只能使用绑定单个 workspace 的 Key（[认证文档](https://platform.claude.com/docs/en/manage-claude/authentication)）。

### 5.1 请求：Responses → Messages

| Responses（Codex 发的） | Messages（发给上游的） |
|---|---|
| `model` | `model`（原样） |
| `input` 是字符串 | 一条 user 消息 |
| `instructions`（Codex 不发） | 顶层 `system` 的第一段 |
| 开头连续的 `message` role `developer` / `system`（基础提示词、skills） | 顶层 `system`：每条一个 text 块，最后一块带 `cache_control`（§5.5） |
| 对话中间的 `developer` / `system`（权限变化等，样本 `3-next-turn`） | 官方地址的 Opus 5.5、Sonnet 5.5、Haiku 5.5、Fable 5.1 默认 inline：在这一段 user 输入（含全部 tool_result）之后、下一条 assistant 之前追加 `role: system`；也可以是末条消息。不插在 tool_use 与 tool_result 之间。代理需显式 `compat.systemMessageMode: inline`；旧模型仍转成注明应用来源的 user text。显式 user 保持原有转换，merge 并进顶层 system。若中途指令后没有可接的 user 输入，回退为注明来源的 user 消息，避免非法 system 位置。顶层 system 与已有历史保持不变 |
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
| `tool_choice`：`auto` / `none` / `required` / `{type: function \| custom, name}` | `auto` 是默认，不发；`none` → `{type: none}`；`required` → `{type: any}`；指定工具 → `{type: tool, name: 摊平后的名字}`。Opus 5.5、Sonnet 5.5、Fable 5.1 的 required / 具名改 auto（不改变 none）；Haiku 5.5 与旧模型保持原映射。显式 compat.toolChoice 优先（auto_only 的 none 规则同 §3.2），仅有历史工具的占位工具仍禁止调用 |
| `parallel_tool_calls: false` | `tool_choice` 带 `disable_parallel_tool_use: true`；`true`（Codex 的默认）不发 |
| `max_output_tokens`（Codex 不发，testProvider 发） | `max_tokens`（Messages 必填）；没有时取 Provider 里这个模型的 `models[].maxTokens`，再没有用 32000（§5.4） |
| `reasoning.effort` / `reasoning.summary` | `thinking` 与 `output_config.effort`（§5.4） |
| `temperature`、`top_p` | 符合上述地址或格式条件、版本 4.7 及以后的 Claude 一律不发（默认 top_p 是 0.99，1 也会 400，同时发两个默认值也会 400）；旧模型与其他 Messages 服务仍原样 |
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

各家的思考开关写法不同（Anthropic 4.6 起是 `adaptive`，4.7 起拒收 `enabled`；更早的 Claude 只认 `enabled` + `budget_tokens`；DeepSeek 认 `enabled` / `disabled`、忽略 `budget_tokens`，档位放在 `output_config.effort`，见 dsh 的 llm-deepseek）。网关按 Codex 发的 `reasoning` 与 Provider 的 `compat.thinkingFormat`（协议里已有的字段；Chat 用法见 §4.4；`anthropic-messages` 上只接受下面两个值，`validateProvider` 检查）：

| `reasoning.effort` | 发给上游的 |
|---|---|
| 没有 | 当前四款 Claude 显式发 `output_config.effort`：Opus 5.5 / Haiku 5.5 为 medium，Sonnet 5.5 / Fable 5.1 为 high；thinking 保持上游默认。其他模型不发思考参数 |
| `none` | 当前四款显式 low：Opus 5.5 / Fable 5.1 保留 adaptive（不能关），Sonnet 5.5 用 `thinking: {type: between_tools}`（仅关前置思考），Haiku 5.5 用 disabled。between_tools / Haiku disabled 配 low 保证在 high 及以下；模板仍只列五档思考，不列 off。旧模型与其他兼容服务仍发 disabled |
| 其他 | `output_config: {effort}`（`minimal` 写成 `low`，其余原样，Anthropic 认 `low` / `medium` / `high` / `xhigh` / `max`），加上按 `thinkingFormat`：`adaptive` → `thinking: {type: adaptive}`，`reasoning.summary` 不是 `none` 时加 `display: summarized`（4.7 起默认 `omitted`，思考文本是空的）；`enabled` → `thinking: {type: enabled, budget_tokens}`，`budget_tokens` 按档位取 `minimal` 1024、`low` 4000、`medium` 10000、`high` 16000、`xhigh` / `max` 31999，不超过 `max_tokens - 1`；`max_tokens` 不到 1025 时不开思考（Anthropic 要求 `budget_tokens` ≥ 1024 且小于 `max_tokens`） |

`thinkingFormat` 没设时：模型 ID 以 `claude-` 开头用 `adaptive`，其余用 `enabled`（兼容服务多是照 Claude Code 对非 Claude 模型名的发法做的，DeepSeek 实际就是 dsh 发的 `enabled`）。Claude 4.5 及更早的模型要设 `thinkingFormat: enabled`；它们中的 Sonnet 4.5、Haiku 4.5 不认 `output_config.effort`，目前没有开关去掉它（§10）。

`max_tokens` 是 Messages 的必填项（思考 token 也算在里面）：Codex 不发 `max_output_tokens`，所以取 Provider 里这个模型的 `models[].maxTokens`（Provider 配置就是网关能看到的模型目录），没写时用 32000（Claude Code 的默认输出上限；当前的 Claude 都是 64K 以上）。上游的上限更低时要在 `models[].maxTokens` 里写明，否则上游回 400。

### 5.5 提示词缓存

Anthropic 官方只缓存显式标注的前缀。网关放两个断点：顶层 `system` 的最后一块（`tools` 在 `system` 之前，一起缓存），与最后一条消息的最后一块（整段历史；下一个请求在 20 个块的回看范围内找到上一次的断点）。DeepSeek 的文档写明忽略 `cache_control`。缓存读写的 token 按 §5.2 映射给 Codex。

官方最多允许四个显式断点，网关仍只放两个；中途 system 可以带断点。思考文本、签名与 redacted data 仍原样带回。新账号会检查思考块之前的 system / tools / messages 前缀：请求只能追加；缓存标记不在校验范围。Codex 手动压缩、工具目录变化或会话内换模型可能重写前缀，当前没有服务端压缩或工具变更机制兜底，仍须真实服务验证（§10）。

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

Chat 上游收到的是 `{model, messages: [{role: user, content: ping}], stream: true, stream_options: {include_usage: true}, max_tokens: 16}`（字段名按 compat）；Messages 上游收到的是 `{model, max_tokens: 16, messages: [{role: user, content: [{type: text, text: ping, cache_control}]}], stream: true}`，没有 `reasoning` 时不显式设置 thinking；当前 Claude 另发各型号默认的 `output_config.effort`（§5.4），上游可能仍默认开启思考。读处理后的 Responses 事件，跳过 `response.created` / `response.in_progress`（Chat 转换时它是网关自己发的；透传时上游也是先发它，之后才可能是 `response.failed`），第一条别的 `response.*` 事件就算成功，`latencyMs` 是从发出请求到这一刻；然后断开，不让模型继续生成。时限 20 s，不跟随重定向。

失败归类与 adapter-dsh 的口径相同（providers.md §6.2，代码是复制的：网关不能依赖 adapter-dsh）：没有 Key → `missing_key`（不发请求）；配置不完整 → `unknown`；401 / 403 → `auth`；429 → `rate_limited`；5xx → `server`；原文提到模型不存在 → `model_not_found`；其余 404 / 405、400 / 422 → `protocol`；连不上 → `network`；超时 → `timeout`；200 但是网页、或不是 Responses 事件、或 Messages 转换发现流不是 Messages 格式（`upstream_protocol_error`）→ `protocol`；200 但第一条是 `response.failed` / `error` 事件（Chat 转换时就是上游流里的错误）→ 按原文归为 `model_not_found` / `auth` / `unknown`。消息里的 Key 换成 `***`。

与 adapter-dsh 的差别：`deepseek-official` 走 DeepSeek 的 Responses 端点，而不是 dsh 用的 Anthropic Messages；`openai-responses` 的探测请求是 message 项的数组，不是字符串；adapter-dsh 不支持 `anthropic-messages`，网关支持（`max_tokens: 16`，dsh 对 DeepSeek 的 Messages 探测是 `max_tokens: 1` 加 `thinking: disabled`）。Ollama Responses 端点的非模型 404 仍是 protocol，另带 error.code: ollama_responses_unavailable（协议 0.31.0），桌面端据此提示升级 Ollama 或切换 Chat；缺模型的 404 不改。

## 8. 日志口径

每个到达路由的请求结束时一行 `info`（`msg: "gateway request"`），字段**只有**：`method`、`providerId`、`outcome`、`durationMs`，另按情况有 `upstreamStatus`（上游的状态码）、`status`（网关自己回的状态码）、`error`（连不上上游时的错误码，如 `ECONNREFUSED`，不记带地址的原文）。`outcome` 取值：`completed`、`client_closed`（Codex 断开或网关关闭，正常）、`upstream_error`（上游非 2xx）、`auth_error`（服务账号交换失败，401）、`network_error`、`rejected`（§2 里网关自己回的 4xx）。令牌不对是一行 `warn`（`gateway request rejected`，`method` 与 `status: 401`）。网关内部异常是 `warn`（`gateway internal error`）。

不记请求体、响应体、上游错误原文、任何 Key 与令牌（集成测试核对：日志里没有 Key、令牌、模型的推理与回答、思考块的签名、请求里的文本）。三种处理方式同一口径。

## 9. 测试与样本

| 层 | 文件 | 内容 |
|---|---|---|
| 单元 | `chat/request.test.ts`、`chat/response.test.ts`、`messages/request.test.ts`、`messages/response.test.ts`、`tools.test.ts`、`dialects.test.ts`、`sse.test.ts`、`errors.test.ts`、`providers.test.ts` | §3、§4、§5 的每一项（Chat 思考格式另在 `chat/thinking.test.ts` 覆盖六种格式、none、模型限制、推理别名、标签的全部分片边界与回传信封；通用方言加：录制样本下 toolChoice / namespace 开关、声明覆盖地址默认与 null 加密推理；R8 加：`content: null` 的推理项、xAI 地址的两条摊平与相反顺序的还原、Gemini 签名信封的往返、换模型与缺签名时的占位值）：录制样本的转换（快照在 `src/__snapshots__/codex-requests/*.chat.json` 与 `*.messages.json`）、对话中间的 developer 消息各模式、图片、工具输出里的图片、孤立的推理、长名字与撞名、length / content_filter、流中的错误与提前断开、交错的并行调用、没有 index 的上游、整段 JSON；Messages 另有思考信封的往返与不带回的各种情况、不合规则的 call_id、占位工具、思考开关与 `max_tokens` 的取值、redacted_thinking、相邻 text 块合并、各 stop_reason、usage 的缓存读写；每个事件序列都过一遍 `codexProblems`（按 Codex 的解析规则检查） |
| 集成 | `gateway.integration.test.ts`、`compat.integration.test.ts`、`chat-thinking.integration.test.ts`、`provider-test.integration.test.ts`、`gemini.integration.test.ts` | Gemini：拒收 minimal、错误签名与交错结果的 mock，同回合两步工具调用保留各步签名；Schema 默认拒收与显式清洗后通过，Key 前缀不拦截；Chat 思考格式：拒收缺 reasoning_content 的 mock、MiniMax 原始正文与 reasoning_details 的两步回传；通用方言：拒收非 auto / namespace / null 加密推理的 mock，原始请求 400、开关改写后 200，与响应的工具类型 / 命名空间还原；真实 HTTP：令牌、路由、透传（请求体只少 `client_metadata`、请求头白名单、Key 替换）、deepseek-official、两条方言修正、gzip、Chat 转换（apply_patch 与 namespace 往返、交错的并行调用、incomplete、failed）、Messages 转换（请求头、工具调用与跨回合思考的三步往返、不给签名的上游、压缩请求、incomplete、failed、Anthropic 风格的错误正文）、上游错误（状态码与正文、Key 遮掉）、502、Codex 断开时中断上游（三种处理方式）、`setProviders` 不影响进行中的请求、`close()`、日志口径；testProvider 的成功与每种失败（三种处理方式）。Messages 的 mock（`test-fixtures/mock-messages.ts`）按 Anthropic 的结构规则检查请求，不合规则就回 400：`max_tokens`、`budget_tokens`、角色交替、空文本、思考块的签名（对原文哈希，改了就对不上）、`tool_result` 紧跟且排在最前、有工具调用就必须定义工具、名字与 id 的字符 |
| 真实模型（可选） | `gateway.real.integration.test.ts` | `WEVIR_TEST_API_KEY` + `WEVIR_TEST_PROVIDER=deepseek`（或 `deepseek-official`）时，DeepSeek 的透传、Chat 转换与 Messages 转换（`https://api.deepseek.com/anthropic`）各一次最小对话、testProvider、工具与跨回合思考（三个请求，打印推理项与 Messages 签名数量）；另对 Responses 的 required / 具名选择做显式 any 的 400 与默认修正后的 200 对照。模型默认 `deepseek-flash`，`WEVIR_TEST_MODEL` 可改。2026-10-16 两个模型各 11 项通过。没有 Key 时跳过并打印原因 |
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

- Kimi：2026-10-17 官方 Responses 文档只支持 kimi-k3，模板不列 K2.7-code / K2.6；不新增 Chat / Messages 模板，不接 Kimi Code 会员端点。缺 WEVIR_TEST_API_KEY，K3 真实契约与桌面 apply_patch 尚未验收。非 data URL 图片会丢掉，不下载外部资源；代理地址需自行满足此限制。服务默认输出 131072，目录 maxTokens 不改变透传预算；完整推理回放与缓存字段仍需真实服务核对。见 §3.8、providers.md §7.3。

- Ollama：本机未安装服务与模型，真实契约第 3 层及桌面 apply_patch 未验收；Cloud 没有真实 Key，namespace 采用保守摊平。发现只列前 64 个模型，详情失败时不猜实际上下文与推理档位；未知自定义思考枚举不映射。会话提醒只针对标准回环 11434 或 local-ollama 模板 ID，其他端口可在表单中读取、核对；发现不会自动修改已存目录。见 §3.7、providers.md §7.5。

**P0a 对锁定 Codex 的输入项核实（2026-10-15，rust-v0.162.1 / `092d3ac`）：** 下列 Codex 路径相对 `upstream/codex/codex-rs/`；Wevir 适配器路径相对 `packages/`。

- `additional_tools` 只在模型元数据 `use_responses_lite = true` 时发：`core/src/client.rs:915–932` 把工具目录写进该输入项；增量工具的 `core/src/session/world_state.rs:44–55,143–147` / `context/world_state/top_level_tools.rs:135` 也受此门控。Wevir 的 `adapter-codex/src/config.ts::catalogEntry` 不设置这个字段，`protocol/src/openai_models.rs:482–489` 的 serde 默认是 false；模型目录按 slug 整条读取，不继承官方 GPT 的元数据（`models-manager/src/manager.rs:461–478`），因此 GPT-5.6+ 的名称也不会自动打开。三条网关路都不会遇到它，本次不加转换或伪造样本。
- `configuration_update` 需要 `core/src/client.rs:556–559` 的三重条件：开 reasoning-effort override、Provider `is_openai()`、模型 `supports_reasoning_effort_updates`。Wevir Provider 名称是 `Wevir/<显示名>`，不属于 OpenAI，目录也不设置后者（serde 默认 false）。`client.rs:902–906` 还会从请求副本中过滤旧历史里的该项。实际推理档位仍由每次 `turn/start` 的 effort 与请求顶层 reasoning 传递，Chat / Messages 已有对应（§4.1、§5.4）。
- `collaboration` 是 multi-agent V2 的默认 namespace（`core/src/config/mod.rs:262,1614–1632`、`tools/spec_plan.rs:1374–1390`），并非看模型名称前缀就开启。Wevir 目录不设置 `multi_agent_version`、配置不覆盖，按 Collab feature 取 V1，因此是已录制的 `multi_agent_v1`。ChatGPT 进程用官方目录，但不经模型网关；本任务不改变它。
- 自定义模型目录声明 `apply_patch_tool_type: freeform`，只有 `tools/handlers/apply_patch_spec.rs` 的 apply_patch custom 工具。其他 freeform（`tools/code_mode/execute_spec.rs`）要求 CodeMode / CodeModeOnly；目录不设置 `tool_mode`，`tools/mod.rs:76–85` 回落到 feature，这两个在 `features/src/lib.rs` 默认 false。因此不用“只支持 apply_patch”的新开关。
- `ResponseItem::Reasoning`（`protocol/src/models.rs:1051–1063,1626–1632`）会保留明文 reasoning_text 与 summary；缺失的 content 可能序列化成 null，缺失或 null 的 encrypted_content 一定序列化成 null（现有录制样本 2-tool-results、3-next-turn、4-compact 已包含它，无需另造样本）。§3.2 分别清理两个 null 键，保留明文与 summary，不改响应字节或非空加密内容。

Codex 升级时重查上述字段默认值、Provider 判定与触发条件；一旦 Wevir 配置能发 additional_tools / configuration_update，就要先录真实样本，并把工具并入 tools、将最后的推理档位反映到 Chat / Messages，再启用相应元数据。


- Google Cloud Vertex：本地实现服务账号、Gemini Chat 与 Claude Messages 变体，尚缺 GCP 项目与真实服务账号，两个模型的契约第 3 层与桌面工具对话未验收。不读取 ADC / gcloud，不接 express Key、Gemini 原生 API 或其他发布方。Claude 的 URL 图片、30 MB、地域可用性限制见 §2 与 providers.md §7.11。
- Azure：缺 WEVIR_TEST_API_KEY、资源端点与部署名，Bearer Key 认证、Responses / Claude 的契约第 3 层和桌面 apply_patch 均未验收。大陆直连情况未确认；不接 Entra ID、Azure 中国、旧 deployments + api-version 路径或 /api/projects 路由。自定义 Claude 部署别名的型号识别局限见 §3.5。
- DeepSeek：2026-10-16 两个模型的三条网关路由各 11 项、Codex 契约第 3 层各 23 项通过；桌面官方 Flash / high 与 Chat V4 Pro / low 均完成 apply_patch，详见 providers.md §7.1。Responses 的默认输出上限与长回答截断仍未实测，目录 maxTokens 不会解除它；auto_only 不能保证禁止调用。旧 Profile 不迁移，手动更新见同节。
- Gemini：未提供 WEVIR_TEST_API_KEY，3.8 Flash / 3.1 Pro Preview / 4 Argon 的真实契约与桌面工具对话未验收；Schema 清洗默认关闭，占位签名、Schema 与中途 system 仍待实测（§4.5）。不接 Interactions 或原生 generateContent；思考内容不返回、不显示。
- 阿里云百炼：缺 WEVIR_TEST_API_KEY，Qwen3.8 Max / Flash 的契约第 3 层与桌面 apply_patch 未验收；custom、namespace 与非 auto 选择的真实支持待探测，当前为保守默认（§3.4）。Responses 文档说明输入约限窗口的 80% 且会自动截断；未从官方确认最大输出，模板不填 maxTokens。旧 Provider 不迁移，手动修改见 providers.md §7.2。只接按量 Responses，不接订阅套餐、托管第三方模型模板或 Anthropic 端点。
- DeepSeek 的历史 Spike 见 codex-notes §7.3；2026-10-16 本包已用两个当前模型跑通三条路，替代原来仅有 mock 的验收状态。其他服务的推理带回、自定义工具与 namespace 仍须逐家真实验证。xAI、Gemini 的方言依据与验收边界见 §3.2、§4.5，不能从 DeepSeek 的通过结果推断它们也可用；命令见 docs/development.md §6.3。
- OpenAI 官方 API：2026-10-15 只完成文档与本地 mock 核对（§3.3）。缺 `WEVIR_TEST_API_KEY`，Sol / Luna 的契约第 3 层、桌面端 `apply_patch` 与 Luna 的关闭推理选项仍待真实服务验证，命令见 docs/development.md §6.3。
- Anthropic 官方 API：2026-10-15 完成文档、录制请求与严格 HTTP mock 核对；缺 `WEVIR_TEST_API_KEY`，Sonnet / Opus 的契约第 3 层与桌面 apply_patch 未验收。未实现 Workspace ID，只支持绑定单个 workspace 的 Key；Codex 的手动压缩、动态工具目录与换模型可能改变思考前缀，尚无服务端压缩或工具变更机制兜底。
- Messages：缺签名的思考不带回（§5.3）；`thinkingFormat` 只有 `adaptive` / `enabled` 两种，Sonnet 4.5、Haiku 4.5 不认 `output_config.effort` 却没有开关去掉；`max_tokens` 的默认值 32000 对上限更低的服务要在 Provider 里写明；Anthropic 的 HTTP 400 “prompt is too long”原样转回，Codex 不会把它认成上下文超长（只有流里的 `context_length_exceeded` 才会）；不发 `metadata.user_id`、`stop_sequences`、服务端工具；`custom_tool_call_input.delta` 同 Chat，不生成。
- Chat 转换不传 `parallel_tool_calls`、`strict`（为兼容性）；`reasoning.summary` 没有对应。§4.4 的思考格式以官方文档与 mock 验证，缺真实 Key 时不能算各服务的验收；minimax / tencent 扩展目前不能用于 dsh；Qwen 新 reasoning.effort 的替代接口留给服务接入时核对，目前沿用仍有官方文档的 enable_thinking。模型别名不能据名称认出强制思考能力时，须在模型目录准确声明 reasoningEfforts。
- 图片只支持 data URL 与网址，`file_id` 引用丢掉。
- `custom_tool_call_input.delta` 增量不生成（Chat 转换在流结束时才提交工具调用），apply_patch 的补丁内容不会边生成边显示。
- Host 进程里的 `fetch` 不读 `HTTPS_PROXY` 等代理变量（providers.md §6.3 的同一局限）。
