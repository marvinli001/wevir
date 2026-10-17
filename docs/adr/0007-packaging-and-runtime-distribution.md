# ADR-0007：第一个安装包与运行时分发

- 状态：Accepted（2026-10-14，R9 起草，维护者在对话中确认决策 1、2、3、6 的选项；决策 4 同日定为 Electron 自带的 Node 并实现。同日维护者决定先做好基础，决策 6 的可选组件推迟，见决策 6）。2026-10-16 补记 1：第一个安装包；补记 2：维护者改了决策 3（自动更新、两条下载线路、正式版与开发版）；补记 3：Claude 与 Cursor 的 SDK 不随安装包分发；补记 4：自动更新的客户端；2026-10-17 补记 5：加 GitHub Release 线路；补记 6：Claude Agent SDK 随安装包分发
- 日期：2026-10-14
- 任务：R9；影响：`apps/desktop` 的打包与资源目录、adapter-codex 的二进制解析；推迟的部分影响 adapter-dsh、Host 的组件管理、设置页的引擎列表、R8 的 Grok Build 与 Gemini CLI
- 依据：[ADR-0005](./0005-agent-runtime-and-model-gateway.md) 决策 8、未决事项 2 与 4；[ADR-0002](./0002-host-transport-and-process-model.md) 未决事项 1；[ADR-0004](./0004-repo-tooling.md)（打包工具留到打包阶段）；[UPSTREAM.md](../upstream/UPSTREAM.md) §1.2、§2.1、§2.4；[third-party-notices.md](../upstream/third-party-notices.md)；本文“背景”里的本机实测

## 背景

1. **仓库没有打包配置**：没有 electron-builder、Electron Forge 的依赖与配置文件，`apps/desktop` 只有 electron-vite 的 `build`（产物在 `out/`）。
2. **Host 现在跑在开发者本机的 Node 上**（`WEVIR_NODE` 或 `PATH`，`host-lifecycle.ts`），dsh 跑在 Host 的 `process.execPath` 上（ADR-0002 未决事项 1）。本机实测：Electron 44.7.0 以 `ELECTRON_RUN_AS_NODE=1` 运行时是 Node 24.21.0（`process.versions.modules` 149），`node:sqlite` 可用（SQLite 3.53.4）。ADR-0002 未决事项 1 担心的“Electron 内置的 Node 有没有 `node:sqlite`”不成问题。决策 4 起，桌面端改用 Electron 自带的 Node 拉起 Host。
3. **Codex 的发布物**（`rust-v0.162.1`，GitHub Release API，2026-10-14）：

   | 平台 | 独立二进制（`.tar.gz`） | 解压后 | 另需 |
   |---|---|---|---|
   | macOS arm64 | 71.9 MiB | 181 MiB | — |
   | macOS x64 | 78.2 MiB | — | — |
   | Windows x64 | 81.6 MiB | 243.4 MiB | 沙箱的 `codex-windows-sandbox-setup` / `-service`（6.5 / 17.2 MiB）是否需要，未核实 |
   | Windows arm64 | 74.9 MiB | 205.2 MiB | 同上 |
   | Linux x64（musl） | 82.1 MiB | — | `bwrap-x86_64-unknown-linux-musl.tar.gz`，0.2 MiB |
   | Linux arm64（musl） | 76.4 MiB | — | `bwrap-aarch64-unknown-linux-musl.tar.gz`，0.2 MiB |

   Codex 在 Linux 上优先用 `PATH` 上的 `bwrap`，没有时用可执行文件旁边的 `codex-resources/bwrap`（`upstream/codex/codex-rs/linux-sandbox/README.md`）。ADR-0005 未决事项 4（Linux 是否随包带 `bwrap`、Windows 用哪种沙箱）还没有结论：R2 只在 macOS 上实测过。
4. **dsh 的依赖闭包**（本机 pnpm 安装的 `@deepseek-ai/dsh@0.2.1-alpha.2` 生产闭包，按各包 `package.json` 的 `os` / `cpu` / `libc` 过滤出每个平台会装的部分）：

   | 平台 | 包数 | 解压后 |
   |---|---|---|
   | macOS arm64 | 590 | 588 MiB（打成 `.tar.gz` 约 165 MiB） |
   | macOS x64 | 590 | 607 MiB |
   | Windows x64 / arm64 | 587 / 586 | 622 / 581 MiB |
   | Linux x64 / arm64（glibc） | 589 / 589 | 593 / 594 MiB |

   大头：`@deepseek-ai/libreoffice-kit-<平台>` 148–184 MiB（Office 转 PDF，MPL-2.0）、`sherpa-onnx-<平台>` 22–38 MiB（语音）、`openai` 27 MiB、`node-pty` 26 MiB（带全部平台的预编译）、`dsh-experimental-inspector` 25 MiB、`@img/sharp-libvips-<平台>` 约 18 MiB（LGPL-3.0）。
5. **dsh 离开 pnpm 还缺两件事**：
   - adapter-dsh 在 dsh 第一次启动时运行 `dsh plugin --profile acp add link:<stream-tap>`，dsh 把它转给 `PATH` 上的 **pnpm**（`packages/adapter-dsh/src/stream-tap.ts`）。用户的机器上一般没有 pnpm，这一步要由 Wevir 代做（写 profile 的 `package.json` 依赖并建链接）。
   - `@deepseek-ai/dsh-subprocess-local` 有 `postinstall`（给 node-pty 的 `spawn-helper` 恢复执行位），不经包管理器安装时要代做；原生模块（`node-pty`、`koffi`、`sharp`、`sherpa-onnx-node`、`node-addon-system`）要能在 Electron 的 Node 上加载，N-API 的不受 ABI 影响，要逐个核实。
6. **许可证**：Codex 是 Apache-2.0，带 `NOTICE`；Linux 的 `bwrap` 是 LGPL-2.0-or-later；dsh 闭包里有 MPL-2.0（`libreoffice-kit`）与 LGPL-3.0（sharp 的 libvips）。谁把这些文件交给用户，谁承担 third-party-notices.md §3.3、§3.4 的义务（对应源码的获取方式等）。

## 决策

每项保留当时列出的选项，**粗体**是维护者选定的。

### 1. 打包工具

| 选项 | 说明 |
|---|---|
| **electron-builder 26（选定）** | electron-vite 的分发文档以它为主；`extraResources` 放 Codex 二进制、`asarUnpack`；macOS 签名与公证（notarytool）、Windows NSIS 与 Azure Trusted Signing、Linux AppImage / deb 都内置；electron-updater 的 `generic` provider 可以指向任意静态地址（国内镜像），并支持签名的更新清单；`.npmrc` 已写好 `ELECTRON_BUILDER_BINARIES_MIRROR` |
| Electron Forge 8 | Electron 官方。ADR-0004 已不用它的 Vite 插件，只拿来打包要另配一套忽略规则；自动更新走 Squirrel（`update.electronjs.org` 只服务公开 GitHub 仓库，且要求 macOS 已签名），国内可达性差 |

### 2. 签名与公证

| 选项 | 后果 |
|---|---|
| (a) 第一个包不签名（macOS 用 ad-hoc 签名，Windows 不签） | 只适合自己与内测者：macOS 上下载的包会被隔离，要在“系统设置 → 隐私与安全性”放行（或 `xattr -dr com.apple.quarantine`）；Windows 有 SmartScreen 警告；macOS 的自动更新（Squirrel.Mac）要求应用已签名，所以没有自动更新 |
| **(b) macOS 用 Developer ID 签名并公证，Windows 先不签（选定；维护者有 Apple 开发者账号）** | Apple Developer Program 年费 99 美元；开启 Hardened Runtime，随包的 `codex-app-server` 由 Wevir 重签；**下载来的 dsh 原生模块没有 Wevir 的签名**，Electron 以 Node 身份运行 dsh 时要给主程序加 `com.apple.security.cs.disable-library-validation`，否则加载失败 |
| (c) 两个平台都签 | 在 (b) 之上加 Windows 证书：OV / EV 证书每年数千元，Azure Trusted Signing 只对部分国家与地区的机构开放 |

### 3. 更新渠道

| 选项 | 说明 |
|---|---|
| (a) electron-updater + `generic` provider 指向国内对象存储 / CDN，GitHub Releases 作源与备用，更新清单签名 | 国内下载快；要有对象存储账号，国内 CDN 要已备案的域名 |
| **(b) 第一个包不自动更新（2026-10-14 选定，2026-10-16 改为 (a) 的做法，见补记 2）**：“关于”里检查 GitHub Releases 的最新版本并给下载链接；发布目录按 `generic` provider 的布局放好，有了国内镜像再打开 (a) | 不需要托管；macOS 未签名时也能用 |
| (c) electron-updater + GitHub Releases | 国内下载慢、常失败 |

### 4. Host 与引擎跑在哪个 Node（ADR-0002 未决事项 1）

**Electron 自带的 Node（维护者 2026-10-14 定，同日实现）。** 桌面主进程用自己的可执行文件 `process.execPath`（开发时是 Electron，打包后是 Wevir 主程序）加环境变量 `ELECTRON_RUN_AS_NODE=1` 拉起 Host（`host-lifecycle.ts` 的 `hostRuntime`）。用户不用另装 Node，从访达或开始菜单启动也不依赖 `PATH`；安装包不多带一份 Node（压缩约 30–40 MiB）。T3 Code 的桌面端也这样拉起它的本机服务；Codex 桌面端没有这一层，界面经 stdio 直接连 app-server。

- `WEVIR_NODE` 仍可改用别的 Node（排查用）；不再在 `PATH` 里找 `node`。
- 这个变量只留在 Host 进程里：Host 给 codex-app-server 与 dsh 的环境按白名单构造（ADR-0005 决策 5、ADR-0001 §4），传不到 Agent 跑的命令里。传过去的话，用户在会话里启动的 Electron 应用会被当成 Node 运行。
- 打包时不能用 `@electron/fuses` 关掉 `RunAsNode`，否则 Host 起不来。
- dsh 还不能跑在这样的 Host 里：adapter-dsh 默认用 Host 的 `process.execPath` 运行 dsh，而白名单环境里没有 `ELECTRON_RUN_AS_NODE`，dsh 会以 Electron 应用的方式启动；原生模块的 ABI 也要逐个核实（背景 5）。桌面端拉起的 Host 不传 `--adapter`，只用 Codex，现在不受影响；做可选组件（决策 6）时一并处理（未决事项 2）。
- 实测（2026-10-14，macOS arm64，开发构建 `pnpm dev`）：Host 进程是 Electron 二进制，环境里有 `ELECTRON_RUN_AS_NODE=1`，程序坞里没有多出图标；它拉起的 codex-app-server 环境里没有 `ELECTRON_*`；经 mock 模型完成一个回合（含一次命令执行），桌面端照常显示；关窗口后 Host 退出。`host-lifecycle.test.ts` 有一条用例用本机已下载的 Electron 二进制拉起真实的 Host（没下载时跳过）。Windows、Linux 与安装包里的主程序没有实测。

### 5. Codex 随包（与打包工具无关，R9 已做）

- 构建时 `pnpm --filter @wevir/desktop resources [--target <三元组>]`（`apps/desktop/scripts/stage-resources.ts`）用 `scripts/fetch-codex.sh --target <三元组> --out <目录>` 按**目标平台**取锁定版本的二进制（同一张 sha256 表；`codex-app-server` 与它旁边的 `codex-code-mode-host`，2026-10-16 补：后者是 code mode 的 `exec` 运行的独立进程，漏了它时只给 code mode 的模型调不了工具），放进桌面端的资源目录 `apps/desktop/resources/engines/codex/`（gitignore），打包时原样进入安装包的资源目录（electron-builder 的 `extraResources`，运行时是 `process.resourcesPath`）。
- 打包后的桌面主进程拉起 Host 时告诉它资源目录（环境变量 `WEVIR_RESOURCES_DIR`，`host-lifecycle.ts` 的 `hostEnvironment`；环境里已有这个变量时不覆盖，开发时不设）；adapter-codex 的解析顺序：`WEVIR_CODEX_BIN` → `<资源目录>/engines/codex/` → 开发缓存 `.wevir-dev/bin/`。资源目录里没有二进制时退回开发缓存，版本照旧在启动前用 `--version` 核对。
- 随附 Codex 的 `LICENSE` 与 `NOTICE`：取自锁定提交 `092d3ac`，放在 `apps/desktop/licenses/codex/`，准备资源时复制到二进制旁边；third-party-notices.md 加上 Codex（§2.5）。
- Linux：ADR-0005 未决事项 4 还没有结论（Linux 没有实测）。R9 的默认做法是随包带 `bwrap`（Codex 发布的 `bwrap-<目标>.tar.gz`，0.2 MiB，放在 `codex-resources/bwrap`，同样按 sha256 校验）：系统有 `bwrap` 时 Codex 优先用系统的，没有时才用它，不带的话这类机器上沙箱里的命令跑不起来。第三方声明写明 LGPL-2.0-or-later 与源码位置（锁定提交的 `codex-rs/vendor/bubblewrap/`）。Linux 实测后在 ADR-0005 补记里定下或改掉。Windows 的沙箱附带程序等 Windows 实测后再定。

### 6. 可选组件：推迟（维护者 2026-10-14）

维护者先选了下载来源 A（下表），随后同日决定**先做好基础，可选组件下载与组件管理往后放**；codex-app-server 随应用分发照做（决策 5）。所以 R9 落到 master 的只有决策 5：dsh 仍只在开发环境经 pnpm 安装（ADR-0005 未决事项 2 的“在那之前”继续有效），`--adapter dsh` 照旧解析 adapter-dsh 的依赖，协议没有加方法。

已经写好、没有合进 master 的实现留在分支 `r9-components` 上（WIP，以后接着做时以它为起点再核对一遍）：组件包 `packages/components`（清单、按清单从 npm registry 下载与 sha512 校验、pnpm 布局、删除与清理、tar 解包）、由 `pnpm-lock.yaml` 生成的 dsh 清单、adapter-dsh 的组件描述与入口解析、不经 pnpm 安装 stream-tap、Host 的 `engine.*` 方法（当时编号 0.8.0，现已被 R11 用掉，接着做时要换版本号）。

当时定下的做法，留作以后的起点（未决事项 4）：

- **版本锁定**：每个 Wevir 版本随应用带一份组件清单（组件 ID、版本、每个平台要下载的包与完整性校验值），只安装清单里写的版本；清单在构建时生成并进安装包，不从网上取。
- **安装**：装进 `<数据目录>/components/<组件 ID>/<版本>/`，逐个校验后解开，最后写入标记文件；中断或校验失败删掉这个版本目录。dsh 的 stream-tap 链接与 `postinstall` 由安装步骤代做（背景 5）。
- **升级**：新版本的 Wevir 带来新的清单，设置页显示“可升级”；新版本装好后删掉不在用的旧版本。
- **删除**：Host 正在用这个引擎时拒绝。
- **镜像**：registry 可以在设置里换（预置 npmmirror），环境变量也能指定；完整性只认清单里的校验值，与从哪里下载无关。
- **归属**：组件管理在 Host 里（数据目录归 Host；CLI 与桌面共用），Host API 加列出、安装（带进度通知）、取消、删除，设置页的引擎列表用它们。

下载来源（维护者选了 A）：

| 选项 | 做法 | 用户下载 | Wevir 要做的 | 许可证义务 |
|---|---|---|---|---|
| **A. npm registry 逐包下载（选定，推迟）** | 构建时从 `pnpm-lock.yaml` 生成 dsh 的安装清单（每平台约 550 个包、lockfile 里的 sha512），运行时并发下载、校验、解开，不运行任何安装脚本 | 约 165 MiB；默认 npmmirror，也可以是 `registry.npmjs.org` | 一个“按清单安装”的小安装器；不托管任何文件 | 文件由 npm registry 交给用户，Wevir 只在声明里写明；与开发环境装的是同一组版本 |
| B. Wevir 自己的发布物 | CI 每个平台装好 dsh、裁掉别的平台的预编译，打成一个压缩包，挂 GitHub Releases 与国内镜像，sha256 写进清单 | 约 140–165 MiB，1 个文件 | CI 打包与上传；国内可达的托管（对象存储 + 已备案域名的 CDN） | Wevir 是分发者：third-party-notices §3.3、§3.4 全部要做 |
| C. B 的压缩包发布成 npm 包 | 例如 `@wevir/engine-dsh-darwin-arm64`，经 npm / npmmirror 下载一个 tarball | 同 B | 要有 npm 的 `@wevir` 组织；先试发一次确认 registry 接受这么大的包 | 同 B |

## 备选方案

见各项的表。另外考虑过“不在应用里下载 dsh，让用户自己 `npm i -g` 再在设置里填路径”（R8 对 Grok Build、Gemini CLI 的第一步就是这样）：不满足 ADR-0005 决策 8 的“用户选用时下载”，只作为组件管理之外的兜底。

## 后果

- R9 只做了决策 5。仓库里仍然没有 electron-builder 的配置，所以“从安装包启动”还验证不了：R9 的验收是在开发构建上模拟安装后的布局（做法见 [development.md](../development.md) §3.5）。2026-10-14 在 macOS arm64 上：`pnpm --filter @wevir/desktop resources` 取到 `rust-v0.162.1` 并校验通过；全新的数据目录与 `HOME`、`env -i`、开发缓存里没有二进制、`WEVIR_RESOURCES_DIR` 指向 `apps/desktop/resources`，Host、mock 模型与 CLI 都在 `sandbox-exec` 里运行（只放行本机地址，沙箱里访问外网报 `EPERM`）。Host 以默认的 Codex 引擎启动，`codex-app-server` 从资源目录拉起；经 CLI 建 Provider（mock，Responses）、新建会话、一问一答完成（回合 `completed`，标题由模型生成）。没有验证的：工具调用（Codex 在 macOS 上用 `sandbox-exec` 跑命令，套在验收用的沙箱里会失败，与分发无关）、桌面端从安装包拉起 Host（打包任务）、Windows 与 Linux（只在 macOS 上跑过；Linux 的 `bwrap` 与 Windows 的资源目录都没有实测）。
- **第一个安装包另开任务**（2026-10-16 做了，见补记 1），要做：electron-builder 26 的配置（`extraResources` 收 `apps/desktop/resources/`）；Host 由安装包里的主程序拉起（决策 4 已在开发构建上实现；Host 的 `dist` 与生产依赖怎样进安装包，`RunAsNode` fuse 保持打开）；`@deepseek-ai/dsh` 及其闭包不进安装包（它现在是 adapter-dsh 的生产依赖，组件管理推迟期间，安装包里的 Host 不提供 dsh）；macOS 的 Developer ID 签名与公证（Hardened Runtime，随包的 `codex-app-server` 重签；以后下载 dsh 原生模块时主程序要加 `com.apple.security.cs.disable-library-validation`）；“关于”里检查 GitHub Releases 的新版本；按安装包的实际内容生成第三方声明（third-party-notices.md §4）。
- 安装包变大：每个平台多出 `codex-app-server` 的压缩约 72–82 MiB（解压 181–243 MiB），与 ADR-0005 的“后果”一致。

## 未决事项

1. Windows 的 Codex 沙箱附带程序是否要随包、Linux 是否保留随包的 `bwrap`（ADR-0005 未决事项 4，两个平台实测后定）。
2. dsh 的原生模块在 Electron 的 Node 上逐个能否加载，以及 dsh 进程怎样拿到 `ELECTRON_RUN_AS_NODE`（决策 4）。
3. Host 与引擎跑在哪个 Node：已定，Electron 自带的 Node（决策 4，2026-10-14）。
4. 可选组件（决策 6）：什么时候做、是否仍用下载来源 A，由维护者定；接着做时以分支 `r9-components` 为起点，协议换成那时的下一个次版本。同时要做的还有 dsh 离开 pnpm 的两件事（背景 5）。

## 补记

1. **2026-10-16，第一个安装包。** 后果里列的第一个安装包的事，做法如下；命令与检查方法见 [development.md](../development.md) §3.5、§3.6。
   - **打包工具**：electron-builder 26.17.0（`apps/desktop` 的 devDependency；27 还是 alpha），配置 `apps/desktop/electron-builder.yml`，`pnpm --filter @wevir/desktop package [--target <三元组>]`（`scripts/package.ts`：准备资源目录 → `electron-vite build` → electron-builder）。asar 里只有 `out/`：桌面端的工作区包改成 devDependencies（主进程与 preload 本来就把它们打进 `out/`），electron-builder 不收 node_modules。Chromium 的语言包只留界面支持的 10 种语言（`electronLanguages`）。`appId` 是 `si.wevir.desktop`（维护者的域名 wevir.si 倒过来；验收时打的包还是之前用的 `io.github.marvinli001.wevir`）；发第一个对外的版本之后不再改，macOS 的自动更新与 Windows 的通知都认它。
   - **Host 进安装包**：放在资源目录的 `host/`。`stage-resources.ts` 用 `pnpm deploy`（`--prod`、`--ignore-scripts`、hoisted 布局、按目标平台的 `--os` / `--cpu`）复制 wevir-host 与生产依赖，再从 Host 的依赖出发剪掉 `vitest`（runtime-adapter 的可选 peer，pnpm 从工作区根的开发依赖解析到它）、`@deepseek-ai/dsh` 与只被它们用到的包，最后检查没有这两个包、没有符号链接、没有安装脚本。没有把 Host 打成单个文件：`@cursor/sdk` 的平台包带可执行文件与 `.node`，按包原样放与开发时的模块解析相同。安装包里的主程序以 `ELECTRON_RUN_AS_NODE` 拉起 `<资源目录>/host/dist/main.js`（`packagedHostEntry`），`RunAsNode` fuse 保持默认打开（配置里没有 `electronFuses`）。2026-10-16 在 macOS arm64 上是 24 个顶层包、85 MB。
   - **dsh**：`@deepseek-ai/dsh` 从 adapter-dsh 的 dependencies 移到 devDependencies，安装包里的 Host 不带 dsh（决策 6：可选组件推迟期间 dsh 只在开发环境经 pnpm 安装）；开发环境的 `--adapter dsh` 照旧。
   - **提示词**：资源目录的 `prompts/`（仓库的 `prompts/`，不含 README.md）。adapter-codex 的 `resolvePromptsDir`：`<WEVIR_RESOURCES_DIR>/prompts/`（有 `base.md` 时）→ 仓库的 `prompts/`，wevir-host 把结果交给 Codex 与会话标题（codex-event-mapping 未决事项里的“安装包里提示词的位置”）。
   - **签名与公证**（决策 2）：Hardened Runtime，entitlements 只有 `com.apple.security.cs.allow-jit`，主程序与包里其余可执行文件共用；electron-builder 默认模板里的 `allow-unsigned-executable-memory` 与 `disable-library-validation` 不要（包里的 `.node` 一起用 Wevir 的证书重签，同一个 Team ID 能过库验证）。@electron/osx-sign 把包里的二进制（codex-app-server，`@cursor/sdk` 的 `rg`、`cursorsandbox` 与 tree-sitter 的 `.node`）都重签。公证在环境里有 notarytool 凭据（`APPLE_KEYCHAIN_PROFILE`，或 Apple ID 三件套，或 App Store Connect API 密钥三件套）时自动进行，没有就跳过并告警。
   - **验收**（2026-10-16，macOS arm64，钥匙串里的 Developer ID 证书，没有公证凭据）：dmg 204 MB、zip 200 MB（带 blockmap；裁掉语言包之前是 214 / 209 MB）。`codesign --verify --deep --strict` 通过，包里的二进制与 `.node` 都是同一个 Team ID、带 Hardened Runtime 与时间戳；`spctl` 判定 `Unnotarized Developer ID`（还没公证）。用临时数据目录直接运行 `Wevir.app/Contents/MacOS/Wevir`：主程序拉起 `Contents/Resources/host/dist/main.js`，Host 的本机 MCP 脚本也由主程序以 Node 身份运行；经 CLI 登记 mock 模型（Responses）、新建会话发“工具”，模型请求经网关，安装包里的 codex-app-server 执行 `ls`，回合 `completed`，标题由模型生成，Codex 的模型目录里是 `base.md` 的内容（安装包里没有仓库的 `prompts/`，只能来自资源目录）。窗口经 `wevir://` 从 asar 加载、正常显示。退出应用时 Host 与 codex-app-server 都退出。裁掉语言包后重打的包又验了一遍启动、显示与退出。Windows x64 的 NSIS 安装程序（183 MB，未签名）在 macOS 上交叉打出来了，不用 Wine。
   - **没有验证的**：公证，以及在另一台 Mac 上从下载的 dmg 安装（要维护者的公证凭据）；x64 的 Mac；Windows 包没有在 Windows 上安装运行过；按安装包的实际内容生成第三方声明（third-party-notices.md §4）；`@cursor/sdk` 与 `@anthropic-ai/claude-agent-sdk` 的许可证写的是“All rights reserved，按各自的服务条款使用”，能否随安装包再分发要维护者确认（同日定为不随应用分发，见补记 3）。
2. **2026-10-16，维护者改决策 3：自动更新。** 不再是“第一个包不自动更新”，改成 (a) 的做法并扩展：
   - electron-updater，自定义 provider（基于 `generic`）：客户端内置两个 Wevir 自己的下载域名，只认域名不认服务商：全球线路 `download.wevir.si`（Cloudflare R2 + CDN），优化线路 `download2.wevir.si`（三网优化的服务器）；维护者 2026-10-16 定，当时还没有解析；检查更新时同时向两条线路取更新清单，先到且校验通过的胜出，有新版本时再按两条线路下载安装包前一小段的速度选线路，失败换另一条，GitHub Releases 作备用。
   - 正式版与开发版两个通道，只有 master 一条线：开发版是下一个正式版的预发布（`X.Y.Z-beta.N`），正式版在 master 上打 tag `vX.Y.Z`；开发版用户也收到正式版，从开发版切回正式版不降级。GitHub Actions 在 CI 通过后自动构建并上传到两条线路：先传安装包、都成功后再写清单，清单只许更高的版本覆盖。
   - 更新清单要签名验证：electron-builder 26.17 没有签名更新清单（`updateManifest` 是 27 的功能，现在还是 alpha），在自定义 provider 里自己验签，或等 27 正式版。
   - 界面照 Codex 桌面端：侧栏左下角显示新版本，点击后显示下载进度，下载完变成“重启以更新”等用户点。
   - 分几步做：更新模块与界面、发布流水线、服务器配置。每一步做完在这里补记。
3. **2026-10-16，Claude 与 Cursor 的 SDK 不随安装包分发。** `@anthropic-ai/claude-agent-sdk` 与 `@cursor/sdk` 的许可证写的是“All rights reserved，按各自的服务条款使用”，维护者定不随应用再分发。
   - `stage-resources.ts` 的 `EXCLUDED_PACKAGES` 加上这两个包，剪掉它们与只被它们用到的依赖（`@anthropic-ai/sdk`、`@cursor/sdk` 的平台包等）。安装包里的 Host 从 85 MB 降到 21 MB，不再有原生模块与可执行文件。
   - Host 照常启动：adapter-claude 不再静态 import SDK，改为模块加载时动态 import，只把 `ERR_MODULE_NOT_FOUND` 当作没装（`claudeSdkInstalled`）；adapter-cursor 本来就是第一次用到时才加载，加了只解析不加载的 `cursorSdkInstalled`。host 的 `subscriptionEngines` 在 SDK 不在时不挂那个引擎，日志记 `engine sdk not installed; engine disabled`。桌面端没有这种账号，订阅来源里显示“即将支持 · 当前后台服务不支持”。开发环境里两个 SDK 照旧经 pnpm 装上，五种订阅引擎都在。
   - 安装包里要用 Claude 或 Cursor，得在用户选用时再下载 SDK（与 dsh 一样属于可选组件，决策 6，还没做）；下载时由用户的机器直接从 npm registry 取，Wevir 不分发这两个包。`@cursor/sdk` 的平台包带 `.node` 与可执行文件，下载来的没有 Wevir 的签名，到时主程序要加 `com.apple.security.cs.disable-library-validation`（同决策 2 对 dsh 的说法）。
   - 验收（2026-10-16，macOS arm64）：资源目录里的 Host 以 `ELECTRON_RUN_AS_NODE` 在 `env -i` 的环境里启动，日志里两个引擎各记一条未启用，Host `ready`。
   - 公证（同日，维护者的 App Store Connect API 密钥存成 notarytool 的钥匙串 profile，`APPLE_KEYCHAIN_PROFILE`）：electron-builder 公证并装订了 `.app`；`spctl` 判定 `accepted, source=Notarized Developer ID`，`stapler validate` 通过，dmg 里的那份也一样；加上下载隔离属性的副本 `spctl` 同样通过，`syspolicy_check distribution` 报 ready for distribution。dmg 本身没有签名（electron-builder 的默认），只靠里面装订过的应用通过 Gatekeeper。这次的包：dmg 191 MB、zip 186 MB，`appId` 是 `si.wevir.desktop`。
4. **2026-10-16，自动更新的客户端（补记 2 的第 2 步）。** electron-updater 6.8.10，主进程的 `src/main/updates/`，界面在渲染进程的 `updates/`；命令与本机验收方法见 [development.md](../development.md) §3.8，界面规格见 desktop-tokens.md §46。
   - **线路与发布目录**：两条线路（`download.wevir.si`、`download2.wevir.si`）的布局相同：`<线路>/desktop/<平台>-<架构>/` 里是 electron-builder 写的清单、清单列出的文件与 blockmap，以及每份清单的签名 `<清单>.sig`。electron-builder.yml 配了 generic 的 `publish`，只为了写出清单（`--publish never`，不经它上传）；`scripts/release-dir.ts` 把一次打包的产物整理成这个目录并签名，发布流水线上传它。
   - **取清单与选线路**（`feed.ts`，自定义 provider `mirror-provider.ts` 把结果交给 electron-updater）：同时问所有线路，第一条给出验过签的清单的胜出（整体 15 s 超时）；版本比当前新时等其他线路的结果，在给出同一版本的线路之间各取安装包开头 256 KB（Range，不认 Range 的线路不参加），按吞吐选下载线路。清单里的文件只能是发布目录里的相对路径，下载走的就是选中的线路。下载失败时那条线路记为失败，重新检查、换另一条再下一次；两条都失败报 `download`。
   - **签名**：Ed25519，签清单的原始字节；公钥编进应用（`keys.ts` 的 `UPDATE_PUBLIC_KEYS`，任何一把验过即可，轮换时先加新公钥发一版）。私钥 2026-10-16 生成在维护者本机 `~/.wevir-release/update-signing-key.pem`，发布流水线用 secret `WEVIR_UPDATE_SIGNING_KEY`。没有公钥的构建不检查更新。清单验签不过报 `signature`、不下载；清单里每个文件的 sha512 由 electron-updater 下载后核对。没有等 electron-builder 27 的签名清单（还是 alpha）。
   - **通道**：正式版只读 `latest`；开发版读 `latest` 与 `beta` 取版本高的（还没有 `beta` 的清单时只看 `latest`），正式版发布后开发版用户也收到它，发布时不必把正式版复制成 `beta`。`allowDowngrade` 关着，切回正式版不降级。默认通道按当前版本：带预发布标签是开发版，否则正式版；选择存在 `<userData>/updates.json`。
   - **状态与时机**：启动 30 s 后检查一次，之后每小时一次；睡眠时计时器不走，所以唤醒或窗口回到前台时，上次检查早于 15 分钟就补查一次并重新计时（2026-10-17 起，原来是每 4 小时、不补查）。macOS 应用菜单有“检查更新…”，打开设置 → 关于并立即检查；不自动下载（`autoDownload` 关），点侧栏的入口才下载。下载完显示“重启以更新”等用户点（2026-10-16 起不再在没有回合在跑时自己安装）；下载好了但用户直接退出时退出时安装（`autoInstallOnAppQuit`）。安装经 `quitAndInstall`，主进程原有的退出流程照常停掉自己拉起的 Host。开发构建、没有公钥、macOS 上从 dmg 直接打开或被系统转移位置时关闭；最后一种在设置里给“移到“应用程序””。
   - **验收**（2026-10-16，macOS arm64，两个版本都用 Developer ID 签名、没有公证）：装 0.1.0，两条本机线路（支持 Range 的小服务器，全球线路限速 3 MB/s）发 0.1.1 的发布目录，`WEVIR_UPDATE_MIRRORS` 指过去。启动后两条线路都取了清单与签名、各取了安装包开头 256 KB，按吞吐选了优化线路（约 87 000 对 2 900 字节 / 毫秒）；侧栏左下角出现“新版本 0.1.1 · 更新”，点击后从优化线路下载整个 zip（第一次更新没有旧的 update.zip，不走差分），没有回合在跑，直接显示“正在安装更新”，应用退出并停掉 Host，Squirrel 换掉应用、重新打开：Info.plist 是 0.1.1，签名完整，新版本启动后又检查了一次。
   - **没有验证的**：Windows（NSIS 的更新、未签名时 electron-updater 不做发布者校验，安全只靠清单签名与 sha512）；差分下载（要第二次更新才有旧包）；真实的两个域名与 CDN（还没解析）；下载中途断网、两条线路都坏时界面的表现只有单元测试。
5. **2026-10-17，加 GitHub Release 线路（维护者定）。** 海外以 GitHub 为主要的更新线路，`download.wevir.si`（Bunny）留作备用，`download2.wevir.si`（RustFS）照旧；原有两条线路与客户端的选线路逻辑都不变，只是多一条。国内的 git 平台（CNB、Gitee）商量过，这次不做。
   - **布局**：仓库里 tag `desktop-updates` 的一个滚动 Release（预发布、不标 Latest，Releases 页上的最新版本仍是正式版的 `vX.Y.Z`），只放更新用的文件。附件没有目录：清单与签名的名字前加平台目录（`darwin-arm64-latest-mac.yml`、`win32-x64-beta.yml.sig`），安装包与 blockmap 照原名（名字本来就带平台与架构），所以清单里的相对路径、electron-updater 差分下载时按版本号换出的旧 blockmap 地址都照样对。开发版与正式版的文件同在这一个 Release 里，与发布目录一样各留最新 2 个版本。
   - **客户端**（`feed.ts`）：`UPDATE_MIRRORS` 加 `{ id: 'github', layout: 'release' }`，地址 `https://github.com/marvinli001/wevir/releases/download/desktop-updates`；清单地址由 `manifestUrl` 按布局拼，安装包相对 Release 的下载地址。仍然先验签，下载经 GitHub 的跳转到 `release-assets.githubusercontent.com`（支持 Range，测速与差分照用）。`WEVIR_UPDATE_MIRRORS` 里地址带 `/releases/download/` 的按这个布局读。
   - **发布**（`release.ts`）：线路抽成 `Line`（S3 两条与 GitHub 一条），流程不变：安装包先传到所有线路，再核对版本、写清单，最后清理。GitHub 线路用 gh 与工作流的 `GITHUB_TOKEN`（发布作业本来就有 `contents: write`），没有这个 Release 时先建；传完核对附件的大小与 GitHub 给的 sha256。写清单是 `--clobber`（先删后传），有一两秒这条线路没有清单或清单与签名对不上，客户端这时会用另外两条线路。正式版另建的 `vX.Y.Z` Release（dmg 与 exe，给人下载）照旧，不清理。
   - **验证**：单元测试；用模拟的 gh 跑了 `publish --only github` 的五次发布（建 Release、清单前缀、拒绝更低版本、两个通道各留 2 个版本）。没有在真实仓库上发过，第一次开发版发布时看。
6. **2026-10-17，Claude Agent SDK 随安装包分发（维护者定，改补记 3 中 Claude 的一半）。** Anthropic 2026-10-07 更新了 Agent SDK 的说明：第三方应用仍可经 Agent SDK 使用用户的订阅额度。维护者据此开放 Claude 订阅来源，并定 SDK 随应用带上，不做补记 3 里的按需下载。
   - `stage-resources.ts` 的 `EXCLUDED_PACKAGES` 去掉 `@anthropic-ai/claude-agent-sdk`，加上 `@anthropic-ai/sdk`（0.3.286 的 peer，只在 `.d.ts` 里用它的类型，运行时不加载，14 MB）。SDK 只带 JS（5.2 MB，包内 `LICENSE.md` 一起），各平台的 Claude Code 二进制照旧不装（`ignoredOptionalDependencies`），用用户自己装的 `claude`。`@cursor/sdk` 照旧不带。
   - 安装包里的 Host 从 21 MB 到 37 MB（另有 MCP SDK 与 zod 随 Claude Agent SDK 进来）。
   - 界面与 Host 建的 Provider 叫 “Claude”（原来是 “Claude Agent”）；已有的 Provider 还叫 “Claude Agent” 时，Host 下次刷新模型列表时改名，用户自己改过的名字不动（`accounts.ts` 的 `LEGACY_PROVIDER_NAMES`）。
   - 验收（2026-10-17，macOS arm64）：`pnpm --filter @wevir/desktop resources` 后资源目录的 Host 以 `ELECTRON_RUN_AS_NODE` 在 `env -i` 与临时 HOME 下启动，日志只有 Cursor 一条 `engine sdk not installed`，Host `ready`。没有用真实的 Claude 订阅跑会话。

