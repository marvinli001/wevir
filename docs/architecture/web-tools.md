# Agent 的联网工具（wevir_web）

状态：0.34.0 起（2026-10-15）。维护者当天定：联网搜索做成 Wevir 自己的 MCP 服务；搜索服务可换，默认博查（国内可用），设置里也能选 Tavily，以后加一家只加一个实现；网页抓取不需要 Key，由 Host 自己抓。

## 1. 组成

```text
模型 ──tools──▶ Codex（codex-app-server）
                 │ mcp__wevir_web__web_search / web_fetch
                 ▼
             桥脚本 <数据目录>/mcp/wevir-web.mjs（stdio MCP，Node 内置模块）
                 │ POST http://127.0.0.1:<端口>/call，Authorization: Bearer <令牌>
                 ▼
             Host 的 WebService（packages/host/src/web/）
                 ├─ web_search → 所选的搜索服务（博查 / Tavily），Key 从密钥存储取
                 └─ web_fetch  → Host 自己抓网页（node:http(s)），HTML → 正文 Markdown
```

- **桥脚本**（`@wevir/runtime-adapter/web-tool`）：MCP 服务 `wevir_web`，`tools/list` 给两个工具的定义，`tools/call` 原样转给 Host 的端点，端点不在或回错时给模型一条 `isError` 的说明。脚本只用 Node 内置模块，由引擎启动前写进数据目录（0600），用 Host 自己的 Node 运行（Electron 里带 `ELECTRON_RUN_AS_NODE=1`）。与 `wevir_tasks`、`wevir_history` 同一套做法。
- **端点**：Host 启动时在 127.0.0.1 的随机端口监听，只有 `POST /call`；每次启动生成 32 字节的令牌（常量时间比较，日志里抹掉）。请求体 `{ name, arguments }`，回复 MCP 的 `{ content, isError? }`。
- **令牌怎么到桥脚本**：Codex 进程的环境里有 `WEVIR_WEB_TOKEN`，config.toml 的 `[mcp_servers.wevir_web]` 用 `env_vars = ["WEVIR_WEB_TOKEN"]` 让 Codex 按名字转给桥脚本（rmcp-client 的 `create_env_for_mcp_server`）；端点地址是脚本的参数。令牌不写进任何文件；`shell_environment_policy` 排除 `WEVIR_*`，模型跑的命令看不到它。
- **Key 不出 Host**：搜索服务的 Key 只在 Host 的密钥存储（`secrets.json`，引用 `web-search:<服务 ID>`）与发给搜索服务的请求头里，不进引擎的环境、config.toml、日志、事件与测试快照。服务端把请求头回显在错误里时，原文里的 Key 换成 `***`。

## 2. 设置

`<数据目录>/web.json`（0600）：`enabled`（默认 true）与 `searchService`（默认 `bocha`）。Key 在密钥存储。协议 0.34.0 的 `web.get` / `web.update` / `web.test`（host-api.md §3.1），Host 功能 `web_tools`；桌面端“设置 → 联网搜索”与 CLI 的 `wevir web` 改的是同一份。

- **开关**关着：Codex 的会话不登记 `wevir_web`，工具调用（已开始的会话里）回“联网已关闭”。
- **没配所选服务的 Key**：会话只登记 `web_fetch`；`web_search` 被调用时回一条说明，让模型告诉用户去“设置 → 联网搜索”配置。
- **测试**：`web.test` 用一次真实的搜索（查询 `Wevir`、1 条）测服务与 Key；给了 `apiKey` 就用它测、不保存。失败按 `WebTestFailure` 归类（missing_key、auth、quota、rate_limited、network、timeout、server、invalid_response、unknown），附服务端原文。

设置在工具调用时按当时的值检查；登记哪些工具则在会话开始（`thread/start` / `thread/resume`）时按当时的值定（§5.1）。

## 3. 搜索服务

`web/search.ts` 定义统一的请求（`query`、`count` 1–10，默认 6、`freshness` day / week / month / year、`domains`）与结果（标题、链接、摘要、网站、发布日期），每家一个实现，登记在 `web/services.ts`。以后加一家：写一个实现（请求映射、响应映射、错误归类），登记进 `SEARCH_SERVICES`，桌面端与 CLI 的服务名表加一项；协议的服务 ID 是开放字符串，旧客户端按 ID 显示，不用改协议。

### 3.1 博查（默认）

2026-10-15 查的官方文档（博查 AI 开放平台 → 开发文档 → Web Search API，飞书文档，“4 月 1 日修改”版）。

| 项 | 取值 |
|---|---|
| 请求 | `POST https://api.bocha.cn/v1/web-search`，`Authorization: Bearer <API KEY>`，JSON |
| 请求体 | `query`；`count`（1–50）；`summary: true`（要长摘要）；`freshness` 由 day / week / month / year 换成 `oneDay` / `oneWeek` / `oneMonth` / `oneYear`，不限时不写（默认 `noLimit`，文档也推荐）；`include` 是域名用 `|` 连起来 |
| 响应 | `{ code, log_id, msg, data }`，结果在 `data.webPages.value[]`：`name` → 标题、`url`、`summary`（没有时 `snippet`）→ 摘要、`siteName`、`datePublished`（UTC+8 带时区）。只有 `dateLastCrawled` 时按文档把结尾的 `Z` 换成 `+08:00`（它其实是北京时间的发布时间） |
| 错误 | 401 与“API KEY is missing”的 400 → auth；403“You do not have enough money” → quota；429 → rate_limited；5xx → server；HTTP 200 里 `code` 不是 200 也按这张表 |

### 3.2 Tavily

2026-10-15 查的官方文档 <https://docs.tavily.com/documentation/api-reference/endpoint/search>。

| 项 | 取值 |
|---|---|
| 请求 | `POST https://api.tavily.com/search`，`Authorization: Bearer tvly-…`，JSON |
| 请求体 | `query`；`max_results`；`search_depth: "basic"`（1 个额度）；`topic: "general"`；`include_published_date: true`；`time_range` 直接用 day / week / month / year；`include_domains` |
| 响应 | `results[]`：`title`、`url`、`content`（片段，`[...]` 换成省略号）、`published_date`（认不出时是 null，不写） |
| 错误 | 401 / 403 → auth；432（套餐额度）、433（按量上限）→ quota；429 → rate_limited；5xx → server；400 / 422 → unknown |

### 3.3 给模型的结果

一段文字：`Search results for "<查询>" (<服务>, <条数>):`，每条 `[n] 标题`、`URL:`、`Site: … · Published: …`、摘要（最多 600 字）。编号与网址方便模型引用；正文要模型再用 `web_fetch` 读。

## 4. 网页抓取

`web/fetch-page.ts`，不需要 Key：

- 只认 `http:` / `https:`，带用户名密码的 URL 不抓；
- 整次（含重定向）20 s；解压后最多读 5 MB，多的不读、标成截断；重定向最多 5 次，每一跳都重新检查；
- `Accept-Encoding: gzip, deflate, br`，按 `Content-Encoding` 解压；编码按响应头，HTML 没写时看前 4 KB 的 `<meta charset>`（国内不少站还是 GBK），认不出按 UTF-8；
- HTML（含没写类型的）转正文 Markdown；`text/*`、JSON、XML、YAML 等原样；其余（PDF、图片、压缩包）回“不收这种内容”。
- 转 Markdown 用 turndown 7.2.4 与它在 Node 里用的 DOM domino 2.2.0（ADR-0004 补记 12）：先删掉脚本、样式、导航、侧栏、页脚、表单、图片、隐藏元素，有 `<main>` / `<article>` 且里面至少 200 个字时只转它，链接改成绝对地址（`javascript:` / `data:` 链接只留文字），空链接去掉。
- 给模型的结果：`URL`（最终地址）、`Title`、这一段在全文里的位置与下一段的 `start`，然后是正文；每段默认 1 万字符，`max_chars` 最多 3 万。

### 4.1 本机与局域网地址：拦

`web_fetch` 拒绝 `localhost` / `*.localhost`、回环、RFC 1918 私网、链路本地（含云主机元数据 169.254.169.254）、运营商级 NAT（100.64/10，Tailscale 也在这里）、组播、保留与未指定地址，IPv6 的回环、ULA、链路本地、组播，以及嵌着这些 IPv4 的 IPv4 映射地址。主机名在**连接时**按 DNS 的全部结果检查（`node:http` 的 `lookup` 钩子；有一个地址在范围里就拒绝），DNS 重绑定绕不过去，重定向的每一跳也查。

取舍：

- **为什么拦**：抓取在 Host 进程里发出，不受 Codex 沙箱的网络限制，工具也不经审批（`default_tools_approval_mode = "approve"`）。不拦的话，网页里的一段提示词就能让模型去读本机的开发服务器、路由器管理页、云主机的元数据接口，再把内容带进下一次搜索的查询词里（SSRF 加外传）。
- **代价**：模型不能用 `web_fetch` 看本机的开发服务器。这件事改用命令（`curl http://localhost:3000`），那条路走沙箱与审批，用户看得见、能拒绝。base.md 的联网一节告诉了模型。
- **198.18.0.0/15 不拦**：Clash / mihomo / Surge 的 fake-ip 模式把每个域名都解析到这里，拦了等于开着代理的电脑上什么都抓不了；它不是局域网地址。
- **没有走代理**：`node:http` 不读 `HTTP_PROXY`，抓取直连（系统级 TUN 代理照常生效）。只设了环境变量代理的环境抓不了被墙的网站，这是已知的限制（TODO.md §2）。

## 5. 哪些引擎挂上

### 5.1 Codex 的网关进程（经网关的第三方模型）

挂上两个工具。config.toml 的 `[mcp_servers.wevir_web]`：`command` / `args`（Node、桥脚本、端点地址）、`env = { ELECTRON_RUN_AS_NODE = "1" }`、`env_vars = ["WEVIR_WEB_TOKEN"]`、`default_tools_approval_mode = "approve"`（只读工具，不问用户）、`enabled_tools = ["web_search", "web_fetch"]`、`tool_timeout_sec = 60`，每个工具的 `output_token_limit`（搜索 4000、抓取 12000，比模型目录默认的 10 KB 截断宽）。每个会话的 `thread/start` / `thread/resume` 按当时的设置覆盖 `mcp_servers.wevir_web.enabled` 与 `enabled_tools`（MCP 连接是每个 thread 一份，覆盖只影响这个会话；用真实的 `codex-app-server` 验证过三种状态，codex-event-mapping.md §6.12）。

Codex 托管的 `web_search` 保持关闭（`web_search = "disabled"`）：它由 OpenAI 的服务端执行，经网关的第三方模型用不了；custom provider 的 `ProviderCapabilities` 默认 `web_search: true`（upstream/codex/codex-rs/model-provider/src/capabilities.rs），不关就把托管搜索工具发给上游。

### 5.2 Codex 的 ChatGPT 进程（ChatGPT 登录的 OpenAI 模型）

取舍：

| 方案 | 好处 | 坏处 |
|---|---|---|
| 用 Codex 托管的 `web_search` | OpenAI 服务端执行，不要 Key、不占搜索服务的额度；OpenAI 的模型为它训练过；在 ChatGPT 套餐里；流量本来就直连 OpenAI | 结果来源与 Wevir 的搜索服务不同；跟着 Codex 走，Wevir 管不了它的行为 |
| 用 `wevir_web` 的 `web_search` | 两种会话行为一致 | 要用户另配 Key、花搜索服务的钱；OpenAI 模型没有为这个工具调过 |

定的方案：**ChatGPT 会话用 Codex 托管的搜索，跟着 Wevir 的联网开关**。开着时 `thread/start` 覆盖 `web_search = "cached"`（Codex 自己的默认：OpenAI 维护的缓存索引，少受网页里的提示词影响；完全访问时 Codex 自己升到 `live`），关着时 `disabled`。`wevir_web` 在这个进程里只登记 `web_fetch`（本机抓网页，补上托管搜索读不到的页面），同样跟着开关。

### 5.3 其他引擎：不挂

它们都有自己的联网工具，再挂一套会让模型面对两组功能相同的工具：

| 引擎 | 自带 | 决定 |
|---|---|---|
| dsh | `web_search`、`web_fetch`（DeepSeek Harness 自己的） | 不挂 |
| Claude | `WebSearch`、`WebFetch` | 不挂 |
| OpenCode | `websearch`、`webfetch` | 不挂 |
| Cursor | `webSearch`、`webFetch` | 不挂 |
| Grok Build | `websearch`、`webfetch` | 不挂 |
| Antigravity | 运行体自带、按 ACP 的 `search` / `fetch` 报的联网工具 | 不挂 |

能挂 MCP 的（Claude、Grok、ACP）以后需要时照 `wevir_history` 的做法挂上即可；那时注意不要和自带的工具同时开。Wevir 的联网开关与 Key 只管 `wevir_web` 与 ChatGPT 会话的托管搜索，不管这些引擎自带的工具。

## 6. 展示

Codex 的 `mcpToolCall`（server `wevir_web`）按工具映射（adapter-codex 的 tool-display.ts）：`web_search` → `search`，摘要与 `query` 是查询词；`web_fetch` → `fetch`，摘要与 `url` 是网址；输出是工具回的文字（不是 MCP 结果的 JSON）。桌面端的工作组：“已搜索 〈查询词〉”“已获取 〈网址〉”，网页搜索按工具名（`web_search` / `webSearch` / `WebSearch` / `websearch`）用地球图标，与代码搜索的放大镜分开；抓取本来就是地球图标。

## 7. 测试

- 第 1 层（单元，mock HTTP，`pnpm vitest run --project host src/web`）：两家的请求体与请求头、文档示例响应的映射、错误归类、Key 回显被抹掉；抓取的地址检查（字面量、DNS 结果、重定向）、重定向上限、大小与时间上限、内容类型、gzip 与 GBK；设置与 Key 的读写（Key 不进 `web.json`）、开关与没有 Key 时的工具回复、端点的令牌。桥脚本（runtime-adapter 的 web-tool.test.ts）、Codex 的配置与展示（config.test.ts、tool-display.test.ts）、CLI（web.integration.test.ts）、桌面端的纯逻辑各有测试。
- 第 2 层（真实 `codex-app-server` + 网关 + mock 模型 + 假端点，`codex-adapter.web.integration.test.ts`）：config.toml 能被 `--strict-config` 接受，模型看到 `mcp__wevir_web` 里的工具，调用带令牌转到端点、不问用户，结果回到模型，展示成搜索；没有 Key 只有抓取；关着两个都不登记；令牌不在 config.toml 里。
- 第 3 层（真实服务，`web.contract.test.ts`）：`WEVIR_TEST_BOCHA_API_KEY`、`WEVIR_TEST_TAVILY_API_KEY`、`WEVIR_TEST_WEB_FETCH=1`，没有就跳过并打印原因（development.md §6.3）。
