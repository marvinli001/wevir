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

它按平台（macOS arm64 / x64、Linux musl x64 / arm64、Windows x64 / arm64，Windows 在 Git Bash 里运行）下载 GitHub Release 的压缩包，按脚本里的 sha256 校验后解到 `.wevir-dev/bin/codex-app-server[.exe]`（gitignore），旁边是 `codex-code-mode-host[.exe]`（code mode 的 `exec` 在它里面跑，codex-app-server 在自己旁边找它；没有它时只给 code mode 的模型调不了任何工具），Linux 另带 `codex-resources/bwrap`，已是同一版本且文件齐全就直接退出。大陆网络设 `WEVIR_GITHUB_MIRROR`（§7.4）。也可以不下载、用 `WEVIR_CODEX_BIN=<绝对路径>` 指向别处的同版本二进制（同一目录里也要有 `codex-code-mode-host`）；版本不对时 Host 在第一次启动它之前报错。准备安装包用的资源目录见 §3.5。

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

安装包内置锁定版本的 `codex-app-server`、Host 与提示词，运行时不从网上下载（ADR-0005 决策 8、[ADR-0007](./adr/0007-packaging-and-runtime-distribution.md) 决策 4、5）。打安装包（§3.6）的第一步就是准备这个目录，也可以单独运行（要先 `pnpm build`）：

```bash
pnpm --filter @wevir/desktop resources
```

它运行 `apps/desktop/scripts/stage-resources.ts`，按本机平台（或 `-- --target <三元组>` 指定的平台，三元组见 `scripts/fetch-codex.sh`）准备 `apps/desktop/resources/`（gitignore）：

- `engines/codex/`：用 `scripts/fetch-codex.sh --target <三元组> --out <目录>` 取二进制并按 sha256 校验，连同 `codex-code-mode-host` 与 `apps/desktop/licenses/codex/` 里 Codex 的 `LICENSE` 与 `NOTICE`；Linux 另带 `codex-resources/bwrap`。
- `prompts/`：仓库的 `prompts/`，不含 README.md。
- `host/`：`pnpm --filter @wevir/host deploy --prod --ignore-scripts --config.node-linker=hoisted --os=<平台> --cpu=<架构>` 把 wevir-host 与它的生产依赖复制进来（工作区包按各自 `files` 复制，hoisted 布局没有符号链接；平台可选依赖按目标平台装）。然后从 Host 的依赖出发剪掉走不到的包：`vitest`（runtime-adapter 的可选 peer，pnpm 从工作区根的开发依赖解析到它）、`@deepseek-ai/dsh`（adapter-dsh 的开发依赖，ADR-0007 决策 6）、`@anthropic-ai/claude-agent-sdk` 与 `@cursor/sdk`（不随应用分发，ADR-0007 补记 3；Host 没有它们时不挂 Claude 与 Cursor 引擎），以及只被它们用到的包；剪完检查没有这些包、没有符号链接、留下的包没有安装脚本，不满足就报错。2026-10-16 在 macOS arm64 上是 21 MB。

打包时这个目录原样进入安装包的资源目录（`process.resourcesPath`）。安装包里的主进程用 Electron 自带的 Node 拉起 `<资源目录>/host/dist/main.js`（`host-lifecycle.ts` 的 `packagedHostEntry`），并设 `WEVIR_RESOURCES_DIR=<资源目录>`（环境里已有时不覆盖）。adapter-codex 找二进制的顺序是 `WEVIR_CODEX_BIN` → `<WEVIR_RESOURCES_DIR>/engines/codex/` → 开发缓存 `.wevir-dev/bin/`；提示词是 `<WEVIR_RESOURCES_DIR>/prompts/`（有 `base.md` 时）→ 仓库的 `prompts/`（`resolvePromptsDir`，wevir-host 交给 Codex 与会话标题）。开发时桌面端不设这个变量；要在开发构建上模拟安装后的布局，自己设上它并让开发缓存里没有二进制，例如：

```bash
WEVIR_HOME="$(mktemp -d)" WEVIR_RESOURCES_DIR="$PWD/apps/desktop/resources" node packages/host/dist/main.js
```

macOS 上要连“不联网也能用 Codex”一起验证时，用 `sandbox-exec` 只放行本机地址，再按 §3.1 的 mock 模型做法建 Provider 与会话（R9 的验收记录见 ADR-0007 的“后果”）：

```bash
sandbox-exec -p '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(allow network-outbound (remote unix-socket))' <命令>
```

### 3.6 打安装包

electron-builder 26（ADR-0007 决策 1），配置在 `apps/desktop/electron-builder.yml`。先在仓库根目录构建，再打包：

```bash
pnpm build
```

```bash
pnpm --filter @wevir/desktop package
```

`apps/desktop/scripts/package.ts` 依次准备资源目录（§3.5）、`electron-vite build`、运行 `electron-builder --mac|--win|--linux --arm64|--x64`。`--target <三元组>` 指定别的平台（默认本机）；`--` 之后的参数原样交给 electron-builder，例如 `-- --dir` 只出 `.app` / 未打包的目录。产物在 `apps/desktop/release/`（gitignore）：macOS 是 `Wevir-<版本>-mac-<架构>.dmg` 与 `Wevir-<版本>-mac-<架构>.zip`（zip 留给以后的自动更新），Windows 是 `Wevir-<版本>-win-<架构>-setup.exe`（NSIS，一键装到当前用户，不要管理员权限）。

安装包里：asar 只有 `out/` 与 `package.json`（主进程与 preload 已把依赖打进 `out/`；桌面端的工作区包都是 devDependencies，electron-builder 不往里放 node_modules）；资源目录是 §3.5 的 `host/`、`engines/codex/`、`prompts/`，加上 `legal/`（Wevir 的 `LICENSE` 与 `NOTICE`）。

**macOS 签名与公证**（ADR-0007 决策 2）：

- 钥匙串里有 “Developer ID Application” 证书时 electron-builder 自动用它签名，开 Hardened Runtime，entitlements 在 `apps/desktop/build/entitlements.mac.plist`（只开 JIT）。包里的其余可执行文件（`codex-app-server` 等）一起重签。CI 用 `CSC_LINK`（.p12 的 base64 或路径）与 `CSC_KEY_PASSWORD` 给证书。不签名：`CSC_IDENTITY_AUTO_DISCOVERY=false`。
- 公证：先把凭据存进钥匙串（一次即可，App 专用密码在 account.apple.com 生成，命令会提示输入）：

  ```bash
  xcrun notarytool store-credentials wevir-notary --apple-id <Apple ID> --team-id <Team ID>
  ```

  之后打包时设 `APPLE_KEYCHAIN_PROFILE=wevir-notary`。CI 用 App Store Connect API 密钥（`APPLE_API_KEY` 为 .p8 路径、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`）。都没有时 electron-builder 跳过公证并告警：这样的包在别的 Mac 上下载后打不开，要在“系统设置 → 隐私与安全性”放行。
- 检查：`codesign --verify --deep --strict --verbose=2 release/mac-arm64/Wevir.app`；公证后 `spctl -a -vvv -t exec release/mac-arm64/Wevir.app` 显示 `source=Notarized Developer ID`，`xcrun stapler validate release/mac-arm64/Wevir.app` 通过。

**Windows** 先不签名（ADR-0007 决策 2），安装时 SmartScreen 会提示。Windows 包要在 Windows 上打（资源目录里的 Host 依赖与 codex-app-server 按目标平台准备，NSIS 的图标与版本信息也在 Windows 上写最稳）。

### 3.7 发布：开发版与正式版

`.github/workflows/release.yml`（ADR-0007 补记 2 的发布流水线），脚本是 `apps/desktop/scripts/release.ts`：

- **开发版**：master 上 push 触发的 CI 通过后自动发（macOS 与 Windows 的作业都要成功）。版本 `X.Y.(Z+1)-beta.N`：`X.Y.Z` 是上一个 `vX.Y.Z` tag（没有时按 0.0.0），N 是从那个 tag 到这个提交的 master 提交数（`--first-parent`）。`node apps/desktop/scripts/release.ts plan` 在本机打印下一次的版本。
- **正式版**：维护者决定发布时，在已经通过 CI 的 master 提交上打 tag 并推送：

  ```bash
  git tag v0.1.0 && git push origin v0.1.0
  ```

  流水线核对这个提交在 master 上、CI 通过，发到 `latest` 通道，另建 GitHub Release（dmg 与 exe）。
- 三个包并行打：macOS arm64、x64（macos-latest，签名、公证，检查 `codesign`、`stapler`、`spctl`），Windows x64（windows-latest，不签名）。版本经 `package --app-version` 写进安装包，electron-builder 按它写出更新清单（`latest-mac.yml` / `beta-mac.yml`，Windows 是 `latest.yml` / `beta.yml`，通道由版本的预发布标签决定）。
- 上传作业：`release-dir.ts` 把每个平台的产物整理成 `desktop/<平台>-<架构>/` 并签清单（签名私钥只在这个作业里），`release.ts publish` 把它们传到两条线路。先传安装包，两条线路都传完后再写清单与 `.sig`；线路上同通道的清单版本不低于这次时整个停下（上传前、写清单前各查一次）。全球线路（Bunny）每个文件用一次 PutObject 整个传、不分片（Bunny 把分片上传的文件复制到其他地区的存储副本时会丢片：2026-10-16 悉尼副本上 beta.210 的 arm64 dmg 少了一个 8 MiB 的分片，清缓存也没用）；传完安装包后经 CDN 逐个下载、与本地核对 sha512，对不上就清缓存重取（最多 20 分钟，超时整个停下、不写清单），都对上后再等 3 分钟让其他地区的存储副本跟上、清一次缓存，才写清单；写完清单同样清缓存并核对（`release.ts` 的 `waitForCdn`）。最后清理：每个平台目录里开发版、正式版各留最新 2 个版本，再加上清单引用的版本（正式版的 dmg 与 exe 另在 GitHub Release 上）。
- 同一时间只跑一个发布，后来的排队，排队的只留最新一个。

仓库要配的 secret 与 variable（Settings → Secrets and variables → Actions；`gh secret set` / `gh variable set`）：

| 名称 | 类型 | 内容 |
|---|---|---|
| `WEVIR_RELEASE` | variable | `on` 时流水线才发布；下面的都配好之后再设 |
| `MAC_CERT_P12_BASE64` | secret | Developer ID Application 证书与私钥导出的 .p12，base64 |
| `MAC_CERT_PASSWORD` | secret | 导出 .p12 时设的密码 |
| `APPLE_API_KEY_P8` | secret | App Store Connect API 密钥 .p8 的全文 |
| `APPLE_API_KEY_ID` | variable | 这把密钥的 Key ID |
| `APPLE_API_ISSUER` | secret | App Store Connect 的 Issuer ID |
| `WEVIR_UPDATE_SIGNING_KEY` | secret | 更新清单的 Ed25519 私钥（PKCS#8 PEM 全文，`update-signing.ts keygen` 生成），公钥在 `src/main/updates/keys.ts` |
| `WEVIR_GLOBAL_S3_ENDPOINT` | variable | Bunny Storage 的 S3 地址，如 `https://sg-s3.storage.bunnycdn.com` |
| `WEVIR_GLOBAL_S3_REGION` | variable | Bunny 的区域代码，如 `sg` |
| `WEVIR_GLOBAL_S3_BUCKET` | variable | 存储区名（同时是 S3 的 Access Key ID） |
| `WEVIR_GLOBAL_S3_SECRET_ACCESS_KEY` | secret | 存储区的 Password（不是 Read-only password） |
| `BUNNY_API_KEY` | secret | Bunny 账户的 API Key，清 CDN 缓存用；不配时不清，清单要等 CDN 缓存过期 |
| `WEVIR_OPTIMIZED_S3_ENDPOINT` | variable | `https://download2.wevir.si`（RustFS 的 S3 接口，也是客户端访问的地址） |
| `WEVIR_OPTIMIZED_S3_REGION` | variable | 可不配，默认 `us-east-1` |
| `WEVIR_OPTIMIZED_S3_BUCKET` | variable | `desktop`（必须是这个名字，见下） |
| `WEVIR_OPTIMIZED_S3_ACCESS_KEY_ID` | secret | RustFS 访问密钥 |
| `WEVIR_OPTIMIZED_S3_SECRET_ACCESS_KEY` | secret | RustFS 访问密钥的 Secret |

两条线路的服务端：`https://download.wevir.si/desktop/…` 对应 Bunny 存储区根目录下的 `desktop/…`（拉取区连到存储区）；`download2.wevir.si` 直接是 RustFS 的 S3 接口（path-style），`https://download2.wevir.si/desktop/…` 就是桶 `desktop` 里的键，所以桶名必须是 `desktop`，键里不带 `desktop/`（`release.ts` 的 `bucketIsDesktop`），桶要允许匿名读（GetObject）。客户端用 Range 请求测速，两边都要支持 Range。RustFS 上清单带 `Cache-Control: no-cache`；Bunny 的 S3 接口不收这个头，靠清缓存，也可以在拉取区给 `*.yml`、`*.sig` 加不缓存的 Edge Rule。

本机试上传（不经 CI）：设好上表的线路变量，`node apps/desktop/scripts/release.ts publish --channel dev --version <版本> --dir <目录> --only optimized`，`<目录>` 下按 `darwin-arm64/` 等放产物与签过名的清单。要本机装 AWS CLI。

### 3.8 自动更新与发布目录

安装包自己检查更新（[ADR-0007](./adr/0007-packaging-and-runtime-distribution.md) 补记 2、4）：主进程的 `src/main/updates/`，界面是侧栏左下角的更新入口与设置 → 关于。开发构建（`pnpm dev`）不检查。

- **两条线路**：全球 `https://download.wevir.si`、优化 `https://download2.wevir.si`，发布目录是 `<线路>/desktop/<平台>-<架构>/`（例如 `darwin-arm64`、`win32-x64`）。每次检查同时向两条线路取更新清单（`latest-mac.yml` / `latest.yml`，开发版通道另取 `beta-*`），先给出验过签的那条胜出；清单 404 当作该通道还没发布过（还没发正式版时只有 `beta-*`），两条线路上该通道的清单都不存在时显示已是最新，不报连不上；有新版本时在给出同一版本的线路之间各取安装包开头 256 KB 测速，选快的下载，下载失败换另一条重试一次。
- **签名**：每份清单旁边有 `<清单>.sig`（Ed25519，签清单的原始字节），应用只认 `src/main/updates/keys.ts` 里的公钥，验不过就不下载；清单里每个文件的 sha512 由 electron-updater 下载后核对。私钥在维护者本机 `~/.wevir-release/update-signing-key.pem`（`node apps/desktop/scripts/update-signing.ts keygen` 生成，不进仓库，CI 用 secret），别处另生成的私钥签出来的清单客户端不认。
- **安装包不覆盖写**：安装包的名字都带版本，发出去就不再改写。以前每次发布另存一份固定名字的安装包（`Wevir-beta-mac-arm64.dmg` 等）覆盖写：Bunny 存储覆盖同名文件后，CDN 回源在一段时间里会拿到新旧混杂的内容，2026-10-16 固定名字的 dmg 与 exe 就这样坏过（大小对、内容一半是旧的）。现在不再生成，清理时删掉留下的（`release.ts` 的 `isLegacyAlias`）。README 的下载链接指向官网下载页，版本徽章经 shields.io 读 `darwin-arm64/beta-mac.yml` 的 `version`。
- **官网下载页**（仓库 `wevirsi`）：构建时读两条线路的清单（两个通道取版本高的），把带版本的安装包写进链接；浏览器里再读一次清单、测速选线路，读不到（线路不许跨域读）就沿用构建时的链接。发布作业最后调 `WEVIR_SITE_DEPLOY_HOOK`（secret，Vercel 的部署钩子）重建官网，没设置时只给警告。
- **通道**：正式版只读 `latest`；开发版读 `latest` 与 `beta`、取版本高的，所以正式版发布后开发版用户也收到它。开发版的版本号写成 `X.Y.Z-beta.N`，electron-builder 据此写 `beta-*.yml`。切换通道不降级。
- **发布目录**：打包时带上版本，再整理并签名：

  ```bash
  pnpm --filter @wevir/desktop package --app-version 0.2.0
  ```

  ```bash
  node apps/desktop/scripts/release-dir.ts --out /tmp/wevir-release
  ```

  后者把 `apps/desktop/release/` 里的清单、它列出的文件与 blockmap 复制到 `<out>/desktop/<平台>-<架构>/`，写签名并用内置公钥核对。把 `<out>` 同步到每条线路的根即可：先传安装包，最后传清单与签名。
- **本机验收**：`WEVIR_UPDATE_MIRRORS=global=http://127.0.0.1:8701,optimized=http://127.0.0.1:8702` 换掉两条线路（照样验签），`WEVIR_UPDATE_FIRST_CHECK_MS` 改启动后第一次检查的延迟（默认 30 s，之后每 4 小时）。服务器要支持 Range（测速与差分下载）。

## 4. 离线开发：echo 假引擎

不需要 dsh、模型或网络。echo 回复 `Echo: <输入>`，先按分片发增量、再发已提交消息；输入里的关键词（不分大小写）触发其他行为：

| 关键词 | 行为 |
|---|---|
| `tool` | 回复前模拟一次工具调用（不需要审批） |
| `approve` | 模拟一次需要审批的写文件；允许则工具完成，拒绝则工具失败 |
| `think` | 回复前先发一段思考 |
| `fail` | 回合以失败结束 |

取消时的行为与 dsh 相同：未决审批被取消，已生成的半段回复保留。完整的关键词表在 `echo.ts` 的类注释里。计划模式（0.36.0）的消息回复 `Echo (plan): <输入>`，之后报一份计划（`plan.proposed`），桌面端的计划卡片与“实施”可以对着 echo Host 试。

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
| `web.json` | 联网工具的设置（0.34.0，[web-tools.md](./architecture/web-tools.md)）：开关 `enabled` 与搜索服务 `searchService`，0600；搜索服务的 Key 在 `secrets.json`。没有这个文件时开着、用博查 |
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
| `mcp/` | Host 给引擎挂的本机 MCP 服务的脚本（0.25.0 的 `wevir-history.mjs`、0.34.0 的联网工具 `wevir-web.mjs`），引擎第一次启动前写，每次覆盖 |
| `images/` | 消息里的图片（0.28.0）：`<图片 ID>.<扩展名>` 与旁边的 `<图片 ID>.json`（Host 认定的格式、大小与像素），0600；`staged/` 里是上传了还没发出去的，过一天删掉 |
| `engines/cursor/` | Cursor 引擎：应用内登录铸出的 API Key `auth.json`（0600，见[安全说明](./security.md) §3）。第一次登录 Cursor 时才出现；agent 的对话由 Cursor 的 SDK 存在它自己的位置（`~/.cursor/projects/`） |
| `engines/opencode/` | OpenCode 引擎：读账号时 `opencode serve` 的工作目录，`servers/` 是本机服务器的台账（0600，进程身份与端口）。登录、配置与会话都在用户自己的 opencode 目录（`~/.config/opencode`、`~/.local/share/opencode`），Wevir 不读不改，见 [opencode-event-mapping.md](./architecture/opencode-event-mapping.md) §1 |
| `engines/antigravity/` | Antigravity 引擎：`runtime/<平台>-<架构>/`（设置里下载的运行体，`active.json` 指向装好的版本，没下完的在 `downloads/`）、`profile/`（运行体的 `GEMINI_HOME`：Google 登录 `antigravity-acp/acp_token.json` 与对话，Wevir 不读登录的内容）、`tmp/`（每个进程的解包目录，约 1 GB，进程退出后删掉）、`models.json`（模型列表）。第一次下载或登录时才出现 |
| `desktop/` | Electron 的 userData（Chromium 配置、localStorage） |

数据目录及其子目录新建时为 0700；`secrets.json`、`run/host.json`、`logs/host.log` 与各身份文件为 0600，`wevir.db` 按默认 umask 创建，靠所在目录的 0700 挡住其他用户。dsh 在第一个会话需要它时才启动，`engines/dsh-agents/` 和 dsh 的会话日志到那时才出现。

插件 P1（协议 0.41.0）的全局数据在 `<数据目录>/plugins/`：`registry.json` 为 0600，含用户 MCP 的 env / headers 原值与 skills 开关；托管 skills 在 `skills/<name>/`。文件夹、SKILL.md、ZIP 或 Codex / Claude 插件包经 `skill.install` 安装，客户端结果只看得到密钥的键名与已设置标记。P1 无界面，使用 client-sdk 的类型化 request / watchPlugins；方法与默认禁用外部 skills 的规则见 [plugins.md](architecture/plugins.md)。针对性验证：`pnpm vitest run --project protocol`、`pnpm vitest run --project host plugins`、`pnpm vitest run --project client-sdk client.test.ts`、`pnpm vitest run --project adapter-codex codex-adapter.plugins-gate.integration.test.ts`；真实 Codex 测试使用仓库锁定的 app-server 与本机假模型，不需要供应商 Key。数据目录别名也会规范化；本次在 macOS 用真实 app-server 与本机假模型验证两个适配实现、MCP 审批及运行中插件变更。Windows 的临时 HOME 隔离实验因 Codex 的 dirs::home_dir 不读 HOME 而跳过，待该平台单独验证。

插件 P1a（协议 0.42.0）把 Wevir 插件包装进 `<数据目录>/plugins/packages/<id>/`，注册表同样在 `registry.json`（含输入项的值）。改了清单的 zod 定义就运行 `pnpm --filter @wevir/protocol schema` 重新生成 `packages/protocol/schemas/wevir-plugin.schema.json`。针对性验证：`pnpm vitest run --project protocol plugin-manifest`、`pnpm vitest run --project host plugin-packages`；真实 Codex 例子在 `plugins.codex.integration.test.ts`（worktree 里没有 `.wevir-dev/bin` 时用 `WEVIR_CODEX_BIN` 指向主 checkout 的 app-server）。

插件 P3（对话里安装，协议仍为 0.42.0）：`plugin-app-tools.ts` 复用 P1/P1a 安装，三个写工具必须得到用户批准，完整说明见 [plugins.md「在对话里安装」](architecture/plugins.md#在对话里安装p3)。验证命令：`pnpm vitest run --project host app-tools`、`pnpm vitest run --project host plugin-app-tools.codex.integration`；后者以锁定的真实 app-server 与本机假模型分别跑 CodexAdapter / CodexRuntime，不需要供应商密钥。

插件 P2（桌面端的插件页，不改协议与 Host）：纯逻辑与主进程的来源判断由 `pnpm vitest run --project desktop plugins`、`pnpm vitest run --project desktop plugin-source`、`pnpm vitest run --project desktop paths` 覆盖，类型检查是 `pnpm --filter @wevir/desktop typecheck`。界面要在构建出来的桌面端里走一遍：`pnpm build` 与 `pnpm --filter @wevir/desktop build` 后，先用 `pnpm --silent wevir --home <临时目录> host start --adapter echo` 起 echo Host，再 `cd apps/desktop && WEVIR_HOME=<临时目录> ./node_modules/.bin/electron . --remote-debugging-port=9359`（用 CDP 驱动；原生文件对话框加 `--inspect=9350`，在主进程里替换 `dialog.showOpenDialog`）；Codex Host 用 `packages/host/dist` 与 `packages/adapter-codex/dist` 的 `startHost` 加 `CodexRuntime` 与本机假模型起，`WEVIR_CODEX_BIN` 指向 `.wevir-dev/bin/codex-app-server`。

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

Z.ai 与智谱标准 API 按官方 Codex 指南使用 Responses。先在进程环境提供**对应站点新建的标准** WEVIR_TEST_API_KEY，再分别运行（两站 Key 不通用，不写进命令或文件）：

```bash
WEVIR_TEST_PROVIDER=openai-compatible WEVIR_TEST_API=openai-responses WEVIR_TEST_BASE_URL=https://api.z.ai/api/v1 WEVIR_TEST_MODEL=glm-5.3 pnpm vitest run --project adapter-codex codex-adapter.contract.real --maxWorkers=2
```

```bash
WEVIR_TEST_PROVIDER=openai-compatible WEVIR_TEST_API=openai-responses WEVIR_TEST_BASE_URL=https://open.bigmodel.cn/api/v1 WEVIR_TEST_MODEL=glm-5.3 pnpm vitest run --project adapter-codex codex-adapter.contract.real --maxWorkers=2
```

随后在 pnpm dev 里分别用 Z.ai / 智谱模板完成一次 apply_patch 改文件对话，并检查 low / high / max、Flash 图片与多步历史。2026-10-17 无两站标准 Key，真实契约与桌面对话未验收；`zai.test.ts` / `zai.integration.test.ts` 的录制请求和 HTTP mock 只证明本地兼容逻辑。拿到 Key 后另探测原生 namespace，再决定是否将 supportsNamespaceTools 改 true；当前第 3 层没有显式 compat 环境入口，原生 namespace 的对照需用进程内网关配置。2026-10-16 的 Key 类型与标准 Key 入口有变化，模型页仍保留曾订阅账号的 Chat 限制；若实际拒收 Responses，按 providers.md §7.4 手动设 Chat 与 zai 思考格式，不自动回退、不使用套餐或历史兼容 Key。

Kimi 开放平台按官方 Codex 指南使用 Responses。先在进程环境提供国内站的 WEVIR_TEST_API_KEY，再运行（不把 Key 写进命令或文件）：

```bash
WEVIR_TEST_PROVIDER=openai-compatible WEVIR_TEST_API=openai-responses WEVIR_TEST_BASE_URL=https://api.moonshot.cn/v1 WEVIR_TEST_MODEL=kimi-k3 pnpm vitest run --project adapter-codex codex-adapter.contract.real --maxWorkers=2
```

国际站使用 https://api.moonshot.ai/v1，并提供国际站 Key，两站不通用。2026-10-17 官方 Responses 参数页只确认 kimi-k3，模板因此只列 K3，不运行 K2.7-code / K2.6 的 Responses 契约。当前没有 WEVIR_TEST_API_KEY，真实契约与 pnpm dev 中使用 Kimi 模板、经 apply_patch 改文件的对话未验收；`kimi.test.ts` / `kimi.integration.test.ts` 的录制请求和本机 HTTP mock 只验证方言。另需在桌面对话检查图片输入与 low / high / max 档位；配置和旧 Provider 的手动修改见 providers.md §7.3。

Ollama 使用 Responses（至少 0.13.3）。先自行安装 Ollama 与支持工具的模型，并确认实际上下文至少 65536；模型下载可能十几 GB，不由 Wevir 自动执行。设置进程环境中的 WEVIR_TEST_API_KEY 为本机占位值 ollama（Cloud 则是真实 Key，不写文件），再运行：

```bash
WEVIR_TEST_PROVIDER=openai-compatible WEVIR_TEST_API=openai-responses WEVIR_TEST_BASE_URL=http://127.0.0.1:11434/v1 WEVIR_TEST_MODEL=gpt-oss:20b pnpm vitest run --project adapter-codex codex-adapter.contract.real --maxWorkers=2
```

Cloud 改 WEVIR_TEST_BASE_URL=https://ollama.com/v1，WEVIR_TEST_MODEL 取发现接口返回的原名。之后另用 pnpm dev 的对应模板做一次 apply_patch 改文件对话。2026-10-16 本机无 Ollama 与模型，这两项未验收；mock 测试不替代真实验收。发现接口与上下文含义见 providers.md §7.5；不会自动下载模型、管理服务或修改 OLLAMA_CONTEXT_LENGTH。

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

用到 Key 的测试：`packages/adapter-dsh` 的 `dsh-adapter.approval.integration`、`dsh-adapter.resume.integration`、`provider-test.integration`、`dsh-adapter.contract.real.integration`，`packages/host` 的 `host-process.dsh.integration`，`packages/adapter-codex` 的 `codex-adapter.contract.real.integration`，以及 `packages/model-gateway` 的 `gateway.real.integration`（DeepSeek 的 Responses、Chat、Messages 三条路）。Key 只经环境变量传给测试：Codex 路由只交给网关内存、不进 Codex 环境；dsh 路由只进 dsh 子进程环境。不写进 overlay、快照或日志；不要把 Key 写进仓库里的任何文件。

DeepSeek 经 Codex 的官方 Responses 路由与网关三条路分别验证。先在进程环境设置 WEVIR_TEST_API_KEY，命令中不写 Key；默认模型 deepseek-flash，再设 WEVIR_TEST_MODEL=deepseek-v4-pro 重跑：

```bash
WEVIR_TEST_PROVIDER=deepseek-official pnpm vitest run --project adapter-codex codex-adapter.contract.real --maxWorkers=2
```

```bash
WEVIR_TEST_PROVIDER=deepseek pnpm vitest run --project model-gateway gateway.real --maxWorkers=2
```

网关真实测试包含 Responses / Chat / Messages 的最小对话、连接探测、工具调用及下一回合回忆，并单独检查 Responses 在 high 下的 required / 具名选择。2026-10-16 已用真实 Key 复现：两个模型均拒收 forced choice（400），默认 auto_only 改写后为 200；网关测试每模型 11 项通过。两个模板都不填 maxTokens，理由与旧 Provider 的手动更新见 providers.md §7.1；Responses 长回答的默认输出上限尚未实测。真实契约的审批提示词只要求一次 touch，完成或拒绝后不再调用工具，避免模型另做 ls 校验产生第二次审批、使单审批用例挂起。

同日两个模型的 Codex 契约第 3 层各 23 项通过。`pnpm dev` 以独立数据目录附着真实 Codex Host，官方模板 Flash / high 与 Chat 模板 V4 Pro / low 都经 apply_patch 写出预期文件；只将临时 SecretStore 的持久化替换为内存，API Key 从进程环境填入界面，未落文件。目录、地域说明、默认模型、推理档位和 1280px / 960px 视口检查通过；临时进程、脚本、截图、工作区与数据目录在验收后删除。

可选 dsh 引擎原有的例子：

```bash
WEVIR_TEST_API_KEY=<Key> WEVIR_TEST_PROVIDER=deepseek-official pnpm vitest run --project adapter-dsh dsh-adapter.contract.real
```

百炼按量 API 经 Responses 透传。先在进程环境提供北京地域的 WEVIR_TEST_API_KEY，再分别验证 Max 与 Flash；不把 Key 写进命令或文件：

```bash
WEVIR_TEST_PROVIDER=openai-compatible WEVIR_TEST_API=openai-responses WEVIR_TEST_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 WEVIR_TEST_MODEL=qwen3.8-max pnpm vitest run --project adapter-codex codex-adapter.contract.real --maxWorkers=2
```

```bash
WEVIR_TEST_PROVIDER=openai-compatible WEVIR_TEST_API=openai-responses WEVIR_TEST_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 WEVIR_TEST_MODEL=qwen3.8-flash pnpm vitest run --project adapter-codex codex-adapter.contract.real --maxWorkers=2
```

2026-10-15 未提供百炼 Key，上述真实契约与 pnpm dev 中通过百炼模板、经 apply_patch 改文件的对话未验收。工具默认值来自保守兼容策略，拿到 Key 后先确认 custom / namespace / 非 auto 的 tool_choice，再判断是否覆盖 compat；同时验证工具结果与下一回合的 reasoning id / summary 回放。provider.test 的最小请求不能替代这些验收，地址与旧 Provider 的手动修改见 providers.md §7.2。

Azure OpenAI 的 v1 Responses 与 Foundry Claude 分别用以下命令。先在进程环境提供对应资源的 WEVIR_TEST_API_KEY；将资源和部署占位替换为部署详情的实际值，不把 Key 写入文件或命令记录：

```bash
WEVIR_TEST_PROVIDER=openai-compatible WEVIR_TEST_API=openai-responses WEVIR_TEST_BASE_URL='https://<resource>.openai.azure.com/openai/v1' WEVIR_TEST_MODEL='<deployment>' pnpm vitest run --project adapter-codex codex-adapter.contract.real --maxWorkers=2
```

```bash
WEVIR_TEST_PROVIDER=openai-compatible WEVIR_TEST_API=anthropic-messages WEVIR_TEST_BASE_URL='https://<resource>.services.ai.azure.com/anthropic' WEVIR_TEST_MODEL='<deployment>' pnpm vitest run --project adapter-codex codex-adapter.contract.real --maxWorkers=2
```

两条路的 model 都是部署名。2026-10-15 未提供 Azure Key、资源端点与部署名，真实契约与 pnpm dev 中通过两个模板、经 apply_patch 改文件均未验收。Responses 的 Bearer API Key 目前仅按微软 SDK 与 Codex 示例推断；第三种 cognitiveservices.azure.com 地址须以部署详情确认为准。网关录制请求与本机 HTTP mock 只证明兼容修正、认证头构造、工具和推理往返及 provider.test；不能证明真实服务通过。配置与 Claude 自定义别名的局限见 providers.md §7.12 和 model-gateway.md §3.5。

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

模板里的 3.1 Pro 使用官方 API ID `gemini-3.1-pro-preview`，真实验证沿用同一 Chat 地址：

```bash
WEVIR_TEST_PROVIDER=openai-compatible WEVIR_TEST_API=openai-completions WEVIR_TEST_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/ WEVIR_TEST_MODEL=gemini-3.1-pro-preview pnpm vitest run --project adapter-codex codex-adapter.contract.real --maxWorkers=2
```

2026-10-15 维护者确认本次没有 Gemini Key，3.8 Flash / 4 Argon 的真实契约已明确跳过，新增 3.1 Pro 的真实契约未跑，pnpm dev 中通过 Gemini 模板、经 apply_patch 改文件的桌面对话未跑。`gemini.integration.test.ts` 的 HTTP mock 与四份录制请求覆盖三款模型的 minimal 降档、并行结果连续排放、空文本末片签名和同回合多步回传；Schema 清洗开关默认关闭。拿到 Key 后逐款补真实契约，并先分别试 additionalProperties 与空对象参数，确实收到相关 400 才开启 compat.geminiToolSchema；provider.test 没有工具，不能代替此项或第二步工具签名验收。

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

联网工具（0.34.0，[web-tools.md](./architecture/web-tools.md) §7）的第 3 层用真实的搜索服务与网页，Key 只从进程环境读，没有就跳过并打印原因：

| 变量 | 含义 |
|---|---|
| `WEVIR_TEST_BOCHA_API_KEY` | 博查开放平台的 API Key：`web.test` 与一次真实的 `web_search` |
| `WEVIR_TEST_TAVILY_API_KEY` | Tavily 的 API Key（`tvly-…`），同上 |
| `WEVIR_TEST_WEB_FETCH=1` | 抓一个公开网页（`https://example.com/`），不需要 Key |

```bash
WEVIR_TEST_WEB_FETCH=1 pnpm vitest run --project host web.contract --maxWorkers=2
```

先在进程环境里提供 Key（不写进命令、文件或日志），再跑同一条命令。2026-10-15 没有博查与 Tavily 的 Key，两家的真实契约与桌面端配 Key 后经网关模型搜索、引用来源的对话都没有跑；`WEVIR_TEST_WEB_FETCH=1` 跑过（抓 example.com 通过），另外手动抓过 nodejs.org、docs.python.org、gov.cn、新浪新闻与 GitHub 的页面。mock HTTP 的单元测试（`pnpm vitest run --project host src/web`）与真实 `codex-app-server` 的第 2 层（`codex-adapter.web.integration`）不能替代它们。

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
