# Wevir 开发指南

> 状态：骨架阶段（M6，T6.1）· 最后验证：2026-10-14
> 配套：[架构总览](./architecture/overview.md) · [安全说明](./security.md) · 仓库规则与命令速查 [AGENTS.md](../AGENTS.md)

本文件讲怎样把 Wevir 跑起来、怎样分包开发和测试、数据放在哪里，以及在大陆网络下怎样装依赖。文中的耗时都是 2026-10-14 在一台 Apple Silicon Mac（macOS 26）上从全新克隆实测的，记录见[验收存档](./research/skeleton-acceptance/README.md#t61-开发文档从全新克隆跑起-pnpm-dev2026-10-14)。

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node | ≥ 22.19，推荐 24 LTS | 下限来自 dsh（`^22.19.0 \|\| >=24.0.0`）与 `node:sqlite`（ADR-0003）。`.node-version` 写的是 24，CI（T6.2）另跑一次 22.19。2026-10-14 在 24.21.0 与 26.10.0 上验证过 |
| pnpm | 12.6.0 | 以根 `package.json` 的 `packageManager` 为准。较新的 Node（实测 26）不再自带 corepack，直接用 npm 装：`npm install -g pnpm@12.6.0` |
| git | 任意近期版本 | 只有同步上游参考仓库（§7.4）时要用到 |
| 操作系统 | macOS、Windows | 首版平台。本文的步骤在 macOS 上验证；Windows 的 lint、typecheck、test 由 CI（T6.2）覆盖，`pnpm dev` 还没在 Windows 上走过一遍 |
| 磁盘 | 约 2 GB | pnpm store 约 1.5 GB；Electron 下载包约 129 MB，解压后约 307 MB |

不需要 Python、Xcode 或 Visual Studio：需要编译的依赖（node-pty、koffi）在 macOS arm64 上都用预编译文件，安装时没有触发源码编译。

## 2. 首次安装

```bash
git clone <仓库地址> wevir
```

```bash
cd wevir && pnpm install
```

在大陆网络下先按 §7 切换 registry。全新克隆、全新 pnpm store、经 npmmirror 的实测：`pnpm install` 24 s。

安装时会跑 5 个依赖的构建脚本（`pnpm-workspace.yaml` 的 `allowBuilds` 逐个登记：dsh 的 `dsh-subprocess-local`、`node-pty`、`koffi`、两个版本的 `esbuild`），其他构建脚本一律不跑。`strictDepBuilds` 保持开启，依赖升级后冒出没登记的构建脚本时安装直接失败（`ERR_PNPM_IGNORED_BUILDS`），审查后再登记，见 ADR-0004 §2。

## 3. 运行

### 3.1 `pnpm dev`：桌面端 + Host

```bash
pnpm dev
```

它依次做三件事（`apps/desktop` 的 `dev` 脚本）：

1. 用 tsdown 构建 `@wevir/host` 及其依赖（protocol、storage、runtime-adapter、adapter-dsh），因为 Host 是以 `packages/host/dist/main.js` 跑在本机 Node 上的子进程。
2. `install-electron`：Electron 44 没有 postinstall，二进制要单独下载。第一次运行时下载并按 npm 包里的 `checksums.json` 校验，之后检查到已安装就立即退出。大陆网络先设 `ELECTRON_MIRROR`（§7.3）。
3. `electron-vite dev`：构建主进程与 preload，渲染进程的开发服务器固定在 `http://localhost:5199`（`strictPort`，因为这个 origin 在 Host 的白名单里），然后打开窗口。

窗口打开后，主进程读数据目录里的 `run/host.json`：有活着的 Host 就附着；没有就用本机 Node 拉起 `wevir-host --home <数据目录> --exit-on-stdin-eof`（默认 dsh 引擎），并持有它的 stdin 作为归属管道。关窗口即退出，同时停掉自己拉起的 Host；附着的 Host 不受影响。左栏底部显示“Host 已连接”即就绪，全新数据目录会显示三步引导。

实测（全新克隆，Node 24.21.0）：第一次 `pnpm dev` 26 s 连上 Host，其中从 npmmirror 下载 Electron 约 19 s；第二次 4 s。

| 环境变量 | 作用 |
|---|---|
| `WEVIR_HOME` | 数据目录（§5），桌面、Host、CLI 的解析规则相同。用相对路径时请写成绝对路径，例如 `WEVIR_HOME="$PWD/.wevir-dev"` |
| `WEVIR_NODE` | 拉起 Host 用的 Node 可执行文件。默认在 `PATH` 里找 `node` |
| `WEVIR_DESKTOP_DEBUG_PORT` | 渲染进程的 Chrome 远程调试端口，默认 9339，只在开发模式打开、只监听 127.0.0.1 |
| `ELECTRON_MIRROR` | Electron 二进制的下载地址（§7.3） |

**调试。** 渲染进程：Chrome 打开 `chrome://inspect`，在 Configure 里加 `localhost:9339`，或直接用 `http://127.0.0.1:9339/json` 走 DevTools 协议。主进程的日志带 `[wevir-desktop]` 前缀，打在运行 `pnpm dev` 的终端里。Host 的日志在数据目录的 `logs/host.log`（§5.2）。

改渲染进程的代码由 Vite 热更新；改了主进程、preload 或 `packages/host`，关掉窗口重新 `pnpm dev`。主进程与渲染进程按 `@wevir/source` 条件直接打包 client-sdk、protocol 等工作区包的源码，改了这些包不用先构建；Host 子进程跑的是 `dist/`，dev 脚本每次都会重新构建它。

### 3.2 单独运行 Host

```bash
pnpm dev:host
```

构建 `@wevir/host` 及其依赖，以 echo 假引擎在仓库下的 `.wevir-dev/` 启动 Host（gitignore），Ctrl-C 优雅退出。就绪后 stdout 打印一行 `{"event":"ready","url":…}`，连接信息在 `.wevir-dev/run/host.json`。要用真实 dsh 或调整日志级别时直接运行入口：

```bash
node packages/host/dist/main.js --home ./.wevir-dev --adapter dsh --log-level debug
```

参数见 `node packages/host/dist/main.js --help`。退出码：0 正常，1 运行失败，2 参数错误，3 该数据目录已有 Host 在运行（读 `host.json` 附着即可）。

### 3.3 命令行客户端

`apps/cli`（T4.2）合入后，`pnpm build` 再运行 `pnpm --silent wevir --help`。`wevir host start` 以分离方式启动 Host，桌面端随后附着它；`wevir session attach <id>` 与桌面看同一事件流、可以在终端里审批。数据目录与 Host 相同（`WEVIR_HOME` 或 `--home`）。

### 3.4 各包单独开发

类型检查与测试都按 `@wevir/source` 条件直接用依赖包的源码，不需要先构建（ADR-0004 补记 1）。只有在 Node 里直接运行包（Host、CLI，或测试里拉起 Host 子进程）时才需要 `pnpm build`。

| 包 | 职责（详见[架构总览](./architecture/overview.md) §2） | 开发时常用 |
|---|---|---|
| `packages/protocol` | Host API 的 schema、方法表、事件、错误码 | `pnpm --filter @wevir/protocol test`；改了协议同步 `docs/architecture/host-api.md`（表格由测试比对） |
| `packages/runtime-adapter` | 引擎适配接口、契约测试套件、echo 假引擎 | `pnpm vitest run --project runtime-adapter` |
| `packages/storage` | SQLite、迁移、仓储、SecretStore | `pnpm vitest run --project storage` |
| `packages/adapter-dsh` | dsh 进程、ACP 映射、增量旁路、Provider 桥接 | `pnpm vitest run --project adapter-dsh`（含真实 dsh + 本地 mock Provider，不需要 Key） |
| `packages/host` | 会话管理、事件库、RPC 服务、进程入口 | `pnpm dev:host`；`pnpm gate:m2`（Gate M2 端到端验收） |
| `packages/client-sdk` | 连接、订阅、重连、消息投影 | `pnpm vitest run --project client-sdk` |
| `apps/desktop` | Electron 桌面端 | `pnpm dev`；`pnpm --filter @wevir/desktop palette` 重新生成色阶 |

全仓命令：`pnpm lint`（Biome + 引擎边界检查）、`pnpm typecheck`、`pnpm build`、`pnpm test`。全新克隆上依次 2 s、2 s、3 s、14 s（1000 条测试，结果见验收存档）。

## 4. 离线开发：echo 假引擎

不需要 dsh、模型或网络。echo 回复 `Echo: <输入>`，先按分片发增量、再发已提交消息；输入里的关键词（不分大小写）触发其他行为：

| 关键词 | 行为 |
|---|---|
| `tool` | 回复前模拟一次工具调用（不需要审批） |
| `approve` | 模拟一次需要审批的写文件；允许则工具完成，拒绝则工具失败 |
| `think` | 回复前先发一段思考 |
| `fail` | 回合以失败结束 |

取消时的行为与 dsh 相同：未决审批被取消，已生成的半段回复保留。

**桌面端连 echo Host。** 先在一个终端启动 echo Host，再在另一个终端让桌面端用同一个数据目录，它会附着而不是自己拉起：

```bash
pnpm dev:host
```

```bash
WEVIR_HOME="$PWD/.wevir-dev" pnpm dev
```

新建会话仍需要一个 Provider：设置里加一个“其他 OpenAI 兼容服务”，地址、模型、Key 随便填（echo 不用它），保存后的自动测试会显示失败，不影响使用。关窗口后 echo Host 继续运行，到第一个终端 Ctrl-C 结束。

2026-10-14 在全新克隆上验证：桌面端日志 `host attached`，发 `think tool 你好` 后会话里依次出现工具卡片、思考过程与 `Echo: think tool 你好`。

**测试里用 echo。** Host、client-sdk、CLI 的大部分测试都用 `EchoAdapter`（`@wevir/runtime-adapter/echo`）；`simulateEngineExit()` 模拟引擎进程退出。

## 5. 数据目录与日志

### 5.1 位置

解析顺序：`WEVIR_HOME` > `--home` > 平台默认（`packages/host/src/home.ts`）。

| 平台 | 默认位置 |
|---|---|
| macOS | `~/Library/Application Support/Wevir` |
| Windows | `%APPDATA%\Wevir` |
| 其他 | `$XDG_DATA_HOME/wevir`，未设时 `~/.local/share/wevir` |

`pnpm dev:host` 用仓库下的 `.wevir-dev/`。每个数据目录同一时间只能有一个 Host（`run/host.json` 排他占位），也只能有一个桌面端（单实例锁按数据目录）。

### 5.2 内容

| 路径 | 内容 |
|---|---|
| `wevir.db` | SQLite：工作区、Provider（不含 Key）、会话、事件、审批、发送回执。会话历史以这里的事件为准 |
| `secrets.json` | 模型 API Key，明文 JSON，0600（见[安全说明](./security.md) §3） |
| `host-id` | `hostId`，客户端据此认出同一个 Host |
| `device-id`、`desktop-client-id`、`cli-client-id` | 客户端身份，写进 `user.message.sentBy` 与审批的 `decidedBy`（CLI 的由 T4.2 写入） |
| `run/host.json` | 运行中 Host 的 `pid`、`startedAt`、`url`、令牌、版本。0600，Host 退出时删除 |
| `logs/host.log` | Host 的结构化日志，一行一个 JSON，只追加、不轮转 |
| `logs/host-stdio.log` | `wevir host start` 分离启动的 Host 的 stdout / stderr（T4.2） |
| `engines/dsh/` | dsh 的 `DSH_HOME`，也是 dsh 进程的 cwd：`profiles/acp/`、会话日志、Wevir 生成的 Provider overlay `wevir/providers.yml`（只有 Key 的变量名） |
| `engines/dsh-agents/` | dsh 的 `DSH_AGENTS_HOME`，空目录（安全说明 §4） |
| `desktop/` | Electron 的 userData（Chromium 配置、localStorage） |

数据目录及其子目录新建时为 0700；`secrets.json`、`run/host.json`、`logs/host.log` 与各身份文件为 0600，`wevir.db` 按默认 umask 创建，靠所在目录的 0700 挡住其他用户。dsh 在第一个会话需要它时才启动，`engines/dsh-agents/` 和 dsh 的会话日志到那时才出现。

### 5.3 日志

- **Host**：`logs/host.log`，字段 `{ts, level, msg, …}`。`--log-level debug|info|warn|error`，默认 info。字段名像令牌、密钥、密码、API Key 的值替换为 `[REDACTED]`，本次启动的令牌在任何字符串里出现都替换。stderr 是终端时同时镜像一份。
- **dsh**：stderr 只保留尾部；dsh 意外退出时，尾部随 `engine.exited` 写进会话的 `engine.error` 事件，桌面与 CLI 都能看到。
- **桌面主进程**：运行 `pnpm dev` 的终端，前缀 `[wevir-desktop]`。Host 起不来时界面顶部给出原因和 `logs/host.log` 的路径。
- **渲染进程**：DevTools 控制台（§3.1）。

想从头来过：关掉桌面端与 Host（确认 `run/host.json` 不在），删掉数据目录。

## 6. 测试

```bash
pnpm build && pnpm test
```

`pnpm test` 从根目录跑全部 Vitest project。拉起 Host 子进程的测试跑的是 `dist/`，所以先 `pnpm build`。真实 dsh + 本地脚本化 mock Provider 的集成测试包含在内，不需要 Key。单跑一个包：`pnpm --filter @wevir/<包名> test`，或 `pnpm vitest run --project <包名> [文件名过滤]`。内存紧张时加 `--maxWorkers=2`。

### 6.1 dsh 的三层契约测试

```bash
pnpm vitest run --project adapter-dsh dsh-adapter.contract
```

| 层 | 文件 | 需要 |
|---|---|---|
| 1. 回放 | `dsh-adapter.contract.test.ts` | 无（fake-dsh 回放 T0.3 录制的 ACP 样本），约 1 s |
| 2. 真实 dsh + mock Provider | `dsh-adapter.contract.integration.test.ts` | 无，约 20 s |
| 3. 真实 dsh + 真实模型 | `dsh-adapter.contract.real.integration.test.ts` | `WEVIR_TEST_API_KEY`、`WEVIR_TEST_PROVIDER`；缺了跳过并打印原因 |

### 6.2 真实模型测试的环境变量

| 变量 | 含义 |
|---|---|
| `WEVIR_TEST_API_KEY` | 模型 Key。设了它，下面几组测试才跑真实模型的用例 |
| `WEVIR_TEST_PROVIDER` | 只有契约第 3 层要：`deepseek-official` 或 `openai-compatible` |
| `WEVIR_TEST_BASE_URL` | 走 OpenAI 兼容服务时的地址，例如 `https://dashscope.aliyuncs.com/compatible-mode/v1`。不设则用 DeepSeek 官方 |
| `WEVIR_TEST_MODEL` | 模型 ID。设了 `WEVIR_TEST_BASE_URL` 时必填；用 DeepSeek 官方时可省略，各测试有自己的默认值 |

用到 Key 的测试：`packages/adapter-dsh` 的 `dsh-adapter.approval.integration`、`dsh-adapter.resume.integration`、`provider-test.integration`、`dsh-adapter.contract.real.integration`，以及 `packages/host` 的 `host-process.dsh.integration`。Key 只经环境变量传给测试，再只进 dsh 子进程的环境，不写进 overlay、快照或日志；不要把 Key 写进仓库里的任何文件。

DeepSeek 官方的例子：

```bash
WEVIR_TEST_API_KEY=<Key> WEVIR_TEST_PROVIDER=deepseek-official pnpm vitest run --project adapter-dsh dsh-adapter.contract.real
```

截至 2026-10-14 本机没有 Key，第 3 层与各真实模型用例都还没有跑过（Gate M3 的待办）。

### 6.3 其他

- **审批用例要求仓库不在系统临时目录下。** dsh 的 `workspace-write` 允许不经审批写 `/tmp` 与 `$TMPDIR`，审批用例的写入目标是 `packages/adapter-dsh/.test-outside/`；仓库克隆在 `/tmp` 下时，这些用例直接报“在系统临时目录 … 下，写入不会触发审批”。
- `WEVIR_RECORD_FIXTURES=1`：重新录制 adapter-dsh 的 resume 错误样本，见 `packages/adapter-dsh/src/test-fixtures/README.md`。
- `pnpm gate:m2`：Gate M2 的端到端验收（子进程 Host + 最小 WebSocket 客户端），`--keep` 保留临时数据目录。

## 7. 大陆网络

每一项都在 2026-10-14 的干净环境里实际走过一遍：全新的 `HOME` 与 `TMPDIR`（没有任何 npm、pnpm、Electron、git 的配置与缓存），`PATH` 里只有 Node 24.21.0 和系统目录，仓库是全新克隆；经一个只记录目标域名的本地 HTTP 代理，确认整个过程访问了哪些域名。

验证是在维护者本机的网络上做的，证明的是“配置生效、只访问镜像”；各镜像在大陆具体网络环境下的速度以实际为准。镜像（尤其是第三方 GitHub 代理）会变，失效时换一个，并把结果和日期更新到本节。

| 项 | 做法 | 2026-10-14 结果 |
|---|---|---|
| Node 安装包 | `https://npmmirror.com/mirrors/node/` | 24.21.0 macOS arm64 包 9 s，与 nodejs.org 的 `SHASUMS256.txt` 一致 |
| pnpm 本身 | `npm install -g pnpm@12.6.0 --registry=https://registry.npmmirror.com` | 9 s，只访问 npmmirror |
| npm registry | §7.2 | `pnpm install` 24 s，只访问 `registry.npmmirror.com`、`cdn.npmmirror.com` |
| Electron 二进制 | §7.3 | 129 MB，19 s，只访问 `npmmirror.com`、`cdn.npmmirror.com` |
| 上游参考仓库 | §7.4 | 3 个仓库 17–23 s，只访问镜像域名 |
| 模型服务 | §7.5 | DeepSeek、通义千问、Kimi、智谱均可达 |

### 7.1 Node 与 pnpm

Node 从 npmmirror 的 Node 镜像下载对应平台的安装包（目录结构与 nodejs.org/dist 相同），下载后用 nodejs.org 的 `SHASUMS256.txt` 核对。pnpm 用 npm 从镜像装：

```bash
npm install -g pnpm@12.6.0 --registry=https://registry.npmmirror.com
```

### 7.2 npm registry 切到 npmmirror

只改本机，不改仓库文件：

```bash
pnpm config set registry https://registry.npmmirror.com --location=global
```

在 macOS 上它写进 `~/Library/Preferences/pnpm/auth.ini`。改回官方：`pnpm config delete registry --location=global`。临时使用也可以只给一次命令加 `--registry=https://registry.npmmirror.com`。

`pnpm-lock.yaml` 只记 integrity，不记 registry 地址：切换镜像不会改动 lockfile，从镜像下载的每个包都按 lockfile 里的哈希校验。实测经镜像安装后 `git status` 干净。

### 7.3 Electron 二进制：`ELECTRON_MIRROR`

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

末尾的 `/` 不能省：下载地址是 `<ELECTRON_MIRROR>v44.7.0/electron-v44.7.0-<平台>-<架构>.zip`。在第一次 `pnpm dev` 之前设好（或写进 shell 配置文件）；Windows PowerShell 用 `$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"`。

下载的文件按 `electron` npm 包自带的 `checksums.json` 校验，镜像替换不了二进制。下载包缓存在 `~/Library/Caches/electron`（macOS），解压到 `node_modules/.pnpm/electron@44.7.0/node_modules/electron/dist`。想看实际下载地址，加 `DEBUG='@electron/get*'`。

### 7.4 上游参考仓库：`WEVIR_GITHUB_MIRROR`

`upstream/` 只是只读参考（读 dsh、OpenWork、Paseo 的源码、移植时核对），构建和运行都不需要它。`scripts/upstream-sync.sh` 把 `https://github.com` 前缀换成这个变量的值：

```bash
WEVIR_GITHUB_MIRROR=https://ghfast.top/https://github.com bash scripts/upstream-sync.sh
```

脚本按 SHA 浅拉取 `docs/upstream/upstream.lock` 里的锁定提交，最后检查 `HEAD` 与锁定的 SHA 一致才算完成，所以经第三方镜像拿到的内容与 GitHub 上的同一提交逐字节相同。

2026-10-14 的结果：`https://ghfast.top/https://github.com`、`https://gh-proxy.com/https://github.com` 都能同步三个仓库（`ghproxy.net` 的同类前缀 `git ls-remote` 也能通）；`kkgithub.com`、`bgithub.xyz`、`githubfast.com` 不可用；`gitclone.com/github.com` 是缓存型镜像，分支头落后于 GitHub，缺锁定提交时脚本会沿分支加深查找，找不到就报错。

### 7.5 模型服务

在设置里新建 Provider 时先选这几项（桌面端的模板取自 [providers.md](./architecture/providers.md) §7）：

1. **DeepSeek 官方（首选）。** 类型 `deepseek-official`，走 dsh 原生的 DeepSeek 适配器，只要填 Key。
2. **国内的 OpenAI 兼容服务：** 通义千问（阿里云百炼）、Kimi、智谱 GLM。地址按 Key 所在的站点和套餐选：Kimi 国内站的 Key 只能配 `api.moonshot.cn`；百炼的国际站、Coding Plan，智谱的 GLM Coding 套餐都有各自的地址，不能混用。细节见 providers.md §7。
3. **本机模型（Ollama、vLLM 等）。** 地址 `http://127.0.0.1:11434/v1` 一类，Key 随便填。本机没有装，未验证。

海外服务（OpenAI 官方等）只要是 OpenAI 兼容协议也能配，但需要能访问对方的网络，未验证；`anthropic-messages` 协议骨架阶段不支持。

2026-10-14 的验证：在全新数据目录上用一个无效的 Key 依次登记上面的 DeepSeek（官方类型与 OpenAI 兼容两种）、通义千问、Kimi、智谱，经 Host 的 `provider.test` 得到的结论都是 `auth`（HTTP 401）：地址可达、按所选协议应答、认出了 Key 无效。用真实 Key 完成对话尚未验证。另外，审批卡片要靠模型按 dsh 的提示升级沙箱权限才会出现，真实模型上是否可靠也还没有验证（ADR-0001 未决事项 3）。

## 8. 常见问题

**`pnpm dev` 报 `Error: Electron uninstall`。** Electron 二进制没装上。electron-vite 不会替 Electron 44 下载，dev 脚本里的 `install-electron` 负责这一步；它失败了就设好 `ELECTRON_MIRROR` 再跑一次 `pnpm dev`，或单独执行 `pnpm --filter @wevir/desktop exec install-electron`。

**`Failed to resolve entry for package "@wevir/client-sdk"`。** T6.1 之前的提交上，主进程打包的是各包的 `dist/`，没构建过的全新克隆会报这个。更新到当前代码，或先 `pnpm build`。

**`Port 5199 is already in use`。** 另一个 `pnpm dev` 还开着。渲染进程的端口不能换（它的 origin 在 Host 的白名单里），关掉另一个。

**窗口一闪就退出，终端里没有报错。** 同一个数据目录已经有一个桌面端在运行，新开的把焦点交给它后退出。要同时开两个，给第二个设不同的 `WEVIR_HOME`。远程调试端口 9339 被占时用 `WEVIR_DESKTOP_DEBUG_PORT` 换一个。

**“在 PATH 里找不到 node”。** 主进程用本机 Node 拉起 Host，从图形界面启动或 `PATH` 不含 Node 时会这样。用 `WEVIR_NODE` 指定 Node 的绝对路径。

**Host 起不来 / “Host 无法启动”。** 看界面给出的原因与 `logs/host.log`。`wevir-host` 退出码 3 表示该数据目录已有 Host 在运行；Host 被强杀后留下的 `run/host.json` 会按 `pid` 与启动时刻判定为陈旧，下次启动自动清掉。

**`pnpm lint` 报命令 shim 导出了 `NODE_PATH`。** 在 `extendNodePath: false` 加入之前装过依赖的 checkout 要 `pnpm install --force` 一次（AGENTS.md 规则 2）。

**`ERR_PNPM_IGNORED_BUILDS`。** 依赖升级带来了没登记的构建脚本，按 ADR-0004 §2 审查后登记到 `allowBuilds`，不要关掉 `strictDepBuilds`。

**`ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER`（CI 的 `--frozen-lockfile`）。** 新包没有依赖时 pnpm 12.6 不写它的 lockfile 条目，运行 `pnpm install --fix-lockfile`（AGENTS.md）。

**审批相关的 dsh 测试失败，说目标“在系统临时目录下”。** 把仓库克隆到系统临时目录以外（§6.3）。

**设了 `NODE_USE_ENV_PROXY=1` 和 `HTTPS_PROXY` 之后连本机服务也走了代理。** 这个开关让 Node 内置的 HTTP 客户端（含 `fetch`）按代理变量走，到 Host（127.0.0.1）的连接、`provider.test` 到本机 Ollama 都可能经过代理。同时设 `NO_PROXY=localhost,127.0.0.1`。pnpm 与 git 本来就认 `HTTPS_PROXY`，不需要这个开关。
