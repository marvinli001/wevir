# T0.4 Paseo 架构研读：daemon、协议、多端与中继

> 日期：2026-10-12 · 任务：[SKELETON_PLAN §6 T0.4](../SKELETON_PLAN.md) · 上游：`getpaseo/paseo@dc7bc8d`（Apache-2.0，见 [UPSTREAM.md](../upstream/UPSTREAM.md)）
> 只读研究，没有移植任何代码。

## 0. 怎么读这份报告

- 文中路径都相对 `upstream/paseo/`，`文件:行号` 按锁定提交 `dc7bc8d` 核对过。每个文件在一节里第一次出现时尽量写全路径，之后只写文件名；文件名与完整路径的对照见本节末尾（同名文件只有 `connection-offer.ts` 和 `directory-sync/index.ts`，文中对它们始终写全路径）。
- Paseo 的文档和代码不一致时以代码为准，并标注“文档漂移”。
- “§x.y”指本文小节，“计划 §x.y”指 [SKELETON_PLAN](../SKELETON_PLAN.md) 的小节，“T0.3 §x”指 [dsh 接入 Spike 报告](dsh-integration-spike.md)。
- 术语对照：Paseo 的 **daemon** ≈ Wevir 的 **Host**；Paseo 的 **agent** ≈ Wevir 的 **Session**（一个 agent 是一条长期对话）；Paseo 的 **Session**（`server/session.ts`）是“一个客户端的逻辑连接”，与 Wevir 的 Session 不是一回事；Paseo 的 **timeline** ≈ Wevir 的事件流投影。
- 结论先行：
  1. Paseo 的握手、兼容规则、运行时文件、本地凭据、桌面“只停自己拉起的 daemon”这几块可以直接照搬到骨架，成本低、收益确定。
  2. 它的事件流是**内存投影 + 按 epoch 分段的序号**，持久事实交给各 Provider 的历史文件。Wevir 选的是持久事件库（计划 §2.1），所以事件流只借鉴“实时推送保即时、按序号拉取保正确”的分工，不借它的存储模型。
  3. 多端审批没有做成显式的冲突协议：Provider 层先到先得，后到者得到错误；`agent_permission_resolved` 不带“谁批的”。Wevir T2.3 已规划的幂等审批比它更完整。
  4. 配对与中继能用，但比文档说的弱：没有一次性邀请、没有按设备的凭据和撤销，所有客户端都是 owner；中继不认证客户端、会话内不防重放。移动端阶段借它的密码学骨架（NaCl box + 二维码钉公钥），补上这些缺口。
  5. Provider 层（`AgentClient` / `AgentManager`）与 dsh 在会话事实来源、审批、终端沙箱、工具注入、密钥存放上都有冲突，Wevir 不采纳，只参考它的工具调用归一化与审批选项结构。

路径缩写对照：

| 目录 | 文中简写的文件 |
|---|---|
| `packages/server/src/server/` | `websocket-server.ts` `bootstrap.ts` `session.ts` `config.ts` `config-environment.ts` `persisted-config.ts` `pid-lock.ts` `daemon-worker.ts` `daemon-instance.ts` `paseo-home.ts` `private-files.ts` `local-credential.ts` `auth.ts` `session-admission-auth.ts` `hostnames.ts` `relay-transport.ts` `daemon-keypair.ts` `server-id.ts` `pairing-qr.ts` `pairing-offer.ts` `authorization/index.ts` `authorization/operation-permissions.ts` `creation/index.ts` `message-receipts/index.ts` `directory-sync/internal/versioned-collection.ts` `session/owned-subscriptions/index.ts` `websocket/physical-socket.ts` `hub/relationship-controller.ts` `managed-processes/managed-processes.ts` |
| `packages/server/src/server/agent/` | `agent-manager.ts` `agent-sdk-types.ts` `agent-timeline-store.ts` `agent-timeline-store-types.ts` `agent-stream-coalescer.ts` `agent-projections.ts` `agent-prompt.ts` `agent-storage.ts` `timeline-projection.ts` `runtime-mcp-config.ts` `provider-launch-config.ts` `tools/paseo-tools.ts` |
| `packages/server/src/server/agent/providers/` | `acp-agent.ts` `generic-acp-agent.ts` `codex-app-server-agent.ts` `jsonl-rpc-process.ts` `claude/agent.ts` `opencode/server-manager.ts` |
| `packages/server/scripts/` | `supervisor.ts` `supervisor-entrypoint.ts` |
| `packages/server/src/terminal/` | `terminal-size-ownership.ts` |
| `packages/protocol/src/` | `messages.ts` `client-capabilities.ts` `daemon-endpoints.ts` |
| `packages/client/src/` | `daemon-client.ts` `connection/index.ts` `daemon-client-transport-types.ts` |
| `packages/relay/src/` | `crypto.ts` `encrypted-channel.ts` `cloudflare-adapter.ts` |
| `packages/app/src/` | `runtime/host-runtime.ts` `runtime/host-confirmation.ts` `timeline/session-stream-reducers.ts` `timeline/viewed-timeline-sync.ts` `timeline/timeline-fetch-policy.ts` `types/host-connection.ts` `utils/connection-selection.ts` |
| `packages/desktop/src/` | `daemon/daemon-manager.ts` `daemon/local-transport.ts` `daemon/quit-lifecycle.ts` `daemon/runtime-paths.ts` `preload.ts` `main.ts` |
| `packages/cli/src/` | `commands/daemon/start.ts` `commands/daemon/pair.ts` `commands/daemon/restart.ts` `commands/daemon/local-daemon.ts` `commands/onboard.ts` `utils/client.ts` |
| `docs/` | `architecture.md` `protocol-compatibility.md` `protocol-validation.md` `rpc-namespacing.md` `timeline-sync.md` `agent-stream-performance.md` `permissions.md` `providers.md` `custom-providers.md` `agent-lifecycle.md` `data-model.md` |

---

## 1. daemon 的启动、发现、桌面拉起与退出

### 1.1 进程结构：supervisor + worker

- 两个进程：`supervisor-entrypoint.ts`（“Paseo Supervisor”）fork 出 `daemon-worker.ts`（“Paseo Daemon”）（进程标题 `packages/server/scripts/supervisor-entrypoint.ts:18`、`packages/server/src/server/daemon-worker.ts:10`；选择 worker 入口 `supervisor-entrypoint.ts:45-60`；fork 本身在 `packages/server/scripts/supervisor.ts:287-298`）。
- supervisor 启动顺序：解析 home、读配置（`supervisor-entrypoint.ts:110-112`）→ 以 `listen: null` 抢 pid 锁（`:115-117`）→ 起锁心跳（`:127-136`）→ `runSupervisor`：worker 就绪时发布端点、worker 退出时清掉端点、自身退出时释放锁（`:148-178`）。
- worker：`loadConfig` → `createPaseoDaemon` → `daemon.start()`，然后经 IPC 发 `{type:"paseo:ready", listen, serverId}`（`daemon-worker.ts:70-75,311-335`）。
- 双向存活：supervisor 每 1 s 发 IPC 心跳（`packages/server/scripts/supervisor.ts:9,303-316`）；worker 发现 IPC 断开、父进程变化，或心跳超过 3.5 s 且 supervisor 已死，就硬退出（`daemon-worker.ts:287-305`），注释说明这是为了避免往断管道写日志而成为孤儿进程（`:265-268`）。
- CLI：`paseo daemon start` 以 `managed` 模式后台启动，`daemon run` 以 `deployment` 模式前台运行（`packages/cli/src/commands/daemon/local-daemon.ts:43-67`、`start.ts:14-55`），两者都走 `startDaemonInstance`，以子路径 `@getpaseo/server/daemon-control` 导出（`packages/server/package.json:31-35`）。
- “净化启动”：managed 模式在 spawn 前删掉所有 daemon 设置类环境变量（`PASEO_LISTEN`、`PORT`、`PASEO_PASSWORD` 等），配置只认 `config.json`（`packages/server/src/server/config-environment.ts:3-59,76-91`）。旧的 `--port/--listen` 参数直接报错并提示改用 `config set`（`local-daemon.ts:82-111`）。

### 1.2 监听地址

- 默认 `127.0.0.1:6767`：`const DEFAULT_PORT = 6767;`（`packages/server/src/server/config.ts:38`），优先级 `cli.listen → PASEO_LISTEN → config.json daemon.listen → 127.0.0.1:${PORT ?? 6767}`（`config.ts:466-482`）。
- 还支持 Unix socket、Windows 命名管道（`packages/server/src/server/bootstrap.ts:43-82`）。发布的是 `httpServer.address()` 实际绑定的地址（`bootstrap.ts:20-37`）。
- 端口被占用时**不换端口**：`start()` 失败 → worker 退出 1（`daemon-worker.ts:336-338,362-365`）→ worker 在就绪前死亡则 supervisor 退出 1（`supervisor.ts:390-393`）→ 启动器报 `DAEMON_START_FAILED` 并附最后 30 行日志（`daemon-instance.ts:265-271`）。

### 1.3 发现：`$PASEO_HOME/paseo.pid` 是唯一的事实

- `$PASEO_HOME` = `env.PASEO_HOME ?? "~/.paseo"`（`packages/server/src/server/paseo-home.ts:14-18`）。目录强制 `0700`、私密文件 `0600`（Windows 跳过 chmod）（`packages/server/src/server/private-files.ts:5-20`）。
- pid 锁的 schema（`packages/server/src/server/pid-lock.ts:10-20`）：

  ```ts
  pid, startedAt, hostname, uid, listen: string | null,
  serverId?: string | null, desktopManaged?: boolean, heartbeat?: true, bootId?: string
  ```

- 加锁用排他创建 `open(pidPath, "wx")`（`pid-lock.ts:194-215`）；每 30 s touch 一次 mtime 作为心跳（`pid-lock.ts:43,314-346`），心跳发现锁被别人占了就以 `pid_lock_ownership_lost` 退出（`supervisor-entrypoint.ts:129-134`）。
- 陈旧锁判定：写于上一次开机（Linux 用 `bootId`，其他平台用 `startedAt` 对比系统 uptime，容差 5 s），或 `kill(pid, 0)` 失败（`pid-lock.ts:56-100`）。回收前重读一次，必须仍是同一个 `{pid, startedAt}` 才删（`pid-lock.ts:161-184`）。
- 发现规则：`listen` 只在 worker 就绪后写入，重启 worker 前先清空；客户端每 100 ms 轮询 pid 文件直到 `listen` 出现（`daemon-instance.ts:59-86`），CLI 只连 pid 文件里的地址，**没有**“回退到配置地址或默认端口”（`packages/cli/src/utils/client.ts:302-310`、`public-docs/cli.md:377`、`docs/architecture.md:479`）。文档明确说这份元数据不是监听者身份的密码学证明（`docs/architecture.md:479`）。
- 本地凭据：每次 worker 启动写 `$PASEO_HOME/local-credential`（32 字节随机数 base64url，`0600`，先写临时文件再原子 rename）（`packages/server/src/server/local-credential.ts:12-25`），停止或启动失败时删除（`bootstrap.ts:1606,1798-1799,1813-1814`）。CLI 和桌面主进程只在 pid 文件的 `listen` 与自己的目标一致时才读它（`local-credential.ts:68-81`）。

### 1.4 桌面端：先找，再拉起；只停自己拉起的

- 主进程 `startDaemon()` 先查状态，已在运行就直接返回（`packages/desktop/src/daemon/daemon-manager.ts:279-301`）；查状态时，没有 pid 文件就在进程内直接判定为“已停止”，有 pid 文件则一律调用内置 CLI `paseo daemon status --json`（`:223-240`）。
- 拉起：`startDaemonInstance({mode:"managed", desktopManaged:true, timeout 30s})`，`onAcquired` 记下 `ownedLaunch = {home, instance}`（`daemon-manager.ts:303-324`）。supervisor 用 Electron 自带的 Node 运行（`ELECTRON_RUN_AS_NODE=1`，开发与打包都如此，`packages/desktop/src/daemon/node-entrypoint-launcher.ts:26-40`；入口路径与 macOS Helper 的解析在 `packages/desktop/src/daemon/runtime-paths.ts:40-56,77-120`）。
- “拥有”与“附着”：只有 pid 文件与**本次桌面会话**拉起时记下的 `{pid, startedAt}` 一致，桌面才认为 daemon 归自己（`daemon-manager.ts:58,189-194,334-339`）。预先存在的 daemon（含旧的 `desktopManaged` 记录）只附着、不自动停止（`docs/architecture.md:486`）；手动停止附着的 daemon 需要弹窗确认 home 和 PID，执行前再核对一次（`packages/app/src/desktop/daemon/desktop-daemon.ts:199-224`、`daemon-manager.ts:340-350`）。版本不一致时的自动重启也只对自己拥有的 daemon 做（`daemon-manager.ts:266-271`）。
- 连接信息怎么到渲染进程：preload 只暴露一个通用的 `paseoDesktop.invoke → ipcRenderer.invoke("paseo:invoke")`（`packages/desktop/src/preload.ts:32-36`），主进程分发（`daemon-manager.ts:477-489`）。TCP 时渲染进程自己开 WebSocket（`packages/app/src/runtime/host-runtime.ts:577-584`）；Unix socket / 命名管道时由主进程连 `ws+unix://…`，SSH 时主进程起一个经 `ssh` 子进程转发的本地 TCP 代理再连 `ws://127.0.0.1:<port>/ws`，这三种都由主进程把帧以 base64 IPC 转给渲染进程（`packages/desktop/src/daemon/local-transport.ts:101-104,196-275,410-429`、`host-runtime.ts:552-576`）。本地凭据只在 daemon 是 `desktopManaged` 且 `listen` 匹配时交给渲染进程（`daemon-manager.ts:409-413`）。
- 退出：`before-quit` 关闭传输；只有 `keepRunningAfterQuit` 为 false **且**自己拥有的 daemon 仍在运行时才停止它（`packages/desktop/src/daemon/quit-lifecycle.ts:55-74,118-158`、`daemon-manager.ts:134-142`）。默认 `manageBuiltInDaemon: true`、`keepRunningAfterQuit: false`（`packages/desktop/src/settings/desktop-settings.ts:38-39`）。

### 1.5 退出与重启

- POSIX 上 `daemon stop` 直接给 supervisor 发 SIGTERM，不走 TCP；Windows 上走 shutdown RPC，没有 `listen` 时需要 `--force` 整树 SIGKILL（`daemon-instance.ts:105-136`）。等待 15 s，只有 `{pid, startedAt}` 匹配才释放锁（`daemon-instance.ts:155-203`）。
- supervisor 收到 SIGINT/SIGTERM → IPC 通知 worker 优雅退出，10 s 后整树 SIGKILL（`supervisor.ts:10,243-271,424-493`）；worker 退出后 supervisor 释放自己的锁（`pid-lock.ts:379-398`）。
- worker 的 `daemon.stop()` 有 10 s 强制退出（`daemon-worker.ts:163-187`），顺序是：删本地凭据 → 关闭 agent、flush 存储、杀终端 → 关 WS 与 HTTP 服务 → 删 socket 文件（`bootstrap.ts:1812-1860`）。
- 重启：RPC `restart_server_request` 让 worker 通知 supervisor 重拉 worker（`daemon-worker.ts:211-240`、`supervisor.ts:406-414,458-467`）；worker 崩溃（非零退出或非 SIGTERM 信号）也会被重拉（`supervisor.ts:402-404`）。重拉时保留参数和环境、重读配置，但 supervisor 自身代码不刷新（`docs/architecture.md:481`）。CLI 以“worker PID 变了、`serverId` 没变”确认重启成功（`packages/cli/src/commands/daemon/restart.ts:66-97`）。

### 1.6 本地访问控制

- **默认没有密码，也就不需要任何令牌**：HTTP 直接放行（`packages/server/src/server/auth.ts:83`），WebSocket 直接以 `owner` 准入（`packages/server/src/server/session-admission-auth.ts:18-19`）。`SECURITY.md:49` 自己承认 loopback 对本机其他用户可达。
- 设了密码后，WebSocket 在 `hello.auth` 里带 `{kind:"password"}` 或 `{kind:"localCredential"}`（`packages/protocol/src/messages.ts:7540-7545`、`session-admission-auth.ts:28-32`）。
- DNS rebinding 防护：TCP 监听时 HTTP 与 WebSocket 升级都校验 Host 头白名单（默认 `localhost`、`*.localhost`、IP 字面量）（`bootstrap.ts:724-735`、`websocket-server.ts:880-902`、`hostnames.ts:41-74`），WebSocket 再校验 Origin（`websocket-server.ts:903-911,2923-2955`）。不合格的请求一律 403（`bootstrap.ts:730`、`websocket-server.ts:900`）。一个漏洞：WebSocket 升级请求如果根本没带 Host 头，就跳过 Host 校验（`websocket-server.ts:894`，条件是 `requestHost && …`），而 `SECURITY.md:73` 说每个升级请求都校验。

**对 Wevir 的意义**：骨架的 Host 由桌面拉起、随桌面退出（ADR-0002 草案），正好对应 Paseo 的 `keepRunningAfterQuit: false` 加“只停自己拉起的”。`run/host.json` 可以照抄 pid 锁的排他创建、陈旧判定、就绪后才发布端点；令牌则应**始终必需**，不学 Paseo 的“默认无密码”。supervisor/worker 双进程是为常驻 daemon 和自更新准备的，骨架不需要。

---

## 2. 协议组织

### 2.1 传输与信封

- 单条 WebSocket，JSON 文本帧为主，终端和文件传输用二进制帧（`docs/architecture.md:234,300-314`）。schema 全在 `packages/protocol/src/messages.ts`（7642 行）。
- 顶层信封是一个以 `type` 区分的联合（`messages.ts:7593-7604`）：
  - 入站：`ping`、`hello`、`recording_state`、`session`（包着 `SessionInboundMessageSchema`）。
  - 出站：`pong`、`session`（包着 `SessionOutboundMessageSchema`）、`hello.rejected`。
- 心跳用应用层 `ping/pong`，不用 RFC6455 控制帧：客户端每 10 s 一次（`packages/client/src/daemon-client.ts:1056`），首个 ping 为该物理连接申请一个 45 s 的租约，过期则服务端强制断开（`packages/server/src/server/websocket/physical-socket.ts:5-8`、`docs/architecture.md:266`）。
- 每个物理连接有发送缓冲上限，超过就断开该连接而不影响同一逻辑会话的其他连接。代码里是 64 MiB（`physical-socket.ts:1-4,94`），文档写的是 8 MiB（`docs/architecture.md:268`）——文档漂移。
- RPC 默认超时 60 s，专门为了慢的中继和移动网络；连接超时、心跳和真正的长任务各自单独设置（`daemon-client.ts:1052`、`docs/architecture.md:270`）。

### 2.2 请求、响应、推送怎么区分

Paseo 没有用 JSON-RPC，而是全部靠 `type` 字符串和 `requestId` 约定：

| 类别 | 形状 | 依据 |
|---|---|---|
| 请求 | `{type: "x.y.verb.request", requestId, ...参数平铺}` | `docs/rpc-namespacing.md:36-48` |
| 响应 | `{type: "x.y.verb.response", payload: {requestId, ...}}`；客户端把 `.request` 机械替换为 `.response` 来等待 | `rpc-namespacing.md:50-65`、`packages/client/src/daemon-client.ts:2032` |
| 有限流式响应 | 先若干 `.update`，再一个终结的 `.response`，共用 `requestId` | `rpc-namespacing.md:28-32` |
| 错误 | `rpc_error {requestId, requestType?, error, code?}` | `messages.ts:3779-3787` |
| 推送 | 不带 `requestId`，带可选 `subscriptionId`，如 `agent_update`、`agent_stream`、`agent_permission_request/resolved` | `messages.ts:4094-4126,5148-5165` |

- 客户端判定“这是响应”的规则：`type` 是 `rpc_error`，或以 `_response` / `.response` / `/response` 结尾，且 `payload.requestId` 是字符串（`daemon-client.ts:284-319`）。`_response` 与 `.response` 并存，是旧扁平命名（`checkout_pr_merge_response`）迁移到点分命名的遗留（`rpc-namespacing.md:78-92`）；`/response` 分支目前没有任何消息类型使用，文档也要求“用点不用斜杠”（`rpc-namespacing.md:17`）。
- 订阅是显式的：连接本身不产生任何数据需求，列表请求带 `subscribe: {}` 才建立订阅并由服务端分配 `subscriptionId`，客户端用 `subscription.release.request` 释放（`docs/architecture.md:251-262`、`messages.ts:3166-3196`、`docs/protocol-compatibility.md:51-53`）。重连后由客户端重新订阅，拿到新的服务端 ID。
- 命名约定：新 RPC 一律 `domain.namespace.verb.request/response`，最后一段之前是动词（`get_noun` 而不是 `noun`），用点不用斜杠（`rpc-namespacing.md:1-17`）。

### 2.3 版本号与兼容策略

- 版本号几乎不承担兼容职责：服务端 `const WS_PROTOCOL_VERSION = 1;`（`packages/server/src/server/websocket-server.ts:489`），客户端写死 `protocolVersion: 1`（`daemon-client.ts:6262`），服务端只拒绝 `< 1`（`websocket-server.ts:1568-1579`）。文档说会“取双方最大值中较小的那个”（`docs/protocol-compatibility.md:13`），代码只是回报自己的常量（`websocket-server.ts:1781`）——文档漂移。
- 真正的兼容靠三条规则（`docs/protocol-compatibility.md:9-41`、`docs/architecture.md:316-329`）：
  1. **协议契约（永远兼容）**：schema 只增不减；新字段一律 optional；不把 optional 改成必填、不收窄类型（`string → enum`、可空 → 非空都算收窄）；不再发送的字段继续接受。
  2. **客户端能力位**：客户端在 `hello.capabilities` 里声明自己支持什么（`messages.ts:7547-7566`，取值见 `packages/protocol/src/client-capabilities.ts:1-49`）；服务端发出新的枚举值或新消息前用 `session.supports(CLIENT_CAPS.x)` 判断，不支持就降级成旧值或不发。能力属于物理连接，不跨连接借用（`architecture.md:318-320`）。客户端包维护一份穷举的默认能力表，App、CLI、插件都继承它（`packages/client/src/connection/index.ts:125-145`、`protocol-compatibility.md:43-49`）。
  3. **功能契约（按功能门控一次）**：服务端在 `server_info.features` 里声明能力（`messages.ts:3560-3610`），客户端在一处判断，要么启用功能，要么提示用户升级 Host；不写降级路径，不在功能内部到处加防御分支（`protocol-compatibility.md:31-41`）。
- 每个兼容垫片都写 `// COMPAT(name): added in vX, remove after <date>`，`rg "COMPAT\("` 就是清理清单（`protocol-compatibility.md:77-91`）。`server_info` 里随处可见这种标签（`messages.ts:3566-3610`）。
- 未知请求：服务端校验失败时，如果是带 `requestId` 的 `session` 消息，就回 `rpc_error`，`code: "unknown_schema"`，提示“try upgrading the daemon (currently vX)”（`websocket-server.ts:2180-2204`）；`hello` 之前的任何非法消息直接以 4002 关闭（`websocket-server.ts:2166-2177`）。
- 握手失败：`hello.rejected {reason: password_required | incorrect_password | incompatible_protocol}`，然后用专用关闭码关闭（协议不兼容 4003，认证失败 4401，`websocket-server.ts:116,487`）；只对声明了 `hello_rejection` 能力或带了 `auth` 的客户端发这个新帧，老客户端只看关闭码，避免它们的校验器遇到不认识的顶层消息（`websocket-server.ts:1705-1733`、`messages.ts:7586-7590`）。`hello` 有 15 s 超时（`websocket-server.ts:484`）。

### 2.4 schema 怎么定义

- zod 4 写 schema，`z.infer` 出类型，协议包只依赖 `zod` 和 `semver`（`packages/protocol/package.json:33-36`），以 `./*` 子路径导出（`package.json:11-16`）。
- schema 必须是纯结构声明：不许 `.transform()` / `.catch()` / `.preprocess()`，规范化放在校验之后的显式步骤里；共享字面量标签时必须用 `z.discriminatedUnion()`；`.default()` 只放在原始类型叶子上（`docs/protocol-compatibility.md:15-20`、`docs/protocol-validation.md:36-42`）。
- 原因是移动端性能：客户端入站校验用 zod-aot 在构建时生成校验器，Hermes 上一条 353 KB 的消息从 10.9 ms 降到 2.5 ms（`docs/protocol-validation.md:1-9`）；生成器只能编译纯 schema。服务端入站仍用运行时 zod（`websocket-server.ts:2307`）。
- 协议改动的 PR 必须说明“半年前的 App 能否解析、半年前的 daemon 能否满足新 App”（`protocol-compatibility.md:22-27,93-95`）。

**对 Wevir 的意义**：Wevir 已冻结 JSON-RPC 2.0（计划 §1.3），请求/响应关联、错误对象、通知（无 `id`）都由 JSON-RPC 本身提供，不需要 `.request/.response` 后缀和 `requestId`。要借的是它的兼容纪律：只增不减、客户端能力位、`features` 一处门控、`COMPAT` 标签、未知方法给出“请升级 Host”的明确错误码、`hello` 失败先回错误再关闭。版本号要真的用起来：Paseo 的整数版本形同虚设，Wevir 的 `host.hello` 应返回实际协商结果和最低支持版本。

---

## 3. 事件流

### 3.1 两条路径：实时保即时，拉取保正确

- 文档开宗明义（`docs/timeline-sync.md:3-17`）：`agent_stream` 推送负责即时性，可以是增量形状；`fetch_agent_timeline_request` 负责正确性，永远返回完整的投影条目。持续订阅的客户端按序应用每一条已提交的行；打开或恢复一个 agent 时，用一次有界请求拿到当前尾部，更早的历史向后翻页。
- “在线状态不等于投递”：客户端心跳只用于通知路由，不能拿来决定是否推送时间线（`docs/timeline-sync.md:24-33`）。
- 工具输出进入任何一条路径之前先截断（shell 工具输出的规范上限是 64 KiB），从 Provider 历史回放时同样截断（`docs/timeline-sync.md:19-22`）。

### 3.2 序号：每个 agent 一条内存时间线，`(epoch, seq)` 作游标

- 每个 agent 的时间线状态是 `{epoch, projection, minSeq, nextSeq}`（`packages/server/src/server/agent/agent-timeline-store.ts:22-27`），`append()` 取 `seq = nextSeq` 再自增（`agent-timeline-store.ts:132-149`）。游标类型（`agent-timeline-store-types.ts:4-15`）：

  ```ts
  export interface AgentTimelineRow { seq: number; timestamp: string; item: AgentTimelineItem;
    readonly turnId?: string; readonly providerMessageId?: string; }
  export interface AgentTimelineCursor { epoch: string; seq: number; }
  ```

- `epoch` 是随机 UUID，只在 `initialize()` 里生成（`agent-timeline-store.ts:40-54`）：agent 首次注册（`agent-manager.ts:3722`）、从 Provider 历史强制重建（`agent-manager.ts:4141`，回退 rewind 也走这里并发 `timeline_replacement`，`:3276-3286`）。daemon 重启后时间线从 Provider 历史重建，自然是新 epoch。`docs/architecture.md:386` 说“每次 run 开一个新 epoch”，代码里一个回合并不换 epoch——文档漂移。
- **时间线只在内存**：`AgentManager` 接受可选的 `durableTimelineStore`（`agent-manager.ts:754,5022-5026`），bootstrap 从不传入（`bootstrap.ts:949-962`），只在测试里出现。
- 只有 `timeline` 类事件带序号，其余推送只带时间戳（`agent-manager.ts:4342-4344`）。线上形状（`packages/protocol/src/messages.ts:4115-4126`）：

  ```ts
  // Present for timeline events. Maps 1:1 to canonical in-memory timeline rows.
  seq: z.number().int().nonnegative().optional(),
  epoch: z.string().optional(),
  ```

- 增量合并：`AgentStreamCoalescer` 每个 agent 一个 60 ms 窗口，首尾两次 flush（`agent-stream-coalescer.ts:4`、`docs/agent-stream-performance.md:29-31`）；每次 flush 成为一条规范行（`agent-manager.ts:799-805`），投影再把相邻的同回合助手文本合并（`timeline-projection.ts:313-321`）。不能合并的事件先 flush 缓冲，保证顺序（`agent-manager.ts:4303-4307`）。所以中间增量**不保留**，规范行是“60 ms 一段”的粒度。

### 3.3 断线补发

- 拉取请求（`messages.ts:1865-1882`）：

  ```ts
  direction: z.enum(["tail", "before", "after"]).optional(),
  cursor: AgentTimelineCursorSchema.optional(),     // {epoch, seq}
  limit: z.number().int().nonnegative().optional(), // 0 = all
  ```

  响应（`messages.ts:4625-4650`）带 `epoch`、`reset`、`staleCursor`、`gap`、`window{minSeq,maxSeq,nextSeq}`、`startCursor/endCursor`、`hasOlder/hasNewer`，以及一份 **agent 快照**。每个条目带 `seqStart`、`seqEnd`、`sourceSeqRanges`、`collapsed`（`messages.ts:4614-4623`），因为一次工具调用的生命周期会跨多个源序号但只算一个投影条目（`docs/timeline-sync.md:37-39`）。
- 服务端：游标的 epoch 不一致 → `staleCursor`；`after` 方向且游标早于 `minSeq-1` → `gap`；两者都置 `reset` 并改返回尾页（`agent-timeline-store.ts:102-116`）。默认页大小 200（`:28`），但 `after` 方向不带 limit 时返回全部（`packages/server/src/server/session.ts:7731-7734`）；App 固定每页 40（`packages/app/src/timeline/timeline-fetch-policy.ts:3`）。
- 客户端对实时事件的判定（`packages/app/src/timeline/session-stream-reducers.ts:282-304`）：epoch 不同 → 丢弃（例外：新 epoch 且 `seq === 1` 时重置实时时间线并应用，`session-stream-reducers.ts:1544-1551`）；`seq <= endSeq` → 重复，丢弃；`seq == endSeq+1` → 接受；更大 → 缺口，暂不应用并排队一次 `after` 拉取（`session-stream-reducers.ts:1530-1543`、`viewed-timeline-sync.ts:887-893`）。
- 补齐“分页但完整”：响应 `hasNewer: true` 就立刻从 `endCursor` 继续拉，直到 `hasNewer: false` 才算补完（`docs/timeline-sync.md:35-45`、`viewed-timeline-sync.ts:573-588`）；失败按 1 s 到 30 s 退避重试（`viewed-timeline-sync.ts:417-418,599-616`）。分页的理由是大响应会超过中继的帧限制（`docs/timeline-sync.md:37`）。
- 应用拉取结果（`session-stream-reducers.ts:1220-1410`）：`reset` 整体替换；epoch 变化或回退（`maxSeq < endSeq`）替换且不保留连续性；页与已有内容重叠时只追加 `seqEnd > endSeq` 的部分；与实时文本重叠时按 `sourceSeqRanges` 替换而不是追加（`:782-800`）。

### 3.4 状态快照

- agent 快照 `AgentSnapshotPayloadSchema`（`messages.ts:813-845`）里有 `activeTurn`（`:826`）和 `pendingPermissions`（`:830`），由服务端填充（`agent-projections.ts:128-138`）；`agent_update` 推送 upsert/remove，带可选 `generation` 和 `seq`（`messages.ts:4094-4113`）。
- 目录同步（项目、工作区、agent 列表）是另一套机制：daemon 全局服务（`websocket-server.ts:593`），`generation` 是每个 daemon 进程生成的 UUID（`packages/server/src/server/directory-sync/index.ts:53-55`）；每类实体一个单调序号，每个实体记最后一次变更的序号，值没变（指纹相同）就不发（`directory-sync/internal/versioned-collection.ts:57-67`）；删除留墓碑，上限 5000 条，裁剪时推进 `expiredThroughSeq`（`versioned-collection.ts:69-78,132-140`）。读取时：generation 不同、没有游标、游标过期 → 全量快照并注明原因；否则只发变更和删除（`packages/server/src/server/directory-sync/index.ts:172-186`、`versioned-collection.ts:92-116`）。**不保存事件日志，只保存每个实体的最新投影**（`docs/architecture.md:142-145`）。

### 3.5 中途加入一个正在运行的会话

1. 先订阅（`agent.timeline.set_subscription.request`，`session.ts:2700-2710`），等订阅就绪，**然后**才开始补拉（`viewed-timeline-sync.ts:524-525,719-752`）。
2. 还没有基线时到达的实时行放进单独的“头部叠加层”（`session-stream-reducers.ts:1594-1620`），基线到了之后按序号去重合并。
3. 补拉响应里带着 agent 快照，所以未决审批和当前回合在同一个回复里拿到（`session.ts:7748,7781`）。
4. 进行中的助手文本：已 flush 的部分都是规范行，尾页能拿到；只有最多约 60 ms 尚未 flush 的文本只存在于合并器里，随后由实时推送补上。

**对 Wevir 的意义**：Paseo 的序号是“内存投影的行号”，daemon 一重启就换 epoch、整段重拉，这是它把持久事实交给 Provider 的代价。Wevir 的 `seq` 落在 SQLite 事件库里、跨重启有效（T2.1、T2.2），不需要 epoch；但要保留它的几条经验：

- 实时推送和按序号补拉分工；客户端按 `seq` 去重、发现缺口就补拉（T4.1）。
- 补拉要分页且必须拉到 `hasMore: false`（T2.4 的 `events.subscribe` 回放若分批发送，要带“回放结束”标记；T4.1 负责续拉）。
- “先订阅、再补拉”的顺序在 Wevir 里由服务端保证：T2.4 已规划 `events.subscribe(sessionId, sinceSeq)` 先补发再切实时，追加与回放在同一把会话锁下完成，客户端就不需要 Paseo 那种头部叠加层。
- 快照里放未决审批与当前回合：`session.get` 返回 `{state, pendingApprovals, activeTurn, lastSeq}`，中途加入的客户端拿快照 + `sinceSeq = lastSeq` 订阅即可（T1.2、T2.2）。
- 助手增量先在 Host 内按短窗口合并再分配 `seq` 落库，否则事件表会被逐 token 的增量撑大；工具输出入库前截断（T2.2、T3.2）。

---

## 4. 多客户端同时操作同一会话

### 4.1 两端同时审批：先到先得，后到者报错

- `AgentManager.respondToPermission` 用一个“提交中”集合挡住并发（`packages/server/src/server/agent/agent-manager.ts:3085-3094`）：

  ```ts
  if (agent.inFlightPermissionResponses.has(requestId)) {
    throw new Error("A response to this permission request is already being submitted");
  ```

  第一个响应完成后 Provider 已删掉这条未决请求，再来的响应抛“没有这条未决请求”的错误：Claude 与 ACP 是 `No pending permission request with id ...`（`providers/claude/agent.ts:2690-2694`、`acp-agent.ts:2436-2440`），Codex 是 `No pending Codex app-server permission request with id ...`（`codex-app-server-agent.ts:4678-4681`）。
- 后到者收到什么：`handleAgentPermissionResponse` 记一条 `activity_log` 错误并重新抛出（`session.ts:5104-5118`）；因为 `agent_permission_response` 恰好有个 `requestId` 字段（审批请求的 ID），通用异常处理会回一个 `rpc_error {code: "handler_error"}`（`session.ts:2169-2186`）。用 `respondToPermissionAndWait` 的调用方因此得到 `DaemonRpcError`；用不等待的 `respondToPermission` 的调用方只能在活动日志里看到（`packages/client/src/daemon-client.ts:5437-5448,5689-5719`）。**后到者拿不到“已被谁以什么决定处理”**。
- 广播：响应提交期间，Provider 发出的 `permission_resolved` 被暂扣（`agent-manager.ts:4741-4746`），提交完成后放行（`:3110-3114`）；每个客户端会话再以 `agent_stream` 事件和 `agent_permission_resolved` 推送转发（`session.ts:2001,2014-2023`），同时发一条未决列表变短的 `agent_update`（`agent-manager.ts:3106-3108`）。
- `agent_permission_resolved` 的形状里**没有“谁批的”**（`messages.ts:5157-5165`）：

  ```ts
  payload: z.object({ subscriptionId: z.string().optional(), agentId: z.string(),
    requestId: z.string(), resolution: AgentPermissionResponseSchema }),
  ```

- 中断会把所有未决审批以 deny “Interrupted” 结掉（`agent-manager.ts:3184-3188,4750-4767`）。

### 4.2 两端同时发消息、取消

- 运行中再发消息，默认 `activeTurnBehavior: "interrupt"`（`session.ts:8210`）：取消当前回合、开始新回合（`agent-prompt.ts:354-360`、`agent-manager.ts:2777-2807`）；`"steer"` 时 Provider 支持就把消息插进当前回合，不支持则同样替换（`agent-manager.ts:2837-2881`）。发新消息同时清掉未决审批（`session.ts:8211`）。
- 取消和 steer 按 agent 串行化（`runForegroundMutation`，`agent-manager.ts:2889-2929,3123-3125`）；已有活动回合时 `streamAgent` 直接拒绝 `already has an active run`（`agent-manager.ts:2600-2613`）。
- daemon 没有消息队列。两端同时“中断式发送”，大概率后到的赢（推断，未测）。唯一的队列在 App 客户端本地，agent 空闲时才发出（`packages/app/src/runtime/host-runtime.ts:2396-2448`）。
- 对空闲 agent 取消返回 `not_running` 而不报错（`agent-manager.ts:3132-3134`）。

### 4.3 幂等与去重

- 发消息可带客户端 `messageId`（`messages.ts:1363-1376`，注释 “Client-provided ID for deduplication”）。daemon 以 agent + `messageId` 为键在 `$PASEO_HOME/agent-requests` 记回执（`packages/server/src/server/message-receipts/index.ts:42-56`）：请求指纹不同 → `agent_request_key_conflict`；已完成 → 直接返回，不重发；还停在 `pending`（Provider 可能已收到但回执没写完）→ `agent_request_outcome_unknown`，**不重发**。时间线也按 `clientMessageId` 去重（`agent-manager.ts:4829-4834`）。
- 创建（agent / 工作区）走“创建日志”：按 `(kind, idempotencyKey)` 记录，请求指纹不同报冲突，进行中则加入同一份工作，已完成返回存档快照，中途被打断的返回 `outcomeUnknown` 而不是重做（`packages/server/src/server/creation/index.ts:69-87`）；客户端重连后用 `creation.subscribe.request` 接着观察（`creation/index.ts:125-149`）。设计原则写在 `docs/architecture.md:331-363`：创建归 daemon 所有，断开连接不取消已接受的创建；重放回执不得重发首条提示。

### 4.4 其他共享资源的策略

- 终端尺寸“最后交互者赢”：只有视口真正变化或用户聚焦时才声明尺寸，被动渲染不发 resize，所有权不广播（`docs/architecture.md:308`、`packages/server/src/terminal/terminal-size-ownership.ts:11-37`）。
- 所有权按物理连接：一个 `(principal, clientId)` 对应一个逻辑 Session，可以挂多个物理连接（`websocket-server.ts:1436-1445`）；每个订阅、每个请求的回复都绑定到发起它的那条物理连接（`owned-subscriptions/index.ts:61-99,267-303`）；客户端断开后逻辑 Session 保留 90 s 等重连（`websocket-server.ts:483,2077-2087`）。

**对 Wevir 的意义**：Paseo 在审批上靠 Provider 自身“删掉就没了”实现先到先得，协议上没有为第二个响应者设计结果。Wevir T2.3 的规划（首个决定生效，后续返回 `already_decided` + 既有决定，记录 `deviceId`）更完整，应保留，并补上 Paseo 的两点做法：决定提交期间暂扣引擎侧的“已解决”事件，提交成功后再广播 `approval.resolved`（带 `decidedBy`）；中断或新消息时把未决审批统一结为 `cancelled`（T3.3 已有同样结论）。运行中再发消息，骨架阶段建议 Host 直接拒绝（`session_busy` + 当前状态），排队留在客户端；“中断并替换”“插入当前回合”以后作为显式选项再加。`session.send` 带 `clientMessageId` 做幂等，Host 重启后对“已接受但未确认”的发送标记为结果未知，不自动重发。


---

## 5. 设备配对、令牌作用域与撤销

### 5.1 配对流程

- CLI：`paseo daemon pair`（或 `paseo pair`）在本地生成配对 offer，或经 RPC 向运行中的 daemon 索取（`packages/cli/src/commands/daemon/pair.ts:70-140`）；`--relay` 会先把 `daemon.relay.enabled` 打开（`pair.ts:80-81,118-122`）。不带 `--relay` 且中继未开时直接退出并提示（`pair.ts:183-197`）；只有 `paseo` 的引导流程会交互式询问是否开中继（`packages/cli/src/commands/onboard.ts:287-296`）。公开文档说“按提示确认”（`public-docs/connectivity.md:72`）——文档漂移。
- 中继默认关闭，配对即同意：新配置 `relay: { enabled: false }`（`packages/server/src/server/persisted-config.ts:370-372`），老 home 没写这个字段的保持开启（`config.ts:302-308`，`COMPAT(relayOptInDefault)`）；运行时监听配置变化实时启停中继（`bootstrap.ts:1772-1774`）。桌面“配对设备”按钮就是 patch `{relay:{enabled:true}}`，这次 patch 发的是 `set_daemon_config_request`，需要 `daemon.manage` 权限（`packages/app/src/desktop/components/pair-device-section.tsx:67-70`、`daemon-client.ts:5227-5234`、`authorization/operation-permissions.ts:176`）。
- offer 的内容（`packages/protocol/src/connection-offer.ts:9-17`）：

  ```ts
  v: z.literal(2), serverId: z.string().min(1),
  daemonPublicKeyB64: z.string().min(1),
  relay: z.object({ endpoint: z.string().min(1), useTls: z.boolean().optional() }),
  ```

  编码成 `https://app.paseo.sh/#offer=<base64url(JSON)>`，二维码就是这个 URL（`packages/server/src/server/connection-offer.ts:43-50`、`pairing-qr.ts:7-18`）。放在 URL fragment 里，所以不会发给 `app.paseo.sh` 的服务器。**没有邀请密钥、没有过期时间、没有密码**。`serverId` 是 `srv_` + 9 字节随机数，存在 `$PASEO_HOME/server-id`，同时用作中继会话 ID（`server-id.ts:23-27`）。另有 `relay://host:port/<serverId>?key=…` 形式的连接 URI（`packages/protocol/src/daemon-endpoints.ts:22-64`）。
- App 侧：`expo-camera` 只扫二维码（`packages/app/src/app/pair-scan.tsx:7,126,268`）；App 收到的外部链接只要含 `#offer=` / `#connect=` 或以 `relay://` 开头就当作配对链接处理（`packages/app/src/app/_layout.tsx:705-725`，判断在 `:709`）。除非链接与已保存的主机完全一致，否则弹窗确认“新主机 / 连接已变更”并显示公钥指纹片段（`packages/app/src/runtime/host-confirmation.ts:58-69,92-97`）。确认后，扫码配对流程先探测 daemon 再保存（`host-runtime.ts:1998,2041-2061`），外部链接导入则直接保存、不探测（`host-runtime.ts:2004-2012`）。

### 5.2 主体、权限、凭据：文档先行，代码未跟上

- 文档里的模型（`docs/permissions.md:5-51`）：principal（持久身份）↔ credential（设备或服务证明自己代表某 principal）↔ grant（权限）三者分离；配对邀请是“会过期、一次性”的交换，用来创建 principal 和 credential（`permissions.md:16`）；owner/operator/viewer 只是 UI 预设，展开成显式权限后存储，不存角色（`permissions.md:34`）；权限只做加法，没有 deny（`permissions.md:36`）；将来 grant 可以限定到工作区（`permissions.md:40-51`）。
- 权限词表已经在协议里（`packages/protocol/src/messages.ts:118-128`）：

  ```ts
  "daemon.read","daemon.manage","tunnel.manage","access.manage","workspace.read",
  "workspace.write","workspace.manage","automation.manage","hub.execute"
  ```

  每个 RPC 都映射到所需权限（`packages/server/src/server/authorization/operation-permissions.ts`，如获取配对 offer 需要 `access.manage`，`:71`），入站请求和出站推送都检查（`authorization/index.ts:25-57`），`server_info.permissions` 告诉客户端自己拿到了什么（`messages.ts:3567-3568`）。
- **实际存在的 principal 只有两种**：
  - `owner`（全部权限）：密码或本地凭据正确、未设密码、经中继且不带凭据，统统是 owner（`session-admission-auth.ts:11-37`）；插件和带 Bearer 头的旧客户端也是 owner（`websocket-server.ts:947,1027`）。
  - Hub 服务主体 `hub:<daemonId>:<sha256(secret)>`，权限在本地选择、可部分授予与撤销并实时推给已连接会话（`packages/server/src/server/hub/relationship-controller.ts:326-355,637-641`、`websocket-server.ts:1036-1050`）。
  - `hello.clientType`（`mobile|browser|cli|mcp|hub`）不参与授权（`messages.ts:7538`）。
- 代码里搜不到 “invitation”（`packages/{server,client,app,cli,protocol}/src` 下 0 处）：一次性配对邀请尚未实现。
- 凭据存放：daemon 侧是 `config.json` 里的 bcrypt 密码哈希（cost 12）（`auth.ts:6,35-37`）和每次启动重写的 `local-credential`；App 侧把主机档案（含明文 `password` 和 `daemonPublicKeyB64`）以 JSON 存在 AsyncStorage 的 `@paseo:daemon-registry` 下，不是 Keychain/Keystore（`host-runtime.ts:1407,1522,2234-2236`、`packages/app/src/types/host-connection.ts:401-445`）。

### 5.3 撤销与手机端权限

- **没有设备列表，没有按设备撤销。** 要切断一台已配对的手机，只能删 `daemon-keypair.json`（没有命令做这件事，下次启动静默重建，见 §6.1）、关掉中继，或者等中继强制密码的兼容垫片移除后设密码。
- 密码从不强制，即使绑定到非 loopback 地址也只是“强烈建议”（`SECURITY.md:59`、`public-docs/security.md:156-157`）。经中继的客户端即使设了密码、不带凭据也被准入为 owner（`session-admission-auth.ts:21-25`，`COMPAT(relayPasswordOptional)`；`SECURITY.md:45`）。
- 手机端与本地桌面**权限完全相同**：都是 owner；`SECURITY.md:55` 写明已连接客户端是 daemon 用户的“受信任操作员”，文件预览可以读 daemon 进程能读的任何普通文件。手机与桌面的差别只在传输：SSH 和本地 socket/管道只能经桌面主进程的传输（`host-runtime.ts:552-565`）。

**对 Wevir 的意义**：权限词表和“principal / credential / grant 分离、邀请一次性且会过期”的模型值得采用，但 Paseo 只实现了一半。Wevir 骨架不做配对（计划 §7），只需在协议里给 `host.hello` 结果留 `permissions` 字段、给连接身份留 `deviceId`；移动端阶段要补上 Paseo 缺的三样：一次性邀请、按设备凭据、设备列表与撤销。

---

## 6. 中继：加密、信任模型、直连与中继切换

### 6.1 加密

- tweetnacl：Curve25519 求共享密钥（`nacl.box.before`），XSalsa20-Poly1305 加密（`nacl.box.after`），密文包为 `[24 字节随机 nonce][密文]`（`packages/relay/src/crypto.ts:5-9,134-181`）；拒绝全零共享密钥（`crypto.ts:142-147`）。
- daemon 用**静态**密钥对，存 `daemon-keypair.json`（`{v:2, publicKeyB64, secretKeyB64}`，`0600`），读不出来就静默重新生成（`packages/server/src/server/daemon-keypair.ts:16-24,50-65`）；客户端每条通道生成**临时**密钥对。因为 daemon 一侧是静态密钥，没有前向保密。
- 握手（`packages/relay/src/encrypted-channel.ts:56-69,154-217,227-315`）：客户端发明文 `{"type":"e2ee_hello","key":"<b64>","capabilities":{"binaryCiphertext":true}}`，每 1 s 重发一次；daemon 回明文 `{"type":"e2ee_ready"}`；daemon 侧握手超时 15 s（`packages/server/src/server/relay-transport.ts:423-426`）。同一通道再收到不同公钥的 hello 以 1008 关闭（`encrypted-channel.ts:503-525`）；通道建立后再出现明文 JSON 视为致命错误（`:406-408`）。
- 能力协商：双方都支持 `binaryCiphertext` 时，文本帧走 base64 文本、二进制帧走原始二进制，保留 WebSocket opcode；否则全部 base64 文本（`encrypted-channel.ts:419-441,475-482`；`SECURITY.md:25-27`）。
- 会话内**不防重放**：随机 nonce，不记录 nonce、没有计数器（`SECURITY.md:39`）。

### 6.2 信任模型

- 中继能看到：IP、时间、消息大小、URL 查询串里的 `serverId` / `connectionId`、明文握手帧（`SECURITY.md:29`、`daemon-endpoints.ts:227-250`）。
- 客户端认证 daemon：靠二维码里钉住的 daemon 公钥。`e2ee_ready` 本身不认证（`encrypted-channel.ts:364-368`），daemon 身份是在第一条消息成功解密时隐式证明的；App 还会核对服务端回报的 `serverId`（`host-runtime.ts:1044-1052`）。
- daemon 认证客户端：**不认证**。拿到 `serverId` 和 daemon 公钥的任何人都是 owner（见 §5.3），所以“二维码就是信任锚，像密码一样保管”（`SECURITY.md:43`）。
- 中继服务本身：生产用的是独立仓库的 Elixir 服务，本仓库的 Cloudflare Durable Object 实现已不部署（`docs/architecture.md:183`）。旧实现按 `serverId` + `role` + `v` 路由，`role=server` 无 `connectionId` 是控制连接、带 `connectionId` 是每客户端的数据连接（`packages/relay/src/cloudflare-adapter.ts:118-128,340-371,417-440`），`role=server` 不认证、新连接顶掉旧连接（`:356-360`）。
- 推断（文档没写）：双向共用一把对称密钥，中继可以把帧原样反射给发送方；中继也可以剥掉 `binaryCiphertext` 能力，但只能把帧格式降级为 base64，不影响机密性。

### 6.3 daemon 出站连接

- daemon 主动连中继的控制通道，处理 `sync`/`connected`/`disconnected`/`ping`（`relay-transport.ts:49-54,162-171,292-330`）；每来一个客户端，开一条数据连接、跑 `createDaemonChannel`，以 `transport: "relay"` 接入同一个 WebSocket 服务（`relay-transport.ts:345-393,416-470`）。重连退避上限 30 s（`relay-transport.ts:333-343`）。
- 没有密钥对时会以明文接入（`relay-transport.ts:390-391`），bootstrap 总会提供密钥对（`bootstrap.ts:1756-1771`）。
- 客户端在没有 E2EE 的中继连接上拒绝发送凭据（`packages/client/src/daemon-client.ts:1527-1531`）。

### 6.4 直连与中继切换

- 一个主机档案下挂多条连接：`HostProfile {serverId, connections[], preferredConnectionId, ...}`（`packages/app/src/types/host-connection.ts:63-73`），连接类型有 `directTcp`、`directSocket`、`directPipe`、`remoteSsh`、`relay{relayEndpoint, useTls, daemonPublicKeyB64}`（`host-connection.ts:26-59`）。直连按 `serverId` 合并到已有主机（`public-docs/connectivity.md:122`）。
- 选择：所有连接都定期探测——起初每 2 s、逐步退避到 30 s，活动连接 10 s 一次，非活动连接在线时 120 s 一次（`host-runtime.ts:228-233,502-519`）；先连上哪条用哪条（`host-runtime.ts:905-924`）；活动连接断了就切到延迟最低的可用连接（`host-runtime.ts:957-971`、`packages/app/src/utils/connection-selection.ts:26-50`）；否则只有另一条连接连续 3 次探测都快至少 40 ms 才切换（`host-runtime.ts:977-1016`）。
- `preferredConnectionId` 存了但不参与选择；没有监听网络变化，切换完全靠轮询探测。

**对 Wevir 的意义**：中继整体推迟到移动端阶段。届时可以沿用“二维码钉住 Host 公钥 + 客户端临时密钥 + NaCl box”的骨架和“一个主机多条连接、按探测延迟带滞回切换”的选路，但要补：客户端认证（配对时下发按设备凭据，在加密通道内的 `host.hello` 里出示）、会话内防重放（单调计数器或按方向区分的 nonce 前缀）、Host 密钥轮换与撤销。中继服务要能在大陆自托管（计划 §2.7），不能默认指向海外地址。

---

## 7. Agent Provider 抽象与进程管理的边界

Wevir 不采纳这一层，这里只划清边界和冲突点。

### 7.1 边界在哪

- 边界是 `AgentClient` / `AgentSession`（`packages/server/src/server/agent/agent-sdk-types.ts`）。每个 Provider 是 daemon 进程内的一个 TypeScript 适配器，适配器自己 spawn 并拥有它的 CLI 子进程。形状上和 Wevir 的 `AgentRuntimeAdapter` 是同一层，区别是 Paseo 在它上面还有一个管得更多的 `AgentManager`。
- `AgentClient`（`agent-sdk-types.ts:746-812`）：`createSession`、`resumeSession(handle)`、`fetchCatalog`（模型和模式）、`isAvailable`，以及可选的导入、归档、`shutdown`。
- `AgentSession`（`agent-sdk-types.ts:664-714`）的核心方法：

  ```ts
  startTurn(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<{ turnId: string }>;  // :674
  subscribe(callback: (event: AgentStreamEvent) => void): () => void;                          // :676
  streamHistory(): AsyncGenerator<AgentStreamEvent>;                                            // :677
  ```

  另有 `getPendingPermissions()`（`:682`）、`respondToPermission`（`:683`）、`describePersistence()`（`:687`）、`interrupt()`（幂等，只有不能确认回合已停止时才 reject，`:688-693`）、`close()`（释放运行时但不删原生会话，`:694-695`），以及模式、模型、思考强度设置。
- `AgentStreamEvent`（`agent-sdk-types.ts:405-461`）：`thread_started`、`turn_started/completed/failed/canceled`、`usage_updated`、`mode/model/thinking_option_changed`、`timeline`（包一条 `AgentTimelineItem`）、`permission_requested/resolved`、`attention_required`、`provider_subagent`。
- 工具调用归一化为 `ToolCallDetail`（`agent-sdk-types.ts:239-336`）：`shell`、`read`、`edit`、`write`、`search`、`fetch`、`worktree_setup`、`sub_agent`、`plain_text`、`plan`、`unknown`，状态 `running/completed/failed/canceled`（`:338-371`）。
- 审批请求（`agent-sdk-types.ts:479-491`）：`kind` 为 `tool | plan | question | mode | other`，附 `actions[]`（每项 `{id, label, behavior: "allow" | "deny"}`，`:471-477`）；响应（`:493-505`）是 allow/deny，带 `selectedActionId` 和可选 `interrupt`。
- 持久化句柄只存 Provider 的原生会话 ID（`agent-sdk-types.ts:183-189`）：`{provider, sessionId, nativeHandle?, metadata?}`。

### 7.2 进程管理

- 没有统一的进程管理器，各 Provider 自己 spawn 和回收：Codex（`providers/codex-app-server-agent.ts:7244`）、Pi/OMP（`jsonl-rpc-process.ts:66`）、Claude（`claude/agent.ts:2798`）、OpenCode（`opencode/server-manager.ts`）；文档也这么写（`docs/providers.md:58`）。只有可能比会话活得久的辅助进程要登记到 daemon 的托管进程表，启动时对账、清理残留（`docs/providers.md:122-128`、`packages/server/src/server/managed-processes/managed-processes.ts:91-105`、`bootstrap.ts:499-507,515-523`）。
- 通用 ACP Provider 用 `@agentclientprotocol/sdk`（`packages/server/package.json:107`），**每个 agent 会话一个进程**：`spawnProcess()` 把 stdio 包成 NDJSON 流，`new ClientSideConnection(() => this, stream)`（`providers/acp-agent.ts:2816-2891`，`:2864`）。新会话 `newSession({cwd, mcpServers})`（`:1797-1817`）；恢复时 Agent 支持 `loadSession` 就回放历史，否则用 `unstable_resumeSession`，两者都没有就报错（`:1826-1873`）。目录探测另起一个短命进程（`:1082,1398`）。`close()` 依次 `cancel` → `unstable_closeSession` → 整树杀进程（`:2502-2554`）。进程退出只在有活动回合时报成 `turn_failed`，回合之间退出不上报（`acp-agent.ts:2843-2857`）；Paseo 文档要求回合之间的退出也报成回合失败，目前只有 Claude 和 OMP 做到（`docs/agent-lifecycle.md:31-38`）。
- `AgentManager`（`packages/server/src/server/agent/agent-manager.ts`）：五态状态机 `initializing / idle / running / error / closed`（`:401-484`），时间线放在内存（`InMemoryAgentTimelineStore`，`:744`），可选的 `durableTimelineStore`（`:329`）在 bootstrap 里从未传入（`bootstrap.ts:949-962`）；恢复时用 `session.streamHistory()` 重建时间线（`agent-manager.ts:4097-4127`）；每个 agent 一份 JSON 记录在 `$PASEO_HOME/agents/{cwd-with-dashes}/{id}.json`（`agent-storage.ts:44-78,381-384`）。
- 密钥：文档说“Paseo 不管 API Key”（`docs/architecture.md:444`），实际自定义 Provider 的 Key 以明文 `env` 写在 `config.json` 里（`docs/custom-providers.md:495-505`），子进程环境是 `process.env` + 配置 env + 启动上下文叠加（`provider-launch-config.ts:211-253`）。
- 注入工具：Paseo 给每个 agent 挂一个名为 `paseo` 的 HTTP MCP 服务（`/mcp/agents?callerAgentId=…`，每次运行一个 Bearer token），提供 `create_agent`、`send_agent_prompt`、终端、定时任务等工具（`runtime-mcp-config.ts:3-4,29-58`、`bootstrap.ts:1469-1558`、`agent/tools/paseo-tools.ts:1428,1855`）；ACP Provider 通过 `mcpServers` 传入（`acp-agent.ts:2894-2896`）。

### 7.3 如果把 dsh 放进 Paseo 的模型，会在哪里冲突

| # | 冲突点 | Paseo 的做法 | Wevir / dsh 的约束 |
|---|---|---|---|
| 1 | 会话事实来源 | Provider 历史是持久事实，时间线只是内存投影，恢复时回放重建（`docs/timeline-sync.md:8-11`） | Wevir 事件库是唯一事实来源（计划 §2.1）。dsh ACP 没有 `session/load`（T0.3），Paseo 的回放路径对 dsh 根本走不通，只能走 `unstable_resumeSession`，历史会是空的 |
| 2 | 会话身份 | agent JSON 记 `nativeHandle`，恢复 = 新 spawn 一个进程再 resume（`acp-agent.ts:1828-1866`） | Wevir Session ↔ 引擎 Session 的映射归 Host（T2.3），只能有一个所有者 |
| 3 | 审批 | 适配器内部有 Auto Accept，可以在本地直接应答（`acp-agent.ts:861-875,2556-2598`）；按 option `kind` 前缀猜 allow/deny（`:3944-3979`） | 审批规则与自动应答记在 Host，作为事件落库（T0.3 §11.2 第 4 条、T2.3）；dsh 侧的权限模式另有一套 |
| 4 | 沙箱 | ACP 客户端能力默认 `terminal: true`，dsh 的终端请求会由 Paseo 在宿主机上执行（`acp-agent.ts:286-293,2712`） | 绕过 dsh 沙箱。Wevir 适配器必须声明 `terminal: false`、`fs` 全关 |
| 5 | 工具注入 | 往 `mcpServers` 塞 `paseo` MCP，给 Agent 增加编排工具 | Wevir 不应在骨架阶段给 dsh 注入自家工具；扩展走 Cordis 插件（计划 §1.3） |
| 6 | 进程生命周期 | ACP：每会话一进程，关会话即杀；回合之间的进程退出不报（`acp-agent.ts:2843-2857`） | T3.1：dsh 进程由 `adapter-dsh` 管，T0.3 验证过单进程多会话；任何时候进程退出都要转成会话 `error` |
| 7 | Provider 配置与密钥 | `config.json` 的 `env` 明文存 Key，profile 与 models 覆盖 | 计划 §2.8：密钥只在 Host 内存与 0600 文件，经子进程环境变量传给 dsh；模型配置经 overlay 归 dsh |
| 8 | 模式与模型 | 每次启动或恢复都强推配置里的 mode/model（`acp-agent.ts:2925` 起） | 会覆盖 dsh 自己的会话状态；Wevir 只在用户显式切换时 `set_config_option` |

**可以借的**：`ToolCallDetail` 的分类可作为 Wevir 工具卡片展示类型的参考（T0.3 发现 dsh 的 ACP `kind` 恒为 `other`，Host 要按工具名自己归类）；审批请求带 `actions[]`、响应带 `selectedActionId` 的形状能原样承接 ACP 的 `PermissionOption`；`interrupt()` “幂等、只在无法确认已停止时失败”的语义适合写进 T1.3 契约测试；`getPendingPermissions()` 说明适配器应能报告未决审批，供 Host 重启或客户端中途加入时对账。

---

## 8. Expo 客户端与桌面端共享了什么

- **桌面直接渲染 App 的 web 导出**：开发时加载 Metro 地址，打包后加载 `paseo://app/...`，文件来自 `app-dist`（`packages/desktop/src/main.ts:110,576-582,780-790,929-945`），而 `app-dist` 是 `packages/app/dist` 的拷贝（`packages/desktop/electron-builder.yml:34-35`）。构建脚本 `PASEO_WEB_PLATFORM=electron npx expo export --platform web`（根 `package.json:95`）。也就是说，iOS、Android、浏览器、桌面是**同一套 React Native 代码**。
- 平台差异靠 Metro 文件后缀：Electron 先找 `.electron.*`，再回退 `.web.*`（`packages/app/metro.config.cjs:13-16,52-76`），例如 `packages/app/src/desktop/browser/pane/index.electron.tsx`；原生与 web 用 `.native.ts` / `.web.ts`。
- 包依赖：
  - `@getpaseo/protocol`：zod schema 与类型，只依赖 `zod`、`semver`（`packages/protocol/package.json:1-36`）。
  - `@getpaseo/client`：底层 `DaemonClient`（`packages/client/src/daemon-client.ts:1222`）加上层 `PaseoClient` / `PaseoApi` 门面，依赖 protocol、relay、zod（`packages/client/package.json:10-45`；`docs/architecture.md:99-109`）。
  - App 依赖 client、protocol、plugin、highlight、expo-two-way-audio（`packages/app/package.json:51-55`）。
  - 桌面依赖 `@getpaseo/server` 和 `@getpaseo/cli`，**不依赖 app 包**，只拷贝它的构建产物（`packages/desktop/package.json:30-36`）。
  - CLI 与 App 用同一个 `DaemonClient`（`@getpaseo/client/internal/daemon-client`，如 `packages/cli/src/utils/client.ts:21`），另从 `@getpaseo/server/daemon-control` 拿进程控制（`client.ts:6`）。
- 状态管理（只在 App 里，桌面主进程没有）：zustand 5（`packages/app/package.json:136`，如 `packages/app/src/stores/session-store.ts:2-3,717-718`）、TanStack Query（`packages/app/package.json:66`、`packages/app/src/data/query-client.ts:3`）、包住 `DaemonClient` 的 `HostRuntimeController` / `HostRuntimeStore`（`packages/app/src/runtime/host-runtime.ts:10,630,1489`）、目录同步 `DirectorySync`（`packages/app/src/runtime/directory-sync/index.ts:134`）、副本缓存 `ReplicaCache`（`packages/app/src/runtime/replica-cache/index.ts:883`；web 用 IndexedDB `packages/app/src/runtime/replica-cache/row-store.web.ts:69`，原生用 expo-sqlite `packages/app/src/runtime/replica-cache/row-store.native.ts:1,43`；`docs/data-model.md:581`）。
- 桌面主进程额外提供：preload 暴露的 `window.paseoDesktop`（通用 `invoke`、窗口、对话框、通知、编辑器、菜单、内置浏览器，`packages/desktop/src/preload.ts:32-140`）；`invoke` 命令里有 daemon 启停与状态、本地传输、附件、更新、安装 CLI（`daemon-manager.ts:404-490`）；socket / 管道 / SSH 传输（`local-transport.ts:12-24,92-110,173`）。App 侧对这个桥的类型是 `DesktopHostBridge`（`packages/app/src/desktop/host.ts:171-196`）。

**对 Wevir 的意义**：Paseo 能做到“手机即桌面”，是因为它从一开始就把桌面做成了 RN-web。Wevir 已冻结“桌面 Electron + React + Tailwind，移动端 Expo”（计划 §1.3），所以骨架阶段能共享的是**协议包 + client-sdk**（类型、请求、订阅、断线续传），以及将来可能抽出的与渲染无关的状态层；UI 不共享。client-sdk 要像 `@getpaseo/client` 一样只依赖协议包、不依赖 Node 内置模块，才能在 Expo 里直接用（T4.1）。

---

## 9. 三栏结论

### 9.0 总表

编号对应 §9.1–§9.3 的明细；“直接采纳”每一项都在 §9.1 写明落到 SKELETON_PLAN 的哪个任务。

| 主题 | 骨架阶段直接采纳（写进 Host API / 事件设计） | 推迟到移动端阶段采纳 | 不采纳 |
|---|---|---|---|
| 进程与发现（§1） | A13 运行时文件与陈旧锁 · A14 每次启动的本地令牌 · A17 桌面先发现后拉起、只停自己拉起的 · A18 优雅退出顺序 | D9 supervisor/worker 常驻 daemon、自更新、socket/管道监听 | N8 默认无鉴权 · N11 断线后服务端保留逻辑会话 |
| 协议组织（§2） | A1 `host.hello` 握手 · A2 握手与未知方法的错误 · A3 兼容纪律与 `COMPAT` 标签 · A4 能力位与功能门控 · A15 Host/Origin 校验 · A16 心跳租约、发送上限、超时分层 | D7 生成式入站校验器 | N1 自定义 `type` 信封与 `.request/.response` 后缀 · N2 形同虚设的整数版本号 |
| 事件流（§3） | A5 显式订阅与 `subscriptionId` · A6 按 `seq` 去重、缺口补拉、补到完 · A7 会话快照含未决审批 · A8 增量合并后入库、工具输出截断 | D5 客户端副本缓存 · D6 列表的增量目录同步 · D8 推送通知与在线状态 | N3 内存时间线 + epoch 序号 + Provider 历史为事实 |
| 多端并发（§4） | A9 审批先到先得、广播带 `decidedBy` · A10 中断时未决审批结为 `cancelled` · A11 每会话串行、运行中拒绝发送 · A12 `clientMessageId` 幂等、结果未知不重发 | D10 客户端本地发送队列 | N12 运行中新消息默认“中断并替换” |
| 配对与权限（§5） | A1 中预留 `deviceId` 与 `permissions` 字段 | D2 一次性配对邀请 + 二维码钉公钥 · D3 principal / credential / grant 与设备撤销 | —（Paseo 的半成品实现见 N8） |
| 中继（§6） | — | D1 中继 E2EE（补防重放、防反射、客户端认证） · D4 多连接选路与滞回切换 | — |
| Provider 与进程（§7） | A19 适配器契约补充 · A20 工具展示类型与审批选项结构 | — | N4 Provider 层 · N5 MCP 工具注入与宿主终端 · N6 适配器内自动应答 · N7 密钥写配置文件 · N9 JSON 文件存储 |
| 代码共享（§8） | A21 平台无关、传输可注入的 client-sdk | D11 抽出与渲染无关的共享状态层 | N10 桌面渲染 RN-web 导出 |

### 9.1 骨架阶段直接采纳

| ID | 采纳内容（写进哪里） | Paseo 依据 | 落到任务 |
|---|---|---|---|
| A1 | `host.hello` 是首个且必须的请求，参数带 `clientId`（每个安装持久）、`clientKind`、`deviceId`、`protocolVersion`、`capabilities`、`token`；结果带 `hostId`、`hostVersion`、协商后的 `protocolVersion`、`minProtocolVersion`、`features`、`permissions`（骨架恒为全部）。hello 之前的任何请求直接关闭连接；hello 设超时（Paseo 15 s）。 | §2.3；`messages.ts:7535-7566,3560-3610`、`websocket-server.ts:484,1566-1579,1777-1790` | T1.2（schema、`host-api.md`）、T2.4（执行） |
| A2 | 握手失败先回 JSON-RPC 错误（`unauthorized` / `incompatible_protocol`），再用专用关闭码关闭；未知方法回 `-32601`，`data` 带 `hostVersion` 与“请升级 Host”提示；`host-api.md` 列出错误码表。 | §2.3；`websocket-server.ts:1705-1733,2180-2204` | T1.2、T2.4 |
| A3 | 兼容纪律写进 `host-api.md`：只增不减、新字段 optional、不收窄、不再发送的字段继续接受；schema 只做结构声明（不用 `transform/preprocess/catch`），共享 `type` 时用 `z.discriminatedUnion`，`default` 只放叶子；兼容垫片一律 `// COMPAT(name): added in vX, remove after <date>`。schema 单测保留“旧消息仍能解析”的样本。 | §2.3、§2.4；`docs/protocol-compatibility.md:9-29,77-91`、`docs/protocol-validation.md:36-42` | T1.2 |
| A4 | 客户端在 hello 声明 `capabilities`，Host 发出新事件类型或新枚举值前按能力门控（不支持就降级或不发）；Host 在 hello 结果的 `features` 里声明功能，客户端只在一处判断，不写降级路径。client-sdk 维护一份穷举的默认能力表，CLI、桌面继承。 | §2.3；`client-capabilities.ts:1-49`、`connection/index.ts:125-145`、`docs/protocol-compatibility.md:31-49` | T1.2、T2.4、T4.1 |
| A5 | 连接本身不推送任何会话数据；`events.subscribe` 返回服务端分配的 `subscriptionId`，事件通知带 `subscriptionId`，`events.unsubscribe(subscriptionId)` 释放；重连后由客户端重新订阅。 | §2.2；`docs/architecture.md:251-262`、`messages.ts:3166-3196` | T1.2、T2.4、T4.1 |
| A6 | 客户端按 `seq` 应用事件：`seq == lastSeq + 1` 接受，`<=` 丢弃，更大视为缺口并以 `sinceSeq = lastSeq` 重新订阅；Host 分批回放时在最后发一个回放结束标记（或在订阅结果里给出 `replayedThroughSeq`），客户端未收到结束标记前不算追平。 | §3.3；`session-stream-reducers.ts:282-304`、`docs/timeline-sync.md:35-45` | T2.4、T4.1 |
| A7 | `session.get` 返回快照 `{state, pendingApprovals[], activeTurn, lastSeq, ...}`；中途加入 = 取快照 + `events.subscribe(sinceSeq = lastSeq)`。快照由事件推导（T2.2 已规划），未决审批是快照的一部分。 | §3.4、§3.5；`messages.ts:813-845`（`activeTurn :826`、`pendingPermissions :830`）、`session.ts:7748,7781` | T1.2、T2.2 |
| A8 | 助手文本增量在 Host 内按短窗口（Paseo 60 ms，首尾两次 flush）合并后再分配 `seq` 落库，不能合并的事件先 flush 保序；工具输出入库与推送前按统一上限截断（Paseo 对 shell 输出取 64 KiB），上限写进 `host-api.md`。 | §3.2；`agent-stream-coalescer.ts:4`、`agent-manager.ts:4303-4307`、`docs/timeline-sync.md:19-22`、`docs/agent-stream-performance.md:29-31` | T2.2、T3.2 |
| A9 | 审批先到先得：首个决定生效；决定提交到引擎期间暂扣引擎侧的“已解决”事件，成功后再写 `approval.resolved {requestId, decision, decidedBy{deviceId, clientKind}}` 并广播；后到者收到 `already_decided` 和既有决定（Paseo 只给后到者一个错误，也不记录是谁批的）。 | §4.1；`agent-manager.ts:3085-3121,4741-4746`、`messages.ts:5157-5165` | T2.3（`approval.resolved` 事件 schema 在 T1.2） |
| A10 | 取消、会话关闭、引擎退出时，未决审批统一结为 `cancelled` 并写事件；Host 重启时残留的未决审批结为 `expired`（T3.3 已有）。 | §4.1；`agent-manager.ts:3184-3188,4750-4767` | T2.3、T3.3 |
| A11 | 每个会话的命令（send、cancel、approval.respond、close）在 Host 内串行执行；会话非 `idle` 时 `session.send` 直接返回 `session_busy` 和当前状态，排队留给客户端。 | §4.2；`agent-manager.ts:2600-2613,2889-2929` | T2.3（错误码在 T1.2） |
| A12 | `session.send` 带可选 `clientMessageId`：同一 ID 重发时返回原结果，不再发给引擎；请求体不同则报冲突；Host 重启后对“已接受、未确认引擎收到”的发送标为结果未知，不自动重发。 | §4.3；`messages.ts:1363-1376`、`message-receipts/index.ts:42-56`、`creation/index.ts:69-87` | T1.2、T2.3、T3.5 |
| A13 | `run/host.json` 用排他创建（`wx`）写入，目录 `0700`、文件 `0600`；监听就绪后才写入端点；陈旧判定用 `kill(pid, 0)` + `startedAt`；退出时只删 `{pid, startedAt}` 仍属于自己的文件；客户端只连 `host.json` 里的端点，不回退到默认端口。 | §1.3；`pid-lock.ts:10-20,56-100,161-215,379-398`、`daemon-instance.ts:59-86` | T2.5、T4.1 |
| A14 | 每次 Host 启动生成 32 字节随机令牌，只写在 `host.json`（0600），退出时删除；令牌**始终必需**，在 `host.hello` 参数里出示（浏览器和 Electron 渲染进程的 WebSocket 设不了 `Authorization` 头，Paseo 也已把 Bearer 头降为兼容路径）。 | §1.3、§1.6；`local-credential.ts:12-25`、`messages.ts:7540-7545`、`websocket-server.ts:923-948` | T2.4、T2.5、T4.1 |
| A15 | WebSocket 升级时校验 Host 头（只允许 `127.0.0.1`、`localhost`）和 Origin 白名单（桌面渲染进程的 origin、无 Origin 的 CLI）；**缺 Host 头也拒绝**（Paseo 在这里放行）。 | §1.6；`websocket-server.ts:880-911`、`hostnames.ts:41-74` | T2.4 |
| A16 | 应用层心跳：client-sdk 每 10 s 发 `host.ping`，Host 对超过租约（Paseo 45 s）无活动的连接断开；每条连接设发送缓冲上限，超限只断这一条；client-sdk 的请求超时、连接超时、心跳超时分开配置。 | §2.1；`physical-socket.ts:1-8`、`daemon-client.ts:1052,1056` | T2.4、T4.1 |
| A17 | 桌面主进程先读 `host.json` 并探活，已有 Host 就附着；否则拉起并记下 `{pid, startedAt}`。退出时只停止本次会话拉起的 Host；附着到 CLI 启动的 Host 不停止。 | §1.4；`daemon-manager.ts:58,189-194,279-324`、`quit-lifecycle.ts:55-74,118-158` | T5.1 |
| A18 | 优雅退出顺序：停止接受新连接 → 取消运行中的回合并结掉未决审批 → 回收 dsh 进程树 → flush SQLite → 关闭 WebSocket → 删除 `host.json`；整体超过时限（Paseo 10 s）强制退出。 | §1.5；`bootstrap.ts:1812-1860`、`daemon-worker.ts:163-187` | T2.5、T3.1 |
| A19 | 适配器契约补充：`cancel` 幂等，只在无法确认已停止时失败；适配器能列出未决审批，供 Host 对账；ACP 客户端能力声明 `terminal: false`、`fs` 读写全关，不在 Host 上替引擎执行命令；引擎进程在回合之间退出也要上报。 | §7.1、§7.3；`agent-sdk-types.ts:682,688-693`、`acp-agent.ts:286-293,2843-2858` | T1.3（契约测试）、T3.1 |
| A20 | 领域模型参考：工具卡片展示类型参考 `ToolCallDetail` 的分类（shell / read / edit / write / search / fetch / plan / unknown）；`ApprovalRequest` 原样携带引擎给的选项列表（id、标签、allow/reject 类别），`approval.respond` 回传所选选项 ID。 | §7.1；`agent-sdk-types.ts:239-371,471-505` | T1.1、T3.2、T3.3 |
| A21 | client-sdk 只依赖 `packages/protocol`，不 import Node 内置模块（`@getpaseo/client` 的非测试源码里没有 `node:` 导入），WebSocket 由调用方注入，传输层是可替换接口，为将来 Expo 和中继加密传输留口。 | §8；`packages/client/package.json:41-45`、`daemon-client-transport-types.ts:1-25` | T4.1 |

### 9.2 推迟到移动端阶段采纳

| ID | 内容 | 届时要补的缺口 | 依据 |
|---|---|---|---|
| D1 | 中继 + 端到端加密：Curve25519 求共享密钥，XSalsa20-Poly1305 加密；Host 静态密钥、客户端每连接临时密钥；明文握手只含公钥与能力 | 会话内防重放（计数器）；两个方向用不同密钥或 nonce 前缀，防止中继反射；Host 密钥轮换；中继服务可在大陆自托管（计划 §2.7） | §6.1–§6.3 |
| D2 | 配对 offer 放在 URL fragment / 二维码里（`hostId` + Host 公钥 + 中继地址），App 端确认后保存并钉住公钥 | 一次性、会过期的配对邀请（带邀请密钥）；配对成功后下发按设备凭据 | §5.1；`packages/protocol/src/connection-offer.ts:9-17` |
| D3 | principal / credential / grant 分离；语义权限词表（`workspace.read/write` 等）；owner/operator/viewer 只做 UI 预设 | 设备列表、按设备撤销；中继客户端必须出示凭据；手机端凭据存 Keychain/Keystore（Paseo 用 AsyncStorage 存明文密码） | §5.2、§5.3；`docs/permissions.md` |
| D4 | 一个主机多条连接（直连、中继），定期探测延迟，带滞回地切换（Paseo：连续 3 次快 40 ms 以上才切） | 监听网络变化立即重新选路；让 `preferredConnectionId` 真正生效 | §6.4 |
| D5 | 客户端副本缓存：先展示缓存，再经网络对账；web 用 IndexedDB，原生用 SQLite | — | §8；`docs/architecture.md:126-140` |
| D6 | 会话列表、工作区列表的增量目录同步：每类实体单调 `seq` + `generation` + 墓碑，游标过期返回全量快照 | 骨架的 `session.list` 全量返回即可；经中继的移动网络再做增量 | §3.4 |
| D7 | 构建期生成的入站校验器（zod-aot），解决 Hermes 上运行时 zod 过慢 | 先实测 Wevir 的事件体量再决定 | §2.4；`docs/protocol-validation.md:1-9` |
| D8 | 推送通知；在线状态只用于通知路由，不参与事件投递 | — | §3.1；`docs/timeline-sync.md:24-33` |
| D9 | supervisor + worker 双进程的常驻 Host、自更新、Unix socket / 命名管道监听 | 手机要在桌面关闭后仍能连到 Host 时才需要；那时 `keepRunningAfterQuit` 成为设置项 | §1.1、§1.5 |
| D10 | 客户端本地发送队列（会话空闲时再发出） | 与 A11 的 `session_busy` 配合 | §4.2；`host-runtime.ts:2396-2448` |
| D11 | 把与渲染无关的状态层（会话、事件归并、连接状态）从桌面抽成可在 Expo 复用的包 | 骨架先在 client-sdk 里把事件归并做对（A6） | §8 |

终端二进制帧和“最后交互者赢”的终端尺寸策略（`docs/architecture.md:300-308`）属于 Phase 1 的终端面板，不在这三栏里，届时再读。

### 9.3 不采纳

| ID | 内容 | 原因 | 依据 |
|---|---|---|---|
| N1 | 自定义 `type` 信封、`.request/.response` 后缀、`requestId` 关联、`rpc_error` | 计划 §1.3 已冻结 JSON-RPC 2.0，关联、错误对象、通知都由它提供；Paseo 自己也在为扁平与点分两套响应命名并存付兼容成本 | §2.2 |
| N2 | 只拒绝 `< 1`、永远回报常量的整数协议版本 | 起不到协商作用；Wevir 在 A1 里做真正的协商 | §2.3 |
| N3 | 时间线只放内存、`epoch` 分段序号、以 Provider 历史为持久事实 | Wevir 事件库是唯一事实来源（计划 §2.1），`seq` 跨重启有效；dsh ACP 没有 `session/load`，按 Paseo 的路径恢复后历史为空 | §3.2、§7.3 #1 |
| N4 | Provider 层：`AgentClient` / `AgentManager`、多 Provider、各 Provider 自管进程、每会话一个进程 | 引擎只有 dsh，经 `AgentRuntimeAdapter` 隔离（计划 §1.3、§8“引擎生命周期归属冲突”）；T0.3 已验证单进程多会话 | §7 |
| N5 | 给引擎注入 `paseo` MCP 工具；ACP `terminal: true`，由宿主替引擎执行命令 | 绕过 dsh 沙箱，并引入第二套工具；扩展走 Cordis 插件 | §7.3 #4、#5 |
| N6 | 在适配器内自动应答审批 | 审批规则与自动应答归 Host 并落事件（T0.3 §11.2） | §7.3 #3 |
| N7 | 自定义 Provider 的 Key 以明文写在 `config.json` 的 `env` 里 | 违反计划 §2.8“密钥不落引擎文件” | §7.2 |
| N8 | 默认无鉴权；中继客户端不带凭据也给 owner；Bearer 头或 WebSocket 子协议传密码 | Wevir 令牌始终必需，在 `host.hello` 里出示（A14） | §1.6、§5.3 |
| N9 | 每个 agent 一个 JSON 文件、无迁移 | 计划 §1.3 冻结 SQLite + 文件系统，T2.1 有迁移与版本表 | §7.2；`docs/data-model.md` |
| N10 | 桌面直接渲染 Expo 的 RN-web 导出，四端共用一套 UI | 计划 §1.3 冻结桌面为 Electron + React + Tailwind（DOM）；移动端阶段再评估 UI 是否共享 | §8 |
| N11 | 客户端断开后服务端保留逻辑会话 90 s | Wevir 服务端不为客户端保留订阅状态，重连靠 `sinceSeq` 重新订阅即可恢复，更简单 | §4.4 |
| N12 | 运行中收到新消息默认“中断并替换” | 骨架用 A11 的 `session_busy`；“中断并替换”“插入当前回合”以后作为显式选项再加 | §4.2 |

---

## 10. 对 SKELETON_PLAN 的修改建议（由 T0.6 落实）

除 ADR-0002 一条已直接改进计划外，以下修改交给 T0.6，与 T0.3 报告 §11.3 的建议一起落实。

- **ADR-0002**（已定，计划 §6 T0.6 已改写）：令牌在 `host.hello` 参数里出示，不用 Bearer 头，因为 Electron 渲染进程用的是浏览器 WebSocket，设不了 `Authorization` 头（A14）；Host 由桌面拉起、桌面只停自己拉起的，常驻 daemon 推迟到移动端（A17、D9）。T0.6 写 ADR 时照此记录。
- **T1.2**：`host.hello` 结果加 `hostId`、`hostVersion`、`minProtocolVersion`、`features`、`permissions`（A1）；`events.subscribe` 返回 `subscriptionId`、通知带 `subscriptionId`、回放结束标记（A5、A6）；`session.get` 快照含 `pendingApprovals`、`activeTurn`、`lastSeq`（A7）；`session.send` 加 `clientMessageId`（A12）；新增事件 `approval.resolved`（含 `decidedBy`）（A9）；`host-api.md` 加“兼容规则”和“错误码表”两节（A2、A3）。
- **T2.2**：助手增量先合并再分配 `seq`；工具输出截断上限（A8）。
- **T2.3**：每会话命令串行、`session_busy`、审批提交期间暂扣引擎事件、`cancelled` 与结果未知的处理（A9–A12）。
- **T2.4**：hello 超时、Host/Origin 校验、心跳租约、发送缓冲上限、按能力门控（A1、A4、A15、A16）。
- **T2.5**：`host.json` 的排他创建、陈旧判定、就绪后发布、只删自己的、退出顺序（A13、A14、A18）。
- **T1.3 / T3.1**：契约测试覆盖 `cancel` 幂等与列出未决审批；ACP 客户端能力 `terminal: false`、`fs` 全关；回合之间的进程退出上报（A19）。
- **T4.1**：穷举默认能力表、按 `seq` 去重与缺口补拉、超时分层、传输可注入、不依赖 Node 内置模块（A4、A6、A16、A21）。
- **T5.1**：附着与拥有的区分（A17）。
