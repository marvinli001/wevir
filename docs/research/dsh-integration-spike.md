# T0.3 dsh 接入 Spike：ACP vs SDK

> 日期：2026-10-12 · 任务：[SKELETON_PLAN §6 T0.3](../SKELETON_PLAN.md) · 代码与样本：[`spikes/dsh-acp/`](../../spikes/dsh-acp/)
> 结论先行：**ACP 可以作为骨架主路径**，但它没有增量流式输出，§4.2 第 3 条“看到流式助手输出”必须靠 Wevir 自己补（本次已用一个 20 行的 Cordis 插件验证可行）。其余缺口都能在 Host / 适配器层补齐。

## 0. 怎么读这份报告

- 每条结论后面的 `fixtures/...` 指 `spikes/dsh-acp/fixtures/` 下的文件；`summary.<mode>.json` 里有每项检查的 pass/fail 与原始数值。
- **本次没有调用真实模型**（执行 T0.3 时决定暂不使用真实 Key）。需要模型的步骤全部跑在本地脚本化 mock（`src/mock-llm.ts`）上：它实现 OpenAI Chat Completions 流式协议和最小 Anthropic Messages，像真实 Provider 一样只看请求里的 `messages` 决定下一步。所以 dsh 侧（ACP 服务、工具、沙箱、审批、持久化、resume、pi-ai / llm-deepseek 适配器的请求拼装与 Key 注入）都是真实代码路径；mock 替代的只是“模型会怎么回答”。
- 真实模型才能回答的问题列在 [§9](#9-尚未验证需要真实模型)，补跑命令是 `WEVIR_SPIKE_API_KEY=... npm run spike`。

## 1. 环境与版本

| 项 | 值 |
|---|---|
| 平台 | macOS（darwin-arm64），Node v26.10.0，npm 11.19.1 |
| `@deepseek-ai/dsh` | `0.2.1-alpha.2`（npm `latest` 仍是 `0.2.0-rc.2`，必须写死） |
| `@deepseek-ai/dsh-sdk-client` | `0.2.1-alpha.2` |
| `@agentclientprotocol/sdk` | `1.4.0`：与 dsh-acp、dsh-subagent-acp 锁定的版本完全相同（npm latest 为 1.8.0） |
| pi-ai（dsh-llm-pi-ai 的依赖） | `@earendil-works/pi-ai@1.1.0` |
| 上游参考 | `upstream/deepseek-harness` @ `d743267`（tag `dsh-v0.2.1-alpha.2`） |
| DSH_HOME | `spikes/dsh-acp/.dsh-home`（每次运行先清空）；从未读写 `~/.dsh` |

运行方式（`spikes/dsh-acp/README.md`）：

```bash
npm run spike:mock     # 全流程，mock 模型，52 项断言全部通过（另 29 项观测记录），约 25 秒
npm run spike:keyless  # 只跑不调模型的协议部分，16 项断言通过
npm run spike          # 真实模型；没有 WEVIR_SPIKE_API_KEY 时打印设置说明并以退出码 2 结束
```

安装注意：npm 11 默认拦截依赖的安装脚本。dsh 需要其中 5 个（`dsh-subprocess-local` 给 node-pty 的 `spawn-helper` 加执行位、`koffi`、`node-pty`、`protobufjs`、`@google/genai`），已写进 `package.json` 的 `allowScripts`。Wevir 用 pnpm 打包 adapter-dsh 时同样要放行（pnpm 的 `onlyBuiltDependencies`）。

## 2. 每一步的实际结果

| # | 步骤 | 结果 | 依据 |
|---|---|---|---|
| 1 | 精确安装 dsh 与 ACP SDK | 成功；`dsh --version` → `0.2.1-alpha.2` | `package.json`、`package-lock.json` |
| 2 | 独立 DSH_HOME | 成功；首次启动自动生成 `profiles/acp`、`sessions/`、`storages/`、`.anonymous-user-id` | `summary.mock.json` 的 env-hygiene“DSH_HOME 顶层内容” |
| 3 | Provider 注入 | OpenAI 兼容路由与 deepseek-official 路由都走通；Key 只出现在请求头 | `providers/mock/*.json`、[§6](#6-provider-注入) |
| 4 | ACP 全流程 | 全部通过（读写、allow / deny / 审批中取消、工具中取消、生成中取消、close → list → resume、跨进程 resume 追问） | `acp/mock/scenarios/*.json`、`summary.mock.json` 的 `acp-flow` |
| 5 | 录制真实 JSON | 74 个 JSON（含两份 summary）+ 18 份完整帧记录（`*.jsonl`），已脱敏 | `fixtures/**` |
| 6 | SDK 对照 | 完成；差异见 [§7](#7-acp-vs-sdk) | `sdk/mock/**`、`acp/mock/scenarios/todo-subagent.json` |
| 7 | 冷启动与多会话 | spawn → initialize 中位 0.44 s / 0.48 s（keyless、mock 两轮各 5 个样本，均含首次启动，最大 0.61 s）；单进程 3 会话并发建会话与并发提示均正常 | `summary.keyless.json`、`measure/cold-start.json`、`measure/mock/concurrency.json` |
| — | 增量流式补丁原型 | 旁路首个分片 85 ms 到达，ACP 的整条消息 3317 ms 才到 | `stream-tap/mock/summary.json` |
| — | 进程环境卫生 | 进程 cwd 的 `.env` 会被当作 Key；`$DSH_AGENTS_HOME` 的 skills 与 AGENTS.md 会进入请求；隔离后都不出现 | `env-hygiene/mock/summary.json` |
| — | 密钥检查 | `fixtures/` 与 `.dsh-home/`（含解压后的 `session.v4.jsonl.zstd`）里没有注入的 Key，没有生成 `.credentials.yaml`；fixtures 无个人路径 | `summary.*.json` 的 `check-secrets` |

## 3. ACP 协议面（dsh-acp 实际行为）

### 3.1 initialize

请求见 `acp/initialize.request.json`，响应（`acp/initialize.response.json`）：

```json
{
  "protocolVersion": 1,
  "agentInfo": { "name": "deepseek-harness-acp", "version": "0.0.1" },
  "agentCapabilities": {
    "mcpCapabilities": { "http": true },
    "promptCapabilities": { "image": false, "audio": false, "embeddedContext": false },
    "sessionCapabilities": { "close": {}, "list": {}, "resume": {} }
  },
  "authMethods": []
}
```

- 没有 `loadSession`；`session/load` 返回 `-32601 Method not found`（`acp/errors/session-load-unsupported.json`）。
- `authMethods` 为空、`authenticate` 直接成功：**ACP 上没有任何登录入口**（影响 OAuth 类 Provider，见 §6.4）。
- `agentInfo.version` 固定 `0.0.1`，不是 dsh 版本号；版本校验要靠 Wevir 自己锁定的包版本。

### 3.2 会话生命周期

| 调用 | 观察 | 依据 |
|---|---|---|
| `session/new` | 返回 `sessionId` + `configOptions`（`model`、`reasoning_effort` 两个 select）。`model` 的值是 JSON 编码的 `["provider","model"]` 字符串 | `acp/session-new.response.json`、`acp/session-new.openai-compatible.response.json` |
| `session/list` | **只返回 `sessionId` 与 `cwd`**，没有 `title`、`updatedAt`；**活跃会话不出现在列表里**；按创建时间新到旧 | `acp/session-list.response.json`、`lifecycle` 检查 |
| `session/close` | 返回 `{}`；之后会话出现在 list 中，可 resume | `acp/session-close.response.json` |
| `session/resume` | 返回 `configOptions`，**不回放任何 `session/update`**；活跃会话被拒（`-32602 session is already active`）；cwd 不一致被拒（按 realpath 比较） | `acp/session-resume.response.json`、`acp/errors/resume-*.json` |
| 未知会话 | `-32602 unknown session` | `acp/errors/close-unknown-session.json` |

### 3.3 session/update 类型清单

本次实际出现的类型（`acp/mock/updates/`，每类一个样本）：

| `sessionUpdate` | 内容 | 备注 |
|---|---|---|
| `agent_message_chunk` | `{ messageId, content: {type:'text', text} }` | **一条已提交的 assistant 消息一个 chunk**，不是增量（§4） |
| `agent_thought_chunk` | 同上，内容为推理文本 | Provider 返回 `reasoning_content` 时出现 |
| `tool_call` | `{ toolCallId, title, kind, status, rawInput }` | `title` 就是工具名（`read`、`write`、`bash`、`todo_write`、`subagent`…），`kind` 恒为 `other`，`status` 直接是 `in_progress`（没有 `pending`），没有 `locations` |
| `tool_call_update` | `{ toolCallId, status: completed / failed, content: [{type:'content', content:{type:'text', text}}] }` | 工具结果原文（模型看到的那段文本）；没有 `diff` 类型内容 |
| `usage_update` | `{ used, size }` | `size` 是上下文窗口；自定义模型未声明时是 pi-ai 的猜测值 262144，没有 `cost` |

源码里存在但本次没触发：`config_option_update`（Provider 拓扑变化时）。**dsh 从不发送** `plan`、`session_info_update`（标题）、`user_message_chunk`、`current_mode_update`、`available_commands_update`（`packages/acp/acp/src/updates.ts`、README “不支持的界面”一节）。

### 3.4 prompt 的结算

- `stopReason` 只见到 `end_turn` 与 `cancelled`。源码 `codec.ts` 把 dsh 的 `error`、`blocked`、`aborted` 都映射成 `end_turn`；但**轮次失败会让 `session/prompt` 以 JSON-RPC `-32603` 失败**，错误信息是自由文本，例如缺 Key 时 `Internal error: turn failed: llm-pi-ai: no credential for provider route "wevir-spike"; …`（`acp/errors/prompt-missing-key.*.json`）。没有结构化错误码，适配器只能按文本归类。
- 有后台子 agent 时，ACP 的 prompt 会一直等到子 agent 结束、父 agent 处理完它的回报后才结算（`todo-subagent` 场景：`rows.txt = 3` 写在子 agent 回报之后）。

## 4. 流式输出：ACP 的最大缺口

| 场景 | mock 发送方式 | ACP 收到 | 依据 |
|---|---|---|---|
| F：约 170 字介绍 | 30 片，每片间隔 100 ms，约 3.2 s | `agent_thought_chunk` ×1、`agent_message_chunk` ×1、`usage_update` ×1，**全部在 3279 ms 同时到达** | `acp/mock/scenarios/F-stream-granularity*.json` |
| E2：生成中第 4 秒取消 | 300 片 | 取消时一次性收到已生成的 320 字（作为一个 chunk），随后 `stopReason: cancelled` | `acp/mock/scenarios/E2-cancel-during-generation.json` |

原因：dsh-acp 只把已提交的 `assistant/message` 投影成 ACP 更新（`packages/acp/acp/src/updates.ts`），进程内的增量帧 `agent/assistant-stream` 唯一的远程消费方是 Web profile。SDK 协议同样只有已提交事件（§7）。

**补丁原型（已验证）**：`spikes/dsh-acp/stream-tap/` 是一个不依赖任何 `@deepseek-ai/*` 包的 Cordis 函数插件，监听 `agent/assistant-stream`，把每个 `start / chunk / end` 帧以 NDJSON 写到 `WEVIR_STREAM_FD`（Wevir spawn 时多开的 fd 3），不碰 stdout 上的 ACP 流量。装配方式是官方插件机制，不改 dsh：

```bash
dsh plugin --profile acp add link:/abs/path/to/stream-tap   # 写入 profile 的 package.json 依赖
```

```yaml
# --patch overlay
- insert:
    - id: wevir-stream-tap
      name: wevir-spike-stream-tap
```

结果（`stream-tap/mock/summary.json`、`frames.sample.json`）：35 个 chunk 帧从 85 ms 持续到 3312 ms，ACP 的整条消息 3317 ms 才到。帧形如 `{"type":"chunk","attemptId":"<sessionId>:1","index":3,"chunk":{"type":"text-delta","index":1,"text":"…"}}`，另有 `block-start`、`reasoning-delta`、`block-end`。适配器的合并规则：按 `sessionId` 实时显示增量，收到 ACP 的 `agent_message_chunk` 后以它为准替换（`attemptId` 与 ACP 的 `messageId` 不同，按会话内顺序对齐）。

## 5. 权限请求

### 5.1 什么时候会有审批

在随附的 profile 组合里，dsh 的审批**只来自沙箱升级**，不是“每次写文件都问”（返回 `ask` 决定的 `tools/pre-execute` 监听器只存在于 experimental 的 hooks-claude-code 与 auto-review）：

1. 默认模式 `workspace-write`（`DSH_PERMISSION_MODE` 可改）+ 审批策略 `ask`。
2. 工作区内读写：直接执行，没有审批（场景 A，`permissions: 0`）。
3. **系统临时目录也可直接写**：工作区外、但在 `$TMPDIR` 下的路径不需要审批就写成功了（场景 B0）。
4. 工作区外其他路径：工具先失败，结果里带 `[sandbox: file access denied under workspace-write mode]` 和“带 `sandbox_permissions` + `justification` 重试一次”的提示；**模型自己决定**是否带参数重试，重试才触发 `session/request_permission`。
5. 结论：Wevir 的审批卡片出现与否取决于模型是否升级。真实模型是否可靠地按提示升级，是 §9 的待验证项。

### 5.2 结构

请求（`acp/mock/permission/request.json`）只有 `toolCallId`，没有标题、参数或理由：

```json
{
  "sessionId": "…",
  "toolCall": { "toolCallId": "call_…_0" },
  "options": [
    { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
    { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" }
  ]
}
```

- 选项固定两个，没有 `allow_always` / `reject_always`。“总是允许”只能由 Host 自己记规则、自动应答。
- 审批详情要从**同一 `toolCallId` 之前的 `tool_call` 的 `rawInput`** 取：其中有路径、内容、`sandbox_permissions` 与模型写的 `justification`。帧顺序：`tool_call(in_progress)` → `request_permission` → 回复 → `tool_call_update`（`acp/mock/transcripts/B-permission-allow.jsonl`）。
- 回复（`acp/mock/permission/responses.json`）：allow `{"outcome":{"outcome":"selected","optionId":"allow-once"}}`，deny 同形 `reject-once`，取消 `{"outcome":{"outcome":"cancelled"}}`。

### 5.3 allow / deny / cancel 之后工具结果怎么记

每次升级都是两个工具调用：第一次失败（沙箱拒绝），第二次带升级参数。第二次的 `tool_call_update`（`acp/mock/permission/after-*.tool-lifecycle.json`）：

| 决定 | `status` | 工具结果文本（模型同样看到这段） | 文件 |
|---|---|---|---|
| allow | `completed` | `<path>…/allowed.txt</path><type>file</type><content>Created file</content>` | 已写入 |
| deny | `failed` | `Error: the user rejected escalating this operation to "danger-full-access"; it stays denied, so stop and explain instead of working around it` | 未写入 |
| cancel | `failed` | `Error: approval for escalating to "danger-full-access" was cancelled`，随后 prompt 以 `cancelled` 结算，没有 assistant 回复 | 未写入 |

这些结果都写进 dsh 会话日志，resume 后模型仍能看到（§5.4 的请求记录）。

### 5.4 取消

| 场景 | 结果 | 依据 |
|---|---|---|
| D：审批挂起时客户端发 `session/cancel` 并以 `cancelled` 回复审批 | `stopReason: cancelled`，文件未写 | `acp/mock/scenarios/D-permission-cancel.json` |
| E1：`bash sleep 45` 运行 1.5 s 后取消 | 3 ms 内结算为 `cancelled`；取消前 `sleep 45` 在运行，取消后进程已不在 | `summary.mock.json` 的 E1 三项 |
| E2：生成中取消 | 64 ms 内结算；mock 观察到发往 Provider 的流式请求被中断 | 同上 |

## 6. Provider 注入

### 6.1 验证结果

| 路由 | 配置方式 | 结果 |
|---|---|---|
| OpenAI 兼容（`llm-pi-ai` 自定义 provider） | overlay 声明 `baseURL`、`api`、`models`、`apiKeyEnv: WEVIR_SPIKE_API_KEY` | 走通；mock 收到 `Authorization: Bearer <注入值>`（`providers/mock/openai-compatible.json`） |
| DeepSeek 官方（`llm-deepseek`，`deepseek-official`） | overlay 只改 `apiKeyEnv`（mock 模式额外指定 `baseURL`） | 走通；mock 在 `/anthropic/v1/messages` 收到 `x-api-key: <注入值>`（`providers/mock/deepseek-official.json`） |
| 缺 Key | 同上，不设环境变量 | prompt 失败，错误文本点名 `WEVIR_SPIKE_API_KEY`（`acp/errors/prompt-missing-key.*.json`） |
| 组合结果 | `dsh --profile acp --patch <overlay> --dump-config` | 能看到 overlay 的 provider 与 acp 路由（`lifecycle` 检查） |

DSH_HOME 中没有 `.credentials.yaml`，扫描（含解压会话日志）找不到注入的 Key。

### 6.2 可直接复制的 overlay

OpenAI 兼容服务（通义、Kimi、智谱、中转网关等）：

```yaml
- id: llm-pi-ai
  config:
    providers:
      my-gateway:                      # Provider ID：小写连字符，写入会话日志，创建后不可改名
        displayName: My Gateway
        apiKeyEnv: WEVIR_PROVIDER_MY_GATEWAY_KEY   # 只写环境变量名
        api: openai-completions          # 或 openai-responses、anthropic-messages
        baseURL: https://gateway.example/v1
        compat:                          # 非 OpenAI 官方地址时，多数网关需要这两项
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        models:
          - id: your-model-id
            contextWindow: 131072        # 不写时按 262144 猜，usage_update.size 会失真

- id: acp                              # 整体替换 acp 条目的 config
  config:
    provider: my-gateway
    model: your-model-id
```

DeepSeek 官方（最小配置）：

```yaml
- id: llm-deepseek
  config:
    apiKeyEnv: WEVIR_PROVIDER_DEEPSEEK_KEY
- id: web-search-deepseek               # web_search 工具另有自己的 Key 引用，默认 DEEPSEEK_API_KEY
  config:
    apiKeyEnv: WEVIR_PROVIDER_DEEPSEEK_KEY
```

DeepSeek 的 OpenAI 兼容端点（`https://api.deepseek.com`，模型 `deepseek-flash` / `deepseek-v4-pro`）若走 pi-ai，还需 `compat.thinkingFormat: deepseek` 与 `requiresReasoningContentOnAssistantMessages: true`（`src/overlays.ts`，取自 pi-ai 自带目录）。

### 6.3 dsh 的凭据解析顺序与 Wevir 的约束

`packages/credentials/credentials-local/src` 的顺序：**继承的环境变量 > `$DSH_HOME/.credentials.yaml` > `<dsh 进程 cwd>/.env` > `$DSH_HOME/.env`**。因此：

- 子进程环境必须按白名单构造，否则用户 shell 里的 `DEEPSEEK_API_KEY`、`ANTHROPIC_*` 等会被 dsh 直接用上。
- dsh 进程的 cwd 不能是用户工作区：已用假 `.env` 验证，环境里没有 Key 时 dsh 会把 `<进程 cwd>/.env` 里的值发给 Provider（`env-hygiene/mock/summary.json`）。Spike 用 `DSH_HOME` 作为进程 cwd；会话的工作目录由 `session/new` 的 `cwd` 决定，两者无关。

### 6.4 账号登录（Codex、Claude 等）

只读源码，未实测：pi-ai 为 `openai-codex` 与 `anthropic` 提供 OAuth 登录；dsh 通过授权 seam 跑登录流程，得到的 grant 存在 `$DSH_HOME/.credentials.yaml` 的 `llm-pi-ai/<provider id>` 记录，由 dsh 在跨进程锁下自行刷新（`packages/llm/llm-pi-ai/README.zh.md`“登录提供方”）。ACP 没有登录入口（§3.1）。所以：

- API Key 类 Provider：按 §6.2 走环境变量，满足 SKELETON_PLAN §2.8。
- OAuth 类 Provider：refresh token 会轮换，只能留在 dsh 能写的地方，**与 §2.8“密钥不落 DSH_HOME”冲突**。需要 Wevir 自己提供登录界面并触发 dsh 的授权流程（或自己做 OAuth 后写入同格式记录），grant 存在 Wevir 专属的 `DSH_HOME`（0600）。登录入口怎么接、各家条款是否允许第三方客户端使用订阅账号，都需要单独的 Spike。

## 7. ACP vs SDK

同一 todo + subagent 提示两边各跑一次（`sdk/mock/summary.json`、`acp/mock/scenarios/todo-subagent.json`）：

| 能力 | ACP（`dsh --profile acp`） | SDK（`dsh --profile sdk` + HarnessClient） |
|---|---|---|
| 协议 | 标准 ACP v1，可复用到其他 ACP Agent | dsh 私有 JSON-RPC，`serverInfo.version` 固定 `0.0.1` |
| 取消 | `session/cancel`，结算为 `cancelled`，会杀掉正在跑的子进程 | 无；`session/cancel` 返回 `unknown … method`（`sdk/mock/errors/session-cancel.json`），只能杀进程 |
| 审批 | `session/request_permission`，可 allow / reject / cancel | 无应答方：升级请求记为 `approval/asked` → `approval/decided: unavailable`，工具结果 `no approval channel is available`（`sdk/mock/escalation.tool-results.json`） |
| 增量流式 | 无 | 无（同样只有已提交的 `assistant/message`） |
| 会话管理 | `new` / `list` / `close` / `resume` | 会话 id 由客户端指定，首次 prompt 时创建；没有 list / close |
| 标题 | 无 | `session/title` 事件（`source.kind: fallback`，取首个提示词前若干字；两个 profile 都禁用了 LLM 标题） |
| todo | 只能从 `todo_write` 的 `tool_call.rawInput` 读到完整列表 | `todo/write` 事件，带完整列表 |
| plan | 不支持 | 计划模式的会话事件（本次未触发） |
| subagent | 只看到父会话的 `subagent` 工具调用（结果 `started subagent <id>`）；子会话的任何更新都看不到（`otherSessionUpdates: 0`） | `subagent.started` / `subagent.finished`（含子 agent 最后回复）+ 子会话的全部事件 |
| 事件序号 | 无 | 每个事件带会话内 `seq` 与 `time` |
| 运行状态 | 只有 prompt 结算 | `session.status` running / idle |
| 沙箱与审批策略 | 不可见 | `permission/preset`、`sandbox/mode`、`approval/policy` 事件 |
| 用户消息与注入上下文 | 不发送 | `user/message`（含 runtime context、子 agent 回报） |
| 模型选择 | 每会话 `session/set_config_option` | 只在 `initialize` 时给定 |
| 冷启动 | 中位 0.44–0.48 s | 0.42 s（单样本，`sdk/mock/summary.json` 的 `initializeMs`） |

一句话：SDK 的事件更全（标题、todo、子 agent、seq），但没有取消和审批；ACP 正好相反。骨架阶段最硬的需求是取消、审批与会话生命周期，所以选 ACP；SDK 多出来的信息可以通过同一个旁路插件补发（§11.2 第 2 项）。

## 8. resume 后的上下文

- 同进程 close → resume 后追问暗号：答对（`acp/mock/scenarios/G-recall-same-process.json`）。
- **新进程** list → resume 后追问：暗号与 `summary.md` 内容都答对（`H-recall-new-process.json`）。
- 因为 mock 只能根据请求内容作答，`H-first-request-after-resume.json` 直接记录了 resume 后第一个模型请求：39 条消息，包含系统提示、所有历史用户消息、全部工具调用与结果（含沙箱拒绝、用户拒绝、审批取消、`tool call aborted before dispatch`）、被取消时已生成的半段回答。**没有丢失模型可见的上下文**。
- 丢失的是**界面层**信息：ACP 不回放历史 update，`session/list` 没有标题与时间。这部分由 Wevir 事件库负责（SKELETON_PLAN 已规划）。
- dsh 会话日志按工作区路径分目录存放：`$DSH_HOME/sessions/<cwd 编码>/<sessionId>/session.v4.jsonl.zstd`，明文内容（读到的文件、工具输出）压缩后落盘；工作区删除后日志仍在。

## 9. 尚未验证（需要真实模型）

`WEVIR_SPIKE_API_KEY=... npm run spike` 会跑同样的步骤，fixtures 写到 `*/real/` 下，可回答：

1. 真实模型是否按沙箱提示带 `sandbox_permissions` 重试（决定审批卡片在实践中会不会出现）。
2. 真实 Provider 的流式节奏下，ACP 与旁路的首字时间差。
3. DeepSeek 官方路由（Anthropic Messages 协议、thinking、Files API）在真实端点上是否正常。
4. 真实 `usage_update` 数值与 `agent_thought_chunk` 的出现频率。

## 10. 其他发现（影响 T3.1 的进程管理）

| 发现 | 影响 | 依据 |
|---|---|---|
| dsh 默认读取 `$DSH_AGENTS_HOME`（默认 `~/.agents`）下的 `skills/` 与 `AGENTS.md`，以及 `$DSH_HOME/AGENTS.md`，内容进入每个会话的首个请求（本机未隔离的探针请求里，用户自己的 skill 清单约 15 KB） | 要决定“共享用户的 ~/.agents”还是隔离；Spike 用空目录隔离 | `env-hygiene/mock/summary.json`；`packages/context/agent-instructions/README.zh.md` |
| 环境里没有 Key 时，dsh 会读 `<进程 cwd>/.env` 并把值发给 Provider | 进程 cwd 必须是 Wevir 自己的目录 | `env-hygiene/mock/summary.json` |
| `workspace-write` 允许写系统临时区，不需要审批 | 安全说明与 UI 提示要写清楚 | 场景 B0 |
| `dsh-base` 带 OTel 遥测（仅在用户反馈后上报），并总会生成 `$DSH_HOME/.anonymous-user-id` | Wevir 默认设 `DSH_TELEMETRY_DISABLED=1` | `packages/bundle/base/cordis.patch.yml` |
| 进程 cwd 必须存在，否则 spawn 直接 `ENOENT` | T3.1 先建目录 | Spike 首次运行的报错 |
| stdin EOF 后 22–29 ms 退出 | `dispose` 走 stdin EOF 即可，SIGTERM / SIGKILL 作兜底 | `measure/cold-start.json` |
| 3 个会话同进程并发：结果各归其位，所有 update 都能按 `sessionId` 归属 | 一个 dsh 进程可承载多个 Wevir 会话 | `measure/mock/concurrency.json` |
| dsh 运行时依赖原生模块（node-pty、koffi） | 桌面端用 Electron 的 Node 运行 dsh 时要处理 ABI；或随包带一个独立 Node | `package.json` 的 `allowScripts` |

## 11. 结论

### 11.1 ACP 能否作为骨架主路径

**能。** 取消、审批、多会话、持久化与跨进程 resume 都按协议工作，且模型侧上下文在 resume 后完整保留。阻碍 §4.2 验收的只有“流式输出”一项，已用插件旁路验证可解，不需要 fork dsh，也不需要换到 SDK 或 Web RPC。

### 11.2 必须由 Wevir 补足的能力

| # | 能力 | 做法 | 建议归属 |
|---|---|---|---|
| 1 | 增量流式输出 | stream-tap 插件 + 额外 fd，适配器合并增量与已提交消息 | M3 新任务（见下） |
| 2 | 标题、todo、子 agent 活动、事件序号 | 骨架：标题由 Host 取首条提示词生成，todo 从 `todo_write` 的 rawInput 解析，seq 由 Host 分配；Phase 1：同一插件补发 `session/event` | T3.2 / Phase 1 |
| 3 | 历史回放与会话元数据 | Wevir 事件库（已规划）；列表、标题、时间以 Host 为准，不依赖 `session/list` | T2.2 / T3.5 |
| 4 | 审批详情与“总是允许” | `request_permission` 与此前的 `tool_call.rawInput` 按 `toolCallId` 关联；规则记在 Host，自动应答 | T3.3 |
| 5 | 工具展示元数据 | `kind` 恒为 `other`、无 `locations` / `diff`：Host 按工具名映射图标与类型，从 rawInput 生成路径与 diff | T3.2 / T5.3 |
| 6 | 错误分类 | `-32603` 自由文本 → 适配器按前缀归类（缺凭据、Provider 错误、未知），保留原文 | T3.2 |
| 7 | 进程环境卫生 | 白名单环境、独立 `DSH_HOME`、`DSH_AGENTS_HOME` 策略、进程 cwd、关闭遥测、安装脚本放行 | T3.1 |
| 8 | OAuth 账号 Provider | 单独 Spike；修订 §2.8 | Phase 1 前 |

### 11.3 对 SKELETON_PLAN 的修改建议（由 T0.6 落实）

**§3.1 DeepSeek Harness**

- ACP 行的“缺口”补充：没有增量流式（只发已提交消息，取消时补发已生成部分）；`session/list` 只有 `sessionId` + `cwd` 且不含活跃会话；审批只来自沙箱升级，请求只带 `toolCallId`，选项仅 `allow_once` / `reject_once`；子 agent 活动不可见；工具 `kind` 恒为 `other`；轮次失败以 `-32603` 自由文本返回。
- SDK 行的“缺口”补充：同样没有增量流式；“能力”补充：标题、todo、子 agent、事件 `seq`。
- “骨架阶段的接入假设”改为“T0.3 已验证，ACP 为主路径，增量流式由 Wevir 插件旁路补齐”，指向 ADR-0001 与本报告。
- 补一条进程环境要点：`DSH_HOME`、`DSH_AGENTS_HOME`、`DSH_TELEMETRY_DISABLED`、`DSH_PERMISSION_MODE`、进程 cwd 与凭据解析顺序（§6.3）。
- ACP SDK 版本锁定为与 dsh-acp 相同的 `@agentclientprotocol/sdk@1.4.0`，升级 dsh 时一起核对。

**§2.8 密钥不落引擎文件**：加例外说明——OAuth grant 需要 dsh 自行刷新，只能存于 Wevir 专属 `DSH_HOME/.credentials.yaml`（0600）；API Key 仍只走环境变量。

**§6 M3**

- T3.1：加入环境白名单、`DSH_AGENTS_HOME` 策略、进程 cwd 不得为用户目录、`DSH_TELEMETRY_DISABLED=1`、pnpm 放行 5 个安装脚本、Electron 下运行 dsh 的 Node / 原生模块方案。initialize 实测约 0.5 s，现有超时设计足够。
- 新增 **T3.2a 增量流式旁路**：把 `spikes/dsh-acp/stream-tap` 产品化为 `packages/adapter-dsh` 内的插件（它只用 Cordis `ctx`，不 import `@deepseek-ai/*`），T3.1 负责安装到 profile 并开 fd；T3.2 合并增量与 ACP 消息。§4.2 第 3 条依赖它。
- T3.2：映射表以 `spikes/dsh-acp/fixtures/acp/mock/` 为输入；加上工具名 → 展示类型映射、`todo_write` 解析、错误文本归类、取消时的半段消息。
- T3.3：写明审批详情来自同 `toolCallId` 的 `tool_call`；客户端取消时必须以 `cancelled` 回复挂起的审批；审批只在模型升级时出现，UI 文案与权限模式选择（`workspace-write` / `read-only`）要据此设计。
- T3.4：按 §6.2 生成 overlay（含 `compat`、`contextWindow`）；`web-search-deepseek` 的 Key 引用一并处理；OAuth 推迟。
- T3.5：resume 必须用会话创建时的 cwd（realpath 比较）；活跃会话不能 resume；会话列表与标题以 Wevir 事件库为准。
- T3.6：在“真实模型（有 Key 时）”与“离线回放”之间加一层“真实 dsh + 本地 mock Provider”（复用 `spikes/dsh-acp/src/mock-llm.ts` 的做法）：CI 不需要 Key 也能端到端覆盖工具、审批、取消与 resume，本次的 mock 套件约 25 秒跑完。

**§8 风险表**：“ACP 不回放历史、无终端/计划/todo”一行补上“无增量流式 → 插件旁路（已验证）”；新增“dsh 读取 `~/.agents` 与进程 cwd 的 `.env`”与“OAuth grant 必须落 DSH_HOME”两行。
