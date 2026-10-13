# Wevir 安全说明（骨架阶段）

> 状态：T6.1 · 日期：2026-10-14
> 依据：[ADR-0001](./adr/0001-runtime-integration.md)（dsh 进程环境、沙箱与审批）、[ADR-0002](./adr/0002-host-transport-and-process-model.md)（传输、令牌、运行时文件）、[ADR-0003](./adr/0003-storage.md)（存储与密钥）

本文件写清骨架阶段 Wevir 防什么、不防什么。一句话：**信任边界是操作系统用户**。以同一用户身份运行的任何进程都能拿到 Host 的全部权限和全部模型 Key；Wevir 防的是其他用户、网络上的其他机器和浏览器里的网页。

## 1. 信任边界：操作系统用户

- Host 只监听 `127.0.0.1`，端口由系统分配，局域网与公网连不上。
- 每次 Host 启动生成一个 32 字节的随机令牌，客户端在 `host.hello` 里出示（常量时间比较，不放 URL、请求头或子协议）。令牌只在 Host 内存和 `<数据目录>/run/host.json` 里：`run/` 为 0700，文件为 0600。
- **同一用户的任何进程都能读 `run/host.json` 拿到令牌**，于是能做客户端能做的一切：建会话、让 Agent 在工作区里读写文件和运行命令、批准审批、读全部会话历史。这与 Paseo 的本地凭据模型相同（ADR-0002 §2）。骨架阶段不区分“同一用户下可信与不可信的程序”；以你的身份运行的恶意程序本来就能直接读你的文件。
- 升级为 WebSocket 之前，Host 校验 `Host` 头（缺失也拒绝）与 `Origin`：只接受桌面端的 `wevir://app` 与开发服务器 `http://localhost:5199`，其他网页发起的连接在握手前就被拒（防 DNS 重绑定与网页跨站连接本机端口）。Origin 只是第一道，鉴权仍靠令牌。
- **Windows**：`chmod` 只能改只读位，0700 / 0600 在 Windows 上不生效。`run/`、`secrets.json` 的保护来自默认数据目录 `%APPDATA%\Wevir` 继承的按用户 ACL（只有本人、SYSTEM 与管理员可访问）。用 `WEVIR_HOME` 把数据目录放到别处时，保护取决于那个目录自己的 ACL，不要放在共享目录里。

## 2. 桌面端

- 渲染进程持有令牌，渲染进程被攻破就等于拿到 Host 的全部权限。对策（T5.1）：所有渲染进程开 `sandbox` 与 `contextIsolation`，`nodeIntegration` 关闭；preload 只暴露 `window.wevir` 上的少数方法，主进程校验 IPC 的发送方；严格的 CSP（没有 `unsafe-inline`、`unsafe-eval`）；拒绝新窗口与跨 origin 导航，外部链接交给系统浏览器；网页权限请求一律拒绝。模型输出的 Markdown 经 DOMPurify 清洗后才渲染。
- **开发模式**会打开渲染进程的 Chrome 远程调试端口（默认 9339，只监听 127.0.0.1）。同一用户的进程连上它就能在渲染进程里执行任意脚本、读到令牌，和读 `host.json` 是同一个边界；正式构建不开。

## 3. 密钥

- 模型 API Key 存在 `<数据目录>/secrets.json`：明文 JSON，0600；写入时先以 0600 创建临时文件再 rename，任何时刻都没有宽权限的中间文件（ADR-0003 §3）。Windows 上 0600 不生效，依赖 `%APPDATA%` 的按用户 ACL（同 §1）。迁移到系统钥匙串是 ADR-0003 的未决事项。
- `wevir.db` 只存 Provider 的配置与 Key 的引用，不存 Key；但会话历史（提示、模型回答、工具的参数与输出）都在里面，没有加密，靠数据目录的权限保护。
- Key 交给 dsh 的唯一途径是 dsh 子进程的环境变量 `WEVIR_PROVIDER_<ID>_KEY`；Wevir 写给 dsh 的 Provider overlay（`engines/dsh/wevir/providers.yml`）里只有变量名（`apiKeyEnv`），不写进 `DSH_HOME`（AGENTS.md 规则 5）。同一用户的进程能读另一个进程的环境变量，这仍在 §1 的边界之内。
- Host 日志按字段名把令牌、密钥、密码、API Key、凭据、Authorization、Cookie 一类的值替换为 `[REDACTED]`，本次启动的令牌在任何字符串里出现都替换。`provider.test` 的错误原文来自服务端，服务端回显的 Key 片段（例如 `****-key`）照原样保留。

## 4. dsh 引擎

- **独立的 dsh 目录。** `DSH_HOME` 是 `<数据目录>/engines/dsh`，不与用户自己装的 dsh 混用；dsh 进程的 cwd 也是它，所以工作区里的 `.env` 不会被 dsh 当作凭据读进来。
- **`DSH_AGENTS_HOME` 被隔离，但只隔离用户级。** dsh 默认把 `~/.agents` 里的 skills 与 `AGENTS.md` 放进每个会话的首个请求。Wevir 把它指向空目录 `<数据目录>/engines/dsh-agents`，你自己 `~/.agents` 里的内容不会进入 Wevir 的会话，那里的 skills 在骨架阶段也就用不了（ADR-0001 未决事项 2，Phase 1 做 Skills 管理时再定）。
  - **工作区里的项目级指令文件与 skills 照常进入会话。** dsh 从会话 cwd（即工作区）向上找项目根：最近的含 `.git` 的目录，没有就是 cwd 本身。`<项目根>/.dsh/skills` 与 `<项目根>/.agents/skills` 里的 skills 列进会话的 skill 目录（名称与描述在请求里，正文由模型调 `skill` 工具读取）；从项目根到 cwd 每一层的 `AGENTS.md`、`CLAUDE.md`、`AGENTS.local.md`、`CLAUDE.local.md` 拼进首个请求，整条指令消息上限 64 KB；之后 Agent 读写更深目录里的文件时，那一层的指令文件也会追加进来。工作区是某个仓库的子目录时，项目根在工作区之上，工作区外、仓库内的这些文件同样会读到。
  - **打开不可信的仓库作为工作区，这些文件就是提示词注入面。** 仓库作者写进去的内容会和你的提示一起交给模型，而按下文沙箱一条，模型在工作区内写文件不需要审批，读工作区外的文件、访问网络也不触发审批。指令文件是符号链接时 dsh 会跟随，仓库可以借此把工作区外的文件内容带进会话。骨架阶段 Wevir 不关闭、不过滤这些文件，也不提示它们被加载；添加工作区之前，先看过仓库里的这些文件。
  - 来源：dsh `docs/subsystems/skills.md`（Local discovery priority）与 `packages/context/agent-instructions/README.md`；acp profile 从 `packages/bundle/base/cordis.patch.yml` 继承这两个插件，没有关掉（锁定提交 `d743267`，即 tag `dsh-v0.2.1-alpha.2`）。
- **白名单环境。** dsh 子进程只继承 `PATH`、`HOME`、用户名、shell、区域与时区、临时目录、代理变量、`NODE_EXTRA_CA_CERTS` 和 Windows 的系统变量；你 shell 里的 `DEEPSEEK_API_KEY`、`OPENAI_*`、`ANTHROPIC_*`、自己的 `DSH_*`、`NODE_OPTIONS` 都不会传进去。固定注入 `DSH_TELEMETRY_DISABLED=1`，关掉 dsh 的遥测。
- **`workspace-write` 沙箱与审批。** Wevir 固定 `DSH_PERMISSION_MODE=workspace-write`：
  - 工作区内的读写**不需要审批**；
  - **系统临时目录（`/tmp`、`$TMPDIR`）也可以不经审批写入**（T0.3 场景 B0，T3.3 用真实 dsh 复核）。在 macOS 上 `$TMPDIR` 是每个用户自己的，`/tmp` 是所有用户共享的；
  - 工作区外其他位置的写入先被沙箱拒绝，模型带 `sandbox_permissions` 重试时才弹审批。所以**审批只来自沙箱升级**，不是每次写文件都问；模型不重试就不会出现审批卡片，真实模型是否可靠地重试尚未验证（ADR-0001 未决事项 3）；
  - 按 dsh 自己的文档，沙箱模式**只约束文件写入**：读取工作区外的文件、网络访问与进程可见性都不在它的范围内，也不触发审批。Windows 上的沙箱是部分强制（NTFS 硬链接可以绕过写入限制）。来源：dsh `docs/subsystems/sandbox.zh.md` 与 `packages/sandbox/sandbox-local/README.zh.md`（锁定提交 `d743267`）。Wevir 没有另外验证读取与网络的行为。
- 骨架阶段没有“总是允许”一类的审批规则，每次升级都要逐个决定。

## 5. 骨架阶段不做的

远程访问与设备配对、多用户、代码签名与公证、自动更新、OAuth 类 Provider、系统钥匙串、会话数据加密，都不在骨架范围（SKELETON_PLAN §7）。`pnpm dev` 默认用平台默认的数据目录；试验不可信的提示词或文件时，用 `WEVIR_HOME` 指向一个单独的目录，并只把专门准备的文件夹添加为工作区。
