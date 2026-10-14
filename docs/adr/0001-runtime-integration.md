# ADR-0001：dsh 接入路径：ACP 子进程 + 增量流式旁路

- 状态：Accepted（2026-10-12）
- 日期：2026-10-12
- 任务：T0.6；影响 T1.1、T1.3、T3.1–T3.6、T4.2
- 依据：[dsh 接入 Spike](../research/dsh-integration-spike.md)（T0.3，`spikes/dsh-acp/`，dsh `0.2.1-alpha.2` = 上游 `d743267`）；[Paseo 研读](../research/paseo-notes.md) §7 与 A19、A20

## 背景

- dsh 是 developer preview，官方明确会有不兼容变更（计划 §1.2）。Wevir 只能在 `packages/adapter-dsh` 一个包里接触它（计划 §2.2）。
- dsh 有两条进程外接入路径：ACP（`dsh --profile acp`，标准 Agent Client Protocol v1）与 SDK（`dsh --profile sdk`，dsh 私有 JSON-RPC）。T0.3 用真实 dsh + 本地脚本化 mock 模型把两条路径都跑了一遍（52 项断言通过），结论：

| 骨架需要的能力 | ACP | SDK | 依据 |
|---|---|---|---|
| 取消 | `session/cancel`，3–64 ms 内结算为 `cancelled`，正在跑的子进程被杀 | 无，只能杀进程 | T0.3 §5.4、§7 |
| 审批 | `session/request_permission`，allow / reject / cancel 均可 | 无应答方，升级请求记为 `unavailable` | T0.3 §5、§7 |
| 会话生命周期 | `new` / `list` / `close` / `resume`；新进程 resume 后模型上下文完整 | 无 list / close | T0.3 §3.2、§8 |
| 增量流式 | **无**：一条已提交消息一个 chunk，170 字的回答 3.3 s 后一次性到达 | 同样没有 | T0.3 §4 |
| 标题、todo、子 agent、事件序号 | 无 | 有 | T0.3 §7 |
| 单进程多会话 | 3 个会话并发正常 | — | T0.3 §10 |
| 冷启动到 initialize 完成 | 中位 0.44–0.48 s | 0.42 s | T0.3 §2 |

- 增量流式的缺口可以不改 dsh 补上：dsh 进程内有 `agent/assistant-stream` 增量帧，T0.3 用一个 20 行的 Cordis 插件（`spikes/dsh-acp/stream-tap/`）把它写到额外 fd，首个分片 85 ms 到达（T0.3 §4）。

## 决策

### 1. 接入方式

- Host 以子进程运行 `dsh --profile acp`，经 stdio 走 ACP v1。ACP 客户端库用 `@agentclientprotocol/sdk`，**锁定 `1.4.0`**，与 dsh-acp 自己锁定的版本相同（npm latest 已是 1.8.0）；升级 dsh 时一起核对。
- dsh **锁定 `@deepseek-ai/dsh@0.2.1-alpha.2`**（npm `latest` 标签仍是 `0.2.0-rc.2`，必须写精确版本）。这两个依赖只由 `packages/adapter-dsh` 声明。
- `initialize` 的 `clientCapabilities` 不声明 `fs` 与 `terminal`（ACP 默认均为 false，T0.3 即以 `{}` 运行，`fixtures/acp/initialize.request.json`）：Host 不替引擎读写文件或执行命令，工具一律在 dsh 的沙箱里执行（Paseo A19、N5）。

### 2. 进程模型

- 一个 Host 一个 dsh 进程，承载该 Host 的全部会话；dsh 进程只由 `adapter-dsh` 管理，Host 是唯一调度者（计划 §8）。
- 一个 Wevir 会话对应一个工作区目录，即 `session/new` 的 `cwd`。dsh **进程**的 cwd 是 Wevir 自己的目录（`DSH_HOME`），不得是用户工作区：环境里没有 Key 时，dsh 会把 `<进程 cwd>/.env` 里的值发给 Provider（T0.3 §6.3）。
- 进程退出（无论是否在回合中）都上报为引擎错误，相关会话转 `error`（Paseo A19：Paseo 只在回合中上报）。重启策略在 T3.1 实现。
- 回收：先关 stdin（T0.3 实测 EOF 后 22–29 ms 退出），超时再 SIGTERM、SIGKILL。

### 3. 增量流式旁路（新任务 T3.2a）

- 把 stream-tap 产品化为 `packages/adapter-dsh` 内的 Cordis 插件：监听 `agent/assistant-stream`，以 NDJSON 写到 spawn 时额外打开的 fd 3，fd 号经环境变量 `WEVIR_STREAM_FD` 告知插件；不碰 stdout 上的 ACP 流量。插件只用 Cordis 的 `ctx`，不 import `@deepseek-ai/*`。
- 用 dsh 官方插件机制装配，不 fork、不改 dsh 源码：`dsh plugin --profile acp add link:<插件目录>` 写入 Wevir 专属 `DSH_HOME` 的 profile，`--patch` overlay 里 `insert` 该插件。
- 合并规则：适配器按会话实时产出增量；收到 ACP 已提交的 `agent_message_chunk` 后以它为准替换（`attemptId` 与 `messageId` 不同，按会话内顺序对齐，T0.3 §4）。
- 旁路是增强而不是依赖：插件缺失或 fd 无数据时，适配器只产出已提交消息，其余功能不受影响。

### 4. 进程环境

| 项 | 做法 | 原因（T0.3） |
|---|---|---|
| 子进程环境 | 按白名单构造，不继承用户 shell 里的 `DEEPSEEK_API_KEY`、`ANTHROPIC_*` 等 | 凭据解析顺序：继承的环境变量 > `$DSH_HOME/.credentials.yaml` > `<进程 cwd>/.env` > `$DSH_HOME/.env`（§6.3） |
| `DSH_HOME` | `<Wevir 数据目录>/engines/dsh`，不与用户自己的 dsh 混用 | §2 |
| `DSH_AGENTS_HOME` | 指向 Wevir 专属的空目录（骨架默认隔离） | 默认 `~/.agents` 的 skills 与 AGENTS.md 会进入每个会话的首个请求（本机约 15 KB，§10） |
| 遥测 | `DSH_TELEMETRY_DISABLED=1` | `dsh-base` 带 OTel 遥测（§10） |
| DeepSeek 请求的附加字段 | Provider overlay 写 `session-log-deepseek` 与 `plugin-package-inventory-deepseek` 的 `enabled: false` | `dsh-base` 默认给 `llm-deepseek` 的每个请求附带会话日志 `dsh_session_log` 与插件清单 `dsh_plugin_packages`，不受 `DSH_TELEMETRY_DISABLED` 控制（docs/security.md §4） |
| 权限模式 | `DSH_PERMISSION_MODE` 显式设为 `workspace-write`（进程级，与 dsh 当前默认相同），不依赖默认值 | §5.1 |
| 模型 Key | 只经子进程环境变量 `WEVIR_PROVIDER_<ID>_KEY` 传入；overlay 里只写 `apiKeyEnv` 变量名 | §6.1、计划 §2.8 |
| Provider 配置 | 由 Host 生成 `--patch` overlay（格式见 T0.3 §6.2，含 `compat`、`contextWindow` 与 `web-search-deepseek` 的 Key 引用） | §6.2 |
| 安装脚本 | 放行 dsh 依赖里必需的安装脚本（T0.3 在 npm 下是 5 个：`@deepseek-ai/dsh-subprocess-local`、`koffi`、`node-pty`、`protobufjs`、`@google/genai`），pnpm 下的写法见 ADR-0004 | §1 |

### 5. 产品层事实归 Host

ACP 给不了、或给得不完整的信息，由 Host / 适配器自己补，不等 dsh：

| # | 能力 | 做法 | 任务 |
|---|---|---|---|
| 1 | 增量流式 | 决策 3 | T3.2a、T3.2 |
| 2 | 历史回放、会话列表、标题、时间 | Wevir 事件库是唯一来源；不依赖 `session/list`（只有 `sessionId` + `cwd`，且不含活跃会话）与 resume（不回放 update） | T2.2、T3.5 |
| 3 | 事件序号 | Host 分配 `seq` | T2.2 |
| 4 | 标题 | 骨架由 Host 取首条提示词生成 | T2.3 / T3.2 |
| 5 | todo | 解析 `todo_write` 的 `tool_call.rawInput`（完整列表） | T3.2 |
| 6 | 审批详情 | `request_permission` 只带 `toolCallId`，详情取同一 `toolCallId` 之前那条 `tool_call` 的 `rawInput`（路径、内容、`sandbox_permissions`、`justification`） | T3.3 |
| 7 | 审批选项 | 原样携带 ACP 给的选项（dsh 只有 `allow_once` / `reject_once`）；“总是允许”只能由 Host 记规则自动应答，骨架不做 | T1.1、T3.3 |
| 8 | 工具展示类型 | ACP `kind` 恒为 `other`、无 `locations` / `diff`：按工具名映射展示类型（参考 Paseo A20 的分类），从 `rawInput` 提取路径 | T1.1、T3.2、T5.3 |
| 9 | 错误分类 | 轮次失败是 `-32603` 自由文本：按前缀归类（缺凭据、Provider 错误、未知），始终保留原文 | T3.2 |
| 10 | 子 agent 活动 | 骨架只显示父会话的 `subagent` 工具调用；子会话事件推迟到 Phase 1（同一插件补发） | Phase 1 |

### 6. 审批、取消与恢复的语义

- dsh 的审批**只来自沙箱升级**：`workspace-write` 下工作区内读写、系统临时目录写入都不需要审批；工作区外的操作先失败，模型带 `sandbox_permissions` 重试才触发 `request_permission`（T0.3 §5.1）。界面文案、验收用例都按这一点设计。
- 客户端取消时，挂起的审批必须以 `{"outcome":{"outcome":"cancelled"}}` 回复，否则 dsh 侧悬挂（T0.3 §5.4）。
- `session/resume` 只能用会话创建时的 `cwd`（按 realpath 比较），活跃会话不能 resume（`-32602 session is already active`，T0.3 §3.2）。引擎会话恢复不了时会话只读，历史仍在 Wevir（补记 6）。

### 7. 适配器接口的调整（T1.3）

- `cancel` 幂等，只在无法确认已停止时失败；适配器能列出未决审批，供 Host 重启或客户端中途加入时对账（Paseo A19）。
- `AgentEvent` 区分“增量”与“已提交消息”，后者替换前者。
- 契约测试套件带能力声明开关（例如“支持增量流式”），引擎做不到的条款按开关跳过，不删条款。

## 备选方案

| 方案 | 结论 | 原因 |
|---|---|---|
| SDK JSON-RPC（`dsh --profile sdk` + `@deepseek-ai/dsh-sdk-client`） | 不作主路径 | 没有取消和审批，骨架最硬的两条需求都满足不了；它多出来的标题、todo、子 agent、`seq` 可以由旁路插件补发 |
| Web profile 的远程 RPC | 未采纳 | 是 `agent/assistant-stream` 唯一的远程消费方，但属于 dsh 自家 Web 界面的私有协议，T0.3 没有评估；ACP 加 20 行插件已够用 |
| 进程内嵌入（adapter-dsh 直接 import dsh 包，在 Host 进程里跑 Cordis 应用） | 不采纳 | Host 进程要加载 dsh 的原生模块和预览版内部实现，引擎崩溃会拖垮 Host；违背计划 §1.2“作为依赖运行（子进程）” |
| 修改 dsh 源码让 ACP 发增量 | 不采纳 | 计划 §7 不修改 dsh；官方插件机制已能做到 |
| 不补增量，只显示整条消息 | 不采纳 | 计划 §4.2 第 3 条要求流式输出；整条到达要等 3 s 以上 |
| 每会话一个 dsh 进程（Paseo 的做法） | 不采纳 | T0.3 已验证单进程多会话，所有 update 都能按 `sessionId` 归属；每会话一进程意味着每次建会话都多一次约 0.5 s 的冷启动和一份 dsh 运行时内存 |

## 后果

- 收益：取消、审批、会话生命周期走标准协议；同一套 ACP 映射以后可以复用到 Claude Code、Codex、Gemini CLI 等 ACP Agent。
- 旁路依赖 dsh 的**进程内**事件 `agent/assistant-stream`，它不是公开契约，dsh 升级可能改名或改形状。对策：升级检查清单（T3.6 写入 UPSTREAM.md）必须重跑旁路测试；旁路失效时只退化为整条消息，不影响其他功能。
- 错误按自由文本归类，dsh 改措辞就会落到“未知”。对策：保留原文，归类失败不影响会话状态转换。
- 审批卡片出现与否取决于模型是否按提示升级，真实模型是否可靠尚未验证（T0.3 §9 第 1 条）。计划 §4.2 第 4 条与 Gate M4 的用例必须包含一次工作区外、非系统临时目录的操作。
- `DSH_AGENTS_HOME` 隔离后，用户自己 `~/.agents` 里的 skills 在骨架阶段不可用。
- dsh 运行时带原生模块（`node-pty`、`koffi`）。骨架阶段只跑开发模式，用开发者本机的 Node；打包时 dsh 跑在哪个 Node 上见 ADR-0002 未决事项。
- dsh 的 npm 依赖闭包里有非宽松许可证（`@deepseek-ai/libreoffice-kit*` 为 MPL-2.0，`sharp` 的 libvips 为 LGPL-3.0-or-later），分发 dsh 时的义务记在 UPSTREAM.md §2.1，由 T6.3 与打包阶段处理。

## 未决事项

1. **OAuth 类 Provider**（Codex、Claude 等订阅账号登录）：ACP 没有登录入口；grant 的 refresh token 会轮换，只能留在 dsh 能写的 `DSH_HOME/.credentials.yaml`，与计划 §2.8“密钥不落 DSH_HOME”冲突（T0.3 §6.4）。Phase 1 前单独做 Spike 决定登录入口、存放位置和各家条款；在那之前 Wevir 只支持 API Key 类 Provider，§2.8 不改。
2. **`DSH_AGENTS_HOME` 是否共享用户的 `~/.agents`**：骨架隔离；Phase 1 做 Skills 管理时再定。
3. **真实模型下的待验证项**（T0.3 §9：模型是否按提示升级、真实流式节奏下的首字时间差、DeepSeek 官方路由、`usage_update` 数值）：有 Key 后执行 `WEVIR_SPIKE_API_KEY=... npm run spike`，结果补记到本 ADR。
4. ~~**Provider 变更是否需要重启 dsh 进程**~~：已由 T3.4 实测，需要重启，见补记 5。

## 补记

1. **2026-10-13，T3.1：dsh 进程管理的实现细节。** 代码在 `packages/adapter-dsh/src/{paths,env,dsh-process}.ts`。决策 2、4 没有写到、由 T3.1 定下或实测确认的部分：
   - **可执行入口**：读本包依赖 `@deepseek-ai/dsh/package.json` 的 `bin.dsh`（`lib/bin.js`），用 Node 运行，不查 PATH；解析到的版本不等于 `DSH_VERSION`（`0.2.1-alpha.2`）时启动失败。开发模式下 Node 是 Host 自己的 `process.execPath`（ADR-0002 未决事项 1）。
   - **目录**：`DSH_HOME` 为 `<数据目录>/engines/dsh`，`DSH_AGENTS_HOME` 为 `<数据目录>/engines/dsh-agents`。后者放在 `DSH_HOME` 之外，`DSH_HOME` 只装 dsh 自己写的内容。每次启动前建好两个目录并收紧到 0700；`profiles/`、`sessions/` 等由 dsh 首次启动时生成。
   - **环境**：白名单 `INHERITED_ENV` 只有 PATH、HOME、用户名、shell、区域与时区、临时目录、代理、`NODE_EXTRA_CA_CERTS` 和 Windows 的系统变量（Windows 上变量名不分大小写）。固定注入 `DSH_HOME`、`DSH_AGENTS_HOME`、`DSH_TELEMETRY_DISABLED=1`、`DSH_PERMISSION_MODE=workspace-write`、`NO_COLOR=1`，变量名按 dsh-base 的 `cordis.patch.yml` 核对过。调用方的额外变量（T3.4 的 `WEVIR_PROVIDER_<ID>_KEY`）不能覆盖这几个。`NODE_OPTIONS` 与 `NODE_PATH` 都不传：pnpm 的 bin 脚本（`pnpm test` 等）会把 `NODE_PATH` 设成 `node_modules/.pnpm/node_modules`，Vitest 还会带上 `--conditions`。
   - **启动参数**：`<Node> <入口> --profile acp [--patch <overlay>]…`（`dshSpawnSpec`），cwd 为 `DSH_HOME`。给了 `onStreamData` 才多开 fd 3 并设 `WEVIR_STREAM_FD=3`（T3.2a）。POSIX 上以 `detached` 启动、自成进程组：在终端里按 Ctrl-C 时 SIGINT 只到 Host，由 Host 按 ADR-0002 §6 的顺序收尾，dsh 不会同时被打断；回收时的 SIGTERM / SIGKILL 发给整个进程组。Windows 上不分离（分离会给 dsh 开新控制台）。
   - **initialize**：`clientCapabilities: {}`，时限 15 s，dsh 回的协议版本不是 1 也算启动失败。失败报 `engine_unavailable`，消息里带退出码和 stderr 尾部（只保留最后 16 KiB）。显式 `start()` 失败不自动重试。
   - **退出与重启**：就绪的进程意外退出（不论是否在回合中）时发 `exit` 事件（`DshExit`：退出码、信号、stderr 尾部），进行中的 ACP 请求以 `engine_unavailable`（“dsh 进程已退出（…）”）失败。stdout 可能先于进程的 exit 事件结束，所以 ACP 的输入流要等退出记下来才结束，否则请求只会得到笼统的“连接已关闭”。之后自动重启，最多连续 3 次，分别等 0.5 s、1 s、2 s（上限 8 s）；进程就绪后连续运行满 60 s 再退出，次数重新计算。次数用完停在 `failed`，再调 `start()` 也重新计算。每次重启都是新连接，旧会话随进程失效，要 resume（T3.5）。
   - **回收**：关连接 → 关 stdin 等 2 s → SIGTERM 等 1.5 s → SIGKILL 等 1 s，最坏 4.5 s 返回，在 Host 退出的 7 s 预算之内（ADR-0002 补记 3）。`dispose` 引起的退出不发 `exit` 事件。
   - **审批默认值**：没有接上审批处理器（T3.3 之前）时，`session/request_permission` 一律回复 `cancelled`，不替用户批准任何操作。
   - **实测**（本机 macOS arm64，Node 26.10，`dsh-process.integration.test.ts`）：spawn 到 initialize 完成 520 ms；一个进程并发新建 3 个会话正常；空闲时 `dispose` 在第一步（stdin EOF）22 ms 返回，没有用到信号。另一条用例模拟 Host 被强杀：一个假 Host 按 `dshSpawnSpec` 拉起 dsh 并转发 stdio，模型换成本地脚本化的 OpenAI 兼容服务（不需要 Key），让 dsh 用 bash 工具执行 `sleep 291`。假 Host 被 SIGKILL 后，dsh 在 51 ms 内因 stdin EOF 退出，`sleep` 也随之结束。进程树检查依赖 `ps`，这条用例在 Windows 上跳过。
2. **2026-10-13，T3.2a：增量流式旁路的实现细节。** 插件在 `packages/adapter-dsh/stream-tap/`，Host 一侧在 `src/stream-tap.ts` 与 `src/dsh-process.ts`。决策 3 没有写到、由 T3.2a 定下或实测确认的部分：
   - **插件**：`stream-tap/index.js` 是纯 JS 的 Cordis 函数插件（只导出 `name` 与 `apply`，不默认导出），只 import `node:fs`，dsh 直接加载这个源文件，不经构建。包名 `@wevir/dsh-stream-tap`，没有依赖，随适配器包发布（`files`）。Biome 对这个目录单独禁止 `@deepseek-ai/*`（`biome.json`）。
   - **线格式**：每行一条 JSON。`apply` 时写一次 `{"type":"ready"}`；之后每帧写 `{"type":"frame","sessionId":…,"frame":…}`，帧原样转发（dsh 的 `AssistantStreamFrame`，上游 `packages/core/agent/src/runtime-types.ts`）。`sessionId` 与 ACP 的 `sessionId` 相同（实测）。监听器里的异常吞掉并告警，写 fd 失败（EPIPE、EBADF）后停止转发，都不影响 dsh。
   - **装配**：每次启动前检查 `$DSH_HOME/profiles/acp`：`package.json` 声明了依赖，且 `node_modules/@wevir/dsh-stream-tap` 的真实路径等于插件目录，就跳过安装；否则运行 `dsh plugin --profile acp add link:<插件目录的真实路径>`（cwd 为 `DSH_HOME`，白名单环境，不带 Provider Key，时限 60 s）。profile 不存在时 dsh 先从随附模板生成，与直接 `--profile acp` 启动生成的相同。插件包不声明 `dsh.bundle`，dsh 会告警 “installed as a plain dependency”，这是预期的：插件行由插件目录里随附的 `overlay.yml` 作为最后一个 `--patch` 插入，每次启动由 Wevir 决定用不用。插件目录换了位置（应用升级、搬家）时会重新 link。本机实测 `dsh plugin add` 约 0.2 s，不访问网络。
   - **插件目录**：默认 `defaultStreamTapPluginDir()`，即本包的 `stream-tap/`。开发模式下它就是 workspace 里的目录，从 `src/` 与 `dist/` 都按 `../stream-tap` 找到。打包后由调用方经 `DshProcessOptions.streamTap.pluginDir` 给出。
   - **fd 3 解码**：`StreamTapDecoder` 按 `\n` 切行，整行凑齐再按 UTF-8 解码，所以多字节字符被两次读取切开也没关系；容忍空行与 `\r\n`，单行上限 8 MiB。`text-delta` / `reasoning-delta` 变成 `assistant.delta`（`kind` 分别为 text / reasoning，`blockIndex` 是内容块序号），`end` 变成 `assistant.stream_ended`（committed / abandoned）；空文本、`start` 帧与其他 chunk 类型不产出事件。畸形行、超长行和 fd 关闭时没有换行的半行都告警后跳过。一个 dsh 进程一个解码器。增量与已提交消息的合并在 T3.2。
   - **退化**：旁路的任何问题都不让启动失败。`DshProcess.streamTapState` 为 `off`（没配置旁路）、`unavailable`、`waiting`、`active`。插件装不上（pnpm 不在 PATH、超时、插件目录缺 `overlay.yml`）时告警 `install_failed`，本次启动不开 fd 3、不插入插件行。插件行插入了但加载失败时，dsh 只在 stderr 告警 “entry did not activate”，其余插件照常启动（实测）；initialize 完成后 2 s 内没收到 ready，适配器告警 `not_loaded`（带 stderr 尾部）。这几种情况都只有 ACP 的已提交消息。契约测试的能力声明用 `dshAdapterCapabilities(streamTapState)`，只有 `active` 时 `incrementalStream` 为 true，其余能力不变。
   - **实测**（本机 macOS arm64，Node 26.10，`stream-tap.integration.test.ts`；mock Provider 先发 3 片推理、再发 20 片文本，每片间隔 100 ms）：首个增量 82 ms 到达，首个文本增量约 383 ms，ACP 的整条消息约 2420 ms，3 次运行一致。文本增量拼起来与 `agent_message_chunk` 相同，推理增量与 `agent_thought_chunk` 相同；committed 的 end 帧可能晚于 `session/prompt` 的响应。去掉插件、插件加载失败两种情况下会话照常完成。dsh 升级时要重跑这个测试（见“后果”）。
   - **待定（打包）**：`dsh plugin` 要求 PATH 上有 pnpm，打包后的用户机器上不一定有。实测 overlay 的插件行直接写插件入口的绝对路径（`name: /…/stream-tap/index.js`）同样能加载，不需要 `dsh plugin add` 与 pnpm。打包阶段与 ADR-0002 未决事项 1 一起决定：随应用带 pnpm，或改用按路径插入。
3. **2026-10-13，T3.2：ACP → Wevir 事件映射与 `DshAdapter`。** 映射表、工具名表、错误归类表在 [acp-event-mapping.md](../architecture/acp-event-mapping.md)（与代码的一致性由 `acp-event-mapping.test.ts` 检查），代码在 `packages/adapter-dsh/src/{acp-mapping,tool-display,turn-error,delta-merge,session-events,dsh-adapter}.ts`。决策 3、5 没有写到、由 T3.2 定下或实测确认的部分：
   - **`session/update` 在 ACP SDK 之前截下。** SDK 1.4.0 收到通知先做 zod 校验：不认识的 `sessionUpdate` 类型整条不交给处理器（只打印一行错误），认识的类型里不认识的字段被删掉、不认识的枚举值被丢掉（实测）。决策 5 要求不认识的内容以 `engine.raw` 原样保留，所以 `DshProcess` 在 `ndJsonStream` 与 SDK 之间插一个 `TransformStream`：`session/update` 原样同步交给 `onSessionUpdate`（参数类型因此是 `unknown`，由映射自己检查字段），其余消息照常给 SDK。截取在 SDK 读到消息之前，同一条流里后到的 `session/prompt` 响应兑现时它前面的通知都已入队，回合终结事件总在该回合其他事件之后。
   - **`DshAdapter`（`AgentRuntimeAdapter` 的 dsh 实现）由本任务建立**，T3.1 只有进程管理：一个 `DshProcess` 承载全部会话；`createSession` 发 `session/new {cwd, mcpServers: []}`，返回 `configOptions` 里引擎当前的模型与推理强度；`send` 发出 `session/prompt` 就返回，结果映射为 `turn.settled`、错误映射为 `turn.failed`；`cancel` 发 `session/cancel` 后等回合结算，4 s（`CANCEL_TIMEOUT_MS`，先于 Host 的 5 s）内没结算报 `cancel_unconfirmed`；`close` 先取消，`session/close` 失败（如 `-32602 unknown session`）不阻止关闭；进程退出时每个挂着的会话发 `engine.exited` 并脱开；增量旁路默认开启。每个引擎会话一个 `SessionEventQueue`：三路输入（ACP 更新、旁路增量、回合边界）同步入队，按调用顺序扇出给订阅者。尚未实现：审批（T3.3；之前 `DshProcess` 对每个审批请求回复 `cancelled`，`respondToApproval` 报 `approval_not_found`）、脱开或关闭之后的 `resumeSession`（T3.5）、`cancel_unconfirmed` 之后重启 dsh（T3.5）；`SessionConfig` 的 Provider 与模型由 T3.4 的 overlay 决定，适配器不切换。
   - **增量对齐依据的 dsh 行为**（上游 `dsh-acp/src/updates.ts`、`dsh-llm/src/assembler.ts`、`agent-loop/src/agent.ts`）：ACP 按块各发一条 chunk（每个长度非零的文本块一条 `agent_message_chunk`、推理块一条 `agent_thought_chunk`，同一 `messageId`），不是每个 attempt 一条（T0.3 样本里每个 attempt 只有一个文本块）；只有取消时才丢掉只含空白的块，一个都不剩就落成 `assistant/attempt`，没有已提交消息。旁路插件异步写 fd 3，fd 3 与 stdout 之间没有顺序，所以配对按会话内顺序、再用内容核对（增量文本是已提交文本的前缀），并处理已提交消息先到、尾部增量后到两种情况（acp-event-mapping.md §4）。`StreamTapDecoder` 把 committed 但落成 `assistant/attempt` 的 end 帧改报 `abandoned`（它的增量不会被替换）。旁路里属于子 agent 会话的帧（ACP 看不到这些会话）丢弃。
   - **错误归类的样本**：除 T0.3 的两个缺 Key 样本，用真实 dsh + 本地 mock Provider 录了 5 个 Provider 失败（`test-fixtures/acp/errors/prompt-provider-*.json`，`turn-error.integration.test.ts` 逐字复现）。llm-pi-ai 写成 `turn failed: <状态码>: <error JSON>`，连不上与中途断开都是 `turn failed: Connection error.`，归 `provider`；llm-deepseek 把服务端的 `error.message` 原样接在 `turn failed: ` 后面，没有状态码、没有可依赖的前缀，归 `unknown`（原文保留，界面照样能显示原因）。可重试的错误（429、5xx、连接错误）dsh 默认重试 5 次，约 16 s 后才以最后一次的原文失败。
   - **告警**：映射不了的内容按“原因 + `sessionUpdate` 类型”在一个适配器实例内只告警一次（`warnOnceVia`）；`config_option_update` 是有意的 `engine.raw`，不告警。适配器的 `logger` 与 Host 的 Logger 同形（`warn(message, fields)`），T3.6 接 Host 时传入。
4. **2026-10-13，T3.3：审批桥接。** 规则与对照表在 [acp-event-mapping.md](../architecture/acp-event-mapping.md) §5，代码在 `packages/adapter-dsh/src/dsh-adapter.ts`。决策 5、6 没有写到、由 T3.3 定下或实测确认的部分：
   - **审批请求经 ACP SDK 应答**，不像 `session/update` 那样在 SDK 之前截下：响应要经 SDK 的写队列写回。`approval.requested` 排在同一 `toolCallId` 的 `tool.started` 之后，靠两点保证：dsh 先把积压的更新写完才发审批请求（上游 `packages/acp/acp/src/index.ts` 的 `drainUpdates`），更新在 SDK 读到消息之前就已同步入队（补记 3）。适配器交给 Host 的 `requestId` 是自己分配的 `perm-<n>`，不用 JSON-RPC id（dsh 重启后会重复）。
   - **详情仍由 Host 生成**（决策 5 第 6 条）：`approval.requested` 只带 `toolCallId` 与原样的选项，Host 从同一 `toolCallId` 的 `tool.started` 取 `rawInput`。
   - **取消时的写出顺序**：先 `session/cancel`，再以 `cancelled` 回复挂起的审批，与 T0.3 场景 D 实测的顺序相同（SDK 在 `notify` 调用时就把通知排进写队列）。`runtime-adapter` 接口注释原先写的是相反顺序，已改。
   - **不超时**：dsh 不给审批请求设时限，也不撤回（0.2.1-alpha.2 不发 `$/cancel_request`），不回复就一直等，所以未决审批默认等用户。取消、关闭、回合结束、引擎退出、`dispose` 时由适配器结束并回复 `cancelled`（引擎退出时已无从回复）。Host 优雅退出的主路径是 `SessionManager.shutdown()` 逐会话取消；`dispose` 兜底回复后先让回复写进 dsh 的 stdin（等一个 `setImmediate`，测试覆盖），再关连接。Host 被强杀时 dsh 因 stdin EOF 退出（补记 1），残留的未决审批由 Host 重启时的对账结为 `expired`（T2.3）。
   - **重复决定**：Host 首个决定生效、之后 `ALREADY_DECIDED`（T2.3）；适配器另外保证一个 `requestId` 只回复 dsh 一次（先移出未决表再回复，并发的第二个决定报 `approval_not_found`）。
   - **触发审批的测试目标**：dsh `workspace-write` 的可写根是工作区、`/tmp` 与 dsh 进程的 `os.tmpdir()`（上游 `packages/sandbox/sandbox/src/roots.ts`），测试的临时目录通常就在其中，所以要审批的用例把目标建在 `packages/adapter-dsh/.test-outside/`（gitignore）。真实 dsh + mock Provider 下复核了：工作区内与系统临时目录的写入没有审批，工作区外写入先被沙箱拒绝、升级重试才请求审批，批准后写成、拒绝后工具失败。
   - **真实模型尚未验证**（未决事项 3 仍未决）：`dsh-adapter.approval.integration.test.ts` 的真实模型用例要求一次工作区外、且不在系统临时目录的写入，设了 `WEVIR_TEST_API_KEY` 才跑（默认 DeepSeek 官方路由，`WEVIR_TEST_BASE_URL` + `WEVIR_TEST_MODEL` 改走 OpenAI 兼容服务）；T3.3 完成时本机没有 Key，未运行。
5. **2026-10-13，T3.4：Provider 配置桥接与变更的生效。** 映射规则、国内服务示例与 `provider.test` 的归类在 [providers.md](../architecture/providers.md)，代码在 `packages/adapter-dsh/src/{provider-config,provider-test,dsh-adapter,dsh-process}.ts` 与 `packages/host/src/host-methods.ts`。决策 4 没有写到、由 T3.4 定下或实测确认的部分：
   - **接口**：`AgentRuntimeAdapter` 新增三个可选方法：`validateProvider`（Host 在 `provider.upsert` 写库前调用，dsh 启动时校验整份配置，任何一处不合法都会让进程起不来，所以先挡住）、`configureProviders`（Host 启动时一次、每次 `provider.upsert` / `provider.remove` 写库后一次，传全部 Provider 与 Key）、`testProvider`。Host 不接触 dsh 的配置格式。
   - **overlay**：写在 `<DSH_HOME>/wevir/providers.yml`（0700 / 0600，临时文件 + rename），排在调用方的 `patches` 之前，只含 `apiKeyEnv` 变量名；用 JSON 写（YAML 1.2 是 JSON 的超集，实测 dsh 照收）。`llm-deepseek` 与 `web-search-deepseek` 的 Key 引用总是改成 `WEVIR_PROVIDER_DEEPSEEK_OFFICIAL_KEY`，没有 DeepSeek Provider 时也改；不写 `acp` 条目。`openai-compatible` 的 compat 按地址补默认值，每个开关只写给认它的协议（路由上写了读不了的开关 dsh 会拒绝整份配置）。`anthropic-messages` 只预留类型，`validateProvider` 拒绝。
   - **会话的路由**：`DshAdapter.createSession` 在 `session/new` 之后用 `session/set_config_option` 选定 `SessionConfig` 的 Provider 与模型（值是 dsh 的 `JSON.stringify([provider, model])`），给了推理强度时再设 `reasoning_effort`；选不上报 `invalid_input` 并关掉引擎侧的会话。补记 3 写的“Provider 与模型由 overlay 决定，适配器不切换”作废：一个 dsh 进程承载多个 Provider，`acp` 条目只能有一个默认路由。
   - **实测：dsh 不热加载 Provider 配置**（真实 dsh + 两个本地 mock Provider，`dsh-adapter.providers.integration.test.ts`）。运行中改 `--patch` 传入的 overlay（同一 Provider 换 `baseURL`），已有会话与新建会话的请求都还发往旧地址；改 `$DSH_HOME/profiles/acp/cordis.patch.yml` 加一个 Provider，新 Provider 的模型选不上（`unknown model option`）；Key 在子进程环境里，运行中的进程看不到新值。原因是 acp profile 关掉了 `hmr`，也没有 Web 界面的 `config-editor` 写入路径。重启 dsh 之后，新会话用新配置；旧会话 resume 之后的请求同样发往新地址、带新 Key（路由按 Provider ID 在每次请求时解析）。**Provider 变更必须重启 dsh 进程。**
   - **生效策略**：`configureProviders` 先换下一次 spawn 的配置（`DshProcess.setLaunchConfig`，之后的首次启动、崩溃重启、计划重启都用它）。dsh 没在运行就到此为止；在运行且没有进行中的回合时立即计划重启（`DshProcess.restart`：与 `dispose` 同一个回收阶梯，不发 `exit`、不计入崩溃重启次数），返回时新进程已就绪；有回合（含等审批）时不打断，等最后一个回合结束再重启，其间新建的会话建在旧进程上、用旧配置。
   - **对运行中会话的影响**：重启前挂在旧进程上的会话以 `engine.exited`（新增可选字段 `reason: 'config_changed'`，`exitCode` / `signal` 为 null）脱开，Host 转 `error`，消息提示 resume；只在没有回合时重启，所以没有回合被打断、没有审批被结掉。resume（T3.5）之后会话用新配置继续；被删除的 Provider 的会话不能 resume。
   - **`provider.test` 不经 dsh**：适配器按 dsh 的请求拼法直接向 Provider 发一次最小的流式请求（`max_tokens` 1，收到第一条合乎协议的数据就断开），按状态码与错误原文归为 `missing_key` / `network` / `timeout` / `auth` / `model_not_found` / `protocol` / `rate_limited` / `server` / `unknown`。经 dsh 的话每次都带完整系统提示词与工具定义，代价高，失败时也只有自由文本（补记 3）。协议为此升到 0.2.0（`provider.test` 结果加 `reason`、`httpStatus`，`ProviderModel` 加 `maxTokens`、`supportsImages`、`reasoningEfforts`，均为 optional；最低版本仍是 0.1.0）。
   - **真实 Provider 尚未验证**：`provider-test.integration.test.ts`（正确 Key 成功、错误 Key 为 `auth`、不存在的模型为 `model_not_found`）设了 `WEVIR_TEST_API_KEY` 才跑，T3.4 完成时本机没有 Key，未运行；`model_not_found` 依赖服务端措辞，最需要在真实端点上确认。
6. **2026-10-13，T3.5：会话恢复。** 归类表在 [acp-event-mapping.md](../architecture/acp-event-mapping.md) §6，Host 一侧的规则在 [domain-model.md](../architecture/domain-model.md) §4.4，代码在 `packages/adapter-dsh/src/{resume-error,dsh-adapter}.ts` 与 `packages/host/src/{session-manager,snapshot}.ts`。决策 5、6 没有写到、由 T3.5 定下或实测确认的部分：
   - **resume 不认 ID 的来历**：适配器不认识的会话（Host 重启后适配器是新的）照样发 `session/resume`，已挂在本进程上的直接成功、不发 ACP（dsh 拒绝 resume 活跃的会话）。恢复后按 Host 记录的路由 `set_config_option`：dsh 恢复的是日志里最后的路由，Provider 变更（补记 5）之后可能不同。dsh 说会话仍活跃（之前 `session/close` 失败、适配器按已关闭处理）时沿用它。
   - **实测：恢复不了的会话**（真实 dsh，不需要模型）。会话日志被删除或日志头读不出来是 `-32602 session is not resumable`；日志由更新版本写入（格式 v5）、日志损坏是 `-32603 Internal error`，原文在 `data.details`（`… uses log format v5, but this harness reads only v4 …`、`… stored log is corrupt …`）；cwd 不存在与 cwd 不一致是同一句 `session cwd does not match`。三种恢复不了的情况适配器报新的 `session_lost`（`AdapterError.lostReason`：`not_found` / `incompatible` / `corrupted`），Host 据此把会话标为只读；cwd 不一致、引擎不可用不标只读。`AgentRuntimeAdapter` 的契约随之改为：`resumeSession` 遇到引擎里没有的会话报 `session_lost`（不再是 `session_not_found`）。
   - **引擎版本**：`EngineSession` 加可选的 `engineVersion`，dsh 适配器填锁定并经 `resolveDshEntry` 核对过的包版本（ACP 的 `agentInfo.version` 恒为 0.0.1，T0.3 §3.1）。Host 记进 `session.created` 与新事件 `session.resumed`，排查跨版本问题时对比两者。
   - **取消得不到确认时重启 dsh**：`cancel` 报 `cancel_unconfirmed` 的同时，适配器把挂着的会话全部以 `engine.exited`（`reason` 新增 `cancel_unconfirmed`）脱开并计划重启 dsh（与补记 5 同一条路径）。不重启的话，卡住的会话在 dsh 里仍活跃，resume 被拒，回合也一直占着它；代价是同进程上其他会话的回合被打断，它们按引擎退出处理、resume 后继续。
   - **resume 前后的上下文**：新进程 resume 之后，模型收到的第一个请求带着之前的全部用户消息与回复（真实 dsh + mock Provider，与 T0.3 §8 一致）；界面层信息（历史、标题、列表）resume 不提供，全部来自事件库。真实模型的同一用例（追问能引用之前告知的暗号）需要 `WEVIR_TEST_API_KEY`，T3.5 完成时本机没有 Key，未运行。
   - 协议为此升到 0.3.0：新事件 `session.resumed`、`session.read_only`，`Session.readOnly`，`INVALID_STATE` 的 `data.readOnly`，`session.created.engineVersion`，均为新类型或 optional 字段（host-api.md §10）。基于只读会话的历史新建会话只定了 Host 内部接口 `SessionFromHistory`，Host API 方法留到实现时再加。
7. **2026-10-13，T3.6：适配器契约测试的三层与 Host 接通。** 同一套 `runAdapterContract`（T1.3，18 条）跑 `DshAdapter`，代码在 `packages/adapter-dsh/src/dsh-adapter.contract*.test.ts` 与 `test-fixtures/{contract,escalation,real-model}.ts`、`test-fixtures/fake-dsh.mjs`；Host 一侧在 `packages/host/src/cli.ts`。

   | 层 | 文件 | 引擎与模型 | 能力声明 | 结果（本机 macOS arm64，Node 26.10） |
   |---|---|---|---|---|
   | 1 回放 | `dsh-adapter.contract.test.ts` | `fake-dsh.mjs` 回放 T0.3 的 ACP 样本，没有模型 | `dshAdapterCapabilities('off')` | 17 条通过，增量条款跳过；约 1 s，CI 默认跑 |
   | 2 真实 dsh + mock Provider | `dsh-adapter.contract.integration.test.ts` | dsh `0.2.1-alpha.2`，旁路开启；本地 mock Provider，不需要 Key | `dshAdapterCapabilities('active')` | 18 条全部通过；三次运行 20–24 s，是否进 CI 由 T6.2 决定 |
   | 3 真实模型 | `dsh-adapter.contract.real.integration.test.ts` | dsh + `WEVIR_TEST_PROVIDER` 指定的 Provider | `dshAdapterCapabilities('active')` | 缺 `WEVIR_TEST_API_KEY` 或 `WEVIR_TEST_PROVIDER` 时整层跳过并打印原因；T3.6 提交时本机没有 Key，未运行（Gate M3 的这一项待补） |

   - **没有 dsh 满足不了的条款。** 真实 dsh 上 18 条全部通过，能力开关里没有因为 dsh 做不到而关掉的一项。回放层跳过增量条款是录制的缺口，不是 dsh 的：T0.3 只录了 ACP 一侧，旁路帧只有抽样（`test-fixtures/stream-tap/frames.sample.json`），没有与 ACP 样本对齐的完整录制；增量由第 2 层（插件真实加载）与 `delta-merge.test.ts`（真实帧形状）覆盖。第 2、3 层直接声明 `incrementalStream: true`，不按启动后的旁路状态推导：旁路失效时增量条款失败，而不是悄悄跳过，dsh 升级时必须看到它通过（UPSTREAM.md §7）。
   - **回放层的做法**：fake-dsh 按提示词回放录制里 dsh 写出的消息，会话 ID、`session/prompt` 的结果 id 和 dsh 发出的请求 id 换成当前的。plain 回放场景 F，toolCall 回放场景 A；approval 用 `replay:permission`：先回放 B 到审批请求为止，再按客户端的回复（选了 `allow_*` 还是 `reject_*` 的选项，或 `cancelled`）接 B、C、D 在审批请求之后的部分。三份录制的前半段同构（先被沙箱拒绝，升级重试才请求审批），后半段里重试那个工具的 `toolCallId` 换成 B 的。`FAKE_DSH_STORE=1` 让 fake-dsh 像真实 dsh 一样把会话记在 `DSH_HOME`：引擎被杀、自动重启后的新进程能 resume，没建过的会话回放 T3.5 录下的 `session is not resumable`（→ `session_lost`）。
   - **第 2 层的做法**：mock 模型按提示词里的标记作答：plain 先逐片发思考、再逐片发文本，toolCall 在工作区里 `write`，approval 用 T3.3 的升级脚本（目标在 `packages/adapter-dsh/.test-outside/`）。Provider 经 `DshAdapterOptions.providers` 走 T3.4 的桥接，与 Host 的路径相同；每条用例一个新的 `DSH_HOME` 和 dsh 进程（含 stream-tap 的安装）。“引擎退出”两条 SIGKILL dsh 主进程：`DshProcess` 自动重启，被杀之前的会话 resume 成功；“资源释放”检查适配器拉起过的每个 dsh pid 都已退出。
   - **第 3 层的开关**：`WEVIR_TEST_PROVIDER` 取 `ProviderConfig.kind`：`deepseek-official`（模型默认 `deepseek-v4-flash`，`WEVIR_TEST_MODEL` 可改），或 `openai-compatible`（另需 `WEVIR_TEST_BASE_URL` 与 `WEVIR_TEST_MODEL`）；值不对、缺地址或模型时报错，不悄悄跳过。Provider 同样走桥接，Key 只进 dsh 的子进程环境。T3.3–T3.5 的真实模型用例仍只看 `WEVIR_TEST_API_KEY`（默认 DeepSeek 官方，`WEVIR_TEST_BASE_URL` 改走 OpenAI 兼容服务），两套设法可以同时设。审批条款依赖模型按沙箱提示升级（未决事项 3）。
   - **Host 接通**：`wevir-host --adapter dsh`（默认值）由 `createAdapter` 建 `DshAdapter`：数据目录与 Host 相同，告警写 Host 的日志，增量旁路默认开启，`clientInfo` 带 Host 版本。dsh 的可执行入口在 Host 启动时就解析（`resolveDshEntry`），依赖没装好或版本不对时 Host 启动失败（退出码 1，原因写 stderr 与日志），不等到第一个会话；dsh 进程本身仍在第一次需要时才拉起（启动时只把 Provider 写成 overlay）。`@wevir/adapter-dsh` 因此从 Host 的 devDependency 改为运行时依赖；Host 仍不接触 `@deepseek-ai/*`，tsdown 把它当外部依赖，不打进 Host 的 `dist/`，`resolveDshEntry` 与旁路插件目录都按 adapter-dsh 包自己的位置解析。原先给“dsh 未实现”用的退出码 2 不再出现在这条路径上。
   - dsh 的升级检查清单写在 [UPSTREAM.md §7](../upstream/UPSTREAM.md#7-dsh-升级检查清单)。

8. **2026-10-14，ADR-0005：默认引擎换成 Codex。** 维护者决定以 `codex-app-server` 为默认引擎、Host 内置模型协议网关；dsh 保留为可选引擎，只做安全与隐私修复和跟进上游所需的升级，不再加新能力，也不再随安装包分发（用户选用时下载）。本 ADR 对 dsh 接入方式（ACP 子进程、stream-tap 旁路、进程环境与回收）的决定继续有效；通用的 ACP 部分将抽成通用 ACP 适配器（ADR-0005 决策 1.3），抽取不改变 dsh 的行为。
9. **2026-10-14，R7：通用的 ACP 部分抽成 `packages/adapter-acp`（ADR-0005 决策 1.3）。** dsh 的行为不变：adapter-dsh 的全部测试（三层契约的前两层与其余单元、集成测试）在抽取前后结果相同，测试代码只改了 import 路径。补记 1–7 写到的代码位置随之变化：
   - 进程（补记 1 的启动、initialize、退出上报与重启、回收，补记 3 的“在 SDK 之前截下 `session/update`”，补记 2 里 fd 3 的解码与报到时限）在 `adapter-acp/src/acp-process.ts` 的 `AcpProcess`，经启动器 `AcpLauncher` 启动引擎。`DshProcess` 是它的子类，只带 dsh 的启动器（`paths.ts`、`env.ts`、`dshSpawnSpec`、stream-tap 的安装）与 `setLaunchConfig`。错误与告警里的“dsh”取自引擎描述的名字，原文不变。
   - 映射、每会话事件队列、会话与审批记账、恢复与取消得不到确认时的重启（补记 3、4、6）在 `adapter-acp/src/{acp-mapping,session-events,acp-adapter}.ts`；`DshAdapter` 是 `AcpAdapter` 的子类，只多出 Provider 桥接与配置变更时的重启（补记 5）。
   - dsh 的差异经引擎描述 `DSH_ENGINE`（`adapter-dsh/src/engine.ts`）注入：能力表、工具展示表、路由编码、回合与 resume 失败的归类、增量旁路（fd 3、`StreamTapDecoder`、2 s 的报到时限、`DeltaMerger`）。映射文档拆成通用与 dsh 两部分（[acp-event-mapping.md](../architecture/acp-event-mapping.md)）。
   - `@agentclientprotocol/sdk` 改由 adapter-acp 声明，版本仍是 `1.4.0`（决策 1）；adapter-dsh 的测试经 `@wevir/adapter-acp/sdk` 用它。
