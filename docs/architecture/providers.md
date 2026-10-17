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

Codex 网关的工具方言默认值是 Provider 显式 compat > 地址默认 > 全局默认（model-gateway.md §4.4；地址表含 xAI、百炼按量端点、DeepSeek 的 Responses / Chat 路由及 Ollama / Kimi / Z.ai / 智谱 Responses；Z.ai / 智谱 Chat 也默认 auto_only）。模板是新建 Provider 的初始值，已存的 Profile 不自动迁移；使用反向代理时可手动在 `provider.upsert` 的 compat 写 `supportsNamespaceTools: false`、`supportsCustomTools: false` 或 `toolChoice: auto_only`（工具选择的 none 规则见 model-gateway.md §3.2），桌面表单原样保留、暂不提供开关控件。Azure 的按地址请求修正见 model-gateway.md §3.5；Kimi Responses 的非 data URL 图片过滤仅按开放平台地址生效，代理需自行满足 data URL 要求。

Phala / RedPill 的已核对地址在 Codex Responses 上也补保守的 custom / namespace 摊平与 auto_only（model-gateway.md §3.10）；显式 compat 优先。这里只影响网关，不改变 dsh 的默认值。

MiMo 的 xiaomimimo.com 及子域仅在 Responses 上补 custom / namespace 摊平与 auto_only，排除 token-plan / token-plan-* 套餐主机名；显式 compat 优先。普通模式不支持原生 custom，Lite 请求与 namespace 的验收边界见 model-gateway.md §3.11；不改变 Chat / Messages 或 dsh。

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

Codex 网关另识别 Phala / RedPill 的 404 not_found_error 与 503 upstream verification failed（service_unavailable）：分别返回 `phala_no_route`、`phala_attestation_unavailable` 的 error.code，reason 为 server，避免当作地址或协议填写错误。HTTP 状态与脱敏原文保留；普通 404、未知模型与普通 503 不套用此说明。桌面连接测试与会话均有对应的本地化提示，见 model-gateway.md §3.10。

### 6.3 局限

- 只验证地址、协议、Key 与模型能对上；不验证 compat 是否适合 dsh 真正发的请求（带系统提示词、工具、推理参数），这类问题在第一次对话时以 `provider` 类错误暴露（acp-event-mapping.md §3）。
- Host 进程里的 `fetch` 不读 `HTTPS_PROXY` 等代理变量（dsh 子进程的代理行为由 dsh 决定）。需要代理才能访问的服务，`provider.test` 可能报 `network` / `timeout` 而对话正常。
- 模型不存在的判断依赖错误原文，服务改措辞会落到 `protocol` 或 `unknown`。

## 7. 服务示例

以下是 `provider.upsert` 的参数。**`baseURL` 与模型 ID 以各服务当前的官方文档为准**，这里的值是 2026-10 核对的（来源见每节），上下文与最大输出按各节的模型文档填写。每个模型都填 `contextWindow`：Codex 引擎按它自动压缩（窗口的九成）并显示上下文用量，没填按 128k 估算（codex-event-mapping.md §3“上下文大小”）。2026-10-15 对照各家官方模型页核对过桌面端全部预设（`provider-presets.ts`）的上下文长度，后续复核日期以各节为准；本机 Ollama 取决于自己的运行配置（§7.5）。几处官方写法：OpenAI 与 Azure 的 GPT-6 系列 1,050,000 是输入加输出，输入上限 922,000、输出 128,000；百炼 qwen3.8 / 3.7 的 1,000,000 里输入上限 991,808（思考模式 983,616）；Kimi K3 按官方 Codex 指南填 1,048,576（§7.3）；DeepSeek 模型页写“1M”，2026-10-16 按官方 Codex 目录的明确数值 1,048,576 填（§7.1）；Anthropic 的 1M 是 Claude 5.5 系列的默认，不用 beta 头；gemini-4-argon 的 1,048,576 是输入输出共用。智谱与 Z.ai 的 GLM-5.3 系列按官方 Codex 目录的 1,048,576 填（§7.4）。非 `api.openai.com` 的地址会按 §2.3 补默认 compat；Codex 网关的开关另见 model-gateway.md §4.4。

### 7.1 DeepSeek

**2026-10-16 核对。** 首选 `deepseek-official`：Codex 按 DeepSeek 的官方 Codex 指南，经网关透传到 `https://api.deepseek.com/responses`，保留原生 apply_patch 与明文推理历史。这个 kind 的可选 baseURL 仍只供 dsh 的 Messages 路由使用，不能用它更改 Codex 的 Responses 地址；需要代理时另建 `openai-compatible` + `openai-responses`。本次不改 dsh 引擎。

新建官方 Provider 显式填入模型目录（Codex 要求非空），默认 Flash；两个模型均可关闭思考、支持 low / high / max，未选档位时由 DeepSeek 默认 high。Flash 收图片，V4 Pro 只收文本。窗口按官方 Codex models.json 的 **1,048,576**，比模型页笼统写的 1M 更精确；不照抄其中的基础提示词、shell、multi-agent V2 或搜索开关，保留 Wevir 的执行与加固设置。

```json
{
  "id": "deepseek-official",
  "kind": "deepseek-official",
  "displayName": "DeepSeek",
  "models": [
    { "id": "deepseek-flash", "contextWindow": 1048576, "supportsImages": true, "reasoningEfforts": ["off", "low", "high", "max"] },
    { "id": "deepseek-v4-pro", "contextWindow": 1048576, "reasoningEfforts": ["off", "low", "high", "max"] }
  ],
  "defaultModelId": "deepseek-flash",
  "apiKey": "<DeepSeek API Key>"
}
```

也可以选“DeepSeek（OpenAI 兼容）”，由 Codex 网关转 Chat。模板显式声明思考格式、历史推理与工具选择，经代理改地址也保留；官方地址的 Responses / Chat 路由默认使用 auto_only（显式 compat 优先），Messages 保持原规则。Chat 文档明确写出思考时 required / 具名选择会 400；Responses 文档只列支持，**2026-10-16 真实 Key 实测两个模型在 high 下也返回 400，错误为思考模式不支持该 tool_choice，同请求改 auto 后均为 200 并调用工具**，因此同样降级（model-gateway.md §3.6）。auto_only 也会去掉 none、保留工具，不能保证禁止调用。

```json
{
  "id": "deepseek-openai",
  "kind": "openai-compatible",
  "displayName": "DeepSeek（OpenAI 兼容）",
  "api": "openai-completions",
  "baseURL": "https://api.deepseek.com",
  "compat": {
    "thinkingFormat": "deepseek",
    "requiresReasoningContentOnAssistantMessages": true,
    "toolChoice": "auto_only"
  },
  "models": [
    { "id": "deepseek-flash", "contextWindow": 1048576, "supportsImages": true, "reasoningEfforts": ["off", "low", "high", "max"] },
    { "id": "deepseek-v4-pro", "contextWindow": 1048576, "reasoningEfforts": ["off", "low", "high", "max"] }
  ],
  "defaultModelId": "deepseek-flash",
  "apiKey": "<DeepSeek API Key>"
}
```

- **输出上限。** 两个模板均不填 maxTokens。模型页最大输出为 384K，Chat 参考明确为 393,216；Chat 未设置时非思考默认 8K、思考 64K、max 档 128K。Responses 参考只说 max_output_tokens 包含思考与正文，没有独立声明默认数值，不能把 Chat 默认当成 Responses 已验证的行为。锁定 Codex 不发送 max_output_tokens，模型目录的 maxTokens 也不会自动进入 Responses / Chat 请求；只填 384K 不能解除截断。保留服务默认，不主动提高每次请求的输出预算；长回答是否触及 Responses 默认上限仍待真实样本，不声称已经解决。
- **历史与工具。** Responses 是无状态 API，store / include / previous_response_id 等不受支持的字段静默忽略；每次发送完整历史。reasoning 的明文 content 带回，summary / encrypted_content 不支持；只清理通用 null 键。custom 工具只认 apply_patch；namespace 的历史 Spike 与本轮两个模型的子智能体契约均通过，当前官方文档未声明它，不额外摊平。Chat 会完整带回所有 assistant 的 reasoning_content，不能只带最近一步。
- **地域与目录。** 按量 API，中国大陆可直连；Key 从 [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) 创建。两个入口均在“国内”，复用已有 LobeHub DeepSeek 标志。旧的 deepseek-v4-flash / deepseek-v4-flash-vision-exp 别名现由 Flash 服务，新模板只列 deepseek-flash 与 deepseek-v4-pro。
- **旧 Provider 手动修改。** 不迁移已存 Profile。已有 Chat Provider 可在设置中更新模型窗口为 1048576，按上例补 low 与 compat（compat 经 provider.upsert 合并，Key 省略即可保留）；只改窗口不会自动增加档位。已有官方 Provider 若 models 为空，可经 provider.upsert 提交上例的非空目录并省略 apiKey；桌面官方表单保留旧 models，不会自动替换。改完重新测试连接并新建会话。
- **真实验收（2026-10-16）。** Flash 与 V4 Pro 的网关测试各 11 项通过（Responses / Chat / Messages、testProvider、工具与跨回合历史、forced choice 的 400 → 200），Codex 契约第 3 层各 23 项通过。`pnpm dev` 中通过官方模板的 Flash / high、Chat 模板的 V4 Pro / low，各用 apply_patch 写出预期文件并正常完成；另核对了档位切换、目录与表单、1280px / 960px 视口。临时 Host 仅将 SecretStore 改为内存，使用真实 Codex 与 DeepSeek；检查临时数据无 Key、无 secrets.json。未生成长达输出上限的回答，Responses 的实际默认输出上限仍未验证。已存 Provider 不迁移。

来源（2026-10-16）：[Codex 与 models.json](https://api-docs.deepseek.com/quick_start/agent_integrations/codex)、[Responses 指南](https://api-docs.deepseek.com/guides/responses_api)、[Responses 参数](https://api-docs.deepseek.com/api/create-response)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode)、[Chat 参数](https://api-docs.deepseek.com/api/create-chat-completion)、[Anthropic 兼容](https://api-docs.deepseek.com/guides/anthropic_api)、[模型与最大输出](https://api-docs.deepseek.com/quick_start/pricing)。

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

### 7.3 Kimi（月之暗面开放平台，按量计费）

2026-10-17 对照[官方 Codex 指南](https://platform.kimi.com/docs/guide/codex-kimi.md)，模板改用 Responses 透传，保留原生 apply_patch 与 namespace，无需经过 Chat 或 Messages 转换。国内站 API 地址未变，控制台与文档已经迁到 platform.kimi.com。

```json
{
  "id": "kimi",
  "kind": "openai-compatible",
  "displayName": "Kimi",
  "api": "openai-responses",
  "baseURL": "https://api.moonshot.cn/v1",
  "compat": { "toolChoice": "auto_only" },
  "models": [
    {
      "id": "kimi-k3",
      "contextWindow": 1048576,
      "maxTokens": 1048576,
      "supportsImages": true,
      "reasoningEfforts": ["low", "high", "max"]
    }
  ],
  "defaultModelId": "kimi-k3",
  "apiKey": "<Kimi 开放平台 API Key>"
}
```

- **地域与 Key。** 默认国内站，中国大陆可直连；在 [platform.kimi.com](https://platform.kimi.com/console/api-keys) 创建 Key。国际站控制台是 [platform.kimi.ai](https://platform.kimi.ai)，API 为 `https://api.moonshot.ai/v1`。国内与国际站 Key 不通用，切换地址时必须换成对应站点的 Key。只接开放平台按量计费服务，不接 Kimi Code 会员的 Key、模型或地址；dsh 的 pi-ai 目录条目不变。
- **模型范围。** 当前 Responses 参数页明确写着“本接口当前支持 kimi-k3”，因此本模板只列 K3。模型列表中的 K2.7-code、K2.7-code-highspeed 与 K2.6 仍可用于各自支持的接口，不能从 Chat 的 thinking 参数推断为 Responses 支持。K2.5、moonshot-v1 系列已于 2026-08-31 下线。
- **思考与输出。** K3 始终思考，Responses 使用 reasoning.effort: low / high / max，默认 max；没有 off，也不发送 Chat 的 thinking / reasoning_effort。上下文按官方 Codex 指南填 1048576。maxTokens 记录服务允许设置的最大输出 1048576；Codex 当前不发送 max_output_tokens，网关不从目录补它，实际服务默认输出上限仍为 131072。Chat 的“带工具时 max_tokens 至少 16000”不套用于 Responses 的连接探测。
- **工具与历史。** 官方支持 function、custom（仅 Lark 语法的 apply_patch）、namespace 与一个 web_search。网关仅按地址补 toolChoice: auto_only，不摊平 custom 或 namespace；模板显式写同一选择，反向代理仍可用。显式 compat 优先，none 只去掉 tool_choice、保留工具，不能保证禁止调用。每步携带完整历史，reasoning 的 content / summary 原样保留，由服务按 content 优先回放；encrypted_content 固定 null，Codex 带回的 null 键由通用修正去掉。不依赖服务端存储或 previous_response_id。
- **图片与缓存限制。** 仅支持 data URL。锁定 Codex 的本地附件与 view_image 输出均为 data URL；网址图片与 file_id 图片由 Kimi Responses 方言从用户消息和工具输出数组中丢掉，网关不下载外部资源。只含这些图片的数组会变空，需改为内嵌图片再发；代理地址没有这项过滤。prompt_cache_key 与自动缓存配置原样保留；不注入 prompt_cache_breakpoint，外部请求带入该项时仍会收到官方规定的 400。详见 model-gateway.md §3.8。
- **旧 Provider 手动修改。** 已存的 Chat + kimi-k2.6 配置不会套新模板。可在“设置 → 模型服务 → 添加”重新选择 Kimi 模板，以完整保存 K3 的图片、上下文与三档推理，再测试连接并新建会话。若需沿用原 Provider ID，经 provider.upsert 按上例更新 api、baseURL、models、defaultModelId 与 compat；使用同站已存 Key 时省略 apiKey，Host 会保留它，换站则提供对应站点的 Key。桌面编辑表单只编辑模型 ID、上下文和图片，不能补齐 reasoningEfforts / maxTokens 或编辑 compat。旧的 thinkingFormat: deepseek 只供 Chat 使用，手动更新 compat 为上例即可移除；显式 toolChoice: any 会覆盖地址默认。保留原 Chat Profile 也不会被自动改动。
- **验收边界。** 录制 Codex 请求与本机 HTTP mock 覆盖两站地址、非 auto 的 400 与默认修正、原生工具和多步推理回放、图片过滤、响应字节透传及 provider.test。没有 WEVIR_TEST_API_KEY，K3 的契约第 3 层与桌面 apply_patch 未验收；不对未确认支持的 K2.7-code 运行 Responses 契约。命令见 development.md §6.3。

来源与核对日期：2026-10-17，[Responses](https://platform.kimi.com/docs/api/responses.md)、[Codex 指南](https://platform.kimi.com/docs/guide/codex-kimi.md)、[模型列表](https://platform.kimi.com/docs/models.md)、[思考模型](https://platform.kimi.com/docs/guide/use-thinking-models.md)、[Chat](https://platform.kimi.com/docs/api/chat.md)、[Messages](https://platform.kimi.com/docs/api/messages.md)。后两种接口仅用于核对协议差异，本次没有新增它们的模板或方言。

### 7.4 智谱 GLM 与 Z.ai（按量 API）

**2026-10-17 核对。** 两站接口相同、账号与 Key 分开。按两站官方 Codex 指南使用 `/api/v1/responses` 透传，保留原生 freeform apply_patch 与完整推理历史。指南本身以套餐为例；本接法只用标准 API Key，按量 Key 的 Responses 可用性仍待真实验证，不据此接入套餐。

| 模板 | 分组与地域 | baseURL | 标准 API Key |
|---|---|---|---|
| Z.ai（`zai`） | 国际站；中国大陆直连未验证，建议使用国内智谱 | `https://api.z.ai/api/v1` | [Z.ai API Keys](https://z.ai/manage-apikey/apikey-list) 中的 Standard API Key |
| 智谱 GLM（`zhipu`） | 国内站；中国大陆可直连 | `https://open.bigmodel.cn/api/v1` | [智谱标准 API Key](https://bigmodel.cn/usercenter/proj-mgmt/apikeys) |

两模板共用下面的模型与 compat，默认 GLM-5.3；国内模板使用上表中的 id、displayName、baseURL 与国内 Key。

```json
{
  "id": "zai",
  "kind": "openai-compatible",
  "displayName": "Z.ai",
  "api": "openai-responses",
  "baseURL": "https://api.z.ai/api/v1",
  "compat": {
    "supportsCustomTools": true,
    "supportsNamespaceTools": false,
    "toolChoice": "auto_only"
  },
  "models": [
    { "id": "glm-5.3", "contextWindow": 1048576, "maxTokens": 131072, "reasoningEfforts": ["low", "high", "max"] },
    { "id": "glm-5.3-flash", "contextWindow": 1048576, "maxTokens": 131072, "supportsImages": true, "reasoningEfforts": ["low", "high", "max"] }
  ],
  "defaultModelId": "glm-5.3",
  "apiKey": "<本站标准 API Key>"
}
```

- **Key 类型的新规则。** 两站 2026-10-16 的 Key 管理说明明确：新建标准 Key 与套餐 Key 分开管理，在支持的端点上按 Key 类型计费，不能靠换地址把套餐 Key 变成按量 Key。历史兼容 Key 可能继续按账号的套餐状态计费；本模板要求新建标准 Key，不使用套餐 Key 或历史兼容 Key。国内标准 Key 的官方入口现为上表的新地址。不提供 Coding Plan 的地址、模型或 Key 示例。
- **文档中的协议差异。** GLM-5.3 模型页列出 Responses，同时写明曾订阅 Coding Plan（含已过期）的账号暂时只能通过 Chat 调用模型 API；新 Key 管理页则说明标准 Key 的计费独立于套餐。没有真实标准 Key，不能断言该限制已解除。按 Codex 指南先提供 Responses 模板；若实际账号拒收 Responses，手动改为 Chat（下文），不要自动切换或迁移。
- **模型与思考。** GLM-5.3 只收文本；Flash 收图片，文本参数同 GLM-5.3。两者均强制思考，low / high / max（默认 max），不列 off。1M 窗口按 Codex 目录的 1048576 记录；128K 最大输出按 Chat 参数的 131072 记录。目录 maxTokens 不会自动写入透传请求，Codex 当前不发 max_output_tokens；Responses 默认输出预算未实测。Flash 的 Responses 图片输入能力也待真实验证；不增加视频、文件或音频输入。
- **工具与历史。** 按官方 Codex 目录保留 custom apply_patch；namespace 无官方声明、无真实 Key 证据，先保守摊平并还原，显式 supportsNamespaceTools: true 可覆盖。Responses / Chat 默认 toolChoice: auto_only；none 会被去掉而保留工具，不能保证禁止调用。地址识别只匹配 z.ai / bigmodel.cn 及子域的标准 `/api/v1`、`/api/paas/v4` 路径，套餐域名与路径不补默认值。反向代理需显式声明 compat。推理明文、summary、非空 encrypted_content、store 与缓存字段原样保留，仅清理通用 null 键；不把 Chat 的 thinking 参数注入 Responses。
- **已有 Chat 与手动兜底。** Chat 的标准 baseURL 分别是 `https://api.z.ai/api/paas/v4`、`https://open.bigmodel.cn/api/paas/v4`，协议为 openai-completions，显式设置 `compat: {"thinkingFormat":"zai","toolChoice":"auto_only"}`。网关沿用既有 zai 格式：thinking.type: enabled、clear_thinking: false、顶层 reasoning_effort，完整原样带回每段 assistant 的 reasoning_content。GLM-5.3 系列的 none 降 low。Chat 只收 auto、最多 128 个函数、函数名 1–64 个字母数字下划线或连字符；摊平使用既有命名规则，不截断工具清单。
- **旧 Provider 手动修改。** 已存的 zhipu Chat + glm-4.5 不自动迁移。在“设置 → 模型服务”编辑原 Profile：协议改 Responses、地址改为本站 `/api/v1`、模型与默认项改为上例，并换用本站标准 Key；经 provider.upsert 补上上述 compat。原有 thinkingFormat: zai 仅供 Chat 使用，可保留或手动移除。若继续使用 Chat，只更新模型、窗口、三档力度并按上段设置 compat。重新测试连接，再新建会话；显式 compat 优先于地址默认，不会被模板覆盖。
- **验收边界。** `zai.test.ts` 使用四份录制请求，`zai.integration.test.ts` 的严格 HTTP mock 验证非 auto / namespace 的拒绝与修正、原生 apply_patch、推理与工具结果往返、同路由 provider.test。没有两站的标准 Key，真实契约第 3 层与 pnpm dev 的 apply_patch 对话未验收；namespace 原生支持、Flash 图片、缓存字段与 Responses 输出预算仍待验证。命令见 development.md §6.3。Z.ai 标志取自同版本 LobeHub 的 zai.svg，国内站沿用 zhipu-color.svg。

来源（2026-10-17）：[Z.ai Codex](https://docs.z.ai/devpack/tool/codex)、[智谱 Codex](https://docs.bigmodel.cn/cn/coding-plan/tool/codex)、[Z.ai GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3)、[智谱 GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)、[Z.ai Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash)、[智谱 Flash](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash)、[Chat 参数](https://docs.z.ai/api-reference/llm/chat-completion)、[思考模式](https://docs.z.ai/guides/capabilities/thinking-mode)、[Z.ai Key 新规则](https://docs.z.ai/devpack/notice/api-key-management)、[智谱 Key 新规则](https://docs.bigmodel.cn/cn/coding-plan/notice/api-key-management)。当前没有独立的 Responses 参数参考，Chat 的限制不能视为 Responses 的实测能力。

### 7.5 Ollama 本机与 Ollama Cloud

**2026-10-16 核对。** 按 [Ollama 的 Codex 指南](https://docs.ollama.com/integrations/codex)改用 Responses 透传：本机从 0.13.3 起支持无状态 `/v1/responses`，不使用 previous_response_id、conversation 或 truncation。模板不预填未安装的模型，先在表单点“读取模型”，再勾选支持工具的模型；也可以手动添加。

```json
{
  "id": "local-ollama",
  "kind": "openai-compatible",
  "displayName": "本机 Ollama",
  "api": "openai-responses",
  "baseURL": "http://127.0.0.1:11434/v1",
  "compat": { "supportsCustomTools": false, "toolChoice": "auto_only" },
  "models": [{ "id": "gpt-oss:20b", "contextWindow": 65536, "reasoningEfforts": ["low", "medium", "high"] }],
  "defaultModelId": "gpt-oss:20b",
  "apiKey": "ollama"
}
```

- **本机。** 上面是手动配置示例，要求已自行安装对应模型，并确认实际分配了 65536 上下文。占位 Key 仍以 Authorization: Bearer 发送，本机 Ollama 忽略它；不会省略认证头。网关把 custom apply_patch 转成只有 input 字符串参数的函数，历史与响应成对还原；0.40.4 源码支持 namespace，故本机保留。低版本 Responses 端点 404 时，连接测试提示“升级 Ollama 或改用 Chat 协议”；模型不存在的 404 仍按缺模型处理。
- **发现与上下文。** Host 的 `provider.discoverModels` 读 /api/tags、/api/show 与本机 /api/ps，拿模型名、大小、参数量、量化、能力、思考档位和上下文；只访问回环主机（127.0.0.1 / localhost / ::1）或 HTTPS ollama.com，不访问局域网、自定义 DNS 名、重定向或 tags 返回的 remote_host。路径必须是 /v1；本机自定义端口可发现，但工具地址默认只识别 11434，其他端口需显式 compat。Cloud 用原名，经已登录的本机 daemon 使用时保留 tags 返回的云模型别名，不自行加减后缀。
- **实际窗口。** /api/ps 的 context_length 优先于 /api/show 参数中的 num_ctx；model_info 的 `*.context_length` 只是模型最大值，本机实际未知时不拿它填表。官方默认按显存给 4k / 32k / 256k；Agent 建议至少 64k。已知实际值不足 65536 时表单与会话显示提醒，可在 Ollama 设置中调整，或以 `OLLAMA_CONTEXT_LENGTH=65536` 重启自己的服务，之后重新读取并更新 Provider。OpenAI 兼容 API 不能按请求修改 num_ctx，Wevir 不替用户改服务、下载模型或管理进程。没有实际值时请先运行模型再核对；留空仍受通用 128k 估算规则影响，不代表 Ollama 已分配 128k。
- **思考。** 按 /api/show 的 thinking.values 列出档位；gpt-oss 的 low / medium / high 不加 off。布尔开关可用时映射到兼容接口的 none / medium；只有 false 的模型不提供思考。缺元数据时不猜型号能力，未知的自定义档位暂不提供选择。详情失败仍列出 tags，但提示手动核对。

Cloud 另有模板 `ollama-cloud`，国际分组、复用 Ollama 标志，地址 `https://ollama.com/v1`；需[官方 API Key](https://ollama.com/settings/keys)。模型从官方 /api/tags 与 /api/show 动态发现，不维护静态的过时云列表；直连使用返回的原名。Cloud 默认使用模型最大上下文；账号用量与并发限制仍由 Ollama 管理，中国大陆直连情况未确认。Cloud 明确不支持 custom/freeform 调用回放与 Responses 内置 web search；namespace 未有真实验证，模板保守声明 `supportsCustomTools: false, supportsNamespaceTools: false, toolChoice: auto_only`。显式 compat 优先于地址默认。auto_only 不保证禁止调用工具。

**旧 Provider 手动更新。** 已存的 Chat + qwen3:8b 不自动迁移。在设置 → 模型服务编辑，把协议改为 Responses，保留本机 /v1 地址，重新读取后勾选已安装的工具模型，核对上下文并选择默认模型，再测试连接、新建会话。显式旧工具 compat 不被地址默认覆盖；发现列表不会自动重写已有模型，需手动改值或取消勾选后重新勾选。旧 Host 没有 provider_model_discovery 时界面提示升级，仍能手动填写。vLLM / LM Studio 不在本节接入范围。

**验收边界。** 录制请求、本机 HTTP mock、发现元数据与安全边界测试不能代替真实 Ollama。当前机器未安装 Ollama、无已运行模型；真实契约第 3 层与桌面 apply_patch 尚未验收，安装与十几 GB 模型下载由维护者确认后自行准备。命令见 development.md §6.3。

来源（2026-10-16）：[OpenAI 兼容](https://docs.ollama.com/api/openai-compatibility)、[Anthropic 兼容](https://docs.ollama.com/api/anthropic-compatibility)、[Codex](https://docs.ollama.com/integrations/codex)、[上下文](https://docs.ollama.com/context-length)、[Cloud](https://docs.ollama.com/cloud)、[思考](https://docs.ollama.com/capabilities/thinking)、[模型列表](https://docs.ollama.com/api/tags)、[模型详情](https://docs.ollama.com/api-reference/show-model-details)、[运行模型](https://docs.ollama.com/api/ps)、[0.40.4 Responses 源码](https://github.com/ollama/ollama/blob/v0.40.4/openai/responses.go)。当前 Chat 文档已列 tool_choice；本次只给 Responses 配置 auto_only，不据旧调研修改 Chat。

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

桌面端的首次引导（U6，`apps/desktop/src/renderer/src/onboarding/`）与“更多”对话框按 `settings/provider-catalog.ts` 列出服务：国际（OpenAI、Anthropic、Google AI Studio、Google Vertex AI、xAI、Z.ai）、国内（DeepSeek 官方、通义千问、Kimi、智谱 GLM、小米 MiMo）、本地与自定义（Ollama、空白的 OpenAI 兼容表单）。Google Vertex AI 使用服务账号（§7.11），Host 声明 google_vertex 后可选；旧 Host 的入口提示更新后台服务。

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

### 7.13 RedPill / Phala Private AI

**2026-10-17 核对。** 国际按量多模型入口，模板默认 `https://api.redpill.ai/v1`，中国大陆直连尚未验证。按 [RedPill Codex 指南](https://docs.redpill.ai/guides/integrations/coding-tools/codex-cli)选择 Responses 透传；不将 Chat / Messages 参数表当作 Responses 原生工具支持的证明。Key 在 [RedPill dashboard](https://www.redpill.ai/dashboard) 创建，按预付余额计费；与模型厂商直连的 Key 不通用。

```json
{
  "id": "redpill",
  "kind": "openai-compatible",
  "displayName": "RedPill",
  "api": "openai-responses",
  "baseURL": "https://api.redpill.ai/v1",
  "compat": {
    "supportsCustomTools": false,
    "supportsNamespaceTools": false,
    "toolChoice": "auto_only"
  },
  "models": [
    { "id": "openai/gpt-5.5", "contextWindow": 1050000, "maxTokens": 128000, "supportsImages": true },
    { "id": "anthropic/claude-opus-4.8", "contextWindow": 1000000, "maxTokens": 128000, "supportsImages": true },
    { "id": "z-ai/glm-5.3", "contextWindow": 1048576, "maxTokens": 1048576 }
  ],
  "defaultModelId": "openai/gpt-5.5",
  "apiKey": "<RedPill API Key>"
}
```

模型 ID、上下文、最大输出和图片能力取自当天公开的 [RedPill /v1/models](https://api.redpill.ai/v1/models)：三款均在 supported_parameters 声明 tools / tool_choice、supported_features 声明 tools / reasoning。目录共 68 个模型，混合标准与 TEE 模型；模板中的 GPT-5.5、Opus 4.8 为非 TEE，GLM-5.3 为 is_tee: true。GPT-5.6 Sol、Claude Sonnet / Opus 5 等条目的工具能力数组尚为空，因此不据模型名字推断支持，也不列入模板；同样排除工具能力为空的 deepseek/deepseek-v4-flash-0731。目录上限不保证一次回答能达到同样的长度，maxTokens 不会给 Responses 请求补 max_output_tokens。目录不提供逐模型推理枚举，模板暂不列档位，由服务默认决定，不能据此宣称不支持思考。

**工具兼容。** Responses 文档未说明 custom / namespace / forced choice，OpenAPI 也没有定义这部分 schema；没有 Key 可确认，故保守摊平为函数并用 auto_only。声明的 compat 优先于地址默认，代理也能沿用；none 会去掉工具选择、保留工具，不能作为禁止调用的保证。完整推理与非空 encrypted_content 保留，每一步携带完整历史。原生工具、跨回合推理、缓存字段和图片的真实服务验收仍待补。

**机密边界。** 默认 api.redpill.ai 入口包含普通转发模型，不强制 TEE 或经证明的上游。is_tee 表示模型可以机密运行，不代表某次请求一定经可证明的上游；TEE 与零留存也不同。[TEE-only 端点](https://docs.redpill.ai/guides/tee-endpoint) `https://tee.redpill.ai/v1` 会强制经证明的上游，使用 RedPill Key；须先从它的 /v1/models 换成支持工具的 TEE 模型，普通模型会 404。Phala Private AI 的 [inference.phala.com/v1](https://docs.phala.com/phala-cloud/confidential-ai/confidential-model/confidential-ai-api.md) 目录当天有 22 个 TEE 模型，在 Phala Cloud 的 Private AI → API Keys 取本站 Key；使用工作区 Balance，赠送余额不能支付 Private AI，不假定两站 Key 通用。只换 baseURL 不等于在本机验证过 TLS 通道。Wevir 不做证明校验、收据展示、路由约束界面或 Private AI Proxy，也不把连接成功显示成“已验证机密”。

**错误。** [路由文档](https://docs.redpill.ai/guides/error-handling)的 404 not_found_error 表示没有满足条件的路由；[经证明的路由](https://docs.redpill.ai/guides/attested-routing)的 503 service_unavailable、upstream verification failed 表示暂时没有可证明的上游。连接测试与会话分别提示检查模型 / 路由条件或稍后重试，不把它们笼统说成协议填写错误；普通路径 404、未知模型与普通 503 仍按 §6.2 处理。

**手动修改与验收。** 已有 Provider 不自动迁移。可在设置 → 模型服务编辑原配置，手动选择 Responses、填所需地址与完整模型 ID；需要摊平的代理地址通过 provider.upsert 保存上述 compat（表单会保留已有字段），或使用新模板另建 Provider。同版本 LobeHub Icons 未找到 RedPill 标志，界面使用首字母。`phala.test.ts` / `phala.integration.test.ts` 覆盖录制 Codex 请求、本机严格 HTTP mock、工具与推理往返、错误分类和脱敏；这些不能代替真实服务。当前无 WEVIR_TEST_API_KEY，契约第 3 层与 pnpm dev 中的 apply_patch 对话未验收，命令见 development.md §6.3。

来源：[Phala 按量 API](https://docs.phala.com/phala-cloud/confidential-ai/confidential-model/confidential-ai-api.md)、[RedPill Quickstart](https://docs.redpill.ai/get-started/quickstart)、[Agent 接入](https://docs.redpill.ai/get-started/use-in-agents)、[Responses](https://docs.redpill.ai/api-reference/responses)、[模型目录字段](https://docs.redpill.ai/api-reference/models)、[推理](https://docs.redpill.ai/guides/reasoning)。核对日期均为 2026-10-17。

### 7.14 Xiaomi MiMo（按量 API）

**2026-10-17 核对。** 按官方 Codex 指南使用 `https://api.xiaomimimo.com/v1/responses` 透传，保留 Responses 的完整推理历史，不经过 Chat / Messages 转换。指南当前同时给出按量 API 与套餐配置；本模板只接按量服务。国内分组显示“小米 MiMo”，中国大陆可直连，Key 从 [MiMo 开放平台](https://platform.xiaomimimo.com/#/console/api-keys)创建，使用按量 API Key，认证为 Authorization: Bearer。服务也接受 api-key 头，网关沿用现有 Bearer 方式。

```json
{
  "id": "mimo",
  "kind": "openai-compatible",
  "displayName": "小米 MiMo",
  "api": "openai-responses",
  "baseURL": "https://api.xiaomimimo.com/v1",
  "compat": {
    "supportsCustomTools": false,
    "supportsNamespaceTools": false,
    "toolChoice": "auto_only"
  },
  "models": [
    { "id": "mimo-v2.6-pro", "contextWindow": 1048576, "maxTokens": 131072, "supportsImages": true, "reasoningEfforts": ["off", "high"] },
    { "id": "mimo-v2.6-flash", "contextWindow": 1048576, "maxTokens": 131072, "supportsImages": true, "reasoningEfforts": ["off", "high"] }
  ],
  "defaultModelId": "mimo-v2.6-pro",
  "apiKey": "<MiMo 按量 API Key>"
}
```

- **模型与思考。** 默认 Pro，另列 Flash；两者支持图片理解、1048576 上下文与 131072 最大输出，窗口取官方 Codex 目录的精确数值。Responses 的默认输出上限也是 131072，maxTokens 只记录能力，不改变透传请求。reasoning.effort: none 关闭思考，其他有效值全部开启、没有力度差别，所以只列 off / high 两档，off 经 Codex 适配器变为 none。不注入 Chat 的 thinking / reasoning_effort。官方将 Ultraspeed 列为定制服务，本模板不列；2.5 系列于北京时间 2026-10-21 10:00 下线，不加入模板。
- **普通 Responses 与 Lite。** 官方 model-catalogs.json 的 V2.6 条目设置 use_responses_lite: true，并指定 code_mode_only 与 multi-agent V2；锁定 Codex 因此将工具目录放进 additional_tools 输入项，增加内部 Lite 请求头、reasoning.context: all_turns 并关闭 parallel_tool_calls。Wevir 生成的目录未启用 Lite，网关也不透传内部头，不能照搬这一配置。本接法使用普通 Responses，把 custom apply_patch 转成单个 input 字符串参数的函数，保留语法说明、回放调用与结果，再将响应还原给 Codex。不修改 Codex 或启用新的输入项，详见 model-gateway.md §3.11。
- **工具与地址默认。** 按量 xiaomimimo.com 及子域的 Responses 补上上述三个 compat 字段，排除 token-plan / token-plan-* 套餐主机名，Chat / Messages 不变。显式 compat 优先，模板显式写明以供代理使用。官方声明非 Lite 不支持 custom；namespace 尚无真实 Key 验证，先保守摊平，不声称上游一定拒收。tool_choice 只有 auto 生效，其他值会被上游过滤；auto_only 将 required / 具名改 auto，none 去掉选择但保留工具，不能保证禁止调用。
- **历史与未知字段。** 每次带回完整 input，保留明文 reasoning、summary、图片与工具历史，只清理通用 null 字段。官方推荐带回所有推理；Chat 上缺 reasoning_content 会 400 的限制不转换成 Responses 请求字段。store、include、缓存键与非空 encrypted_content 保持原值，文档未明确其语义，仍需真实验证。previous_response_id、background、context_management 不受支持，不依赖它们，不主动发送或伪造服务端状态。
- **已有 Provider 手动更新。** 不迁移用户数据。可在设置 → 模型服务 → 添加里选择“小米 MiMo”，完整保存两款模型的能力与 compat，再测试连接、新建会话。沿用原 ID 时，经 provider.upsert 提交上例的 api、baseURL、models、defaultModelId 与 compat，保留自己的其他设置；使用同一按量 Key 时省略 apiKey，Host 会保留它。桌面编辑表单不能补齐 reasoningEfforts / maxTokens 或编辑 compat；仅改模型 ID 不会套用新能力。旧 2.5 模型应手动换成 2.6；套餐配置不得复用到此模板。
- **验收边界。** 录制 Codex 请求与严格本机 HTTP mock 检查工具限制、摊平 / 还原、三步推理回放、off / high 与 provider.test；不把 mock 当成真实能力证明。当前无 WEVIR_TEST_API_KEY，Pro / Flash 的契约第 3 层、pnpm dev 的 apply_patch 对话、图片和原生 namespace 未验收，命令见 development.md §6.3。标志使用同版本 LobeHub 的 xiaomimimo.svg，来源与哈希见 assets/provider-logos/SOURCE.md、NOTICE 第 9 节。Token Plan、语音与图像生成接口不在本接法范围内。

来源与核对日期：2026-10-17，[模型列表](https://mimo.mi.com/docs/zh-CN/quick-start/summary/model)、[深度思考](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/text-generation/deep-thinking)、[Responses 参数](https://mimo.mi.com/docs/en-US/api/chat/responses)、[Chat 参数](https://mimo.mi.com/docs/zh-CN/api/chat/openai-api)、[Codex 配置](https://mimo.mi.com/docs/en-US/tokenplan/integration/codex-configuration)、[官方模型目录](https://example-files.cnbj1.mi-fds.com/example-files/configs/model-catalogs.json)。
