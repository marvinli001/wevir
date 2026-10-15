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

Host 的默认引擎是 Codex（ADR-0005，R3 起），要先下载锁定版本的 `codex-app-server`（每个平台压缩 72–82 MiB，解压 181–243 MiB，不在 npm 依赖里）：

```bash
bash scripts/fetch-codex.sh
```

它按平台（macOS arm64 / x64、Linux musl x64 / arm64、Windows x64 / arm64，Windows 在 Git Bash 里运行）下载 GitHub Release 的压缩包，按脚本里的 sha256 校验后解到 `.wevir-dev/bin/codex-app-server[.exe]`（gitignore），Linux 另带 `codex-resources/bwrap`，已是同一版本就直接退出。大陆网络设 `WEVIR_GITHUB_MIRROR`（§7.4）。也可以不下载、用 `WEVIR_CODEX_BIN=<绝对路径>` 指向别处的同版本二进制；版本不对时 Host 在第一次启动它之前报错。准备安装包用的资源目录见 §3.5。

安装时会跑 5 个依赖的构建脚本（`pnpm-workspace.yaml` 的 `allowBuilds` 逐个登记：dsh 的 `dsh-subprocess-local`、`node-pty`、`koffi`、两个版本的 `esbuild`），其他构建脚本一律不跑。`strictDepBuilds` 保持开启，依赖升级后冒出没登记的构建脚本时安装直接失败（`ERR_PNPM_IGNORED_BUILDS`），审查后再登记，见 ADR-0004 §2。

## 3. 运行

### 3.1 `pnpm dev`：桌面端 + Host

```bash
pnpm dev
```

它依次做三件事（`apps/desktop` 的 `dev` 脚本）：

1. 用 tsdown 构建 `@wevir/host` 及其依赖（protocol、storage、runtime-adapter、adapter-acp、adapter-dsh、model-gateway、adapter-codex），因为 Host 是运行 `packages/host/dist/main.js` 的子进程。
2. `install-electron`：Electron 44 没有 postinstall，二进制要单独下载。第一次运行时下载并按 npm 包里的 `checksums.json` 校验，之后检查到已安装就立即退出。大陆网络先设 `ELECTRON_MIRROR`（§7.3）。
3. `electron-vite dev`：构建主进程与 preload，渲染进程的开发服务器固定在 `http://localhost:5199`（`strictPort`，因为这个 origin 在 Host 的白名单里），然后打开窗口。

窗口打开后，主进程读数据目录里的 `run/host.json`：有活着的 Host 就附着；没有就用 Electron 自带的 Node（Electron 本身加 `ELECTRON_RUN_AS_NODE=1`，不用另装 Node，ADR-0007 决策 4）拉起 `wevir-host --home <数据目录> --exit-on-stdin-eof`（默认的 Codex 引擎，要先 `bash scripts/fetch-codex.sh`），并持有它的 stdin 作为归属管道。关窗口即退出，同时停掉自己拉起的 Host；附着的 Host 不受影响。左栏列出工作区即就绪（全新数据目录显示三步引导）；连上时界面上不显示连接状态，连不上或断线时窗口顶部才出提示，设置 → 关于里能看到连接状态与 Host 进程、版本。

实测（全新克隆，Node 24.21.0）：第一次 `pnpm dev` 26 s 连上 Host，其中从 npmmirror 下载 Electron 约 19 s；第二次 4 s。

| 环境变量 | 作用 |
|---|---|
| `WEVIR_HOME` | 数据目录（§5），桌面、Host、CLI 的解析规则相同。用相对路径时请写成绝对路径，例如 `WEVIR_HOME="$PWD/.wevir-dev"` |
| `WEVIR_NODE` | 改用这个 Node 可执行文件拉起 Host（排查用）。默认用 Electron 自带的 Node |
| `WEVIR_DESKTOP_DEBUG_PORT` | 渲染进程的 Chrome 远程调试端口，默认 9339，只在开发模式打开、只监听 127.0.0.1 |
| `ELECTRON_MIRROR` | Electron 二进制的下载地址（§7.3） |
| `WEVIR_ANTIGRAVITY_MIRROR` | 在设置里下载 Antigravity 运行体时替换 `https://dl.google.com` 前缀（§7.4） |

**调试。** 渲染进程：Chrome 打开 `chrome://inspect`，在 Configure 里加 `localhost:9339`，或直接用 `http://127.0.0.1:9339/json` 走 DevTools 协议。主进程的日志带 `[wevir-desktop]` 前缀，打在运行 `pnpm dev` 的终端里。Host 的日志在数据目录的 `logs/host.log`（§5.2）。

**窗格布局。** 开发模式下顶栏“已打开的标签页”菜单的“打开窗格”里还列着以后的窗格种类（变更、文件预览等）的占位，用来检查多个窗格的排布（[desktop-layout.md](./architecture/desktop-layout.md) §2.1）；正式构建里只有已经实现的种类。每个会话的窗格与尺寸存在渲染进程的 localStorage（`wevir.panes.v1`），想从头来过可以在 DevTools 里删掉它。

**动效（U3）。** libraries.dev 的动效封装在 `apps/desktop/src/renderer/src/fx/`（ADR-0004 补记 9）。开发模式下打开 `#/dev/fx` 是动效样张：九种 thinking orb、两种光束、子智能体头像、“插话 | 排队”切换、金属按钮 / 字标 / “新”徽标、图片显现，右上角能切深浅色。动效库在运行时插 `<style>`，开发服务器与构建产物的 CSP 都只放行带 nonce 的（`src/shared/csp.ts`），所以**要在正式构建里核对**：

```bash
VITE_WEVIR_FX_GALLERY=1 pnpm --filter @wevir/desktop build
```

带这个变量构建才有 `#/dev/fx`（默认的构建连同它的 chunk 一起摇掉）。然后在 `apps/desktop` 里用构建产物启动（`wevir://` 协议与生产 CSP），附着到自己起的 Host，用 9359 之类的端口走 DevTools 协议看控制台有没有 CSP 报告：

```bash
WEVIR_HOME="$PWD/../../.wevir-dev" ./node_modules/.bin/electron . --remote-debugging-port=9359
```

echo 引擎（§4）的回合很短，看不清进行中的效果；可以用 `approve`（停在审批上）或 `slow` 拉长。减弱动效用 DevTools 协议的 `Emulation.setEmulatedMedia`（`prefers-reduced-motion: reduce`）模拟。窗口被别的窗口挡住时 rAF 会停，所有效果都不动，测性能要让窗口露在外面。

**子智能体（R5）。** 不用 Key 就能看到：用 `@wevir/adapter-codex/testing` 的 mock 模型登记一个 Provider（见下面 Codex 一段），在会话里发含“子智能体”的消息，父 agent 会派一个子 agent 并等它（spawn → wait）；再加“工具”让子 agent 跑一次 `ls`，加“长”让它慢慢回答，加“工作区外”让它请求审批（父会话的输入框上方会出现标着来自哪个子智能体的审批卡片；审批要写到工作区与系统临时目录之外，`WEVIR_MOCK_OUTSIDE_DIR` 指定目录）。消息流里点“〈标题〉开始工作 / 已完成”、置顶摘要的“子智能体”或列表里的一项进入子 agent 视图，地址是 `#/workspace/<工作区>/session/<父会话>/agent/<子会话>`（[desktop-layout.md](./architecture/desktop-layout.md) §10）。

**引擎。** 桌面端拉起的 Host 用默认的 Codex。要用 dsh（可选引擎），或想让 Host 在关窗口之后继续运行，先在同一个数据目录里自己启动 Host，桌面端会附着到它（关窗口不停它）：

```bash
pnpm build
```

```bash
pnpm --silent wevir --home "$PWD/.wevir-dev" host start --adapter dsh
```

```bash
WEVIR_HOME="$PWD/.wevir-dev" pnpm dev
```

Codex 引擎的模型请求都经 Host 里的模型网关（[model-gateway.md](./architecture/model-gateway.md)），Provider 的配置与 dsh 相同（设置页或 `wevir provider add`）；`openai-completions`、`openai-responses`、`anthropic-messages` 三种协议和 DeepSeek 官方都能用。没有 Key 时可以用 `@wevir/adapter-codex/testing` 的本地 mock 模型（`startMockModel()`，Responses 协议，`openai-compatible` + `openai-responses`，Key 填任意值）：默认脚本按提示词里的关键词回答（`工具` 调一次 `ls`，`补丁` 新建文件，`工作区外` 越出沙箱 `touch` 一个文件、会请求审批，`长` 慢慢流出长回答、用来试取消），也会回会话标题的请求（`test-fixtures/mock-model.ts` 的 `defaultMockScript`）。

改渲染进程的代码由 Vite 热更新；改了主进程、preload 或 `packages/host`，关掉窗口重新 `pnpm dev`。主进程与渲染进程按 `@wevir/source` 条件直接打包 client-sdk、protocol 等工作区包的源码，改了这些包不用先构建；Host 子进程跑的是 `dist/`，dev 脚本每次都会重新构建它。

### 3.2 单独运行 Host

```bash
pnpm dev:host
```

构建 `@wevir/host` 及其依赖，以 echo 假引擎在仓库下的 `.wevir-dev/` 启动 Host（gitignore），Ctrl-C 优雅退出。就绪后 stdout 打印一行 `{"event":"ready","url":…}`，连接信息在 `.wevir-dev/run/host.json`。要用真实的引擎、调整日志级别时直接运行入口（不带 `--adapter` 就是 Codex）：

```bash
node packages/host/dist/main.js --home ./.wevir-dev --log-level debug
```

```bash
node packages/host/dist/main.js --home ./.wevir-dev --adapter dsh
```

Codex 引擎要先有 `codex-app-server`（§2 的 `fetch-codex.sh` 或 `WEVIR_CODEX_BIN`），找不到时 Host 直接启动失败并给出下载命令。`codex-app-server` 在第一个会话时才启动。会话标题：第一个回合开始后 Host 用会话的模型生成（`prompts/thread-title.md`，Codex 引擎才有），之前与失败时用首条消息截断的标题。

参数见 `node packages/host/dist/main.js --help`。退出码：0 正常，1 运行失败，2 参数错误，3 该数据目录已有 Host 在运行（读 `host.json` 附着即可）。

### 3.3 命令行客户端

`apps/cli`（T4.2）合入后，`pnpm build` 再运行 `pnpm --silent wevir --help`。`wevir host start [--adapter codex|dsh|echo]`（默认 codex）以分离方式启动 Host，桌面端随后附着它；`wevir session attach <id>` 与桌面看同一事件流、可以在终端里审批。`wevir provider login` / `status` / `logout` 管 ChatGPT 账号（R6，设备码方式，只有 Codex 引擎有）。数据目录与 Host 相同（`WEVIR_HOME` 或 `--home`）。

### 3.4 各包单独开发

类型检查与测试都按 `@wevir/source` 条件直接用依赖包的源码，不需要先构建（ADR-0004 补记 1）。只有在 Node 里直接运行包（Host、CLI，或测试里拉起 Host 子进程）时才需要 `pnpm build`。

| 包 | 职责（详见[架构总览](./architecture/overview.md) §2） | 开发时常用 |
|---|---|---|
| `packages/protocol` | Host API 的 schema、方法表、事件、错误码 | `pnpm --filter @wevir/protocol test`；改了协议同步 `docs/architecture/host-api.md`（表格由测试比对） |
| `packages/runtime-adapter` | 引擎适配接口、契约测试套件、echo 假引擎 | `pnpm vitest run --project runtime-adapter` |
| `packages/storage` | SQLite、迁移、仓储、SecretStore | `pnpm vitest run --project storage` |
| `packages/adapter-acp` | 通用 ACP 适配器：引擎描述、ACP 进程、映射、事件队列、会话与审批记账 | `pnpm vitest run --project adapter-acp`；它的大部分行为由 adapter-dsh 的测试经 dsh 覆盖 |
| `packages/adapter-dsh` | dsh 的引擎描述与启动器、增量旁路、Provider 桥接 | `pnpm vitest run --project adapter-dsh`（含真实 dsh + 本地 mock Provider，不需要 Key） |
| `packages/adapter-codex` | Codex 引擎（默认）：`codex-app-server` 进程与握手、CODEX_HOME 与生成的配置、会话与回合、通知 → AgentEvent、审批、取消与恢复、计划、错误归类、会话标题（[codex-event-mapping.md](./architecture/codex-event-mapping.md)） | `pnpm vitest run --project adapter-codex`（回放不需要二进制；真实二进制 + 网关 + mock 模型不需要 Key，没有二进制时跳过并打印下载命令） |
| `packages/adapter-cursor` | Cursor 引擎（订阅来源）：`@cursor/sdk` 的应用内登录、模型、本地 agent、流式更新 → AgentEvent、取消与恢复（[cursor-event-mapping.md](./architecture/cursor-event-mapping.md)） | `pnpm vitest run --project adapter-cursor`（假 SDK 与本机 mock 后端，不需要 Cursor 账号、不联网；真实回合的手动步骤见映射文档 §8） |
| `packages/adapter-opencode` | OpenCode 引擎（订阅来源）：用户的 `opencode`、本机服务器、账号与模型、规则集与审批、子 agent、流式事件 → AgentEvent、插话、标题、支线、取消与恢复（[opencode-event-mapping.md](./architecture/opencode-event-mapping.md)） | `pnpm vitest run --project adapter-opencode`（假 opencode 回放真实录音，不需要 opencode）；装了 opencode 时 `WEVIR_TEST_OPENCODE=1 WEVIR_TEST_OPENCODE_BIN="$(which opencode)" pnpm vitest run --project adapter-opencode contract.real`（真实 opencode + 本机假模型，不用订阅、不联网）；用订阅的手动步骤见映射文档 §9 |
| `packages/adapter-grok` | Grok Build 引擎（订阅来源）：用户自己的 `grok` 的账号检测、按权限模式分进程的 ACP 会话、xAI 扩展（[grok-event-mapping.md](./architecture/grok-event-mapping.md)） | `pnpm vitest run --project adapter-grok`（假 grok 回放 T3 录的真实样本，不需要 Grok 账号、不联网；真实 `grok` 见 §6.2b） |
| `packages/adapter-antigravity` | Antigravity 引擎（订阅来源）：钉住版本的下载安装、私有 profile、应用内 Google 登录、经通用 ACP 适配器的会话（[antigravity-event-mapping.md](./architecture/antigravity-event-mapping.md)） | `pnpm vitest run --project adapter-antigravity`（本机假下载服务器与假运行体，不下载真实运行体、不联网；真实运行体的手动步骤见映射文档 §8） |
| `packages/model-gateway` | Codex 用的模型协议网关：Responses 透传与 Chat、Anthropic Messages 转换（[model-gateway.md](./architecture/model-gateway.md)） | `pnpm --filter @wevir/model-gateway test`（本地 mock 上游，不需要 Key）；真实 `codex-app-server` 经它跑 Spike 场景见 model-gateway.md §9 |
| `packages/host` | 会话管理、事件库、RPC 服务、进程入口 | `pnpm dev:host`；`pnpm gate:m2`（Gate M2 端到端验收） |
| `packages/client-sdk` | 连接、订阅、重连、消息投影 | `pnpm vitest run --project client-sdk` |
| `apps/desktop` | Electron 桌面端 | `pnpm dev`；改了设计变量跑 `pnpm vitest run --project desktop`（含对比度校验，[desktop-tokens.md](./design/desktop-tokens.md) §7）；字体用 `apps/desktop/scripts/build-fonts.py` 重新生成（用法在脚本开头，平时不需要） |

全仓命令：`pnpm lint`（Biome + 引擎边界检查）、`pnpm typecheck`、`pnpm build`、`pnpm test`。全新克隆上依次 2 s、2 s、3 s、14 s（1000 条测试，结果见验收存档）。

### 3.5 随安装包的运行时：资源目录

安装包内置锁定版本的 `codex-app-server`，运行时不从网上下载（ADR-0005 决策 8、[ADR-0007](./adr/0007-packaging-and-runtime-distribution.md) 决策 5）。打包工具（electron-builder）的配置还没加，下面这一步是它的前置：

```bash
pnpm --filter @wevir/desktop resources
```

它运行 `apps/desktop/scripts/stage-resources.ts`：用 `scripts/fetch-codex.sh --target <三元组> --out <目录>` 取本机平台（或 `-- --target <三元组>` 指定的平台，三元组见脚本）的二进制并按 sha256 校验，连同 `apps/desktop/licenses/codex/` 里 Codex 的 `LICENSE` 与 `NOTICE` 放进 `apps/desktop/resources/engines/codex/`（gitignore）；Linux 另带 `codex-resources/bwrap`。打包时这个目录原样进入安装包的资源目录（`process.resourcesPath`）。

打包后的桌面端拉起 Host 时设 `WEVIR_RESOURCES_DIR=<资源目录>`（环境里已有时不覆盖）。adapter-codex 找二进制的顺序是 `WEVIR_CODEX_BIN` → `<WEVIR_RESOURCES_DIR>/engines/codex/` → 开发缓存 `.wevir-dev/bin/`。开发时桌面端不设这个变量；要在开发构建上模拟安装后的布局，自己设上它并让开发缓存里没有二进制，例如：

```bash
WEVIR_HOME="$(mktemp -d)" WEVIR_RESOURCES_DIR="$PWD/apps/desktop/resources" node packages/host/dist/main.js
```

macOS 上要连“不联网也能用 Codex”一起验证时，用 `sandbox-exec` 只放行本机地址，再按 §3.1 的 mock 模型做法建 Provider 与会话（R9 的验收记录见 ADR-0007 的“后果”）：

```bash
sandbox-exec -p '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))' <命令>
```

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
| `settings.json` | Host 设置（R11，domain-model §3.7）：目前只有“回合进行中按回车”插话还是排队（`sendWhileBusy`），桌面端与 CLI 共用；没有这个文件时用默认值 |
| `device-id`、`desktop-client-id`、`cli-client-id` | 客户端身份，写进 `user.message.sentBy` 与审批的 `decidedBy`（CLI 的由 T4.2 写入） |
| `run/host.json` | 运行中 Host 的 `pid`、`startedAt`、`url`、令牌、版本。0600，Host 退出时删除 |
| `logs/host.log` | Host 的结构化日志，一行一个 JSON，只追加、不轮转 |
| `logs/host-stdio.log` | `wevir host start` 分离启动的 Host 的 stdout / stderr（T4.2） |
| `engines/dsh/` | dsh 的 `DSH_HOME`，也是 dsh 进程的 cwd：`profiles/acp/`、会话日志、Wevir 生成的 Provider overlay `wevir/providers.yml`（只有 Key 的变量名） |
| `engines/dsh-agents/` | dsh 的 `DSH_AGENTS_HOME`，空目录（安全说明 §4） |
| `engines/codex/` | Codex 的 `CODEX_HOME`，也是 `codex-app-server` 的 cwd：Wevir 每次启动它之前重写的 `config.toml` 与模型目录 `wevir-models.json`（只有网关令牌的变量名，没有 Key），以及 Codex 自己的 rollout（`sessions/`）、SQLite 库、`shell_snapshots/` 等 |
| `engines/codex-chatgpt/` | ChatGPT 进程的 `CODEX_HOME`（R6）：Wevir 重写的 `config.toml`（没有 Provider 与模型目录），登录后 Codex 写的 `auth.json`（0600，ChatGPT 的令牌，见[安全说明](./security.md) §3），以及它自己的 rollout 与 SQLite 库。第一次用到 ChatGPT 账号时才出现 |
| `engines/claude/` | Claude Agent 引擎（2026-10-15）探测登录与生成标题时的工作目录，里面没有 Wevir 的文件。会话记录与登录都在用户自己的 `~/.claude`（`claude` 写，Wevir 不读不改），见 [claude-event-mapping.md](./architecture/claude-event-mapping.md) §2 |
| `engines.json` | `account.setPath` 指定的订阅引擎可执行文件（0.19.0） |
| `history/` | 接力过的会话的完整历史（0.25.0，domain-model §3.14）：`<会话 ID>.json`（0600），会话换到挂了读历史工具的引擎时由 Host 写，读历史的 MCP 服务只读这里 |
| `mcp/` | Host 给引擎挂的本机 MCP 服务的脚本（0.25.0 的 `wevir-history.mjs`），引擎第一次启动前写，每次覆盖 |
| `images/` | 消息里的图片（0.28.0）：`<图片 ID>.<扩展名>` 与旁边的 `<图片 ID>.json`（Host 认定的格式、大小与像素），0600；`staged/` 里是上传了还没发出去的，过一天删掉 |
| `engines/cursor/` | Cursor 引擎：应用内登录铸出的 API Key `auth.json`（0600，见[安全说明](./security.md) §3）。第一次登录 Cursor 时才出现；agent 的对话由 Cursor 的 SDK 存在它自己的位置（`~/.cursor/projects/`） |
| `engines/opencode/` | OpenCode 引擎：读账号时 `opencode serve` 的工作目录，`servers/` 是本机服务器的台账（0600，进程身份与端口）。登录、配置与会话都在用户自己的 opencode 目录（`~/.config/opencode`、`~/.local/share/opencode`），Wevir 不读不改，见 [opencode-event-mapping.md](./architecture/opencode-event-mapping.md) §1 |
| `engines/antigravity/` | Antigravity 引擎：`runtime/<平台>-<架构>/`（设置里下载的运行体，`active.json` 指向装好的版本，没下完的在 `downloads/`）、`profile/`（运行体的 `GEMINI_HOME`：Google 登录 `antigravity-acp/acp_token.json` 与对话，Wevir 不读登录的内容）、`tmp/`（每个进程的解包目录，约 1 GB，进程退出后删掉）、`models.json`（模型列表）。第一次下载或登录时才出现 |
| `desktop/` | Electron 的 userData（Chromium 配置、localStorage） |

数据目录及其子目录新建时为 0700；`secrets.json`、`run/host.json`、`logs/host.log` 与各身份文件为 0600，`wevir.db` 按默认 umask 创建，靠所在目录的 0700 挡住其他用户。dsh 在第一个会话需要它时才启动，`engines/dsh-agents/` 和 dsh 的会话日志到那时才出现。

### 5.3 日志

- **Host**：`logs/host.log`，字段 `{ts, level, msg, …}`。`--log-level debug|info|warn|error`，默认 info。字段名像令牌、密钥、密码、API Key 的值替换为 `[REDACTED]`，本次启动的令牌在任何字符串里出现都替换。stderr 是终端时同时镜像一份。
- **模型网关**（Codex 引擎）：每个请求一行 `gateway request`（方法、Provider ID、结果、上游状态码、耗时），写在 `logs/host.log`。网关令牌每次启动 `codex-app-server` 换一个，出现在日志里会被抹掉。
- **dsh、codex-app-server**：stderr 只保留尾部（codex-app-server 的 `RUST_LOG=warn`）；dsh 意外退出时，尾部随 `engine.exited` 写进会话的 `engine.error` 事件，桌面与 CLI 都能看到。
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

### 6.2 Codex 适配器的测试

```bash
bash scripts/fetch-codex.sh
```

```bash
pnpm vitest run --project adapter-codex --maxWorkers=2
```

三层契约测试照 adapter-dsh，能力开关全开：

```bash
pnpm vitest run --project adapter-codex codex-adapter.contract
```

| 文件 | 内容 | 需要 |
|---|---|---|
| `codex-adapter.contract.test.ts` | 契约第 1 层：假的 app-server（`test-fixtures/fake-app-server.mjs`）回放真实二进制录的通知与审批对话；子会话的条款跳过（回放层不模拟子 thread 的审批与中断） | 无；约 3 s |
| `codex-adapter.contract.integration.test.ts` | 契约第 2 层：真实 `codex-app-server` + 网关 + 本地 mock 模型，含子会话的三条（派出与订阅、子会话的审批、取消子回合） | 二进制；约 20 s |
| `codex-adapter.contract.real.integration.test.ts` | 契约第 3 层：真实二进制 + 网关 + 真实模型 | 二进制、`WEVIR_TEST_API_KEY`、`WEVIR_TEST_PROVIDER`（§6.3）；缺了跳过并打印原因 |
| `mapping.test.ts`、`turn-error.test.ts`、`resume-error.test.ts` 等单元测试 | 回放真实二进制录的样本（`src/test-fixtures/app-server/`：通知、审批对话、错误）、配置与提示词的生成、展示类型 | 无 |
| `codex-adapter.{approval,resume,turn}.integration.test.ts` | 审批的各个决定、恢复与取消的兜底、计划、错误归类、会话标题 | 二进制；共约 30 s |
| `codex-adapter.integration.test.ts` | 握手、Provider 变更、版本核对 | 二进制；约 5 s |
| `codex-adapter.subagent.test.ts`、`codex-adapter.subagent.integration.test.ts` | 子会话（R4）：回放录制的子 agent 样本（含子 thread 先于 spawn 完成到达、按 rootTurnId 认出的顺序）；真实二进制上的 spawn → wait、不等子 agent、`close_agent`、取消父回合时子 agent 不受影响、notFound 不当作子会话 | 回放无；真实二进制约 3 s |
| `codex-adapter.isolation.integration.test.ts` | 外连为零（代理 + lsof）、令牌与 Key 不落盘不进日志、命令看不到 `WEVIR_*` | 二进制；约 10 s |
| `account.test.ts`、`codex-runtime.chatgpt.integration.test.ts` | ChatGPT 进程（R6）：账号状态机与 `model/list` 的换算；真实二进制 + 本机 mock 登录服务与后端（`test-fixtures/mock-chatgpt.ts`）走设备码与浏览器登录、取消、登出、模型列表、会话分到哪个进程，外连经拒绝的代理 | 单元无；真实二进制约 10 s，不需要账号 |

没有二进制时集成测试跳过并打印下载命令。审批用例写 `packages/adapter-codex/.test-outside/`（工作区外、且不在系统临时目录，gitignore），同 §6.4 的第一条。升级 Codex 按 [UPSTREAM.md](./upstream/UPSTREAM.md)「Codex 升级检查清单」，其中重录样本是 `WEVIR_RECORD_CODEX=1 pnpm vitest run --project adapter-codex record-app-server`。Host 一侧的端到端是 `packages/host/src/cli.codex.integration.test.ts` 与子会话的 `cli.codex.subagent.integration.test.ts`（派出子会话、子会话的审批经父会话处理、取消父会话时级联取消；写 `packages/host/.test-outside/`）。mock 模型的默认脚本里“子智能体”（或 `subagent`）让父 agent 派一个子 agent 并等它（与 Spike 的 subagent 场景相同的 spawn → wait），再加“工作区外”让子 agent 请求审批、加“长”让它慢慢回答；echo 引擎的 `subagent` 关键词是同样的流程（`packages/runtime-adapter/src/echo.ts`）。

ChatGPT 登录在桌面端的验收不需要真实账号：在 scratch 目录写一个小脚本，用 `@wevir/adapter-codex` 的 `CodexRuntime`（`chatgptEndpoints` 指向 `@wevir/adapter-codex/testing` 的 `startMockChatgpt()`）与 `@wevir/host` 的 `startHost` 起一个 Host，再 `WEVIR_HOME=<那个目录> WEVIR_DESKTOP_DEBUG_PORT=9349 pnpm --filter @wevir/desktop dev` 附着它；设备码登录由 mock 的 `approveDeviceCode()` 放行（浏览器登录会打开系统浏览器，验收时少用）。真实账号的登录与对话要维护者自己操作。

### 6.2a Claude Agent 适配器的测试

```bash
pnpm vitest run --project adapter-claude
```

| 文件 | 内容 | 需要 |
|---|---|---|
| `claude-adapter.contract.test.ts` | 契约第 1 层：假的 Claude Agent SDK（`test-fixtures/fake-sdk.ts`）回放真实 `claude` 录的消息（`src/test-fixtures/sdk/`），审批按决定走对应录音的分支 | 无；约 3 s |
| `claude-adapter.test.ts`、`account.test.ts`、`units.test.ts` | 映射回放、账号检测、找可执行文件、模型目录、结果归类 | 无 |
| `claude-adapter.contract.real.integration.test.ts` | 契约真实层：本机真实的 `claude` 与用户的登录（`claude-haiku-4-5`，会用掉订阅额度），`WEVIR_TEST_CLAUDE=1` 才跑，`WEVIR_TEST_CLAUDE_MODEL` 可换模型；可以用 `-t` 只跑几条 | 装好并登录的 `claude` |

跑真实 `claude` 的测试与录制要用干净的环境：在 Claude Code 里开的终端带着它的一堆环境变量（含 `ANTHROPIC_BASE_URL`），会被继承给 `claude`。

```bash
env -i HOME="$HOME" PATH="$PATH" USER="$USER" WEVIR_TEST_CLAUDE=1 pnpm vitest run --project adapter-claude contract.real -t '一问一答|审批：选允许'
```

重录样本：`env -i HOME="$HOME" PATH="$PATH" USER="$USER" WEVIR_RECORD_CLAUDE=1 pnpm vitest run --project adapter-claude record-sdk`。`WEVIR_CLAUDE_BIN` 可指定 `claude` 的路径（优先于自动查找，低于设置里指定的路径）。桌面端走一遍：`env -i HOME="$HOME" PATH="$PATH" USER="$USER" WEVIR_CODEX_BIN=<codex-app-server> pnpm --silent wevir --home <目录> host start`（默认的 Codex Host 带着订阅引擎），再 `WEVIR_HOME=<目录> WEVIR_DESKTOP_DEBUG_PORT=9361 ./node_modules/.bin/electron-vite dev`（在 apps/desktop 里）；设置 → 模型服务里 Claude Agent 显示套餐与用量，模型选择里有它的模型。测完删掉 `~/.claude/projects` 下以临时工作目录命名的那个文件夹（`claude` 的会话记录）。

### 6.2b Grok 适配器的测试

```bash
pnpm vitest run --project adapter-grok
```

| 文件 | 内容 | 需要 |
|---|---|---|
| `grok-adapter.contract.test.ts` | 契约：GrokAdapter 起假 grok（`src/test-fixtures/fake-grok.mjs`，真的子进程与 ACP），引擎写出的消息回放 T3 Code 录的真实 Grok Build 样本（`src/test-fixtures/acp/`） | 无；约 5 s |
| `grok-adapter.test.ts`、`accounts.test.ts`、`units.test.ts` | 样本回放（增量、待办、审批、提问、取消、回合失败、唤醒回合）、按模式分进程、会话中换模式与模型、认证后重试、resume；账号检测；编解码与工具展示 | 无 |
| `grok-adapter.contract.real.integration.test.ts` | 真实 `grok` 的账号检测与契约（用户自己的登录，会用掉订阅额度），`WEVIR_TEST_GROK=1` 才跑，`WEVIR_TEST_GROK_MODEL` 可换模型（默认 `grok-build`，即 Grok 自己的默认模型） | 装好并 `grok login` 的 `grok` |

```bash
env -i HOME="$HOME" PATH="$PATH" USER="$USER" WEVIR_TEST_GROK=1 pnpm vitest run --project adapter-grok contract.real
```

`WEVIR_GROK_BIN` 可指定 `grok` 的路径（优先于设置里指定的路径与自动查找）。真实 `grok` 上的手工步骤与要顺手核对的几项见 [grok-event-mapping.md](./architecture/grok-event-mapping.md) §8。

### 6.3 真实模型测试的环境变量

| 变量 | 含义 |
|---|---|
| `WEVIR_TEST_API_KEY` | 模型 Key。静态 Key 的真实模型用例要设；Vertex 服务账号不使用它 |
| `WEVIR_TEST_PROVIDER` | dsh 与 Codex 契约第 3 层要：`deepseek-official` 或 `openai-compatible`；Codex 另支持 `google-vertex`。模型网关单独的真实模型测试只认 `deepseek`（或 `deepseek-official`） |
| `WEVIR_TEST_BASE_URL` | 走 OpenAI 兼容服务时的地址，例如 `https://dashscope.aliyuncs.com/compatible-mode/v1`。不设则用 DeepSeek 官方 |
| `WEVIR_TEST_MODEL` | 模型 ID。设了 `WEVIR_TEST_BASE_URL` 时必填；用 DeepSeek 官方时可省略，各测试有自己的默认值（dsh 是 `deepseek-v4-flash`，Codex 与网关经 Responses 端点是 `deepseek-flash`） |
| `WEVIR_TEST_API` | Codex 契约第 3 层走 OpenAI 兼容服务时的协议：`openai-completions`（默认）、`openai-responses` 或 `anthropic-messages` |
| `WEVIR_TEST_VERTEX_PROJECT` | Vertex 的目标项目 ID 或编号，google-vertex 时必填 |
| `WEVIR_TEST_VERTEX_LOCATION` | Vertex location，默认 global；按模型的可用地域选择 |
| `WEVIR_TEST_VERTEX_SERVICE_ACCOUNT_JSON` | 整份服务账号 JSON，仅从进程环境读取，不回显、不写日志或快照 |
| `WEVIR_TEST_VERTEX_SERVICE_ACCOUNT_FILE` | 用户已有的服务账号 JSON 文件绝对路径；与上一项只选一种。只读进内存，不复制文件，不读取 ADC / gcloud |

Vertex 使用 Codex 契约第 3 层。先通过进程环境设置上述 JSON 或已有文件路径，再分别验证 Gemini 与 Claude（不把私钥写进命令或仓库）：

```bash
WEVIR_TEST_PROVIDER=google-vertex WEVIR_TEST_VERTEX_PROJECT=your-project-id WEVIR_TEST_VERTEX_LOCATION=global WEVIR_TEST_API=openai-completions WEVIR_TEST_MODEL=google/gemini-3.8-flash pnpm vitest run --project adapter-codex codex-adapter.contract.real --maxWorkers=2
```

```bash
WEVIR_TEST_PROVIDER=google-vertex WEVIR_TEST_VERTEX_PROJECT=your-project-id WEVIR_TEST_VERTEX_LOCATION=global WEVIR_TEST_API=anthropic-messages WEVIR_TEST_MODEL=claude-sonnet-5-5 pnpm vitest run --project adapter-codex codex-adapter.contract.real --maxWorkers=2
```

Vertex 不读 WEVIR_TEST_BASE_URL。未指定模型时，Chat 默认 google/gemini-3.8-flash，Messages 默认 claude-sonnet-5-5；不设置 API Key，凭据只在 Host 网关内存。缺 JSON / 文件路径时整层跳过并打印缺失的变量名。2026-10-15 未提供 Vertex 服务账号，两个模型的真实契约与 `pnpm dev` 中用 Vertex 模板经 apply_patch 改文件均未验收；本地 HTTP mock 不能替代真实服务。

用到 Key 的测试：`packages/adapter-dsh` 的 `dsh-adapter.approval.integration`、`dsh-adapter.resume.integration`、`provider-test.integration`、`dsh-adapter.contract.real.integration`，`packages/host` 的 `host-process.dsh.integration`，`packages/adapter-codex` 的 `codex-adapter.contract.real.integration`（Key 只进网关的内存，不进 Codex 的环境），以及 `packages/model-gateway` 的 `gateway.real.integration`（经 DeepSeek 的透传与 Chat 转换各跑一次）。Key 只经环境变量传给测试，再只进 dsh 子进程的环境，不写进 overlay、快照或日志；不要把 Key 写进仓库里的任何文件。

DeepSeek 官方的例子：

```bash
WEVIR_TEST_API_KEY=<Key> WEVIR_TEST_PROVIDER=deepseek-official pnpm vitest run --project adapter-dsh dsh-adapter.contract.real
```

xAI 与 Gemini 的 API Key 经 Codex 的契约第 3 层验证（网关按地址套用它们的方言，model-gateway.md §3.2、§4.5；模型 ID 以 providers.md §7.6、§7.7 为准）：

```bash
WEVIR_TEST_API_KEY=<xAI Key> WEVIR_TEST_PROVIDER=openai-compatible WEVIR_TEST_API=openai-responses WEVIR_TEST_BASE_URL=https://api.x.ai/v1 WEVIR_TEST_MODEL=grok-4.7 pnpm vitest run --project adapter-codex codex-adapter.contract.real
```

```bash
WEVIR_TEST_PROVIDER=openai-compatible WEVIR_TEST_API=openai-completions WEVIR_TEST_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/ WEVIR_TEST_MODEL=gemini-3.8-flash pnpm vitest run --project adapter-codex codex-adapter.contract.real --maxWorkers=2
```

Gemini 先在进程环境中提供 WEVIR_TEST_API_KEY；不要把 Key 写进命令、文件或日志。再用同样的 Chat 地址验证 4 Argon：

```bash
WEVIR_TEST_PROVIDER=openai-compatible WEVIR_TEST_API=openai-completions WEVIR_TEST_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/ WEVIR_TEST_MODEL=gemini-4-argon pnpm vitest run --project adapter-codex codex-adapter.contract.real --maxWorkers=2
```

2026-10-15 未提供 Gemini Key，两次真实契约均跳过，pnpm dev 中通过 Gemini 模板、经 apply_patch 改文件的桌面对话未跑。`gemini.integration.test.ts` 的 HTTP mock 与四份录制请求覆盖 minimal 降档、并行结果连续排放、空文本末片签名和同回合多步回传；Schema 清洗开关默认关闭。拿到 Key 后先分别试 additionalProperties 与空对象参数，确实收到相关 400 才开启 compat.geminiToolSchema；provider.test 没有工具，不能代替此项或第二步工具签名验收。

OpenAI 官方 API 经 Responses 透传，先在进程环境提供 `WEVIR_TEST_API_KEY`，然后分别验证 Sol 与 Luna（不把 Key 写入文件或命令记录）：

```bash
WEVIR_TEST_PROVIDER=openai-compatible WEVIR_TEST_API=openai-responses WEVIR_TEST_BASE_URL=https://api.openai.com/v1 WEVIR_TEST_MODEL=gpt-6.1-sol pnpm vitest run --project adapter-codex codex-adapter.contract.real --maxWorkers=2
```

```bash
WEVIR_TEST_PROVIDER=openai-compatible WEVIR_TEST_API=openai-responses WEVIR_TEST_BASE_URL=https://api.openai.com/v1 WEVIR_TEST_MODEL=gpt-6-luna pnpm vitest run --project adapter-codex codex-adapter.contract.real --maxWorkers=2
```

2026-10-15 的 OpenAI 核对没有可用 Key，上面两次真实契约与 `pnpm dev` 中使用 OpenAI 模板、经 `apply_patch` 改文件的桌面对话均未验收。本地加密推理往返的 mock 测试不能替代它们。Luna 的模板提供 `off`（交给 Codex 时是 `none`）；上述契约测试未显式指定档位，验证该选项还需在桌面对话中选择“关闭”。

Anthropic 官方 API 经 Messages 转换。先通过进程环境提供绑定单个 workspace 的 `WEVIR_TEST_API_KEY`（当前没有 Workspace ID 配置字段），再分别跑 Sonnet 与 Opus：

```bash
WEVIR_TEST_PROVIDER=openai-compatible WEVIR_TEST_API=anthropic-messages WEVIR_TEST_BASE_URL=https://api.anthropic.com WEVIR_TEST_MODEL=claude-sonnet-5-5 pnpm vitest run --project adapter-codex codex-adapter.contract.real --maxWorkers=2
```

```bash
WEVIR_TEST_PROVIDER=openai-compatible WEVIR_TEST_API=anthropic-messages WEVIR_TEST_BASE_URL=https://api.anthropic.com WEVIR_TEST_MODEL=claude-opus-5-5 pnpm vitest run --project adapter-codex codex-adapter.contract.real --maxWorkers=2
```

2026-10-15 的 Messages 兼容核对未提供 Key，上述两次契约与 `pnpm dev` 中用 Anthropic 模板、经 apply_patch 改文件的对话仍未验收。本地用四份录制请求和会拒收 forced choice、非法思考模式、采样参数及历史前缀变化的 mock，覆盖工具结果、中途 system 与下一回合往返（`pnpm vitest run --project model-gateway --maxWorkers=2`）；这些不代表真实服务通过。模板声明 adaptive / inline，官方地址不需要手填 compat；代理地址的旧 Provider 需按 providers.md §7.9 手动补齐。Opus / Fable 的 none 降到 low 并保留思考，Sonnet 的 none 用 between_tools；模板均不提供 off。

截至 2026-10-14 本机没有 Key，第 3 层与各真实模型用例都还没有跑过（Gate M3 的待办）。Responses 通用开关的核对（2026-10-15）同样没有 `WEVIR_TEST_API_KEY`；本地验收用录制 Codex 请求 + 拒收非 auto、namespace 与 null 加密推理的 mock（`pnpm vitest run --project model-gateway --maxWorkers=2`），不能替代逐家的契约第 3 层与桌面端带工具对话。Codex 升级前按 model-gateway.md §10 复查新输入项的触发条件。

Chat 思考格式的本地验收（2026-10-15）：同一份 `2-tool-results` 录制请求覆盖六种思考格式，HTTP mock 拒收缺 reasoning_content 的历史，MiniMax 的正文标签与 reasoning_details 经 Responses 历史再完整带回；运行 `pnpm vitest run --project model-gateway --maxWorkers=2`。真实 Key 未提供时不启动桌面真实模型验收，也不把 mock 结果视为契约第 3 层通过。需要代理地址上指定 thinkingFormat 时，当前第 3 层的环境变量还没有 compat 入口；逐服务接入时应补测试配置入口或使用按地址可识别的配置，不能把协议名称当成思考格式。minimax / tencent 的新格式目前只适用于 Codex 网关，dsh 共用格式为 openai / deepseek / qwen / zai（model-gateway.md §4.4）。

### 6.4 其他

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

`upstream/` 只是只读参考（读 dsh、OpenWork、Paseo、Codex 的源码、移植时核对），构建和运行都不需要它。`scripts/upstream-sync.sh` 把 `https://github.com` 前缀换成这个变量的值：

```bash
WEVIR_GITHUB_MIRROR=https://ghfast.top/https://github.com bash scripts/upstream-sync.sh
```

脚本按 SHA 浅拉取 `docs/upstream/upstream.lock` 里的锁定提交，最后检查 `HEAD` 与锁定的 SHA 一致才算完成，所以经第三方镜像拿到的内容与 GitHub 上的同一提交逐字节相同。

设置 → 模型服务 → Antigravity 的下载从 `dl.google.com` 取 Google 的运行体，大陆网络下常连不上。`WEVIR_ANTIGRAVITY_MIRROR` 把 `https://dl.google.com` 前缀换成镜像（路径不变，例如内网的同步镜像），在启动 Host（或桌面端）之前设好；内容照样按钉住的 sha256 校验，给错文件只会校验失败。没有镜像时自己下载 ACP Registry 里的压缩包，把 `agy_acp_server.par` 与 `localharness_external` 放在同一个目录，在设置里填可执行文件的路径（[antigravity-event-mapping.md](./architecture/antigravity-event-mapping.md) §2）。下载断了下次点下载会接着下。没有实测过可用的公共镜像。

`scripts/fetch-codex.sh`（下载 `codex-app-server`，§2）同样认这个变量：Release 资产走 `<镜像>/openai/codex/releases/download/…`，下载后照样按脚本里的 sha256 校验（2026-10-14 经 `https://ghfast.top/https://github.com` 实测：72 MiB 约 8 s，校验通过）。

2026-10-14 的结果：`https://ghfast.top/https://github.com`、`https://gh-proxy.com/https://github.com` 都能同步三个仓库（`ghproxy.net` 的同类前缀 `git ls-remote` 也能通）；`kkgithub.com`、`bgithub.xyz`、`githubfast.com` 不可用；`gitclone.com/github.com` 是缓存型镜像，分支头落后于 GitHub，缺锁定提交时脚本会沿分支加深查找，找不到就报错。

### 7.5 模型服务

在设置里新建 Provider 时先选这几项（桌面端的模板取自 [providers.md](./architecture/providers.md) §7）：

1. **DeepSeek 官方（首选）。** 类型 `deepseek-official`，走 dsh 原生的 DeepSeek 适配器，只要填 Key。
2. **国内的 OpenAI 兼容服务：** 通义千问（阿里云百炼）、Kimi、智谱 GLM。地址按 Key 所在的站点和套餐选：Kimi 国内站的 Key 只能配 `api.moonshot.cn`；百炼的国际站、Coding Plan，智谱的 GLM Coding 套餐都有各自的地址，不能混用。细节见 providers.md §7。
3. **本机模型（Ollama、vLLM 等）。** 地址 `http://127.0.0.1:11434/v1` 一类，Key 随便填。本机没有装，未验证。

**ChatGPT 订阅**（R6）：设置 → 模型 Provider 顶部的“ChatGPT 账号”，或 `wevir provider login`。登录与对话直连 `auth.openai.com` 与 `chatgpt.com`，需要能访问 OpenAI 的网络；`codex-app-server` 继承 Host 的 `HTTPS_PROXY` 等代理变量（从访达启动的桌面端拿不到 shell 里的代理变量，要在启动 Host 的环境里设）。只供个人在本机使用。

海外服务（OpenAI 官方等）只要是 OpenAI 兼容协议也能配，但需要能访问对方的网络，未验证；`anthropic-messages` 协议骨架阶段不支持。

2026-10-14 的验证：在全新数据目录上用一个无效的 Key 依次登记上面的 DeepSeek（官方类型与 OpenAI 兼容两种）、通义千问、Kimi、智谱，经 Host 的 `provider.test` 得到的结论都是 `auth`（HTTP 401）：地址可达、按所选协议应答、认出了 Key 无效。用真实 Key 完成对话尚未验证。另外，审批卡片要靠模型按 dsh 的提示升级沙箱权限才会出现，真实模型上是否可靠也还没有验证（ADR-0001 未决事项 3）。

## 8. 常见问题

**`pnpm dev` 报 `Error: Electron uninstall`。** Electron 二进制没装上。electron-vite 不会替 Electron 44 下载，dev 脚本里的 `install-electron` 负责这一步；它失败了就设好 `ELECTRON_MIRROR` 再跑一次 `pnpm dev`，或单独执行 `pnpm --filter @wevir/desktop exec install-electron`。

**`Failed to resolve entry for package "@wevir/client-sdk"`。** T6.1 之前的提交上，主进程打包的是各包的 `dist/`，没构建过的全新克隆会报这个。更新到当前代码，或先 `pnpm build`。

**`Port 5199 is already in use`。** 另一个 `pnpm dev` 还开着。渲染进程的端口不能换（它的 origin 在 Host 的白名单里），关掉另一个。

**窗口一闪就退出，终端里没有报错。** 同一个数据目录已经有一个桌面端在运行，新开的把焦点交给它后退出。要同时开两个，给第二个设不同的 `WEVIR_HOME`。远程调试端口 9339 被占时用 `WEVIR_DESKTOP_DEBUG_PORT` 换一个。

**Host 起不来 / 桌面端顶部“后台服务无法启动”。** 看界面给出的原因与 `logs/host.log`（桌面端的提示与状态不提 Host，说“后台服务”）。`wevir-host` 退出码 3 表示该数据目录已有 Host 在运行；Host 被强杀后留下的 `run/host.json` 会按 `pid` 与启动时刻判定为陈旧，下次启动自动清掉。

**`pnpm lint` 报命令 shim 导出了 `NODE_PATH`。** 在 `extendNodePath: false` 加入之前装过依赖的 checkout 要 `pnpm install --force` 一次（AGENTS.md 规则 2）。

**`ERR_PNPM_IGNORED_BUILDS`。** 依赖升级带来了没登记的构建脚本，按 ADR-0004 §2 审查后登记到 `allowBuilds`，不要关掉 `strictDepBuilds`。

**`ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER`（CI 的 `--frozen-lockfile`）。** 新包没有依赖时 pnpm 12.6 不写它的 lockfile 条目，运行 `pnpm install --fix-lockfile`（AGENTS.md）。

**审批相关的 dsh 测试失败，说目标“在系统临时目录下”。** 把仓库克隆到系统临时目录以外（§6.4）。

**设了 `NODE_USE_ENV_PROXY=1` 和 `HTTPS_PROXY` 之后连本机服务也走了代理。** 这个开关让 Node 内置的 HTTP 客户端（含 `fetch`）按代理变量走，到 Host（127.0.0.1）的连接、`provider.test` 到本机 Ollama 都可能经过代理。同时设 `NO_PROXY=localhost,127.0.0.1`。pnpm 与 git 本来就认 `HTTPS_PROXY`，不需要这个开关。

## 9. 品牌与跨平台图标

图标资源在 [`assets/icons/`](../assets/icons/README.md)：浅色为香槟金主标与灰调象牙白（`#F4F3ED`），字标与线性功能图标保留深色；深色为铂金与石墨黑。包括主标/转曲字标、八个线性功能图标、macOS ICNS 与菜单模板、Windows ICO 与托盘、iOS 资源目录、Android 分层、Linux 与 Web 资源。桌面端在主进程运行时按主题设置图标：macOS 的程序坞图标跟随应用的深浅色，Windows 的窗口与任务栏图标跟随系统的 Windows 模式（`apps/desktop/src/main/app-icon.ts`）；桌面端还没有打包配置，ICNS 与安装包图标留到打包时接入。iOS / Android 还没有客户端。

```bash
pnpm icons:build
pnpm icons:check
pnpm icons:pack
```

`icons:build` 经根目录开发依赖 Sharp 0.35.5 从 SVG 导出 PNG，再生成预览与格式化资源元数据，不启动 Host，不需要模型 Key，也不需要先构建产品包。`icons:check` 检查尺寸、透明度、模板、tinted 灰度、ICNS/ICO 帧、SVG 来源、Android 安全区域和 Icon Composer 工程 `source/Wevir.icon`（macOS 上有 Xcode 时另用 `actool` 编译，否则跳过）。`icons:pack` 输出可独立重建的 `assets/icons/release/wevir-icons-v1.zip`（gitignore）。字标轮廓已提交；只有重新从源字体提取字形时才需要可选 Python 工具 fonttools。

平台接入方法、完整规格与官方规范链接见资源目录 README。当前的静态导出校验与 Apple 资源编译通过，不代表已经在真实设备、Windows 托盘或各 Android 启动器上验收。
