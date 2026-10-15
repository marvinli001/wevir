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
- 桌面端表单（OpenAI 兼容与 Vertex）每行模型有“图片输入”勾选框，对应 `supportsImages`：勾上写 `true`，取消时原模型标过的写 `false`、没标过的不写。Codex 引擎只给标了 `true` 的模型开图片输入（Codex 的模型目录据此填 `input_modalities`），手填网关模型要发图片就得勾上；`deepseek-official` 不在表单里编辑模型。
- 列出 `deepseek-official` 的模型会替换 dsh 自带目录，连同目录里为 `deepseek-flash` 声明的图片输入与提示词缓存相关设置（`systemPromptUpdate`、`toolUpdate`）。一般不需要列，用默认目录即可。
- 文件用 JSON 写（YAML 1.2 是 JSON 的超集），显示名、地址这些用户输入不需要 YAML 转义。dsh 启动时校验整份配置，任何一处不合法都会让 dsh 起不来、所有会话都受影响，所以 Host 在写库之前就调用 `validateProvider`，规则在 `validateProviderConfig`。
- `baseURL` 不能带用户名、密码、查询参数或片段：地址会原样写进 overlay，落到 `DSH_HOME`。

### 2.3 compat 默认值

pi-ai 按地址决定请求格式，不认识的地址一律按 OpenAI 官方的规则发，多数网关会拒绝其中一部分（dsh providers.md「Request compatibility」）。`openai-compatible` 实际写进 overlay 的 compat 是“用户给的值优先，其余按地址补默认值”（`effectiveCompat`）：

| 条件 | 补的默认值 |
|---|---|
| 地址不是 `api.openai.com` | `supportsDeveloperRole: false`、`maxTokensField: max_tokens` |
| 地址是 `deepseek.com` 及其子域（DeepSeek 的 OpenAI 兼容端点走 pi-ai 时） | 另加 `thinkingFormat: deepseek`、`requiresReasoningContentOnAssistantMessages: true`（T0.3 §6.2，取自 pi-ai 自带的 deepseek 目录） |

Codex 网关的工具方言默认值是 Provider 显式 compat > 地址默认 > 全局默认（model-gateway.md §4.4；地址表含 xAI 与百炼按量端点）。模板是新建 Provider 的初始值，已存的 Profile 不自动迁移；使用反向代理时可手动在 `provider.upsert` 的 compat 写 `supportsNamespaceTools: false`、`supportsCustomTools: false` 或 `toolChoice: auto_only`（工具选择的 none 规则见 model-gateway.md §3.2），桌面表单原样保留、暂不提供开关控件。Azure 的按地址请求修正见 model-gateway.md §3.5，不改变这些工具开关。

每个开关只写给认它的协议：`supportsDeveloperRole` 用于 `openai-completions` 与 `openai-responses`，其余三个只用于 `openai-completions`。`supportsCustomTools` 与 `systemMessageMode`（协议 0.4.0）、`supportsNamespaceTools` 与 `toolChoice`（协议 0.12.0）、`geminiToolSchema`（协议 0.26.0，默认关闭）只有 Codex 引擎的模型网关读（model-gateway.md §4.4），adapter-dsh 不检查、不写进 overlay，同一个 Provider 可以在两个引擎之间共用。路由上写了一个所有模型都读不了的开关，dsh 会拒绝整份配置，所以 `openai-responses` 只补 `supportsDeveloperRole`，用户给了不匹配的开关时 `validateProvider` 拒绝。

Codex 的 Chat 转换也读取 `thinkingFormat`（2026-10-15）：`openai` / `deepseek` / `qwen` / `zai` 使用与 pi-ai 同名格式相同的参数位置与开关语义；力度、none、强制思考模型与预算的映射见 [model-gateway.md §4.4](./model-gateway.md#44-网关的-compat-开关)。`minimax` / `tencent` 是网关扩展，当前只用于 Codex，dsh 上游的配置枚举不认这两个值。通过代理接入时必须显式写格式；DeepSeek 地址仍默认 deepseek。推理必填的默认值按格式补，显式 `requiresReasoningContentOnAssistantMessages: false` 可以停止补空串；模型已返回的推理不删除。只收 auto 的服务另设 `toolChoice: auto_only`。这些规则不更新模板、不自动改已有 Provider，桌面表单仍原样保存 compat。

Messages 的 Anthropic 官方地址按当前 Claude 型号处理 forced choice、默认 effort 与 none，4.7 起去掉采样参数；代理地址可显式 `thinkingFormat: adaptive` 开启同样的 Claude 方言。中途 system 的模式另由 `systemMessageMode` 决定：当前四款模型在官方地址默认 inline，代理要显式 inline；旧模型仍按 user。toolChoice 的显式声明优先于模型默认。详见 [model-gateway.md §5](./model-gateway.md#5-anthropic-messages-转换)。

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

- **OAuth 类 Provider**（Codex、Claude 等订阅账号登录）：grant 只能存在 dsh 能写的 `DSH_HOME/.credentials.yaml`，与“密钥不落 DSH_HOME”冲突，ACP 也没有登录入口（ADR-0001 未决事项 1）。这是 dsh 骨架阶段的限制。Codex 网关现支持 §7.11 的 Vertex 服务账号；交互式订阅登录走各自引擎，不复用服务账号路径。
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

## 7. 服务示例

以下是 `provider.upsert` 的参数。**`baseURL` 与模型 ID 以各服务当前的官方文档为准**，这里的值是 2026-10 核对的（来源见每节），上下文与最大输出按各节的模型文档填写。非 `api.openai.com` 的地址会按 §2.3 补默认 compat；Codex 网关的开关另见 model-gateway.md §4.4。

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

### 7.2 阿里云百炼（DashScope）

**2026-10-15 核对。** 按[官方 Codex 指南](https://help.aliyun.com/zh/model-studio/codex)使用按量 Responses，避免把原生 reasoning 历史转换成 Chat。模板保留无需 Workspace ID 的北京旧域名，官方仍支持它；新建默认模型为 Qwen3.8 Max。目录继续使用已有的 LobeHub Qwen 标志。

```json
{
  "id": "dashscope",
  "kind": "openai-compatible",
  "displayName": "阿里云百炼",
  "api": "openai-responses",
  "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "compat": {
    "supportsCustomTools": false,
    "supportsNamespaceTools": false,
    "toolChoice": "auto_only"
  },
  "models": [
    { "id": "qwen3.8-max", "contextWindow": 1000000, "supportsImages": true, "reasoningEfforts": ["off", "low", "medium", "xhigh"] },
    { "id": "qwen3.8-flash", "contextWindow": 1000000, "reasoningEfforts": ["off", "low", "medium", "xhigh"] },
    { "id": "qwen3.7-plus", "contextWindow": 1000000, "supportsImages": true, "reasoningEfforts": ["off", "low", "medium", "high", "xhigh"] }
  ],
  "defaultModelId": "qwen3.8-max",
  "apiKey": "<百炼 API Key>"
}
```

- **地址与 Key。** 北京端点中国大陆可直连；国际站旧地址为 `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`（新加坡）。官方推荐 `https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1`，region 可为 cn-beijing、ap-southeast-1、us-east-1、eu-central-1、ap-northeast-1、cn-hongkong，须填真实业务空间 ID，并使用对应地域的 Key 与可用模型。Key 入口是[北京 API Key 页面](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key)，其他地域在控制台切换。Wevir 只接按量计费，套餐的地址、Key 与模型不提供模板。
- **工具默认值。** 上述按量主机名自动补同样的三个 compat 字段；模板显式写明，经代理改地址也保留。官方只声明 function 与内置工具，未声明 custom / namespace；required 限单工具，Qwen 思考模式也不支持 required。没有真实 Key，采用保守摊平与 auto_only，显式 compat 逐字段优先。none 会被去掉、工具保留，不能保证禁止调用工具。未声称已证实服务拒收 custom / namespace。
- **思考与上下文。** Responses 使用 reasoning.effort，不用 Chat 的 thinkingFormat: qwen 或 enable_thinking。off 交给 Codex 时为 none；Qwen3.8 的原生档位是 none / low / medium / xhigh（默认 xhigh）。Qwen3.7 Plus 的开启档位沿用官方 Codex 目录示例 low / medium / high / xhigh，并按混合思考能力提供 off；Responses 参数页未单列它的档位映射。模型窗口按官方模型列表记 1M；Codex 指南中 Qwen3.8 Max 的示例写 983616，不当成模型能力上限。Responses 文档另说明输入约限窗口的 80%，超限自动截断。没有官方最大输出依据，不填 maxTokens。
- **历史与存储。** reasoning 项保留 id 与 summary；Codex 带回的 null content / encrypted_content 由通用方言去掉。store: false 原样保留，不启用默认七天的响应存储或 previous_response_id。连接测试只发最小请求，不能证明工具与跨回合推理可用。
- **旧 Provider 手动修改。** 已存的 Chat + qwen-plus 配置不会套新模板。可在“设置 → 模型服务”编辑：协议改为 OpenAI Responses，地址用上述按量地址，模型列表与默认模型换成示例中的值，重新测试连接后新建会话。原有 thinkingFormat: qwen 仅供 Chat 使用，可经 provider.upsert 移除；其他显式工具 compat 也需自行核对，不能由地址默认覆盖。
- **验收边界。** 录制请求与严格 HTTP mock 已覆盖工具摊平、响应还原、推理历史与 provider.test；缺 WEVIR_TEST_API_KEY，Qwen3.8 Max / Flash 的真实契约与桌面 apply_patch 尚未验收（命令见 development.md §6.3）。不接本服务的 Anthropic 端点，也不把托管第三方模型加入模板。

来源（2026-10-15）：[Codex](https://help.aliyun.com/zh/model-studio/codex)、[Responses 兼容指南](https://help.aliyun.com/zh/model-studio/compatibility-with-openai-responses-api)、[Responses 参数](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)（旧的 /api/v2/apps/protocols/compatible-mode/v1/responses 已停止维护）、[深度思考](https://help.aliyun.com/zh/model-studio/deep-thinking)、[Function Calling](https://help.aliyun.com/zh/model-studio/qwen-function-calling)、[模型列表](https://www.alibabacloud.com/help/en/model-studio/text-generation-model)、[API Key](https://help.aliyun.com/zh/model-studio/get-api-key)。

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

### 7.7 Google AI Studio（Gemini API Key）

**2026-10-15 核对。** 国际按量 API，只用 [AI Studio 的 API Key](https://aistudio.google.com/apikey)。官方 OpenAI 兼容指南提供的是 `chat/completions`，兼容层仍是 beta、没有 Responses；因此 Codex 经 Host 网关做 Chat 转换（model-gateway.md §4.5）。Interactions 是另一种协议，本接法不使用它或原生 generateContent。dsh 不适用；Gemini CLI 是独立引擎路线。

中国内地、香港、澳门都不在官方可用地区，内地无法直连；须符合 Google 可用地区要求并具备可访问 Google 的网络。Host 的 fetch 代理限制见 §6.3。

```json
{
  "id": "gemini",
  "kind": "openai-compatible",
  "displayName": "Google AI Studio",
  "api": "openai-completions",
  "baseURL": "https://generativelanguage.googleapis.com/v1beta/openai/",
  "models": [
    { "id": "gemini-3.8-flash", "contextWindow": 1048576, "maxTokens": 65536, "supportsImages": true, "reasoningEfforts": ["low", "medium", "high"] },
    { "id": "gemini-3.1-pro-preview", "contextWindow": 1048576, "maxTokens": 65536, "supportsImages": true, "reasoningEfforts": ["low", "medium", "high"] },
    { "id": "gemini-4-argon", "contextWindow": 1048576, "maxTokens": 65536, "supportsImages": true, "reasoningEfforts": ["low", "medium", "high"] }
  ],
  "defaultModelId": "gemini-3.8-flash",
  "apiKey": "<Gemini API Key>"
}
```

模板只列 3.8 Flash、3.1 Pro 与 4 Argon，默认 3.8 Flash。3.1 Pro 当前官方 API ID 为 `gemini-3.1-pro-preview`，按预览模型标识保存。三款都支持图片输入、1,048,576 上下文与 65,536 输出，只列 low / medium / high；3.1 Pro 默认 high，另两款默认 medium。

3.8 Flash 明确拒收 minimal，4 Argon 的 minimal 由兼容层映射到 low。网关仅对 Gemini 官方地址、未显式设置 thinkingFormat 时把 minimal 降到 low，none 仍省略，不能据此关闭思考。不发 extra_body.google.thinking_config，避免与 reasoning_effort 冲突。4 Argon 的 1,048,576 是输入输出共用上下文，同步输出上限为 65,536；它只支持隐式缓存，网关不伪造缓存请求。

2026-05-28 起 AI Studio 新建的是绑定服务账号的 auth key；无限制的旧 standard key 会被拒，有显式限制的仍可用。表单、网关与 provider.test 都不按 AQ. / AIza 前缀校验，Key 原样放入 Bearer 头，不自行换取令牌。真实 auth key 的兼容性仍须用目标账号验证。

并行调用合在一条 assistant 消息，之后连续放全批 tool 结果；当前回合每一步第一个调用的 thought signature 都按原 call_id 带回（§4.5）。provider.test 没有工具、输出上限只有 16，只证明最小连接，不能证明第二步签名、占位签名、Schema 或中途 system 可用。

Schema 两项尚无真实 Key 证据，模板默认不清洗。只有服务确实因 additionalProperties 或空对象拒绝请求时，才手动通过 provider.upsert 设置 `compat: {geminiToolSchema: true}`（协议 0.26.0）。它只改 Chat 工具定义：递归去掉 additionalProperties、给空对象补可省略的 `_wevir_unused` 布尔参数；会放宽对象约束，结构化输出不变，经代理也可用。省略或 false 关闭，dsh 忽略，桌面表单原样保存但没有专门开关控件。

已有 Provider 是用户数据，不自动迁移。旧模板用户可在设置 → 模型服务中手动添加 gemini-3.1-pro-preview，把模型输出上限改为 65536、档位改成 low / medium / high；保留自定义地址与模型，不因模板更新覆盖。反向代理不触发官方地址的 minimal 修正与签名识别，模板的 Schema 开关不能代替它们；签名必须在完整链路中验证。

本次没有 WEVIR_TEST_API_KEY，三款模型的契约第 3 层与 pnpm dev 中带 apply_patch 的桌面对话均未验收；占位签名、additionalProperties、空对象和中途 system 仍待实测。命令见 development.md §6.3；本机 HTTP mock 的多步签名测试不能替代真实服务。

来源：[OpenAI 兼容端点](https://ai.google.dev/gemini-api/docs/openai)、[模型目录](https://ai.google.dev/gemini-api/docs/models)、[3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)、[3.1 Pro Preview](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview)、[4 Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon)、[思考档位](https://ai.google.dev/gemini-api/docs/thinking)、[工具签名与顺序](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)、[API Key](https://ai.google.dev/gemini-api/docs/api-key)、[可用地区](https://ai.google.dev/gemini-api/docs/available-regions)。原 thought-signatures URL 已移到以 Interactions 为主的 Thinking guide，Chat 细节以 generate-content 下的签名页为准。兼容表泛称的 Gemini 3 Flash minimal 支持不用于 3.8 Flash，按具体型号页处理。

### 7.8 OpenAI（Responses）

Codex 引擎经网关透传到官方按量 API `https://api.openai.com/v1/responses`，不需要额外 compat。Sol 与 Astra 的工具调用要求 Responses；Luna 在 Chat Completions 上只有关闭推理时支持函数调用，因此模板统一使用 Responses。三款模型都支持图片输入、1,050,000 token 上下文与最多 128,000 token 输出；默认模型仍是 `gpt-6.1-sol`，不加入旧一代模型。dsh 不适用。

中国大陆无法直连；中国大陆、香港、澳门都不在 OpenAI 的支持地区内，在不支持地区访问或提供访问可能导致账号被封禁或暂停。使用前应查看[官方支持地区](https://developers.openai.com/api/docs/supported-countries)。Key 在 [OpenAI Platform](https://platform.openai.com/api-keys) 创建。

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
    { "id": "gpt-6-luna", "contextWindow": 1050000, "maxTokens": 128000, "supportsImages": true, "reasoningEfforts": ["off", "low", "medium", "high", "xhigh", "max"] }
  ],
  "defaultModelId": "gpt-6.1-sol",
  "apiKey": "<OpenAI API Key>"
}
```

Luna 的 `off` 经 adapter-codex 的 `toCodexEffort` 映射为 `none`：模型目录、建会话与会话内改档位都走这个映射，网关原样透传 `reasoning.effort: none`。Sol 与 Astra 不列 `off` 或 `minimal`，只列 low–max。

**已有 Provider 不自动迁移。** 用旧模板建的 OpenAI Provider 仍保留原来的档位。需要给 Luna 加“关闭”时，经 `provider.upsert` 提交原 Profile 的配置，仅把它的 `models` 中 Luna 的 `reasoningEfforts` 改成上例的六档；保留其他模型、地址、协议和默认模型，省略 `apiKey` 以保留已存 Key。桌面表单目前不编辑推理档位，编辑已有 Provider 不会自动套新模板。

来源与核对日期：**2026-10-15 已核对** [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)、[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)、[GPT-6 接口说明](https://developers.openai.com/api/docs/guides/latest-model#gpt-6-astra-update-api-and-model-parameters)。Responses 字段与加密推理的核对见 [model-gateway.md §3.3](./model-gateway.md#33-openai-官方-api-核对)。没有提供真实 Key，契约第 3 层（Sol、Luna）与桌面端 `apply_patch` 对话仍未验证，不能用本地 mock 结果代替。

### 7.9 Anthropic（官方按量 API）

Codex 引擎经网关转 Messages（[model-gateway.md §5](./model-gateway.md#5-anthropic-messages-转换)）；官方原生接口是 Messages，因此用转换路由。四款当前主力模型均支持图片输入、1M 上下文、128K 输出和五档 effort；默认模型仍是 Opus 5.5。模板显式声明 adaptive 与 inline，保证使用代理地址时仍按 Claude 的模型限制处理；dsh 不适用。

中国内地无法直连；中国内地、香港、澳门均不在[官方支持地区](https://www.anthropic.com/legal/supported-regions)内。Key 在 [Claude Console](https://platform.claude.com/settings/keys) 创建。当前只支持绑定单个 workspace 的 Key：未绑定的个人 / 服务账号 Key 要额外发送 `anthropic-workspace-id`，Wevir 暂未提供该字段。网关继续使用官方仍支持的 legacy `x-api-key`，不同时发送 Authorization；不接订阅套餐。

```json
{
  "id": "anthropic",
  "kind": "openai-compatible",
  "displayName": "Anthropic",
  "api": "anthropic-messages",
  "baseURL": "https://api.anthropic.com",
  "compat": { "thinkingFormat": "adaptive", "systemMessageMode": "inline" },
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

Opus 5.5 / Haiku 5.5 的默认 effort 为 medium，Sonnet 5.5 / Fable 5.1 为 high，网关总是显式发送。Opus / Fable 不能关闭思考；Sonnet 的最低模式 between_tools 仍在工具间思考。模板保持五档、不列 off。旧配置或外部请求传入 none 时，网关按型号用 adaptive / between_tools / disabled 并显式 low，避免发送不合法的 disabled。Opus / Sonnet / Fable 的 forced tool_choice 改 auto，Haiku 保留；采样与 system 的位置规则见 model-gateway.md §5。

**已有 Provider 不自动迁移。** 原来的官方地址、协议、四款模型与默认模型不用改，网关会按地址识别限制。通过代理使用旧 Provider 时，经 `provider.upsert` 提交原配置并把 `compat` 与上例的两个字段合并；保留自己的其他 compat、模型与地址，省略 apiKey 以保留已存 Key。原来显式配置了 `systemMessageMode: user` 的继续按 user 工作；要使用 system 角色请手动改 inline。若用的是 Claude 4.5 及更早型号，保持 `thinkingFormat: enabled` 与旧的 user 模式，不照抄当前模板；这些旧型号的 effort 支持局限见 model-gateway.md §10。

来源与核对日期：**2026-10-15 已核对** [模型目录](https://platform.claude.com/docs/en/models/overview)、[effort](https://platform.claude.com/docs/en/build-with-claude/effort)、[认证](https://platform.claude.com/docs/en/manage-claude/authentication)、[思考模式与限制](https://platform.claude.com/docs/en/build-with-claude/thinking)、[手动思考的兼容性](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)、[中途 system](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)、[思考前缀](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)。当前没有提供 `WEVIR_TEST_API_KEY`，Sonnet / Opus 的契约第 3 层与桌面端 apply_patch 对话未验收；本地录制请求与严格 HTTP mock 通过不代表真实服务通过。

桌面端的首次引导（U6，`apps/desktop/src/renderer/src/onboarding/`）与“更多”对话框按 `settings/provider-catalog.ts` 列出服务：国际（OpenAI、Anthropic、Google AI Studio、Google Vertex AI、xAI）、国内（DeepSeek 官方、通义千问、Kimi、智谱 GLM）、本地与自定义（Ollama、空白的 OpenAI 兼容表单）。Google Vertex AI 使用服务账号（§7.11），Host 声明 google_vertex 后可选；旧 Host 的入口提示更新后台服务。

### 7.10 已有 Chat Provider 的思考配置

选择 Chat 是为了服务只提供 Chat 端点，或当前 API Key 不能使用它的 Responses 端点。已有 Provider 不自动迁移；通过 `provider.upsert` 编辑原有 Profile、保留地址与模型，按服务补 compat，例如智谱 / Z.ai 用 `{"thinkingFormat":"zai","toolChoice":"auto_only"}`，MiniMax 用 `{"thinkingFormat":"minimax"}`，TokenHub 用 `{"thinkingFormat":"tencent","toolChoice":"auto_only"}`。这些是按量端点的配置片段，不是订阅套餐模板；minimax / tencent 格式目前只适用于 Codex 引擎。

模型目录只声明厂商支持的 reasoningEfforts，不能关闭思考的模型不列 off。Kimi K3 在 Chat 上用 openai 或 deepseek 格式（只发 reasoning_effort），K2.6 用 deepseek 格式（thinking.type 与 keep: all）；模型特例与 MiniMax 的原始思考回传见 model-gateway.md §4.4。provider.test 不带 reasoning.effort，仅验证最小连接，不能证明工具调用后的第二步、推理回传或强制思考模型的小输出上限可用。

来源与核对日期：2026-10-15，[Z.ai Chat 参数](https://docs.z.ai/api-reference/llm/chat-completion)、[Kimi 思考模型](https://platform.kimi.com/docs/guide/use-thinking-models.md)、[MiniMax Chat 参数](https://platform.minimax.io/docs/api-reference/text-openai-api)、[MiniMax 工具指南](https://platform.minimax.cn/docs/guides/text-m3-function-call)、[TokenHub Chat 字段](https://intl.cloud.tencent.com/zh/document/product/1300/82345)。本次没有真实 API Key，仍需逐服务验证；大陆网络与地域说明沿用各服务节，在正式更新模板时再核对。

### 7.11 Google Cloud（Vertex AI / Gemini Enterprise Agent Platform）

**2026-10-15 核对。** 使用独立的 `google-vertex` kind 与服务账号认证，只有 Codex 网关支持（领域模型 §3.2、Host API 0.21.0）。Gemini 官方提供 OpenAI Chat 兼容端点，故复用 Responses → Chat 转换；Claude 官方接口是 Messages 的变体，故复用 Messages 转换并改变 URL 与版本字段。不使用原生 generateContent、express API Key、ADC 或本机 gcloud 凭据。只接按量计费的 Gemini 与 Claude，不接 Model Garden 的其他发布方。

在 [Google Cloud 控制台](https://console.cloud.google.com/vertex-ai) 为目标项目启用计费与 Vertex AI API，开通所选模型的访问权限，给服务账号目标项目的 Vertex AI 调用权限（如 Vertex AI User）。项目可以与服务账号所属项目不同。将用户已有的服务账号 JSON 文件导入桌面表单，或粘贴完整 JSON；输入被掩码，只显示 client_email，之后编辑时留空保留凭据。整份 JSON 只在 SecretStore，SQLite 只保存 project/location，令牌与私钥不交给 Codex。

默认地域 `global`。Gemini 3.8 Flash 的当前按量地域是 global / us / eu，Claude 当前模板模型也使用这三种；Claude 的 us / eu 相比 global 加价 10%，具体地域只支持 Sonnet 4.6 及更早型号，应先查模型可用地域再手动换模型。Google Cloud 没有中国大陆地域，googleapis.com 在大陆无法直连；需要可访问 Google Cloud 的网络。网关的代理局限见 §6.3。

Gemini 示例（密钥只通过 serviceAccountJson 传入 SecretStore；下例的占位符不是实际密钥）：

```json
{
  "id": "google-vertex",
  "kind": "google-vertex",
  "displayName": "Google Vertex AI",
  "api": "openai-completions",
  "vertex": { "project": "your-project-id", "location": "global" },
  "models": [
    { "id": "google/gemini-3.8-flash", "contextWindow": 1048576, "maxTokens": 65536, "supportsImages": true, "reasoningEfforts": ["low", "medium", "high"] }
  ],
  "defaultModelId": "google/gemini-3.8-flash",
  "serviceAccountJson": "<完整服务账号 JSON>"
}
```

不要填写 baseURL 或 apiKey。网关生成 global 的 `https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/endpoints/openapi/chat/completions`，其他地域使用 `https://{location}-aiplatform.googleapis.com/v1beta1/projects/{project}/locations/{location}/endpoints/openapi/chat/completions`。Gemini 模型 ID 要带 `google/`。官方兼容指南仍以 3.5 Flash 举例，本模板以当天 Model Garden 的 3.8 Flash 为准；该型号拒绝 minimal，不能关闭思考，所以只列 low / medium / high，thought signature 按 model-gateway.md §4.5 带回。旧型号可手动填写其官方 ID 与支持档位。

Claude 另建一个 Provider（同一服务账号可复用；桌面表单选择 Claude 会填好以下模型）：

```json
{
  "id": "google-vertex-claude",
  "kind": "google-vertex",
  "displayName": "Google Vertex AI · Claude",
  "api": "anthropic-messages",
  "vertex": { "project": "your-project-id", "location": "global" },
  "compat": { "thinkingFormat": "adaptive", "systemMessageMode": "inline" },
  "models": [
    { "id": "claude-sonnet-5-5", "contextWindow": 1000000, "maxTokens": 128000, "supportsImages": true, "reasoningEfforts": ["low", "medium", "high", "xhigh", "max"] },
    { "id": "claude-opus-5-5", "contextWindow": 1000000, "maxTokens": 128000, "supportsImages": true, "reasoningEfforts": ["low", "medium", "high", "xhigh", "max"] }
  ],
  "defaultModelId": "claude-sonnet-5-5",
  "serviceAccountJson": "<完整服务账号 JSON>"
}
```

地址为 `https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/publishers/anthropic/models/{model}:streamRawPredict`（其他 location 换成地域域名），模型不进正文，正文另带 anthropic_version: vertex-2023-10-16。新模型使用第一方 ID，旧型号的 @日期后缀照官方列表填写。只发 Bearer 访问令牌；不发 x-api-key 或 anthropic-version。工具、签名与思考沿用 Messages 转换；URL 图片在联网前报错，内嵌图片可以使用。转换后正文上限 30 MB；Files、Batches、Models API 不在网关范围内。

**已有配置不自动迁移。** 目录原先不能新建 Vertex，没有旧的 Vertex 模板。手动建过 openai-compatible / 静态令牌配置的用户应新建 google-vertex Provider，填写 project/location 与完整服务账号；kind 创建后不可改，旧 Profile 与会话继续保留原配置。需要改模型、地域或凭据时手动编辑，凭据留空即保留。

来源：[OpenAI 兼容接口](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/openai)、[认证](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/migrate/openai/auth-and-credentials)、[服务账号 JWT bearer](https://developers.google.com/identity/protocols/oauth2/service-account)、[API Key](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/api-keys)、[express 模式 API 范围](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/express-mode/vertex-ai-express-mode-api-reference)、[地域 Chat 示例](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/migrate/openai/examples)、[Gemini 3.8 Flash](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-8-flash)、[Claude on Google Cloud](https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai)、[Claude REST 调用](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude/use-claude)。上述 Google 旧路径会重定向到新品牌路径，API 域名仍为 aiplatform.googleapis.com。

本地覆盖 RS256 JWT、并发与刷新、两种协议的录制请求与工具签名往返、认证错误与脱敏。尚未提供启用 Vertex 的 GCP 项目及服务账号，Gemini / Claude 的契约第 3 层与桌面端 apply_patch 都未验收；命令见 development.md §6.3。

Claude 模型的 1M 上下文、128K 输出与五档力度同时核对了 [模型目录](https://platform.claude.com/docs/en/models/overview)与 [effort](https://platform.claude.com/docs/en/build-with-claude/effort)（2026-10-15）；平台 ID 与地域以上面的 Google Cloud 文档为准。


### 7.12 Azure OpenAI / Microsoft Foundry

**2026-10-15 核对。** 按微软的 [Codex 指南](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/codex)为 OpenAI 部署使用 v1 Responses 透传；Foundry Claude 的原生接口是 Messages，使用网关现有转换。目录直接列“Azure OpenAI”与“Azure Claude”两项，位于“国际”，Key 都从 [Foundry](https://ai.azure.com)的部署详情取得。只接按量服务，不需要新 Provider kind 或协议字段。

**必须填写资源名和部署名。** 模板中的尖括号是待填写内容；设置页与首次引导会立即标出，未替换不能保存。地址与模型 ID 的通用检查也识别花括号和 URL 编码的占位。两种协议的 model 都是自己的部署名，可能与模型 ID 相同，也可能是自定义别名；网关不重写它。填写部署名后保留模板对应的窗口、输出与推理档位，删除未部署的行，默认模型跟随选中的那一行。修改其他普通模型 ID 仍清除旧型号的额外能力声明。旧 Provider 不自动套模板或迁移。

OpenAI 示例（将所有占位替换为实际值；下面只列一个部署，模板另有 Astra 与 Luna）：

```json
{
  "id": "azure-openai",
  "kind": "openai-compatible",
  "displayName": "Azure OpenAI",
  "api": "openai-responses",
  "baseURL": "https://<resource>.openai.azure.com/openai/v1",
  "models": [
    { "id": "<gpt-6.1-sol-deployment>", "displayName": "GPT-6.1 Sol", "contextWindow": 1050000, "maxTokens": 128000, "supportsImages": true, "reasoningEfforts": ["low", "medium", "high", "xhigh", "max"] }
  ],
  "defaultModelId": "<gpt-6.1-sol-deployment>",
  "apiKey": "<Azure resource API Key>"
}
```

- **地址与认证。** 不加 api-version。微软明确支持资源的 openai.azure.com 与 services.ai.azure.com 两种 `/openai/v1` 地址。网关与标志也识别资源的 cognitiveservices.azure.com 域名，但当天 v1 页面未独立确认第三种地址的等价性，须复制部署详情给出的端点。资源 Key 仍以 Authorization: Bearer 发送：这是按微软 OpenAI SDK 与 Codex env_key 示例推断的行为，没有 Key 可实测；微软 REST 示例用 api-key，不能把本次本机 mock 当成服务支持 Bearer 的证据。
- **模型与推理。** Sol 6.1、Astra、Luna 均在当天 Azure Responses 支持列表中。Sol / Astra 为 low–max，Luna 另有 off（交给 Codex 为 none）；窗口、图片输入与输出声明同 §7.8 的模型能力，具体部署可用性以控制台为准。gpt-6.1-sol 的部署名是示例，不是通用可用的资源部署。
- **无状态历史与工具。** store: false 时显式 include reasoning.encrypted_content，网关只在缺失时追加。非空加密推理、custom apply_patch、缓存键、content_filters 原样透传；只为 Azure 补 namespace 的空描述。锁定 Codex 不开启 collaboration / Responses Lite，依据见 model-gateway.md §10。内容过滤的 HTTP 400 与 content_filter code 保留。custom / namespace 的实际支持仍待真实部署验证。

Foundry Claude 示例（模板另列 Opus / Haiku 5.5，不列预览 Fable 与仅支持 Entra 的 Mythos）：

```json
{
  "id": "azure-claude",
  "kind": "openai-compatible",
  "displayName": "Azure Claude",
  "api": "anthropic-messages",
  "baseURL": "https://<resource>.services.ai.azure.com/anthropic",
  "compat": { "thinkingFormat": "adaptive", "systemMessageMode": "inline" },
  "models": [
    { "id": "<claude-sonnet-5-5-deployment>", "displayName": "Claude Sonnet 5.5", "contextWindow": 1000000, "maxTokens": 128000, "supportsImages": true, "reasoningEfforts": ["low", "medium", "high", "xhigh", "max"] }
  ],
  "defaultModelId": "<claude-sonnet-5-5-deployment>",
  "apiKey": "<Azure resource API Key>"
}
```

请求发到上述地址的 `/v1/messages`，用 x-api-key 与 anthropic-version: 2023-06-01。三款当前 GA Claude 均为 1M / 128K、五档 effort；不提供 off。Azure Marketplace 的用量付费资格、模型订阅与部署地域必须满足控制台要求；Global Standard 与部分型号的 US Data Zone 可用。新版文档区分 Azure 托管和 Anthropic 基础设施托管，并通过 CCU 计费，需按实际部署核对。Fable 5.1 仍为预览，而且微软当前 effort 表不认 max，因此不沿用官方 Anthropic 模板的四款模型与统一五档声明。

Claude 工具、思考签名与跨回合历史复用现有 Messages 规则（model-gateway.md §5）。Foundry Messages 地址在未显式设置 thinkingFormat 时默认 adaptive，部署别名不会误用 enabled；显式配置优先，旧 Claude 部署可手动选择 enabled。型号专用的 forced choice / 采样 / 默认 effort / 中途 system 判断依赖模型 ID 前缀；完全自定义的部署别名无法据名称识别实际型号。模板显式 adaptive 确保开启档位仍用 adaptive，inline 在无法识别时按 user 回退，未指定 effort 时由服务决定默认。不要把某款型号的占位行改指向另一款模型并沿用其能力；完全自定义别名的特殊限制仍须真实部署验证。

**地域与范围。** 这里是 Azure 全球资源，中国大陆能否直连尚未确认；十种语言的模板说明均标明这一点。不支持 Entra ID、世纪互联 Azure 中国、旧 `/openai/deployments/…?api-version=…` 或 `/api/projects/…` 路由；不增加 Foundry 托管的其他厂商模型模板。旧手动配置可在设置中将协议、baseURL、模型列表及默认部署名改为上述形式；Claude 合并上例 compat，保留其他自己的设置，Key 留空即保留已存 Key。建议重新测试连接并新建会话。

来源（2026-10-15）：[v1 生命周期](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)、[Responses 与支持模型](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses)、[Codex](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/codex)、[Claude 型号与能力](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/claude-models)、[部署与使用 Claude](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude)、[Foundry Responses](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/generate-responses)。

本地使用录制 Codex 请求与 HTTP mock 覆盖两条路、认证头、namespace 描述、加密推理、工具与签名往返、内容过滤和连接测试。未提供资源地址、部署名与 WEVIR_TEST_API_KEY，Responses / Claude 的真实契约第 3 层和 pnpm dev 中经 apply_patch 改文件均未验收，命令见 development.md §6.3。
