# Wevir 安全说明（骨架阶段）

> 状态：T6.1；R6 补 ChatGPT 账号（§3、§5）· 日期：2026-10-14
> 依据：[ADR-0001](./adr/0001-runtime-integration.md)（dsh 进程环境、沙箱与审批）、[ADR-0002](./adr/0002-host-transport-and-process-model.md)（传输、令牌、运行时文件）、[ADR-0003](./adr/0003-storage.md)（存储与密钥）、[ADR-0005](./adr/0005-agent-runtime-and-model-gateway.md)（Codex 引擎与模型网关）

本文件写清骨架阶段 Wevir 防什么、不防什么。一句话：**信任边界是操作系统用户**。以同一用户身份运行的任何进程都能拿到 Host 的全部权限和全部模型 Key；Wevir 防的是其他用户、网络上的其他机器和浏览器里的网页。

## 1. 信任边界：操作系统用户

- Host 只监听 `127.0.0.1`，端口由系统分配，局域网与公网连不上。
- 每次 Host 启动生成一个 32 字节的随机令牌，客户端在 `host.hello` 里出示（常量时间比较，不放 URL、请求头或子协议）。令牌只在 Host 内存和 `<数据目录>/run/host.json` 里：`run/` 为 0700，文件为 0600。
- **同一用户的任何进程都能读 `run/host.json` 拿到令牌**，于是能做客户端能做的一切：建会话、让 Agent 在工作区里读写文件和运行命令、批准审批、读全部会话历史。这与 Paseo 的本地凭据模型相同（ADR-0002 §2）。骨架阶段不区分“同一用户下可信与不可信的程序”；以你的身份运行的恶意程序本来就能直接读你的文件。
- 升级为 WebSocket 之前，Host 校验 `Host` 头（缺失也拒绝）与 `Origin`：只接受桌面端的 `wevir://app` 与开发服务器 `http://localhost:5199`，其他网页发起的连接在握手前就被拒（防 DNS 重绑定与网页跨站连接本机端口）。Origin 只是第一道，鉴权仍靠令牌。
- **Windows**：`chmod` 只能改只读位，0700 / 0600 在 Windows 上不生效。`run/`、`secrets.json` 的保护来自默认数据目录 `%APPDATA%\Wevir` 继承的按用户 ACL（只有本人、SYSTEM 与管理员可访问）。用 `WEVIR_HOME` 把数据目录放到别处时，保护取决于那个目录自己的 ACL，不要放在共享目录里。

## 2. 桌面端

- 渲染进程持有令牌，渲染进程被攻破就等于拿到 Host 的全部权限。对策（T5.1）：所有渲染进程开 `sandbox` 与 `contextIsolation`，`nodeIntegration` 关闭；preload 只暴露 `window.wevir` 上的少数方法，主进程校验 IPC 的发送方；严格的 CSP（没有 `unsafe-inline`、`unsafe-eval`；U3 起样式另放行每次加载随机的 nonce，给动效库运行时插入的 `<style>`，渲染进程经 `document.createElement('style')` 建的样式元素都会带上它，注入的标记与 `style` 属性仍被拦下，取舍见 `apps/desktop/src/shared/csp.ts` 与 ADR-0004 补记 9；0.20.0 起脚本另放行 `'wasm-unsafe-eval'`，只允许编译 WebAssembly（Shiki 的高亮引擎），worker 只放行 `'self'`，ADR-0004 补记 10）；拒绝新窗口与跨 origin 导航，外部链接交给系统浏览器；网页权限请求一律拒绝。模型输出的 Markdown 经 DOMPurify 清洗后才渲染。0.32.0 起文件预览放开 Host 的文件地址（`http://127.0.0.1:*`，图片、音视频、框架与 connect）：地址要 Host 发的令牌（只在内存里、一小时作废），只读、只给会话目录里能预览的几类文件、不给以 `.` 开头的路径段；会话目录里的网页放进 `sandbox` 框架（不透明 origin），Host 的响应另带沙箱与不能联网的 CSP，主进程不让子框架离开 Host 的文件地址，页面请求打开的外部链接只在用户刚点过时交给系统浏览器；Quick Look 与默认应用只认文档与媒体的扩展名，不打开可执行文件（ADR-0004 补记 11）。
- **内置浏览器**（0.33.0，domain-model §3.15.1）：网页在主进程的 `WebContentsView` 里，与渲染进程分开：独立的持久化 session 分区 `persist:wevir-browser`（数据在 `<数据目录>/desktop/` 下，不与渲染进程、也不与用户自己的浏览器共享登录与 Cookie；但这个分区里的数据跨标签页、跨会话、跨重启保留，所有会话共用，用户在窗格里登录过的网站 agent 也能用，工具说明里写明了），`sandbox`、`contextIsolation`、不挂 preload、不许 `<webview>`。地址只放行 http(s)：session 的请求关口（`webRequest.onBeforeRequest`）拦下 `file:`、`wevir:`、`chrome:` / `devtools:` 与各种外部协议，主框架另外只放行新标签页的 `about:blank`，子框架与页面资源另外放行 data / blob（ws(s) 只给资源），`will-navigate` / `will-frame-navigate` / `will-redirect` 再拦一遍；外部协议不交给系统。下载一律取消（记日志，0.46.0 起也在 agent 下一个命令的结果里报出来），agent 操作的标签页里选本机文件的原生文件框被拦下（`Page.setInterceptFileChooserDialog`，用户接手后放开），JS 对话框不弹原生框（`disableDialogs`，0.46.0），网页的权限请求（摄像头、麦克风、定位、通知、剪贴板、设备、屏幕共享）一律拒绝；`window.open` 的 http(s) 变成同一会话的新标签页，其余拒绝。网页能连到本机的 Host 端口，但 `/mcp` 拒绝带 `Origin` 的请求、WebSocket 只放行渲染进程的 Origin（host-api.md §1），也拿不到令牌。agent 的命令只作用于自己会话的标签页，用户正在用的标签页 agent 只读；不提供在页面里跑任意脚本（Paseo 的 `browser_evaluate`）与上传本机文件，会改页面的命令按会话的权限模式走审批。页面内容是不可信的输入：工具说明与 MCP 的 `instructions` 写明它们不是用户的指示。截图有大小上限（4 MiB），快照有长度上限。
- **后台进程**（0.47.0，domain-model §3.15.4）：agent 用 `wevir_process_start` 起的命令由 Host 跑，以用户身份运行，**不在引擎的沙箱里**（Codex 的 `workspace-write` 沙箱管不到它）。起进程、写 stdin、发信号按会话的权限模式走引擎的审批，与 `browser_*` 的写操作一样（Cursor 没有引擎审批，直接执行）；批准一次就是批准这条命令能做的一切。目录限会话文件夹内；环境去掉 Wevir 自己的 `WEVIR_*`（网关令牌等）与 `ELECTRON_*`，其余照 Host 的环境与登录 shell 的配置（同 Codex 给命令的环境）。只结束得了自己会话的进程，Host 退出与删除会话时结束；Host 崩溃时 POSIX 上的进程组会留下。输出日志与落盘的大结果在 `<数据目录>/tool-output/`（目录 0700、文件 0600），可能含命令打印的秘密，七天后或删除会话时删掉。
- **开发模式**会打开渲染进程的 Chrome 远程调试端口（默认 9339，只监听 127.0.0.1）。同一用户的进程连上它就能在渲染进程里执行任意脚本、读到令牌，和读 `host.json` 是同一个边界；正式构建不开。

## 3. 密钥

- 模型 API Key 存在 `<数据目录>/secrets.json`：明文 JSON，0600；写入时先以 0600 创建临时文件再 rename，任何时刻都没有宽权限的中间文件（ADR-0003 §3）。Windows 上 0600 不生效，依赖 `%APPDATA%` 的按用户 ACL（同 §1）。迁移到系统钥匙串是 ADR-0003 的未决事项。
- **搜索服务的 Key**（0.34.0，联网工具）：博查与 Tavily 的 API Key 同样只存在 `secrets.json`（引用 `web-search:<服务>`），设置文件 `web.json` 里只有开关与所选的服务。Key 只在 Host 里用来发搜索请求：不进引擎的环境与配置文件、事件、日志与 `web.*` 的结果（只说配没配）；服务端把请求头回显在错误里时，原文里的 Key 换成 `***`。Codex 的桥脚本只拿到 Host 端点的一次性令牌（每次 Host 启动换新，经 `env_vars` 转，不写进文件）。
- **ChatGPT 账号的凭据**（R6）：登录由 Codex 自己完成，令牌（id / access / refresh token，浏览器登录还有一个经 token-exchange 换来的 API Key）存在 `<数据目录>/engines/codex-chatgpt/auth.json`：明文 JSON，Codex 以 0600 写入（`cli_auth_credentials_store = "file"`），与 `secrets.json` 同一个保护级别。选文件而不是系统钥匙串：未签名的 `codex-app-server` 访问钥匙串会弹系统提示，Wevir 自己的 Key 也还没进钥匙串（ADR-0003 未决事项），以后一起迁（Codex 的 `keyring` / `auto` 模式）。Host、客户端与日志都不读、不转交这些令牌；Host 只经 app-server 读账号状态（邮箱、套餐、用量）。登出时 Codex 删除这个文件并向 OpenAI 吊销刷新令牌。网关进程（`engines/codex`）里没有它。同一用户的进程能读这个文件拿到你的 ChatGPT 会话，与 §1 的边界相同。
- **Cursor 账号的凭据**（订阅来源，ADR-0005 补记 14）：应用内登录时 Cursor 的 SDK 用一次性的会话令牌铸一把有期限（90 天）的用户 API Key，会话令牌随即丢掉；这把 Key 存在 `<数据目录>/engines/cursor/auth.json`：明文 JSON，0600，写法同 `secrets.json`，与它同一个保护级别。SDK 在 Host 进程里运行，所以 Host 进程的适配器（`packages/adapter-cursor`）读它交给 SDK；它登记进日志的抹除表，不进事件与 `account.updated`。设了环境变量 `CURSOR_API_KEY` 时用它、不在应用里登录。登出时删除这个文件并停掉用着它的会话；Key 在 Cursor 那边到期前仍然有效，可在 Cursor 后台的 API Keys 里吊销（名字是 Wevir）。Wevir 不读 Cursor 编辑器或 CLI 自己存的登录；查用量时用这把 Key 向 Cursor 的后端换一个只在内存里的短期令牌（[cursor-event-mapping.md](./architecture/cursor-event-mapping.md) §2）。
- **OpenCode 的本机服务器**（订阅来源，ADR-0005 补记 14）：上游的凭据由用户在终端里 `opencode auth login`，存在 opencode 自己的数据目录（`~/.local/share/opencode`），Wevir 不改；只有接上了 OpenCode Go 时读 auth.json 里 Go 的 Key 去查用量（只读，不复制、不进日志与事件，opencode-event-mapping.md §2.1）。Wevir 起的 `opencode serve` 只听 127.0.0.1、端口随机，每次启动生成一个随机密码经 `OPENCODE_SERVER_PASSWORD` 交给它（HTTP Basic），只在 Host 的内存里；没有密码的 opencode 服务器本机任何进程都能驱动它（读写文件、跑命令、用用户的额度）。服务器的权限边界是会话的规则集（opencode 没有操作系统沙箱），见 [opencode-event-mapping.md](./architecture/opencode-event-mapping.md) §4。`<数据目录>/engines/opencode/servers/` 的台账（0600）只记进程身份与端口，不记密码。
- **Grok 的登录**（订阅来源，ADR-0005 补记 14）：用户在终端里 `grok login`，令牌由 `grok` 自己存在用户的 `~/.grok`；Wevir 不设 `GROK_HOME`、不复制也不改它，只为查用量与邮箱只读 `auth.json` 里默认 grok.com 登录的令牌，带着它问 xAI 的计费接口（令牌只在内存里，[grok-event-mapping.md](./architecture/grok-event-mapping.md) §2.1）。会话里要认证时只让 `grok` 用它缓存的令牌 `authenticate`（方法 `cached_token`）。用户环境里的 `XAI_API_KEY` 随 Host 的环境交给 `grok`（与用户在终端里跑 `grok` 相同），Wevir 不存它（[grok-event-mapping.md](./architecture/grok-event-mapping.md) §1、§2）。
- **Antigravity 账号的凭据**（订阅来源，ADR-0005 补记 14）：Google 登录由 Antigravity 运行体自己保存在 `<数据目录>/engines/antigravity/profile/antigravity-acp/acp_token.json`（`GEMINI_HOME` 是这个私有 profile，`AGY_ACP_FORCE_FILE_STORAGE=1` 不用系统钥匙串，目录 0700）。登录状态只看它在不在；查用量时 Wevir 只读其中的 OAuth client 与 refresh token，向 Google 换一个只在内存里的 access token（不写回文件、不转交、不进日志），再问 Cloud Code 的额度接口（antigravity-event-mapping.md §6）；登出时让运行体自己清掉（ACP `logout`），运行体起不来时删掉这个文件。交给运行体的环境去掉 `GEMINI_API_KEY`、`GOOGLE_*` 等，Wevir 不接收 Antigravity 的 API Key。登录时 Google 的授权页回调到本机 127.0.0.1 上运行体开的端口；`BROWSER` 设成只把网址写到 stderr 的 Node 脚本，Wevir 把网址交给界面，不自己开浏览器（[antigravity-event-mapping.md](./architecture/antigravity-event-mapping.md) §3、§6）。下载的运行体按钉住的 sha256 校验后才启用。
- `wevir.db` 只存 Provider 的配置与 Key 的引用，不存 Key；但会话历史（提示、模型回答、工具的参数与输出）都在里面，没有加密，靠数据目录的权限保护。
- Key 交给 dsh 的唯一途径是 dsh 子进程的环境变量 `WEVIR_PROVIDER_<ID>_KEY`；Wevir 写给 dsh 的 Provider overlay（`engines/dsh/wevir/providers.yml`）里只有变量名（`apiKeyEnv`），不写进 `DSH_HOME`（AGENTS.md 规则 5）。同一用户的进程能读另一个进程的环境变量，这仍在 §1 的边界之内。
- Codex 引擎（默认引擎，§5）拿不到 Key：Key 只在 Host 进程里的模型网关，Codex 的环境与 `CODEX_HOME` 里只有网关令牌（每次启动 `codex-app-server` 随机生成，只在内存，只能访问本机网关），生成的 `config.toml` 里只有令牌的变量名。
- Host 日志按字段名把令牌、密钥、密码、API Key、凭据、Authorization、Cookie 一类的值替换为 `[REDACTED]`，本次启动的令牌在任何字符串里出现都替换。`provider.test` 的错误原文来自服务端，服务端回显的 Key 片段（例如 `****-key`）照原样保留。

## 4. dsh 引擎

- **独立的 dsh 目录。** `DSH_HOME` 是 `<数据目录>/engines/dsh`，不与用户自己装的 dsh 混用；dsh 进程的 cwd 也是它，所以工作区里的 `.env` 不会被 dsh 当作凭据读进来。
- **`DSH_AGENTS_HOME` 被隔离，但只隔离用户级。** dsh 默认把 `~/.agents` 里的 skills 与 `AGENTS.md` 放进每个会话的首个请求。Wevir 把它指向空目录 `<数据目录>/engines/dsh-agents`，你自己 `~/.agents` 里的内容不会进入 Wevir 的会话，那里的 skills 在骨架阶段也就用不了（ADR-0001 未决事项 2，Phase 1 做 Skills 管理时再定）。
  - **工作区里的项目级指令文件与 skills 照常进入会话。** dsh 从会话 cwd（即工作区）向上找项目根：最近的含 `.git` 的目录，没有就是 cwd 本身。`<项目根>/.dsh/skills` 与 `<项目根>/.agents/skills` 里的 skills 列进会话的 skill 目录（名称与描述在请求里，正文由模型调 `skill` 工具读取）；从项目根到 cwd 每一层的 `AGENTS.md`、`CLAUDE.md`、`AGENTS.local.md`、`CLAUDE.local.md` 拼进首个请求，整条指令消息上限 64 KB；之后 Agent 读写更深目录里的文件时，那一层的指令文件也会追加进来。工作区是某个仓库的子目录时，项目根在工作区之上，工作区外、仓库内的这些文件同样会读到。
  - **打开不可信的仓库作为工作区，这些文件就是提示词注入面。** 仓库作者写进去的内容会和你的提示一起交给模型，而按下文沙箱一条，模型在工作区内写文件不需要审批，读工作区外的文件、访问网络也不触发审批。指令文件是符号链接时 dsh 会跟随，仓库可以借此把工作区外的文件内容带进会话。骨架阶段 Wevir 不关闭、不过滤这些文件，也不提示它们被加载；添加工作区之前，先看过仓库里的这些文件。
  - 来源：dsh `docs/subsystems/skills.md`（Local discovery priority）与 `packages/context/agent-instructions/README.md`；acp profile 从 `packages/bundle/base/cordis.patch.yml` 继承这两个插件，没有关掉（锁定提交 `d743267`，即 tag `dsh-v0.2.1-alpha.2`）。
- **白名单环境。** dsh 子进程只继承 `PATH`、`HOME`、用户名、shell、区域与时区、临时目录、代理变量、`NODE_EXTRA_CA_CERTS` 和 Windows 的系统变量；你 shell 里的 `DEEPSEEK_API_KEY`、`OPENAI_*`、`ANTHROPIC_*`、自己的 `DSH_*`、`NODE_OPTIONS` 都不会传进去。固定注入 `DSH_TELEMETRY_DISABLED=1`，关掉 dsh 的遥测。
- **发给 DeepSeek 官方路由的附加数据。** 走 `deepseek-official`（dsh 的 `llm-deepseek`，Messages 协议）的每个模型请求，dsh 默认在模型输入之外再带两个请求体字段，发往该 Provider 配置的 `baseURL`（填了第三方网关就是网关）：
  - `dsh_session_log`：dsh 的完整会话日志，增量上传（服务端回 2xx 后记下水位，下一个请求从水位之后接着发，单个请求最多 8 MiB）。内容大部分是模型本来就能看到的（系统提示、工具定义、提示、回答、工具结果），另外还有每个事件的毫秒时间戳、流式输出的分片时间、权限 / 沙箱 / 审批模式、会话标题、工具结果的附加元数据（`read` 的 `meta` 里是绝对路径加整份文件内容的第二份拷贝），以及只记日志、不进模型的事件类型（例如 `approval/asked`、`approval/decided`、`llm/retry`）。
  - `dsh_plugin_packages`：dsh 进程里所有已加载插件包的名字与版本（约 90 个，6 KB，每个请求都带全量），开了增量旁路时其中有 `@wevir/dsh-stream-tap`。
  - **Wevir 在 Provider overlay 里把两者都关掉**（`session-log-deepseek` 与 `plugin-package-inventory-deepseek` 的 `enabled: false`，`provider-config.ts`）。按两个包的 README，它们不改变模型看到的内容、token 数与 KV Cache；DeepSeek 拿它们做什么上游没有写明，关掉之后服务端依赖它们的功能（如果有）就用不上。以后要打开，注意 `dsh_session_log` 会把关闭期间记下的全部历史补传。
  - **关不掉的两个请求头**：`x-deepseek-harness-user-id`（`<DSH_HOME>/.anonymous-user-id` 里的随机 UUID，每个 Wevir 数据目录一个，长期不变）与 `x-deepseek-harness-session-id`（dsh 会话 ID）。dsh 0.2.1-alpha.2 没有配置项；它们只发往同一个 `baseURL`，而该服务本来就凭 API Key 认得出你。
  - `openai-compatible`（dsh 的 `llm-pi-ai`）不带上面任何一项，只有 `user-agent: deepseek-harness/<版本>`。
  - 来源：dsh `packages/session/session-log-deepseek`、`packages/llm/plugin-package-inventory-deepseek`、`packages/llm/llm-deepseek/src/adapter.ts`（锁定提交 `d743267`），以及真实 dsh + 本地 Messages mock 的实测（`dsh-adapter.providers.integration.test.ts` 断言关掉之后请求体里没有这两个字段）。
- **`workspace-write` 沙箱与审批。** Wevir 固定 `DSH_PERMISSION_MODE=workspace-write`：
  - 工作区内的读写**不需要审批**；
  - **系统临时目录（`/tmp`、`$TMPDIR`）也可以不经审批写入**（T0.3 场景 B0，T3.3 用真实 dsh 复核）。在 macOS 上 `$TMPDIR` 是每个用户自己的，`/tmp` 是所有用户共享的；
  - 工作区外其他位置的写入先被沙箱拒绝，模型带 `sandbox_permissions` 重试时才弹审批。所以**审批只来自沙箱升级**，不是每次写文件都问；模型不重试就不会出现审批卡片，真实模型是否可靠地重试尚未验证（ADR-0001 未决事项 3）；
  - 按 dsh 自己的文档，沙箱模式**只约束文件写入**：读取工作区外的文件、网络访问与进程可见性都不在它的范围内，也不触发审批。Windows 上的沙箱是部分强制（NTFS 硬链接可以绕过写入限制）。来源：dsh `docs/subsystems/sandbox.zh.md` 与 `packages/sandbox/sandbox-local/README.zh.md`（锁定提交 `d743267`）。Wevir 没有另外验证读取与网络的行为。
- 骨架阶段没有“总是允许”一类的审批规则，每次升级都要逐个决定。

## 5. Codex 引擎（R2 起可用，R3 起是默认引擎）

细节见 [codex-event-mapping.md](./architecture/codex-event-mapping.md) §1–§4、§6.6。

- **独立的 `CODEX_HOME`**：`<数据目录>/engines/codex`，不与用户自己装的 Codex（`~/.codex`）混用，进程的 cwd 也是它。白名单环境同 dsh，另外不继承 `OPENAI_API_KEY`、`CODEX_API_KEY`、`CODEX_ACCESS_TOKEN` 等会改变 Codex 认证与配置的变量。
- **两个进程**（R6，ADR-0005 补记 10）：网关进程（`engines/codex`）承载用 API Key 的 Provider；ChatGPT 进程（`engines/codex-chatgpt`）承载 ChatGPT 登录，没有网关令牌。都在第一次用到时才启动。
- **网关进程外连为零**：生成的配置关掉插件（唯一产生外连的开关：启动时同步插件市场，连 github.com、api.github.com、chatgpt.com）、联网搜索、遥测、ChatGPT 应用（`features.apps`），模型请求只发往本机网关；adapter-codex 的集成测试用只记录目标的代理与 lsof 核对。
- **ChatGPT 进程的外连**：登录了才有，目标只有 OpenAI 的两个域名——`auth.openai.com`（设备码、换令牌、刷新与吊销）与 `chatgpt.com`（账号与工作区路由、用量、模型列表、对话）；没登录时它不联网（模型列表用二进制里打包的），也不建会话、不发消息（否则 Codex 会拿着空凭据去连 api.openai.com）。路径与时机见 codex-event-mapping.md §8.5，真实账号的审计结果见 codex-notes §4.1。请求带 `originator: wevir` 与 `wevir/<版本>` 的 User-Agent（OpenAI 要求写应用自己的名字），只有进程启动时第一次拉模型列表用的是 Codex 默认的 `codex_cli_rs`（在握手之前发出，改不了）。用 ChatGPT 的会话，提示、代码与工具输出都发给 OpenAI，按你的 ChatGPT 账号与 OpenAI 的条款处理。
- **ChatGPT 登录的范围**：OpenAI 只允许本地或开源应用用 Codex 的 app-server 登录，商业或托管服务不行；界面与 CLI 都写明“仅供个人在本机使用 Wevir 时登录”。浏览器登录的回调落在本机 `127.0.0.1:1455`（登录期间由 codex-app-server 监听，完成或取消即关闭），浏览器要在这台机器上；设备码方式在任意设备上输入码即可，码只该输入你自己刚发起的登录。
- **命令看不到令牌**：`[shell_environment_policy]` 套用 Codex 内置的 *KEY* / *SECRET* / *TOKEN* 排除并排除 `WEVIR_*`。副作用：你 shell 配置里导出的名字含 KEY、SECRET、TOKEN 的变量（例如 `GITHUB_TOKEN`）在模型跑的命令里也看不到。
- **用户级 skills 不进会话**：`HOME` 是你真实的家目录（命令要用 git 等配置），Codex 会读 `~/.agents/skills`；Wevir 关掉了 skills 列表，那里的 skills 不会列给模型。你在消息里显式写 `$<skill 名>` 时，Codex 会把那个 skill 放进上下文：这是有意保留的，算你主动使用自己的 skill（取舍见 codex-event-mapping.md §1.3）。工作区里的 `AGENTS.md`、`.codex/config.toml`、`.agents/skills` 照常生效，打开不可信仓库时与 §4 的提醒相同。
- **沙箱与审批**：`workspace-write`，macOS 上是 Seatbelt，默认禁网；工作区、`$TMPDIR` 与 `/tmp` 可写。写工作区外的补丁、模型申请越出沙箱的命令要审批，卡片上是命令原文（或补丁的 diff）、工作目录与模型给的理由。“本会话内这个命令不再问”只在这个会话、这个 Codex 进程里有效（Host 或引擎重启后重新问）；没有“总是允许”。子 agent 的审批在子会话（R4）之前一律拒绝。Windows 上是 Codex 不需要管理员权限的受限令牌沙箱（`[windows] sandbox = "unelevated"`，ADR-0005 补记 17），在 CI 的 Windows runner 上验证过；Linux 的沙箱还没有在 Wevir 里实测（ADR-0005 未决事项 4）。
- **会话标题**：第一个回合开始后，Host 把第一条消息（转义、截到约 1 KB）经同一个 Provider 的同一个模型再发一次，请它起标题（不带工具、只经本机网关），所以每个新会话多一次模型请求；不想要时用 dsh 引擎（只有截断的标题）。
- **联网工具**（0.34.0，[web-tools.md](./architecture/web-tools.md)）：经网关的 Codex 会话有 Wevir 自己的 `web_search` 与 `web_fetch`，请求由 **Host 进程**发出（Codex 进程仍然只连本机：网关与 Host 的联网端点）。`web_search` 把模型写的查询词发给你选的搜索服务（博查或 Tavily，按它们的条款处理）；`web_fetch` 直接访问模型给的网址。两个工具都不经审批、不受沙箱的禁网限制，所以 `web_fetch` 拒绝本机与局域网地址（连接时按 DNS 结果检查，重定向的每一跳都查），只读公开网页；要访问本机的开发服务器，模型得用命令，那条路走沙箱与审批。网页内容是不可信的数据，base.md 要求模型不照做里面的指令。不想让 Agent 联网时在“设置 → 联网搜索”关掉（或 `wevir web off`），从下一个会话起不再登记这两个工具，已开的会话里调用也会被拒绝。ChatGPT 会话用 OpenAI 托管的搜索，同一个开关。

## 5a. 代码智能的语言服务器（lsp_* 工具）

细节见 [domain-model.md](./architecture/domain-model.md) §3.15.5。

- **Host 启动外部进程。** agent 调 `lsp_*` 工具时，Host 在项目根启动对应的语言服务器（以你的身份，继承 Host 的环境但去掉 `WEVIR_*` 变量，PATH 补上常见的安装位置），不经引擎的沙箱，也不走审批：这些工具只读，每次都问会让它们没法用。启动语言服务器等于在编辑器里打开这个项目：TypeScript 7 的服务器是项目 `node_modules` 里的可执行文件（你装依赖时装上的），rust-analyzer 会运行 build.rs 与过程宏，gopls 会运行 `go list`（可能下载模块），clangd 按 compile_commands.json 里的参数解析。所以把不可信的仓库添加为工作区时，agent 的 LSP 工具可能执行仓库里的代码；这和 VS Code 打开不受信任的文件夹一样，但 Wevir 没有“受限模式”，也还没有单独关掉 LSP 工具的开关。
- **不下载、不安装。** 服务器只用你机器上已有的；找不到时工具结果给出安装命令，由你决定装不装。安装包也不带语言服务器。
- **不改文件。** 文件只读出来交给服务器；服务器的 `workspace/applyEdit` 一律拒绝。输入的文件按 realpath 限会话文件夹；结果里目录外的位置（依赖、标准库）只给路径、不读内容。
- **回收。** 空闲 10 分钟关掉，最多同时 8 个，Host 退出时关掉全部；Host 崩溃时服务器按 LSP 的 `processId` 约定自己退出，stdin 断开时大多也会退出。

## 6. 骨架阶段不做的

远程访问与设备配对、多用户、代码签名与公证、自动更新、OAuth 类 Provider（R6 的 ChatGPT 登录除外：由 Codex 自己完成，见 §3、§5）、系统钥匙串、会话数据加密，都不在骨架范围（SKELETON_PLAN §7）。`pnpm dev` 默认用平台默认的数据目录；试验不可信的提示词或文件时，用 `WEVIR_HOME` 指向一个单独的目录，并只把专门准备的文件夹添加为工作区。
