# Wevir Host API v0

> 状态：v0（T1.2）· 协议版本 `0.23.0`（会话改名与归档；版本历史见 §10；最低兼容 `0.1.0`）· 日期：2026-10-15
> 依据：[ADR-0002](../adr/0002-host-transport-and-process-model.md)（协议部分以它为准）；[领域模型](./domain-model.md)；[Paseo 研读](../research/paseo-notes.md) §2（兼容纪律的出处）
> 代码：`packages/protocol`。方法注册表 `MethodSchemas`、通知注册表 `NotificationSchemas`、事件 `EventPayloadSchemas`、错误码 `ErrorCode`、关闭码 `CloseCode` 是唯一的定义；本文件的表格由 `host-api-doc.test.ts` 与代码逐项比对，改一边不改另一边测试就失败。
> 下游：T2.4（Host 侧执行）、T4.1（client-sdk）、T5.1（Origin 白名单写回本文件）

本文件定稿了领域模型里标为“草案”的错误码名（§9），以后以本文件为准。实体与事件 payload 的字段含义不在这里重复，见领域模型 §3、§6。

---

## 1. 传输

- JSON-RPC 2.0 over WebSocket，文本帧，一帧一个 JSON-RPC 对象（ADR-0002 §1）。**v0 不支持批量**：收到 JSON 数组时 Host 回一个 `INVALID_REQUEST`（`id: null`）；二进制帧同样回 `INVALID_REQUEST`（`id: null`）。
- 参数一律按名称传（对象）；方法没有参数时传 `{}`，省略 `params` 等同于 `{}`。请求 `id` 用字符串或整数，不用 `null`。
- 客户端只发请求；Host 只发响应和通知（v0 只有 `events.event`）。同一连接上可以连发多个请求，响应顺序不保证与请求一致，按 `id` 对应；同一会话的命令在 Host 内串行执行（ADR-0002 §4）。
- 端点 URL 与令牌从 `<数据目录>/run/host.json` 读取，客户端不自己拼地址、不回退到默认端口。WebSocket 升级时 Host 校验 `Host` 头（只允许 `127.0.0.1:<port>` 与 `localhost:<port>`，缺失也拒绝）与 `Origin`（不带 Origin 的放行，带 Origin 的只放行下表的白名单，精确匹配），不通过直接 403，不会走到 JSON-RPC 层。Host 优雅退出期间的升级请求回 503，不是升级的 HTTP 请求回 426。
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
| `workspace.readFile` | `workspace.read` | `workspaceId, sessionId?, path` | `path, size?, text?, image?, unavailable?` | `WORKSPACE_NOT_FOUND`、`WORKSPACE_PATH_INVALID`、`SESSION_NOT_FOUND`、`INVALID_PARAMS` |
| `provider.list` | `provider.read` | `{}` | `providers: ProviderProfile[]` | |
| `provider.upsert` | `provider.write` | 按 `kind` 区分，见下 | `provider, created` | |
| `provider.remove` | `provider.write` | `providerId` | `{}` | `PROVIDER_NOT_FOUND`、`RESOURCE_IN_USE` |
| `provider.test` | `provider.write` | `providerId, modelId?` | `ok, latencyMs?, error?, reason?, httpStatus?` | `PROVIDER_NOT_FOUND` |
| `provider.setEnabled` | `provider.write` | `providerId, enabled` | `provider` | `PROVIDER_NOT_FOUND` |
| `account.list` | `provider.read` | `{}` | `accounts: AccountState[]` | `ENGINE_ERROR` |
| `account.get` | `provider.read` | `kind, refresh?` | `account: AccountState` | `ENGINE_ERROR` |
| `account.login` | `provider.write` | `kind, method` | `account: AccountState` | `ENGINE_ERROR` |
| `account.cancelLogin` | `provider.write` | `kind, loginId?` | `account: AccountState` | `ENGINE_ERROR` |
| `account.logout` | `provider.write` | `kind` | `account: AccountState` | `ENGINE_ERROR` |
| `account.setPath` | `host.manage` | `kind, path` | `account: AccountState` | `ENGINE_ERROR` |
| `account.install` | `provider.write` | `kind` | `account: AccountState` | `ENGINE_ERROR` |
| `session.create` | `session.write` | `workspaceId, providerId, modelId?, reasoningEffort?, permissionMode?, environmentId?, worktree?, origin?` | `session` | `WORKSPACE_NOT_FOUND`、`PROVIDER_NOT_FOUND`、`ENVIRONMENT_NOT_FOUND`、`WORKSPACE_PATH_INVALID`、`ENGINE_ERROR` |
| `session.list` | `session.read` | `workspaceId?, parentSessionId?, archived?` | `sessions: Session[]` | `WORKSPACE_NOT_FOUND`、`SESSION_NOT_FOUND` |
| `session.get` | `session.read` | `sessionId` | `SessionSnapshot` | `SESSION_NOT_FOUND` |
| `session.configure` | `session.write` | `sessionId, modelId?, reasoningEffort?, permissionMode?` | `session` | `SESSION_NOT_FOUND`、`INVALID_PARAMS`、`INVALID_STATE`、`ENGINE_ERROR` |
| `session.send` | `session.write` | `sessionId, content, clientMessageId?, delivery?` | `turnId?, pendingId?, seq` | `SESSION_NOT_FOUND`、`SESSION_BUSY`、`INVALID_STATE`、`CLIENT_MESSAGE_CONFLICT`、`WORKSPACE_PATH_INVALID`、`ENGINE_ERROR` |
| `session.cancel` | `session.write` | `sessionId` | `{}` | `SESSION_NOT_FOUND`、`INVALID_STATE` |
| `session.close` | `session.write` | `sessionId` | `{}` | `SESSION_NOT_FOUND`、`INVALID_STATE` |
| `session.resume` | `session.write` | `sessionId` | `session` | `SESSION_NOT_FOUND`、`INVALID_STATE`、`PROVIDER_NOT_FOUND`、`WORKSPACE_PATH_INVALID`、`ENGINE_ERROR` |
| `session.fork` | `session.write` | `sessionId, side` | `session` | `SESSION_NOT_FOUND`、`INVALID_STATE`、`WORKSPACE_PATH_INVALID`、`ENGINE_ERROR` |
| `session.rename` | `session.write` | `sessionId, title` | `session` | `SESSION_NOT_FOUND`、`INVALID_PARAMS` |
| `session.archive` | `session.write` | `sessionId, archived` | `session` | `SESSION_NOT_FOUND`、`INVALID_PARAMS`、`ENGINE_ERROR` |
| `session.checkpoints` | `session.read` | `sessionId` | `repo, turns` | `SESSION_NOT_FOUND`、`WORKSPACE_PATH_INVALID` |
| `pending.update` | `session.write` | `sessionId, pendingId, content?, delivery?` | `pending` | `SESSION_NOT_FOUND`、`PENDING_NOT_FOUND`、`PENDING_NOT_EDITABLE` |
| `pending.cancel` | `session.write` | `sessionId, pendingId` | `pending` | `SESSION_NOT_FOUND`、`PENDING_NOT_FOUND`、`PENDING_NOT_EDITABLE` |
| `pending.resume` | `session.write` | `sessionId` | `pendingMessages` | `SESSION_NOT_FOUND`、`INVALID_STATE` |
| `question.respond` | `session.write` | `questionId, answers` | `questionId, status, resolution` | `QUESTION_NOT_FOUND`、`INVALID_PARAMS`、`ENGINE_ERROR` |
| `approval.respond` | `session.write` | `approvalId, optionId` | `approvalId, status, resolution` | `APPROVAL_NOT_FOUND`、`ALREADY_DECIDED` |
| `events.subscribe` | `session.read` | `sessionId, sinceSeq` | `subscriptionId, replayedThroughSeq` | `SESSION_NOT_FOUND` |
| `events.unsubscribe` | `session.read` | `subscriptionId` | `{}` | |

Host → 客户端的通知：

<!-- registry:notifications -->
| 通知 | params |
|---|---|
| `events.event` | `subscriptionId, event: WevirEvent` |
| `account.updated` | `account: AccountState`（0.7.0；只发给调用过 `account.*` 方法的连接；订阅来源只发给声明了 `subscription_kinds` 的连接） |
| `settings.updated` | `settings: HostSettings`（发给调用过 `settings.*` 的连接） |

### 3.1 各方法要点

- **`host.ping`**：心跳（§12），任何时候都可以发。
- **`host.shutdown`**：Host 先回 `{}`，再按 ADR-0002 §6 的顺序优雅退出，最后以 `GOING_AWAY` 关闭所有连接。退出期间到达的请求回 `HOST_SHUTTING_DOWN`。
- **`workspace.add`**：`rootPath` 必须是绝对路径、存在、是目录，否则 `WORKSPACE_PATH_INVALID`（`data.reason` 为 `not_absolute` / `not_found` / `not_directory` / `not_accessible`）。Host 取 realpath 去重：已有同一 realpath 的工作区（含曾被移除的）时返回它，`created: false`。
- **`workspace.remove`**：只注销，不删磁盘文件；有未关闭会话时回 `RESOURCE_IN_USE`，`data.sessionIds` 列出这些会话。
- **`environment.*`**（0.15.0，Host 功能 `environments`，domain-model §3.10）：保存的环境。`create` 的 `folders` 1–8 个、工作区不重复且都在，`name` 去掉首尾空白后 1–60 字，否则 `INVALID_PARAMS`；`update` 只改给出的字段；`remove` 不影响已经用它建的会话。按创建时间排列。
- **`workspace.git`**（0.13.0，Host 功能 `workspace_git`，U18）：工作区目录的 git 状态，给桌面端会话侧栏的“环境”（分支）与“变更”（+N −M）卡片。Host 每次调用时在工作区目录里现跑只读的 git 命令，不缓存、不写事件；客户端在回合结束、窗口获得焦点与定时（桌面端 10 s）时重读。目录不在 git 仓库里、本机没有 git、git 出错或超时（每条命令 5 s）都回 `repo: false`，其余字段省略。是仓库时：`branch` 是当前分支（含还没有提交的新分支）；分离头指针时没有 `branch`，`detachedAt` 是 HEAD 的短 SHA。改动按工作区目录统计（`git diff --relative`，工作区是仓库的子目录时只算这个目录里的）：已跟踪文件相对 HEAD（工作树 + 暂存区；还没有提交时是暂存区）的增删行数之和 `added` / `removed`，不跟踪重命名（重命名算一删一增）；`fileCount` 是改动的文件数，含未跟踪（`.gitignore` 之外的）文件；`files` 每项 `path`（相对工作区目录，`/` 分隔）、`status`（`modified` / `added` / `deleted` / `untracked`，开放字符串，以后可能多）、`added` / `removed`（二进制文件与未跟踪文件没有），按 git 的顺序、先已跟踪后未跟踪，最多 200 项，多了 `truncated: true`。为了不在不受信任的仓库里执行仓库配置里的命令，Host 关掉 fsmonitor、外部 diff 与 textconv，屏蔽仓库自己（local、worktree 两级配置）定义的过滤器（`filter.<名字>.clean` 等，`git diff` 读工作树文件时会执行它；全局与系统配置里的照常用），并设 `GIT_OPTIONAL_LOCKS=0`（不写索引锁）。工作区已移除回 `WORKSPACE_NOT_FOUND`，目录已不存在回 `WORKSPACE_PATH_INVALID`。0.15.0 起可带 `sessionId`：读这个会话的目录（环境会话是 Host 新开的 worktree，domain-model §3.10），会话不存在或不属于这个工作区回 `SESSION_NOT_FOUND`。
- **`provider.upsert`**：参数按 `kind` 判别。`deepseek-official` 的 `id` 固定为 `deepseek-official`；`openai-compatible` 必须给 `api`、`baseURL`（http / https，允许 localhost 与 IP）和至少一个模型。语义是整体替换非密钥字段，不是合并；`id` 不存在时新建（`created: true`）。`kind` 创建后不可改，改了回 `INVALID_PARAMS`；`defaultModelId` 不在 `models` 里（`openai-compatible`）同样回 `INVALID_PARAMS`。`apiKey`：省略 = 保留已存的 Key，字符串 = 设置或替换，`null` = 删除。**Key 只进 SecretStore，Host 不得把它写进日志、事件或任何响应**；响应里只有 `hasSecret`。写库前 Host 让引擎适配器检查配置（`validateProvider`），引擎不接受时回 `INVALID_PARAMS`（`data.issues` 是适配器给的字段路径与说明，例如 `anthropic-messages` 暂不支持、compat 开关与协议不匹配），不写库。写库后 Host 把全部 Provider 交给引擎；引擎没能用上新配置时回 `ENGINE_ERROR`，但 Profile 已保存（`provider.remove` 同样）。新配置何时对运行中的会话生效见 [providers.md](./providers.md) §5。
- **`provider.upsert` 的 `google-vertex`**（0.21.0）：Host 功能 google_vertex；api 选 openai-completions 或 anthropic-messages，vertex.project 必须有效，location 省略为 global；models 不混用 Gemini 与 Claude，defaultModelId 必须在列表中。不使用自定义 baseURL。serviceAccountJson（optional，最多 64 KiB）整份进 SecretStore，省略保留、字符串替换、null 删除；不使用 apiKey。能力门控与兼容方式见 §10。
- **`provider.upsert` 的 `chatgpt`**（0.7.0）：`id` 固定为 `chatgpt`，只有 `displayName` 与 `defaultModelId`；没有 Key、地址与 compat，`models` 由 Host 向引擎要（ChatGPT 进程的 `model/list`），`defaultModelId` 不在其中回 `INVALID_PARAMS`。Host 没有 `chatgpt_account` 功能时（dsh、echo 引擎）引擎的 `validateProvider` 拒绝，回 `INVALID_PARAMS`。ChatGPT 登录成功后 Host 自己建这个 Provider（显示名 `ChatGPT`，默认模型取引擎标为默认的那个），之后每次登录成功与 `account.get` 读到已登录时刷新它的模型列表（默认模型不在新列表里时换成新的默认）。
- **`provider.remove`**：同时删除 Key。被未关闭会话引用时回 `RESOURCE_IN_USE`。删除 `chatgpt` 不登出账号；下次登录成功时 Host 再建它。
- **`workspace.diff`**（0.20.0，Host 功能 `workspace_diff`）：一段改动的统一格式 diff，给桌面端的“变更”窗格。`source` 三种：`uncommitted` 是工作树加暂存区对 HEAD（还没有提交时对空树），含 `.gitignore` 之外的未跟踪文件（Host 把它们以 intent-to-add 加进一份临时索引，不碰用户的索引）；`branch` 是工作树对默认分支与 HEAD 的 merge-base（默认分支依次试 `origin/HEAD` 指向的分支、`main`、`master`、`origin/main`、`origin/master`），找不到时同 `uncommitted`、不带 `baseRef`；`turn` 是会话一个回合前后的快照之间（必须带 `sessionId`，否则 `INVALID_PARAMS`），回合还没有“后”快照（进行中、快照失败）时新的一侧是现在的工作树、带 `live: true`，没有“前”快照时只回 `repo: true, unavailable: 'no_checkpoint'`（快照见 domain-model §3.13）；回合里 HEAD 动过（pull、merge、rebase、提交）时，git 带进来、回合本身没写过的文件不算（T3 Code 的做法）。目录与 `workspace.git` 相同（带 `sessionId` 时是会话的目录），路径相对它（`git diff --relative`），跟踪重命名。`base` 是旧的一侧的提交（还没有提交时是空树），`head` 是新的一侧的提交（省略即工作树），两者给 `workspace.diffFile`。`patch` 是 `a/`、`b/` 前缀的统一格式 diff，只含 `files` 里没有 `omitted` 的文件；`files` 每项 `path`、`previousPath?`、`status`（`added` / `deleted` / `modified` / `renamed` / `copied` / `type_changed` / `untracked`，开放字符串）、`added` / `removed`（二进制文件没有，带 `binary: true`）。上限：整个 `patch` 2 MiB、单个文件 512 KiB（UTF-16 code unit），超过的文件只列出、带 `omitted`（`too_large` / `over_limit`）；未跟踪文件多于 5000 个时不算它们的 diff，逐个列出、带 `omitted: 'over_limit'`；`files` 最多 2000 项。有任何 `omitted` 或 `files` 被截断时 `truncated: true`，`fileCount` 与 `added` / `removed` 仍是全部。同一目录同一段的并发调用共用一次读取；每条 git 命令 10 s 超时，超时与 git 出错都回 `repo: false`。安全做法同 `workspace.git`，另外屏蔽钩子与提交签名。
- **`workspace.diffFile`**（0.20.0）：一个文件两侧的全文，给“展开未修改的行”。旧的一侧是 `oldRev`（上面的 `base`）里的 `oldPath`，新的一侧是 `newRev`（上面的 `head`）里的 `newPath`，没有 `newRev` 时读磁盘（realpath 之后仍要在目录里、是普通文件）；只给要读的那一侧的路径，`oldPath` 要带 `oldRev`。路径必须相对、`/` 分隔、不含 `..`，否则 `INVALID_PARAMS`。一侧超过 1 MiB、含 NUL 字节、不存在时只回 `unavailable`（`too_large` / `binary` / `not_found`）。版本库里的一侧用 `git cat-file blob`，不经过 textconv 与过滤器。
- **`workspace.files`**（0.22.0，Host 功能 `workspace_files`）：按名字找文件与文件夹，给桌面端输入框的 @ 提及与文件窗格的搜索。目录同 `workspace.git`（带 `sessionId` 时是会话的目录），路径相对它、`/` 分隔。Host 按目录建一份索引、缓存 5 s：git 仓库里是 `git ls-files --cached --others --exclude-standard`（跟踪的加没被忽略的未跟踪文件，文件夹取它们的父目录），否则逐层遍历、跳过 `node_modules`、`.git`、`.venv`、`target` 等目录与符号链接；最多 25 000 项，超出或遍历超过 10 s 时结果带 `truncated`。`query` 先去掉开头的 `@` 与空白、转小写，名字的匹配（完全相同、前缀、词边界、包含、子序列）优先于整条路径的匹配，含 `/` 时只按路径；排序与桌面端的斜杠命令共用 `@wevir/protocol` 的 `scoreQueryMatch`（移植自 T3 Code）。`query` 为空时按层级从浅到深给出前 `limit`（默认 50，最多 200）项；`kind` 只要文件或只要文件夹。匹配的多于 `limit` 时也带 `truncated`。
- **`workspace.listDir`**（0.22.0）：列一个目录的直接子项，给文件窗格的目录树。`path` 为空字符串是根目录，否则同 `workspace.diffFile` 的路径规则（相对、`/` 分隔、不含 `..`，否则 `INVALID_PARAMS`）。文件夹在前、再按名字（数字按数值）；不含 `.git`；符号链接按它指到的类型，指到目录外的不列；git 仓库里被 `.gitignore` 忽略的项带 `ignored: true`（`git check-ignore`）。目录不存在或 realpath 在目录外时是空表。最多 5000 项，超出带 `truncated`。
- **`workspace.readFile`**（0.22.0）：读一个文件，给文件窗格。路径规则同上。按扩展名认出的图片（png、jpg、gif、webp、svg、bmp、ico）给 `image: { mimeType, data }`（base64，不超过 4 MiB，免得超过连接的发送缓冲），其余当 UTF-8 文本给 `text`（不超过 1 MiB）；`size` 是文件的字节数。超过上限回 `unavailable: 'too_large'`，文本含 NUL 字节回 `binary`，不存在、不是普通文件或 realpath 在目录外回 `not_found`（不带 `size`）。开放字符串。
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
- **`session.create`**：`modelId` 省略时用 Provider 的 `defaultModelId`。0.16.0 起可带 `origin`（建议的后续任务，domain-model §3.11）：`workspaceId` 要与提出建议的会话相同、这项建议还没开始，否则 `INVALID_PARAMS`；建好后在提出建议的会话里写 `task.started`。0.15.0 起可带 `environmentId`（domain-model §3.10）：`workspaceId` 必须是环境的主文件夹；Host 先按环境准备目录（worktree），再建引擎会话，任何一步失败都回 `INVALID_PARAMS` 并删掉已建的 worktree。0.18.0 起可带 `worktree: 'new'`（Host 功能 `session_worktree`）：不用环境，在工作区的仓库里给这个会话单独新开一个 worktree，失败同样回 `INVALID_PARAMS`、不留 worktree；不能与 `environmentId` 同时给，`none` 与省略相同。Host 先建引擎会话，成功后才写 `session.created`（`seq = 1`），返回的 `session.state` 为 `idle`、`lastSeq` 为 1。引擎失败回 `ENGINE_ERROR`，不建会话。
- **`session.fork`**（0.17.0，Host 功能 `side_sessions`，domain-model §3.12）：从会话分出一个支线会话，`side` 现在只能是 `true`。被分的会话是子会话、支线、只读，或还没有完成的回合时回 `INVALID_STATE`；回合进行中也可以分，支线带着到最近一个完成的回合为止的上下文。返回的新会话 `idle`、带 `forkedFrom` 与 `side`，它的事件流从 `session.created` 开始；支线不进 `session.list`。
- **`session.rename`**（0.23.0，Host 功能 `session_rename`）：用户给会话改名。`title` 去掉首尾空白后不能是空的（否则 `INVALID_PARAMS`），最长 200 个字符；写一条 `session.title_changed`（`source: 'user'`），之后模型生成的标题不再覆盖它。子会话不能改名（`INVALID_PARAMS`）；已关闭、只读、已归档的会话可以。标题没变时不写事件。
- **`session.archive`**（0.23.0，Host 功能 `session_archive`）：`archived: true` 归档——会话没关闭时先按 `session.close` 关闭（进行中的回合取消），再记下归档的时刻（`Session.archivedAt`）；`false` 取消归档，会话仍是关闭的，下次发送时客户端照常先 `session.resume`。只有顶层、不是支线的会话能归档（否则 `INVALID_PARAMS`）。已归档时再归档不改时刻。`archivedAt` 只在 `session.list`、`session.get` 与 `session.*` 方法的结果里，不是事件推导的；别的客户端在下一次 `session.list` 时看到变化。
- **`session.checkpoints`**（0.20.0，Host 功能 `workspace_diff`）：会话有快照的回合，从早到晚，每项 `turnId` 与“后”快照里记下的统计 `fileCount`、`added`、`removed`（同 `workspace.diff` 的 `turn`，滤掉 git 带进来的文件；还没有“后”快照时省略）。会话目录不是 git 仓库时 `repo: false`、`turns` 为空。先等这个会话还没打完的快照。
- **`session.list`**：按 `updatedAt` 从新到旧；省略 `workspaceId` 时列出所有未移除工作区的会话。不含支线会话（0.17.0）。默认**不含子会话**（0.6.0，领域模型 §3.3.1）：子会话由引擎派出、只读，跟着父会话显示，不进左栏的会话列表。带 `parentSessionId` 时只列出这个会话的子会话（不论 `workspaceId`；会话不存在或所属工作区已移除时回 `SESSION_NOT_FOUND`）；一个会话的子会话也在它的快照 `subagents` 里（摘要）。0.23.0 起默认不含已归档的会话，`archived: true` 时只列已归档的（按 `updatedAt` 从新到旧）。
- **`session.get`**：返回由事件推导的快照 `{session: {state, activeTurn, lastSeq, …}, pendingApprovals, todos?, usage?, subagents?}`（ADR-0002 §3）。中途加入的客户端先取快照，再以 `sinceSeq = session.lastSeq` 订阅。0.6.0：子会话照常可以 `session.get`，`session` 带 `parentSessionId` 与 `subagent`（父工具调用、状态、起止时间）；派出过子会话的会话带 `subagents`，每个子会话一份摘要（标题、模型与推理强度、昵称、状态、起止时间，以及它的未决审批的副本），按 `startedAt` 排列（领域模型 §3.3.1）。
- **`session.configure`**（0.9.0，Host 功能 `session_configure`）：换会话的模型或推理档位，从下一个回合起生效，进行中的回合不受影响，会话处于什么状态都可以调。`modelId` 必须在会话所用 Provider 的模型列表里（Provider 列了模型时，否则 `INVALID_PARAMS`）；不换 Provider。`reasoningEffort` 为 `null` 时清掉、用模型的默认档位，换了模型而没给它时也清掉；给了就原样交给引擎（不按 Provider 的 `reasoningEfforts` 校验，客户端从中选）。值真的变了时追加 `session.configured`（带改后的全部值），结果是改后的会话。子会话回 `INVALID_STATE`（`data.parentSessionId`），只读会话回 `INVALID_STATE`（`data.readOnly`）；Host 的引擎不支持（没有声明 `session_configure`）时回 `ENGINE_ERROR`（`category: unknown`，同 `account.*`）；引擎拒绝这个模型时回 `INVALID_PARAMS`。引擎会话没挂着（Host 重启后、关闭后）时只记下新的值，下次 resume 时交给引擎。0.11.0 起还可以换 `permissionMode`（Host 功能 `permission_modes`，见下一条），交给引擎的总是全部当前值，`session.configured` 也带上它。
- **权限模式 `permissionMode`**（0.11.0，Host 功能 `permission_modes`，domain-model §3.9）：`on_request`（请求批准，默认）、`auto_review`（自动批准：越界的操作由会话的模型审查）、`full_access`（完全访问：不用沙箱、不审批）。`session.create` 省略时是 `on_request`；`session.configure` 省略时不改，从下一个回合起生效。Host 的引擎声明了支持的模式时（Codex）会话与 `session.created` / `session.configured` 都带它；引擎不支持时（dsh）只接受省略或 `on_request`，会话不带这个字段，别的值回 `INVALID_PARAMS`（`data.issues` 的 path 是 `permissionMode`）。子 agent 的子会话沿用父会话当时的模式。
- **`question.respond`**（0.10.0，Host 功能 `user_questions`）：回答引擎提的一组问题（`question.requested`）。`answers` 按问题 ID，每题是选中的选项 `label` 或自己填的文本（问题 `allowOther` 时），可多个（问题 `multiSelect` 时）；省略或空数组的题当作跳过。Host 交给引擎后写 `question.resolved`（`answered`，`resolution` 带回答与回答者），结果同它。已经结束的问题（别的客户端答过、随回合取消）照样返回它的结局，不报错；没有这组问题回 `QUESTION_NOT_FOUND`。问题等回答期间会话仍是 `running`，`Session.awaitingInput` 为 true；回合被取消、会话关闭、引擎退出、Host 退出或重启时，未答的问题以 `cancelled` 结束（原因同审批）。
- **`session.send`**：会话是 `running` / `awaiting_approval` / `cancelling` 时，带 `delivery`（0.8.0）就成为待发消息（领域模型 §3.3.2、§4.6）：`'steer'` 插话，等当前这一步结束插进本回合，引擎不支持或拒绝时转为排队；`'queue'` 排队，回合结束后作为下一个回合发出。这时结果是 `{pendingId, seq}`（`pending.added` 的 `seq`），没有 `turnId`。不带 `delivery` 时回 `SESSION_BUSY`（`data` 带 `state` 与 `activeTurn`），不排队、不打断（旧客户端的行为不变）；`error` / `closed` 时回 `INVALID_STATE`（`data.state`），先 `session.resume`。`idle` 时接受（`delivery` 不起作用），结果是新回合的 `turnId` 和这次 `user.message` 的 `seq`。`clientMessageId` 是幂等键，检查排在状态检查之前：同一会话里同一 ID、同样的 `content` 重发，返回原结果，不再发给引擎（不论会话现在处于什么状态，也不论那个回合后来怎样）；同一 ID、不同 `content` 回 `CLIENT_MESSAGE_CONFLICT`。send 前的自动 resume 失败回 `ENGINE_ERROR`（`category: session_unavailable`），工作区目录已不存在回 `WORKSPACE_PATH_INVALID`（不调引擎、状态不变）。会话只读（0.3.0，`session.readOnly`，引擎会话恢复不了）时回 `INVALID_STATE`，`data.readOnly` 给出原因与引擎原文，客户端据此提示“基于历史新建会话”，不要再提示 resume。Host 接受之后引擎拒收（适配器调用失败）时仍返回本回合的 `turnId` 与 `seq`：消息已被 Host 接受，失败经 `engine.error` 与 `session.state_changed`（→ `error`）送达，重发同一 `clientMessageId` 也返回这个结果（领域模型 §4.3）。子会话（0.6.0）是只读的，由父 agent 驱动：回 `INVALID_STATE`，`data.parentSessionId` 是父会话（幂等检查照样在前）。
- **`pending.update`**（0.8.0）：改一条待发消息的内容（`content`）或方式（`delivery`），返回改后的 `pending`，同时写 `pending.updated`。排队的与暂停的可以改内容；排队的改成插话时，回合进行中且引擎支持就交给引擎，否则保持排队并在 `fallback` 里说明原因。已交给引擎的插话、暂停的改成插话、已到终态的回 `PENDING_NOT_EDITABLE`（`data` 带 `pendingId`、`status`、`delivery`）。规则全表见领域模型 §4.6。
- **`pending.cancel`**（0.8.0）：删掉一条排队的或暂停的待发消息（`cancelled`），返回它；已取消的成功、无操作；已交给引擎的插话、已插入或已发出的回 `PENDING_NOT_EDITABLE`。
- **`pending.resume`**（0.8.0）：让这个会话所有暂停的待发消息继续（转为等待），返回会话当前全部未到终态的待发消息。会话 `idle` 时随后立即发出第一条，活动中时等这个回合结束；`error` / `closed` 回 `INVALID_STATE`，先 `session.resume`。没有暂停的消息时成功、无操作。
- **`settings.get` / `settings.update`**（0.8.0）：Host 设置（领域模型 §3.7），CLI 与桌面共用。`settings.update` 只改给出的字段，返回改后的全部设置；值变了时 Host 给每个调用过 `settings.*` 的连接（含发起者）发 `settings.updated`。目前只有 `sendWhileBusy`：回合进行中按发送的默认方式（`steer` / `queue`，默认 `steer`），客户端据此给 `session.send` 填 `delivery`。
- **`session.cancel`**：幂等，非活动状态下成功、无操作（领域模型 §4.2）。Host 等到回合结算（`turn.finished` 已写入），或判定无法确认（会话转 `error`，取消时限 5 s）才返回；结算细节以事件为准。0.6.0：同时取消这个会话所有活动中的子会话（递归，父会话空闲时也是），等它们一并结算（领域模型 §4.5：Codex 取消父回合时不动子 agent，由 Host 级联）。对子会话本身：0.14.0 起（Host 功能 `subagent_cancel`，U21）照样取消它的回合（domain-model §4.5 C6），连同它自己的子会话，父会话不受影响，适配器能告诉父 agent 时告诉它；更早的 Host 回 `INVALID_STATE`（`data.parentSessionId`）。
- **`session.close`**：活动中的会话先取消再关闭（领域模型 §4.1 #14）；已关闭时成功、无操作。0.6.0：活动中的子会话同 `session.cancel` 一并取消，但不关闭（历史照常可读）；对子会话本身回 `INVALID_STATE`（子会话由父 agent 关闭）。
- **`session.resume`**：`error` / `closed` 时恢复为 `idle`，其余状态成功、无操作；返回最新的 `session`。成功时先写 `session.resumed`（0.3.0，带引擎版本），引擎不回放历史，历史以事件库为准。Provider 已被删除回 `PROVIDER_NOT_FOUND`；工作区目录已不存在回 `WORKSPACE_PATH_INVALID`（不写事件）；引擎拒绝回 `ENGINE_ERROR`（同时追加一条 `engine.error` 事件，状态不变）。引擎会话恢复不了（会话日志被删除、格式不兼容或损坏）时另写 `session.read_only`，会话带上 `readOnly`；只读会话仍可以 resume，引擎找回会话时成功并解除只读（领域模型 §4.4）。对子会话回 `INVALID_STATE`（0.6.0）：子会话在父 agent 又用到它时由 Host 重新挂上（领域模型 §4.5 C5）。
- **`approval.respond`**：`optionId` 必须是该审批 `options` 里的一个，否则 `INVALID_PARAMS`，审批不变。首个决定生效；审批已不是 `pending` 时回 `ALREADY_DECIDED`，`data` 带既有的 `status` 与 `resolution`（领域模型 §5）。提交给引擎失败时会话转 `error`，审批结为 `cancelled`（`engine_exited`），同样回 `ALREADY_DECIDED`（领域模型 §4.3）。子会话的审批（0.6.0）属于子会话，`approvalId` 取自子会话的事件流，或父会话快照与 `subagent.*` 事件里摘要的 `pendingApprovals`；任何连接都能回，不论它订阅的是父会话还是子会话，首个决定生效（领域模型 §5 第 8 条）。
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
| `session.configured` | host |
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
| `question.requested` | engine |
| `question.resolved` | host |
| `usage.updated` | engine |
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

`0.21.0`：服务账号认证的 `google-vertex` Provider。`ProviderProfile.vertex` 与新 upsert 分支的 `vertex`、`serviceAccountJson` 都是 optional；vertex 内 project 必填、location optional（默认 global）。Host 写入时要求有效 project、Chat 或 Messages 协议、至少一个匹配发布方的模型；不使用自定义 baseURL，地址由网关生成。serviceAccountJson 只进 SecretStore，响应、日志、事件不返回它；省略保留、字符串替换、null 删除，hasSecret 沿用。新 Host 服务旧客户端：未声明 provider_kind_google_vertex 时 provider.list 隐藏此 kind，已有会话照常列出；新客户端连旧 Host：没有 google_vertex 功能就禁用 Vertex 入口，不发送新 kind。最低版本仍为 0.1.0，冻结样本 compat/0.21.0.json，旧样本不改。

`0.22.0`：工作区的文件。新方法 `workspace.files`、`workspace.listDir`、`workspace.readFile`；新类型 `WorkspaceEntry`、`WorkspaceEntryKind`、`PreviewImageMimeType`；Host 功能 `workspace_files`。新方法与新类型，`unavailable` 是开放字符串，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调新方法。新客户端连旧 Host：hello 结果里没有 `workspace_files`，桌面端不提供文件窗格，输入框的 @ 不弹出文件列表。冻结样本 `compat/0.22.0.json`。

`0.23.0`：会话改名与归档。新方法 `session.rename`、`session.archive`；`session.list` 加 optional 的 `archived`，`Session` 加 optional 的 `archivedAt`；Host 功能 `session_rename`、`session_archive`；存储 0009_session_archive。行为变化：`session.list` 默认不再列出已归档的会话——只有新方法能归档，旧客户端看不到的只是别的客户端归档掉的会话。新方法与 optional 字段，不需要能力位，最低版本仍为 0.1.0。新客户端连旧 Host：hello 结果里没有这两个功能，桌面端不显示改名、归档与“已归档”设置页。冻结样本 `compat/0.23.0.json`。

依据 Paseo 的兼容纪律（Paseo 研读 §2.3、§2.4；ADR-0002 §2）。目标：半年前的客户端能连新 Host，半年前的 Host 能服务新客户端（同一主版本内）。改 `packages/protocol` 的提交要在说明里回答这两个问题。

**版本**

- `PROTOCOL_VERSION` 是 `主.次.修订` 三段的 semver，不带预发布标签。主版本不同即不兼容，Host 拒绝 hello；同一主版本内次版本只增不减、向后兼容；修订号只用于不改变线缆形状的修正。
- 版本历史：`0.1.0`（T1.2，基线）；`0.2.0`（T3.4）：`ProviderModel` 加 `maxTokens`、`supportsImages`、`reasoningEfforts`，`provider.test` 结果加 `reason`、`httpStatus`，全部 optional，`MIN_PROTOCOL_VERSION` 仍是 `0.1.0`。新 Host 服务 0.1.0 客户端：多出的字段被旧 schema 忽略（规则 5）；0.2.0 客户端连旧 Host：旧 Host 不发这些字段，客户端按 optional 处理。`0.3.0`（T3.5）：新事件类型 `session.resumed`、`session.read_only`，`session.created` 加 `engineVersion`，`Session` 加 `readOnly`，`INVALID_STATE` 的 `data` 加 `readOnly`，全部是新类型或 optional 字段，没有给已有类型加枚举值，不需要能力位；`session.send` 与 `session.resume` 可能多回 `WORKSPACE_PATH_INVALID`（已有错误码）。新 Host 服务旧客户端：旧客户端忽略两种新事件（规则 5，照常推进 `lastSeq`）与新字段，只读会话在它看来是普通的 `error`，send 回 `INVALID_STATE`、resume 回 `ENGINE_ERROR`；0.3.0 客户端连旧 Host：收不到这些事件与字段，按 optional 处理。`0.4.0`（ADR-0005 补记 7）：`ProviderCompat` 加 `supportsCustomTools`（布尔）与 `systemMessageMode`（`inline` / `merge` / `user`），只有 Codex 引擎的模型网关读它们，dsh 适配器接受但忽略；都是 optional 的新字段，不需要能力位。新 Host 服务旧客户端：旧客户端的 schema 丢掉这两个字段（规则 5），它编辑 Provider 时不会带回，按 `provider.upsert` 整体替换的语义，这两个开关会被清掉；0.4.0 客户端连旧 Host：旧 Host 丢掉它们，网关按默认处理。`0.5.0`（R3，ADR-0005 补记 8）：`TitleSource` 加 `generated`（会话的模型生成的标题，prompts/thread-title.md）——给已有类型加枚举值，按下面的规则用能力位 `title_source_generated` 门控：没有声明它的连接，`session.title_changed` 事件与 `session.create` / `session.get` / `session.list` / `session.resume` 结果里的 `generated` 换成 `first_prompt`（`rpc-connection.ts` 的 `adaptEventForClient` / `adaptResultForClient`），标题本身照发；`session.title_changed` 加 optional 的 `description`（检索摘要）；`engine.raw` 的 `protocol` 从字面量 `acp` 放开为非空字符串（Codex 引擎是 `codex-app-server`）。`engine.raw` 只是调试信息、不按能力位门控（§5），旧客户端的 schema 只认 `acp`，按 T4.1 的做法跳过不合 schema 的那几条（告警、照常推进 `lastSeq`），不影响别的事件。新 Host 服务旧客户端：标题来源降级，看到的仍是“自动标题”；0.5.0 客户端连旧 Host：收不到 `generated` 与 `description`，按 optional 处理。`0.6.0`（R4，ADR-0005 补记 9）：子会话。新类型 `SubagentStatus`、`SubagentInfo`、`SubagentSummary`；`Session` 加 optional 的 `parentSessionId` 与 `subagent`，`SessionSnapshot` 加 `subagents`；新事件类型 `subagent.started` / `subagent.updated`；`session.created` 加 `parent`、`turn.started` 加 `input`；`session.list` 的参数加 `parentSessionId`，并且默认不再列出子会话；`INVALID_STATE` 的 `data` 加 `parentSessionId`，`session.cancel` / `session.close` / `session.resume` 可能回它（已有错误码，只对子会话）。都是新类型、新事件或 optional 字段，没有给已有类型加枚举值，不需要能力位。新 Host 服务旧客户端：`session.list` 不给它子会话，它也就不会订阅子会话；它忽略父会话流里的两种新事件（规则 5），快照里的 `subagents` 被它的 schema 丢掉，看到的父会话与 0.5.0 相同（子 agent 的派出、等待仍是工具调用），只是看不到、也回不了子会话的审批（审批挂到父会话被取消为止，取消会级联到子会话）。0.6.0 客户端连旧 Host：旧 Host 不认 `parentSessionId`（schema 丢掉它）而返回全部会话，旧 Host 上本来没有子会话，结果相同；收不到新事件与字段，按 optional 处理。 `0.7.0`（R6，ADR-0005 补记 10）：ChatGPT 账号。`ProviderKind` 加 `chatgpt`——给已有类型加枚举值，用能力位 `provider_kind_chatgpt` 门控：没有声明它的连接，`provider.list` 的结果里去掉 `chatgpt` 类 Provider（`adaptResultForClient`），它也就选不到、改不了这个 Provider；会话里的 `providerId` 只是字符串，用它的会话照常列出。`provider.upsert` 的参数加 `chatgpt` 一支；新类型 `AccountKind`、`AccountLoginMethod`、`AccountLogin`、`AccountRateLimitWindow`、`AccountState`；新方法 `account.get` / `account.login` / `account.cancelLogin` / `account.logout`；新通知 `account.updated`，只发给调用过 `account.*` 的连接，旧客户端不会调，也就收不到（client-sdk 本来就忽略不认识的通知并告警）；Host 功能 `chatgpt_account`（`HOST_FEATURES` 从此不再为空，只列名字，值由 Host 按引擎在每次握手时给出）。新 Host 服务旧客户端：看不到 ChatGPT 的 Provider 与账号，用 ChatGPT 的会话在它那里照常显示与对话（Provider 名字认不出）；0.7.0 客户端连旧 Host：hello 结果没有 `chatgpt_account`，客户端不显示账号入口，不调这些方法。`0.8.0`（R11，ADR-0002 补记 8）：回合进行中发消息。新类型 `PendingMessage`（`PendingDelivery`、`PendingStatus`、`PendingFallbackReason`）与 `HostSettings`；`session.send` 的参数加 optional 的 `delivery`，结果的 `turnId` 改为 optional、加 `pendingId`（只有带 `delivery` 的请求才可能拿到没有 `turnId` 的结果）；新方法 `pending.update` / `pending.cancel` / `pending.resume`、`settings.get` / `settings.update`，新通知 `settings.updated`（只发给调用过 `settings.*` 的连接）；新事件 `pending.added` / `pending.updated` / `user.steered`，`user.message` 加 optional 的 `pendingId`，快照加 `pendingMessages`；新错误码 `PENDING_NOT_FOUND`、`PENDING_NOT_EDITABLE`；Host 功能加 `pending_messages`、`host_settings`。都是新类型、新方法、新事件或 optional 字段，没有给已有类型加枚举值，不需要能力位。新 Host 服务旧客户端：旧客户端不带 `delivery`，回合进行中照旧拿到 `SESSION_BUSY`；别的客户端加入的待发消息与插话的事件被它忽略（规则 5），它的消息流里看不到插话（模型看到了），排队发出的回合照常显示，快照的 `pendingMessages` 被它的 schema 丢掉。新客户端连旧 Host：hello 结果里没有 `pending_messages`，客户端回合进行中不提供插话与排队（仍是忙，旧 Host 也会丢掉 `delivery` 回 `SESSION_BUSY`）；没有 `host_settings` 时不读设置，按默认的插话。`0.9.0`（U8）：会话中换模型与推理档位。新方法 `session.configure`、新事件 `session.configured`、Host 功能 `session_configure`（引擎实现了适配器的 `configureSession` 时声明，目前只有 Codex）。都是新方法、新事件，没有给已有类型加枚举值，不需要能力位。新 Host 服务旧客户端：旧客户端不调新方法；别的客户端换了模型时它忽略 `session.configured`（规则 5），会话的 `modelId` 在它下次读会话时更新。新客户端连旧 Host：hello 结果里没有 `session_configure`，客户端不提供换模型（只显示当前的）。`0.10.0`（U11）：Agent 向用户提问。新类型 `UserQuestion`、`UserQuestionOption`、`QuestionAnswer`、`QuestionRequest`、`QuestionResolution`（原因同审批）；新事件 `question.requested` / `question.resolved`，快照加 `pendingQuestions`，`Session` 加 optional 的 `awaitingInput`；新方法 `question.respond`，新错误码 `QUESTION_NOT_FOUND`；Host 功能 `user_questions`（引擎实现了 `respondToQuestion` 时声明，目前只有 Codex）。都是新类型、新方法、新事件或 optional 字段，会话状态不加新值（等回答时仍是 `running`），不需要能力位。新 Host 服务旧客户端：它忽略两种新事件，看到的是一直在 `running` 的回合，答不了问题，只能停止回合（未答的问题随之取消）或由别的客户端回答。新客户端连旧 Host：hello 结果里没有 `user_questions`，不会收到问题。`0.11.0`（U15）：会话的权限模式。新类型 `PermissionMode`；`session.create` 与 `session.configure` 加 optional 的 `permissionMode`，`Session`、`session.created` 与 `session.configured` 的负载加 optional 的 `permissionMode`（省略即 `on_request`）；Host 功能 `permission_modes`（引擎声明了支持的模式时，目前只有 Codex）。都是 optional 字段，不需要能力位。新 Host 服务旧客户端：它忽略这个字段，建的会话是 `on_request`，看不到别的客户端改了模式。新客户端连旧 Host：hello 结果里没有 `permission_modes`，不提供选择。
- 协商（`negotiateProtocolVersion`）：主版本相同且客户端不低于 `minProtocolVersion` 才接受，协商结果取双方中较低的版本。Host 提高 `minProtocolVersion` 等于放弃更老的客户端，要在变更说明里写明。 `0.12.0`（P0a）：`ProviderCompat` 加 optional 的 `supportsNamespaceTools`（布尔）与 `toolChoice`（`any` / `auto_only`）。网关取 Provider 声明 > 地址默认 > 全局默认，dsh 接受但忽略；没有给已有枚举加值，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧 schema 忽略新字段，旧客户端整体编辑 Provider 会清掉它们；新客户端连旧 Host：旧 Host 丢掉新字段，网关继续按旧版默认行为。冻结样本 `compat/0.12.0.json`，旧版本文件不改。`0.13.0`（U18）：新方法 `workspace.git` 与新类型 `GitFileChange`、Host 功能 `workspace_git`；新方法、新类型，`GitFileChange.status` 是开放字符串而不是枚举，以后多出取值不算收窄，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调它。新客户端连旧 Host：hello 结果里没有 `workspace_git`，桌面端会话侧栏不显示分支与“变更”卡片。冻结样本 `compat/0.13.0.json`。`0.14.0`（U21）：`usage.updated` 与快照的 `usage` 加 optional 的 `totalTokens`（会话累计用掉的 token）；`session.cancel` 对子会话本身放开，Host 功能 `subagent_cancel`。新字段与放宽的行为，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端忽略 `totalTokens`，也不会对子会话发 cancel。新客户端连旧 Host：hello 结果里没有 `subagent_cancel`，桌面端不显示停止单个子智能体的按钮；收不到 `totalTokens`，不显示 token 数。冻结样本 `compat/0.14.0.json`。`0.15.0`（U22.1）：环境。新类型 `Environment`、`EnvironmentFolder`、`SessionWorktree` 与 ID `env_`；新方法 `environment.list / create / update / remove`；新错误码 `ENVIRONMENT_NOT_FOUND`（-32016）；`session.create` 加 optional 的 `environmentId`，`Session` 与 `session.created` 加 optional 的 `environmentId`、`extraRoots`、`worktrees`；Host 功能 `environments`。都是新类型、新方法或 optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调新方法，环境会话在它那里是普通会话（`cwd` 可能是 worktree 里的目录）。新客户端连旧 Host：hello 结果里没有 `environments`，桌面端不显示“选择环境”。冻结样本 `compat/0.15.0.json`。`0.16.0`（U23）：建议的后续任务（domain-model §3.11）。新类型 `SuggestedTask`、`SessionOrigin` 与 ID `tsk_`；新事件 `tasks.suggested`、`task.started`、`task.reported`；快照加 `suggestedTasks`；`session.create` 与 `Session` 加 optional 的 `origin`；Host 功能 `suggested_tasks`。都是新类型、新事件或 optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端忽略三种新事件（规则 5），看到的是一个普通的 MCP 工具调用；它不会带 `origin`。新客户端连旧 Host：hello 结果里没有 `suggested_tasks`，不会收到建议。冻结样本 `compat/0.16.0.json`。`0.17.0`（U23.1）：支线会话（domain-model §3.12）。新方法 `session.fork`；`Session` 与 `session.created` 加 optional 的 `forkedFrom`、`side`；`session.list` 不再列出支线会话（新会话种类，旧数据里没有）；Host 功能 `side_sessions`。新方法与 optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调新方法，也就不会有支线。新客户端连旧 Host：hello 结果里没有 `side_sessions`，桌面端不认 `/btw`（照原样发出）。冻结样本 `compat/0.17.0.json`。
- 协商（`negotiateProtocolVersion`）：主版本相同且客户端不低于 `minProtocolVersion` 才接受，协商结果取双方中较低的版本。Host 提高 `minProtocolVersion` 等于放弃更老的客户端，要在变更说明里写明。 `0.12.0`（P0a）：`ProviderCompat` 加 optional 的 `supportsNamespaceTools`（布尔）与 `toolChoice`（`any` / `auto_only`）。网关取 Provider 声明 > 地址默认 > 全局默认，dsh 接受但忽略；没有给已有枚举加值，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧 schema 忽略新字段，旧客户端整体编辑 Provider 会清掉它们；新客户端连旧 Host：旧 Host 丢掉新字段，网关继续按旧版默认行为。冻结样本 `compat/0.12.0.json`，旧版本文件不改。`0.13.0`（U18）：新方法 `workspace.git` 与新类型 `GitFileChange`、Host 功能 `workspace_git`；新方法、新类型，`GitFileChange.status` 是开放字符串而不是枚举，以后多出取值不算收窄，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调它。新客户端连旧 Host：hello 结果里没有 `workspace_git`，桌面端会话侧栏不显示分支与“变更”卡片。冻结样本 `compat/0.13.0.json`。`0.14.0`（U21）：`usage.updated` 与快照的 `usage` 加 optional 的 `totalTokens`（会话累计用掉的 token）；`session.cancel` 对子会话本身放开，Host 功能 `subagent_cancel`。新字段与放宽的行为，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端忽略 `totalTokens`，也不会对子会话发 cancel。新客户端连旧 Host：hello 结果里没有 `subagent_cancel`，桌面端不显示停止单个子智能体的按钮；收不到 `totalTokens`，不显示 token 数。冻结样本 `compat/0.14.0.json`。`0.15.0`（U22.1）：环境。新类型 `Environment`、`EnvironmentFolder`、`SessionWorktree` 与 ID `env_`；新方法 `environment.list / create / update / remove`；新错误码 `ENVIRONMENT_NOT_FOUND`（-32016）；`session.create` 加 optional 的 `environmentId`，`Session` 与 `session.created` 加 optional 的 `environmentId`、`extraRoots`、`worktrees`；Host 功能 `environments`。都是新类型、新方法或 optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调新方法，环境会话在它那里是普通会话（`cwd` 可能是 worktree 里的目录）。新客户端连旧 Host：hello 结果里没有 `environments`，桌面端不显示“选择环境”。冻结样本 `compat/0.15.0.json`。`0.16.0`（U23）：建议的后续任务（domain-model §3.11）。新类型 `SuggestedTask`、`SessionOrigin` 与 ID `tsk_`；新事件 `tasks.suggested`、`task.started`、`task.reported`；快照加 `suggestedTasks`；`session.create` 与 `Session` 加 optional 的 `origin`；Host 功能 `suggested_tasks`。都是新类型、新事件或 optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端忽略三种新事件（规则 5），看到的是一个普通的 MCP 工具调用；它不会带 `origin`。新客户端连旧 Host：hello 结果里没有 `suggested_tasks`，不会收到建议。冻结样本 `compat/0.16.0.json`。`0.17.0`（U23.1）：支线会话（domain-model §3.12）。新方法 `session.fork`；`Session` 与 `session.created` 加 optional 的 `forkedFrom`、`side`；`session.list` 不再列出支线会话（新会话种类，旧数据里没有）；Host 功能 `side_sessions`。新方法与 optional 字段，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调新方法，也就不会有支线。新客户端连旧 Host：hello 结果里没有 `side_sessions`，桌面端不认 `/btw`（照原样发出）。冻结样本 `compat/0.17.0.json`。`0.18.0`：单独新开 worktree 的会话（domain-model §3.10）。新类型 `WorktreeMode`（`none` / `new`，`EnvironmentFolder.worktree` 也改用它，取值不变）；`session.create` 加 optional 的 `worktree`；Host 功能 `session_worktree`。optional 字段，会话上照旧记在 `worktrees`（不带 `environmentId`），不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不带这个字段，照旧在工作区目录里建会话；别的客户端这样建的会话在它那里是普通会话（`cwd` 是 worktree 里的目录）。新客户端连旧 Host：hello 结果里没有 `session_worktree`，桌面端的“此计算机”不能点开（旧 Host 会丢掉这个字段、在工作区目录里建会话，所以不能不看功能位就发）。冻结样本 `compat/0.18.0.json`。`0.19.0`：订阅来源（ADR-0005 补记 14，domain-model §3.6）。`ProviderKind` 与 `AccountKind` 加 `claude`、`cursor`、`opencode`、`grok`、`antigravity`（新类型 `SubscriptionKind`）——给已有枚举加值，用能力位 `subscription_kinds` 门控：没有声明它的连接，`provider.list` 与 `account.list` 的结果里去掉这些种类，也收不到它们的 `account.updated`；用它们的会话照常列出（`providerId` 只是字符串）。`AccountState` 加 optional 的 `planLabel`、`signIn`、`loginMethods`、`loginCommand`、`installed`、`version`、`executablePath`、`customPath`、`installCommand`、`installUrl`、`canInstall`、`installing`；`ProviderProfile` 加 optional 的 `enabled`；新方法 `provider.setEnabled`、`account.list`、`account.setPath`、`account.install`，`account.get` 加 optional 的 `refresh`；Host 功能 `subscription_sources`、`provider_enabled`。最低版本仍为 0.1.0。新 Host 服务旧客户端：看不到订阅来源的 Provider 与账号；停用的 Provider 在它那里照常列出（它的 schema 丢掉 `enabled`）。新客户端连旧 Host：hello 结果里没有这两个功能，桌面端只显示 ChatGPT 账号，不显示启用开关。冻结样本 `compat/0.19.0.json`。`0.20.0`：改动的 diff 与回合快照（domain-model §3.13）。新方法 `workspace.diff`、`workspace.diffFile`、`session.checkpoints`；新类型 `DiffSource`、`DiffFile`、`GitObjectId`、`TurnCheckpoint`；Host 功能 `workspace_diff`。Host 在每个回合前后给顶层会话的目录打快照（`refs/wevir/checkpoints/…`），不改事件与快照的形状。新方法与新类型，`DiffFile.status` 与 `omitted`、`unavailable` 都是开放字符串，不需要能力位，最低版本仍为 0.1.0。新 Host 服务旧客户端：旧客户端不调新方法；快照照打，它看不到。新客户端连旧 Host：hello 结果里没有 `workspace_diff`，桌面端不提供“变更”窗格，回合下面的“N 个文件已更改”照旧展开过程。冻结样本 `compat/0.20.0.json`。

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
| `workspace_diff` | 0.20.0 | `workspace.diff`、`workspace.diffFile`、`session.checkpoints` 与每个回合前后的快照（与引擎无关） |
| `workspace_files` | 0.22.0 | `workspace.files`、`workspace.listDir`、`workspace.readFile`（与引擎无关） |
| `session_rename` | 0.23.0 | `session.rename`（与引擎无关） |
| `session_archive` | 0.23.0 | `session.archive`、`session.list` 的 `archived`、`Session.archivedAt`（与引擎无关） |
| `session_worktree` | 0.18.0 | `session.create` 的 `worktree: 'new'`：不用环境，单独新开一个 worktree（与引擎无关，0.18.0 起的 Host 都有） |

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
