# ADR-0002：Host 传输与进程模型

- 状态：Accepted（2026-10-12）
- 日期：2026-10-12
- 任务：T0.6；影响 T1.1、T1.2、T2.2–T2.5、T4.1、T4.2、T5.1、T5.5
- 依据：计划 §1.3（JSON-RPC 2.0 over WebSocket 已冻结）；[Paseo 研读](../research/paseo-notes.md) §1–§4、§8 与 §9.1 的 A1–A21（令牌在 hello 中出示一条已在 T0.4 提前写入计划）

## 背景

- Host 是 Wevir 唯一的调度者和事实来源（计划 §2.1）。骨架阶段有两类客户端：`wevir` CLI（Node）和桌面渲染进程（浏览器 WebSocket，**设不了 `Authorization` 头**）；将来还有经中继的手机端（计划 §4.1，只预留字段）。
- 计划 §4.2 第 7 条要求 CLI 与桌面同时连到同一个 Host、看同一条事件流，并能在任一端审批。
- Paseo 的 daemon 已经解决了大部分同类问题，但有几处 Wevir 不能照搬：默认无鉴权（N8）、整数版本号形同虚设（N2）、自定义 `type` 信封（N1）、时间线只在内存（N3）。T0.4 把可直接采纳的做法整理成了 A1–A21，每一条都对应到了计划里的任务。本 ADR 吸收其中的 A1–A18 与 A21；A19、A20 属于适配器层，写在 ADR-0001 §1、§5、§7。

## 决策

### 1. 传输

- JSON-RPC 2.0 over WebSocket，文本帧，一帧一个 JSON-RPC 对象；v0 不支持批量请求。客户端请求带 `id`；Host 主动推送用通知（无 `id`），事件推送的方法名为 `events.event`。
- 只监听 `127.0.0.1`，端口默认 0（系统分配），`--port` 仅供调试。完整端点 URL 写进运行时文件 `run/host.json`，客户端照用、不自己拼，也**不回退到任何默认端口**（Paseo A13）。
- 骨架不监听 Unix socket / 命名管道（渲染进程连不上，Paseo 要经主进程转发，见 D9）。
- WebSocket 升级时校验（Paseo A15）：
  - `Host` 头只允许 `127.0.0.1:<port>` 与 `localhost:<port>`；**缺 `Host` 头也拒绝**（Paseo 在这里放行，是它的一个漏洞）。
  - `Origin` 头：不带 Origin 的客户端（CLI、测试）放行；带 Origin 的只放行桌面渲染进程的 origin（开发服务器与打包后的协议，具体值在 T5.1 确定并写进 `host-api.md`）。其余一律 403。

### 2. 握手：`host.hello`

- 连接上的第一个请求必须是 `host.hello`；在它之前收到任何其他方法，回错误后关闭连接。hello 超时 15 s（Paseo A1）。
- 参数（Paseo A1）：`token`、`protocolVersion`、`clientKind`（至少 `desktop`、`cli`，预留 `mobile`）、`deviceId`（设备级）、`clientId`（每个安装持久，同一台设备上的桌面与 CLI 不同）、`capabilities`（客户端支持的能力位）。
- 结果：`hostId`、`hostVersion`、协商后的 `protocolVersion`、`minProtocolVersion`、`features`（Host 功能声明）、`permissions`（骨架恒为全部，为设备权限预留）。
- **令牌始终必需**（不学 Paseo 的“默认无密码”）：每次 Host 启动生成 32 字节随机数（base64url），只存在于 Host 内存和 `run/host.json`；在 hello 参数里出示，常量时间比较；不放 URL 查询串、不用请求头或子协议（Paseo A14）。
- 失败时先回 JSON-RPC 错误（`unauthorized` / `incompatible_protocol`），再以专用关闭码关闭；未知方法回 `-32601`，`data` 带 `hostVersion` 与“请升级 Host”的提示（Paseo A2）。错误码与关闭码表由 T1.2 写进 `docs/architecture/host-api.md`。
- 版本：`PROTOCOL_VERSION` 是 semver 字符串；主版本不同即不兼容。兼容纪律写进 `host-api.md`（Paseo A3）：schema 只增不减，新字段一律 optional，不收窄类型，不再发送的字段继续接受；schema 只做结构声明（不用 `transform` / `preprocess` / `catch`），共享 `type` 用 `z.discriminatedUnion`，`default` 只放叶子；兼容垫片标 `// COMPAT(name): added in vX, remove after <date>`。
- 能力与功能（Paseo A4）：Host 发出新事件类型或新枚举值前按客户端 `capabilities` 门控，不支持就降级或不发；客户端按 hello 结果的 `features` 一处判断是否启用功能。client-sdk 维护一份穷举的默认能力表，CLI 与桌面继承。

### 3. 订阅与事件流

- 连接本身不推送会话数据。`events.subscribe({sessionId, sinceSeq})` 返回 Host 分配的 `subscriptionId`；事件通知带 `subscriptionId`；`events.unsubscribe(subscriptionId)` 释放；断线重连后由客户端重新订阅（Paseo A5）。Host 不为断开的客户端保留订阅状态（Paseo N11）。
- Host 先补发 `seq > sinceSeq` 的历史，再无缝切换到实时：追加与回放在同一把会话锁下衔接，保证不丢、不重；回放分批时以结束标记（或订阅结果里的 `replayedThroughSeq`）告诉客户端何时追平（Paseo A6）。
- 客户端按 `seq` 应用事件：`seq == lastSeq + 1` 接受，`<=` 丢弃，更大视为缺口，以 `sinceSeq = lastSeq` 重新订阅（Paseo A6）。
- `session.get` 返回由事件推导的快照 `{state, pendingApprovals[], activeTurn, lastSeq, …}`；中途加入的客户端取快照，再以 `sinceSeq = lastSeq` 订阅（Paseo A7）。
- 助手文本增量在 Host 内按短窗口合并后再分配 `seq` 落库（Paseo 取 60 ms，首尾各 flush 一次），不能合并的事件先 flush 以保序；工具输出在入库和推送前按统一上限截断，上限写进 `host-api.md`（Paseo A8）。

### 4. 多客户端并发

- 每个会话的命令（`session.send`、`session.cancel`、`approval.respond`、`session.close`）在 Host 内串行执行。会话不是 `idle` 时 `session.send` 直接返回 `session_busy` 和当前状态，不排队、不打断；排队留给客户端（Paseo A11、N12）。
- 审批先到先得：首个决定生效；提交到引擎期间暂扣引擎侧的“已解决”事件，成功后写 `approval.resolved {requestId, decision, decidedBy: {deviceId, clientKind}}` 并广播；后到者收到 `already_decided` 和既有决定（Paseo A9）。
- 取消、关闭会话、引擎退出时，未决审批统一结为 `cancelled` 并写事件；Host 重启时残留的未决审批结为 `expired`（Paseo A10）。
- `session.send` 带可选 `clientMessageId`：同一 ID 重发返回原结果、不再发给引擎；请求体不同则报冲突；Host 重启后对“已接受、未确认引擎收到”的发送标为结果未知，不自动重发（Paseo A12）。

### 5. 连接健康

- client-sdk 每 10 s 发一次 `host.ping`；Host 对超过租约（45 s）没有任何消息的连接断开（Paseo A16）。
- 每条连接设发送缓冲上限，超限只断这一条连接，不影响同一会话的其他订阅者。
- client-sdk 的请求超时、连接超时、心跳超时分开配置，默认值由 T4.1 定。

### 6. 进程模型

- **Host 是独立进程**：`packages/host` 提供可执行入口 `wevir-host`，不依赖桌面即可运行（Gate M2 不需要桌面）。一个数据目录同时只有一个 Host。
- **运行时文件 `<数据目录>/run/host.json`**（Paseo A13、A14）：内容至少有 `pid`、`startedAt`、`url`、`token`、`protocolVersion`、`hostVersion`；`run/` 目录 0700、文件 0600；启动时以排他创建（`wx`）占位，监听就绪后才原子地写入 `url`（先写临时文件再 rename）；已有文件时用 `kill(pid, 0)` 加 `startedAt` 判断是否陈旧，活着就拒绝启动；退出时只删除 `{pid, startedAt}` 仍是自己的文件。
- **谁拉起 Host**：
  - 桌面（骨架默认）：主进程先读 `host.json` 并探活（连接 + hello），已有 Host 就**附着**；否则拉起 `wevir-host` 子进程并记下 `{pid, startedAt}`，视为**拥有**。退出时只停止自己拥有的 Host，附着的不停（Paseo A17）。
  - 桌面拉起的 Host 由桌面持有它的 stdin 管道；Host 读到 EOF（桌面正常退出或崩溃）就优雅退出，不留孤儿进程。
  - CLI：`wevir host start` 以分离方式启动 Host，不带归属管道，一直运行到 `wevir host stop`。桌面之后启动会附着到它，退出时不停止它。
- **停止**：`host.shutdown` RPC（需已完成 hello），各平台一致；POSIX 上 SIGINT / SIGTERM 同样触发优雅退出。Windows 上对其他进程 `process.kill(pid, 'SIGTERM')` 会直接终止目标进程（Node 文档 `process.kill` 与“Signal events”一节），来不及执行退出流程，所以 CLI 的 `wevir host stop` 走 RPC。
- **优雅退出顺序**（Paseo A18）：停止接受新连接 → 取消运行中的回合、未决审批结为 `cancelled` → 回收 dsh 进程树 → 刷写 SQLite → 关闭 WebSocket 连接 → 删除 `host.json`；整体超过 10 s 强制退出。
- **运行时**：骨架阶段只做开发模式，Host 与 dsh 都跑在开发者本机的 Node 上（≥ 22.19，`.node-version` 为 24），桌面主进程用这个 Node 启动工作区里的 Host。
- **为常驻 daemon 留路**：Host 不假设自己有父进程，所有“随桌面退出”的行为都只由归属管道触发；将来改为常驻时，只需让桌面不再持有管道并把“退出时停止 Host”做成设置项（Paseo D9 的 `keepRunningAfterQuit`）。

### 7. 客户端侧

- client-sdk 只依赖 `packages/protocol`，不 import Node 内置模块；WebSocket 由调用方注入，传输层是可替换接口；读取 `host.json` 的功能放在单独的 Node 入口（Paseo A21）。
- 桌面渲染进程不读 `host.json`：主进程读出 `{url, token}`，经 preload 的 `getHostConnection()` 交给渲染进程，渲染进程只放在内存里（T5.1）。

## 备选方案

| 方案 | 结论 | 原因 |
|---|---|---|
| 令牌放 `Authorization: Bearer` 头 | 不采纳 | 浏览器与 Electron 渲染进程的 WebSocket API 设不了请求头；Paseo 也已把 Bearer 头降为兼容路径 |
| 令牌放 URL 查询串或 WebSocket 子协议 | 不采纳 | 查询串容易进日志；子协议是借用字段，语义不清 |
| loopback 上不鉴权（Paseo 默认） | 不采纳 | loopback 对本机其他用户和任何网页都可达（Paseo `SECURITY.md` 自己承认） |
| 固定端口（Paseo 默认 6767） | 不采纳 | 端口冲突时只能失败；不同数据目录的 Host 不能并存；随机端口 + 运行时文件已足够发现 |
| Unix socket / 命名管道 | 推迟 | 渲染进程连不上，需要主进程转发；常驻 daemon 阶段再评估（Paseo D9） |
| Host 跑在 Electron 主进程里（OpenWork 的 embedded server） | 不采纳 | Host 崩溃会拖垮桌面；CLI 与将来的手机端需要不依赖桌面的 Host |
| 现在就做 supervisor + worker 双进程 | 推迟 | 为常驻 daemon 与自更新准备，骨架用不上（Paseo D9） |
| 自定义 `type` 信封、`.request/.response` 后缀（Paseo N1） | 不采纳 | JSON-RPC 2.0 已提供请求关联、错误对象和通知 |
| 运行中收到新消息默认“中断并替换”（Paseo N12） | 不采纳 | 骨架用 `session_busy`；“中断并替换”“插入当前回合”以后作为显式选项再加 |

## 后果

- Host 可以完全脱离桌面测试，Gate M2、M4 都不需要 Electron。
- 信任边界是操作系统用户：任何以同一用户运行的进程都能读 `host.json` 拿到令牌（与 Paseo 的本地凭据相同）。Windows 上 0600 不生效，依赖 `%APPDATA%` 的按用户 ACL（ADR-0003 同样处理）。这一点写进 T6.1 的安全说明。
- 渲染进程持有令牌，渲染进程被攻破等于拿到 Host 全部权限；对策是 T5.1 的 `sandbox: true`、严格 CSP、禁止任意导航。
- 协议方法 v0 在计划 §6 T1.2 的列表之外新增 `host.ping` 与 `host.shutdown`，事件新增 `approval.resolved`；错误码新增 `session_busy`、`already_decided`、`client_message_conflict` 一类（命名由 T1.2 统一）。
- 随机端口意味着本机之外的客户端没法直接发现 Host；手机端走中继，届时另写 ADR。

## 未决事项

1. **打包后 Host 与 dsh 跑在哪个 Node 上**：可选 (a) Electron 自带的 Node（`ELECTRON_RUN_AS_NODE=1`，Paseo 的做法；dsh 的原生模块 `node-pty`、`koffi` 要按 Electron 的 ABI 处理），(b) 随安装包附带一个独立 Node（没有 ABI 问题，安装包变大），(c) Electron `utilityProcess`（同样是 Electron 的 Node，且把 Host 的生命周期绑到 Electron 上）。骨架只做开发模式，留给打包阶段决定。ADR-0003 选的 `node:sqlite` 在 (b) 下没有问题；(a)(c) 取决于 Electron 内置的 Node 是否提供 `node:sqlite`（Electron 40 起内置 Node 24.x，尚未实测，见 ADR-0003 未决事项）。
2. **常驻 daemon**（桌面关闭后继续运行、开机自启）：移动端阶段决定（Paseo D9）。
3. **设备凭据与配对**：骨架只预留 `deviceId`、`clientId` 与 `permissions`；一次性邀请、按设备凭据、设备撤销在移动端阶段另写 ADR（Paseo D2、D3）。

## 补记

1. **2026-10-12，T1.2：能力门控不扣下事件。** 决策 2 写的是“不支持就降级或不发”，决策 3 又要求客户端把 `seq` 的空洞当作缺口重新订阅；Host 若因为某个连接缺少能力位而不发某条事件，这个连接就会在同一位置反复误判缺口。定稿为：订阅内 `seq` 连续，Host 不扣下任何事件；能力位只用来降级已知事件类型里的新枚举值或新形状；全新的事件类型直接发送，客户端从 v0 起必须忽略不认识的 `type` 并照常推进 `lastSeq`。`engine.raw` 因此也不门控。详见 [host-api.md](../architecture/host-api.md) §4、§10。
2. **2026-10-12，T1.2：错误码与关闭码定稿。** 决策 2 与“后果”里的 `unauthorized`、`incompatible_protocol`、`session_busy`、`already_decided`、`client_message_conflict` 一类名称定稿为 `UNAUTHORIZED`、`INCOMPATIBLE_PROTOCOL`、`SESSION_BUSY`、`ALREADY_DECIDED`、`CLIENT_MESSAGE_CONFLICT` 等，数值与关闭码见 [host-api.md](../architecture/host-api.md) §7、§8。
3. **2026-10-13，T2.5：进程入口的实现细节。** 决策 6 没有写到、由 T2.5 定下的部分（代码在 `packages/host/src/{cli,host-process,runtime-file,home,logger}.ts`）：
   - **启动参数**：`wevir-host --home <目录> --adapter echo|dsh --port <端口> --log-level debug|info|warn|error --exit-on-stdin-eof`。`--adapter` 默认 `dsh`（未实现时以退出码 2 明确报错，开发用 `--adapter echo`）；归属管道参数定名为 `--exit-on-stdin-eof`，桌面拉起时带上并持有 stdin，CLI 的 `wevir host start` 不带。数据目录 `WEVIR_HOME` > `--home` > 平台默认（Linux 为 `$XDG_DATA_HOME/wevir`，未设时 `~/.local/share/wevir`）。
   - **数据目录布局**：`wevir.db`（ADR-0003）、`secrets.json`、`host-id`（`hostId`，首次启动生成，跨重启不变，host-api.md §2）、`run/host.json`、`logs/host.log`；T3.1 再加 `engines/dsh`（`DSH_HOME`）与 `engines/dsh-agents`（`DSH_AGENTS_HOME`，ADR-0001 补记 1）。
   - **`host.json` 的两阶段**：排他创建的占位只有 `pid`、`startedAt`、`protocolVersion`、`hostVersion`，监听就绪后整体原子替换成带 `url` 与 `token` 的完整内容；客户端读到没有 `url` 的文件按“正在启动”处理。占位在打开数据库之前创建，同一数据目录不会有两个 Host 同时迁移、写库。陈旧判定与 Paseo A13 相同：`kill(pid, 0)` 不存在、`startedAt` 早于本次开机（`Date.now() - os.uptime()`，5 s 容差）、或 PID 就是自己，任一成立即陈旧；删除前再读一遍确认仍是同一个文件。重读后仍为空的文件视为创建者写入前就退出，回收；内容无法解析时拒绝启动、不擅自删除。
   - **就绪通知与退出码**：就绪后向 stdout 写一行 `{"event":"ready","pid","url","hostId","home"}`（不含令牌），拉起方可以据此知道何时读 `host.json`。退出码：0 正常退出；1 启动失败、致命错误或退出超时被强制结束；2 参数错误（含 dsh 未实现）；3 该数据目录已有活着的 Host（读 `host.json` 附着即可）。
   - **退出细节**：“停止接受新连接”一步同时让已连上的客户端的新请求回 `HOST_SHUTTING_DOWN`，并等在途请求与订阅补发结束（上限 5 s）；已 hello 的连接保留到“关闭 WebSocket 连接”一步，取消回合写下的事件因此能推送给订阅者。取消回合时未决审批的结算原因是 `host_shutdown`（domain-model §5 第 5 条）。退出期间再收到 SIGINT / SIGTERM、或整体超过 10 s，删除自己的 `host.json` 后以退出码 1 强制结束。可能卡住的三步（停止接受新连接时等在途请求、取消回合、dispose 适配器）共用 7 s 预算（`SHUTDOWN_BUDGET_MS`），超出的那一步记 `shutdown step timed out` 后跳过：取消回合超时则先让会话管理器停止写事件，会话停在活动状态，由下次启动的对账（#15）收尾；刷写 SQLite、关闭连接（自带 2 s 关闭握手时限）、删除 `host.json` 照常执行，所以引擎卡住也不会留下没关的数据库和陈旧的 `host.json`。10 s 硬上限只是兜底。适配器 `dispose` 被跳过或 Host 被强杀时，引擎进程树靠 dsh 自己读到 stdin EOF 退出，T3.1 负责保证并验收这一点（含 dsh 拉起的工具子进程）。
   - **日志**：JSON 行追加写到 `logs/host.log`（目录 0700、文件 0600，骨架阶段不轮转），stderr 是终端时同时镜像一份（`pnpm dev:host`）；被拉起、stderr 是管道时不写 stderr，避免拉起方不读时阻塞。字段名像令牌、密钥、密码、API Key、凭据、Authorization、Cookie 的整体替换为 `[REDACTED]`，本次启动的令牌在任何字符串里出现都替换。

4. **2026-10-13，T4.1：client-sdk 的实现细节。** 决策 5、7 没有写到、由 T4.1 定下的部分（代码在 `packages/client-sdk`）：
   - **端点**：`WevirClient.connect({endpoint})` 的端点可以是固定的 `{url, token}`，也可以是每次连接尝试前调用一次的解析函数。Host 重启会换端口和令牌，要跨 Host 重启自动重连就给解析函数：Node 入口 `@wevir/client-sdk/node` 的 `connectLocalHost({home})` 每次重读 `run/host.json`（文件不存在、还没写入 `url` 都报 `HostUnavailableError`，按普通退避重试）；桌面渲染进程每次向主进程要（T5.1）。首次连接失败不重试，直接以该错误 reject，CLI 据此报“Host 没有运行”。
   - **超时与退避**的默认值见 [host-api.md](../architecture/host-api.md) §12。心跳超时按“多久没收到任何一帧”计，到时放弃连接、不等关闭握手。
   - **握手失败**：`INCOMPATIBLE_PROTOCOL` 与 hello 参数、结果不合 schema 不可恢复，客户端进入 `closed`；`UNAUTHORIZED` 在端点固定时同样 `closed`（host-api.md §8），有解析函数时按慢速退避重试（OpenWork 的做法：本地服务重启时也会短暂出现鉴权失败）。
   - **请求**：按方法注册表类型安全地调用，结果按 result schema 解析（剥离未知字段），JSON-RPC 错误映射为 `WevirRpcError`（按错误码名收窄，`data` 按 `ErrorDataSchemas` 解析）。断线期间发起的请求排队等连接，等待计入请求超时；已发出、未响应就断线的请求以 `ConnectionLostError` 结束，不自动重发。
   - **订阅**：`subscribe()` 返回异步迭代器，产出事件、一次 `caught_up`（回放结束；`reset` 之后再一次）与 `reset`（本地 `seq` 比 Host 新）。断线重连、缺口补订对上层透明；细则见 host-api.md §4。
   - **能力与功能**：`DEFAULT_CLIENT_CAPABILITIES` 以 `satisfies Record<ClientCapability, true>` 穷举 protocol 的能力位，CLI 与桌面继承；功能只经 `client.supports()` / `requireFeature()` 判断。
   - **运行环境**：浏览器入口只依赖 `@wevir/protocol`。三道保证：`tsconfig.browser.json` 在没有 Node 类型的环境里再检查一遍浏览器入口能到达的源码；Biome 对这些源码开 `noNodejsModules`；`build-output.test.ts` 用 tsdown 构建并扫描 `dist/index.js` 能到达的文件。WebSocket 经 `webSocketTransport(WebSocket)` 注入，浏览器、Node ≥ 22 的全局 `WebSocket` 与 `ws` 都可以。
   - **重连状态机**改写自 OpenWork `sync-stream-lifecycle.ts`（候选 #1），登记在 [UPSTREAM.md](../upstream/UPSTREAM.md) §4。

5. **2026-10-13，T5.1：桌面端拉起 / 附着 Host 的实现细节。** 决策 1、6、7 没有写到、由 T5.1 定下的部分（代码在 `apps/desktop/src/main/{host-lifecycle,index,identity,renderer-files}.ts`）：
   - **Origin 白名单**：`wevir://app`（构建产物经特权自定义协议 `wevir` 加载，standard、secure；不用 `file://`）与 `http://localhost:5199`（electron-vite 开发服务器，`strictPort`）。值定义在 `@wevir/protocol` 的 `DESKTOP_RENDERER_ORIGINS`，`startHost` 传给 `HostRpcServer`；桌面端的 `src/shared/renderer-origin.ts` 由测试核对与它一致；表在 [host-api.md](../architecture/host-api.md) §1。开发服务器的 origin 一直在白名单里，Host 不区分开发与正式；鉴权仍靠令牌。
   - **发现与拉起**（`HostLifecycle`，不依赖 Electron，对着真实 wevir-host 测试）：读 `run/host.json`，有 `url` 就连接 + hello 探活（3 s），成功即附着；没有文件、只有占位、探活失败都去拉起。拉起用开发者本机的 Node（`WEVIR_NODE`，否则 `PATH` 里的 `node`；Electron 的 `process.execPath` 是 Electron 自己）运行 `@wevir/host` 的 `bin['wevir-host']`，参数 `--home <数据目录> --exit-on-stdin-eof`，环境去掉 `ELECTRON_*`，并把 `WEVIR_HOME` 设成同一个数据目录（它优先于 `--home`）。轮询 host.json，收到 stdout 的就绪行时立即重读；`pid` 是这个子进程且有 `url` 才算就绪，记下 `{pid, startedAt}` 视为拥有。退出码 3 时改为等 host.json 出现地址并探活成功后附着。总时限 30 s，超时强制结束子进程。启动只尝试一次：失败原因经 `getHostConnection` 交给渲染进程显示；Host 中途退出后重新拉起留给 T5.5。
   - **退出**：桌面端关掉窗口就退出（macOS 也一样，骨架没有托盘）。`before-quit` 里先停 Host 再真正退出：附着的不动；拥有的先关归属管道，5 s 内没退出就确认 host.json 的 `{pid, startedAt}` 仍是它、发 `host.shutdown`，再等 12 s（Host 自己的上限是 10 s）仍没退出才 SIGKILL。桌面主进程被强杀时由操作系统关闭管道，Host 读到 EOF 照常优雅退出。
   - **连接信息**：preload 的 `getHostConnection()` 返回 `{url, token, identity}`，主进程等 Host 就绪后每次重读 host.json，所以附着的 Host 被别人重启后，client-sdk 的重连能拿到新端点（补记 4）。`identity` 是 hello 要的身份：`device-id` 与 CLI 共用，桌面的 `clientId` 存在数据目录的 `desktop-client-id`。
   - **数据目录与单实例**：桌面端与 Host、CLI 用同一个数据目录（`WEVIR_HOME` > 平台默认）。Electron 默认的 `userData` 在 macOS 上正好是 `~/Library/Application Support/Wevir`，与 Host 的数据目录重合，所以改到 `<数据目录>/desktop/`；`requestSingleInstanceLock` 也按它，同一数据目录只开一个桌面端。
   - **安全基线**：`contextIsolation`、`sandbox`（并 `app.enableSandbox()`）、关 `nodeIntegration` 与 `webviewTag`；所有 webContents 拒绝新窗口、只允许同 origin 的导航（开发服务器的整页刷新），http / https / mailto 交给 `shell.openExternal`；权限请求一律拒绝；IPC 只接受主窗口主框架、且 origin 是渲染进程 origin 的调用。CSP 以响应头下发：构建产物 `default-src 'none'; script-src 'self'; style-src 'self'; connect-src ws://127.0.0.1:*` 等；开发服务器用 Vite 的 `html.cspNonce` 给 React Fast Refresh 的内联引导脚本与注入的样式带上每次启动随机的 nonce，同样不用 `'unsafe-inline'` / `'unsafe-eval'`，另放行 HMR 的 WebSocket。Chrome 远程调试端口只在开发模式（未打包且有开发服务器地址）开启，默认 9339（`WEVIR_DESKTOP_DEBUG_PORT`），只监听 127.0.0.1。
