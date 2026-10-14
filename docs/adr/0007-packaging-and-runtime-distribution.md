# ADR-0007：第一个安装包与运行时分发

- 状态：Accepted（2026-10-14，R9 起草，维护者在对话中确认决策 1、2、3、6 的选项；决策 4 留给打包任务。同日维护者决定先做好基础，决策 6 的可选组件推迟，见决策 6）
- 日期：2026-10-14
- 任务：R9；影响：`apps/desktop` 的打包与资源目录、adapter-codex 的二进制解析；推迟的部分影响 adapter-dsh、Host 的组件管理、设置页的引擎列表、R8 的 Grok Build 与 Gemini CLI
- 依据：[ADR-0005](./0005-agent-runtime-and-model-gateway.md) 决策 8、未决事项 2 与 4；[ADR-0002](./0002-host-transport-and-process-model.md) 未决事项 1；[ADR-0004](./0004-repo-tooling.md)（打包工具留到打包阶段）；[UPSTREAM.md](../upstream/UPSTREAM.md) §1.2、§2.1、§2.4；[third-party-notices.md](../upstream/third-party-notices.md)；本文“背景”里的本机实测

## 背景

1. **仓库没有打包配置**：没有 electron-builder、Electron Forge 的依赖与配置文件，`apps/desktop` 只有 electron-vite 的 `build`（产物在 `out/`）。
2. **Host 现在跑在开发者本机的 Node 上**（`WEVIR_NODE` 或 `PATH`，`host-lifecycle.ts`），dsh 跑在 Host 的 `process.execPath` 上（ADR-0002 未决事项 1）。本机实测：Electron 44.7.0 以 `ELECTRON_RUN_AS_NODE=1` 运行时是 Node 24.21.0（`process.versions.modules` 149），`node:sqlite` 可用（SQLite 3.53.4）。ADR-0002 未决事项 1 担心的“Electron 内置的 Node 有没有 `node:sqlite`”不成问题。
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
| **(b) 第一个包不自动更新（选定）**：“关于”里检查 GitHub Releases 的最新版本并给下载链接；发布目录按 `generic` provider 的布局放好，有了国内镜像再打开 (a) | 不需要托管；macOS 未签名时也能用 |
| (c) electron-updater + GitHub Releases | 国内下载慢、常失败 |

### 4. Host 与引擎跑在哪个 Node（ADR-0002 未决事项 1）

没有拿出来确认，留给打包任务实测后定（未决事项 3）。建议用 **Electron 自带的 Node**（`ELECTRON_RUN_AS_NODE=1` 运行安装包里的主程序）：背景 2 已实测 `node:sqlite` 可用，安装包不再多带一份 Node（压缩约 30–40 MiB）。dsh 同样跑在它上面；背景 5 的原生模块逐个核实，有不兼容的再改为随包带 Node。

### 5. Codex 随包（与打包工具无关，R9 已做）

- 构建时 `pnpm --filter @wevir/desktop resources [--target <三元组>]`（`apps/desktop/scripts/stage-resources.ts`）用 `scripts/fetch-codex.sh --target <三元组> --out <目录>` 按**目标平台**取锁定版本的二进制（同一张 sha256 表），放进桌面端的资源目录 `apps/desktop/resources/engines/codex/`（gitignore），打包时原样进入安装包的资源目录（electron-builder 的 `extraResources`，运行时是 `process.resourcesPath`）。
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
- **第一个安装包另开任务**，要做：electron-builder 26 的配置（`extraResources` 收 `apps/desktop/resources/`）；Host 由安装包里的程序拉起（决策 4，Host 的 `dist` 与生产依赖怎样进安装包）；`@deepseek-ai/dsh` 及其闭包不进安装包（它现在是 adapter-dsh 的生产依赖，组件管理推迟期间，安装包里的 Host 不提供 dsh）；macOS 的 Developer ID 签名与公证（Hardened Runtime，随包的 `codex-app-server` 重签；以后下载 dsh 原生模块时主程序要加 `com.apple.security.cs.disable-library-validation`）；“关于”里检查 GitHub Releases 的新版本；按安装包的实际内容生成第三方声明（third-party-notices.md §4）。
- 安装包变大：每个平台多出 `codex-app-server` 的压缩约 72–82 MiB（解压 181–243 MiB），与 ADR-0005 的“后果”一致。

## 未决事项

1. Windows 的 Codex 沙箱附带程序是否要随包、Linux 是否保留随包的 `bwrap`（ADR-0005 未决事项 4，两个平台实测后定）。
2. dsh 的原生模块在 Electron 的 Node 上逐个能否加载（决策 4）。
3. Host 与引擎跑在哪个 Node（决策 4）：打包任务实测后定。
4. 可选组件（决策 6）：什么时候做、是否仍用下载来源 A，由维护者定；接着做时以分支 `r9-components` 为起点，协议换成那时的下一个次版本。同时要做的还有 dsh 离开 pnpm 的两件事（背景 5）。
