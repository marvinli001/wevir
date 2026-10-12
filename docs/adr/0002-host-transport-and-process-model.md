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
