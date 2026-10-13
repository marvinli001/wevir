# Wevir Host API v0

> 状态：v0（T1.2）· 协议版本 `0.3.0`（T3.5：会话恢复的 `session.resumed`、引擎会话丢失后的只读；最低兼容 `0.1.0`）· 日期：2026-10-13
> 依据：[ADR-0002](../adr/0002-host-transport-and-process-model.md)（协议部分以它为准）；[领域模型](./domain-model.md)；[Paseo 研读](../research/paseo-notes.md) §2（兼容纪律的出处）
> 代码：`packages/protocol`。方法注册表 `MethodSchemas`、通知注册表 `NotificationSchemas`、事件 `EventPayloadSchemas`、错误码 `ErrorCode`、关闭码 `CloseCode` 是唯一的定义；本文件的表格由 `host-api-doc.test.ts` 与代码逐项比对，改一边不改另一边测试就失败。
> 下游：T2.4（Host 侧执行）、T4.1（client-sdk）、T5.1（Origin 白名单写回本文件）

本文件定稿了领域模型里标为“草案”的错误码名（§9），以后以本文件为准。实体与事件 payload 的字段含义不在这里重复，见领域模型 §3、§6。

---

## 1. 传输

- JSON-RPC 2.0 over WebSocket，文本帧，一帧一个 JSON-RPC 对象（ADR-0002 §1）。**v0 不支持批量**：收到 JSON 数组时 Host 回一个 `INVALID_REQUEST`（`id: null`）；二进制帧同样回 `INVALID_REQUEST`（`id: null`）。
- 参数一律按名称传（对象）；方法没有参数时传 `{}`，省略 `params` 等同于 `{}`。请求 `id` 用字符串或整数，不用 `null`。
- 客户端只发请求；Host 只发响应和通知（v0 只有 `events.event`）。同一连接上可以连发多个请求，响应顺序不保证与请求一致，按 `id` 对应；同一会话的命令在 Host 内串行执行（ADR-0002 §4）。
- 端点 URL 与令牌从 `<数据目录>/run/host.json` 读取，客户端不自己拼地址、不回退到默认端口。WebSocket 升级时 Host 校验 `Host` 头（只允许 `127.0.0.1:<port>` 与 `localhost:<port>`，缺失也拒绝）与 `Origin`（不带 Origin 的放行，带 Origin 的只放行白名单），不通过直接 403，不会走到 JSON-RPC 层（白名单的具体值由 T5.1 写进本节；在此之前白名单为空）。Host 优雅退出期间的升级请求回 503，不是升级的 HTTP 请求回 426。
- `run/host.json`（T2.5）：`{pid, startedAt, protocolVersion, hostVersion, url, token}`，`run/` 目录 0700、文件 0600。Host 启动时先排他创建不含 `url`、`token` 的占位，监听就绪后整体原子替换；读到没有 `url` 的文件说明 Host 正在启动，稍后重读。`{pid, startedAt}` 认定“同一个 Host”。Host 正常退出时删除它；进程被杀留下的文件由下一个 Host 判定陈旧后回收。令牌每次启动重新生成，Host 重启后用旧令牌 hello 得到 `UNAUTHORIZED`，客户端应重新读取 `host.json`。进程入口 `wevir-host` 的参数、退出码与数据目录布局见 ADR-0002 补记 3。

## 2. 握手：`host.hello`

连接上的第一个请求必须是 `host.hello`，15 s 内完成（§12）。hello 之前 Host 不发任何东西。

```jsonc
// → 客户端
{"jsonrpc":"2.0","id":1,"method":"host.hello","params":{
  "token":"<run/host.json 里的 token>","protocolVersion":"0.1.0","clientKind":"cli",
  "deviceId":"dev-6f1c2a","clientId":"cli-3e9b70","capabilities":{}}}
// ← Host
{"jsonrpc":"2.0","id":1,"result":{
  "hostId":"hst_01JA2B3C4D5E6F7G8H9JKMNPQR","hostVersion":"0.1.0",
  "protocolVersion":"0.1.0","minProtocolVersion":"0.1.0","features":{},
  "permissions":["host.manage","workspace.read","workspace.write","provider.read","provider.write","session.read","session.write"]}}
```

- `clientKind`：`desktop`、`cli`；`mobile` 预留，骨架不出现。`deviceId` 是设备级标识；`clientId` 每个安装持久，同一台设备上的桌面与 CLI 不同。二者与 `clientKind` 组成该连接的 `ClientIdentity`，写进 `user.message.sentBy` 与 `approval.resolved` 的 `decidedBy`。
- `hostId`：每个数据目录一个，跨 Host 重启不变，客户端据此认出“同一个 Host”。
- `permissions`：骨架阶段恒为权限词表全部（`PERMISSIONS`），为设备权限预留；每个方法需要的权限见 §3。
- `capabilities` / `features`：见 §10。v0 是基线，两张表都为空。

**Host 的检查顺序与失败处理**：每种失败都先回 JSON-RPC 错误（`id` 取该请求的 `id`，取不到时为 `null`），再以对应关闭码关闭连接（§8）。

| 顺序 | 检查 | 错误 | 关闭码 |
|---|---|---|---|
| 1 | 帧是合法 JSON、是 JSON-RPC 请求 | `PARSE_ERROR` / `INVALID_REQUEST` | `HELLO_REQUIRED` |
| 2 | 方法是 `host.hello` | `HELLO_REQUIRED` | `HELLO_REQUIRED` |
| 3 | `params.protocolVersion` 主版本相同且不低于 `minProtocolVersion` | `INCOMPATIBLE_PROTOCOL` | `INCOMPATIBLE_PROTOCOL` |
| 4 | 其余参数符合 schema | `INVALID_PARAMS` | `HELLO_REQUIRED` |
| 5 | 令牌正确（常量时间比较） | `UNAUTHORIZED` | `UNAUTHORIZED` |

版本检查排在完整 schema 校验之前：别的主版本的客户端，hello 的形状可能已经不同，也应该拿到“请升级”而不是“参数错误”。`INCOMPATIBLE_PROTOCOL` 的 `data` 因此会在验证令牌之前暴露 `hostVersion`；Host 只监听 loopback，这点信息换来明确的升级提示。

```jsonc
// ← Host（客户端发来 "protocolVersion":"1.0.0"）
{"jsonrpc":"2.0","id":1,"error":{"code":-32002,"message":"incompatible protocol version 1.0.0",
  "data":{"hostVersion":"0.1.0","protocolVersion":"0.1.0","minProtocolVersion":"0.1.0"}}}
// 随后 WebSocket 以 4003 关闭
```

hello 成功后再发 `host.hello`，回 `INVALID_REQUEST`，连接不关。

## 3. 方法

`权限` 列是该方法需要的权限（`null` = 不需要）；所有方法（`host.hello` 除外）都要求本连接已完成 hello，否则回 `HELLO_REQUIRED` 并以 `HELLO_REQUIRED` 关闭。`错误` 列只列方法特有的错误；任何方法都可能回 `INVALID_PARAMS`、`INTERNAL_ERROR`、`HOST_SHUTTING_DOWN`。

<!-- registry:methods -->
| 方法 | 权限 | params | result | 错误 |
|---|---|---|---|---|
| `host.hello` | null | `token, protocolVersion, clientKind, deviceId, clientId, capabilities` | `hostId, hostVersion, protocolVersion, minProtocolVersion, features, permissions` | §2 |
| `host.ping` | null | `{}` | `{}` | |
| `host.shutdown` | `host.manage` | `{}` | `{}` | |
| `workspace.list` | `workspace.read` | `{}` | `workspaces: Workspace[]` | |
| `workspace.add` | `workspace.write` | `rootPath, displayName?` | `workspace, created` | `WORKSPACE_PATH_INVALID` |
| `workspace.remove` | `workspace.write` | `workspaceId` | `{}` | `WORKSPACE_NOT_FOUND`、`RESOURCE_IN_USE` |
| `provider.list` | `provider.read` | `{}` | `providers: ProviderProfile[]` | |
| `provider.upsert` | `provider.write` | 按 `kind` 区分，见下 | `provider, created` | |
| `provider.remove` | `provider.write` | `providerId` | `{}` | `PROVIDER_NOT_FOUND`、`RESOURCE_IN_USE` |
| `provider.test` | `provider.write` | `providerId, modelId?` | `ok, latencyMs?, error?, reason?, httpStatus?` | `PROVIDER_NOT_FOUND` |
| `session.create` | `session.write` | `workspaceId, providerId, modelId?, reasoningEffort?` | `session` | `WORKSPACE_NOT_FOUND`、`PROVIDER_NOT_FOUND`、`WORKSPACE_PATH_INVALID`、`ENGINE_ERROR` |
| `session.list` | `session.read` | `workspaceId?` | `sessions: Session[]` | `WORKSPACE_NOT_FOUND` |
| `session.get` | `session.read` | `sessionId` | `SessionSnapshot` | `SESSION_NOT_FOUND` |
| `session.send` | `session.write` | `sessionId, content, clientMessageId?` | `turnId, seq` | `SESSION_NOT_FOUND`、`SESSION_BUSY`、`INVALID_STATE`、`CLIENT_MESSAGE_CONFLICT`、`WORKSPACE_PATH_INVALID`、`ENGINE_ERROR` |
| `session.cancel` | `session.write` | `sessionId` | `{}` | `SESSION_NOT_FOUND` |
| `session.close` | `session.write` | `sessionId` | `{}` | `SESSION_NOT_FOUND` |
| `session.resume` | `session.write` | `sessionId` | `session` | `SESSION_NOT_FOUND`、`PROVIDER_NOT_FOUND`、`WORKSPACE_PATH_INVALID`、`ENGINE_ERROR` |
| `approval.respond` | `session.write` | `approvalId, optionId` | `approvalId, status, resolution` | `APPROVAL_NOT_FOUND`、`ALREADY_DECIDED` |
| `events.subscribe` | `session.read` | `sessionId, sinceSeq` | `subscriptionId, replayedThroughSeq` | `SESSION_NOT_FOUND` |
| `events.unsubscribe` | `session.read` | `subscriptionId` | `{}` | |

Host → 客户端的通知：

<!-- registry:notifications -->
| 通知 | params |
|---|---|
| `events.event` | `subscriptionId, event: WevirEvent` |

### 3.1 各方法要点

- **`host.ping`**：心跳（§12），任何时候都可以发。
- **`host.shutdown`**：Host 先回 `{}`，再按 ADR-0002 §6 的顺序优雅退出，最后以 `GOING_AWAY` 关闭所有连接。退出期间到达的请求回 `HOST_SHUTTING_DOWN`。
- **`workspace.add`**：`rootPath` 必须是绝对路径、存在、是目录，否则 `WORKSPACE_PATH_INVALID`（`data.reason` 为 `not_absolute` / `not_found` / `not_directory` / `not_accessible`）。Host 取 realpath 去重：已有同一 realpath 的工作区（含曾被移除的）时返回它，`created: false`。
- **`workspace.remove`**：只注销，不删磁盘文件；有未关闭会话时回 `RESOURCE_IN_USE`，`data.sessionIds` 列出这些会话。
- **`provider.upsert`**：参数按 `kind` 判别。`deepseek-official` 的 `id` 固定为 `deepseek-official`；`openai-compatible` 必须给 `api`、`baseURL`（http / https，允许 localhost 与 IP）和至少一个模型。语义是整体替换非密钥字段，不是合并；`id` 不存在时新建（`created: true`）。`kind` 创建后不可改，改了回 `INVALID_PARAMS`；`defaultModelId` 不在 `models` 里（`openai-compatible`）同样回 `INVALID_PARAMS`。`apiKey`：省略 = 保留已存的 Key，字符串 = 设置或替换，`null` = 删除。**Key 只进 SecretStore，Host 不得把它写进日志、事件或任何响应**；响应里只有 `hasSecret`。写库前 Host 让引擎适配器检查配置（`validateProvider`），引擎不接受时回 `INVALID_PARAMS`（`data.issues` 是适配器给的字段路径与说明，例如 `anthropic-messages` 暂不支持、compat 开关与协议不匹配），不写库。写库后 Host 把全部 Provider 交给引擎；引擎没能用上新配置时回 `ENGINE_ERROR`，但 Profile 已保存（`provider.remove` 同样）。新配置何时对运行中的会话生效见 [providers.md](./providers.md) §5。
- **`provider.remove`**：同时删除 Key。被未关闭会话引用时回 `RESOURCE_IN_USE`。
- **`provider.test`**：用该 Provider 发一次最小请求（带已存的 Key）。连通与否放在结果里（`ok`、`error.category` / `error.message`），不作为 JSON-RPC 错误；只有 Provider 不存在才回错误。0.2.0 起失败时另有 `reason`（`missing_key` / `network` / `timeout` / `auth` / `model_not_found` / `protocol` / `rate_limited` / `server` / `unknown`）与收到的 `httpStatus`，归类规则见 [providers.md](./providers.md) §6。
- **`session.create`**：`modelId` 省略时用 Provider 的 `defaultModelId`。Host 先建引擎会话，成功后才写 `session.created`（`seq = 1`），返回的 `session.state` 为 `idle`、`lastSeq` 为 1。引擎失败回 `ENGINE_ERROR`，不建会话。
- **`session.list`**：按 `updatedAt` 从新到旧；省略 `workspaceId` 时列出所有未移除工作区的会话。
- **`session.get`**：返回由事件推导的快照 `{session: {state, activeTurn, lastSeq, …}, pendingApprovals, todos?, usage?}`（ADR-0002 §3）。中途加入的客户端先取快照，再以 `sinceSeq = session.lastSeq` 订阅。
- **`session.send`**：会话是 `running` / `awaiting_approval` / `cancelling` 时回 `SESSION_BUSY`（`data` 带 `state` 与 `activeTurn`），不排队、不打断；`error` / `closed` 时回 `INVALID_STATE`（`data.state`），先 `session.resume`。`idle` 时接受，结果是新回合的 `turnId` 和这次 `user.message` 的 `seq`。`clientMessageId` 是幂等键，检查排在状态检查之前：同一会话里同一 ID、同样的 `content` 重发，返回原结果，不再发给引擎（不论会话现在处于什么状态，也不论那个回合后来怎样）；同一 ID、不同 `content` 回 `CLIENT_MESSAGE_CONFLICT`。send 前的自动 resume 失败回 `ENGINE_ERROR`（`category: session_unavailable`），工作区目录已不存在回 `WORKSPACE_PATH_INVALID`（不调引擎、状态不变）。会话只读（0.3.0，`session.readOnly`，引擎会话恢复不了）时回 `INVALID_STATE`，`data.readOnly` 给出原因与引擎原文，客户端据此提示“基于历史新建会话”，不要再提示 resume。Host 接受之后引擎拒收（适配器调用失败）时仍返回本回合的 `turnId` 与 `seq`：消息已被 Host 接受，失败经 `engine.error` 与 `session.state_changed`（→ `error`）送达，重发同一 `clientMessageId` 也返回这个结果（领域模型 §4.3）。
- **`session.cancel`**：幂等，非活动状态下成功、无操作（领域模型 §4.2）。Host 等到回合结算（`turn.finished` 已写入），或判定无法确认（会话转 `error`，取消时限 5 s）才返回；结算细节以事件为准。
- **`session.close`**：活动中的会话先取消再关闭（领域模型 §4.1 #14）；已关闭时成功、无操作。
- **`session.resume`**：`error` / `closed` 时恢复为 `idle`，其余状态成功、无操作；返回最新的 `session`。成功时先写 `session.resumed`（0.3.0，带引擎版本），引擎不回放历史，历史以事件库为准。Provider 已被删除回 `PROVIDER_NOT_FOUND`；工作区目录已不存在回 `WORKSPACE_PATH_INVALID`（不写事件）；引擎拒绝回 `ENGINE_ERROR`（同时追加一条 `engine.error` 事件，状态不变）。引擎会话恢复不了（会话日志被删除、格式不兼容或损坏）时另写 `session.read_only`，会话带上 `readOnly`；只读会话仍可以 resume，引擎找回会话时成功并解除只读（领域模型 §4.4）。
- **`approval.respond`**：`optionId` 必须是该审批 `options` 里的一个，否则 `INVALID_PARAMS`，审批不变。首个决定生效；审批已不是 `pending` 时回 `ALREADY_DECIDED`，`data` 带既有的 `status` 与 `resolution`（领域模型 §5）。提交给引擎失败时会话转 `error`，审批结为 `cancelled`（`engine_exited`），同样回 `ALREADY_DECIDED`（领域模型 §4.3）。
- **`events.subscribe` / `events.unsubscribe`**：见 §4。`events.unsubscribe` 对不存在或已释放的 `subscriptionId` 成功、无操作。

### 3.2 示例

会话忙：

```jsonc
// →
{"jsonrpc":"2.0","id":7,"method":"session.send","params":{
  "sessionId":"ses_01JA2B3C4D5E6F7G8H9JKMNPQR","content":[{"type":"text","text":"继续"}],"clientMessageId":"msg-2"}}
// ←
{"jsonrpc":"2.0","id":7,"error":{"code":-32021,"message":"session is busy","data":{
  "state":"running","activeTurn":{"turnId":"trn_01JA2B3C4D5E6F7G8H9JKMNPQR","startedAt":"2026-10-12T08:00:00.000Z"}}}}
```

两端同时审批，后到者：

```jsonc
// → 桌面
{"jsonrpc":"2.0","id":12,"method":"approval.respond","params":{"approvalId":"apr_01JA2B3C4D5E6F7G8H9JKMNPQR","optionId":"reject-once"}}
// ← （CLI 已先批准）
{"jsonrpc":"2.0","id":12,"error":{"code":-32022,"message":"approval already decided","data":{
  "approvalId":"apr_01JA2B3C4D5E6F7G8H9JKMNPQR","status":"approved",
  "resolution":{"reason":"user","optionId":"allow-once","decidedBy":{"deviceId":"dev-6f1c2a","clientId":"cli-3e9b70","clientKind":"cli"}}}}}
```

未知方法（新客户端连到旧 Host）：

```jsonc
// →
{"jsonrpc":"2.0","id":30,"method":"session.rename","params":{"sessionId":"ses_01JA2B3C4D5E6F7G8H9JKMNPQR","title":"周报"}}
// ←
{"jsonrpc":"2.0","id":30,"error":{"code":-32601,"message":"Method not found: session.rename",
  "data":{"hostVersion":"0.1.0","hint":"请升级 Wevir Host"}}}
```

## 4. 订阅语义

连接本身不推送会话数据，客户端用 `events.subscribe` 显式订阅（ADR-0002 §3）。

```jsonc
// → 客户端本地已应用到 seq 3
{"jsonrpc":"2.0","id":5,"method":"events.subscribe","params":{"sessionId":"ses_01JA2B3C4D5E6F7G8H9JKMNPQR","sinceSeq":3}}
// ← 订阅建立时会话的 lastSeq 是 5
{"jsonrpc":"2.0","id":5,"result":{"subscriptionId":"sub_01JA2B3C4D5E6F7G8H9JKMNPR0","replayedThroughSeq":5}}
// ← 补发 seq 4、5
{"jsonrpc":"2.0","method":"events.event","params":{"subscriptionId":"sub_01JA2B3C4D5E6F7G8H9JKMNPR0","event":{
  "seq":4,"sessionId":"ses_01JA2B3C4D5E6F7G8H9JKMNPQR","ts":"2026-10-12T08:00:01.000Z","type":"turn.started","source":"host",
  "payload":{"turnId":"trn_01JA2B3C4D5E6F7G8H9JKMNPQR"}}}}
{"jsonrpc":"2.0","method":"events.event","params":{"subscriptionId":"sub_01JA2B3C4D5E6F7G8H9JKMNPR0","event":{
  "seq":5,"sessionId":"ses_01JA2B3C4D5E6F7G8H9JKMNPQR","ts":"2026-10-12T08:00:01.000Z","type":"session.state_changed","source":"host",
  "payload":{"from":"idle","to":"running","reason":"turn_started"}}}}
// ← 已追平；之后是实时事件 seq 6、7 …
{"jsonrpc":"2.0","method":"events.event","params":{"subscriptionId":"sub_01JA2B3C4D5E6F7G8H9JKMNPR0","event":{
  "seq":6,"sessionId":"ses_01JA2B3C4D5E6F7G8H9JKMNPQR","ts":"2026-10-12T08:00:01.060Z","type":"assistant.delta","source":"engine",
  "payload":{"turnId":"trn_01JA2B3C4D5E6F7G8H9JKMNPQR","streamId":"stm_01JA2B3C4D5E6F7G8H9JKMNPQR","blockIndex":0,"kind":"text","text":"好的，"}}}}
```

**Host 的保证**：

1. **先补发后实时，不丢不重。** Host 在会话锁内记下当时的 `lastSeq`（= `replayedThroughSeq`）并登记订阅；之后按 `seq` 升序推送 `(sinceSeq, replayedThroughSeq]` 的历史，再推送 `seq > replayedThroughSeq` 的实时事件。事件的追加与订阅的登记在同一把锁下，所以每个 `seq` 在这个订阅上恰好出现一次。
2. **订阅结果先于它的事件。** `events.subscribe` 的响应帧在该订阅的第一条 `events.event` 之前发出，客户端收到事件时一定已经知道 `subscriptionId`。
3. **回放结束标记是 `replayedThroughSeq`。** 客户端应用到这个 `seq` 即追平（`sinceSeq >= replayedThroughSeq` 时一订阅就已追平）。回放不另发结束通知，分批发送对客户端透明。
4. **订阅内 `seq` 连续。** Host 不跳过任何事件，也不按能力位扣下事件（§10）。
5. 退订的响应发出后，该订阅不再有事件。连接断开时 Host 丢弃这条连接的全部订阅，不为断开的客户端保留状态；重连后客户端重新订阅，拿到新的 `subscriptionId`。
6. 同一连接可以对同一会话建多个订阅，各收一份。会话关闭不结束订阅（之后可能 resume）。

**客户端的规则**（client-sdk，T4.1）：

- 按 `seq` 应用：`seq == lastSeq + 1` 接受；`seq <= lastSeq` 是重复，丢弃；更大是缺口，退订后以 `sinceSeq = lastSeq` 重新订阅。
- 先用 `WevirEventEnvelopeSchema` 解析；`type` 不认识（`isKnownEventType` 为假）就忽略这条事件的内容，**但照常推进 `lastSeq`**。认识的再用 `WevirEventSchema` 解析。
- `sinceSeq > replayedThroughSeq` 说明客户端的缓存比 Host 还新（不应发生，例如数据目录被替换），丢弃本地缓存，以 `sinceSeq = 0` 重新订阅。
- 中途加入：`session.get` 取快照，再以 `sinceSeq = session.lastSeq` 订阅。

## 5. 事件类型

信封字段：`seq`（会话内从 1 开始连续递增）、`sessionId`、`ts`（Host 追加时间）、`type`、`source`（`host` / `engine`）、`payload`。各类型的 payload 字段、来源与触发时机见[领域模型](./domain-model.md) §6；代码在 `EventPayloadSchemas`。

<!-- registry:events -->
| `type` | `source` |
|---|---|
| `session.created` | host |
| `session.resumed` | host |
| `session.read_only` | host |
| `session.title_changed` | host |
| `session.state_changed` | host |
| `user.message` | host |
| `turn.started` | host |
| `turn.finished` | host |
| `assistant.delta` | engine |
| `assistant.stream_ended` | engine |
| `assistant.message` | engine |
| `assistant.thought` | engine |
| `tool.started` | engine |
| `tool.updated` | engine |
| `tool.finished` | engine / host |
| `todo.updated` | host |
| `approval.requested` | engine |
| `approval.resolved` | host |
| `usage.updated` | engine |
| `engine.error` | engine / host |
| `engine.raw` | engine |

`engine.raw` 不按能力位门控，所有订阅者都收到（门控意味着扣下事件，会打断 `seq` 的连续性，§4 第 4 条）；客户端默认不投影它，开发者模式下作为调试信息显示。它的 `params` 按 §11 截断。

## 6. ID

Host 生成的 ID 形如 `<前缀>_<ULID>`。ULID 是 26 位 Crockford Base32：48 位毫秒时间戳 + 80 位随机数，全局唯一，字典序大致对应创建时间（同一毫秒内不保证单调）。客户端把 ID 当不透明字符串，不解析内容；schema 只校验前缀与字符集（`[0-9A-Za-z]{1,64}`），以后换算法不算收窄。

| ID | 前缀 | 唯一范围 |
|---|---|---|
| `HostId` | `hst_` | 数据目录，跨重启不变 |
| `WorkspaceId` | `ws_` | Host |
| `SessionId` | `ses_` | Host |
| `TurnId` | `trn_` | Host |
| `ApprovalId` | `apr_` | Host |
| `StreamId` | `stm_` | Host |
| `SubscriptionId` | `sub_` | Host（只在建立它的连接上有效） |

`ProviderId` 由用户给出，`^[a-z][a-z0-9-]{0,31}$`。`deviceId`、`clientId`、`clientMessageId` 由客户端生成，1–128 个字符。时间字段是 `Date.prototype.toISOString()` 的输出（UTC、毫秒精度）。

## 7. 错误码

客户端按 `error.code` 的数值判断，`message` 只给人看，`data` 的形状见 `ErrorDataSchemas`（下表“data”列）。前五个是 JSON-RPC 2.0 标准码；Wevir 的错误放在规范留给实现方的 −32000…−32099 内，按段划分：−32000…−32009 连接与握手，−32010…−32019 对象不存在，−32020…−32039 状态与冲突，−32040…−32059 环境与引擎。

<!-- registry:errors -->
| 名称 | code | 含义 | data |
|---|---|---|---|
| `PARSE_ERROR` | -32700 | 帧不是合法 JSON | |
| `INVALID_REQUEST` | -32600 | 不是合法的 JSON-RPC 请求；批量请求；重复 hello | |
| `METHOD_NOT_FOUND` | -32601 | 未知方法，多半是 Host 比客户端旧 | `hostVersion, hint` |
| `INVALID_PARAMS` | -32602 | 参数不合 schema，或违反方法的跨字段规则 | `issues[{path, message}]` |
| `INTERNAL_ERROR` | -32603 | Host 内部错误 | |
| `UNAUTHORIZED` | -32001 | 令牌错误 | |
| `INCOMPATIBLE_PROTOCOL` | -32002 | 协议主版本不同或低于最低版本 | `hostVersion, protocolVersion, minProtocolVersion` |
| `HELLO_REQUIRED` | -32003 | 本连接还没完成 `host.hello` | |
| `HOST_SHUTTING_DOWN` | -32004 | Host 正在优雅退出 | |
| `WORKSPACE_NOT_FOUND` | -32010 | 工作区不存在或已移除 | |
| `PROVIDER_NOT_FOUND` | -32011 | Provider 不存在 | |
| `SESSION_NOT_FOUND` | -32012 | 会话不存在（含所属工作区已移除） | |
| `APPROVAL_NOT_FOUND` | -32013 | 审批不存在 | |
| `INVALID_STATE` | -32020 | 会话当前状态不允许该操作（`error` / `closed` 时 send） | `state, readOnly?` |
| `SESSION_BUSY` | -32021 | 会话有进行中的回合 | `state, activeTurn?` |
| `ALREADY_DECIDED` | -32022 | 审批已结算 | `approvalId, status, resolution` |
| `CLIENT_MESSAGE_CONFLICT` | -32023 | 同一 `clientMessageId` 的请求体不同 | `clientMessageId` |
| `RESOURCE_IN_USE` | -32024 | 被未关闭的会话引用，不能移除 | `sessionIds` |
| `WORKSPACE_PATH_INVALID` | -32040 | 工作区路径不可用 | `path, reason` |
| `ENGINE_ERROR` | -32041 | 引擎拒绝或失败（建会话、resume、send 前的自动 resume） | `category, message` |

已分配的数值不改、不复用；废弃的错误码在表里保留并注明。

## 8. 关闭码

1000–1015 是 RFC 6455 标准码，4000–4999 是应用私有码。凡是 Host 主动关闭且有对应请求的，先回 JSON-RPC 错误再关闭。

<!-- registry:close-codes -->
| 名称 | code | 何时 |
|---|---|---|
| `NORMAL` | 1000 | 正常关闭 |
| `GOING_AWAY` | 1001 | Host 优雅退出 |
| `HELLO_TIMEOUT` | 4001 | 15 s 内没有完成 hello |
| `HELLO_REQUIRED` | 4002 | 首个请求不是合法的 `host.hello`（帧不合法、方法不对、参数不合 schema），或 hello 之前调用了其他方法 |
| `INCOMPATIBLE_PROTOCOL` | 4003 | 协议版本不兼容 |
| `UNAUTHORIZED` | 4004 | 令牌错误 |
| `LEASE_EXPIRED` | 4005 | 超过租约没有收到任何消息 |
| `SEND_BUFFER_OVERFLOW` | 4006 | 这条连接的发送缓冲超限 |

客户端遇到 4003、4004 不要自动重连（重连也会失败），提示用户升级或重新读取 `host.json`；其余情况按退避重连。

## 9. 与领域模型草案的对应

领域模型 §4.2、§10 里的草案名在此定稿（领域模型已回写）：

| 草案 | 定稿 |
|---|---|
| `session_busy` | `SESSION_BUSY` |
| `session_inactive`（`error` / `closed` 时 send） | `INVALID_STATE`，`data.state` 告诉客户端需要先 resume |
| `already_decided` | `ALREADY_DECIDED` |
| `not_found`（审批） | `APPROVAL_NOT_FOUND`；其他对象各有自己的 `*_NOT_FOUND` |
| `unauthorized`、`incompatible_protocol`、`client_message_conflict`（ADR-0002） | `UNAUTHORIZED`、`INCOMPATIBLE_PROTOCOL`、`CLIENT_MESSAGE_CONFLICT` |

## 10. 兼容规则

依据 Paseo 的兼容纪律（Paseo 研读 §2.3、§2.4；ADR-0002 §2）。目标：半年前的客户端能连新 Host，半年前的 Host 能服务新客户端（同一主版本内）。改 `packages/protocol` 的提交要在说明里回答这两个问题。

**版本**

- `PROTOCOL_VERSION` 是 `主.次.修订` 三段的 semver，不带预发布标签。主版本不同即不兼容，Host 拒绝 hello；同一主版本内次版本只增不减、向后兼容；修订号只用于不改变线缆形状的修正。
- 版本历史：`0.1.0`（T1.2，基线）；`0.2.0`（T3.4）：`ProviderModel` 加 `maxTokens`、`supportsImages`、`reasoningEfforts`，`provider.test` 结果加 `reason`、`httpStatus`，全部 optional，`MIN_PROTOCOL_VERSION` 仍是 `0.1.0`。新 Host 服务 0.1.0 客户端：多出的字段被旧 schema 忽略（规则 5）；0.2.0 客户端连旧 Host：旧 Host 不发这些字段，客户端按 optional 处理。`0.3.0`（T3.5）：新事件类型 `session.resumed`、`session.read_only`，`session.created` 加 `engineVersion`，`Session` 加 `readOnly`，`INVALID_STATE` 的 `data` 加 `readOnly`，全部是新类型或 optional 字段，没有给已有类型加枚举值，不需要能力位；`session.send` 与 `session.resume` 可能多回 `WORKSPACE_PATH_INVALID`（已有错误码）。新 Host 服务旧客户端：旧客户端忽略两种新事件（规则 5，照常推进 `lastSeq`）与新字段，只读会话在它看来是普通的 `error`，send 回 `INVALID_STATE`、resume 回 `ENGINE_ERROR`；0.3.0 客户端连旧 Host：收不到这些事件与字段，按 optional 处理。
- 协商（`negotiateProtocolVersion`）：主版本相同且客户端不低于 `minProtocolVersion` 才接受，协商结果取双方中较低的版本。Host 提高 `minProtocolVersion` 等于放弃更老的客户端，要在变更说明里写明。

**线缆契约（永远遵守）**

1. **只增不减。** 方法、通知、事件类型、字段、枚举值、错误码都不删除；错误码与关闭码的数值不改、不复用。
2. **新字段一律 optional。** 不把 optional 改成必填。
3. **不收窄类型。** `string` 改成枚举、可空改成非空、放宽过的范围再收紧，都算收窄。
4. **不再发送的字段继续接受。** 字段退役时，schema 里保留它（optional），只是不再写。
5. **接收方忽略不认识的东西。** 对象 schema 用 `z.object`（剥离未知字段），旧端读到新字段时忽略；客户端读到不认识的事件 `type` 时忽略内容、照常推进 `lastSeq`（§4）。能力位、功能、权限都是开放集合（`looseObject` / 字符串数组），不会因为对方多了一项而解析失败。
6. **schema 只做结构声明。** 不用 `transform` / `preprocess` / `catch`，规范化放在校验之后的显式步骤里；共享 `type` 一类标签时用 `z.discriminatedUnion`；`default` 只放在原始类型的叶子上。`schemas.test.ts` 会遍历全部 schema 检查这一条。

**客户端能力位（`capabilities`）**

- 客户端在 hello 里声明自己能理解的新形状。Host 往客户端发**已知类型里的新枚举值或新形状**之前，先看这条连接的能力位，不支持就降级（例如新枚举值换成该字段的兜底值 `unknown`），能力属于连接、不跨连接借用。
- **事件不靠扣下来门控**：扣下事件会让订阅内的 `seq` 出现空洞（§4 第 4 条），客户端会误判为缺口。全新的事件类型直接发送，旧客户端按规则 5 忽略它。
- client-sdk 维护一份穷举的默认能力表（T4.1），CLI 与桌面继承。v0 是基线，`CLIENT_CAPABILITIES` 为空。

**Host 功能（`features`）**

- Host 在 hello 结果里声明功能，客户端只在一处判断：要么启用功能，要么提示用户升级 Host；功能内部不写降级路径、不到处加防御分支。v0 是基线，`HOST_FEATURES` 为空。

**`COMPAT` 标签**

每个兼容垫片（为旧端保留的分支、能力门控、退役但仍接受的字段）在要删除的位置写：

```ts
// COMPAT(name): added in 0.2.0, remove after 2027-06-01
```

`rg "COMPAT\("` 就是清理清单；不带标签的兼容代码会意外变成永久代码。

**冻结样本**

`packages/protocol/src/compat/<协议版本>.json` 是该版本发布时冻结的报文样本（方法的 params 与 result、通知、全部事件、带 data 的错误）。之后只新增文件、不修改旧文件；`compat.test.ts` 要求当前 schema 仍能解析所有旧样本，且旧样本里的方法、事件类型、错误码都还在。发布新的协议次版本时，加一份该版本的样本文件。

## 11. 工具输出截断上限

工具输出与引擎原始数据在**入库之前**截断（T2.2），回放与实时推送用的是同一份截断后的数据（ADR-0002 §3）。长度一律按 UTF-16 code unit（JS `string.length`）计，截断时不切开代理对。常量在 `limits.ts`。

| 对象 | 字段 | 规则 |
|---|---|---|
| 工具输出 | `tool.updated.output.text`、`tool.finished.output.text` | 超过 `TOOL_OUTPUT_MAX_LENGTH`（65536）时保留开头 32768 与结尾 32768，中间插入一行 `[… N chars truncated …]`；`truncated: true`，`originalLength` 为截断前长度 |
| JSON 值 | `tool.started.input`、`tool.updated.input`、`approval.requested` 的 `detail.input`、`engine.raw.params` | 先把其中每个超过 `JSON_STRING_MAX_LENGTH`（16384）的字符串截成开头 16384，并追加 `…[+N chars]`；之后整个值 `JSON.stringify` 仍超过 `JSON_VALUE_MAX_LENGTH`（131072）时，整体换成 `TruncatedJson`：`{"$truncated": true, "originalLength": N, "preview": "<原 JSON 文本开头 JSON_PREVIEW_LENGTH（4096）>"}` |
| 不截断 | `assistant.*`、`user.message`、`todo.updated` | 这些是对话内容本身；单条事件可能较大，不影响连接健康的判断 |

先截字符串再判断整体，是为了让 `write` 一类工具的 `file_path` 等短字段在大段 `content` 被截断后仍然可用。客户端看到 `$truncated: true` 时按截断显示，不要把它当作工具的真实输入。

## 12. 连接健康

常量在 `limits.ts`（ADR-0002 §5，取自 Paseo A16）。

| 项 | 值 | 说明 |
|---|---|---|
| hello 超时 | `HELLO_TIMEOUT_MS` = 15 s | 连接建立后 15 s 内没完成 hello，以 `HELLO_TIMEOUT` 关闭 |
| 心跳 | `PING_INTERVAL_MS` = 10 s | client-sdk 每 10 s 发一次 `host.ping`；不用 WebSocket 协议层的 ping 帧（浏览器 API 发不了） |
| 租约 | `CONNECTION_LEASE_MS` = 45 s | Host 收到客户端的任何一帧都续租；45 s 什么都没收到，以 `LEASE_EXPIRED` 断开 |
| 发送缓冲 | `SEND_BUFFER_LIMIT_BYTES` = 8 MiB | 每条连接一个上限，超限只断这一条（`SEND_BUFFER_OVERFLOW`），不影响同一会话的其他订阅者 |

Host 不主动 ping 客户端。client-sdk 的请求超时、连接超时、心跳超时分开配置，默认值由 T4.1 定。

发送缓冲按“积压”计：ws 还没写到套接字的字节，加上补发期间排队等待发出的实时事件（§4 第 1 条）。Host 每次发帧前检查积压，已超过上限就不再发送、以 `SEND_BUFFER_OVERFLOW` 关闭；单个大帧本身不算超限（`assistant.*` 等事件不截断，§11），所以积压最多超出上限一帧。补发按批读取，并在积压达到上限的四分之一时等它写出再继续，补发本身不会触发超限。Host 主动关闭连接后最多等 2 s 的关闭握手，对方不回关闭帧就直接断开 TCP。
