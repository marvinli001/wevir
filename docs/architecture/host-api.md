# Wevir Host API v0

> 状态：v0（T1.2）· 协议版本 `0.38.0`（分支到新会话与撤回最后一个回合；版本历史见 §10；最低兼容 `0.1.0`）· 日期：2026-10-16
> 依据：[ADR-0002](../adr/0002-host-transport-and-process-model.md)（协议部分以它为准）；[领域模型](./domain-model.md)；[Paseo 研读](../research/paseo-notes.md) §2（兼容纪律的出处）
> 代码：`packages/protocol`。方法注册表 `MethodSchemas`、通知注册表 `NotificationSchemas`、事件 `EventPayloadSchemas`、错误码 `ErrorCode`、关闭码 `CloseCode` 是唯一的定义；本文件的表格由 `host-api-doc.test.ts` 与代码逐项比对，改一边不改另一边测试就失败。
> 下游：T2.4（Host 侧执行）、T4.1（client-sdk）、T5.1（Origin 白名单写回本文件）

本文件定稿了领域模型里标为“草案”的错误码名（§9），以后以本文件为准。实体与事件 payload 的字段含义不在这里重复，见领域模型 §3、§6。

---

## 1. 传输

- JSON-RPC 2.0 over WebSocket，文本帧，一帧一个 JSON-RPC 对象（ADR-0002 §1）。**v0 不支持批量**：收到 JSON 数组时 Host 回一个 `INVALID_REQUEST`（`id: null`）；二进制帧同样回 `INVALID_REQUEST`（`id: null`）。
- 参数一律按名称传（对象）；方法没有参数时传 `{}`，省略 `params` 等同于 `{}`。请求 `id` 用字符串或整数，不用 `null`。
- 客户端只发请求；Host 只发响应和通知。Host 要客户端做事时也只用通知：0.33.0 起登记为浏览器提供方的连接会收到 `browser.request`，用请求 `browser.respond` 回答（§3.1），线缆上仍没有 Host 发出的 JSON-RPC 请求。同一连接上可以连发多个请求，响应顺序不保证与请求一致，按 `id` 对应；同一会话的命令在 Host 内串行执行（ADR-0002 §4）。
- 端点 URL 与令牌从 `<数据目录>/run/host.json` 读取，客户端不自己拼地址、不回退到默认端口。WebSocket 升级时 Host 校验 `Host` 头（只允许 `127.0.0.1:<port>` 与 `localhost:<port>`，缺失也拒绝）与 `Origin`（不带 Origin 的放行，带 Origin 的只放行下表的白名单，精确匹配），不通过直接 403，不会走到 JSON-RPC 层。Host 优雅退出期间的升级请求回 503，不是升级的 HTTP 请求回 426（下面两个路径除外）。例外是 `POST /mcp`：应用级工具的 MCP 端点（0.30.0，domain-model §3.15），给 Host 自己挂到引擎会话上的 agent 用，不是客户端的接口。它按 MCP 的 Streamable HTTP 只回 JSON（不开 SSE、不记 MCP 会话），要 `Authorization: Bearer <这个会话的令牌>`（每个 Wevir 会话一个，只在内存里、Host 重启后作废，与 `run/host.json` 的令牌无关）；带 `Origin` 头、`Host` 头不是本机地址的回 403，没有或不认识的令牌回 401，不是 POST 的回 405，Host 退出期间回 503。一个进程服务所有会话的引擎（OpenCode）拿的是引擎令牌，调用工具时在请求头 `x-wevir-engine-session` 里写自己的引擎会话 ID，Host 映射回 Wevir 会话，认不出（不存在、或不是这个引擎的种类）回 404；不带这个头只能列工具。
- 另一个例外是 `GET /files/<令牌>/<路径>`（0.32.0，`workspace.fileUrl`）：文件预览的只读读取，给渲染进程里的 `<img>`、`<video>`、`<audio>`、`<iframe>` 与 `fetch` 用。`Host` 头不是本机地址的回 403（防 DNS 重绑定）；不认识、已作废的令牌与读不到的文件一律回 404（不区分）；不是 GET / HEAD 的回 405。令牌按目录发，目录里只读得到能预览的几类文件（图片、样式、脚本、字体、音视频、PDF、网页与 Office 文件，按扩展名，所以 HTML 页面的相对引用与 Markdown 里的图片也走它），路径里有以 `.` 开头的段（`.env`、`.git/`）的不给，realpath 之后仍要在目录里。音视频支持单段 `Range`（206 / 416）。响应都带 `X-Content-Type-Options: nosniff`、`Cache-Control: private, no-store` 与 `Access-Control-Allow-Origin: *`（令牌就是凭据，带它的人本来就读得到；渲染进程要 `fetch` Office 文件的字节）；HTML 另带 CSP：`sandbox allow-scripts allow-forms allow-popups allow-downloads`（不透明 origin，碰不到桌面端的会话与存储，照 T3 Code）且不能联网（`connect-src 'none'`，外部脚本、样式、字体与图片都不加载，只认同一个令牌下的文件，照 Paseo 的 HTML 预览），SVG 带 `default-src 'none'; style-src 'unsafe-inline'; sandbox`。
- Origin 白名单只有桌面渲染进程（T5.1，代码 `DESKTOP_RENDERER_ORIGINS`）。浏览器与渲染进程的 WebSocket 升级一定带 Origin 头；CLI 与测试用的 Node 客户端不带，不受白名单影响。白名单只是纵深防御，挡的是本机浏览器里任意网页发起的连接；鉴权仍靠 hello 里的令牌（§2）。

<!-- registry:origins -->
| Origin | 来源 |
|---|---|
| `wevir://app` | 构建后的渲染进程：主进程注册特权自定义协议 `wevir`（standard、secure），从 `wevir://app/index.html` 加载 electron-vite 的构建产物（`electron-vite build` / `preview`；打包同样用它）。不用 `file://`：它的 Origin 不是可以单独放行的值（Electron 安全清单第 18 条） |
| `http://localhost:5199` | 开发模式（`pnpm dev`）：electron-vite 的开发服务器，端口固定（`strictPort`），被占用时开发服务器启动失败而不是换端口。只在主进程未打包且有开发服务器地址时使用 |

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

- `clientKind`：`desktop`、`cli`；`mobile` 预留，骨架不出现。`deviceId` 是设备级标识；`clientId` 每个安装持久，同一台设备上的桌面与 CLI 不同。二者与 `clientKind` 组成该连接的 `ClientIdentity`，写进 `user.message.sentBy` 与 `approval.resolved` 的 `decidedBy`。客户端把它们存在数据目录里（T4.2）：`device-id` 本机的桌面与 CLI 共用，谁先用到谁创建；CLI 的 `clientId` 在 `cli-client-id`，同一台机器上开几个终端都是同一个 CLI 安装。
- `hostId`：每个数据目录一个，跨 Host 重启不变，客户端据此认出“同一个 Host”。
- `permissions`：骨架阶段恒为权限词表全部（`PERMISSIONS`），为设备权限预留；每个方法需要的权限见 §3。
- `capabilities` / `features`：见 §10。0.7.0 起 Host 按自己的引擎声明 `features.chatgpt_account`（Codex 引擎有，dsh、echo 没有）。
- `engineFeatures`（0.25.0）：键是 Provider 种类，值是跑这种 Provider 的引擎的名字与它能做什么（插话、换模型、支线、提问、权限模式、额外目录、读历史的工具，0.27.0 起还有会话能用的命令 `commands`，0.36.0 起还有计划模式 `planMode`，`EngineFeatures`）。会话接力到别的来源后，客户端按会话当前的 `providerId` 的种类查它，决定输入框上的功能（domain-model §3.14）。

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
| `plugins.list` | `host.manage` | `{}` | `connectors, skills`（密钥只回键名与 true） | |
| `connector.add` | `host.manage` | `name, config, enabled?` | `connector` | |
| `connector.update` | `host.manage` | `id, name?, config?, enabled?`（密钥键省略保留、null 删除） | `connector` | |
| `connector.remove` | `host.manage` | `id` | `{}` | |
| `connector.setEnabled` | `host.manage` | `id, enabled` | `connector` | |
| `skill.install` | `host.manage` | `path`（目录、SKILL.md、ZIP、插件包目录） | `connectors, skills` | |
| `skill.remove` | `host.manage` | `id`（只移除托管项） | `{}` | |
| `skill.setEnabled` | `host.manage` | `id, enabled` | `skill` | |
| `host.hello` | null | `token, protocolVersion, clientKind, deviceId, clientId, capabilities` | `hostId, hostVersion, protocolVersion, minProtocolVersion, features, permissions` | §2 |
| `host.ping` | null | `{}` | `{}` | |
| `host.shutdown` | `host.manage` | `{}` | `{}` | |
| `settings.get` | `session.read` | `{}` | `settings: HostSettings` | |
| `settings.update` | `host.manage` | `settings`（部分字段） | `settings: HostSettings` | |
| `workspace.list` | `workspace.read` | `{}` | `workspaces: Workspace[]` | |
| `workspace.add` | `workspace.write` | `rootPath, displayName?` | `workspace, created` | `WORKSPACE_PATH_INVALID` |
| `workspace.remove` | `workspace.write` | `workspaceId` | `{}` | `WORKSPACE_NOT_FOUND`、`RESOURCE_IN_USE` |
| `environment.list` | `workspace.read` | `{}` | `environments: Environment[]` | |
| `environment.create` | `workspace.write` | `name, folders` | `environment` | `WORKSPACE_NOT_FOUND` |
| `environment.update` | `workspace.write` | `environmentId, name?, folders?` | `environment` | `ENVIRONMENT_NOT_FOUND`、`WORKSPACE_NOT_FOUND` |
| `environment.remove` | `workspace.write` | `environmentId` | `{}` | `ENVIRONMENT_NOT_FOUND` |
| `workspace.git` | `workspace.read` | `workspaceId, sessionId?` | `repo, branch?, detachedAt?, added?, removed?, fileCount?, files?, truncated?` | `WORKSPACE_NOT_FOUND`、`WORKSPACE_PATH_INVALID` |
| `workspace.diff` | `workspace.read` | `workspaceId, sessionId?, source` | `repo, unavailable?, base?, baseRef?, branch?, head?, live?, patch?, files?, fileCount?, added?, removed?, truncated?` | `WORKSPACE_NOT_FOUND`、`WORKSPACE_PATH_INVALID`、`SESSION_NOT_FOUND`、`INVALID_PARAMS` |
| `workspace.diffFile` | `workspace.read` | `workspaceId, sessionId?, oldRev?, oldPath?, newRev?, newPath?` | `oldContents?, newContents?, unavailable?` | `WORKSPACE_NOT_FOUND`、`WORKSPACE_PATH_INVALID`、`SESSION_NOT_FOUND`、`INVALID_PARAMS` |
| `workspace.files` | `workspace.read` | `workspaceId, sessionId?, query, limit?, kind?` | `entries, truncated?` | `WORKSPACE_NOT_FOUND`、`WORKSPACE_PATH_INVALID`、`SESSION_NOT_FOUND` |
| `workspace.listDir` | `workspace.read` | `workspaceId, sessionId?, path` | `entries, truncated?` | `WORKSPACE_NOT_FOUND`、`WORKSPACE_PATH_INVALID`、`SESSION_NOT_FOUND`、`INVALID_PARAMS` |
| `workspace.readFile` | `workspace.read` | `workspaceId, sessionId?, path` | `path, size?, mtimeMs?, text?, image?, unavailable?` | `WORKSPACE_NOT_FOUND`、`WORKSPACE_PATH_INVALID`、`SESSION_NOT_FOUND`、`INVALID_PARAMS` |
| `workspace.fileUrl` | `workspace.read` | `workspaceId, sessionId?, path` | `path, url?, size?, mtimeMs?, expiresAt?, unavailable?` | `WORKSPACE_NOT_FOUND`、`WORKSPACE_PATH_INVALID`、`SESSION_NOT_FOUND`、`INVALID_PARAMS` |
| `workspace.writeFile` | `workspace.write` | `workspaceId, sessionId?, path, text, expectedMtimeMs?` | `path, size?, mtimeMs?, conflict?` | `WORKSPACE_NOT_FOUND`、`WORKSPACE_PATH_INVALID`、`SESSION_NOT_FOUND`、`INVALID_PARAMS` |
| `provider.list` | `provider.read` | `{}` | `providers: ProviderProfile[]` | |
| `provider.upsert` | `provider.write` | 按 `kind` 区分，见下 | `provider, created` | |
| `provider.remove` | `provider.write` | `providerId` | `{}` | `PROVIDER_NOT_FOUND`、`RESOURCE_IN_USE` |
| `provider.test` | `provider.write` | `providerId, modelId?` | `ok, latencyMs?, error?, reason?, httpStatus?` | `PROVIDER_NOT_FOUND` |
| `provider.discoverModels` | `provider.write` | `providerId? / baseURL?, apiKey?, modelId?` | `ok, models, reason?, truncated?` | `PROVIDER_NOT_FOUND`, `INVALID_PARAMS` |
| `provider.setEnabled` | `provider.write` | `providerId, enabled` | `provider` | `PROVIDER_NOT_FOUND` |
| `account.list` | `provider.read` | `{}` | `accounts: AccountState[]` | `ENGINE_ERROR` |
| `account.get` | `provider.read` | `kind, refresh?` | `account: AccountState` | `ENGINE_ERROR` |
| `account.login` | `provider.write` | `kind, method` | `account: AccountState` | `ENGINE_ERROR` |
| `account.cancelLogin` | `provider.write` | `kind, loginId?` | `account: AccountState` | `ENGINE_ERROR` |
| `account.logout` | `provider.write` | `kind` | `account: AccountState` | `ENGINE_ERROR` |
| `account.setPath` | `host.manage` | `kind, path` | `account: AccountState` | `ENGINE_ERROR` |
| `account.install` | `provider.write` | `kind` | `account: AccountState` | `ENGINE_ERROR` |
| `session.create` | `session.write` | `workspaceId?, providerId, modelId?, reasoningEffort?, permissionMode?, environmentId?, worktree?, origin?` | `session` | `WORKSPACE_NOT_FOUND`、`PROVIDER_NOT_FOUND`、`ENVIRONMENT_NOT_FOUND`、`WORKSPACE_PATH_INVALID`、`ENGINE_ERROR` |
| `session.list` | `session.read` | `workspaceId?, parentSessionId?, archived?` | `sessions: Session[]` | `WORKSPACE_NOT_FOUND`、`SESSION_NOT_FOUND` |
| `session.get` | `session.read` | `sessionId` | `SessionSnapshot` | `SESSION_NOT_FOUND` |
| `session.configure` | `session.write` | `sessionId, modelId?, reasoningEffort?, permissionMode?` | `session` | `SESSION_NOT_FOUND`、`INVALID_PARAMS`、`INVALID_STATE`、`ENGINE_ERROR` |
| `session.send` | `session.write` | `sessionId, content, clientMessageId?, delivery?` | `turnId?, pendingId?, seq` | `SESSION_NOT_FOUND`、`SESSION_BUSY`、`INVALID_STATE`、`CLIENT_MESSAGE_CONFLICT`、`WORKSPACE_PATH_INVALID`、`ENGINE_ERROR`、`IMAGE_NOT_FOUND` |
| `session.cancel` | `session.write` | `sessionId` | `{}` | `SESSION_NOT_FOUND`、`INVALID_STATE` |
| `session.close` | `session.write` | `sessionId` | `{}` | `SESSION_NOT_FOUND`、`INVALID_STATE` |
| `session.resume` | `session.write` | `sessionId` | `session` | `SESSION_NOT_FOUND`、`INVALID_STATE`、`PROVIDER_NOT_FOUND`、`WORKSPACE_PATH_INVALID`、`ENGINE_ERROR` |
| `session.fork` | `session.write` | `sessionId, side?, turnId?` | `session` | `SESSION_NOT_FOUND`、`INVALID_PARAMS`、`INVALID_STATE`、`WORKSPACE_PATH_INVALID`、`ENGINE_ERROR` |
| `session.rewind` | `session.write` | `sessionId, turnId` | `seq` | `SESSION_NOT_FOUND`、`SESSION_BUSY`、`INVALID_STATE`、`WORKSPACE_PATH_INVALID`、`ENGINE_ERROR` |
| `session.compact` | `session.write` | `sessionId` | `turnId, seq` | `SESSION_NOT_FOUND`、`SESSION_BUSY`、`INVALID_STATE`、`WORKSPACE_PATH_INVALID`、`ENGINE_ERROR` |
| `session.review` | `session.write` | `sessionId, target` | `turnId, seq` | `SESSION_NOT_FOUND`、`SESSION_BUSY`、`INVALID_STATE`、`INVALID_PARAMS`、`WORKSPACE_PATH_INVALID`、`ENGINE_ERROR` |
| `session.setGoal` | `session.write` | `sessionId, objective, tokenBudget?` | `turnId, seq` | `SESSION_NOT_FOUND`、`SESSION_BUSY`、`INVALID_STATE`、`INVALID_PARAMS`、`WORKSPACE_PATH_INVALID`、`ENGINE_ERROR` |
| `session.updateGoal` | `session.write` | `sessionId, status` | `goal` | `SESSION_NOT_FOUND`、`INVALID_STATE`、`WORKSPACE_PATH_INVALID`、`ENGINE_ERROR` |
| `session.clearGoal` | `session.write` | `sessionId` | `cleared` | `SESSION_NOT_FOUND`、`INVALID_STATE`、`WORKSPACE_PATH_INVALID`、`ENGINE_ERROR` |
| `session.rename` | `session.write` | `sessionId, title` | `session` | `SESSION_NOT_FOUND`、`INVALID_PARAMS` |
| `session.archive` | `session.write` | `sessionId, archived` | `session` | `SESSION_NOT_FOUND`、`INVALID_PARAMS`、`ENGINE_ERROR` |
| `session.checkpoints` | `session.read` | `sessionId` | `repo, turns` | `SESSION_NOT_FOUND`、`WORKSPACE_PATH_INVALID` |
| `pending.update` | `session.write` | `sessionId, pendingId, content?, delivery?` | `pending` | `SESSION_NOT_FOUND`、`PENDING_NOT_FOUND`、`PENDING_NOT_EDITABLE`、`IMAGE_NOT_FOUND` |
| `pending.cancel` | `session.write` | `sessionId, pendingId` | `pending` | `SESSION_NOT_FOUND`、`PENDING_NOT_FOUND`、`PENDING_NOT_EDITABLE` |
| `pending.resume` | `session.write` | `sessionId` | `pendingMessages` | `SESSION_NOT_FOUND`、`INVALID_STATE` |
| `image.upload` | `session.write` | `mimeType, data, name?` | `image: UserImagePart` | `INVALID_PARAMS` |
| `image.read` | `session.read` | `imageId, offset?` | `imageId, mimeType, size, offset, data` | `IMAGE_NOT_FOUND`、`INVALID_PARAMS` |
| `web.get` | `session.read` | `{}` | `web: WebSettings` | `INVALID_PARAMS`（Host 没有联网服务） |
| `web.update` | `host.manage` | `enabled?, searchService?, key?: {service, apiKey}`（`apiKey` 为 null 删掉） | `web: WebSettings` | `INVALID_PARAMS` |
| `web.test` | `host.manage` | `service?, apiKey?` | `ok, service, latencyMs?, results?, reason?, httpStatus?, message?` | `INVALID_PARAMS` |
| `question.respond` | `session.write` | `questionId, answers` | `questionId, status, resolution` | `QUESTION_NOT_FOUND`、`INVALID_PARAMS`、`ENGINE_ERROR` |
| `approval.respond` | `session.write` | `approvalId, optionId` | `approvalId, status, resolution` | `APPROVAL_NOT_FOUND`、`ALREADY_DECIDED` |
| `browser.register` | `host.manage` | `commands` | `{}` | |
| `browser.unregister` | `host.manage` | `{}` | `{}` | |
| `browser.respond` | `host.manage` | `requestId, ok, result?, error?, dialogs?` | `accepted` | |
| `events.subscribe` | `session.read` | `sessionId, sinceSeq` | `subscriptionId, replayedThroughSeq` | `SESSION_NOT_FOUND` |
| `events.unsubscribe` | `session.read` | `subscriptionId` | `{}` | |

Host → 客户端的通知：

<!-- registry:notifications -->
| 通知 | params |
|---|---|
| `plugins.changed` | `{}`（全局变化，调用过插件方法的连接重读 plugins.list；不写会话事件流） |
| `events.event` | `subscriptionId, event: WevirEvent` |
| `account.updated` | `account: AccountState`（0.7.0；只发给调用过 `account.*` 方法的连接；订阅来源只发给声明了 `subscription_kinds` 的连接） |
| `settings.updated` | `settings: HostSettings`（发给调用过 `settings.*` 的连接） |
| `browser.request` | `requestId, sessionId, cwd, command: BrowserCommand`（0.33.0；只发给用 `browser.register` 登记过的连接） |

### 3.1 各方法要点

- **`host.ping`**：心跳（§12），任何时候都可以发。
- **`host.shutdown`**：Host 先回 `{}`，再按 ADR-0002 §6 的顺序优雅退出，最后以 `GOING_AWAY` 关闭所有连接。退出期间到达的请求回 `HOST_SHUTTING_DOWN`。
- **`workspace.add`**：`rootPath` 必须是绝对路径、存在、是目录，否则 `WORKSPACE_PATH_INVALID`（`data.reason` 为 `not_absolute` / `not_found` / `not_directory` / `not_accessible`）。Host 取 realpath 去重：已有同一 realpath 的工作区（含曾被移除的）时返回它，`created: false`。
- **`workspace.remove`**：只注销，不删磁盘文件；有未关闭会话时回 `RESOURCE_IN_USE`，`data.sessionIds` 列出这些会话。“对话”工作区（`kind: 'chats'`，0.39.0）不能移除，`workspace.add` 也不接受它与它下面的文件夹（都是 `INVALID_PARAMS`）。
- **`environment.*`**（0.15.0，Host 功能 `environments`，domain-model §3.10）：保存的环境。`create` 的 `folders` 1–8 个、工作区不重复且都在，`name` 去掉首尾空白后 1–60 字，否则 `INVALID_PARAMS`；`update` 只改给出的字段；`remove` 不影响已经用它建的会话。按创建时间排列。
- **`workspace.git`**（0.13.0，Host 功能 `workspace_git`，U18）：工作区目录的 git 状态，给桌面端会话侧栏的“环境”（分支）与“变更”（+N −M）卡片。Host 每次调用时在工作区目录里现跑只读的 git 命令，不缓存、不写事件；客户端在回合结束、窗口获得焦点与定时（桌面端 10 s）时重读。目录不在 git 仓库里、本机没有 git、git 出错或超时（每条命令 5 s）都回 `repo: false`，其余字段省略。是仓库时：`branch` 是当前分支（含还没有提交的新分支）；分离头指针时没有 `branch`，`detachedAt` 是 HEAD 的短 SHA。改动按工作区目录统计（`git diff --relative`，工作区是仓库的子目录时只算这个目录里的）：已跟踪文件相对 HEAD（工作树 + 暂存区；还没有提交时是暂存区）的增删行数之和 `added` / `removed`，不跟踪重命名（重命名算一删一增）；`fileCount` 是改动的文件数，含未跟踪（`.gitignore` 之外的）文件；`files` 每项 `path`（相对工作区目录，`/` 分隔）、`status`（`modified` / `added` / `deleted` / `untracked`，开放字符串，以后可能多）、`added` / `removed`（二进制文件与未跟踪文件没有），按 git 的顺序、先已跟踪后未跟踪，最多 200 项，多了 `truncated: true`。为了不在不受信任的仓库里执行仓库配置里的命令，Host 关掉 fsmonitor、外部 diff 与 textconv，屏蔽仓库自己（local、worktree 两级配置）定义的过滤器（`filter.<名字>.clean` 等，`git diff` 读工作树文件时会执行它；全局与系统配置里的照常用），并设 `GIT_OPTIONAL_LOCKS=0`（不写索引锁）。工作区已移除回 `WORKSPACE_NOT_FOUND`，目录已不存在回 `WORKSPACE_PATH_INVALID`。0.15.0 起可带 `sessionId`：读这个会话的目录（环境会话是 Host 新开的 worktree，domain-model §3.10），会话不存在或不属于这个工作区回 `SESSION_NOT_FOUND`。
- **`provider.upsert`**：参数按 `kind` 判别。`deepseek-official` 的 `id` 固定为 `deepseek-official`；`openai-compatible` 必须给 `api`、`baseURL`（http / https，允许 localhost 与 IP）和至少一个模型。语义是整体替换非密钥字段，不是合并；`id` 不存在时新建（`created: true`）。`kind` 创建后不可改，改了回 `INVALID_PARAMS`；`defaultModelId` 不在 `models` 里（`openai-compatible`）同样回 `INVALID_PARAMS`。`apiKey`：省略 = 保留已存的 Key，字符串 = 设置或替换，`null` = 删除。**Key 只进 SecretStore，Host 不得把它写进日志、事件或任何响应**；响应里只有 `hasSecret`。写库前 Host 让引擎适配器检查配置（`validateProvider`），引擎不接受时回 `INVALID_PARAMS`（`data.issues` 是适配器给的字段路径与说明，例如 `anthropic-messages` 暂不支持、compat 开关与协议不匹配），不写库。写库后 Host 把全部 Provider 交给引擎；引擎没能用上新配置时回 `ENGINE_ERROR`，但 Profile 已保存（`provider.remove` 同样）。新配置何时对运行中的会话生效见 [providers.md](./providers.md) §5。
- **`provider.upsert` 的 `google-vertex`**（0.21.0）：Host 功能 google_vertex；api 选 openai-completions 或 anthropic-messages，vertex.project 必须有效，location 省略为 global；models 不混用 Gemini 与 Claude，defaultModelId 必须在列表中。不使用自定义 baseURL。serviceAccountJson（optional，最多 64 KiB）整份进 SecretStore，省略保留、字符串替换、null 删除；不使用 apiKey。能力门控与兼容方式见 §10。
- **`provider.upsert` 的 `chatgpt`**（0.7.0）：`id` 固定为 `chatgpt`，只有 `displayName` 与 `defaultModelId`；没有 Key、地址与 compat，`models` 由 Host 向引擎要（ChatGPT 进程的 `model/list`），`defaultModelId` 不在其中回 `INVALID_PARAMS`。Host 没有 `chatgpt_account` 功能时（dsh、echo 引擎）引擎的 `validateProvider` 拒绝，回 `INVALID_PARAMS`。ChatGPT 登录成功后 Host 自己建这个 Provider（显示名 `ChatGPT`，默认模型取引擎标为默认的那个），之后每次登录成功与 `account.get` 读到已登录时刷新它的模型列表（默认模型不在新列表里时换成新的默认）。
- **`provider.remove`**：同时删除 Key。被未关闭会话引用时回 `RESOURCE_IN_USE`。删除 `chatgpt` 不登出账号；下次登录成功时 Host 再建它。
- **`workspace.diff`**（0.20.0，Host 功能 `workspace_diff`）：一段改动的统一格式 diff，给桌面端的“变更”窗格。`source` 三种：`uncommitted` 是工作树加暂存区对 HEAD（还没有提交时对空树），含 `.gitignore` 之外的未跟踪文件（Host 把它们以 intent-to-add 加进一份临时索引，不碰用户的索引）；`branch` 是工作树对默认分支与 HEAD 的 merge-base（默认分支依次试 `origin/HEAD` 指向的分支、`main`、`master`、`origin/main`、`origin/master`），找不到时同 `uncommitted`、不带 `baseRef`；`turn` 是会话一个回合前后的快照之间（必须带 `sessionId`，否则 `INVALID_PARAMS`），回合还没有“后”快照（进行中、快照失败）时新的一侧是现在的工作树、带 `live: true`，没有“前”快照时只回 `repo: true, unavailable: 'no_checkpoint'`（快照见 domain-model §3.13）；回合里 HEAD 动过（pull、merge、rebase、提交）时，git 带进来、回合本身没写过的文件不算（T3 Code 的做法）。目录与 `workspace.git` 相同（带 `sessionId` 时是会话的目录），路径相对它（`git diff --relative`），跟踪重命名。`base` 是旧的一侧的提交（还没有提交时是空树），`head` 是新的一侧的提交（省略即工作树），两者给 `workspace.diffFile`。`patch` 是 `a/`、`b/` 前缀的统一格式 diff，只含 `files` 里没有 `omitted` 的文件；`files` 每项 `path`、`previousPath?`、`status`（`added` / `deleted` / `modified` / `renamed` / `copied` / `type_changed` / `untracked`，开放字符串）、`added` / `removed`（二进制文件没有，带 `binary: true`）。上限：整个 `patch` 2 MiB、单个文件 512 KiB（UTF-16 code unit），超过的文件只列出、带 `omitted`（`too_large` / `over_limit`）；未跟踪文件多于 5000 个时不算它们的 diff，逐个列出、带 `omitted: 'over_limit'`；`files` 最多 2000 项。有任何 `omitted` 或 `files` 被截断时 `truncated: true`，`fileCount` 与 `added` / `removed` 仍是全部。同一目录同一段的并发调用共用一次读取；每条 git 命令 10 s 超时，超时与 git 出错都回 `repo: false`。安全做法同 `workspace.git`，另外屏蔽钩子与提交签名。
- **`workspace.diffFile`**（0.20.0）：一个文件两侧的全文，给“展开未修改的行”。旧的一侧是 `oldRev`（上面的 `base`）里的 `oldPath`，新的一侧是 `newRev`（上面的 `head`）里的 `newPath`，没有 `newRev` 时读磁盘（realpath 之后仍要在目录里、是普通文件）；只给要读的那一侧的路径，`oldPath` 要带 `oldRev`。路径必须相对、`/` 分隔、不含 `..`，否则 `INVALID_PARAMS`。一侧超过 1 MiB、含 NUL 字节、不存在时只回 `unavailable`（`too_large` / `binary` / `not_found`）。版本库里的一侧用 `git cat-file blob`，不经过 textconv 与过滤器。
- **`workspace.files`**（0.22.0，Host 功能 `workspace_files`）：按名字找文件与文件夹，给桌面端输入框的 @ 提及与文件窗格的搜索。目录同 `workspace.git`（带 `sessionId` 时是会话的目录），路径相对它、`/` 分隔。Host 按目录建一份索引、缓存 5 s：git 仓库里是 `git ls-files --cached --others --exclude-standard`（跟踪的加没被忽略的未跟踪文件，文件夹取它们的父目录），否则逐层遍历、跳过 `node_modules`、`.git`、`.venv`、`target` 等目录与符号链接；最多 25 000 项，超出或遍历超过 10 s 时结果带 `truncated`。`query` 先去掉开头的 `@` 与空白、转小写，名字的匹配（完全相同、前缀、词边界、包含、子序列）优先于整条路径的匹配，含 `/` 时只按路径；排序与桌面端的斜杠命令共用 `@wevir/protocol` 的 `scoreQueryMatch`（移植自 T3 Code）。`query` 为空时按层级从浅到深给出前 `limit`（默认 50，最多 200）项；`kind` 只要文件或只要文件夹。匹配的多于 `limit` 时也带 `truncated`。
- **工作区的文件与 git 方法**（`workspace.git`、`workspace.diff`、`workspace.diffFile`、`workspace.files`、`workspace.listDir`、`workspace.readFile`、`workspace.fileUrl`、`workspace.writeFile`）：对“对话”工作区（0.39.0）要带 `sessionId`，读那个会话的文件夹；不带时 `INVALID_PARAMS`。
- **`workspace.listDir`**（0.22.0）：列一个目录的直接子项，给文件窗格的目录树。`path` 为空字符串是根目录，否则同 `workspace.diffFile` 的路径规则（相对、`/` 分隔、不含 `..`，否则 `INVALID_PARAMS`）。文件夹在前、再按名字（数字按数值）；不含 `.git`；符号链接按它指到的类型，指到目录外的不列；git 仓库里被 `.gitignore` 忽略的项带 `ignored: true`（`git check-ignore`）。目录不存在或 realpath 在目录外时是空表。最多 5000 项，超出带 `truncated`。
- **`workspace.readFile`**（0.22.0）：读一个文件，给文件窗格。路径规则同上。按扩展名认出的图片（png、jpg、gif、webp、svg、bmp、ico）给 `image: { mimeType, data }`（base64，不超过 4 MiB，免得超过连接的发送缓冲），其余当 UTF-8 文本给 `text`（不超过 1 MiB）；`size` 是文件的字节数。超过上限回 `unavailable: 'too_large'`，文本含 NUL 字节回 `binary`，不存在、不是普通文件或 realpath 在目录外回 `not_found`（不带 `size`）。开放字符串。0.32.0 起读到文件时带 `mtimeMs`（这一版的修改时间，毫秒，可能有小数），编辑后写回时作 `workspace.writeFile` 的 `expectedMtimeMs`。
- **`workspace.fileUrl`**（0.32.0，Host 功能 `file_preview`）：给一个文件发只读的流式地址，给文件窗格预览 PDF、网页、音视频、Office 文件与大图片（不走 base64 的 JSON-RPC）。路径规则同 `workspace.readFile`；不存在、不是普通文件或 realpath 在目录外只回 `unavailable: 'not_found'`，不是能预览的类型（见 §1）或路径里有以 `.` 开头的段回 `unsupported`（开放字符串）。`url` 是 `http://127.0.0.1:<RPC 端口>/files/<令牌>/<路径>`（各段百分号编码），`size`、`mtimeMs` 是这时的文件，`expiresAt` 是令牌作废的时间。令牌按目录发（同一个会话目录在有效期内重复调用给同一个），只在 Host 内存里，一小时后作废、Host 重启后全部作废，最多同时 64 个。HTTP 端见 §1。
- **`workspace.writeFile`**（0.32.0，Host 功能 `file_preview`）：把文本写回一个已有的普通文件，给文件窗格的编辑。路径规则同上，realpath 之后仍要在目录里；不存在、不是普通文件回 `INVALID_PARAMS`，文本超过 1 MiB（UTF-8）同样。带 `expectedMtimeMs` 时，磁盘上的修改时间与它不同（或文件已删除）就不写，回 `conflict: true` 与现在的 `size` / `mtimeMs`（已删除时省略）；不带时直接写。原地写（保留权限与硬链接），写完回新的 `size` / `mtimeMs`。不新建文件、不改编码与换行（客户端给什么写什么）。
- **`provider.setEnabled`**（0.19.0，Host 功能 `provider_enabled`）：启用或停用一个 Provider（任何种类），结果是改后的 Provider。停用只影响客户端：模型选择里不再列出它的模型；已有会话照常能用、能 resume，Host 不拒绝用它建会话。`ProviderProfile.enabled` 省略表示启用；Host 只在停用时写 `enabled: false`。
- **订阅来源的 Provider**（0.19.0，Host 功能 `subscription_sources`，ADR-0005 补记 14）：`claude`、`cursor`、`opencode`、`grok`、`antigravity` 同 `chatgpt`，`id` 固定等于种类，没有 Key 与地址；对应的账号第一次读到已登录时 Host 建它（显示名见 domain-model §3.6），之后刷新模型列表的规则同 `chatgpt`。用它建的会话由对应的引擎运行；Host 没有那个引擎时回 `ENGINE_ERROR`。客户端没有声明能力位 `subscription_kinds` 时，`provider.list` 不含这些 Provider。
- **`provider.test`**：用该 Provider 发一次最小请求（带已存的 Key）。连通与否放在结果里（`ok`、`error.category` / `error.message`），不作为 JSON-RPC 错误；只有 Provider 不存在才回错误。0.2.0 起失败时另有 `reason`（`missing_key` / `network` / `timeout` / `auth` / `model_not_found` / `protocol` / `rate_limited` / `server` / `unknown`）与收到的 `httpStatus`，归类规则见 [providers.md](./providers.md) §6。
- **`account.get`**（0.7.0）：读账号状态（`AccountState`，domain-model §3.6）。已登录时附带用量（引擎读不到时省略）。调用过任何 `account.*` 方法的连接，之后都会收到 `account.updated` 通知（连接断开即止，重连后再调一次 `account.get`）；没调过的连接收不到，旧客户端因此不会遇到这个通知。Host 没有 `chatgpt_account` 功能时回 `ENGINE_ERROR`。
- **`account.list`**（0.19.0，Host 功能 `subscription_sources`）：Host 的引擎支持的全部账号种类各自的状态，按 `AccountKind` 的顺序。读不到的种类也列出：`signed_out` 带 `lastError`。客户端没有声明 `subscription_kinds` 时只有 `chatgpt`。调用过它也算调用过 `account.*`。订阅来源的状态还带安装字段（domain-model §3.6）：`installed: false` 时界面给 `installCommand` / `installUrl`，`canInstall` 时可以 `account.install`；`signIn: command` 的种类不能 `account.login`（回 `ENGINE_ERROR`），用户在终端里运行 `loginCommand` 之后，客户端 `account.get` 带 `refresh: true` 重新检测。
- **`account.get` 的 `refresh`**（0.19.0）：让引擎重新找可执行文件、重读登录状态（不带时引擎可以用最近一次的结果）。
- **`account.setPath`**（0.19.0）：指定这类订阅的引擎用的可执行文件（绝对路径），`null` 清掉、回到自动查找。Host 把它记在 Host 设置旁边的 `engines.json` 里，交给引擎后重新检测，结果是新的状态（找不到时 `installed: false`、`lastError` 说明）。引擎不支持指定路径时回 `ENGINE_ERROR`。
- **`account.install`**（0.19.0）：让 Wevir 下载安装这类订阅的引擎（`canInstall` 的种类，如 Antigravity）。立即返回带 `installing` 的状态，进度、完成与失败经 `account.updated` 送达；已在安装时返回当前状态。引擎不能安装时回 `ENGINE_ERROR`。
- **`account.login`**：开始登录，结果是 `signing_in` 的状态，`login` 里是浏览器方式的 `authUrl`，或设备码方式的 `verificationUrl` 与 `userCode`。Host 不打开浏览器：桌面端把 `authUrl` 交给系统浏览器（`openExternal`），CLI 用设备码。浏览器方式的回调落在引擎在本机 `127.0.0.1:1455` 临时监听的端口，所以浏览器要在 Host 这台机器上；不在时用设备码。已有进行中的登录时新的替换旧的（旧的以失败结束，不算错误）。完成、失败与超时经 `account.updated` 送达。引擎拒绝（例如设备码请求连不上登录服务）回 `ENGINE_ERROR`。
- **`account.cancelLogin`**：取消进行中的登录；没有、或 `loginId` 不是当前的，什么都不做。返回取消之后的状态（`signed_out`，或者原本已登录时的 `signed_in`）。
- **`account.logout`**：登出（引擎删除本机凭据并尽力吊销令牌），没登录时同样成功。`chatgpt` Provider 与用它的会话保留，之后的回合失败（`missing_credentials`），重新登录即可继续。
- **`session.create`**：`modelId` 省略时用 Provider 的 `defaultModelId`。0.16.0 起可带 `origin`（建议的后续任务，domain-model §3.11）：`workspaceId` 要与提出建议的会话相同、这项建议还没开始，否则 `INVALID_PARAMS`；建好后在提出建议的会话里写 `task.started`。0.15.0 起可带 `environmentId`（domain-model §3.10）：`workspaceId` 必须是环境的主文件夹；Host 先按环境准备目录（worktree），再建引擎会话，任何一步失败都回 `INVALID_PARAMS` 并删掉已建的 worktree。0.18.0 起可带 `worktree: 'new'`（Host 功能 `session_worktree`）：不用环境，在工作区的仓库里给这个会话单独新开一个 worktree，失败同样回 `INVALID_PARAMS`、不留 worktree；不能与 `environmentId` 同时给，`none` 与省略相同。0.39.0 起 `workspaceId` 可以省略（Host 功能 `chat_sessions`，domain-model §3.1）：会话建在 Host 的“对话”工作区（没有就建），`cwd` 是给它新建的空文件夹 `<数据目录>/chats/<会话 ID>`；给的是“对话”工作区时也一样；带 `environmentId` 或 `worktree: 'new'` 回 `INVALID_PARAMS`。Host 没有声明 `chat_sessions` 时省略它回 `INVALID_PARAMS`。Host 先建引擎会话，成功后才写 `session.created`（`seq = 1`），返回的 `session.state` 为 `idle`、`lastSeq` 为 1。引擎失败回 `ENGINE_ERROR`，不建会话（对话的文件夹也删掉）。
- **`session.fork`**（0.17.0，Host 功能 `side_sessions`，domain-model §3.12）：从会话分出一个支线会话，`side` 现在只能是 `true`。被分的会话是子会话、支线、只读，或还没有完成的回合时回 `INVALID_STATE`；回合进行中也可以分，支线带着到最近一个完成的回合为止的上下文。返回的新会话 `idle`、带 `forkedFrom` 与 `side`，它的事件流从 `session.created` 开始；支线不进 `session.list`。
- **分支：`session.fork` 不带 `side`**（0.38.0，Host 功能 `session_branches`，domain-model §3.18）：分支到新会话。新会话是普通的顶层会话（进 `session.list`，引擎会话持久化），带着被分会话到 `turnId` 那个完成的回合为止的消息记录：事件流是 `session.created`（带 `forkedFrom: { sessionId, turnId }`，没有 `side`），接着抄来的那段历史（`seq` 重新编号，`ts` 与 `payload` 照旧，会话自己的事实、审批与提问不抄），再是标题（同被分的会话）。`turnId` 省略时到最近一个完成的回合；不是这个会话完成的（没被撤回的）回合时回 `INVALID_PARAMS`，支线带 `turnId` 同样。回合进行中也可以分。会话所在的引擎不能分支（`engineFeatures` 的 `branch`）、那个回合在最近一次接力之前、刚接力还没发过消息时回 `INVALID_STATE`。
- **`session.rewind`**（0.38.0，Host 功能 `session_rewind`，domain-model §3.18）：撤回会话最后一个完成的回合，客户端用它编辑重发最后一条用户消息（撤回之后照常 `session.send`）。`turnId` 必须是最后一个没撤回的完成的回合，否则 `INVALID_STATE`；回合进行中回 `SESSION_BUSY`；子会话、支线、只读、出错或已关闭的会话，引擎不能撤回（`engineFeatures` 的 `rewind`），或那个回合在最近一次接力之前时回 `INVALID_STATE`。引擎会话没挂着时 Host 先自动恢复，引擎撤回之后写 `turn.rewound`，结果是它的 `seq`；引擎失败时回 `ENGINE_ERROR`、不写事件。会话目录里的文件不动。
- **`session.compact`**（0.24.0，Host 功能 `session_compact`，domain-model §4.7）：立即压缩会话的上下文。开始一个由命令开始的回合：没有 `user.message`，`turn.started` 带 `command: { kind: 'compact' }`，回合里引擎报 `context.compacting` 与 `context.compacted`（`trigger: 'manual'`），之后照常 `turn.finished`。前提与 `session.send` 相同：会话空闲（回合进行中回 `SESSION_BUSY`，不排队），已关闭或出错时先 `session.resume`（否则 `INVALID_STATE`），只读与子会话 `INVALID_STATE`；引擎会话没挂着时 Host 先自动恢复。会话所在的引擎不能压缩时回 `INVALID_STATE`，不写事件；0.27.0 起 `host.hello` 的 `engineFeatures` 的 `commands`（`compact`、`review`）事先说明哪种 Provider 的引擎会，客户端按会话当前的 Provider 查，只列出会的命令。Codex：`thread/compact/start`；Claude：发 `/compact`。结果是开始的回合与它的 `turn.started` 的 `seq`。引擎在上下文快满时自己压缩（不经这个方法）同样报这两个事件，`trigger: 'auto'`，在普通回合中间。
- **`session.review`**（0.24.0，Host 功能 `session_review`）：代码审查。`target: 'uncommitted'` 看工作树里暂存、未暂存与未跟踪的改动；`'branch'` 看当前分支对基础分支的改动，基础分支由 Host 找（同 `workspace.diff` 的 `branch`：origin 的 HEAD，再试 main、master 与 origin 上的同名分支），找不到时 `INVALID_PARAMS`。会话目录不是 git 仓库时同样 `INVALID_PARAMS`。回合同 `session.compact`：`turn.started` 带 `command: { kind: 'review', target, baseBranch? }`，审查结果是这个回合的助手消息。其余前提与错误同 `session.compact`。Codex：`review/start`（`delivery: 'inline'`，在会话自己的 thread 上）；别的引擎不支持（`INVALID_STATE`）。
- **`session.setGoal`**（0.35.0，Host 功能 `session_goals`，domain-model §3.16，ADR-0005 补记 20）：设会话的目标。`objective` 去掉首尾空白后不能是空的，最多 `GOAL_OBJECTIVE_MAX_CHARS`（4000，按码点，同 Codex）个字；`tokenBudget` 可选，正整数。替换原有的目标（连同用量），以目标为用户消息开始第一个回合：`user.message` 的内容就是目标，`turn.started` 带 `trigger: 'goal'`，首个回合照常起标题。之后目标进行中、会话空闲时引擎自己开回合接着做：这样的回合只有 `turn.started`（`trigger: 'goal'`）、没有 `user.message`，直到模型判定目标达成（`complete`）或受阻（`blocked`）、用户暂停或清除、预算或用量到了上限。前提同 `session.compact`（空闲，否则 `SESSION_BUSY`；只读、子会话、出错或已关闭 `INVALID_STATE`；引擎会话没挂着时先自动恢复）；会话所在的引擎没有目标时 `INVALID_STATE`，不写事件，`host.hello` 的 `engineFeatures` 的 `goals` 事先说明（目前只有 Codex）。结果同 `session.send`：开始的回合与它的 `user.message` 的 `seq`。
- **`session.updateGoal`** / **`session.clearGoal`**（0.35.0）：`status: 'paused'` 暂停（进行中的回合照常做完，之后不再接着做），`'active'` 继续（会话空闲时引擎随即开回合）；结果是改后的 `goal`。会话没有目标时 `updateGoal` 回 `INVALID_STATE`；`clearGoal` 清除目标，结果的 `cleared` 为 `false` 表示本来就没有。只读、子会话、出错或已关闭 `INVALID_STATE`，引擎没有目标同上；回合进行中也可以。`session.cancel` 停止回合时 Host 让引擎先暂停进行中的目标（同 Codex 终端界面），停下的回合之后不会被续上。目标的每次变化（设置、状态、用量）都写成 `session.goal_changed`（来自引擎的通知，清除时 `goal` 为 `null`），`Session.goal` 与快照跟着它；Host 重启后从事件重放出来，引擎也持久化了它（Codex 的 state DB）。
- **`session.rename`**（0.23.0，Host 功能 `session_rename`）：用户给会话改名。`title` 去掉首尾空白后不能是空的（否则 `INVALID_PARAMS`），最长 200 个字符；写一条 `session.title_changed`（`source: 'user'`），之后模型生成的标题不再覆盖它。子会话不能改名（`INVALID_PARAMS`）；已关闭、只读、已归档的会话可以。标题没变时不写事件。
- **`session.archive`**（0.23.0，Host 功能 `session_archive`）：`archived: true` 归档——会话没关闭时先按 `session.close` 关闭（进行中的回合取消），再记下归档的时刻（`Session.archivedAt`）；`false` 取消归档，会话仍是关闭的，下次发送时客户端照常先 `session.resume`。只有顶层、不是支线的会话能归档（否则 `INVALID_PARAMS`）。已归档时再归档不改时刻。`archivedAt` 只在 `session.list`、`session.get` 与 `session.*` 方法的结果里，不是事件推导的；别的客户端在下一次 `session.list` 时看到变化。
- **`session.checkpoints`**（0.20.0，Host 功能 `workspace_diff`）：会话有快照的回合，从早到晚，每项 `turnId` 与“后”快照里记下的统计 `fileCount`、`added`、`removed`（同 `workspace.diff` 的 `turn`，滤掉 git 带进来的文件；还没有“后”快照时省略）。会话目录不是 git 仓库时 `repo: false`、`turns` 为空。先等这个会话还没打完的快照。
- **`session.list`**：按 `updatedAt` 从新到旧；省略 `workspaceId` 时列出所有未移除工作区的会话。不含支线会话（0.17.0）。默认**不含子会话**（0.6.0，领域模型 §3.3.1）：子会话由引擎派出、只读，跟着父会话显示，不进左栏的会话列表。带 `parentSessionId` 时只列出这个会话的子会话（不论 `workspaceId`；会话不存在或所属工作区已移除时回 `SESSION_NOT_FOUND`）；一个会话的子会话也在它的快照 `subagents` 里（摘要）。0.23.0 起默认不含已归档的会话，`archived: true` 时只列已归档的（按 `updatedAt` 从新到旧）。
- **`session.get`**：返回由事件推导的快照 `{session: {state, activeTurn, lastSeq, …}, pendingApprovals, todos?, usage?, subagents?}`（ADR-0002 §3）。中途加入的客户端先取快照，再以 `sinceSeq = session.lastSeq` 订阅。0.6.0：子会话照常可以 `session.get`，`session` 带 `parentSessionId` 与 `subagent`（父工具调用、状态、起止时间）；派出过子会话的会话带 `subagents`，每个子会话一份摘要（标题、模型与推理强度、昵称、状态、起止时间，以及它的未决审批的副本），按 `startedAt` 排列（领域模型 §3.3.1）。
- **`session.configure`**（0.9.0，Host 功能 `session_configure`）：换会话的模型或推理档位，从下一个回合起生效，进行中的回合不受影响，会话处于什么状态都可以调。`modelId` 必须在会话所用 Provider 的模型列表里（Provider 列了模型时，否则 `INVALID_PARAMS`）；不换 Provider。`reasoningEffort` 为 `null` 时清掉、用模型的默认档位，换了模型而没给它时也清掉；给了就原样交给引擎（不按 Provider 的 `reasoningEfforts` 校验，客户端从中选）。值真的变了时追加 `session.configured`（带改后的全部值），结果是改后的会话。子会话回 `INVALID_STATE`（`data.parentSessionId`），只读会话回 `INVALID_STATE`（`data.readOnly`）；Host 的引擎不支持（没有声明 `session_configure`）时回 `ENGINE_ERROR`（`category: unknown`，同 `account.*`）；引擎拒绝这个模型时回 `INVALID_PARAMS`。引擎会话没挂着（Host 重启后、关闭后）时只记下新的值，下次 resume 时交给引擎。0.11.0 起还可以换 `permissionMode`（Host 功能 `permission_modes`，见下一条），交给引擎的总是全部当前值，`session.configured` 也带上它。
- **接力：`session.configure` 的 `providerId`**（0.25.0，Host 功能 `session_handoff`，domain-model §3.14，ADR-0005 补记 14）：换到别的 Provider（别的来源）。`modelId` 省略时用新 Provider 的默认模型，给了就要在它的模型列表里（列了模型时）；`reasoningEffort` 没给时清掉；`permissionMode` 没给时沿用，新引擎不支持时回 `INVALID_PARAMS`。会话要是 `idle`、`error` 或 `closed`，活动中回 `SESSION_BUSY`；子会话、支线与只读以外的检查同上；Provider 不在回 `PROVIDER_NOT_FOUND`。Host 先取消活动中的子会话、断开并关闭当前的引擎会话，再为新 Provider 挂上引擎会话：这个来源以前用过时恢复它以前的引擎会话（恢复不了就新建），否则新建；然后从事件库整理交给它的历史摘要：第一次用的来源拿整段对话（`full_thread_summary`），用过的只拿它错过的那段（`delta_since_target_last_seen`），没有要补的就不给。写 `session.handoff`（新旧两头、摘要与它覆盖的 `seq` 范围），会话原来是 `error` / `closed` 时同一事务里转 `idle`（`resumed`），只读随之解除；只读的会话因此可以换个来源接着用。摘要不进消息记录，随下一条消息的开头交给新引擎，那条消息的回合以 `interrupted` 以外的结局结束才算交付（否则再下一条接着带）。新引擎挂不上时回 `ENGINE_ERROR`、不写事件，会话还是原来的 Provider（原来的引擎会话已经关了，下次发消息时自动恢复）。`providerId` 与当前的相同时就是普通的换模型。刚接力、摘要还没交出去时 `session.fork` 回 `INVALID_STATE`。
- **权限模式 `permissionMode`**（0.11.0，Host 功能 `permission_modes`，domain-model §3.9）：`on_request`（请求批准，默认）、`auto_review`（自动批准：越界的操作由会话的模型审查）、`full_access`（完全访问：不用沙箱、不审批）。`session.create` 省略时是 `on_request`；`session.configure` 省略时不改，从下一个回合起生效。Host 的引擎声明了支持的模式时（Codex）会话与 `session.created` / `session.configured` 都带它；引擎不支持时（dsh）只接受省略或 `on_request`，会话不带这个字段，别的值回 `INVALID_PARAMS`（`data.issues` 的 path 是 `permissionMode`）。子 agent 的子会话沿用父会话当时的模式。
- **`question.respond`**（0.10.0，Host 功能 `user_questions`）：回答引擎提的一组问题（`question.requested`）。`answers` 按问题 ID，每题是选中的选项 `label` 或自己填的文本（问题 `allowOther` 时），可多个（问题 `multiSelect` 时）；省略或空数组的题当作跳过。Host 交给引擎后写 `question.resolved`（`answered`，`resolution` 带回答与回答者），结果同它。已经结束的问题（别的客户端答过、随回合取消）照样返回它的结局，不报错；没有这组问题回 `QUESTION_NOT_FOUND`。问题等回答期间会话仍是 `running`，`Session.awaitingInput` 为 true；回合被取消、会话关闭、引擎退出、Host 退出或重启时，未答的问题以 `cancelled` 结束（原因同审批）。
- **`session.send`**：会话是 `running` / `awaiting_approval` / `cancelling` 时，带 `delivery`（0.8.0）就成为待发消息（领域模型 §3.3.2、§4.6）：`'steer'` 插话，等当前这一步结束插进本回合，引擎不支持或拒绝时转为排队；`'queue'` 排队，回合结束后作为下一个回合发出。这时结果是 `{pendingId, seq}`（`pending.added` 的 `seq`），没有 `turnId`。不带 `delivery` 时回 `SESSION_BUSY`（`data` 带 `state` 与 `activeTurn`），不排队、不打断（旧客户端的行为不变）；`error` / `closed` 时回 `INVALID_STATE`（`data.state`），先 `session.resume`。`idle` 时接受（`delivery` 不起作用），结果是新回合的 `turnId` 和这次 `user.message` 的 `seq`。`clientMessageId` 是幂等键，检查排在状态检查之前：同一会话里同一 ID、同样的 `content` 重发，返回原结果，不再发给引擎（不论会话现在处于什么状态，也不论那个回合后来怎样）；同一 ID、不同 `content` 回 `CLIENT_MESSAGE_CONFLICT`。send 前的自动 resume 失败回 `ENGINE_ERROR`（`category: session_unavailable`），工作区目录已不存在回 `WORKSPACE_PATH_INVALID`（不调引擎、状态不变）。会话只读（0.3.0，`session.readOnly`，引擎会话恢复不了）时回 `INVALID_STATE`，`data.readOnly` 给出原因与引擎原文，客户端据此提示“基于历史新建会话”，不要再提示 resume。Host 接受之后引擎拒收（适配器调用失败）时仍返回本回合的 `turnId` 与 `seq`：消息已被 Host 接受，失败经 `engine.error` 与 `session.state_changed`（→ `error`）送达，重发同一 `clientMessageId` 也返回这个结果（领域模型 §4.3）。子会话（0.6.0）是只读的，由父 agent 驱动：回 `INVALID_STATE`，`data.parentSessionId` 是父会话（幂等检查照样在前）。0.28.0 起 `content` 可以有图片（`type: 'image'`，`image.upload` 的结果），只有图片、没有文字也可以：一条消息最多 `IMAGE_MAX_PER_MESSAGE`（10）张；会话的引擎与模型不收图片时回 `INVALID_PARAMS`（Provider 的模型列表标了 `supportsImages: false`，或适配器的 `acceptsImages` 回答不收：Codex 要模型标了 `supportsImages`，dsh 不收），图片不存在回 `IMAGE_NOT_FOUND`，都不写事件。`pending.update` 的 `content` 同样。 0.36.0 起可以带 `collaborationMode`（Host 功能 `plan_mode`，domain-model §3.17）：`plan` 让这个回合在计划模式里跑，记在 `user.message` 的 `collaborationMode` 上，回合里给出的计划是 `plan.proposed`；省略或 `default` 照常（`user.message` 不带这个字段）。模式按消息给，不是会话的设置；会话的 `collaborationMode` 是最近一条消息的。会话当前的 Provider 交给的引擎没有计划模式（`engineFeatures` 的 `planMode`）时回 `INVALID_PARAMS`（`path: ['collaborationMode']`），不写事件。带 `delivery` 成为待发消息时，模式记在待发消息上：排队的作为回合发出时用它，插话插进进行中的回合，沿用回合的模式。幂等的指纹在 `plan` 时连同模式一起算（同一 `clientMessageId` 换了模式回 `CLIENT_MESSAGE_CONFLICT`），默认模式的照旧只算内容。
- **`pending.update`**（0.8.0）：改一条待发消息的内容（`content`）或方式（`delivery`），返回改后的 `pending`，同时写 `pending.updated`。排队的与暂停的可以改内容；排队的改成插话时，回合进行中且引擎支持就交给引擎，否则保持排队并在 `fallback` 里说明原因。已交给引擎的插话、暂停的改成插话、已到终态的回 `PENDING_NOT_EDITABLE`（`data` 带 `pendingId`、`status`、`delivery`）。规则全表见领域模型 §4.6。
- **`pending.cancel`**（0.8.0）：删掉一条排队的或暂停的待发消息（`cancelled`），返回它；已取消的成功、无操作；已交给引擎的插话、已插入或已发出的回 `PENDING_NOT_EDITABLE`。
- **`pending.resume`**（0.8.0）：让这个会话所有暂停的待发消息继续（转为等待），返回会话当前全部未到终态的待发消息。会话 `idle` 时随后立即发出第一条，活动中时等这个回合结束；`error` / `closed` 回 `INVALID_STATE`，先 `session.resume`。没有暂停的消息时成功、无操作。
- **`image.upload` / `image.read`**（0.28.0，Host 功能 `user_images`，domain-model §3.3.3）：消息里的图片。`image.upload` 带 base64 的 `data`（解码后不超过 `IMAGE_MAX_BYTES`，10 MiB，同 T3 Code）、`mimeType` 与可选的原文件名 `name`；Host 按文件头认格式（png、jpeg、gif、webp，以文件头为准，认不出回 `INVALID_PARAMS`）、读出像素，写进数据目录的 `images/staged/`，返回 `image`（`UserImagePart`：`imageId`、`mimeType`、`size`、`width?`、`height?`、`name?`）。客户端把它原样放进 `session.send` 或 `pending.update` 的 `content`；消息被接受时 Host 以自己记下的为准（客户端给的元数据不作数），把图片挪到 `images/`，之后一直留着（事件里引用它）。没有发出去的过一天删掉。`image.read` 从 `offset`（默认 0）起最多读 `IMAGE_READ_CHUNK_BYTES`（4 MiB，base64 之后仍在发送缓冲之内）；`offset + 解码后的长度 < size` 时接着读，`offset` 不小于 `size` 回 `INVALID_PARAMS`。暂存的与已发出的图片都能读。
- **`web.get` / `web.update` / `web.test`**（0.34.0，Host 功能 `web_tools`，[web-tools.md](./web-tools.md)）：Agent 联网工具的设置。`WebSettings` 是 `enabled`（联网工具开着没有）、`searchService`（`web_search` 用的服务 ID）与 `services`（Host 支持的搜索服务，按显示顺序，每个带 `hasKey`）；服务 ID 是开放字符串（`bocha`、`tavily`），客户端不认识的按 ID 显示。`web.update` 只改给出的字段：`searchService` 与 `key.service` 要是 `services` 里的一个；`key.apiKey` 是字符串时去掉首尾空白后存进 Host 的密钥存储（不能为空），`null` 删掉；Key 不出现在任何结果、事件与日志里。`web.test` 用一次真实的搜索测服务（省略时当前选中的）与 Key（给了 `apiKey` 就用它，不保存；没有 Key 时不发请求，回 `reason: 'missing_key'`），失败按 `WebTestFailure` 归类（`missing_key`、`auth`、`quota`、`rate_limited`、`network`、`timeout`、`server`、`invalid_response`、`unknown`），`message` 是服务端原文（Key 换成 `***`）。设置在工具调用时立即生效；Codex 的会话登记哪些工具在会话开始或恢复时按当时的设置定。Host 没有联网服务时三个方法回 `INVALID_PARAMS`，也不声明 `web_tools`。
- **`settings.get` / `settings.update`**（0.8.0）：Host 设置（领域模型 §3.7），CLI 与桌面共用。`settings.update` 只改给出的字段，返回改后的全部设置；值变了时 Host 给每个调用过 `settings.*` 的连接（含发起者）发 `settings.updated`。目前只有 `sendWhileBusy`：回合进行中按发送的默认方式（`steer` / `queue`，默认 `steer`），客户端据此给 `session.send` 填 `delivery`。
- **`session.cancel`**：幂等，非活动状态下成功、无操作（领域模型 §4.2）。Host 等到回合结算（`turn.finished` 已写入），或判定无法确认（会话转 `error`，取消时限 5 s）才返回；结算细节以事件为准。0.6.0：同时取消这个会话所有活动中的子会话（递归，父会话空闲时也是），等它们一并结算（领域模型 §4.5：Codex 取消父回合时不动子 agent，由 Host 级联）。对子会话本身：0.14.0 起（Host 功能 `subagent_cancel`，U21）照样取消它的回合（domain-model §4.5 C6），连同它自己的子会话，父会话不受影响，适配器能告诉父 agent 时告诉它；更早的 Host 回 `INVALID_STATE`（`data.parentSessionId`）。
- **`session.close`**：活动中的会话先取消再关闭（领域模型 §4.1 #14）；已关闭时成功、无操作。0.6.0：活动中的子会话同 `session.cancel` 一并取消，但不关闭（历史照常可读）；对子会话本身回 `INVALID_STATE`（子会话由父 agent 关闭）。
- **`session.resume`**：`error` / `closed` 时恢复为 `idle`，其余状态成功、无操作；返回最新的 `session`。成功时先写 `session.resumed`（0.3.0，带引擎版本），引擎不回放历史，历史以事件库为准。Provider 已被删除回 `PROVIDER_NOT_FOUND`；工作区目录已不存在回 `WORKSPACE_PATH_INVALID`（不写事件）；引擎拒绝回 `ENGINE_ERROR`（同时追加一条 `engine.error` 事件，状态不变）。引擎会话恢复不了（会话日志被删除、格式不兼容或损坏）时另写 `session.read_only`，会话带上 `readOnly`；只读会话仍可以 resume，引擎找回会话时成功并解除只读（领域模型 §4.4）。对子会话回 `INVALID_STATE`（0.6.0）：子会话在父 agent 又用到它时由 Host 重新挂上（领域模型 §4.5 C5）。
- **`approval.respond`**：`optionId` 必须是该审批 `options` 里的一个，否则 `INVALID_PARAMS`，审批不变。首个决定生效；审批已不是 `pending` 时回 `ALREADY_DECIDED`，`data` 带既有的 `status` 与 `resolution`（领域模型 §5）。提交给引擎失败时会话转 `error`，审批结为 `cancelled`（`engine_exited`），同样回 `ALREADY_DECIDED`（领域模型 §4.3）。子会话的审批（0.6.0）属于子会话，`approvalId` 取自子会话的事件流，或父会话快照与 `subagent.*` 事件里摘要的 `pendingApprovals`；任何连接都能回，不论它订阅的是父会话还是子会话，首个决定生效（领域模型 §5 第 8 条）。
- **`browser.register` / `browser.unregister` / `browser.respond` 与通知 `browser.request`**（0.33.0，Host 功能 `browser_tools`，domain-model §3.15.1）：内置浏览器在桌面端的主进程里，Host 经这条反向通道把会话里的 agent 调的 `browser_*` 工具交给它。`browser.register` 把这条连接登记为浏览器提供方，`commands` 是它会的命令（`BROWSER_COMMANDS`，Host 只发它声明过的，认不出的名字忽略）；再调一次替换，连接关闭即注销。Host 发 `browser.request`（`requestId` 是 `brq_` 开头的 ID，`sessionId` 是调工具的会话，`cwd` 是它的目录，`command` 是 `BrowserCommand`），提供方执行后用 `browser.respond` 回答：`ok: true` 带 `result`（`BrowserResult`，与命令同名），`ok: false` 带 `error`（`code` 是开放字符串，已知的在 `BROWSER_ERROR_CODES`；`message`；`retryable?`），可带执行期间自动处理掉的对话框 `dialogs`。结果 `accepted: false` 表示这个请求已经超时、被取消（引擎取消了工具调用）或不是交给这条连接的，回答被丢掉。新开标签页交给最近登记的提供方，带 `browserId` 的交给开出这个标签页的那个；提供方断开时在途的请求以 `browser_no_host` 结束（Paseo 的 BrowserToolsBroker）。没有提供方时工具明确返回不可用。没有 `browser_tools` 的 Host 上这三个方法照常回 `{}` / `accepted: false`，登记不生效。
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
- client-sdk 的 `subscribe()` 按以上规则实现（T4.1）：订阅结果在收到它的那一帧里同步登记 `subscriptionId`（`ws` 会在同一轮里连续派发多帧，等 Promise 回调再登记会把紧随其后的事件误判为缺口）；断线重连后以已应用的最大 `seq` 续订；重新订阅时遇到 `HOST_SHUTTING_DOWN` 不结束订阅，等重连；在同一个 `seq` 上连续重新订阅 3 次仍没有进展（Host 每次在这里都发同样不合协议的东西）时，以 `ProtocolError` 结束订阅，不无限重试。

**子会话的事件在哪个流里**（0.6.0，领域模型 §3.3.1）：子会话有自己的事件流（`seq` 从 1 起），子 agent 的回合、增量、工具、审批都写在那里，按子会话的 `sessionId` 订阅；父会话的事件流里只有 `subagent.started`（派出了一个子会话）与 `subagent.updated`（它的标题、状态、未决审批变了，每次带完整摘要）。界面在父会话里显示子会话的开始与完成、来自子会话的审批，只订阅父会话就够；打开子 agent 视图时再订阅子会话。子会话的审批只在子会话的流里有 `approval.requested` / `approval.resolved`，父会话的流里是摘要的 `pendingApprovals` 跟着变。

## 5. 事件类型

信封字段：`seq`（会话内从 1 开始连续递增）、`sessionId`、`ts`（Host 追加时间）、`type`、`source`（`host` / `engine`）、`payload`。各类型的 payload 字段、来源与触发时机见[领域模型](./domain-model.md) §6；代码在 `EventPayloadSchemas`。

<!-- registry:events -->
| `type` | `source` |
|---|---|
| `session.created` | host |
| `session.resumed` | host |
| `session.read_only` | host |
| `session.title_changed` | host |
| `session.goal_changed` | engine |
| `session.configured` | host |
| `session.handoff` | host |
| `session.state_changed` | host |
| `user.message` | host |
| `turn.started` | host |
| `turn.finished` | host |
| `turn.rewound` | host |
| `assistant.delta` | engine |
| `assistant.stream_ended` | engine |
| `assistant.message` | engine |
| `assistant.thought` | engine |
| `tool.started` | engine |
| `tool.updated` | engine |
| `tool.finished` | engine / host |
| `todo.updated` | host |
| `plan.proposed` | engine |
| `plan.delta` | engine |
| `approval.requested` | engine |
| `approval.resolved` | host |
| `question.requested` | engine |
| `question.resolved` | host |
| `usage.updated` | engine |
| `context.compacting` | engine |
| `context.compacted` | engine |
| `engine.error` | engine / host |
| `engine.raw` | engine |
| `subagent.started` | host |
| `subagent.updated` | host |
| `tasks.suggested` | host |
| `task.started` | host |
| `task.reported` | host |
| `pending.added` | host |
| `pending.updated` | host |
| `user.steered` | host |
| `ui.show` | host |
| `file.shared` | host |

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
| `PendingMessageId` | `pnd_` | Host |
| `ImageId` | `img_` | 数据目录（0.28.0，消息里的图片） |
| `BrowserRequestId` | `brq_` | Host（0.33.0，交给浏览器提供方的请求，只在内存里） |

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
| `PENDING_NOT_FOUND` | -32014 | 待发消息不存在，或不属于这个会话（0.8.0） | |
| `QUESTION_NOT_FOUND` | -32015 | 没有这组问题，或它不属于这个 Host 上的会话（0.10.0） | |
| `ENVIRONMENT_NOT_FOUND` | -32016 | 没有这个环境（0.15.0） | |
| `IMAGE_NOT_FOUND` | -32017 | 没有这张图片（0.28.0） | |
| `INVALID_STATE` | -32020 | 会话当前状态不允许该操作（`error` / `closed` 时 send；子会话不接受客户端的 send、cancel、close、resume） | `state, readOnly?, parentSessionId?` |
| `SESSION_BUSY` | -32021 | 会话有进行中的回合 | `state, activeTurn?` |
| `ALREADY_DECIDED` | -32022 | 审批已结算 | `approvalId, status, resolution` |
| `CLIENT_MESSAGE_CONFLICT` | -32023 | 同一 `clientMessageId` 的请求体不同 | `clientMessageId` |
| `RESOURCE_IN_USE` | -32024 | 被未关闭的会话引用，不能移除 | `sessionIds` |
| `PENDING_NOT_EDITABLE` | -32025 | 待发消息现在不能这样改：插话已交给引擎、暂停的不能改成插话、已到终态（0.8.0） | `pendingId, status, delivery` |
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

客户端遇到 4003、4004 不要自动重连（重连也会失败），提示用户升级或重新读取 `host.json`；其余情况按退避重连。client-sdk（T4.1）的做法：4003 进入 `closed`；4004 在端点固定时同样进入 `closed`，端点由解析函数提供时（Node 入口每次连接前重读 `host.json`，桌面每次向主进程要）按慢速退避重试，Host 重启换了令牌也能连上（§12）。

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

`0.26.0`：`ProviderCompat` 加 optional 的布尔字段 `geminiToolSchema`，只有 Codex 网关的 Chat 转换使用，默认关闭，dsh 接受但忽略（model-gateway.md §4.5）。不加能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧 schema 忽略此字段，编辑 Provider 时整体替换 compat 会清掉它，回到关闭状态；新客户端连旧 Host：旧 Host 丢掉此字段，不能启用清洗，仍可连接。冻结样本 `compat/0.26.0.json`，旧样本不改。

`0.21.0`：服务账号认证的 `google-vertex` Provider。`ProviderProfile.vertex` 与新 upsert 分支的 `vertex`、`serviceAccountJson` 都是 optional；vertex 内 project 必填、location optional（默认 global）。Host 写入时要求有效 project、Chat 或 Messages 协议、至少一个匹配发布方的模型；不使用自定义 baseURL，地址由网关生成。serviceAccountJson 只进 SecretStore，响应、日志、事件不返回它；省略保留、字符串替换、null 删除，hasSecret 沿用。新 Host 服务旧客户端：未声明 provider_kind_google_vertex 时 provider.list 隐藏此 kind，已有会话照常列出；新客户端连旧 Host：没有 google_vertex 功能就禁用 Vertex 入口，不发送新 kind。最低版本仍为 0.1.0，冻结样本 compat/0.21.0.json，旧样本不改。

`0.22.0`：工作区的文件。新方法 `workspace.files`、`workspace.listDir`、`workspace.readFile`；新类型 `WorkspaceEntry`、`WorkspaceEntryKind`、`PreviewImageMimeType`；Host 功能 `workspace_files`。新方法与新类型，`unavailable` 是开放字符串，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调新方法。新客户端连旧 Host：hello 结果里没有 `workspace_files`，桌面端不提供文件窗格，输入框的 @ 不弹出文件列表。冻结样本 `compat/0.22.0.json`。

`0.23.0`：会话改名与归档。新方法 `session.rename`、`session.archive`；`session.list` 加 optional 的 `archived`，`Session` 加 optional 的 `archivedAt`；Host 功能 `session_rename`、`session_archive`；存储 0009_session_archive。行为变化：`session.list` 默认不再列出已归档的会话——只有新方法能归档，旧客户端看不到的只是别的客户端归档掉的会话。新方法与 optional 字段，不需要能力位，最低版本仍为 0.1.0。新客户端连旧 Host：hello 结果里没有这两个功能，桌面端不显示改名、归档与“已归档”设置页。冻结样本 `compat/0.23.0.json`。

`0.24.0`：压缩上下文与代码审查（domain-model §4.7）。新方法 `session.compact`、`session.review`；新类型 `ReviewTarget`、`TurnCommand`、`CompactionTrigger`；`turn.started` 加 optional 的 `command`；新事件 `context.compacting`、`context.compacted`；Host 功能 `session_compact`、`session_review`。行为变化：普通会话里也会有不带 `user.message` 的回合（之前只有子会话）。新方法、新事件与 optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调新方法；别的客户端开的命令回合在它那里是没有用户消息的回合（只有回答），两种新事件按规则 5 跳过。新客户端连旧 Host：hello 结果里没有这两个功能，桌面端不列 `/compact` 与 `/review`。冻结样本 `compat/0.24.0.json`。

`0.25.0`：接力（domain-model §3.14，ADR-0005 补记 14）。`session.configure` 加 optional 的 `providerId`；新事件 `session.handoff`；`Session` 加 optional 的 `engines`（新类型 `SessionEngine`）；`host.hello` 的结果加 optional 的 `engineFeatures`（新类型 `EngineFeatures`、`HandoffStrategy`，后者是开放字符串）；Host 功能 `session_handoff`。新事件与 optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端忽略 `session.handoff`（规则 5），会话的 `providerId`、`modelId` 在它下次读会话时更新；它不带 `providerId`，换模型照旧只在同一个 Provider 里。新客户端连旧 Host：hello 结果里没有 `session_handoff`，桌面端的模型选择里别的来源照旧不能选（旧 Host 会丢掉 `providerId`、按当前 Provider 校验模型，所以不能不看功能位就发）。冻结样本 `compat/0.25.0.json`。

`0.27.0`：会话能用的命令。新类型 `SessionCommand`（`compact`、`review`）；`EngineFeatures` 加 optional 的 `commands`：这种 Provider 的引擎会的命令（还要 Host 声明 `session_compact` / `session_review`）。0.27.0 起的 Host 总是给，引擎一个都不会时是空数组。optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧 schema 忽略多出的字段，旧桌面端照旧按 Host 功能列 `/compact` 与 `/review`，引擎不会时发出去才被拒绝（`INVALID_STATE`）。新客户端连旧 Host：`engineFeatures` 或其中的 `commands` 没有时只看 Host 功能（同 0.24.0）。冻结样本 `compat/0.27.0.json`。

`0.28.0`：消息里的图片（domain-model §3.3.3）。`UserContentPart` 加 `image` 变体（新类型 `UserImagePart`、`UserImageMimeType` 与 ID `img_`）；新方法 `image.upload`、`image.read`；新错误码 `IMAGE_NOT_FOUND`（-32017）；Host 功能 `user_images`；客户端能力位 `user_images`。给已有的判别联合加了变体，`user.message`、`user.steered`、`turn.started.input`、`pending.*` 与快照的待发消息都可能带它，所以用能力位门控：没有声明 `user_images` 的连接收到的事件与结果里，图片换成文本 `[image]`（段数不变）。最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端看到 `[image]`，照常解析；它发的消息没有图片。新客户端连旧 Host：hello 结果里没有 `user_images`，桌面端不显示“图片”、不接受粘贴与拖放的图片。冻结样本 `compat/0.28.0.json`。

`0.29.0`：上下文用量的自动压缩线。`usage.updated` 与快照的 `usage` 加 optional 的 `autoCompactAt`：已用量（`contextUsed`）到这个数时引擎自己压缩上下文。Codex 引擎经网关的模型报上下文窗口的九成（Provider 模型没填 `contextWindow` 时按 128k，codex-event-mapping.md §3），ChatGPT 登录的模型与其他引擎不报。optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧 schema 忽略这个字段。新客户端连旧 Host：收不到它，桌面端的用量表不画自动压缩的线。冻结样本 `compat/0.29.0.json`。

`0.30.0`：应用级工具（domain-model §3.15）。新事件 `ui.show`（新类型 `UiShowTarget`）；`user.message`、`user.steered` 与 `PendingMessage` 加 optional 的 `from`（新类型 `MessageFrom`：别的会话发来的消息或回报）；`Session` 与 `session.created` 加 optional 的 `openedBy`（新类型 `SessionOpenedBy`）；`EngineFeatures` 加 optional 的 `appTools`；Host 功能 `app_tools`；Host 的 HTTP 服务多了 `POST /mcp`（§1）。agent 开出的会话不改 `origin`：它的 `kind` 是字面量 `suggested_task`，旧客户端解析不了新的值，所以另加 `openedBy`。新事件与 optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端忽略 `ui.show`（规则 5）与新字段，别的会话发来的消息与回报在它那里是普通的用户消息（回报的正文是给模型看的英文说明）。新客户端连旧 Host：hello 结果里没有 `app_tools`，收不到这些事件与字段，不需要降级。冻结样本 `compat/0.30.0.json`。

依据 Paseo 的兼容纪律（Paseo 研读 §2.3、§2.4；ADR-0002 §2）。目标：半年前的客户端能连新 Host，半年前的 Host 能服务新客户端（同一主版本内）。改 `packages/protocol` 的提交要在说明里回答这两个问题。

**版本**

- `PROTOCOL_VERSION` 是 `主.次.修订` 三段的 semver，不带预发布标签。主版本不同即不兼容，Host 拒绝 hello；同一主版本内次版本只增不减、向后兼容；修订号只用于不改变线缆形状的修正。
- 版本历史：`0.1.0`（T1.2，基线）；`0.2.0`（T3.4）：`ProviderModel` 加 `maxTokens`、`supportsImages`、`reasoningEfforts`，`provider.test` 结果加 `reason`、`httpStatus`，全部 optional，`MIN_PROTOCOL_VERSION` 仍是 `0.1.0`。新 Host 服务 0.1.0 客户端：多出的字段被旧 schema 忽略（规则 5）；0.2.0 客户端连旧 Host：旧 Host 不发这些字段，客户端按 optional 处理。`0.3.0`（T3.5）：新事件类型 `session.resumed`、`session.read_only`，`session.created` 加 `engineVersion`，`Session` 加 `readOnly`，`INVALID_STATE` 的 `data` 加 `readOnly`，全部是新类型或 optional 字段，没有给已有类型加枚举值，不需要能力位；`session.send` 与 `session.resume` 可能多回 `WORKSPACE_PATH_INVALID`（已有错误码）。新 Host 服务旧客户端：旧客户端忽略两种新事件（规则 5，照常推进 `lastSeq`）与新字段，只读会话在它看来是普通的 `error`，send 回 `INVALID_STATE`、resume 回 `ENGINE_ERROR`；0.3.0 客户端连旧 Host：收不到这些事件与字段，按 optional 处理。`0.4.0`（ADR-0005 补记 7）：`ProviderCompat` 加 `supportsCustomTools`（布尔）与 `systemMessageMode`（`inline` / `merge` / `user`），只有 Codex 引擎的模型网关读它们，dsh 适配器接受但忽略；都是 optional 的新字段，不需要能力位。新 Host 服务旧客户端：旧客户端的 schema 丢掉这两个字段（规则 5），它编辑 Provider 时不会带回，按 `provider.upsert` 整体替换的语义，这两个开关会被清掉；0.4.0 客户端连旧 Host：旧 Host 丢掉它们，网关按默认处理。`0.5.0`（R3，ADR-0005 补记 8）：`TitleSource` 加 `generated`（会话的模型生成的标题，prompts/thread-title.md）——给已有类型加枚举值，按下面的规则用能力位 `title_source_generated` 门控：没有声明它的连接，`session.title_changed` 事件与 `session.create` / `session.get` / `session.list` / `session.resume` 结果里的 `generated` 换成 `first_prompt`（`rpc-connection.ts` 的 `adaptEventForClient` / `adaptResultForClient`），标题本身照发；`session.title_changed` 加 optional 的 `description`（检索摘要）；`engine.raw` 的 `protocol` 从字面量 `acp` 放开为非空字符串（Codex 引擎是 `codex-app-server`）。`engine.raw` 只是调试信息、不按能力位门控（§5），旧客户端的 schema 只认 `acp`，按 T4.1 的做法跳过不合 schema 的那几条（告警、照常推进 `lastSeq`），不影响别的事件。新 Host 服务旧客户端：标题来源降级，看到的仍是“自动标题”；0.5.0 客户端连旧 Host：收不到 `generated` 与 `description`，按 optional 处理。`0.6.0`（R4，ADR-0005 补记 9）：子会话。新类型 `SubagentStatus`、`SubagentInfo`、`SubagentSummary`；`Session` 加 optional 的 `parentSessionId` 与 `subagent`，`SessionSnapshot` 加 `subagents`；新事件类型 `subagent.started` / `subagent.updated`；`session.created` 加 `parent`、`turn.started` 加 `input`；`session.list` 的参数加 `parentSessionId`，并且默认不再列出子会话；`INVALID_STATE` 的 `data` 加 `parentSessionId`，`session.cancel` / `session.close` / `session.resume` 可能回它（已有错误码，只对子会话）。都是新类型、新事件或 optional 字段，没有给已有类型加枚举值，不需要能力位。新 Host 服务旧客户端：`session.list` 不给它子会话，它也就不会订阅子会话；它忽略父会话流里的两种新事件（规则 5），快照里的 `subagents` 被它的 schema 丢掉，看到的父会话与 0.5.0 相同（子 agent 的派出、等待仍是工具调用），只是看不到、也回不了子会话的审批（审批挂到父会话被取消为止，取消会级联到子会话）。0.6.0 客户端连旧 Host：旧 Host 不认 `parentSessionId`（schema 丢掉它）而返回全部会话，旧 Host 上本来没有子会话，结果相同；收不到新事件与字段，按 optional 处理。 `0.7.0`（R6，ADR-0005 补记 10）：ChatGPT 账号。`ProviderKind` 加 `chatgpt`——给已有类型加枚举值，用能力位 `provider_kind_chatgpt` 门控：没有声明它的连接，`provider.list` 的结果里去掉 `chatgpt` 类 Provider（`adaptResultForClient`），它也就选不到、改不了这个 Provider；会话里的 `providerId` 只是字符串，用它的会话照常列出。`provider.upsert` 的参数加 `chatgpt` 一支；新类型 `AccountKind`、`AccountLoginMethod`、`AccountLogin`、`AccountRateLimitWindow`、`AccountState`；新方法 `account.get` / `account.login` / `account.cancelLogin` / `account.logout`；新通知 `account.updated`，只发给调用过 `account.*` 的连接，旧客户端不会调，也就收不到（client-sdk 本来就忽略不认识的通知并告警）；Host 功能 `chatgpt_account`（`HOST_FEATURES` 从此不再为空，只列名字，值由 Host 按引擎在每次握手时给出）。新 Host 服务旧客户端：看不到 ChatGPT 的 Provider 与账号，用 ChatGPT 的会话在它那里照常显示与对话（Provider 名字认不出）；0.7.0 客户端连旧 Host：hello 结果没有 `chatgpt_account`，客户端不显示账号入口，不调这些方法。`0.8.0`（R11，ADR-0002 补记 8）：回合进行中发消息。新类型 `PendingMessage`（`PendingDelivery`、`PendingStatus`、`PendingFallbackReason`）与 `HostSettings`；`session.send` 的参数加 optional 的 `delivery`，结果的 `turnId` 改为 optional、加 `pendingId`（只有带 `delivery` 的请求才可能拿到没有 `turnId` 的结果）；新方法 `pending.update` / `pending.cancel` / `pending.resume`、`settings.get` / `settings.update`，新通知 `settings.updated`（只发给调用过 `settings.*` 的连接）；新事件 `pending.added` / `pending.updated` / `user.steered`，`user.message` 加 optional 的 `pendingId`，快照加 `pendingMessages`；新错误码 `PENDING_NOT_FOUND`、`PENDING_NOT_EDITABLE`；Host 功能加 `pending_messages`、`host_settings`。都是新类型、新方法、新事件或 optional 字段，没有给已有类型加枚举值，不需要能力位。新 Host 服务旧客户端：旧客户端不带 `delivery`，回合进行中照旧拿到 `SESSION_BUSY`；别的客户端加入的待发消息与插话的事件被它忽略（规则 5），它的消息流里看不到插话（模型看到了），排队发出的回合照常显示，快照的 `pendingMessages` 被它的 schema 丢掉。新客户端连旧 Host：hello 结果里没有 `pending_messages`，客户端回合进行中不提供插话与排队（仍是忙，旧 Host 也会丢掉 `delivery` 回 `SESSION_BUSY`）；没有 `host_settings` 时不读设置，按默认的插话。`0.9.0`（U8）：会话中换模型与推理档位。新方法 `session.configure`、新事件 `session.configured`、Host 功能 `session_configure`（引擎实现了适配器的 `configureSession` 时声明，目前只有 Codex）。都是新方法、新事件，没有给已有类型加枚举值，不需要能力位。新 Host 服务旧客户端：旧客户端不调新方法；别的客户端换了模型时它忽略 `session.configured`（规则 5），会话的 `modelId` 在它下次读会话时更新。新客户端连旧 Host：hello 结果里没有 `session_configure`，客户端不提供换模型（只显示当前的）。`0.10.0`（U11）：Agent 向用户提问。新类型 `UserQuestion`、`UserQuestionOption`、`QuestionAnswer`、`QuestionRequest`、`QuestionResolution`（原因同审批）；新事件 `question.requested` / `question.resolved`，快照加 `pendingQuestions`，`Session` 加 optional 的 `awaitingInput`；新方法 `question.respond`，新错误码 `QUESTION_NOT_FOUND`；Host 功能 `user_questions`（引擎实现了 `respondToQuestion` 时声明，目前只有 Codex）。都是新类型、新方法、新事件或 optional 字段，会话状态不加新值（等回答时仍是 `running`），不需要能力位。新 Host 服务旧客户端：它忽略两种新事件，看到的是一直在 `running` 的回合，答不了问题，只能停止回合（未答的问题随之取消）或由别的客户端回答。新客户端连旧 Host：hello 结果里没有 `user_questions`，不会收到问题。`0.11.0`（U15）：会话的权限模式。新类型 `PermissionMode`；`session.create` 与 `session.configure` 加 optional 的 `permissionMode`，`Session`、`session.created` 与 `session.configured` 的负载加 optional 的 `permissionMode`（省略即 `on_request`）；Host 功能 `permission_modes`（引擎声明了支持的模式时，目前只有 Codex）。都是 optional 字段，不需要能力位。新 Host 服务旧客户端：它忽略这个字段，建的会话是 `on_request`，看不到别的客户端改了模式。新客户端连旧 Host：hello 结果里没有 `permission_modes`，不提供选择。
- 协商（`negotiateProtocolVersion`）：主版本相同且客户端不低于 `minProtocolVersion` 才接受，协商结果取双方中较低的版本。Host 提高 `minProtocolVersion` 等于放弃更老的客户端，要在变更说明里写明。 `0.12.0`（P0a）：`ProviderCompat` 加 optional 的 `supportsNamespaceTools`（布尔）与 `toolChoice`（`any` / `auto_only`）。网关取 Provider 声明 > 地址默认 > 全局默认，dsh 接受但忽略；没有给已有枚举加值，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧 schema 忽略新字段，旧客户端整体编辑 Provider 会清掉它们；新客户端连旧 Host：旧 Host 丢掉新字段，网关继续按旧版默认行为。冻结样本 `compat/0.12.0.json`，旧版本文件不改。`0.13.0`（U18）：新方法 `workspace.git` 与新类型 `GitFileChange`、Host 功能 `workspace_git`；新方法、新类型，`GitFileChange.status` 是开放字符串而不是枚举，以后多出取值不算收窄，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调它。新客户端连旧 Host：hello 结果里没有 `workspace_git`，桌面端会话侧栏不显示分支与“变更”卡片。冻结样本 `compat/0.13.0.json`。`0.14.0`（U21）：`usage.updated` 与快照的 `usage` 加 optional 的 `totalTokens`（会话累计用掉的 token）；`session.cancel` 对子会话本身放开，Host 功能 `subagent_cancel`。新字段与放宽的行为，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端忽略 `totalTokens`，也不会对子会话发 cancel。新客户端连旧 Host：hello 结果里没有 `subagent_cancel`，桌面端不显示停止单个子智能体的按钮；收不到 `totalTokens`，不显示 token 数。冻结样本 `compat/0.14.0.json`。`0.15.0`（U22.1）：环境。新类型 `Environment`、`EnvironmentFolder`、`SessionWorktree` 与 ID `env_`；新方法 `environment.list / create / update / remove`；新错误码 `ENVIRONMENT_NOT_FOUND`（-32016）；`session.create` 加 optional 的 `environmentId`，`Session` 与 `session.created` 加 optional 的 `environmentId`、`extraRoots`、`worktrees`；Host 功能 `environments`。都是新类型、新方法或 optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调新方法，环境会话在它那里是普通会话（`cwd` 可能是 worktree 里的目录）。新客户端连旧 Host：hello 结果里没有 `environments`，桌面端不显示“选择环境”。冻结样本 `compat/0.15.0.json`。`0.16.0`（U23）：建议的后续任务（domain-model §3.11）。新类型 `SuggestedTask`、`SessionOrigin` 与 ID `tsk_`；新事件 `tasks.suggested`、`task.started`、`task.reported`；快照加 `suggestedTasks`；`session.create` 与 `Session` 加 optional 的 `origin`；Host 功能 `suggested_tasks`。都是新类型、新事件或 optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端忽略三种新事件（规则 5），看到的是一个普通的 MCP 工具调用；它不会带 `origin`。新客户端连旧 Host：hello 结果里没有 `suggested_tasks`，不会收到建议。冻结样本 `compat/0.16.0.json`。`0.17.0`（U23.1）：支线会话（domain-model §3.12）。新方法 `session.fork`；`Session` 与 `session.created` 加 optional 的 `forkedFrom`、`side`；`session.list` 不再列出支线会话（新会话种类，旧数据里没有）；Host 功能 `side_sessions`。新方法与 optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调新方法，也就不会有支线。新客户端连旧 Host：hello 结果里没有 `side_sessions`，桌面端不认 `/btw`（照原样发出）。冻结样本 `compat/0.17.0.json`。
- 协商（`negotiateProtocolVersion`）：主版本相同且客户端不低于 `minProtocolVersion` 才接受，协商结果取双方中较低的版本。Host 提高 `minProtocolVersion` 等于放弃更老的客户端，要在变更说明里写明。 `0.12.0`（P0a）：`ProviderCompat` 加 optional 的 `supportsNamespaceTools`（布尔）与 `toolChoice`（`any` / `auto_only`）。网关取 Provider 声明 > 地址默认 > 全局默认，dsh 接受但忽略；没有给已有枚举加值，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧 schema 忽略新字段，旧客户端整体编辑 Provider 会清掉它们；新客户端连旧 Host：旧 Host 丢掉新字段，网关继续按旧版默认行为。冻结样本 `compat/0.12.0.json`，旧版本文件不改。`0.13.0`（U18）：新方法 `workspace.git` 与新类型 `GitFileChange`、Host 功能 `workspace_git`；新方法、新类型，`GitFileChange.status` 是开放字符串而不是枚举，以后多出取值不算收窄，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调它。新客户端连旧 Host：hello 结果里没有 `workspace_git`，桌面端会话侧栏不显示分支与“变更”卡片。冻结样本 `compat/0.13.0.json`。`0.14.0`（U21）：`usage.updated` 与快照的 `usage` 加 optional 的 `totalTokens`（会话累计用掉的 token）；`session.cancel` 对子会话本身放开，Host 功能 `subagent_cancel`。新字段与放宽的行为，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端忽略 `totalTokens`，也不会对子会话发 cancel。新客户端连旧 Host：hello 结果里没有 `subagent_cancel`，桌面端不显示停止单个子智能体的按钮；收不到 `totalTokens`，不显示 token 数。冻结样本 `compat/0.14.0.json`。`0.15.0`（U22.1）：环境。新类型 `Environment`、`EnvironmentFolder`、`SessionWorktree` 与 ID `env_`；新方法 `environment.list / create / update / remove`；新错误码 `ENVIRONMENT_NOT_FOUND`（-32016）；`session.create` 加 optional 的 `environmentId`，`Session` 与 `session.created` 加 optional 的 `environmentId`、`extraRoots`、`worktrees`；Host 功能 `environments`。都是新类型、新方法或 optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调新方法，环境会话在它那里是普通会话（`cwd` 可能是 worktree 里的目录）。新客户端连旧 Host：hello 结果里没有 `environments`，桌面端不显示“选择环境”。冻结样本 `compat/0.15.0.json`。`0.16.0`（U23）：建议的后续任务（domain-model §3.11）。新类型 `SuggestedTask`、`SessionOrigin` 与 ID `tsk_`；新事件 `tasks.suggested`、`task.started`、`task.reported`；快照加 `suggestedTasks`；`session.create` 与 `Session` 加 optional 的 `origin`；Host 功能 `suggested_tasks`。都是新类型、新事件或 optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端忽略三种新事件（规则 5），看到的是一个普通的 MCP 工具调用；它不会带 `origin`。新客户端连旧 Host：hello 结果里没有 `suggested_tasks`，不会收到建议。冻结样本 `compat/0.16.0.json`。`0.17.0`（U23.1）：支线会话（domain-model §3.12）。新方法 `session.fork`；`Session` 与 `session.created` 加 optional 的 `forkedFrom`、`side`；`session.list` 不再列出支线会话（新会话种类，旧数据里没有）；Host 功能 `side_sessions`。新方法与 optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调新方法，也就不会有支线。新客户端连旧 Host：hello 结果里没有 `side_sessions`，桌面端不认 `/btw`（照原样发出）。冻结样本 `compat/0.17.0.json`。`0.18.0`：单独新开 worktree 的会话（domain-model §3.10）。新类型 `WorktreeMode`（`none` / `new`，`EnvironmentFolder.worktree` 也改用它，取值不变）；`session.create` 加 optional 的 `worktree`；Host 功能 `session_worktree`。optional 字段，会话上照旧记在 `worktrees`（不带 `environmentId`），不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不带这个字段，照旧在工作区目录里建会话；别的客户端这样建的会话在它那里是普通会话（`cwd` 是 worktree 里的目录）。新客户端连旧 Host：hello 结果里没有 `session_worktree`，桌面端的“此计算机”不能点开（旧 Host 会丢掉这个字段、在工作区目录里建会话，所以不能不看功能位就发）。冻结样本 `compat/0.18.0.json`。`0.19.0`：订阅来源（ADR-0005 补记 14，domain-model §3.6）。`ProviderKind` 与 `AccountKind` 加 `claude`、`cursor`、`opencode`、`grok`、`antigravity`（新类型 `SubscriptionKind`）——给已有枚举加值，用能力位 `subscription_kinds` 门控：没有声明它的连接，`provider.list` 与 `account.list` 的结果里去掉这些种类，也收不到它们的 `account.updated`；用它们的会话照常列出（`providerId` 只是字符串）。`AccountState` 加 optional 的 `planLabel`、`signIn`、`loginMethods`、`loginCommand`、`installed`、`version`、`executablePath`、`customPath`、`installCommand`、`installUrl`、`canInstall`、`installing`；`ProviderProfile` 加 optional 的 `enabled`；新方法 `provider.setEnabled`、`account.list`、`account.setPath`、`account.install`，`account.get` 加 optional 的 `refresh`；Host 功能 `subscription_sources`、`provider_enabled`。最低版本仍为 0.1.0。新 Host 服务旧客户端：看不到订阅来源的 Provider 与账号；停用的 Provider 在它那里照常列出（它的 schema 丢掉 `enabled`）。新客户端连旧 Host：hello 结果里没有这两个功能，桌面端只显示 ChatGPT 账号，不显示启用开关。冻结样本 `compat/0.19.0.json`。`0.20.0`：改动的 diff 与回合快照（domain-model §3.13）。新方法 `workspace.diff`、`workspace.diffFile`、`session.checkpoints`；新类型 `DiffSource`、`DiffFile`、`GitObjectId`、`TurnCheckpoint`；Host 功能 `workspace_diff`。Host 在每个回合前后给顶层会话的目录打快照（`refs/wevir/checkpoints/…`），不改事件与快照的形状。新方法与新类型，`DiffFile.status` 与 `omitted`、`unavailable` 都是开放字符串，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调新方法；快照照打，它看不到。新客户端连旧 Host：hello 结果里没有 `workspace_diff`，桌面端不提供“变更”窗格，回合下面的“N 个文件已更改”照旧展开过程。冻结样本 `compat/0.20.0.json`。

`0.31.0`：新增 `provider.discoverModels` 与 Host 功能 `provider_model_discovery`，不改已有类型与枚举，最低版本仍为 0.1.0；冻结样本 `compat/0.31.0.json`。旧客户端不调用新方法，新客户端连旧 Host 时隐藏发现操作并保留手动填模型。所有发现详情字段均 optional，旧 Profile 不迁移。provider.test 的 error 加 optional code（字符串或整数）供本地化提示；旧客户端忽略它。

`provider.discoverModels` 仅发现 Ollama：providerId 与 baseURL 二选一。providerId 从同一写锁下读取已存端点与 SecretStore 凭据，不允许同时带 apiKey 或另一个地址；未保存的表单带 baseURL 和可选 apiKey，凭据只在本次请求内存，不保存、不回显。modelId 可选，供会话只查询当前模型。只允许回环主机（localhost 固定解析为 127.0.0.1）或精确 HTTPS ollama.com，baseURL 路径必须 /v1，无 URL 凭据、查询参数或片段；拒绝重定向，不跟随 remote_host。只读固定的 /api/tags、POST /api/show 和本机 /api/ps，不触发模型加载或拉取。每次最多 64 个模型、两个详情请求并发，整个操作 15 s，每个响应最多 2 MiB（在解析前按字节计数并取消超限流）。不返回上游错误原文，reason 使用已有 ProviderTestFailure。

models 每项有 model（ProviderModel）及可选 capabilities、sizeBytes、parameterSize、quantization、remoteHost（只保留 origin）、maxContextWindow、contextSource（开放字符串 running / configured / cloud）、detailsAvailable。model.contextWindow 只在实际值已知时填写；本机 /api/ps 优先于 /api/show num_ctx，model_info 的模型最大值单列 maxContextWindow；Ollama Cloud 使用最大值。可用档位来自 thinking.values；缺元数据不猜测，只有布尔开关映射到 off / medium。仅返回固定结果，不保存 Provider 或事件。

`0.32.0`：文件预览与编辑。新方法 `workspace.fileUrl`、`workspace.writeFile`；`workspace.readFile` 的结果加 optional 的 `mtimeMs`；Host 功能 `file_preview`；Host 的 HTTP 服务多了 `GET /files/…`（§1）。新方法与 optional 字段，`unavailable` 是开放字符串，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调新方法、忽略 `mtimeMs`。新客户端连旧 Host：hello 结果里没有 `file_preview`，桌面端的文件窗格照 0.22.0 只读、只显示文本与图片，PDF、网页、音视频与 Office 文件只给“用默认应用打开”。冻结样本 `compat/0.32.0.json`。

`0.33.0`：内置浏览器（domain-model §3.15.1）。新方法 `browser.register`、`browser.unregister`、`browser.respond`，新通知 `browser.request`（Host 交给登记过的连接，线缆上仍没有 Host 发起的 JSON-RPC 请求，§1）；新类型 `BrowserCommand`、`BrowserResult`、`BrowserTabInfo`、`BrowserRequest`、`BrowserResponse` 等（`packages/protocol/src/browser.ts`，命令名、错误码、`controller`、对话框的类型与处理方式都是开放字符串）与 ID `brq_`；Host 功能 `browser_tools`。应用级工具里多了 `browser_*` 工具，`wevir_show` 的 `kind` 多了 `browser`（MCP 的工具参数，不是 Host API 的形状）。`UiShowTarget` 不变：显示网页经浏览器提供方（`show` 命令），不写 `ui.show`，所以不需要给判别联合加变体，也不需要能力位。新方法与新通知，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不登记，收不到 `browser.request`；agent 调浏览器工具得到“桌面端没开或太旧”。新客户端连旧 Host：hello 结果里没有 `browser_tools`，桌面端不登记（浏览器窗格照样能用，只是 agent 用不了）。冻结样本 `compat/0.33.0.json`。

`0.34.0`：Agent 的联网工具（[web-tools.md](./web-tools.md)）。新方法 `web.get`、`web.update`、`web.test`；新类型 `WebSettings`、`WebSearchServiceId`（开放字符串）、`WebTestFailure`、`WebTestResult`；Host 功能 `web_tools`。新方法与新类型，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调新方法，联网工具按 Host 里的设置照常工作（默认开着、搜索服务是博查、没有 Key 时只有网页抓取）。新客户端连旧 Host：hello 结果里没有 `web_tools`，桌面端的“设置 → 联网搜索”只显示后台服务不支持，CLI 的 `wevir web` 报方法不存在。冻结样本 `compat/0.34.0.json`。

`0.35.0`：会话目标（domain-model §3.16，ADR-0005 补记 20）。新方法 `session.setGoal`、`session.updateGoal`、`session.clearGoal`；新类型 `GoalStatus`、`SessionGoal`、`TurnTrigger`（`goal`）与常量 `GOAL_OBJECTIVE_MAX_CHARS`；新事件 `session.goal_changed`；`Session` 加 optional 的 `goal`，`turn.started` 加 optional 的 `trigger`，`EngineFeatures` 加 optional 的 `goals`；Host 功能 `session_goals`。行为变化：普通会话里会有引擎自己开的回合（没有 `user.message`，之前只有命令回合与子会话）。新方法、新事件与 optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调新方法，忽略 `session.goal_changed`（规则 5）与 `trigger`；别的客户端设的目标在它那里是一条普通消息，续跑的回合是没有用户消息的回合（只有回答）。新客户端连旧 Host：hello 结果里没有 `session_goals`，桌面端不列 `/goal`、“+”菜单里没有“目标”。冻结样本 `compat/0.35.0.json`。

`0.36.0`：计划模式（domain-model §3.17，ADR-0005 补记 21）。新类型 `CollaborationMode`（`default`、`plan`）；`session.send` 加 optional 的 `collaborationMode`；`user.message`、`PendingMessage` 与 `Session` 加 optional 的 `collaborationMode`；新事件 `plan.proposed`（`turnId`、`planId`、`text`）；`EngineFeatures` 加 optional 的 `planMode`；Host 功能 `plan_mode`。新事件与 optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不发 `collaborationMode`，回合照旧是默认模式；别的客户端开的计划回合在旧客户端里是普通的回合，计划（`plan.proposed`）按规则 5 被忽略，看不到计划卡片（Codex 的回答里已拆掉计划块）。新客户端连旧 Host：hello 结果里没有 `plan_mode`，桌面端不显示计划模式的入口（旧 Host 会丢掉 `collaborationMode`，所以不能不看功能位就发）。冻结样本 `compat/0.36.0.json`。

`0.37.0`：计划的流式预览（domain-model §3.17）。新事件 `plan.delta`（`turnId`、`planId`、`text`、optional 的 `restart`）：Codex 写计划时的增量，Host 与 `assistant.delta` 同一个缓冲、同一个 60 ms 窗口合并，同一 `planId` 的 `plan.proposed` 以全文替换。新事件，不需要能力位与 Host 功能，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端按规则 5 忽略 `plan.delta`，计划照旧在 `plan.proposed` 时整份出现。新客户端连旧 Host：没有 `plan.delta`，同上。冻结样本 `compat/0.37.0.json`。

`0.38.0`：分支到新会话与撤回最后一个回合（domain-model §3.18）。`session.fork` 的 `side` 变成 optional、加 optional 的 `turnId`；新方法 `session.rewind`；新事件 `turn.rewound`（`turnId`）；`EngineFeatures` 加 optional 的 `branch`、`rewind`；Host 功能 `session_branches`、`session_rewind`。放宽的参数、新方法、新事件与 optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端照旧只发 `side: true`；别的客户端分出的分支会话在它那里是普通会话，消息记录照常回放；撤回的回合在它那里还在（`turn.rewound` 按规则 5 被忽略），之后的消息接在后面。新客户端连旧 Host：hello 结果里没有这两个功能，桌面端不显示“分支到新会话”与“编辑”（旧 Host 要求 `side: true`，不带时回 `INVALID_PARAMS`）。冻结样本 `compat/0.38.0.json`。

`0.39.0`：不在项目里的会话（domain-model §3.1，照 Codex 桌面端的“不在项目中工作”）。`session.create` 的 `workspaceId` 变成 optional：省略时会话建在 Host 的“对话”工作区，每个会话一个新建的文件夹；新类型 `WorkspaceKind`（`chats`），`Workspace` 加 optional 的 `kind`；Host 功能 `chat_sessions`。放宽的参数与 optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端照旧带 `workspaceId`；别的客户端建的对话在它那里是一个叫 `Chats` 的项目里的普通会话（它的 schema 丢掉 `kind`），移除这个项目回 `INVALID_PARAMS`。新客户端连旧 Host：hello 结果里没有 `chat_sessions`，桌面端不显示“不在目录中工作”，没有项目时照旧先建项目（旧 Host 要求 `workspaceId`）。冻结样本 `compat/0.39.0.json`。

`0.40.0`：交给用户的文件（domain-model §3.15.2）。新事件 `file.shared`（`files`、`turnId?`）；新类型 `SharedFile` 与常量 `SHARED_FILES_MAX`（20）；Host 功能 `shared_files`。应用级工具里多了 `wevir_share_file`（MCP 的工具参数，不是 Host API 的形状），不用批准。新事件，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端按规则 5 忽略 `file.shared`，看不到文件卡片，agent 的回答照常；文件就在会话的文件夹里。新客户端连旧 Host：hello 结果里没有 `shared_files`，agent 没有这个工具，收不到这个事件，不需要降级。冻结样本 `compat/0.40.0.json`。

`0.41.0`：全局连接器与 skills（[plugins.md](plugins.md)、domain-model §3.19）。新增 plugins.list、connector.add / update / remove / setEnabled、skill.install / remove / setEnabled，通知 plugins.changed，Host 功能 plugins；EngineFeatures 新增 optional 的 mcpServers / skills。所有方法权限 host.manage；新客户端先看功能位，旧 Host 不支持时不发请求，旧客户端忽略新通知。密钥输入与结果用不同 schema，结果只含键名 / true，更新省略保留、null 删除。兼容的新增方法与 optional 字段，不需要客户端能力位，最低版本仍为 0.1.0。冻结 compat/0.41.0.json 是 0.40.0 全部样本加新样本。

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
- client-sdk 维护一份穷举的默认能力表（T4.1），CLI 与桌面继承。能力位表：

| 能力位 | 加入版本 | 声明了它的连接收到 | 没声明时 Host 的降级 |
|---|---|---|---|
| `title_source_generated` | 0.5.0 | `TitleSource` 的 `generated` | 换成 `first_prompt`（事件与会话的结果都换），标题本身不变 |
| `provider_kind_chatgpt` | 0.7.0 | `ProviderKind` 的 `chatgpt` | `provider.list` 的结果里去掉 `chatgpt` 类 Provider |
| `provider_kind_google_vertex` | 0.21.0 | `ProviderKind` 的 `google-vertex` | `provider.list` 隐藏这类 Provider |
| `subscription_kinds` | 0.19.0 | `ProviderKind` 与 `AccountKind` 的订阅来源（`claude`、`cursor`、`opencode`、`grok`、`antigravity`） | `provider.list` 与 `account.list` 的结果里去掉这些种类，不发它们的 `account.updated` |
| `user_images` | 0.28.0 | `UserContentPart` 的 `image` | `user.message`、`user.steered`、`turn.started.input`、`pending.added` / `pending.updated` 与 `session.get`、`pending.*` 结果里的图片换成文本 `[image]` |

**Host 功能（`features`）**

- Host 在 hello 结果里声明功能，客户端只在一处判断：要么启用功能，要么提示用户升级 Host；功能内部不写降级路径、不到处加防御分支。功能可能取决于 Host 用的引擎，`HOST_FEATURES` 只列名字：

| 功能 | 加入版本 | 声明了它的 Host 提供 |
|---|---|---|
| `chatgpt_account` | 0.7.0 | `account.*` 方法、`account.updated` 通知与 `chatgpt` 类 Provider（Codex 引擎） |
| `google_vertex` | 0.21.0 | 服务账号的 Gemini Chat 与 Claude Messages 变体（Codex 网关） |
| `pending_messages` | 0.8.0 | `session.send` 的 `delivery`、`pending.*` 方法、`pending.*` 与 `user.steered` 事件、快照的 `pendingMessages` |
| `host_settings` | 0.8.0 | `settings.get` / `settings.update` 与 `settings.updated` 通知 |
| `session_configure` | 0.9.0 | `session.configure` 与 `session.configured` 事件（Codex 引擎） |
| `user_questions` | 0.10.0 | `question.respond`、`question.*` 事件、快照的 `pendingQuestions` 与 `Session.awaitingInput`（Codex 引擎） |
| `permission_modes` | 0.11.0 | `session.create` / `session.configure` 的 `permissionMode`，会话与 `session.created` / `session.configured` 带它（Codex 引擎） |
| `workspace_git` | 0.13.0 | `workspace.git`（与引擎无关，0.13.0 起的 Host 都有） |
| `subagent_cancel` | 0.14.0 | 子会话本身可以 `session.cancel`（与引擎无关，0.14.0 起的 Host 都有） |
| `side_sessions` | 0.17.0 | 支线会话：`session.fork`，`Session` 与 `session.created` 的 `forkedFrom`、`side`（Codex、echo 引擎） |
| `suggested_tasks` | 0.16.0 | 建议的后续任务：`tasks.suggested` / `task.started` / `task.reported` 事件、快照的 `suggestedTasks`、`session.create` 的 `origin`（Codex、echo 引擎） |
| `environments` | 0.15.0 | `environment.*` 与 `session.create` 的 `environmentId`（与引擎无关；多文件夹的环境要引擎支持额外目录，Codex 与 echo 有） |
| `subscription_sources` | 0.19.0 | 订阅来源：`account.list`、`account.get` 的 `refresh`、`account.setPath`、`account.install` 与 `AccountState` 的安装字段（Host 有带账号的引擎时） |
| `provider_enabled` | 0.19.0 | `provider.setEnabled` 与 `ProviderProfile.enabled`（与引擎无关） |
| `provider_model_discovery` | 0.31.0 | `provider.discoverModels` 仅限 Ollama 回环地址或官方 Cloud（与引擎无关） |
| `workspace_diff` | 0.20.0 | `workspace.diff`、`workspace.diffFile`、`session.checkpoints` 与每个回合前后的快照（与引擎无关） |
| `workspace_files` | 0.22.0 | `workspace.files`、`workspace.listDir`、`workspace.readFile`（与引擎无关） |
| `session_rename` | 0.23.0 | `session.rename`（与引擎无关） |
| `session_archive` | 0.23.0 | `session.archive`、`session.list` 的 `archived`、`Session.archivedAt`（与引擎无关） |
| `session_compact` | 0.24.0 | `session.compact`、`turn.started` 的 `command`、`context.compacting` / `context.compacted` 事件（Codex、Claude、echo 引擎；会话所在的引擎不能压缩时 `INVALID_STATE`，0.27.0 起看 `engineFeatures` 的 `commands`） |
| `session_review` | 0.24.0 | `session.review`（Codex、echo 引擎；同上） |
| `session_handoff` | 0.25.0 | 接力：`session.configure` 的 `providerId`、`session.handoff` 事件、`Session.engines` 与 `host.hello` 的 `engineFeatures`（与引擎无关） |
| `user_images` | 0.28.0 | `image.upload`、`image.read` 与消息里的图片（引擎有 `acceptsImages` 时：Codex、Claude、Cursor、OpenCode、Grok、Antigravity、echo；dsh 没有） |
| `file_preview` | 0.32.0 | `workspace.fileUrl`（`GET /files/…` 的只读流式地址）、`workspace.writeFile` 与 `workspace.readFile` 的 `mtimeMs`（与引擎无关） |
| `app_tools` | 0.30.0 | 应用级工具（domain-model §3.15）：引擎会话挂上 Host 的 `wevir` MCP 服务；`ui.show` 事件、`user.message` 与待发消息的 `from`、`Session.openedBy`（Codex、Claude、Cursor、OpenCode、Grok、Antigravity、dsh 引擎；echo 没有，`engineFeatures` 的 `appTools` 按 Provider 说） |
| `browser_tools` | 0.33.0 | 内置浏览器（domain-model §3.15.1）：`browser.*` 方法与 `browser.request` 通知，应用级工具里的 `browser_*` 与 `wevir_show` 的 `browser`（有应用级工具时，同 `app_tools`） |
| `web_tools` | 0.34.0 | `web.get`、`web.update`、`web.test`；Host 带着联网服务启动时声明（`wevir-host` 总是带，与引擎无关；联网工具只挂在 Codex 上，web-tools.md §5） |
| `session_goals` | 0.35.0 | `session.setGoal`、`session.updateGoal`、`session.clearGoal`，`session.goal_changed` 事件，`Session.goal`，`turn.started` 的 `trigger`（Codex、echo 引擎；会话所在的引擎没有目标时 `INVALID_STATE`，看 `engineFeatures` 的 `goals`） |
| `plan_mode` | 0.36.0 | 计划模式：`session.send` 的 `collaborationMode`、`user.message` / 待发消息 / `Session` 的 `collaborationMode` 与 `plan.proposed` 事件（0.37.0 起写的时候还有 `plan.delta`；Codex、Claude、echo 引擎；`engineFeatures` 的 `planMode` 说哪种 Provider 的引擎有，没有时 `session.send` 回 `INVALID_PARAMS`） |
| `session_branches` | 0.38.0 | 分支到新会话：`session.fork` 不带 `side`、可带 `turnId`（Codex、echo 引擎；`engineFeatures` 的 `branch` 说哪种 Provider 的引擎能分支，没有时 `INVALID_STATE`） |
| `session_rewind` | 0.38.0 | 撤回最后一个回合：`session.rewind` 与 `turn.rewound` 事件（Codex、echo 引擎；`engineFeatures` 的 `rewind`，没有时 `INVALID_STATE`） |
| `session_worktree` | 0.18.0 | `session.create` 的 `worktree: 'new'`：不用环境，单独新开一个 worktree（与引擎无关，0.18.0 起的 Host 都有） |
| `shared_files` | 0.40.0 | 交给用户的文件：应用级工具 `wevir_share_file` 与 `file.shared` 事件（有应用级工具时，同 `app_tools`） |
| `plugins` | 0.41.0 | Host 全局连接器与 skills 注册表；注入支持另看 engineFeatures.mcpServers / skills |
| `chat_sessions` | 0.39.0 | 不在项目里的会话：`session.create` 可以不带 `workspaceId`，`Workspace.kind` 的 `chats`（与引擎无关，0.39.0 起的 Host 都有） |

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
| 不截断 | `assistant.*`、`user.message`、`todo.updated`、`plan.proposed`、`plan.delta` | 这些是对话内容本身；单条事件可能较大，不影响连接健康的判断（图片在事件里只是引用，0.28.0） |

先截字符串再判断整体，是为了让 `write` 一类工具的 `file_path` 等短字段在大段 `content` 被截断后仍然可用。客户端看到 `$truncated: true` 时按截断显示，不要把它当作工具的真实输入。

## 12. 连接健康

常量在 `limits.ts`（ADR-0002 §5，取自 Paseo A16）。

| 项 | 值 | 说明 |
|---|---|---|
| hello 超时 | `HELLO_TIMEOUT_MS` = 15 s | 连接建立后 15 s 内没完成 hello，以 `HELLO_TIMEOUT` 关闭 |
| 心跳 | `PING_INTERVAL_MS` = 10 s | client-sdk 每 10 s 发一次 `host.ping`；不用 WebSocket 协议层的 ping 帧（浏览器 API 发不了） |
| 租约 | `CONNECTION_LEASE_MS` = 45 s | Host 收到客户端的任何一帧都续租；45 s 什么都没收到，以 `LEASE_EXPIRED` 断开 |
| 发送缓冲 | `SEND_BUFFER_LIMIT_BYTES` = 8 MiB | 每条连接一个上限，超限只断这一条（`SEND_BUFFER_OVERFLOW`），不影响同一会话的其他订阅者 |

Host 不主动 ping 客户端。client-sdk 的请求超时、连接超时、心跳超时分开配置，默认值由 T4.1 定（`DEFAULT_TIMEOUTS`、`DEFAULT_BACKOFF`，均可覆盖）：

| 项 | 默认 | 说明 |
|---|---|---|
| 请求超时 | 60 s | 从调用起算，含断线期间排队等连接的时间，可按请求覆盖。最慢的是 `session.create` / `session.resume`（可能要拉起引擎）与 `provider.test`（一次真实的模型请求）；与 Paseo 客户端的默认 RPC 时限相同 |
| 连接超时 | 10 s | 一次连接尝试：解析端点、建立 WebSocket、完成 `host.hello`。只连 loopback，比 Host 的 hello 时限（15 s）短，客户端先放弃 |
| 心跳间隔 | 10 s | `PING_INTERVAL_MS` |
| 心跳超时 | 20 s | 超过这么久没有收到 Host 的任何一帧（`host.ping` 的响应、事件都算），放弃这条连接并重连；不等关闭握手，死连接上它可能很久都等不到。容忍一次 ping 没有回音，远小于 45 s 租约 |
| 重连退避 | 1 s 起翻倍、10 s 封顶；令牌被拒 5 s 起、60 s 封顶 | 连上即重置；`reconnectNow()`（例如桌面得知 Host 重启）重置退避并立即重试。首次连接失败不重试，直接报错 |

已发出的请求遇到断线以 `ConnectionLostError` 结束、不自动重发（结果未知；`session.send` 可以带同一个 `clientMessageId` 重发确认，§3.1）；断线期间发起的请求排队，重连后发出。

发送缓冲按“积压”计：ws 还没写到套接字的字节，加上补发期间排队等待发出的实时事件（§4 第 1 条）。Host 每次发帧前检查积压，已超过上限就不再发送、以 `SEND_BUFFER_OVERFLOW` 关闭；单个大帧本身不算超限（`assistant.*` 等事件不截断，§11），所以积压最多超出上限一帧。补发按批读取，并在积压达到上限的四分之一时等它写出再继续，补发本身不会触发超限。Host 主动关闭连接后最多等 2 s 的关闭握手，对方不回关闭帧就直接断开 TCP。
