# WorkBuddy → Wevir 事件映射

> 日期：2026-10-18 · 订阅来源 `workbuddy` · Host API 0.55.0
> 依据：[ADR-0005](../adr/0005-agent-runtime-and-model-gateway.md) 补记 25；[通用 ACP 映射](./acp-event-mapping.md)；[Grok 映射](./grok-event-mapping.md)；[Antigravity 映射](./antigravity-event-mapping.md)
> 代码：`packages/adapter-workbuddy`，依赖只有 `@wevir/adapter-acp` 与 `@wevir/runtime-adapter`。

## 1. 引擎的形态

Wevir 启动用户自己安装的官方 `codebuddy --acp`，经现成的 `AcpLauncher`、`AcpProcess`、`AcpAdapter` 与 ACP SDK 通信。不声明 `@tencent-ai/codebuddy-code` 或 `@tencent-ai/agent-sdk`，不分发 CLI，不另写 HTTP 客户端。

可执行文件按 `WEVIR_WORKBUDDY_BIN` → `account.setPath` → PATH → 常见安装目录查找，也认 `cbc`。显式路径无效时不换别处。目录包括 `~/.local/bin`、npm、Homebrew、bun、Volta、pnpm 全局目录及 Windows 对应位置。进程工作目录为 `<数据目录>/engines/workbuddy`，会话的目录通过 `session/new` / `session/resume` 给出。

不覆盖 HOME、`CODEBUDDY_CONFIG_DIR`，不设置或继承 `CODEBUDDY_IS_SANDBOX`，不设置内部客户端身份开关。用户已有的 `CODEBUDDY_API_KEY`、`CODEBUDDY_AUTH_TOKEN`、`CODEBUDDY_INTERNET_ENVIRONMENT`、`CODEBUDDY_BASE_URL` 随环境继承，Wevir 不保存、不记录。CLI 使用自己的登录与会话目录；不读取 CLI 的 token 文件或 WorkBuddy 桌面端凭据。

构造适配器时不启动进程。会话共用一个 ACP 进程，权限模式在会话内配置。POSIX 进程组、退出上报、取消超时与最多三次自动重启复用 `AcpProcess`；进程退出后 Host 通过 resume 接续。不关闭用户的自动更新；更新导致退出同样走这条路径，静默卡住的取消走通用超时重启。

## 2. 账号与模型

Wevir 只检测登录：找 CLI、运行 `--version`，再用一次性 ACP 进程 `initialize` 与空目录的 `session/new`。从不调用 `authenticate`，不打开登录网址。`-32000 Authentication required` 为未登录；其他探测失败保留诊断、降级，不使 Host 崩溃。版本解析失败不打印 CLI 输出。结果缓存五分钟，`refresh` 与设置路径重新检测，dispose 回收探测进程。

登录命令是 `codebuddy`：当前 `--help` 没有专门的登录子命令。用户在终端完成版本选择与登录，再重新检测。国内、国际、iOA、企业版本必须与用户已有环境一致，Wevir 不替用户选择环境。安装命令为 `npm install -g @tencent-ai/codebuddy-code`；官方安装文档写 Node 18.20+，2.168.2 的启动器实际要求 18.20.8+。

模型列表来自 `session/new` 的 `configOptions` 中 `model` 的选项，分组展开、去重、当前值作为默认；拿不到时只有 **Auto**（沿用 CLI 当前默认模型）。不内置厂商模型名单。`thought_level` 只证明当前模型的档位，其他模型不猜测；会话选定模型后的配置会补充缓存。原生 `disabled` 对应 Wevir 的 `off`，`enabled` 表示 CLI 默认档位，不增添协议枚举。模型、推理档位分别用 `session/set_config_option` 的 `model`、`thought_level`；不用 `session/set_model`。

账号探测不调用 `_codebuddy.ai/getUserInfo`：2.168.2 的这个响应还可能带令牌，检测登录和模型不需要它。没有邮箱、套餐或余额接口就不报告这些值。

## 3. 工具展示

工具执行由 CLI 负责，客户端能力仍为 `{}`，不声明 fs / terminal。工具名优先取 `_meta['codebuddy.ai/toolName']`，其次取标题；Bash / PowerShell、Read、Write、Edit、Grep / Glob、WebSearch / WebFetch、TodoWrite、Agent / Task 分别显示为命令、读取、写入、修改、搜索、抓取、清单、子任务。路径、命令、查询取原始输入和 ACP locations；MCP 工具保留服务名。CLI 的原始工具输入输出仍经通用 ACP 映射转交。

## 4. 消息与回合

文本与思考使用 `messageChunks: streamed`，复用增量合并和回合结算。待办取 ACP `plan`。`usage_update.used / size` 对应上下文已用量 / 容量；`cost` 是本次请求的积分，不是限额窗口，不生成 `rateLimits`。没有用量就不报告。

恢复用 `session/resume`，Host 保留显示历史，不调用会回放历史的 `session/load`。明确的会话不存在错误归 `session_lost`，其他恢复失败可重试。认证错误归 `missing_credentials` 并更新账号状态；额度、限流、上游服务错误归 `provider`。

图片经 `AcpEngine.images` 的现成内容块路径发送。2.168.2 的无账号 `initialize` 声明 `promptCapabilities.image: true`；真实图片理解仍待账号验证。

## 5. 审批与提问

普通 `session/request_permission` 的选项原样交出，不继承 Grok 对长期选项的过滤。AskUserQuestion 的原生请求转为 `question.requested`；回答通过 CLI 的 ACP 扩展 `_codebuddy.ai/resolveInterruption` 交回（包含问题答案，再结束原审批），不能把“允许”当作用户答案。独立的 `_codebuddy.ai/question` 扩展也经现成的 `requestAnswers` 桥接。取消、退出、关闭复用通用的未决提问回收。

ExitPlanMode 取请求 `_meta['codebuddy.ai/plan']` 的 Markdown 报 `plan.proposed`，拒绝这次实施请求，等待用户后续消息；没有正文时不读计划文件。Wevir 暂不声明该引擎的计划模式入口。

`AcpExtensions` 登记 question 请求以及 authUrl、checkpoint、artifact、artifactBatch、command、file_history_snapshot 等通知。authUrl 只忽略，不打开、不记录；其余未接入的扩展不改变会话。`getUserInfo`、`sideQuestion` 是客户端发起的方法，本适配器不调用。未知 `_meta` 不作协议错误。

## 6. 权限模式

| Wevir | `mode` 配置值 |
|---|---|
| `on_request` | `default` |
| `auto_review` | `auto` |
| `full_access` | `bypassPermissions` |

建会话、恢复时设置，会话中改配置在下一次发送前生效；不为每种权限模式另起进程。缺少所选模式或写入失败时报错，不悄悄沿用权限更宽的模式。`bypassPermissions` 下高危命令仍可能询问；不设置 `CODEBUDDY_IS_SANDBOX`。

## 7. 与官方 ACP 面的差异和条款

- 复用 Grok 的应用工具桥和历史工具：通过 ACP `mcpServers` 挂 stdio 服务，跨来源接力由 Host 现有逻辑处理。用户全局 MCP、CLI hooks 等仍由用户自己的 CLI 配置决定。
- 已核对桌面端来源清单。`editors.ts` 是外部文件编辑器表，`codebuddy` 是 Agent CLI，不把它作为“在编辑器中打开”的命令登记。
- 不接 CLI 的会话列表、分支、队列、侧问、context_window 选择器或多任务开关。团队成员标记的更新只保留为原始事件，不合并进主助手的回答；后台唤醒回合和父回合结束后仍等待的 worker 提问尚未映射。不要把这些当作 Wevir 子会话功能。真实多会话并发表现待维护者验证。
- 2026-10-18 核对：官方 [ACP 文档](https://www.workbuddy.ai/docs/cli/acp) 展示 Zed 和其他 ACP 客户端的接入；[ACP Registry](https://github.com/agentclientprotocol/registry/tree/main/codebuddy-code) 登记 2.168.2 与 `--acp`。[国内协议 §8.2(6)](https://www.codebuddy.cn/agreement/) 限制未经腾讯云授权的第三方软件登录或使用；[国际服务条款](https://www.workbuddy.ai/document/term) §6.1–6.4 规定个人许可、转授和使用限制。技术接入文档不等于对 Wevir 的单独授权。本实现的事实边界是：**Wevir 启动官方二进制，用户自己的登录，不转存凭据、不随包分发**；不据此替腾讯作许可结论。
- [国内定价](https://www.workbuddy.cn/docs/workbuddy/Pricing) 与 [CLI costs](https://www.workbuddy.ai/docs/cli/costs) 说明积分计费；不由每次 cost 推算剩余额度。

## 8. 验证

核对日期为 2026-10-18，公开 CLI 包版本 **2.168.2**。临时目录解开 npm 官方包，在空 HOME、无 Key、无用户凭据的环境只执行 `--version`、`--help`、ACP `initialize`、空 `getUserInfo` 与 `session/new`：协议 1、image true、四种认证方式（iOA / external / internal / selfhosted），空用户信息，建会话返回 -32000。没有调用 authenticate 或 session/prompt，没有真实登录，没有消费订阅额度。Registry 上的版本相同；它没有随条目发布协议探测录音。临时包和探针在工作结束时删除。

自动测试使用 `test-fixtures/fake-codebuddy.mjs` 与明确标为合成的 NDJSON 样本，覆盖启动、账号缓存、模型、推理档位、权限、工具、提问、用量、取消、恢复、退出及现成适配器契约。真实契约默认跳过，只有维护者设置 `WEVIR_TEST_WORKBUDDY=1` 才运行，`WEVIR_TEST_WORKBUDDY_MODEL` 可选模型。

2026-10-18 本地验收：

| 命令 | 结果 |
|---|---|
| `pnpm vitest run --project adapter-workbuddy --maxWorkers=2` | 53 通过，6 跳过（真实入口和未声明的契约能力）；执行时显式设 `WEVIR_TEST_WORKBUDDY=0` |
| `pnpm vitest run --project host --maxWorkers=2` | 803 通过，4 跳过 |
| `pnpm vitest run --project protocol --maxWorkers=2` | 790 通过，含所有历史冻结样本和 0.55.0 |
| `pnpm vitest run --project desktop --maxWorkers=2` | 863 通过 |
| `pnpm typecheck`、`pnpm lint` | 通过；lint 有一条原有的 selection-toolbar 信息提示，无错误 |
| `pnpm --workspace-concurrency=2 --filter '@wevir/host...' build` | 通过，桌面生命周期测试使用更新后的 Host 产物 |

另在临时目录验证引擎边界：两个腾讯包名和两种 npm 别名在非 owner 包中均被拒绝，owner 规则通过；产品适配器仍只有两项工作区依赖。

维护者还需用自己的账号验证：国内 / 国际登录检测；模型列表和 `set_config_option`（含切换模型后的档位）；一次带工具的对话；审批允许 / 拒绝与 AskUserQuestion / ExitPlanMode；取消；Host 重启后续接；`usage_update` 与图片；同进程会话隔离和自动更新后的退出恢复。以上没有被无账号探测或假 CLI 测试证明。
