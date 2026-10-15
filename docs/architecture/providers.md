# Provider 配置桥接

> 状态：v0（T3.4）· 日期：2026-10-13 · dsh `0.2.1-alpha.2`
> 依据：[ADR-0001](../adr/0001-runtime-integration.md) §4 与补记 5；[领域模型](./domain-model.md) §3.2；T0.3 报告 §6；dsh 的 `docs/user/guide/providers.md` 与 `docs/config-catalog.zh.md`（`dsh-llm-pi-ai`、`dsh-llm-deepseek-api-key`）
> 代码：`packages/adapter-dsh/src/{provider-config,provider-test,dsh-adapter}.ts`、`packages/host/src/host-methods.ts`

Wevir 的 `ProviderProfile`（Host 的 SQLite + SecretStore）怎样变成 dsh 能用的配置，Key 怎样到达 dsh，改了 Provider 之后什么时候生效，`provider.test` 怎样判断。

## 1. 数据流

```text
provider.upsert ──► Host：适配器检查（validateProvider）→ 写库、Key 进 SecretStore
                         └─► configureProviders(全部 Provider + Key)
                               ├─ <DSH_HOME>/wevir/providers.yml（只有 apiKeyEnv 变量名，0600）
                               ├─ 下一次 spawn 的环境：WEVIR_PROVIDER_<ID>_KEY=<Key>
                               └─ dsh 在运行：空闲时重启（§5）
session.create ──► session/new → session/set_config_option model = ["<providerId>","<modelId>"]
provider.test  ──► 适配器直接向 Provider 发一次最小流式请求（§6），不经 dsh
```

- Host 启动时把存储里的全部 Provider 交给适配器一次（`syncProviders`），之后每次 `provider.upsert` / `provider.remove` 写库后再交一次。交的是整套，不是增量。
- 适配器的检查、配置与探测是 `AgentRuntimeAdapter` 的三个可选方法（`validateProvider`、`configureProviders`、`testProvider`），Host 不接触 dsh 的配置格式。
- 适配器没能用上新配置（例如 dsh 在新配置下起不来）时，`provider.upsert` / `provider.remove` 回 `ENGINE_ERROR`，但 Profile 已经保存；下一次变更或 Host 重启会再交一次。

## 2. 字段映射

### 2.1 两种 kind

（R6 起协议另有 `chatgpt`：ChatGPT 订阅登录的 Codex，没有 Key、地址与 overlay，只有 Codex 引擎有，见 [domain-model.md](./domain-model.md) §3.6 与 [codex-event-mapping.md](./codex-event-mapping.md) §8。dsh 适配器在 `validateProvider` 里拒绝它，写 overlay 时跳过它。下表只说 dsh。）

| `kind` | dsh 适配器 | 路由名 | Key 引用 |
|---|---|---|---|
| `deepseek-official` | `llm-deepseek`（`dsh-llm-deepseek-api-key`，Anthropic Messages） | 固定 `deepseek-official`，所以这类 Profile 最多一个，ID 只能是它 | `llm-deepseek.apiKeyEnv` 与 `web-search-deepseek.apiKeyEnv` 都改成 `WEVIR_PROVIDER_DEEPSEEK_OFFICIAL_KEY` |
| `openai-compatible` | `llm-pi-ai` 的自定义路由 | Provider ID | `providers.<ID>.apiKeyEnv` = `WEVIR_PROVIDER_<ID>_KEY` |

任务说明里写作 `deepseek` 的 kind 就是协议里已有的 `deepseek-official`（T1.2 定名），没有改名。

`openai-compatible` 的 ID 不能是 `deepseek-official` 或 `deepseek-account`：这两个路由名已被 dsh 的其他适配器占用，pi-ai 再注册同名路由会让 dsh 启动失败（`DUPLICATE_ADAPTER`）。ID 与 pi-ai 自带目录里的路由同名时（例如 `moonshotai-cn`、`zai-coding-cn`），dsh 会把它当作目录路由：手填的模型缺省的字段从目录里同 ID 的模型补上（上下文、最大输出、图片、推理档位、compat）。这是 dsh 的行为，Wevir 不依赖它。

**Provider ID 会写进 dsh 会话日志与模型选择，创建后不可改名**（`provider.upsert` 以 ID 为键，没有改名操作）。要“改名”只能新建一个再删除旧的；删除后，引用旧 ID 的已关闭会话在再建同 ID 的 Provider 之前不能 resume。

### 2.2 `ProviderProfile` → overlay

| Wevir 字段 | `deepseek-official`（`llm-deepseek.config`） | `openai-compatible`（`llm-pi-ai.config.providers.<ID>`） |
|---|---|---|
| `displayName` | 不写（dsh 的显示名固定为 DeepSeek） | `displayName` |
| `api` | 不允许 | `api`：`openai-completions` / `openai-responses`；`anthropic-messages` 只预留类型，`validateProvider` 拒绝（dsh 不支持；Codex 引擎经模型网关支持，见 [model-gateway.md](./model-gateway.md) §5） |
| `baseURL` | `baseURL`（省略用 dsh 的 `https://api.deepseek.com/anthropic`） | `baseURL`（必填） |
| `compat` | 不允许 | `compat`，见 §2.3 |
| `models[]` | 为空时不写 `models`，用 dsh 自带目录（`deepseek-flash`、`deepseek-v4-pro`）；不为空时整体替换目录 | `models`（必填，至少一个） |
| `models[].id` / `displayName` | `id` / `name` | `id` / `name` |
| `models[].contextWindow` | `contextWindow` | `contextWindow`（不填时 dsh 按 262144 猜，`usage.updated` 的 `contextSize` 会失真） |
| `models[].maxTokens` | `maxTokens` | `maxTokens`（填了也成为该模型每次请求的默认上限） |
| `models[].supportsImages` | `true` → `inputModalities: [text, image]`；省略或 `false` 只收文本 | `true` → `input: [text, image]`，`false` → `input: [text]`，省略沿用 dsh 目录（手填的模型只收文本） |
| `models[].reasoningEfforts` | 不允许（dsh 固定 off / low / high / max） | 省略沿用 dsh 目录（手填的模型不推理）；`[]` → `reasoningEfforts: false`；`['off','high']` → `{off: null, high: high}`，`off` 不发推理参数，其余原样作为 `reasoning_effort` 发出 |
| `defaultModelId` | 必须在 `models` 里；`models` 为空时必须是 dsh 自带目录里的模型（ACP 的模型选项只认目录里的） | 必须在 `models` 里 |
| Key | 进环境，不进 overlay | 同左 |

其他要点：

- overlay 不写 `acp` 条目。每个会话的 Provider 与模型由适配器在 `session/new` 之后用 `session/set_config_option`（`configId: model`，值是 dsh 的路由编码 `JSON.stringify([provider, model])`，上游 `dsh-acp/src/model-control.ts`）选定；给了 `reasoningEffort` 时再设 `reasoning_effort`。dsh 选不上（`-32602 unknown model option`）时 `session.create` 回 `ENGINE_ERROR`，引擎侧的会话随即关闭。
- 没有任何 Provider 时也写 `llm-deepseek` 与 `web-search-deepseek` 两条，把 Key 引用从默认的 `DEEPSEEK_API_KEY` 改成 Wevir 的变量；没有 `openai-compatible` 时不写 `llm-pi-ai`。
- 总是写 `session-log-deepseek` 与 `plugin-package-inventory-deepseek` 两条 `enabled: false`：dsh 默认给 `llm-deepseek` 的每个请求附带会话日志与插件清单，Wevir 不上传（发了什么、关掉的取舍见 [security.md §4](../security.md)）。
- 列出 `deepseek-official` 的模型会替换 dsh 自带目录，连同目录里为 `deepseek-flash` 声明的图片输入与提示词缓存相关设置（`systemPromptUpdate`、`toolUpdate`）。一般不需要列，用默认目录即可。
- 文件用 JSON 写（YAML 1.2 是 JSON 的超集），显示名、地址这些用户输入不需要 YAML 转义。dsh 启动时校验整份配置，任何一处不合法都会让 dsh 起不来、所有会话都受影响，所以 Host 在写库之前就调用 `validateProvider`，规则在 `validateProviderConfig`。
- `baseURL` 不能带用户名、密码、查询参数或片段：地址会原样写进 overlay，落到 `DSH_HOME`。

### 2.3 compat 默认值

pi-ai 按地址决定请求格式，不认识的地址一律按 OpenAI 官方的规则发，多数网关会拒绝其中一部分（dsh providers.md「Request compatibility」）。`openai-compatible` 实际写进 overlay 的 compat 是“用户给的值优先，其余按地址补默认值”（`effectiveCompat`）：

| 条件 | 补的默认值 |
|---|---|
| 地址不是 `api.openai.com` | `supportsDeveloperRole: false`、`maxTokensField: max_tokens` |
| 地址是 `deepseek.com` 及其子域（DeepSeek 的 OpenAI 兼容端点走 pi-ai 时） | 另加 `thinkingFormat: deepseek`、`requiresReasoningContentOnAssistantMessages: true`（T0.3 §6.2，取自 pi-ai 自带的 deepseek 目录） |

Codex 网关的工具方言默认值是 Provider 显式 compat > 地址默认 > 全局默认（model-gateway.md §4.4；地址表当前只有 xAI）。模板是新建 Provider 的初始值，已存的 Profile 不自动迁移；使用反向代理时可手动在 `provider.upsert` 的 compat 写 `supportsNamespaceTools: false`、`supportsCustomTools: false` 或 `toolChoice: auto_only`（工具选择的 none 规则见 model-gateway.md §3.2），桌面表单原样保留、暂不提供开关控件。P0a 不改变任何服务模板、目录、模型或地址。

每个开关只写给认它的协议：`supportsDeveloperRole` 用于 `openai-completions` 与 `openai-responses`，其余三个只用于 `openai-completions`。`supportsCustomTools` 与 `systemMessageMode`（协议 0.4.0）、`supportsNamespaceTools` 与 `toolChoice`（协议 0.12.0）只有 Codex 引擎的模型网关读（model-gateway.md §4.4），adapter-dsh 不检查、不写进 overlay，同一个 Provider 可以在两个引擎之间共用。路由上写了一个所有模型都读不了的开关，dsh 会拒绝整份配置，所以 `openai-responses` 只补 `supportsDeveloperRole`，用户给了不匹配的开关时 `validateProvider` 拒绝。

### 2.4 生成的 overlay 示例

`deepseek-official`（有 Key）加一个 Kimi：

```yaml
# 由 Wevir 生成（packages/adapter-dsh/src/provider-config.ts），每次 Provider 变更时整体重写，不要手改。
# 只含 Key 的环境变量名（apiKeyEnv），不含 Key；Key 只经 dsh 子进程的环境变量传入。
[
  { "id": "llm-deepseek", "config": { "apiKeyEnv": "WEVIR_PROVIDER_DEEPSEEK_OFFICIAL_KEY" } },
  { "id": "web-search-deepseek", "config": { "apiKeyEnv": "WEVIR_PROVIDER_DEEPSEEK_OFFICIAL_KEY" } },
  { "id": "session-log-deepseek", "config": { "enabled": false } },
  { "id": "plugin-package-inventory-deepseek", "config": { "enabled": false } },
  {
    "id": "llm-pi-ai",
    "config": {
      "providers": {
        "kimi": {
          "displayName": "Kimi",
          "apiKeyEnv": "WEVIR_PROVIDER_KIMI_KEY",
          "api": "openai-completions",
          "baseURL": "https://api.moonshot.cn/v1",
          "compat": { "supportsDeveloperRole": false, "maxTokensField": "max_tokens" },
          "models": [{ "id": "kimi-k2.6", "contextWindow": 262144, "input": ["text", "image"] }]
        }
      }
    }
  }
]
```

（实际文件是 `JSON.stringify(…, null, 2)` 的输出，这里为了篇幅压缩了缩进。）

## 3. Key 的去向

- Key 只在三处：Host 的 SecretStore（`<数据目录>/secrets.json`，0600）、Host 进程内存、dsh 子进程的环境变量 `WEVIR_PROVIDER_<ID>_KEY`（ID 转大写、`-` 换成 `_`）。
- overlay 文件在 `<DSH_HOME>/wevir/providers.yml`（目录 0700、文件 0600，临时文件 + rename 写入），只有变量名。`DSH_HOME` 里没有 `.credentials.yaml`，dsh 进程的 cwd 是 `DSH_HOME`，环境按白名单构造，所以 dsh 找不到用户 shell 里的 `DEEPSEEK_API_KEY` 等变量，也不会读用户工作区的 `.env`（ADR-0001 §4）。
- 没存 Key 的 Provider 不进环境。请求时 dsh 报缺凭据（`MISSING_CREDENTIAL`，错误原文点名变量），归为 `missing_credentials`（acp-event-mapping.md §3）。pi-ai 的 OpenAI 兼容实现总要一个 Key，本机的 Ollama、vLLM 这类不校验 Key 的服务也要填一个任意值。
- `provider.test` 的错误消息里出现 Key 原文时替换成 `***`；Host 不把 Key 写进日志、事件或响应（host-api.md §3.1）。
- 验收测试：`provider-config.test.ts`（overlay 文本里没有 Key、环境里有）、`dsh-adapter.providers.test.ts`（假 dsh 记录的 argv 有 `--patch <overlay>`、子进程环境有 Key、`DSH_HOME` 下其他文件都没有 Key）、`dsh-adapter.providers.integration.test.ts`（真实 dsh：Key 经 `Authorization: Bearer` / `x-api-key` 到达 mock Provider）。

## 4. 不做

- **OAuth 类 Provider**（Codex、Claude 等订阅账号登录）：grant 只能存在 dsh 能写的 `DSH_HOME/.credentials.yaml`，与“密钥不落 DSH_HOME”冲突，ACP 也没有登录入口（ADR-0001 未决事项 1）。骨架只支持 API Key 类 Provider。
- **`anthropic-messages` 协议（dsh 引擎）**：协议类型里保留（`ProviderApi`），adapter-dsh 的 `validateProvider` 拒绝、`provider.test` 不发请求。Codex 引擎经模型网关支持（R10，[model-gateway.md](./model-gateway.md) §5）。
- 按 Provider 配置请求头、超时、重试策略、`reasoning` 默认档位等 pi-ai 的其余字段：骨架不暴露。

## 5. Provider 变更的生效

### 5.1 实测（dsh 0.2.1-alpha.2，`dsh-adapter.providers.integration.test.ts`）

| 改动方式 | 正在运行的 dsh 进程 |
|---|---|
| 直接改 `--patch` 传入的 overlay 文件（同一 Provider 换 `baseURL`） | 不生效：已有会话与新建会话的请求都还发往旧地址 |
| 改 `$DSH_HOME/profiles/acp/cordis.patch.yml`（加一个 Provider） | 不生效：新 Provider 的模型选不上（`unknown model option`） |
| 换 Key | 不可能热更新：Key 在子进程环境里，运行中的进程看不到新值 |
| 重启 dsh（新 overlay + 新环境） | 生效：新会话用新配置；旧会话 resume 之后的请求也发往新地址、带新 Key（路由按 Provider ID 在每次请求时解析） |

原因：acp profile 关掉了 `hmr`（`packages/bundle/acp-app/cordis.patch.yml` 的 `- id: hmr / disabled: true`）。dsh providers.md 说的“改了下一次请求就生效”，靠的是 Web profile 的 HMR 与 `config-editor`（经 Web 界面写入并立即应用），ACP 两者都没有。所以 **Provider 变更必须重启 dsh 进程**。

### 5.2 策略（`DshAdapter.configureProviders`）

1. 先重写 overlay、换掉下一次 spawn 的 Key（`DshProcess.setLaunchConfig`），任何之后的启动（首次、崩溃后的自动重启、计划重启）都用新配置。
2. dsh 没在运行：到此为止，下一次 `session.create` 启动时生效。
3. dsh 在运行、没有进行中的回合：立即重启（`DshProcess.restart`，与 `dispose` 同一个回收阶梯，不计入崩溃重启次数），`configureProviders` 在新进程就绪后返回，`provider.upsert` 因此多约 0.5–1 s。
4. 有回合在跑（含等审批）或有 `createSession` 在进行：不打断，等最后一个回合结束（或下一次 `createSession` 开始时）再重启。这期间新建的会话建在旧进程上，用旧配置；要用的 Provider 或模型在旧配置里没有时 `session.create` 回 `ENGINE_ERROR`（消息里提示配置可能还没生效）。

### 5.3 对运行中会话的影响

- 重启前，挂在旧进程上的会话都以 `engine.exited`（`reason: config_changed`，`exitCode` / `signal` 为 null）脱开。Host 把会话转为 `error`，`engine.error` 的消息是 `engine restarted to apply provider changes; resume the session to continue`（类别仍是 `engine_exited`）。因为只在没有回合时重启，不会有回合被打断、也没有未决审批被结掉。
- 用户 `session.resume` 之后，会话用新配置继续：同一 Provider ID 的新地址、新 Key、新模型参数都生效；会话日志里记录的模型（dsh：已发过请求的会话保留日志里的模型）不变。删除了的 Provider 的会话不能 resume（`PROVIDER_NOT_FOUND`）。
- T3.5 之前 `DshAdapter.resumeSession` 还没实现，这一步要等 T3.5；实测里的 resume 是测试直接发 ACP `session/resume` 验证的。
- 增量旁路、审批等进程级状态随新进程重建，与崩溃后的自动重启相同（ADR-0001 补记 1、2）。

## 6. `provider.test`

### 6.1 请求

适配器按 dsh 发请求的方式，直接向 Provider 发一次最小的流式请求，收到第一条合乎协议的流式数据就断开（`testProvider`，时限 20 s）。不经 dsh：dsh 每个请求都带完整的系统提示词与工具定义，代价高，失败时也只给自由文本。

| Provider | 请求 | 成功的判据 |
|---|---|---|
| `deepseek-official` | `POST <baseURL>/v1/messages`（`baseURL` 已以 `/v1` 结尾时只加 `/messages`，与 llm-deepseek 相同），`x-api-key`、`anthropic-version: 2023-06-01`，`{model, max_tokens: 1, stream: true, thinking: {type: disabled}, messages}` | 第一条 SSE 数据有 `type`（`message_start` 等） |
| `openai-completions` | `POST <baseURL>/chat/completions`，`Authorization: Bearer`，`{model, messages, stream: true, <maxTokensField>: 1}`，字段名按生效的 compat | 第一条数据有 `choices` 数组；服务端无视 `stream` 回整个 JSON 也算 |
| `openai-responses` | `POST <baseURL>/responses`，`{model, input, stream: true, max_output_tokens: 16}`（OpenAI 要求至少 16） | 第一条数据的 `type` 以 `response.` 开头 |

用流式请求，是因为有的服务只在流式下允许思考（例如 DashScope 的 `enable_thinking`），dsh 本身也总是流式请求。请求不跟随重定向。

### 6.2 失败归类

结果里 `ok: false`，`reason` 供界面给出修复提示，`error.message` 是中文说明加服务端原文（最多 300 字符，Key 替换为 `***`），`httpStatus` 是收到的状态码。

| `reason` | 判据 | `error.category` |
|---|---|---|
| `missing_key` | 没存 Key，不发请求 | `missing_credentials` |
| `network` | 连不上：DNS（`ENOTFOUND` / `EAI_AGAIN`）、拒绝连接（`ECONNREFUSED`）、TLS 证书错误等 | `provider` |
| `timeout` | 时限内没有响应，或连接超时 | `provider` |
| `auth` | 401 / 403；或 200 的流里是认证类错误 | `provider` |
| `model_not_found` | 错误原文提到模型不存在（`model_not_found`、`does not exist`、`Model Not Exist`、`模型不存在` 等），不论 400 / 404 还是流里的错误 | `provider` |
| `protocol` | 404 / 405 且与模型无关（baseURL 或协议不对）；400 / 422 且与模型无关（请求格式不被接受，检查协议或 compat）；200 但返回网页或不是所选协议的流 | `provider` |
| `rate_limited` | 429（Key 有效，但被限流或额度用完） | `provider` |
| `server` | 5xx | `provider` |
| `unknown` | 其他，以及配置不完整（不发请求） | `unknown` |

`provider.test` 的结果字段 `reason`、`httpStatus` 是协议 0.2.0 新增的（host-api.md）。

### 6.3 局限

- 只验证地址、协议、Key 与模型能对上；不验证 compat 是否适合 dsh 真正发的请求（带系统提示词、工具、推理参数），这类问题在第一次对话时以 `provider` 类错误暴露（acp-event-mapping.md §3）。
- Host 进程里的 `fetch` 不读 `HTTPS_PROXY` 等代理变量（dsh 子进程的代理行为由 dsh 决定）。需要代理才能访问的服务，`provider.test` 可能报 `network` / `timeout` 而对话正常。
- 模型不存在的判断依赖错误原文，服务改措辞会落到 `protocol` 或 `unknown`。

## 7. 服务示例（`openai-compatible`）

以下是 `provider.upsert` 的参数。**`baseURL` 与模型 ID 以各服务当前的官方文档为准**，这里的值是 2026-10 核对的（来源见每节），上下文与最大输出是示意值，按服务文档填写。所有地址都不是 `api.openai.com`，§2.3 的默认 compat 会自动补上，一般不需要写 `compat`。

### 7.1 DeepSeek

首选 `deepseek-official`（dsh 原生的 Messages 适配器，支持 Files API 的图片与提示词缓存相关设置）：

```json
{
  "id": "deepseek-official",
  "kind": "deepseek-official",
  "displayName": "DeepSeek",
  "models": [],
  "defaultModelId": "deepseek-flash",
  "apiKey": "<DeepSeek API Key>"
}
```

也可以走 OpenAI 兼容端点（pi-ai）。地址是 `deepseek.com` 时 §2.3 自动加 `thinkingFormat: deepseek` 与 `requiresReasoningContentOnAssistantMessages: true`：

```json
{
  "id": "deepseek-openai",
  "kind": "openai-compatible",
  "displayName": "DeepSeek（OpenAI 兼容）",
  "api": "openai-completions",
  "baseURL": "https://api.deepseek.com",
  "models": [
    { "id": "deepseek-flash", "contextWindow": 1000000, "supportsImages": true, "reasoningEfforts": ["off", "low", "high", "max"] },
    { "id": "deepseek-v4-pro", "contextWindow": 1000000, "reasoningEfforts": ["off", "high", "max"] }
  ],
  "defaultModelId": "deepseek-flash",
  "apiKey": "<DeepSeek API Key>"
}
```

来源：dsh 自带的 pi-ai 目录（`@earendil-works/pi-ai` 1.1.0 的 `providers/data/deepseek.json`）与 llm-deepseek README。

### 7.2 通义千问（阿里云百炼 DashScope）

```json
{
  "id": "dashscope",
  "kind": "openai-compatible",
  "displayName": "通义千问",
  "api": "openai-completions",
  "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "models": [{ "id": "qwen-plus", "contextWindow": 131072 }],
  "defaultModelId": "qwen-plus",
  "apiKey": "<百炼 API Key>"
}
```

- 地址按地域与计费方式不同：国际站 `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`，较新的文档建议改用业务空间专属域名（如 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`）；Coding Plan、Token Plan 套餐有独立的地址，不要混用。
- 要用思考模式的模型，按 pi-ai 目录里百炼条目的写法加 `"compat": {"thinkingFormat": "qwen"}` 并声明 `reasoningEfforts`。
- 来源：[百炼 OpenAI Chat 接口兼容](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)、[在 LangChain 中使用百炼](https://help.aliyun.com/zh/model-studio/use-bailian-in-langchain)。

### 7.3 Kimi（月之暗面）

```json
{
  "id": "kimi",
  "kind": "openai-compatible",
  "displayName": "Kimi",
  "api": "openai-completions",
  "baseURL": "https://api.moonshot.cn/v1",
  "models": [{ "id": "kimi-k2.6", "contextWindow": 262144, "supportsImages": true }],
  "defaultModelId": "kimi-k2.6",
  "apiKey": "<Kimi 开放平台 API Key>"
}
```

- 国内站（platform.moonshot.cn）的 Key 只能用 `api.moonshot.cn`，国际站的 Key 用 `https://api.moonshot.ai/v1`，两边不通用。
- pi-ai 目录里 Kimi 的条目带 `thinkingFormat: deepseek`；要声明推理档位时一并写上。
- 来源：pi-ai 目录 `providers/data/moonshotai-cn.json`；[Kimi 开放平台 API 文档](https://platform.kimi.ai/docs/api/overview.md)。

### 7.4 智谱 GLM（BigModel 开放平台）

```json
{
  "id": "zhipu",
  "kind": "openai-compatible",
  "displayName": "智谱 GLM",
  "api": "openai-completions",
  "baseURL": "https://open.bigmodel.cn/api/paas/v4",
  "models": [{ "id": "glm-4.5", "contextWindow": 131072 }],
  "defaultModelId": "glm-4.5",
  "apiKey": "<智谱 API Key>"
}
```

- GLM Coding 套餐的地址是 `https://open.bigmodel.cn/api/coding/paas/v4`（pi-ai 目录 `zai-coding-cn`），与按量计费的地址不同。
- 思考模式的模型按 pi-ai 目录的写法用 `"compat": {"thinkingFormat": "zai"}`。
- 来源：[智谱 OpenAI 兼容说明](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction)；pi-ai 目录 `providers/data/zai-coding-cn.json`。

### 7.5 本机模型服务（Ollama、vLLM 等）

```json
{
  "id": "local-ollama",
  "kind": "openai-compatible",
  "displayName": "本机 Ollama",
  "api": "openai-completions",
  "baseURL": "http://127.0.0.1:11434/v1",
  "models": [{ "id": "qwen3:8b", "contextWindow": 32768 }],
  "defaultModelId": "qwen3:8b",
  "apiKey": "ollama"
}
```

`apiKey` 填任意值（§3）。

### 7.6 xAI（Grok API Key，R8）

只经 Codex 引擎（网关的 Responses 透传，model-gateway.md §3.2）；dsh 不适用。大陆无法直连。这是 ADR-0005 决策 4 第 ②′ 行；Grok 订阅经 Grok Build 的第 ② 行还没做。

```json
{
  "id": "xai",
  "kind": "openai-compatible",
  "displayName": "xAI（Grok API）",
  "api": "openai-responses",
  "baseURL": "https://api.x.ai/v1",
  "compat": { "supportsCustomTools": false },
  "models": [
    { "id": "grok-4.7", "contextWindow": 500000, "supportsImages": true, "reasoningEfforts": ["low", "medium", "high", "xhigh"] },
    { "id": "grok-build-0.1", "contextWindow": 256000 }
  ],
  "defaultModelId": "grok-4.7",
  "apiKey": "<xAI API Key，xai- 开头>"
}
```

来源：docs.x.ai 的 models 页与各模型页（2026-10-14）。`supportsCustomTools: false` 让网关把 apply_patch 摊平成函数（xAI 的地址不写也会默认摊平，写明是为了经代理改地址后仍然生效）。

### 7.7 Google AI Studio（Gemini API Key，R8）

Codex 引擎经网关的 Chat 转换走 Gemini 的 OpenAI 兼容端点（model-gateway.md §4.5）；dsh 不适用。个人 Google 账号登录已停（codex-notes §4.2），只有 API Key。大陆无法直连。经 Gemini CLI 的另一条路（ADR-0005 决策 4 第 ③ 行）还没做。

```json
{
  "id": "gemini",
  "kind": "openai-compatible",
  "displayName": "Google AI Studio",
  "api": "openai-completions",
  "baseURL": "https://generativelanguage.googleapis.com/v1beta/openai/",
  "models": [
    { "id": "gemini-3.8-flash", "contextWindow": 1048576, "supportsImages": true, "reasoningEfforts": ["low", "medium", "high"] },
    { "id": "gemini-4-argon", "contextWindow": 1048576, "supportsImages": true, "reasoningEfforts": ["low", "medium", "high"] }
  ],
  "defaultModelId": "gemini-3.8-flash",
  "apiKey": "<Gemini API Key>"
}
```

来源：ai.google.dev 的 openai、models、thought-signatures 页（2026-10-13）。3.8 Flash 与 4 Argon 不认 `minimal`，模型目录里不列。

### 7.8 OpenAI（U6）

Codex 引擎经网关透传 Responses（这几个模型在 Chat Completions 上不能调工具）；dsh 不适用。大陆无法直连。

```json
{
  "id": "openai",
  "kind": "openai-compatible",
  "displayName": "OpenAI",
  "api": "openai-responses",
  "baseURL": "https://api.openai.com/v1",
  "models": [
    { "id": "gpt-6.1-sol", "contextWindow": 1050000, "maxTokens": 128000, "supportsImages": true, "reasoningEfforts": ["low", "medium", "high", "xhigh", "max"] },
    { "id": "gpt-6-astra", "contextWindow": 1050000, "maxTokens": 128000, "supportsImages": true, "reasoningEfforts": ["low", "medium", "high", "xhigh", "max"] },
    { "id": "gpt-6-luna", "contextWindow": 1050000, "maxTokens": 128000, "supportsImages": true, "reasoningEfforts": ["low", "medium", "high", "xhigh", "max"] }
  ],
  "defaultModelId": "gpt-6.1-sol",
  "apiKey": "<OpenAI API Key>"
}
```

来源：developers.openai.com 的 models 页（2026-10-14）。Luna 还接受 `none`，Wevir 的推理档位没有这一档，不列。

### 7.9 Anthropic（U6）

Codex 引擎经网关转 Messages（R10，[model-gateway.md](./model-gateway.md) §5；`claude-` 开头的模型用 adaptive 思考，档位放进 `output_config.effort`）；dsh 不适用。大陆无法直连。

```json
{
  "id": "anthropic",
  "kind": "openai-compatible",
  "displayName": "Anthropic",
  "api": "anthropic-messages",
  "baseURL": "https://api.anthropic.com",
  "models": [
    { "id": "claude-opus-5-5", "contextWindow": 1000000, "maxTokens": 128000, "supportsImages": true, "reasoningEfforts": ["low", "medium", "high", "xhigh", "max"] },
    { "id": "claude-sonnet-5-5", "contextWindow": 1000000, "maxTokens": 128000, "supportsImages": true, "reasoningEfforts": ["low", "medium", "high", "xhigh", "max"] },
    { "id": "claude-haiku-5-5", "contextWindow": 1000000, "maxTokens": 128000, "supportsImages": true, "reasoningEfforts": ["low", "medium", "high", "xhigh", "max"] },
    { "id": "claude-fable-5-1", "contextWindow": 1000000, "maxTokens": 128000, "supportsImages": true, "reasoningEfforts": ["low", "medium", "high", "xhigh", "max"] }
  ],
  "defaultModelId": "claude-opus-5-5",
  "apiKey": "<Anthropic API Key>"
}
```

来源：platform.claude.com 的 models overview 与 effort 页（2026-10-14）。四个模型都支持五档 effort；Opus 5.5 的思考不能关（`none` 会 400），所以不列 `off`。

桌面端的首次引导（U6，`apps/desktop/src/renderer/src/onboarding/`）与“更多”对话框按 `settings/provider-catalog.ts` 列出服务：国际（OpenAI、Anthropic、Google AI Studio、Google Vertex AI、xAI）、国内（DeepSeek 官方、通义千问、Kimi、智谱 GLM）、本地与自定义（Ollama、空白的 OpenAI 兼容表单）。Google Vertex AI 要 Google Cloud 的 OAuth 令牌，模型网关还没有，先标“即将支持”。
