# 上游参考快照与许可证

> 建立于 T0.2（2026-10-12）。锁定提交以 [`upstream.lock`](./upstream.lock) 为准，本文件记录对应的核实结论。

名称说明（2026-10-18）：xAI 的界面显示名现为 SpaceXAI；本文的上游文件、包名、历史录制说明与版权归属保留原名，服务标志仍使用原 xai.svg。

`upstream/` 是六个上游仓库的只读浅克隆，已被 gitignore。不修改、不提交其中任何文件。复现或更新：

```bash
bash scripts/upstream-sync.sh
```

大陆网络下设置 `WEVIR_GITHUB_MIRROR`，脚本会用它替换仓库 URL 中的 `https://github.com` 前缀，例如 `WEVIR_GITHUB_MIRROR=https://<镜像域名>` 或 `https://<代理域名>/https://github.com`。

## 1. 仓库表

| 名称（`upstream/<名称>`） | 仓库 URL | 分支 | 锁定提交 | 提交日期（UTC） | 锁定日期 | 许可证结论 |
|---|---|---|---|---|---|---|
| `deepseek-harness`（dsh） | https://github.com/deepseek-ai/deepseek-harness | `master` | `d743267388641bc76f17c45ce8b4c231aed1d32c` | 2026-10-09 | 2026-10-12 | **MIT**（部分子目录 BSD-3-Clause，见 §2.1） |
| `openwork` | https://github.com/different-ai/openwork | `dev` | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | 2026-10-11 | 2026-10-12 | **`ee/` 之外 MIT；`ee/` 为 OpenWork EE License（非开源）** |
| `paseo` | https://github.com/getpaseo/paseo | `main` | `dc7bc8db124e837ba909ffd3b4b20e16adaebe24` | 2026-10-12 | 2026-10-12 | **Apache-2.0**（少数第三方组件 MIT） |
| `codex`（OpenAI Codex） | https://github.com/openai/codex | tag `rust-v0.163.0` | `83086188ae0614bd882818ff1aa23f3194962012` | 2026-10-15 | 2026-10-21 | **Apache-2.0**，带 `NOTICE`（见 §2.4） |
| `t3code`（T3 Code） | https://github.com/pingdotgg/t3code | `main` | `ec1313c8f8333292506f05a355bb72d308a455d8` | 2026-10-15 | 2026-10-15 | **MIT**（见 §2.5） |
| `opencode` | https://github.com/sst/opencode（现为 anomalyco/opencode） | tag `v1.19.3` | `e3c4eb242585dcd77be1a867391b7c25fd47ce52` | 2026-10-16 | 2026-10-17 | **MIT**（见 §2.6） |
| `idb`（facebook/idb） | https://github.com/facebook/idb | `main` | `14baeffc8f681380527c400a8184512b746ee918` | 2026-10-23 | 2026-10-24 | **MIT**（见 §2.7） |

补充：

- dsh 不再作为依赖或引擎使用：Wevir 的运行时以 Codex 为底，吸收了 dsh 的长处；这份只读克隆只留作设计参考，不移植源码。锁定提交是 tag `dsh-v0.2.1-alpha.2` 指向的提交。
- codex 锁定的是 release tag `rust-v0.163.0` 指向的提交（2026-10-21 时的最新稳定 release；此前是 `rust-v0.162.1` / `092d3ac`），与 `scripts/fetch-codex.sh` 下载的二进制同一版本，源码与运行的程序一致。§4 登记的移植来源文件在两个提交之间没有改动，文件头与 `NOTICE` 的来源提交仍写 `092d3ac`。Codex 的 release 提交不在任何分支上（`rust-v0.163.0` 与 `main` 分叉：2026-10-21 领先 5 个版本号提交，落后 282 个），所以 lock 的“分支”一栏写 tag，`upstream-sync.sh` 的回退路径按 tag 浅拉取。

### 1.1 作为依赖运行的 npm 包

写精确版本（ADR-0001 §1、ADR-0004 §2）。ACP SDK 只在 `packages/adapter-acp/package.json` 声明（通用 ACP 适配器），其他适配器与测试经 `@wevir/adapter-acp` 及其子路径 `./sdk` 使用。

| npm 包 | 锁定版本 | npm `latest`（2026-10-12） | 许可证 | 说明 |
|---|---|---|---|---|
| `@agentclientprotocol/sdk` | `1.4.0` | `1.8.0` | Apache-2.0（Zed Industries） | peer `zod` 由 pnpm 自动安装为工作区里的 4.6.x |
| `@anthropic-ai/claude-agent-sdk` | `0.3.286`（2026-09-30 发布） | `0.3.300`（2026-10-15） | Anthropic 商业条款（包内 `LICENSE.md`，`© Anthropic PBC`），不是开源许可证 | 只在 `packages/adapter-claude/package.json` 声明（2026-10-15，ADR-0005 补记 14）。驱动用户自己装的 `claude`，各平台带 Claude Code 原生二进制的可选包由 `pnpm-workspace.yaml` 的 `ignoredOptionalDependencies` 跳过；peer `@modelcontextprotocol/sdk` 由 `packageExtensions` 标成可选（只用到类型），`@anthropic-ai/sdk` 与 `zod` 由 pnpm 自动安装为工作区里已有的版本（claude-event-mapping.md §1）。随安装包分发前要定能不能分发（third-party-notices.md §3.2b） |
| `@cursor/sdk` | `1.0.35`（2026-10-01 发布） | `1.2.0`（2026-10-27；`zod` 移到 `peerDependencies`，升级时要自己钉住 `zod`，现在的闭包里是 3.25.76） | **非开源**：`SEE LICENSE IN LICENSE.md`，`© Anysphere Inc. All rights reserved. Use is subject to Cursor's Terms of Service.` | 订阅来源 Cursor 的引擎（ADR-0005 补记 14），只在 `packages/adapter-cursor` 声明，与 T3 Code 锁定的版本相同（§2.5）；`packages/adapter-cursor/src/sdk.ts` 的 `CURSOR_SDK_VERSION` 与之相同（测试核对）。依赖 `zod@3`、`@bufbuild/protobuf`、`@connectrpc/connect(-web)`、`@statsig/js-client`；平台包 `@cursor/sdk-<平台>`（`cursorsandbox`、`rg`、tree-sitter 的原生模块）没有安装脚本。Wevir 不复制它的代码，作为依赖安装运行；随安装包分发前要按它的条款核对能否再分发（cursor-event-mapping.md §1） |
| `yauzl` | `3.4.0` | `3.4.0` | MIT（Josh Wolfe），唯一依赖 `pend@1.2.0` 也是 MIT | 解开下载的 Antigravity 运行体压缩包（`packages/adapter-antigravity/src/zip.ts`），与 T3 Code 用的相同；Host 的 `packages/host/src/plugin-install.ts` 用它解开插件包与 Skills 的 ZIP；桌面主进程的 `apps/desktop/src/main/plugin-source.ts`（插件页，0.42.0）只读 ZIP 的目录与清单，判断“添加”的来源是插件包还是 Skills（桌面端的 devDependency，随 electron-vite 打进主进程）；类型 `@types/yauzl@3.4.0`（MIT，devDependency）。纯 JS，没有安装脚本 |
| `@opencode-ai/sdk` | `1.18.34`（2026-09-30 发布） | `1.19.5`（2026-10-28） | MIT（包里没有 LICENSE 文件；源码在 [anomalyco/opencode](https://github.com/anomalyco/opencode)，`Copyright (c) 2025 opencode`） | 订阅来源 OpenCode 的引擎（ADR-0005 补记 14），只在 `packages/adapter-opencode` 声明，只用 `v2/client` 入口（`opencode serve` 的 HTTP 客户端，T3 Code 声明的是 `^1.3.15`）；`packages/adapter-opencode/src/sdk.ts` 的 `OPENCODE_SDK_VERSION` 与之相同（测试核对）。唯一的依赖 `cross-spawn` 7.0.6（MIT）工作区里本来就有，只有 SDK 的 `server` 入口用它，Wevir 不用。引擎是用户自己装的 `opencode`（`opencode-ai` 1.x，MIT），Wevir 不带它（opencode-event-mapping.md §1） |

| `vscode-languageserver-protocol` | `3.18.4`（2026-09-25 发布） | `3.18.4`（2026-10-17） | MIT，`Copyright (c) Microsoft Corporation`；依赖 `vscode-jsonrpc@9.0.3` 与 `vscode-languageserver-types@3.18.4`（同为 MIT、Microsoft），都没有安装脚本 | 代码智能（domain-model §3.15.5）：Host 与语言服务器之间的 LSP 连接（`packages/host/src/lsp/client.ts`）与协议类型，只在 `packages/host/package.json` 声明 |

### 1.2 作为二进制运行的上游程序

R2（2026-10-14）起产品开始用它：`packages/adapter-codex` 以子进程运行 `codex-app-server`（ADR-0005 决策 1，codex-event-mapping.md）。开发环境用 `scripts/fetch-codex.sh` 下载到仓库的开发缓存，或用 `WEVIR_CODEX_BIN` 指定；安装包内置的那份由 `pnpm --filter @wevir/desktop resources` 用同一个脚本（`--target`、`--out`）放进 `apps/desktop/resources/engines/codex/`，运行时经 `WEVIR_RESOURCES_DIR` 找到（R9，ADR-0007 决策 5）。两处都是上游 Codex 的包布局（`codex-rs/install-context`、`scripts/codex_package/layout.py`）：`bin/` 放 `codex-app-server` 与 `codex-code-mode-host`，`codex-path/` 放 ripgrep，Linux 另有 `codex-resources/bwrap`，根上有 `codex-package.json`。Codex 凭二进制在 `bin/` 下且上一级有这个文件认出包，把 `codex-path/` 放到模型所跑命令的 PATH 最前面（只在 Unix 上，Windows 由 adapter-codex 的 `buildCodexEnv` 补）。版本必须与 adapter-codex 的 `CODEX_VERSION` 一致，启动前用 `--version` 核对。

| 程序 | 版本 | 来源 | 校验 | 用处 |
|---|---|---|---|---|
| `codex-app-server`（独立二进制） | `rust-v0.163.0` | GitHub Release 资产 `codex-app-server-<target>.tar.gz`（Windows 是 `codex-app-server-<target>.exe.tar.gz`） | 6 个平台（macOS arm64 / x64、Linux musl x64 / arm64、Windows x64 / arm64）的 sha256 写在 `scripts/fetch-codex.sh`，取自 GitHub API 的 `digest` | `packages/adapter-codex`：下载到 gitignore 的 `.wevir-dev/codex/bin/`，CI 按脚本内容缓存；安装包的资源目录 `apps/desktop/resources/engines/codex/`；`spikes/codex-app-server` 仍用它自己的 `scripts/fetch-binary.sh`（下载到 `.bin/`，只有 4 个平台） |
| `codex-code-mode-host`（独立二进制） | `rust-v0.163.0` | 同一 release 的 `codex-code-mode-host-<target>.tar.gz`（Windows 是 `.exe.tar.gz`） | 6 个 sha256 同样写在 `scripts/fetch-codex.sh` | 放在 `bin/` 里 `codex-app-server` 旁边：code mode 的 `exec` 在这个独立进程里跑，codex-app-server 在自己所在目录找它（`codex-rs/install-context/src/lib.rs` 的 `code_mode_host_program`）；没有它时只给 code mode 的模型（ChatGPT 模型目录的 `tool_mode`）调不了任何工具 |
| `bwrap`（Linux） | `rust-v0.163.0` | 同一 release 的 `bwrap-<target>.tar.gz`（只有两个 Linux musl 目标，0.2 MiB） | 两个 sha256 同样写在 `scripts/fetch-codex.sh` | Linux 上放在包根的 `codex-resources/bwrap`：`PATH` 上没有 `bwrap` 时 Codex 用它（§2.4）；Linux 还没实测，是否保留由 ADR-0005 未决事项 4 定 |
| `rg`（ripgrep，Windows 是 `rg.exe`） | `15.2.0` | BurntSushi/ripgrep 的 GitHub Release：`ripgrep-15.2.0-<target>.tar.gz`（Windows 是 `.zip`；Linux arm64 用 `aarch64-unknown-linux-gnu`，ripgrep 没有 arm64 的 musl 构建），版本与 sha256 抄自 Codex 锁定提交的 `scripts/codex_package/rg`（DotSlash 清单） | 6 个 sha256 写在 `scripts/fetch-codex.sh`（2026-10-26 逐个下载核对过） | 放在包根的 `codex-path/`：Codex 官方包也带它，模型被教着先用 `rg` 搜索（`prompts/base.md`），用户机器上多半没装；MIT / Unlicense 双许可，`Copyright (c) 2015 Andrew Gallant`，许可证全文在 `apps/desktop/licenses/ripgrep/`，准备资源目录时复制到包里的 `ripgrep/`（third-party-notices.md §2.4） |
| Antigravity ACP 运行体（`agy_acp_server.par` 加 `localharness_external`，Windows 是 `.exe`） | `1.3.0` | Google 的 `https://dl.google.com/agy-extensions/releases/<平台>/agy-acp-server-1.3.0-<平台>-<架构>.zip`，地址取自 ACP Registry（`agentclientprotocol/registry` 提交 `dc55a34900fdd60e5e97c1cbd7825c5a1df673fc` 的 `antigravity-acp/agent.json`），与 T3 Code 钉的相同 | 6 个平台的 sha256、压缩包与两个文件的字节数写在 `packages/adapter-antigravity/src/release.ts`（T3 于 2026-10-05 核对）；解包时逐项核对条目名、类型与大小，再启动它核对 `initialize` | 订阅来源 Antigravity 的引擎（ADR-0005 补记 14）。**不随安装包分发**：用户在设置里点下载时由 Host 从 Google 下载到 `<数据目录>/engines/antigravity/runtime/`（`WEVIR_ANTIGRAVITY_MIRROR` 可替换 `https://dl.google.com` 前缀），或用户用 `account.setPath` 指定自己装的。Google 的软件，许可条款以 Google 的为准、不是开源许可证（能否再分发待维护者核对），Wevir 不复制它的代码（antigravity-event-mapping.md §2） |

同一个 release 还有 `codex-app-server-package-<target>.tar.gz`（压缩后大 20–40 MiB），没有用；Linux 的 `bwrap` 单独取（上表），Windows 的沙箱附带程序（`codex-windows-sandbox-setup` / `-service`）是否要随包等 Windows 实测后定（ADR-0007 未决事项 1）。

两者在 `pnpm-lock.yaml` 里的完整依赖闭包、构建脚本放行（`pnpm-workspace.yaml` 的 `allowBuilds`）与许可证见 §2.1。
- OpenWork 锁定提交比最新 release `v0.18.57` 超前 121 个提交；Paseo `main` 与 tag `v0.11.2` 已分叉（领先 51、落后 3，release 在单独的分支上打）。两者只作参考，不追 release。
- GitHub API 把 OpenWork 和 Paseo 的许可证都识别为 `NOASSERTION`：两份根 `LICENSE` 都在标准文本前加了一段适用范围说明，GitHub 的识别器因此认不出。实际条款以下面的原文为准。

## 2. 许可证核实

路径均相对于 Wevir 仓库根目录；每个原文也附了锁定提交下的 GitHub 永久链接。

### 2.1 DeepSeek Harness：MIT

| 原文 | 内容 |
|---|---|
| [`upstream/deepseek-harness/LICENSE`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/LICENSE) | 标准 MIT，`Copyright (c) 2026 DeepSeek` |
| [`upstream/deepseek-harness/THIRD_PARTY_NOTICES.md`](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/THIRD_PARTY_NOTICES.md) | 由 `scripts/gen-third-party-notices.ts` 生成：`vendor/` 源码、运行时与开发依赖、Python 依赖的许可证清单 |

根 `LICENSE` 之外各自带许可证的部分：

| 路径 | 许可证 |
|---|---|
| `vendor/*/LICENSE`（Cordis 及其基础库，上游提交记录在 `vendor/README.md`） | MIT，各自的版权人 |
| `packages/boot/hmr/LICENSE` | MIT，`Copyright (c) 2021-present Shigma` |
| `native/system/**`（`@deepseek-ai/node-addon-system`） | BSD-3-Clause，`node-addon-landlock-run contributors` |
| `packages/experimental/inspector/assets/devtools/LICENSE` | BSD-3-Clause（Chromium DevTools frontend） |
| `packages/client/ui-sidebar-documentpreview/licenses/FortuneSheet.txt` | MIT，`Suzhou Ruilisi Technology Co., Ltd` |

结论与义务：

- Wevir **不依赖也不分发 dsh，不移植它的源码**（只作设计参考，见 §1 补充）。这一节的许可证原文留作参考。
- 万一需要移植 dsh 源码，按 MIT 处理（见 §5）；碰到上表子目录时，按该目录自己的许可证处理。

### 2.2 OpenWork：`ee/` 之外 MIT，`ee/` 禁止参考和移植

| 原文 | 内容与适用范围 |
|---|---|
| [`upstream/openwork/LICENSE`](https://github.com/different-ai/openwork/blob/ad22cdc2217370f28f24f0f8758016c2921e3c73/LICENSE) | 根许可证。开头的适用范围说明：`/ee` 目录下的全部内容适用 `ee/LICENSE`（EE License）；并入的第三方组件保留原许可证；**其余内容适用 MIT**。下面附 MIT 全文，`Copyright (c) 2026 Different AI` |
| [`upstream/openwork/LICENSES/MIT.txt`](https://github.com/different-ai/openwork/blob/ad22cdc2217370f28f24f0f8758016c2921e3c73/LICENSES/MIT.txt) | REUSE 规范的 MIT 全文，`Copyright (c) 2026-present Different AI, Inc.` |
| [`upstream/openwork/LICENSES/LicenseRef-OpenWork-EE.txt`](https://github.com/different-ai/openwork/blob/ad22cdc2217370f28f24f0f8758016c2921e3c73/LICENSES/LicenseRef-OpenWork-EE.txt) | EE License 全文，与 `ee/LICENSE` 逐字节相同 |
| [`upstream/openwork/ee/LICENSE`](https://github.com/different-ai/openwork/blob/ad22cdc2217370f28f24f0f8758016c2921e3c73/ee/LICENSE) | OpenWork Enterprise Edition License：生产使用需订阅（5 人以内、30 天评估、开发测试除外）；**禁止复制、合并、发布、分发、再许可、销售**；对其做的修改归 Different AI 所有；每个版本公开两年后才转为 MIT；早于 EE License 的版本仍适用 FSL-1.1-MIT |
| [`upstream/openwork/REUSE.toml`](https://github.com/different-ai/openwork/blob/ad22cdc2217370f28f24f0f8758016c2921e3c73/REUSE.toml) | 机读映射：`**` → `MIT`，`ee/**` → `LicenseRef-OpenWork-EE` |

`ee/` 包含 `ee/apps/*`（den-api、den-web、gateway、workbot、headless-runner、landing 等）和 `ee/packages/*`（den-db、telemetry、telemetry-contracts、cloud-runtime、headless-protocol 等），npm 包名都在 `@openwork-ee/` 下。

**可以按 MIT 参考与移植的目录：`ee/` 以外的全部目录。** 与 Wevir 相关的主要是 `apps/app`、`apps/desktop`、`apps/server`、`apps/review`、`packages/*`、`docs/`。注意事项：

- **`ee/` 整体排除**，包括 EE License 里“客户端 JS/CSS/图片按 MIT 授权”的条款也不用：仓库规则（AGENTS.md §3）规定 `ee/` 既不参考也不移植，省掉逐文件判断。
- **MIT 区域里也有对 `ee/` 的依赖**，移植时不能连带引入：
  - `apps/app/package.json` 依赖 `@openwork-ee/telemetry-contracts`，`apps/app/src/app/lib/models-task-analytics.ts` 引用了它；
  - `packages/freestyle/src/`、`packages/sdk/script/generate.mjs` 的构建脚本引用了 `@openwork-ee/*`。
- `packages/codemode` 派生自 `anomalyco/opencode` 的 codemode（MIT，`Copyright (c) the opencode contributors`，上游提交 `38e10eb`），见 `packages/codemode/NOTICE`。从这里移植时，OpenWork 和 opencode 的版权声明都要保留。
- MIT 只授权著作权，不授权商标。`OpenWork` 名称与 logo（如 `openwork-logo-transparent.svg`）不随代码移植。
- `legal/` 里是 OpenWork 的贡献者许可协议（CLA），与移植无关。

T0.5 复核（openwork-notes.md §7）确认以上结论成立，并补充三点：

1. **MIT 区域里有未署名的第三方派生内容**。移植时要另外保留原始版权声明，或者直接从原始来源获取：
   - `apps/app/src/styles/colors.css`：Radix Colors 生成的数值（MIT，© WorkOS）。Wevir 改为直接依赖 `@radix-ui/colors`（U1 起换成手写的「静器」原始色，不再使用 Radix Colors，见 desktop-tokens.md）。
   - `apps/app/src/components/ui/*`：shadcn CLI 生成的组件（MIT，© shadcn）。Wevir 用 shadcn CLI 自己生成，不从 OpenWork 拷贝。
   - `apps/app/src/components/ui/{message,chain-of-thought,source,tool,image}.tsx`：导出 API 与 prompt-kit（MIT）一致，文件里没写来源；`apps/app/components.json` 还配置了 `@ai-elements` registry（Apache-2.0）。出处无法从文件本身确认，**一律只参考、不移植**。
   - `apps/app/src/components/markdown/markdown-math.ts:6`：注释称数学公式分隔规则与上游 opencode web（MIT）相同，移植时保留这条注释。
2. **npm 依赖中的非 MIT 许可证**（2026-10-12 `npm view` 核对）：`@pierre/diffs` 1.3.5、`@pierre/trees` 1.0.0-beta.6、`ai` 6.x 为 Apache-2.0；`dompurify` 3.x 为 `(MPL-2.0 OR Apache-2.0)`；`@paper-design/shaders` 0.0.72 的 package.json 只写“SEE LICENSE IN …”，tarball 内 LICENSE 为 MIT（© Lost Coast Labs），后续版本须重新核对。Wevir 引入这些依赖时由 T6.3 汇总进第三方声明。（T6.3：其中只有 `dompurify` 被 Wevir 引入，按 Apache-2.0 使用；Wevir 全部会分发的依赖汇总在 [third-party-notices.md](./third-party-notices.md) §2。）
3. **商标与网络**：`packages/ui` 的 `ProviderIcon` 运行时从 simpleicons CDN 和 Google s2 服务拉取模型厂商 logo。厂商 logo 是商标，MIT 不授权；Google 服务在大陆不可达。Wevir 不移植这一机制，只做本地缩写头像。

### 2.3 Paseo：Apache-2.0

| 原文 | 内容 |
|---|---|
| [`upstream/paseo/LICENSE`](https://github.com/getpaseo/paseo/blob/dc7bc8db124e837ba909ffd3b4b20e16adaebe24/LICENSE) | 开头的适用范围说明：`Copyright (c) 2025-present Mohamed Boudra`；第三方组件保留原许可证；**除此之外 Paseo 整体适用 Apache License 2.0**。下面附的 Apache-2.0 正文（含 Appendix）与 apache.org 的 `LICENSE-2.0.txt` 逐字一致 |

- **锁定提交下仓库里没有 `NOTICE` 文件**（`git ls-files` 中没有 NOTICE / THIRD_PARTY 类文件），也没有 SPDX 文件头。
- 自带其他许可证的子目录：
  - `packages/expo-two-way-audio/LICENSE`：MIT，`Copyright (c) 2023, Cantab Research Ltd.`（其 package.json 也声明 MIT）；
  - `packages/highlight/src/astro/LICENSE`：MIT，`Copyright (c) 2026 Zulfazli (Fazelllyyy)`；
  - `plugin-examples/modal-ui/LICENSE`：与根 `LICENSE` 相同。
- 早前调研的“Apache-2.0”结论成立；SKELETON_PLAN §1.2 的“待核实”据此更新。

移植 Paseo 代码时的义务（Apache-2.0 第 4 条起；2026-10-16 起有移植的文件：OpenCode 的应用级工具插件、0.32.0 文件预览的 HTML CSP 与 0.33.0 的内置浏览器，见 §4 与根目录 `NOTICE` 第 4 节）：

1. 移植的文件**仍是 Apache-2.0**，不因进入 MIT 仓库而变成 MIT。文件头写 `SPDX-License-Identifier: Apache-2.0`，保留原有版权、专利、商标与署名声明（4(c)），没有就写上根 `LICENSE` 的 `Copyright (c) 2025-present Mohamed Boudra`。
2. 改过的文件必须**显著标明已修改**（4(b)）：文件头写“由 Wevir 修改”和修改要点。
3. 分发时**随附 Apache-2.0 全文**（4(a)），由 T6.3 汇总进第三方声明。
4. 上游以后若加了 `NOTICE` 文件，升级到那个提交后，分发物必须带上其中的署名内容（4(d)）。每次升级都要检查。
5. 不得使用 Paseo 的名称或商标，说明代码来源的用途除外（第 6 条）。
6. 第 3 条专利授权附带终止条件：对该作品发起专利诉讼的一方，其获得的专利许可随之终止。
7. 来自 `packages/expo-two-way-audio`、`packages/highlight/src/astro` 的代码按 MIT 处理，保留各自的版权声明。

### 2.4 OpenAI Codex：Apache-2.0

| 原文 | 内容 |
|---|---|
| [`upstream/codex/LICENSE`](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/LICENSE) | Apache License 2.0 全文 |
| [`upstream/codex/NOTICE`](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/NOTICE) | `OpenAI Codex`、`Copyright 2025 OpenAI`；并说明含有派生自 Ratatui 的代码（MIT，`Copyright (c) 2016-2022 Florian Dehau`、`Copyright (c) 2023-2025 The Ratatui Developers`） |

自带其他许可证的部分：

| 路径 | 许可证 | 说明 |
|---|---|---|
| `codex-rs/vendor/bubblewrap/` | LGPL-2.0-or-later（`COPYING`/`LICENSE` 为 GNU Library GPL v2） | `codex-rs/bwrap/build.rs` 把它编成单独的 `bwrap` 可执行文件，只在 Linux 包里作为 `codex-resources/bwrap` 随附（系统 `PATH` 上有 `bwrap` 时优先用系统的，`codex-rs/linux-sandbox/README.md`）。macOS 的独立 `codex-app-server` 不含它 |
| `third_party/wezterm/` | MIT，`Copyright (c) 2018-Present Wez Furlong` | |
| `codex-rs/skills/src/assets/samples/*/LICENSE.txt` | Apache-2.0 | Codex 首次启动时写进 `CODEX_HOME/skills/.system` 的内置 skill 样例 |

结论与义务：

- R2 移植了四份提示词文本（§4 的 `prompts/*.md`，ADR-0005 补记 2）；P1（0.41.0）另改写 skills 解析 / 扫描与插件配置协议，逐文件登记在 §4。它们按 Apache-2.0 第 4 条处理：文件头写明来源、版权与修改（4(b)、4(c)），根目录 `NOTICE` 收录 Codex `NOTICE` 中与之相关的署名（`OpenAI Codex`、`Copyright 2025 OpenAI`）与 Apache License 2.0 全文（4(a)、4(d)）；Ratatui 那一条只涉及 TUI 代码，与这些文件无关，不收录。随安装包分发 `codex-app-server` 二进制时，按 Apache-2.0 第 4 条随附 `LICENSE` 全文与 `NOTICE` 的署名内容（4(a)、4(d)）：R9 起两份文件取自锁定提交、放在 `apps/desktop/licenses/codex/`，准备资源目录时复制到二进制旁边，第三方声明见 [third-party-notices.md](./third-party-notices.md) §2.5。Linux 包带上 `bwrap`（R9 的默认做法，§1.2），另按 LGPL-2.0 提供其源码获取方式（锁定提交的 `codex-rs/vendor/bubblewrap/`）。
- 二进制里静态链接的 Rust crate 闭包（`codex-rs/Cargo.lock`）的许可证在打包前另做一次核对，方法同 §2.1 对 npm 闭包的做法。
- 不得使用 OpenAI 或 Codex 的名称与商标，说明来源的用途除外（Apache-2.0 第 6 条）。

### 2.5 T3 Code：MIT

| 原文 | 内容 |
|---|---|
| [`upstream/t3code/LICENSE`](https://github.com/pingdotgg/t3code/blob/ec1313c8f8333292506f05a355bb72d308a455d8/LICENSE) | 标准 MIT，`Copyright (c) 2026 T3 Tools Inc.` |

结论与义务：移植了“变更”窗格与回合快照（0.20.0）、接力（0.25.0）、计划卡片（0.36.0）、会话目标（0.35.0）、应用级工具（0.30.0）和 Claude Agent、Cursor、OpenCode、Antigravity 引擎的文件（§4）。按 MIT 在文件头保留版权与许可证（§5 的格式），根目录 `NOTICE` 第 10 节列出文件并收录许可证全文。“变更”窗格依赖的 `@pierre/diffs`（Apache-2.0）是 npm 包，不是从 T3 拷贝的，见 `NOTICE` 第 11 节与 ADR-0004 补记 10；T3 给它打的搜索补丁没有用。T3 Code 自己依赖的 `@anthropic-ai/claude-agent-sdk` 是 Anthropic 的商业条款，Wevir 作为 npm 依赖另行声明（§1.1），不从 T3 拷贝。T3 的仓库里还 vendored 了别的项目（`.repos/` 等），Wevir 没有参考。
- 移植的是 `packages/provider-cursor/src/server/` 下的源码（§4），T3 用 Effect 写，Wevir 改写成普通 TS，不引入 `effect`。义务同 MIT：保留版权与许可声明（各文件头与根目录 `NOTICE` 第 10 节）。
- T3 依赖的 `@cursor/sdk` 不是 T3 的代码，许可证另见 §1.1。
- OpenCode 引擎移植的是 `packages/provider-opencode/src/server/` 下 1.x 那一套（§4），同样改写成普通 TS；`v2/` 下的 OpenCode 2 适配器没有移植。T3 依赖的 `@opencode-ai/sdk` 是 opencode 的 MIT 包，Wevir 作为 npm 依赖另行声明（§1.1）。
- Grok 引擎移植的是 `packages/provider-grok/src/server/` 与 `packages/provider-acp/src/server/` 的两处（§4），同样改写成普通 TS；另原样复制了 T3 录的 7 个 Grok ACP 样本作测试数据（§4.1）。T3 不依赖、Wevir 也不声明 Grok 的 npm 包 `@xai-official/grok`：用户自己装的 CLI，只启动它。
- Antigravity 引擎移植自 `apps/server/src/provider/`（安装、登录、profile、ACP 约定）与 `orchestration-v2/Adapters/AntigravityAdapterV2.ts`（§4），同样改写成普通 TS；`packages/adapter-antigravity/src/test-fixtures/acp-samples.ts` 的样本取自 T3 测试里的 Antigravity 样本。Google 的 Antigravity 运行体不是 T3 的代码，见 §1.2。

### 2.6 opencode：MIT

| 原文 | 内容 |
|---|---|
| [`upstream/opencode/LICENSE`](https://github.com/sst/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/LICENSE) | 标准 MIT，`Copyright (c) 2025 opencode` |

结论与义务：代码智能（domain-model §3.15.5）改写了 v1.19.3 的 `packages/opencode/src/lsp/` 与 `src/tool/lsp.ts`（§4）。opencode 的 `dev` 分支后来去掉了这套实现（2026-10 的重构），所以锁定的是还带着它的最后一个 tag v1.19.3，不追 `dev`。按 MIT 在文件头保留版权与许可证，根目录 `NOTICE` 第 12 节列出文件。opencode 的 Effect 写法没有搬，Wevir 不引入 `effect`。

### 2.7 idb：MIT

| 原文 | 内容 |
|---|---|
| [`upstream/idb/LICENSE`](https://github.com/facebook/idb/blob/14baeffc8f681380527c400a8184512b746ee918/LICENSE) | 标准 MIT，`Copyright (c) Meta Platforms, Inc. and affiliates.` |

结论与义务：iOS 模拟器的 helper（`apps/desktop/native/ios-simulator`）移植了 FBSimulatorControl 里取帧、HID（Indigo、DTUHID、Purple）、XPC、方向读取与 H.264 编码的部分，FBSimulatorAX 的翻译器委托，FBControlCore 的几个小工具，以及 idb 声明私有框架用的头文件与 TBD 桩（§4）。移植的是源码子集，不链接 idb 的静态库，不带 gRPC 与 companion。按 MIT 在文件头保留版权与许可证；`LICENSE-facebook-idb.txt` 放在 helper 的包里，并随安装包放在 helper 旁边（`resources/ios-simulator/`）；根目录 `NOTICE` 第 17 节列出文件。

## 3. 各仓库的参考重点

与 SKELETON_PLAN §3 保持一致，以下路径在锁定提交下均已确认存在。

- **dsh**（只读参考，不移植）：`docs/architecture.zh.md`、`docs/agent-lifecycle.zh.md`、`docs/capability-seams.zh.md`、`packages/acp/acp/README.zh.md`、`packages/sdk/{client,protocol,server}/README.zh.md`、`docs/user/guide/providers.md`。
- **OpenWork**（桌面产品与交互参考，仅 MIT 区域）：`apps/app`（React + Vite + Tailwind v4 主界面）、`apps/desktop`（Electron 壳）、`apps/server`、`packages/ui`、`packages/sdk`、`packages/types`、`docs/architecture`。**`ee/` 排除**。
- **Paseo**（多端与远程架构参考；0.32.0 起移植了 HTML 预览的 CSP，`packages/host/src/html-preview-csp.ts`；0.33.0 起移植了浏览器自动化与浏览器工具）：`packages/server`（daemon）、`packages/protocol`（`@getpaseo/protocol`）、`packages/client`、`packages/relay`、`packages/app`（Expo）、`packages/desktop`、`packages/cli`、`public-docs/sdk`。
- **T3 Code**（订阅来源的做法，移植代码，补记 14）：`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`（Claude 引擎的主体）、`apps/server/src/provider/ClaudeProvider.ts`、`ClaudeModelCatalog.ts`、`ClaudeModelManifest.ts`、`model-manifest.json`、`claudeUsageLimits.ts`、`Drivers/ClaudeExecutable.ts`、`Drivers/ClaudeHome.ts`、`apps/server/src/claudeModelOptions.ts`、`apps/server/src/textGeneration/ClaudeTextGeneration.ts`。T3 的服务端是 Effect 写的，移植时改写成普通 TS，不引入 `effect`。 Antigravity：`apps/server/src/provider/antigravityRelease.ts`、`AntigravityInstallation.ts`、`antigravityAuthSupport.ts`、`AntigravityAuth.ts`、`AntigravityProvider.ts`、`Drivers/AntigravityDriver.ts`、`Drivers/AntigravitySkills.ts`、`acp/AntigravityProtocol.ts`、`acp/AntigravityAcpSupport.ts`、`acp/AntigravitySessionFiles.ts`、`apps/server/src/zipArchive.ts`、`apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts`，以及 `docs/user/providers-antigravity.md`。
- **Codex**（Agent 运行时候选，作为二进制运行，读协议与源码，不移植）：`codex-rs/app-server/README.md` 与 `codex-rs/app-server-protocol/`（`schema/typescript/`、`schema/json/` 是这个版本生成的协议类型）、`codex-rs/model-provider-info/`（`[model_providers]` 配置）、`codex-rs/codex-api/src/sse/responses.rs`（解析模型流的事件）、`codex-rs/core/tests/common/responses.rs`（Responses SSE 的测试帮手）、`codex-rs/models-manager/`（模型目录）、`codex-rs/config/`（配置键）、`codex-rs/linux-sandbox/README.md`、`codex-rs/mxc-sandbox/README.md`。研读结论见 docs/research/codex-notes.md。
- **T3 Code**（接力，维护者 2026-10-15 定照 T3 做）：`apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.ts`（何时接力：不能接着用原生会话或 driver 不同时 `create_with_handoff`；Wevir 跨 Provider 一律接力，不做同一 driver 的 `restart_and_resume`，domain-model §3.14）、`ContextHandoffService.ts`、`ContextHandoffDelivery.ts`、`packages/provider-core/src/server/handoffBudget.ts`、`docs/internals/context-handoffs.md`；读历史的工具参考了 `apps/server/src/mcp/toolkits/orchestrator/tools.ts` 的 `t3_thread_read`（只取作用，不移植代码）。
- **T3 Code**（diff 右栏与回合快照，维护者 2026-10-15 定照搬）：`apps/web/src/components/DiffPanel.tsx`、`apps/web/src/components/diffs/`、`apps/web/src/components/DiffWorkerPoolProvider.tsx`、`apps/web/src/lib/diffRendering.ts`、`apps/server/src/vcs/GitVcsDriver.ts`（captureCheckpoint 等）、`apps/server/src/vcs/GitVcsDriverCore.ts`（未提交与本分支的 diff）、`apps/server/src/orchestration-v2/CheckpointService.ts`。订阅来源的设计另见 ADR-0005 补记 14。

- **opencode**（代码智能，维护者 2026-10-17 定）：`packages/opencode/src/lsp/client.ts`（连接、文档同步、推送与拉取的诊断）、`lsp.ts`（按扩展名与项目根找服务器、起动中的复用）、`server.ts`（各语言服务器的查找与项目根）、`language.ts`、`diagnostic.ts`、`src/tool/lsp.ts` 与 `lsp.txt`（工具）；`packages/web/src/content/docs/lsp.mdx` 与 `tools.mdx`（文档）。

- **idb**（iOS 模拟器，维护者 2026-10-24 定）：`FBSimulatorControl/Framebuffer/`（主屏的 IOSurface 与帧回调）、`FBSimulatorControl/HID/`（Indigo 与 dtuhidd 两种传输及按 CoreSimulator 版本的选择）、`FBSimulatorControl/XPC/`、`FBSimulatorControl/CoreDevice/SimulatorOrientationProtocol.swift`、`FBSimulatorVideo/Encoding/`、`FBSimulatorAX/Translation/`、`PrivateHeaders/`；对照了 `Tools/SimScope/`（键位表）与 `FBSimulatorServices/Commands/SimulatorPreferencesCommands.swift`（慢动画、键盘的做法）。

## 4. 移植登记表

每移植一个文件（含大幅改写后仍可辨认出来源的文件）登记一行。“来源提交”写完整 SHA。

P3 的 `packages/host/src/plugin-app-tools.ts` 是 Wevir 自己的应用工具与审批衔接，复用下表的 P1/P1a 解析、清单与安装实现，没有新增上游代码移植；没有移植 T3 的 `$` 输入菜单。

插件 P1（0.41.0）与 P1a（0.42.0）新增的 Codex 格式 / 协议改写如下，均为 Apache-2.0，Copyright 2025 OpenAI；未修改 upstream，未参考 OpenWork ee，没有移植 T3 的 `$` 输入菜单。

| Wevir 文件 | 来源路径（openai/codex） | 来源提交 | 许可证 | 修改说明 |
|---|---|---|---|---|
| `packages/host/src/plugin-skills.ts` | `codex-rs/skills/src/parser.rs`、`ext/skills/src/loader/{mod,discovery}.rs` | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | Apache-2.0 | Rust 改为 TS / yaml；frontmatter、标量修复、Unicode 长度、6 层 / 2000 目录；optional agents/openai.yaml 原样保留给引擎解释 |
| `packages/host/src/plugin-install.ts` | `codex-rs/core-plugins/src/manifest.rs` | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | Apache-2.0 | 只读本地 Codex / Claude 清单，skills / mcpServers 展开成 Host 实体；有界复制 / 解压与拒绝链接由 Wevir 实现，不运行 hooks / 脚本 |
| `packages/adapter-codex/src/plugins.ts` | `codex-rs/config/src/{mcp_types,skills_config}.rs`、`app-server-protocol/src/protocol/v2/{plugin,mcp,config}.rs` | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | Apache-2.0 | 取配置子集生成 TOML / 热更新；禁用 Host 未启用的 skills；MCP 分页状态只投影状态与工具元数据 |
| `packages/protocol/src/plugins.ts` | `codex-rs/config/src/mcp_types.rs`；0.42.0 起另取 `core-plugins/src/manifest.rs` 的清单字段名 | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | Apache-2.0 | Wevir 判别联合与配置子集；camelCase；密钥写入和脱敏结果分开；`wevir-plugin.json` 沿用 name、version、description、skills（默认 ./skills）与 `./` 路径规则，mcpServers 换成 connectors，另加 schemaVersion、id、icon、inputs |
| `packages/host/src/plugin-packages.ts` | `codex-rs/core-plugins/src/manifest.rs`、`codex-rs/codex-mcp/src/agent_plugin_config.rs` | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | Apache-2.0 | 插件 P1a（0.42.0）：Codex / Claude 包导入成 Wevir 插件，清单元数据与 interface（displayName、developerName、websiteURL、logo）映射到 Plugin，`${PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}` 换成 `${pluginDir}`，hooks、commands、agents、apps 等列为已忽略 |
| `packages/host/src/mcp-oauth/www-authenticate.ts` | `codex-rs/rmcp-client/src/www_authenticate.rs` | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | Apache-2.0 | 远程 MCP 的 OAuth（0.97.0）：Rust 改为 TS；按 RFC 9110 切分挑战与解引号的规则照原文，不只认 `insufficient_scope`，返回 Bearer 挑战的 `resource_metadata`、`scope`、`error` |
| `packages/host/src/mcp-oauth/client.ts` | `codex-rs/rmcp-client/src/oauth_callback.rs`（`callback_id_from_server_url`） | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | Apache-2.0 | 只有按服务器区分的回调路径段（服务器地址的 SHA-256 前 9 字节，base64url）取自原文；注册、换令牌、刷新、撤销与 PKCE 是 Wevir 按 RFC 7591 / 6749 / 7009 / 7636 写的 |

| Wevir 文件 | 来源路径 | 来源提交 | 许可证 | 修改说明 |
|---|---|---|---|---|
| `packages/client-sdk/src/lifecycle.ts` | OpenWork `apps/app/src/react-app/domains/session/sync/sync-stream-lifecycle.ts` | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | MIT | 改写（T4.1，OpenWork 候选 #1）：从事件流 SSE 的重连改为 Host 连接（建立传输 + `host.hello`）的重连状态机。保留两套指数退避（普通 1 s → 10 s、鉴权类 5 s → 60 s）、单一重试计时器、换代时重置退避并立即重连、换代前发起的尝试报的鉴权失败按普通失败处理；阶段改为 connecting / connected / reconnecting / closed，新增不可恢复的失败与首次连接失败即关闭；静默看门狗移到每条连接上（`rpc-channel.ts` 的心跳超时）；去掉诊断历史 |
| `apps/desktop/src/renderer/src/theme/theme.ts` | OpenWork `apps/app/src/app/theme.ts` | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | MIT | 移植（T5.2，OpenWork 候选 #17），修掉两处问题：首帧前脚本只读旧 key（Wevir 的 `public/theme-init.js` 与运行时共用 `shared/theme.ts` 的 `THEME_STORAGE_KEY`，测试核对）；暗色同时认 `.dark` 类（只写 `data-theme`，CSS 的暗色变体也只认它，`color-scheme` 由 tokens.css 设置）。另外去掉旧 key 迁移，nativeTheme 经 preload 的 `setThemeSource` 同步，加 `useTheme` |
| `apps/desktop/src/renderer/public/theme-init.js` | OpenWork `apps/app/index.html` 第 19–32 行的内联脚本 | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | MIT | 移植（T5.2，候选 #17 的首帧前脚本；T6.3 补上文件头与本行，此前只在上一行的来源里提到）：改为单独的普通脚本文件（生产 CSP 不放行内联脚本）；存储 key 换成 `THEME_STORAGE_KEY`；不认识的值按跟随系统处理，与 `theme.ts` 一致（`shared/theme.test.ts` 在 `node:vm` 里核对）；只写 `data-theme`，不写内联 `color-scheme` |
| `apps/desktop/src/renderer/src/session/markdown/markdown.ts` | OpenWork `apps/app/src/components/markdown/markdown-primitive.ts` | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | MIT | 改写（T5.3，OpenWork 候选 #4）：保留 `createStreamingMarkdownRenderer`（流式时只重新 lex 末尾 2 个块、已定的块复用同一个 `{__html}`、有引用式链接定义时整篇重来）与 DOMPurify 清洗；去掉 emoji、KaTeX、Mermaid、会话引用、favicon、视频与图片预览、Shiki。渲染器输出几乎不带类名的语义 HTML（样式在 `styles/markdown.css`），表格对齐用 `align` 属性、图片只显示为链接（CSP 不放行内联样式与外部图片），原文 HTML 按文本显示；高亮另在 `highlight.ts` 用 highlight.js 做（ADR-0004 补记 6）。0.32.0 起文件窗格另用 `markdown-document.ts`（同样登记为移植自这个文件：`mermaidBlockHtml`、图片与 KaTeX 的接法）：加回 KaTeX 与 Mermaid（`markdown-math.ts`、`mermaid.ts`），会话目录里的图片输出 `<img data-file-image>`、地址向 Host 要 |
| `apps/desktop/src/renderer/src/session/scroll-controller.ts` | OpenWork `apps/app/src/react-app/domains/session/surface/scroll-controller.ts`（另参照同目录 `scroll-store.ts`、`scroll-overlay.tsx`） | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | MIT | 改写（T5.3，OpenWork 候选 #3）：保留贴底 / 手动两种模式的状态机（只有真实输入手势能切换模式、ResizeObserver 对账、`overflow-anchor` 随模式切换、键盘焦点把旧内容滚进视野时转手动、发送即回到贴底；U2 加上点开或收起消息流里的一处时转为手动、保持位置）；去掉移动端轮次留白、滚动位置与几何信息的持久化、历史分页、“跳到消息开头”，状态不进全局 store，只交出“是否贴底”给“跳到最新”按钮 |
| `apps/desktop/src/renderer/src/session/tool-model.ts` | OpenWork `apps/app/src/lib/tool-aggregate.ts`、`apps/app/src/lib/current-tool-lifecycle.ts` | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | MIT | 改写（T5.3，OpenWork 候选 #6；U2 再改）：分类从 OpenCode 工具名换成 Wevir 的展示类型（`ToolDisplay.kind`）；T5.3 只聚合读取与搜索，U2 起照 Claude Code 与 Codex 桌面端把连续的思考与全部种类的工具调用合成一个工作组（同 OpenWork 的聚合），摘要是中文计数加改动行数，进行中显示当前动作（同 OpenWork 的当前动作行），失败、被拒绝、状态未知单独计数；组内的思考按原顺序保留；“回合停止后未收尾的工具显示状态未知”照搬，另加“被拒绝” |
| `apps/desktop/src/renderer/src/session/approval-card.tsx` | OpenWork `apps/app/src/react-app/domains/session/chat/permission-approval-modal.tsx` | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | MIT | 改写（T5.3，OpenWork 候选 #9）：保留输入框上方的内联面板、一次只显示第一个、可折叠的完整参数；按钮按审批请求携带的选项渲染，内容取同一 `toolCallId` 的 `rawInput`（`ApprovalRequest.detail`），标出“还有 N 个待审批”，另一端先处理时按 `approval.resolved` 收起并提示处理者 |
| `prompts/base.md` | Codex `codex-rs/protocol/src/prompts/base_instructions/default.md` | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | Apache-2.0 | 改写（ADR-0005 补记 2）：用中文重写并重排；自我介绍改为 Wevir 与实际的底层模型；保留 AGENTS.md 规则、编辑与 git 约束、验证、审查、`update_plan` 的用法；按 Wevir 的 Codex 配置重写工具说明并补上子智能体；新增授权与确认、不可信内容、过程说明与最终回答、中文写作要求；skills、插件、MCP、联网搜索留占位。0.35.0 起加了“目标”一节：规则取自 `codex-rs/ext/goal/src/spec.rs` 的工具说明与 `ext/goal/templates/goals/continuation.md`、`budget_limit.md`（同一提交，Apache-2.0），用自己的话写（补记 20） |
| `prompts/plan-mode.md` | Codex `codex-rs/collaboration-mode-templates/templates/plan.md` | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | Apache-2.0 | 改写（ADR-0005 补记 2）：用中文重写，结构与规则不变；补充只读阶段能做与不能做的例子，最终计划的小节名改为中文，`<proposed_plan>` 标签保持原样 |
| `prompts/auto-review.md` | Codex `codex-rs/prompts/templates/guardian/policy_template.md`、`policy.md`、`node_repl_policy.md` | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | Apache-2.0 | 改写（ADR-0005 补记 2）：用中文重写并合并三份模板，默认策略写进正文，组织策略改为用户配置的可信目的地与补充规则；输入改为 Host 拼装的 `<transcript>` 与 `<planned_action>`；第一版不给复核员工具，“先做只读检查”改为“信息不足时从严”；补充国内常见的外发目的地；`rationale` 用用户的语言 |
| `prompts/thread-title.md` | Codex `codex-rs/tui/src/app/thread_title.rs`（`thread_title_instructions` 等函数里的说明文字） | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | Apache-2.0 | 改写（ADR-0005 补记 2）：用中文重写标题规则；中文与其他语言分别给长度上限；增加检索摘要字段；补充只有链接或编号、寒暄、按最近对话重新生成三种情况；示例改为中文为主 |
| `apps/desktop/src/renderer/src/session/init-prompt.ts` | Codex `codex-rs/tui/assets/prompt_for_init_command.md` | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | Apache-2.0 | 移植（U33，斜杠命令 `/init`）：英文照原文；另写中文版本（界面是中文时用），结构与要求不变 |
| `packages/host/src/git-diff.ts` | T3 Code `apps/server/src/vcs/GitVcsDriverCore.ts`、`apps/server/src/checkpointing/Diffs.ts`、`apps/server/src/vcs/GitVcsDriver.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（0.20.0）：未提交与本分支的 diff（复制索引、intent-to-add 未跟踪文件、merge-base、新的一侧读磁盘并核对 realpath）、numstat 的解析与 `a/`、`b/` 前缀的写法照 T3；改用 Node 的 child_process；屏蔽仓库配置里会执行命令的设置（含仓库定义的过滤器）；补丁按文件切开、超过上限的只列出；旧的一侧用 `cat-file blob` |
| `packages/host/src/checkpoints.ts` | T3 Code `apps/server/src/vcs/GitVcsDriver.ts`、`apps/server/src/orchestration-v2/CheckpointService.ts`、`apps/server/src/checkpointing/Diffs.ts`；落盘设置另取自 `apps/server/src/vcs/VcsProcess.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8`；落盘设置 `55ba1baa559ee73b9db177da07f56000774371f2` | MIT | 改写（0.20.0）：打快照的做法（临时索引、复用用户索引的 stat、`add -A`、`write-tree`、`commit-tree -p HEAD`、`update-ref`，嵌套仓库的排除）、listAuthoredPaths、isGitImport 照 T3；ref 改成 `refs/wevir/checkpoints/<会话>/<回合>/before|after`，统计写进提交说明，sparse checkout 不打，`--diff-merges=off`，不签名，会话关闭时删除、每个会话最多 100 个回合；快照的 git 命令带 `core.fsync=objects,reference`（macOS、Windows 用 batch），macOS 上 F_FULLFSYNC 不受支持时以 writeout-only 重试 |
| `apps/desktop/src/renderer/src/layout/panes/changes-pane.tsx` | T3 Code `apps/web/src/components/DiffPanel.tsx` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（0.20.0）：数据换成 Wevir 的协议；文件头自己画；去掉比较对象选择、忽略空白、文件树、在编辑器中打开与分批加载；加大 diff 默认折叠与省略文件的列表；Wevir 的组件与文案；0.67.0 起的行级批注只照 T3 用 Pierre 的行号按钮与选行开草稿，批注存在 Host、按原文定位，是 Wevir 的 |
| `apps/desktop/src/renderer/src/changes/styled-code-view.tsx` | T3 Code `apps/web/src/components/diffs/StyledDiffCodeView.tsx` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：样式换成 Wevir 的变量，文件头只管定位与底色；itemMetrics 照搬；0.67.0 起加回 T3 的选中行样式（行级批注用） |
| `apps/desktop/src/renderer/src/changes/diff-comment.tsx` | T3 Code `apps/web/src/components/diffs/DiffCommentAnnotation.tsx`、`apps/web/src/components/diffs/commentSubmitShortcut.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（0.67.0，行级批注）：草稿与已存批注的结构、⌘/Ctrl+Enter 保存与 Esc 取消照 T3；去掉 secondaryAction 与外部受控的草稿，加位置状态的角标，组件与文案换成 Wevir 的 |
| `packages/host/src/review/service.ts`（`fenceFor`、`fenceLanguage`） | T3 Code `apps/web/src/reviewCommentContext.ts`（`formatReviewCommentFence`、`inferReviewCommentFenceLanguage`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 移植（0.67.0）：拆成两个小函数；存储、按原文定位与发送是 Wevir 的 |
| `apps/desktop/src/renderer/src/changes/diff-worker-pool.tsx` | T3 Code `apps/web/src/components/DiffWorkerPoolProvider.tsx` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 移植：主题取自 Wevir 的 theme.ts，不用 effect，文案走 t() |
| `apps/desktop/src/renderer/src/changes/diff-rendering.ts` | T3 Code `apps/web/src/lib/diffRendering.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 移植：去掉忽略空白，表面颜色换成 Wevir 的变量 |
| `apps/desktop/src/renderer/src/changes/diff-file-contents.ts` | T3 Code `apps/web/src/lib/diffFileContents.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 移植 createDiffFileContentsLoader，请求换成 `workspace.diffFile` |
| `apps/desktop/src/renderer/src/changes/changes-model.ts` | T3 Code `apps/web/src/lib/diffCollapse.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 只有 areAllCollapsed / toggleAll 来自 T3，其余是 Wevir 的 |
| `apps/desktop/src/renderer/src/notifications/notification-model.ts`、`notification-coordinator.tsx` | T3 Code `apps/web/src/components/ThreadNotificationCoordinator.tsx`、`apps/web/src/threadNotifications.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（U31）：只照它的规则重写——前台且看着这个会话时不提醒、前台看别的会话时应用内提醒、后台时系统通知、角标数后台时发出的通知、回到前台清零；事件从 Wevir 的会话事件判断，系统通知经主进程的 Electron `Notification`（T3 用网页的 `Notification`），提示音用系统的，不带 T3 的音频文件 |
| `packages/host/src/handoff.ts` | T3 Code `apps/server/src/orchestration-v2/ContextHandoffService.ts`、`ContextHandoffDelivery.ts`、`packages/provider-core/src/server/handoffBudget.ts`、`docs/internals/context-handoffs.md` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（0.25.0，接力）：两种方式（`full_thread_summary`、`delta_since_target_last_seen`）、16 000 字节的预算、`selectHistory` 的取舍顺序、`compactText`、摘要放在消息开头的写法照 T3；历史从 Wevir 的事件库整理，每条都截到 240 字（T3 的代码只在分支合并时截），措辞与读历史的工具（`read_session_history`，作用同 `t3_thread_read`，形状是 Wevir 的，`@wevir/runtime-adapter/history-tool`）是 Wevir 的；不用 Effect |
| `packages/host/src/app-tools.ts`、`packages/host/src/app-mcp.ts` | T3 Code `apps/server/src/mcp/toolkits/orchestrator/tools.ts`、`apps/server/src/mcp/OrchestratorMcpService.ts`、`apps/server/src/mcp/McpSessionRegistry.ts`、`packages/provider-core/src/server/orchestrationInstructions.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（0.30.0，应用级工具，domain-model §3.15）：每个会话一个 bearer 令牌、只存摘要的 HTTP MCP 端点，列出、读（分页与长文本续读）、新开会话、发消息（`auto` / `queue` / `steer`）、等待（超时不打断）、停止，权限不能比调用方宽、等到的结果不再回报，照 T3；工具按 Wevir 的会话模型重写，加了请界面显示的 `wevir_show`，回报照 T3 的 delegate_task 完成通知（也是 Paseo 的 notifyOnFinish）；说明文字是 Wevir 自己的；不用 Effect，端点只用 Node 内置模块；子任务、定时任务、密钥、工作流与 worktree 移交没有搬 |
| `packages/protocol/src/browser.ts` | Paseo `packages/protocol/src/browser-automation/rpc-schemas.ts`、`capabilities.ts` | `dc7bc8db124e837ba909ffd3b4b20e16adaebe24` | Apache-2.0 | 改写（0.33.0，内置浏览器）：命令与结果的 schema 照 Paseo，去掉 evaluate、upload、resize，加上请界面显示标签页的 `show`；只做结构声明（不用 refine / transform / default，规则 6），错误码、命令名、标签页的操作方是开放字符串；请求带会话与目录，标签页加 `controller` |
| `packages/host/src/browser-broker.ts` | Paseo `packages/server/src/server/browser-tools/broker.ts`、`errors.ts` | `dc7bc8db124e837ba909ffd3b4b20e16adaebe24` | Apache-2.0 | 改写：提供方是 `browser.register` 登记的 RPC 连接，请求经 `browser.request` 通知发出、`browser.respond` 回来；选提供方、记住标签页在哪、断开后“搁浅”、`list_tabs` 合并照 Paseo；调用方取消时立即结束 |
| `packages/host/src/browser-tools.ts` | Paseo `packages/server/src/server/browser-tools/tools.ts` | `dc7bc8db124e837ba909ffd3b4b20e16adaebe24` | Apache-2.0 | 改写成 Wevir 应用级工具（`AppTool`，JSON Schema 与 MCP annotations）：去掉 browser_evaluate、browser_upload、browser_resize；只读的标 `readOnlyHint`；结果只给文本与图片、不给 `structuredContent`（Codex 有它时丢掉内容项）；说明文字是 Wevir 的 |
| `apps/desktop/src/main/browser/automation/{service,contents,snapshot-engine,aria-snapshot-script,actionability,trusted-input,cdp-session-queue,dialog-handling}.ts` 与 `service.test.ts`、`snapshot-engine.test.ts`、`trusted-input.test.ts` | Paseo `packages/desktop/src/features/browser-automation/` 下同名文件（`contents.ts` 来自 `ipc.ts`） | `dc7bc8db124e837ba909ffd3b4b20e16adaebe24` | Apache-2.0（ARIA 快照脚本由 Paseo 改编自 Playwright，Apache-2.0，署名保留） | 移植 / 改写：类型换成 Wevir 协议的；标签页按会话归属（`ownerOf`）；去掉 evaluate、upload 与标签页的开关（在 `browser-host.ts`）；截图有大小上限；控制台消息按 Electron 35 起的事件对象读；页面里的全局名改成 Wevir 的；`trusted-input` 只重排格式；0.46.0 起对话框整个生命期都记（标签页 `disableDialogs`）、prompt 替身装进每个新文档、网络记录改用 CDP Network 域、快照分段并包含同源 iframe、`actionability` 换算 iframe 坐标、`cdp-session-queue` 前一个命令最多挡 10 s（文件头写明）；0.48.0 把 Paseo 的 evaluate（`buildEvaluateScript` 改为不用 eval、在页面里序列化）与 upload（`DOM.setFileInputFiles`，加会话文件夹的核对）搬回 `service.ts`，加 query、network、dialogs、按 frame 执行与等待条件；`frames.ts`、`network.ts` 与 `browser/downloads.ts` 是 Wevir 自己写的 |
| `apps/desktop/src/shared/browser-tabs.ts` | OpenWork `packages/browser-tabs/index.mjs`（`@openwork/browser-tabs`） | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | MIT | 改写成 TypeScript：标签页按会话归属、能不能上屏、后台标签页的 DevTools 视口与焦点模拟、渲染进程的过滤，逻辑照搬 |
| `apps/desktop/src/main/browser/browser-host.ts` | OpenWork `apps/desktop/electron/browser-panel.mjs` | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | MIT | 改写：WebContentsView 标签页的生命周期、后台标签页停在不显示的窗口里继续绘制、窗格位置换算、载入失败与状态推送照 OpenWork；去掉 WebMCP、代理、组织策略、任务审批、原生菜单、挂起恢复与快捷键；加上 Wevir 的安全基线（独立分区、只放行 http(s)、下载 / 权限 / 外部协议拒绝、弹窗变成同会话的新标签页）、标签页的操作方与 agent 命令的分发 |
| `packages/protocol/src/search-ranking.ts` | T3 Code `packages/shared/src/searchRanking.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 移植（0.22.0）：只改了格式与注释；Host 的 `workspace.files` 与桌面端的输入框菜单共用 |
| `packages/host/src/workspace-files.ts` | T3 Code `apps/server/src/workspace/WorkspaceEntries.ts`、`WorkspaceFileSystem.ts`、`WorkspaceSearchIndex.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（0.22.0）：不用 Effect 与 fff，索引在 git 仓库里是 `git ls-files`、否则自己遍历；列目录与 `check-ignore` 标忽略、读文件的 1 MiB 上限与 NUL 判二进制照 T3；图片给 base64；只读会话目录里的相对路径 |
| `apps/desktop/src/renderer/src/layout/panes/files-pane.tsx` | T3 Code `apps/web/src/components/files/FileBrowserPanel.tsx`、`useDirectoryEntries.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（U32）：不用 @pierre/trees，按需逐层读目录的树与搜索结果自己画；去掉拖到输入框、右键菜单 |
| `apps/desktop/src/renderer/src/layout/panes/file-pane.tsx` | T3 Code `apps/web/src/components/files/FilePreviewPanel.tsx`、`ReadOnlySourcePreview.tsx` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（U32；0.32.0 补齐办公格式）：按文件类型分支照 T3 的 FilePreviewPanel（图片、音视频、PDF、网页、CSV / TSV 的表格、Markdown、可编辑的源码，渲染与源码的切换记在本机），另加 Office（xlsx 表格、docx / pptx 文字、其余交给系统预览与默认应用）；Host 没有 `file_preview` 时退回 0.22.0 的只读；行的跳转按行高估位置；工具行、保存状态与“打开方式”是 Wevir 的 |
| `apps/desktop/src/renderer/src/layout/panes/file-editor.tsx` | T3 Code `apps/web/src/components/files/FilePreviewPanel.tsx`（`EditableFileSurface`、`useEditableAfterHighlight`、`createFileEditor`）、`useFileSaveCoordinator.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（0.32.0）：去掉行内评论与审查意见；保存走 `workspace.writeFile`，带修改时间的冲突检查，冲突时停下等用户选“重新载入”或“覆盖”；有没写的编辑时不让磁盘上的新内容盖掉它 |
| `apps/desktop/src/renderer/src/layout/panes/file-viewers.tsx` | T3 Code `apps/web/src/components/files/BrowserDocumentFrame.tsx`、`DelimitedTablePreview.tsx`、`AudioPreview.tsx`、`apps/web/src/components/media/MediaVideoPlayer.tsx`、`apps/web/src/components/chat/ZoomableImage.tsx`；OpenWork `apps/app/src/react-app/domains/session/artifacts/artifact-spreadsheet-model.ts`、`artifact-spreadsheet-editor.tsx` | `ec1313c8f8333292506f05a355bb72d308a455d8`（T3）、`ad22cdc2217370f28f24f0f8758016c2921e3c73`（OpenWork） | MIT | 改写（0.32.0）：网页框架只留工作区文件的一支（沙箱，点链接经 `ui/open-link` 请桌面端打开，照 T3 的 HtmlRenderDocument 只在框架有焦点、用户刚操作过时打开），不要 html_render 的主题与快捷键转发；视频去掉缩略图、画中画与媒体菜单，保留换地址不重置播放位置；可缩放图片按窗格适应；xlsx 只读，多个工作表用标签切换，列字母与行号照 Excel，超过 1000 行或 100 列截断；docx / pptx 按段落显示文字（`files/office-preview.ts`） |
| `apps/desktop/src/renderer/src/files/file-preview.ts` | T3 Code `packages/shared/src/filePreview.ts`、`packages/shared/src/video.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 移植（0.32.0）：只留 `filePreviewKind` 与媒体类型的判断，去掉附件与 Markdown 链接的部分；`filePaneView`（窗格的显示方式，含 Office）是 Wevir 的 |
| `apps/desktop/src/renderer/src/files/delimited-preview.ts` | T3 Code `packages/shared/src/delimitedPreview.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 移植（0.32.0）：照搬，只改格式 |
| `apps/desktop/src/renderer/src/files/file-save-coordinator.ts` | T3 Code `apps/web/src/components/files/fileSaveCoordinator.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 移植（0.32.0）：`persist` 回布尔值（T3 是 Effect atom 的结果），其余照搬；测试同样移植 |
| `apps/desktop/src/renderer/src/files/html-preview-link.ts`、`packages/host/src/html-preview.ts` | T3 Code `packages/shared/src/htmlRender.ts`（`readHtmlRenderLinkRequest`、`htmlRenderResult`、`blankNonMarkup`、`injectHtmlRenderBootstrap` 与 BOOTSTRAP_SCRIPT 里点链接的部分） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 移植（0.32.0）：只留“点了链接请父页面打开”（MCP Apps 的 `ui/open-link`），同一个 Host 文件地址下的链接照常在框里打开；主题、内容高度与快捷键转发不要 |
| `packages/host/src/file-urls.ts` | T3 Code `apps/server/src/http.ts`（`assetResponseHeaders`、`assetByteRange`、`assetFileResponse`）、`apps/server/src/assets/AssetAccess.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（0.32.0，`workspace.fileUrl`）：按目录发令牌、同目录只给能预览的几类文件、不给以 `.` 开头的段、单段 Range、HTML 与 SVG 的 CSP 头照 T3；令牌不签名、只在 Host 内存里；不用 Effect |
| `packages/host/src/html-preview-csp.ts` | Paseo `packages/app/src/file-pane/html-preview-csp.ts` | `dc7bc8db124e837ba909ffd3b4b20e16adaebe24` | Apache-2.0 | 改写（0.32.0）：不能联网的指令照 Paseo；由 Host 作为响应头下发，不要 meta 前言与 BOM 处理；另加 T3 的 `sandbox`，脚本、样式、图片、字体与音视频多放行 `'self'`。文件仍按 Apache-2.0（§2.3） |
| `apps/desktop/src/renderer/src/files/workbook/ooxml-package.ts`、`xlsx-workbook.ts`、`office-text.ts`、`index.ts` | OpenWork `packages/workbook/src/ooxml-package.ts`、`xlsx-workbook.ts`、`office-text.ts`、`index.ts` | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | MIT | 移植（0.32.0）：逻辑不改；只有格式（Biome）、相对导入去掉 `.js`、几处 biome-ignore 与 `noUncheckedIndexedAccess` 要的类型断言 |
| `apps/desktop/src/renderer/src/session/markdown/markdown-math.ts` | OpenWork `apps/app/src/components/markdown/markdown-math.ts` | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | MIT | 移植（0.32.0，文件窗格的 Markdown）：出错时的兜底不带 OpenWork 的类名；KaTeX 的 style 属性在 `markdown.ts` 里挪到 `data-csp-style`、挂上后经 CSSOM 补回 |
| `apps/desktop/src/renderer/src/session/markdown/mermaid.ts` | OpenWork `apps/app/src/components/markdown/mermaid.ts` | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | MIT | 改写（0.32.0）：源码检查、清洗与排队渲染照搬；挂到页面的部分改写为不触发 CSP（style 属性与 `<style>` 在解析前从字符串里挪开，挂上后经 CSSOM 与样式 nonce 补回；Mermaid 渲染期间同样处理）；主题取 Wevir 的 `useTheme`，文案走 i18n，样式在 `styles/markdown.css`；去掉“下载 SVG” |
| `apps/desktop/src/main/editors.ts` | T3 Code `packages/contracts/src/editor.ts`、`apps/server/src/process/externalLauncher.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（U32）：编辑器表取其中常见的十二个；macOS 找应用包与它自带的命令行，其他平台找 PATH，跳行的参数照 T3 的三种写法 |
| `apps/desktop/src/renderer/src/session/composer-trigger.ts` | T3 Code `apps/web/src/composer-logic.ts`（`detectComposerTrigger`、`replaceTextRange`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 移植（U33）：纯文本输入框不需要折叠光标的换算，只留 `@` 提及（斜杠命令另在 composer-commands.ts，只认消息开头） |
| `apps/desktop/src/renderer/src/session/composer-commands.ts`、`composer-menu.tsx` | T3 Code `apps/web/src/components/chat/ComposerCommandMenu.tsx`、`composerSlashCommandSearch.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（U33）：命令由页面给出、在本地执行，带二级菜单（`/model 查询`）；名字与界面语言的名称一起搜；菜单不用 Base UI 的 Autocomplete，焦点留在 textarea、经 aria-activedescendant 指向选项 |
| `apps/desktop/src/renderer/src/session/goal-command.ts` | T3 Code `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`（`parseCodexGoalCommand`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 移植（0.35.0）：解析不变，放到桌面端，命令交给 `session.setGoal` / `updateGoal` / `clearGoal` |
| `apps/desktop/src/renderer/src/session/goal-model.ts`、`goal-banner.tsx` | T3 Code `packages/client-runtime/src/state/threadExecution.ts`（`presentProviderGoal`）、`apps/web/src/components/ChatView.tsx`（目标横幅） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（0.35.0）：多一个“暂停”，空闲时进行中的目标也能继续；横幅是 Wevir 的样式（desktop-tokens §48）。侧栏的“目标”照 `apps/web/src/components/Sidebar.tsx` 的做法，没有拷贝代码 |
| `packages/adapter-codex/src/codex-adapter.ts`（`startGoal`、`updateGoal`、`cancel` 的目标部分） | T3 Code `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`（`runGoalCommand`、`resolveGoalStopTarget`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（0.35.0）：照它的顺序——先清除、以 paused 写入、`turn/start` 第一个回合、再设 active；停止时先暂停；继续时没交过设置先开空输入的回合。T3 把几个目标回合并成一次运行，Wevir 每个是一个回合（codex-event-mapping.md §6.13） |
| `apps/desktop/src/renderer/src/session/context-meter.tsx`、`apps/desktop/src/renderer/src/layout/context-bar.tsx` | T3 Code `apps/web/src/components/chat/ContextWindowMeter.tsx`（另参考 `ContextWindowMeter.logic.ts`、`apps/web/src/lib/contextWindow.ts`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（0.29.0）：照它的结构写——随用量填满的圆环、悬停打开的弹层（用量、累计用量、自动压缩的说明、“压缩上下文”按钮）；用量取 Host 的 `usage`（`contextUsage`），自动压缩的线来自协议的 `autoCompactAt` 并画在用量条上，颜色按 75% / 90% 分档，没有 T3 的费用、恢复时提示压缩与占位逻辑 |
| `apps/desktop/src/renderer/src/session/composer-images.ts` | T3 Code `packages/contracts/src/chatAttachment.ts`（图片的格式与大小上限）、`apps/web/src/components/chat/composerAttachmentFiles.ts`（`inferImageMimeTypeFromName`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（0.28.0）：只照它的规则重写——png、jpeg、gif、webp，每张不超过 10 MiB，类型为空或是通用二进制时按扩展名认；每条消息最多 10 张（T3 是 100）。Host 的 images.ts 照 T3 `apps/server/src/attachmentStore.ts` 的做法把没发出去的图片过一天删掉，没有拷贝代码；各引擎发图片的格式照 T3 的 Claude、Cursor、OpenCode 与 ACP 适配器（写在已登记的适配器文件里） |
| `apps/desktop/src/renderer/src/session/proposed-plan.ts` | T3 Code `apps/web/src/proposedPlan.ts`（`buildCollapsedProposedPlanPreviewMarkdown`、`buildPlanImplementationPrompt`、`resolvePlanFollowUpSubmission`、`buildProposedPlanMarkdownFilename`、`normalizePlanMarkdownForExport`、`downloadPlanAsTextFile`）、`packages/shared/src/proposedPlanText.ts`（`proposedPlanTitle`、`stripDisplayedPlanMarkdown`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（0.36.0，计划模式）：实施消息的前缀按界面语言；文件名保留汉字等非 ASCII 字母；不要没有标题时的占位与新会话标题 |
| `apps/desktop/src/renderer/src/session/plan-card.tsx` | T3 Code `apps/web/src/components/chat/ProposedPlanCard.tsx` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（0.36.0）：角标与标题、长计划折叠成前十行的预览、复制与下载 Markdown，外形照 Wevir 的卡片；“保存到工作区”没有搬。输入框的“实施”与下拉（`composer.tsx` 的 `ImplementButton`）与“计划已就绪”（`session-view.tsx` 的 `PlanReadyBanner`）照 `ComposerPrimaryActions.tsx`、`ComposerPlanFollowUpBanner.tsx` 的做法重写，没有拷贝代码。0.37.0 起计划写的时候就显示（流式中不折叠、没有复制与下载，没写完的标“未完成”）是 Wevir 加的；Codex 的 `item/plan/delta` 映射成 `plan.delta`、完成时以全文为准照 T3 `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` 的做法（同一提交），没有拷贝代码 |
| `packages/adapter-claude/src/claude-adapter.ts` | T3 Code `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8`；后续修复 `b49488759211b2c69a9419b845e1bdff17d23fb3`、`66cae3d7565a6cc086672a53349cc5da225189c1`、`598298cc3c56ef6943301944d6986578f6b7d587`、`499c9ee68b28492c9e088a98f112998dfc4ffafc` | MIT | 改写（2026-10-15，Claude Agent 引擎）：每个会话一个常驻的 `query()`、建进程的选项、`spawnClaudeProcessGroup`、流式 / 快照 / 工具结果 / 结果的处理、`canUseTool`、中断、插话、`forkThread` 改写成不依赖 `effect` 的普通 TS，实现 Wevir 的 `AgentRuntimeAdapter`；插话用 priority next（T3 用 now）；关掉后台任务；不移植唤醒回合、prompt 回声的门控、后台任务名单、goal、回滚与编排用的 MCP 工具（claude-event-mapping.md）；0.24.0 照 `compactThread` 加 `compact`（发 `/compact`，`compact_boundary` 的 `post_tokens` 更新用量，claude-event-mapping.md §4.9）；0.36.0 照 `ClaudeAdapterV2.ts` 的 `claudeProposedPlan` 与 ExitPlanMode 的拦截加计划模式（权限模式 `plan`，计划报成 `plan.proposed`，拒绝的说明照 T3 原文，claude-event-mapping.md §5.5）；2026-10-30 照 T3 后续修复：计划回合在完全访问下也经审批问写操作（T3 另有的“从不审批”策略 Wevir 没有，不移植）、上下文用量改读顶层请求的 `message_start` / `message_delta`（快照只补流式事件没报的输入，压缩后同一请求的快照不再报）、以第一个 `init` 报的权限模式为准（同一模型不再改回请求的模式，换模型重起进程重新协商）、被用量上限挡下的 `/compact` 报 `turn.failed` 并带 `usageLimit` |
| `packages/adapter-claude/src/task-output.ts` | T3 Code `apps/server/src/orchestration-v2/Adapters/ClaudeTaskOutputTail.ts` | `a5d97921f6a2a310f55c481763248a313ed3dc17` | MIT | 改写（2026-10-30，前台 Bash 的实时输出）：不依赖 `effect`，用 `node:fs/promises` 与定时器轮询 Claude Code 私有的 `<CLAUDE_CODE_TMPDIR 或 /tmp>/claude-<uid>/<项目>/<session_id>/tasks/<task_id>.output`；停下时不补读最后一次（工具结果带完整输出）；适配器把到目前为止的输出随 `tool.updated` 报 |
| `packages/adapter-claude/src/account.ts` | T3 Code `apps/server/src/provider/ClaudeProvider.ts`、`apps/server/src/provider/claudeUsageLimits.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：版本探测、SDK 的探测会话、套餐名、登录判断与用量改写成 Wevir 的 `EngineAccounts` / `AccountState`；用量只留 5 小时与 7 天两个窗口，另认 `unifiedWindows`；去掉 slash 命令、skills 与重置额度 |
| `packages/adapter-claude/src/model-manifest.ts` | T3 Code `apps/server/src/provider/model-manifest.json` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 摘录：`providers.claudeAgent` 与 claudeAgent 的 `compatibility` 原样转成 TS 常量；不联网更新 |
| `packages/adapter-claude/src/model-catalog.ts` | T3 Code `apps/server/src/provider/ClaudeModelCatalog.ts`、`ClaudeModelManifest.ts`、`apps/server/src/claudeModelOptions.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：按版本过滤、effortMap、上下文窗口与模型后缀，输出 `ProviderModelConfig`；去掉自定义模型与 ultracode / ultrathink / fastMode |
| `packages/adapter-claude/src/executable.ts` | T3 Code `apps/server/src/provider/Drivers/ClaudeExecutable.ts`、`apps/server/src/provider/ClaudeProvider.ts`、`apps/web/src/onboarding/providerReadiness.logic.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：Windows npm 启动脚本换成包入口、`--version` 探测、安装命令；另加 PATH 之外的常见安装位置（T3 的桌面端读登录 shell 的环境，Wevir 不读） |
| `packages/adapter-claude/src/permissions.ts` | T3 Code `ClaudeAdapterV2.ts`（`permissionModeForClaudeRuntimePolicy`、`permissionResultFromDecision`、`toSessionPermissionUpdates`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：Wevir 的三种权限模式的映射；审批选项照 adapter-codex |
| `packages/adapter-claude/src/tool-display.ts` | T3 Code `ClaudeAdapterV2.ts`（`classifyClaudeNativeTool`、`summarizeClaudeToolRequest`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：输出 Wevir 的 `ToolDisplay` |
| `packages/adapter-claude/src/todos.ts` | T3 Code `ClaudeAdapterV2.ts`（`claudeTodoSteps`、`applyClaudeTaskTool`、`claudeUserInputQuestions`、`claudeSdkUserInputAnswers`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：输出 `TodoItem` 与 `UserQuestion` |
| `packages/adapter-claude/src/turn-result.ts` | T3 Code `ClaudeAdapterV2.ts`（`resultUserFacingError`、`terminalResultError`、`terminalStatusFromResult`、`providerFailureFromResult`）；`packages/provider-core/src/server/failure.ts`（`redactUrl`、`replaceUnsafeControlCharacters`、`redactProviderFailureText`、`boundedText`） | `ec1313c8f8333292506f05a355bb72d308a455d8`；后续修复 `fb9af9e57dcfcf2a8cf74ba0a52031a65eb02dc9`、`55a8fe9a938c61ef6e6bce718c58647ebdb4c88d` | MIT | 改写：输出 `turn.settled` / `turn.failed` 的归类；2026-10-30 照 T3 后续修复：`blocking_limit` 只在有被拒的 `rate_limit_event` 时算用量上限，否则是上下文窗口满了；`api_error` 的结果以 `API Error:` 开头时说明用原文（脱敏后截到 500 字，截断处加省略号，T3 直接截断） |
| `packages/adapter-cursor/src/sdk.ts` | T3 Code `packages/provider-cursor/src/server/sdk.ts`（另参照 `CursorSdkCatalog.ts`、`CursorAgentSdk.ts` 用到的入口） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（Cursor 引擎）：不用 `createRequire`，第一次用到时动态 import；Effect 的服务换成窄接口 `CursorSdk` |
| `packages/adapter-cursor/src/errors.ts` | T3 Code `packages/provider-cursor/src/server/CursorSdk.ts`、`CursorAgentSdk.ts`、`CursorSdkCatalog.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 移植 `isCursorShellSpawnFailure`、取消与“already has active run”的判断、认证失败的判断；按 `name` 判断，不用 instanceof；守卫由 Host 的 `cli.ts` 调用，不自己注册 unhandledRejection 监听。跟进 T3 `f54dfc0991`：`isCursorClosedStreamWrite`（SDK 往已关闭的 exec 流写入），经 Host 的 `engines.ts` 放过 |
| `packages/adapter-cursor/src/credentials.ts` | T3 Code `packages/provider-cursor/src/server/credentialStore.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：凭据存 `<数据目录>/engines/cursor/auth.json`（0700 / 0600，临时文件加 rename），不进密钥库；去掉旧版文件的迁移；加登录用的内存存储 |
| `packages/adapter-cursor/src/accounts.ts` | T3 Code `packages/provider-cursor/src/server/auth.ts`、`CursorSdkCatalog.ts`、`status.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写成 `EngineAccounts`：登录先写内存、确认后才落盘，5 分钟超时，取消、替换、登出时停掉会话，模型列表缓存 30 分钟，15 s 时限；不读 Cursor CLI 的登录，用量用这把 Key 读（usage.ts） |
| `packages/adapter-cursor/src/models.ts` | T3 Code `packages/provider-cursor/src/server/status.ts`、`sdkModel.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：模型参数只取推理档位（`effort` / `reasoning`），列表第一个是 Auto（交给 SDK 时是 `default`） |
| `packages/adapter-cursor/src/transport-failure.ts` | T3 Code `packages/provider-cursor/src/server/transportFailure.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 移植，逻辑未改 |
| `packages/adapter-cursor/src/transport-failure.test.ts` | T3 Code `packages/provider-cursor/src/server/transportFailure.test.ts`、`CursorSdk.test.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 用例改写成 Vitest；`isCursorClosedStreamWrite` 的用例跟进 T3 `f54dfc0991` |
| `packages/adapter-cursor/src/tool-display.ts` | T3 Code `packages/provider-cursor/src/server/adapter.ts`（工具的名称、输出、失败、待办与子 agent 回答的取法） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：产出 Wevir 的 `ToolDisplay` 与输出文本 |
| `packages/adapter-cursor/src/mapping.ts` | T3 Code `packages/provider-cursor/src/server/adapter.ts`（`handleInteractionUpdate`、`handleToolUpdate`、`finalizeTurn`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：流式更新 → `AgentEvent`（增量、已提交消息、工具、待办），子 agent 只当工具。跟进 T3 `656f3f4094`（每段回答单独判断传输诊断）与 `be1d066732`（记下回合是否已经结束） |
| `packages/adapter-cursor/src/cursor-adapter.ts` | T3 Code `packages/provider-cursor/src/server/adapter.ts`、`CursorAgentSdk.ts`、`driver.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写成 `AgentRuntimeAdapter`：建与恢复 agent 的选项、run 开出前的更新、遗留 run 的恢复、取消；去掉 T3 的 MCP 服务、skills、附件与计划模式；权限模式按 Wevir 的三种映射。跟进 T3 `be1d066732`：回合已经结束后 SDK 恢复没有进展而报的错不算回合失败 |
| `packages/adapter-opencode/src/sdk.ts` | T3 Code `packages/provider-opencode/src/server/OpenCodeRuntime.ts`（`createOpenCodeSdkClient`、`runOpenCodeSdk`、`openCodeRuntimeErrorDetail`）、`adapter.ts`（`isOpenCodeNotFound`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（OpenCode 引擎）：Effect 的服务换成窄接口 `OpenCodeClient`，第一次用到时动态 import SDK，事件流最多重连 3 次 |
| `packages/adapter-opencode/src/executable.ts` | T3 Code `packages/provider-opencode/src/server/versionProbe.ts`、`OpenCodeRuntime.ts`（`MINIMUM_OPENCODE_VERSION`）、`status.ts`（`formatOpenCodeProbeError`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：找 `opencode` 时在 PATH 之外再找常见的安装位置并补进 PATH（同 adapter-claude）；2.x 认出来后报不支持 |
| `packages/adapter-opencode/src/server.ts` | T3 Code `packages/provider-opencode/src/server/OpenCodeRuntime.ts`（`startOpenCodeServerProcess`、`parseServerUrlFromOutput`、`resolveOpenCodeConfigContent`）、`OpenCodeServerLedger.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：Scope 换成显式的 `stop()`；每次起服务器都生成随机密码；台账记在 `<数据目录>/engines/opencode/servers` |
| `packages/adapter-opencode/src/runtime.ts` | T3 Code `packages/provider-opencode/src/server/OpenCodeServerOwner.ts`、`versionProbe.ts`（`makeOpenCodeRuntimeProbe`）、`OpenCodeRuntime.ts`（`verifyOpenCodeServerVersion`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：懒启动、借用计数、空闲 30 秒停掉；账号检测与会话共用一个服务器 |
| `packages/adapter-cursor/src/usage.ts` | T3 Code `packages/provider-cursor/src/server/usageLimits.ts`（`cursorUsageResponseToLimits`、`readCursorUsageLimits`）、`packages/shared/src/usageLimits.ts`（`CURSOR_USAGE_WINDOWS`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（2026-10-17，协议 0.45.0）：不读 Cursor CLI 的登录与钥匙串，像 `@cursor/sdk` 那样用登录铸出的 API Key 经 `/auth/exchange_user_api_key` 换短期令牌再读 `GetCurrentPeriodUsage`；三个按月窗口，额度名用 Cursor 后台的说法 |
| `packages/adapter-opencode/src/accounts.ts` | T3 Code `packages/provider-opencode/src/server/status.ts`（`checkOpenCodeProviderStatus`） | `ec1313c8f8333292506f05a355bb72d308a455d8`；模型目录没读到时退避重试照 `807319c276c6831b2c219640e9da5b38019a8f1d`（#23939） | MIT | 改写成 `EngineAccounts`：“已登录”与套餐是接上了哪些上游；不读 skills、slash 命令与 agent 列表；不支持外部服务器；接上 OpenCode Go 时读它的用量（usage.ts） |
| `packages/adapter-opencode/src/models.ts` | T3 Code `packages/provider-opencode/src/server/status.ts`（`flattenOpenCodeModels`、`subProviderLabelFor`）、`OpenCodeRuntime.ts`（`parseOpenCodeModelSlug`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：输出 `AccountModels`，子 Provider 写进显示名，不补假的推理档位；标题用的最低变体（`lowestVariant`）是 Wevir 自己的 |
| `packages/adapter-opencode/src/permissions.ts` | T3 Code `packages/provider-opencode/src/server/adapter.ts`（`openCodePermissionRules`、`openCodeChildPermissionRules`）、`OpenCodeRuntime.ts`（`buildOpenCodePermissionRules`、`toOpenCodePermissionReply`） | `ec1313c8f8333292506f05a355bb72d308a455d8`；`subagentOwnRules` 参照 `8031991591e22d76830e4acf6358c4fd78ffcf60`（#26302） | MIT | 改写：Wevir 的三种权限模式；去掉给子会话继承的 deny 前缀，改由服务器的权限配置兜住子会话的第一步；放行 `list`；审批选项照 Codex 的四个 |
| `packages/adapter-opencode/src/message-id.ts` | T3 Code `packages/provider-opencode/src/server/adapter.ts`（`makeOpenCodeMessageId`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 移植，Effect 的 Ref 与 Random 换成模块内计数与 `node:crypto` |
| `packages/adapter-opencode/src/tool-display.ts` | T3 Code `packages/provider-opencode/src/server/toolItems.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：产出 Wevir 的 `ToolDisplay`，apply_patch 从补丁取路径 |
| `packages/adapter-opencode/src/mapping.ts` | T3 Code `packages/provider-opencode/src/server/adapter.ts`（`handlePartUpdated`、`handlePartDelta`、`handleAssistantCompleted`、`emitTextPart`、`emitToolPart`、`emitTodo`、`accumulateOpenCodeStepUsage`） | `ec1313c8f8333292506f05a355bb72d308a455d8`；`nativeReadOutput`（`toolItems.ts`）来自 `cfbfbca6e0582fb48423949b10f0663f8fed2be0`（#21507） | MIT | 改写：opencode 的 part → `AgentEvent`（增量与替换、工具三段、清单取 todowrite 的输入、上下文用量） |
| `packages/adapter-opencode/src/opencode-adapter.ts` | T3 Code `packages/provider-opencode/src/server/adapter.ts`（`openSession`、`ensureThread`、`resumeThread`、`startTurn`、`interruptTurn`、`respondToRuntimeRequest`、`handleEvent`、`finalizeTurn`、`reconcileOpenCodePromptAdmissionStatus`、`abortDescendants`、`emitSubagent`、`steerTurn`、`advanceOpenCodePromptAdmission`、`reconcilePromptAdmission`、`forkThread`、`openCodeBoundaryAfterProviderTurn`）、`OpenCodeRuntime.ts`（`openCodeQuestionId`、`toOpenCodeQuestionAnswers`） | `ec1313c8f8333292506f05a355bb72d308a455d8`；换权限模式时子会话跟着换（`applyPermissionRules`）照 `8031991591e22d76830e4acf6358c4fd78ffcf60`（#26302） | MIT | 改写成 `AgentRuntimeAdapter`：一个 Host 一个服务器、按目录订阅事件流；回合以见到 busy 为开始（不用 admission 状态机）；子 agent 照 Wevir 的子会话报，子会话的审批在子会话的流里；插话保留 admission 里交接期间压着 idle 的那一段，以回答它的 assistant 消息报 `turn.steered`，没用上的插话从 opencode 的历史里删掉；分支只做 Wevir 的支线（回合进行中也能分，补一条边界消息）；补充说明用 `noReply`；不搬回滚、slash 命令、附件与 T3 的 MCP 服务 |
| `packages/adapter-opencode/src/title.ts` | T3 Code `packages/provider-opencode/src/server/textGeneration.ts`（`runOpenCodeJson` 的 `runAgainstServer`、`getOpenCodePromptFailure`、`isOpenCodeTextPart`、`getOpenCodeTextResponse`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：只做会话标题；说明经 `system`、输出经 `format: json_schema` 约束、取 `structured`，临时会话的规则放行 StructuredOutput；变体取最低的一档；用完删掉临时会话；解析交给 Host |
| `packages/adapter-opencode/src/app-tools-plugin.ts` | Paseo `packages/server/src/server/agent/providers/opencode/bridge-plugin.mjs`（`paseoPlugin`、`formatToolResult`、`jsonSchemaObjectToZodShape`、`jsonSchemaToZod`、`unionToZod`） | `dc7bc8db124e837ba909ffd3b4b20e16adaebe24` | **Apache-2.0** | 改写（0.30.0，OpenCode 的应用级工具，opencode-event-mapping.md §4.4）：成了生成插件源码的函数，生成的插件也带 Apache-2.0 与来源的声明；工具定义与调用走 Host 的 `/mcp`（JSON-RPC 的 tools/list、tools/call，引擎令牌加 `x-wevir-engine-session` 请求头），不另开桥；只读的工具与 `wevir_show` 不经 `context.ask`；`isError` 时抛错；列不出工具时不挂工具；去掉 `shell.env` 与按父会话找上下文；zod 按绝对地址 import；请求带 opencode 的中止信号。文件头按 §2.3 写 SPDX、版权与“由 Wevir 修改”；同目录的 `app-tools.ts`（插件文件的生成、配置项与工具名）是 Wevir 自己的，MIT |
| `packages/adapter-grok/src/xai.ts` | T3 Code `packages/provider-grok/src/server/acpSupport.ts`（`grokAcpSpawnArgs`、`GROK_ACP_CANCEL_META`、`GROK_ACP_INITIALIZE_META`、`grokApprovalOptions`）、`xaiAcpExtension.ts`（回合结束、提问、退出计划模式的编解码） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写成不依赖 Effect 的 TS：运行模式换成 Wevir 的权限模式；审批选项只过滤 Grok 给的；提问按 Wevir 的 `respondToQuestion`；退出计划模式由 Wevir 的审批决定，不建计划卡片；0.36.0 起退出计划模式照 `makeXAiExitPlanModeCapturedResponse` 回复（`EXIT_PLAN_CAPTURED`），不再当审批问 |
| `packages/adapter-grok/src/tool-display.ts` | T3 Code `packages/provider-grok/src/server/xaiAcpExtension.ts`（`isGenericAcpToolTitle`、`resolveXAiAcpToolTitle`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 另按 Grok 的工具名与 `_meta["x.ai/tool"]` 给出 Wevir 的 `ToolDisplay` |
| `packages/adapter-grok/src/models.ts` | T3 Code `packages/provider-grok/src/server/status.ts`（`parseGrokModelsCliOutput`、`buildGrokModelsFromSessionModelState` 等）、`packages/provider-acp/src/server/runtimeModel.ts`（`sessionModelStateFromInitialize`）、`acpSupport.ts`（`GROK_DEFAULT_MODEL_SLUG`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 输出 Wevir 的 `AccountModels`（上下文窗口与推理档位）；不读 T3 的自定义模型设置 |
| `packages/adapter-grok/src/launch.ts` | T3 Code `packages/provider-grok/src/server/acpSupport.ts`（`buildGrokAcpSpawnInput`、`grokAcpRuntimeProcessOwnership`）、`status.ts`（`runGrokCliCommand`）、`driver.ts`（npm 包名） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 可执行文件经 adapter-acp 的 `resolveExternalExecutable` 找（`WEVIR_GROK_BIN` → `account.setPath` → PATH → 常见安装目录）；不设 `GROK_OAUTH2_REFERRER`；启动器按 `AcpLauncher` 给出 spawn 参数 |
| `packages/adapter-opencode/src/usage.ts` | T3 Code `packages/provider-opencode/src/server/usageLimits.ts`（`readOpenCodeGoUsageLimits`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（2026-10-17，协议 0.45.0）：只读 opencode 的 auth.json 里 Go 的 Key（或 `OPENCODE_API_KEY`），5 小时、每周、每月三个窗口，缺的不报；不算凭据指纹 |
| `packages/adapter-grok/src/accounts.ts` | T3 Code `packages/provider-grok/src/server/status.ts`（`checkGrokProviderStatus`、`discoverGrokMetadataViaAcpInitialize`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 输出 `EngineAccounts` 的 `AccountState`；ACP 探测经 `AcpProcess`；邮箱与用量读 `~/.grok/auth.json`（usage.ts，只读），没有套餐；不做 skills 与斜杠命令；缓存 5 分钟；2026-10-30 补入之后的修复 `c632d7e96bd8bc8a808d76c3f766809c7730a765`（`initialize` 探测 20 s）与 `a2157eced708fd25fab7b616f5a68cb65312eaed`（`grok models` 说没登录时再查一次） |
| `packages/adapter-grok/src/grok-adapter.ts` | T3 Code `packages/provider-grok/src/server/adapter.ts`（提问与退出计划模式的扩展、`grokLaunchRuntimeMode`）、`xaiAcpExtension.ts`（`makeXAiPromptCompletionRuntime`）、`acpSupport.ts`（`resolveGrokAuthMethodId`）、`packages/provider-acp/src/server/AcpSessionRuntime.ts`（`authenticateAfterRequired`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 建在 adapter-acp 的 `AcpAdapter` 上；每种权限模式一个进程（T3 每个会话一个），会话中途换模式时挪进程；不做后台任务、子 agent、计划卡片、斜杠命令与对话压缩；0.36.0 照 `registerGrokExitPlanModeExtensions` 把计划报成 `plan.proposed`（只取请求里的 `planContent`，不找 `plan.md`） |
| `packages/adapter-antigravity/src/release.ts` | T3 Code `apps/server/src/provider/antigravityRelease.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 移植（Antigravity 引擎）：钉住的发布表原样保留；加镜像前缀 `WEVIR_ANTIGRAVITY_MIRROR`、版本号的两种写法与可执行文件名 |
| `packages/adapter-antigravity/src/installation.ts` | T3 Code `apps/server/src/provider/AntigravityInstallation.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：版本目录加原子的 active.json、下载核对大小与 sha256、解包逐项核对、启动校验照 T3；目录换到 `<数据目录>/engines/antigravity/runtime/`，下载不压缩、断了用 Range 接着下、60 秒收不到数据算卡住、连不上时说明镜像与手填路径；不做租约与删除 |
| `packages/adapter-antigravity/src/zip.ts` | T3 Code `apps/server/src/zipArchive.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：Effect 换成 Promise，yauzl 的选项照 T3 |
| `packages/adapter-antigravity/src/profile.ts` | T3 Code `apps/server/src/provider/antigravityAuthSupport.ts`、`Drivers/AntigravitySkills.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：去掉的环境变量、BROWSER 钩子与它的核对、私有 profile、skills 链接、登录网址的解析、stdout / stderr 上的登录提示照 T3；只留个人 Google 账号，不收 API Key；钩子用 Host 自己的 Node；产出 adapter-acp 的启动参数与钩子 |
| `packages/adapter-antigravity/src/session-files.ts` | T3 Code `apps/server/src/provider/acp/AntigravitySessionFiles.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 移植：Effect 换成 Promise |
| `packages/adapter-antigravity/src/protocol.ts` | T3 Code `apps/server/src/provider/acp/AntigravityProtocol.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：interaction_* 提问换成 Wevir 的 `UserQuestion` 与回答到选项 ID 的换算（重名的 label 带选项 ID）、工具负载截断、原生命令字段、start_subagent 的识别照 T3，产出 `ToolDisplay`；不移植审批选项的取舍与安全提示 |
| `packages/adapter-antigravity/src/models.ts` | T3 Code `apps/server/src/provider/AntigravityProvider.ts`（`buildAntigravityModelsFromSession`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：产出 `AccountModels`，另存 models.json |
| `packages/adapter-grok/src/usage.ts` | T3 Code `packages/provider-grok/src/server/usageLimits.ts`（`grokUsageResponseToLimits`、`readGrokCredential`、`readGrokAccount`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（2026-10-17，协议 0.45.0）：只读默认 grok.com 登录的令牌与邮箱（用 API Key 或配置了别的账号时不读），计费接口的一个窗口，每周给长度、每月按月；没用过的账号不报窗口 |
| `packages/adapter-antigravity/src/accounts.ts` | T3 Code `apps/server/src/provider/AntigravityAuth.ts`、`Drivers/AntigravityDriver.ts`、`AntigravityProvider.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写成 `EngineAccounts`：一次性的登录进程、5 分钟超时、取消与替换、登录成功后开一次性会话读模型、显式刷新、ACP logout、不启动运行体的状态；不做远程粘贴回调、API Key 等登录方式；用量见 usage.ts，后台读、5 分钟一次 |
| `packages/adapter-antigravity/src/usage.ts` | T3 Code `apps/server/src/provider/antigravityUsageLimits.ts`（`makeAntigravityUsageProbe`、`summaryWindows`、`modelWindows`、`quotaWindow`） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（2026-10-17，协议 0.45.0）：只读 profile 里的登录文件，refresh token 换的 access token 只在内存里；额度汇总按额度分组（`scope`），老账号退回按模型的额度；不读 Google 账号 ID |
| `packages/runtime-adapter/src/secret-patterns.ts`（`redactDiagnostics`） | T3 Code `packages/provider-core/src/server/failure.ts`（`redactProviderFailureText`）、`packages/provider-acp/src/server/stderr.ts`（`sanitizeAcpStderrExcerpt`） | `67afdd56c7905e9df721c61f5795578bb8c27867`、`49d014245777bbf47756635886ddf0846d2330d3` | MIT | 改写（2026-10-30）：只取凭据键名（含组合键名）后的值与 `Bearer` / `Basic` 凭据两类规则，接在 Wevir 自己的 `redactSecrets` 之后，用于 ACP 引擎的 stderr 尾部与回合失败原文；文件从 `packages/host/src/` 挪来，其余部分是 Wevir 的 |
| `packages/runtime-adapter/src/rate-limits.ts` | T3 Code `packages/provider-core/src/server/usageLimits.ts`（`clampPercent`、窗口排序） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写（2026-10-17，协议 0.45.0）：窗口 → `AccountState.rateLimits`（`windows` 加前两个的 primary / secondary）；不做 T3 的 unavailable 快照与回合里的合并 |
| `packages/adapter-antigravity/src/antigravity-adapter.ts` | T3 Code `apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts`、`acp/AntigravityAcpSupport.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 改写：建在 Wevir 的 `AcpAdapter` 上，一个进程承载全部会话；权限模式 default / auto_edit / yolo 与模型选择照 T3，会话中改的下一个回合生效；`interaction_*` 经 `requestAnswers` 问用户；不声明 fs 能力，没有附件、子 agent 批次与文本生成 |
| `packages/adapter-antigravity/src/test-fixtures/acp-samples.ts` | T3 Code T3 测试里的 Antigravity 样本：`apps/server/src/provider/acp/AntigravityProtocol.test.ts`、`AntigravityProvider.test.ts`、`packages/effect-acp/test/fixtures/antigravity-initialize.json`、`apps/server/src/textGeneration/AntigravityTextGeneration.test.ts` | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 摘录：样本数据原样转成 TS 常量，用于回放 |
| `packages/adapter-grok/src/test-fixtures/acp/*.ndjson` | T3 Code `apps/server/src/orchestration-v2/testkit/fixtures/<场景>/grok_transcript.ndjson`（simple、tool_call_read_only_on_request、todo_list、grok_prompt_error、message_steering、plan_questions、grok_background_bash） | `ec1313c8f8333292506f05a355bb72d308a455d8` | MIT | 原样复制，文件名改成场景名；是 T3 录的真实 Grok Build 1.0.41 / 1.0.44 的 ACP 往返（见 §4.1） |
| `packages/noise/test-vectors/{cacophony,snow}.json` | [cacophony](https://github.com/haskell-cryptography/cacophony) `vectors/cacophony.txt`（`8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247`）与 [snow](https://github.com/mcginty/snow) `tests/vectors/snow.txt`（`8ac60f51cfe3e010c84f0a454cc575ad9204fa12`）中 25519 + ChaChaPoly + SHA256 的 `IK`、`XXpsk3`、`XXpsk0+psk2` | cacophony：Unlicense；snow：Apache-2.0 或 MIT（Wevir 选 MIT），`Copyright (c) 2021 Jake McGinty` | 向量原样复制，来源与筛选写在各 JSON 的 `source` 字段；只给 `@wevir/noise` 的测试用，不进构建产物 |
| `packages/noise/test-vectors/snow-generated.json` | Wevir 的生成程序 `packages/noise/test-vectors/snowgen/`（Rust，`snow =0.10.0`）的输出中 SHA256 的两条（`Noise_XXpsk2`、`Noise_IK`，固定密钥） | Wevir 的文件（MIT） | 用独立实现交叉验证 Wevir 用到的两个协议；CI 只读 JSON，不依赖 Rust |

代码智能（2026-10-17，domain-model §3.15.5）改写自 opencode，MIT，`Copyright (c) 2025 opencode`：

| Wevir 文件 | 来源路径（sst/opencode） | 来源提交 | 许可证 | 修改说明 |
|---|---|---|---|---|
| `packages/host/src/lsp/servers.ts` | `packages/opencode/src/lsp/server.ts`（Typescript、Pyright、Gopls、RustAnalyzer、Clangd、SourceKit、NearestRoot）、`lsp/language.ts` | `e3c4eb242585dcd77be1a867391b7c25fd47ce52` | MIT | 改写：只留六种语言，不自动下载与安装，找不到时给出安装命令；TypeScript 7 用原生 `tsc --lsp`；PATH 之外找常见的安装位置；项目根到会话目录为止；读版本、对照最低版本，找不到或过旧时给出项目级与用户级安装方案（只在用户发起时运行）；没有项目 TypeScript 时用全局的 TypeScript 7 |
| `packages/host/src/lsp/client.ts` | `packages/opencode/src/lsp/client.ts` | `e3c4eb242585dcd77be1a867391b7c25fd47ce52` | MIT | 改写成类，不用 Effect；加 didSave、打开文档上限、递归监视转发 didChangeWatchedFiles、stderr 末尾、拒绝 applyEdit、shutdown / exit 后结束进程；记下声明的能力名与最近一次诊断的时间 |
| `packages/host/src/lsp/manager.ts` | `packages/opencode/src/lsp/lsp.ts` | `e3c4eb242585dcd77be1a867391b7c25fd47ce52` | MIT | 改写：失败 3 次的窗口代替永久的 `broken`，加空闲关闭、上限、回收与引擎改动文件的记录；起服务器前读版本，记下每个服务器的状态、能力与启动日志，可以重启 |
| `packages/host/src/lsp-tools.ts` | `packages/opencode/src/tool/lsp.ts`、`tool/lsp.txt`、`lsp/diagnostic.ts` | `e3c4eb242585dcd77be1a867391b7c25fd47ce52` | MIT | 改写：一个 `lsp` 工具拆成七个应用级工具，结果写成路径:行:列加那一行，位置可给符号名，加诊断工具与改动文件的错误反馈，说明文字重写 |

内置的 skill-creator（0.96.0，`prompts/skills/skill-creator/`）移植自 [anthropics/skills](https://github.com/anthropics/skills)，Apache-2.0，`Copyright 2026 Anthropic, PBC.`，目录里的 `LICENSE.txt` 随文件分发；不在 `upstream/` 里克隆。另对照了 Claude Code 自带的同名 skill（[asgeirtj/system_prompts_leaks](https://github.com/asgeirtj/system_prompts_leaks) 提交 `e7e53f2bc29199dfada98aa9f5d24621c2f65684` 的 `Anthropic/claude-code/skills/skill-creator/`，同为 Apache-2.0）与 Codex 的示例 skill-creator（`codex-rs/skills/src/assets/samples/skill-creator/`），只取了下表写明的部分。`NOTICE` 第 14 节。

| Wevir 文件（`prompts/skills/skill-creator/`） | 来源路径（anthropics/skills 的 `skills/skill-creator/`） | 来源提交 | 许可证 | 修改说明 |
|---|---|---|---|---|
| `SKILL.md` | `SKILL.md` | `dbd4588f1e1033efb41dad4bef2f7947c8993d44` | Apache-2.0 | 不限定模型；测试运行、计时、评审页、安装与分享改用 Wevir 的工具（子智能体或 `wevir_session_create`、`wevir_session_wait`、`wevir_process_start`、`wevir_show`、`wevir_skill_install`、`wevir_share_file`）；描述优化改成子智能体的选择判断；Claude.ai 与 Cowork 两节并成“缺少工具时”；加 Wevir 的名字与位置规则 |
| `scripts/quick_validate.py` | `scripts/quick_validate.py`（单个 SKILL.md 检查取自 Claude Code 自带的副本） | 同上 | Apache-2.0 | PyYAML 可选（自带精简解析），嵌套 SKILL.md 的提示改为 Wevir 的加载规则，检查 `metadata.short-description` |
| `scripts/package_skill.py` | `scripts/package_skill.py` | 同上 | Apache-2.0 | 输出 `<名字>.zip`（Wevir 的安装认 ZIP），跳过 `.git`，不写字节码，可按路径运行 |
| `scripts/trigger_eval.py` | `scripts/run_eval.py`、`run_loop.py`、`improve_description.py` | 同上 | Apache-2.0 | 改写：不调 `claude -p`；保留分层的训练 / 测试切分、触发率与看不到测试分数的改写提示，模型调用交给 agent 的子智能体 |
| `eval-viewer/generate_review.py` | `eval-viewer/generate_review.py` | 同上 | Apache-2.0 | 不再结束占用端口的其他进程（改用空闲端口），绑定并打印 `127.0.0.1`，`--no-browser`，输出立即刷新，支持 Python 3.9 |
| `eval-viewer/viewer.html`、`assets/eval_review.html`、`references/schemas.md` | 同名文件 | 同上 | Apache-2.0 | 文案指回 Wevir；评审页由 `scripts/review_trigger_evals.py` 提供时导出经服务器保存；示例模型名 |
| `scripts/aggregate_benchmark.py` | `scripts/aggregate_benchmark.py` | 同上 | Apache-2.0 | token 只取 `timing.json`（不再拿输出字数顶替，`grading.json` 有计时时也读），`runs_per_configuration` 按实际次数算，`--model` 填模型名 |
| `agents/{grader,comparator,analyzer}.md`、`scripts/{utils,__init__}.py`、`LICENSE.txt` | 同名文件 | 同上 | Apache-2.0 | 原样（只加文件头） |

`scripts/review_trigger_evals.py` 与 `agents/openai.yaml` 是 Wevir 新增的；上游的 `generate_report.py` 只给 `run_loop.py` 出报告，没有移植。

内置的 imagegen skill（`prompts/skills/imagegen/`）改写自 Codex 的示例 skill（`codex-rs/skills/src/assets/samples/imagegen/`），Apache-2.0，`Copyright 2025 OpenAI`，目录里的 `LICENSE.txt` 随文件分发；`NOTICE` 第 5 节。Codex 自己的内置 skills（写进 `CODEX_HOME/skills/.system` 的那份）在 Wevir 的 Codex 配置里由 `[skills.bundled] enabled = false` 关掉，不会出现两个 imagegen。

| Wevir 文件（`prompts/skills/imagegen/`） | 来源路径（openai/codex 的 `codex-rs/skills/src/assets/samples/imagegen/`） | 来源提交 | 许可证 | 修改说明 |
|---|---|---|---|---|
| `SKILL.md` | `SKILL.md` | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | Apache-2.0 | 工具改为 Wevir 的应用级工具 `wevir_image_generate`（ChatGPT 会话里列出的是 Codex 的 `image_gen` 时照用）；去掉 Python CLI 后备、依赖与 `OPENAI_API_KEY` 的说明（Key 在 Host）；编辑直接给本地文件路径；保存位置改为 Wevir 的 generated-images 目录；两个工具都没有时请用户在设置的模型服务里加图片模型；gpt-image-2 的透明背景改为先问再换模型 |
| `references/image-api.md` | `references/image-api.md` | 同上 | Apache-2.0 | 只留 `wevir_image_generate` 接受的参数与模型、尺寸限制；去掉 CLI、端点、input_fidelity、压缩、审核与抠色键的说明 |
| `references/prompting.md` | `references/prompting.md` | 同上 | Apache-2.0 | 两种模式改为两个工具；执行参数一节指向工具参数 |
| `references/sample-prompts.md` | `references/sample-prompts.md` | 同上 | Apache-2.0 | 只改开头的说明，示例原样 |
| `agents/openai.yaml` | `agents/openai.yaml` | 同上 | Apache-2.0 | 去掉图标（Wevir 不读）；短描述改写 |
| `LICENSE.txt` | `LICENSE.txt` | 同上 | Apache-2.0 | 原样 |

`scripts/image_gen.py`、`scripts/remove_chroma_key.py`、`references/cli.md`、`references/codex-network.md` 与 `assets/` 的图标没有移植。

iOS 模拟器的 helper（2026-10-24）移植自 facebook/idb，MIT，`Copyright (c) Meta Platforms, Inc. and affiliates.`，文件都在 `apps/desktop/native/ios-simulator/` 下：

| Wevir 文件 | 来源路径（facebook/idb） | 来源提交 | 许可证 | 修改说明 |
|---|---|---|---|---|
| `Sources/WevirIOSSimulator/idb/XPC/XPCEncoder.swift` | `FBSimulatorControl/XPC/XPCEncoder.swift` | `14baeffc8f681380527c400a8184512b746ee918` | MIT | 原样 |
| `Sources/WevirIOSSimulator/idb/XPC/SimulatorXPCConnection.swift` | `FBSimulatorControl/XPC/SimulatorXPCConnection.swift` | `14baeffc8f681380527c400a8184512b746ee918` | MIT | 去掉 public / package 与 FBControlCore 的 import（下同） |
| `Sources/WevirIOSSimulator/idb/XPC/SimulatorXPCChannel.swift` | `FBSimulatorControl/XPC/SimulatorXPCChannel.swift` | `14baeffc8f681380527c400a8184512b746ee918` | MIT | FirstAnswer 改用锁加一个 continuation，不用 IDBConcurrency 的 AsyncEvent |
| `Sources/WevirIOSSimulator/idb/HID/{DTUHIDModels,SimulatorDTUHIDConnection,SimulatorHIDButtonIdentity,SimulatorHIDTransportSelection,SimulatorIndigoHIDClient,SimulatorPurpleHID,SimulatorPurpleHIDTransport}.swift` | `FBSimulatorControl/HID/ 下的同名文件` | `14baeffc8f681380527c400a8184512b746ee918` | MIT | 只去掉访问修饰与 import |
| `Sources/WevirIOSSimulator/idb/HID/{SimulatorHIDTransport,SimulatorDigitizerHIDTransport,SimulatorIndigoHIDTransport,SimulatorHIDTypes,SimulatorHIDError}.swift` | `FBSimulatorControl/HID/ 下的同名文件` | `14baeffc8f681380527c400a8184512b746ee918` | MIT | 去掉多显示器（SimulatorHIDDisplay）路由，只打主屏；去掉方向的 vendorEvent；Indigo 传输加了按原始 ButtonEventSource 发按键 |
| `Sources/WevirIOSSimulator/idb/HID/SimulatorIndigoHID.swift` | `FBSimulatorControl/HID/SimulatorIndigoHID.swift` | `14baeffc8f681380527c400a8184512b746ee918` | MIT | 加了 button(source:direction:)（⌘K 的软键盘切换是按键源 0x3f0） |
| `Sources/WevirIOSSimulator/idb/HID/SimulatorOrientationProtocol.swift` | `FBSimulatorControl/CoreDevice/SimulatorOrientationProtocol.swift` | `14baeffc8f681380527c400a8184512b746ee918` | MIT | 只留读方向的请求；方向名换成 helper 的 DeviceOrientation |
| `Sources/WevirIOSSimulator/idb/Framebuffer/{Framebuffer,FramebufferSurface,SurfaceImageGenerator}.swift` | `FBSimulatorControl/Framebuffer/ 下的同名文件` | `14baeffc8f681380527c400a8184512b746ee918` | MIT | 只留主屏；去掉统计、显示配置变化与结束事件；截图只按输出尺寸缩放 |
| `Sources/WevirIOSSimulator/idb/Support/ObjCRuntimeClass.swift` | `FBSimulatorControl/Utility/ObjCRuntimeClass.swift` | `14baeffc8f681380527c400a8184512b746ee918` | MIT | FBControlCoreObjC 换成本包的 ObjCExceptionGuard |
| `Sources/WevirIOSSimulator/idb/Support/{FBObjCExceptionGuard+Guarded,SymbolLoading}.swift、DispatchQueue+Perform.swift` | `FBControlCore/Utility/ 下的同名文件、FBControlCore/Async/DispatchQueue+Perform.swift` | `14baeffc8f681380527c400a8184512b746ee918` | MIT | 只去掉访问修饰与 import |
| `Sources/WevirIOSSimulator/idb/Support/FBControlCoreShims.swift` | FBControlCore、FBSimulatorControl 里同名类型（日志、目标状态、Simulator、框架加载） | `14baeffc8f681380527c400a8184512b746ee918` | MIT | Wevir 写的最小替身，名字与签名照上游，好让移植文件保持原样；框架路径的规则（含 Xcode 27 的 SharedFrameworks）取自上游 |
| `Sources/WevirIOSSimulator/idb/Video/H264Encoder.swift` | `FBSimulatorVideo/Encoding/{VideoToolboxEncoderSettings,VideoToolboxFramePusher,PixelBufferConverter}.swift` | `14baeffc8f681380527c400a8184512b746ee918` | MIT | 只留 H.264，三个类型合成一个，直接交出 CMSampleBuffer；加了按设备方向旋转 |
| `Sources/WevirIOSSimulator/Accessibility.swift` | `FBSimulatorAX/Translation/{AXTranslationDispatcher,AXTranslationTransport}.swift` | `14baeffc8f681380527c400a8184512b746ee918` | MIT | 只取翻译器委托、CoreSimulator 传输与超时等待；元素经 AXPMacPlatformElement 读，树的序列化是 Wevir 写的 |
| `Sources/WevirIOSSimulator/Input.swift` | `Tools/SimScope/SimScope/Keymap.swift` | `14baeffc8f681380527c400a8184512b746ee918` | MIT | 只取键位表（字符到 USB HID 用法） |
| `Sources/ObjCExceptionGuard/{FBObjCExceptionGuard.m,include/FBObjCExceptionGuard.h}` | `FBControlCoreObjC/FBObjCExceptionGuard.m、include/FBObjCExceptionGuard.h` | `14baeffc8f681380527c400a8184512b746ee918` | MIT | 原样 |
| `PrivateHeaders/{CoreSimulator,CoreSimDeviceIO,SimulatorApp,AccessibilityPlatformTranslation}/**` | `PrivateHeaders/ 下的同名目录` | `14baeffc8f681380527c400a8184512b746ee918` | MIT | 原样（私有框架的头文件、module.modulemap 与 TBD 桩）；没有带 SimulatorKit 的头文件 |

`Devices.swift`、`Media.swift`、`Protocol.swift`、`Settings.swift` 与 `main.swift` 是 Wevir 写的，用上面的移植代码。

### 4.1 其他第三方来源的文件

不来自上面五个上游仓库、但含第三方作品的文件：由工具生成、从依赖包摘录，或是录下来的上游运行输出。根目录 [`NOTICE`](../../NOTICE) 同样列出它们。

| Wevir 文件 | 来源 | 许可证与版权 | 说明 |
|---|---|---|---|
| `apps/desktop/src/renderer/src/components/ui/{button,dialog,dropdown-menu,input,popover,scroll-area,sheet,textarea,tooltip}.tsx` | shadcn CLI 4.21.4 从官方 registry 生成（`components.json`：`base-nova`、Base UI、lucide） | MIT，`Copyright (c) 2023 shadcn` | T5.2 生成，dropdown-menu、popover 是 R12（`906fa63`）补生成的（U1 补登记）；button、dialog、dropdown-menu、popover、scroll-area、sheet、tooltip 有 Wevir 的改动，写在各自的文件头。OpenWork 的 `apps/app/src/components/ui/*` 也是 shadcn 生成的，两边相近属于同源（§9），不从 OpenWork 拷贝（§2.2 T0.5 复核第 1 点） |
| `apps/desktop/src/renderer/src/styles/shadcn-variants.css` | shadcn 4.21.4 包内 `dist/tailwind.css` 的摘录 | MIT，`Copyright (c) 2023 shadcn` | 只取原语用到的 `@custom-variant` |
| `packages/model-gateway/src/test-fixtures/codex-requests/**`、`packages/model-gateway/src/__snapshots__/codex-requests/**` | OpenAI Codex `rust-v0.162.1`（`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`）的 `codex-app-server` 发出的请求的录制（R1，`spikes/codex-app-server/src/record-requests.ts`），及其经网关转换后的快照 | Apache-2.0，`Copyright 2025 OpenAI` | 录的是 Codex 发给模型服务的请求体，不是源码。含 Codex 内置工具的定义与描述（apply_patch 的 Lark 语法等）与 Codex 注入的权限、skills、环境说明文字；基础提示词已换成长度说明，本机路径与 ID 换成占位符 |
| `packages/adapter-codex/src/test-fixtures/app-server/**` | OpenAI Codex `rust-v0.162.1`（`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`）的 `codex-app-server` 运行输出的录制（R2 起，`record-app-server.test.ts`）：通知序列、审批对话、回合与恢复的错误 | Apache-2.0，`Copyright 2025 OpenAI` | 录的是 app-server 发给客户端的消息，不是源码。含 Codex 的 item 结构、内置工具名、错误措辞（如 500 时的“We’re currently experiencing high demand…”）；本机路径换成占位符，审批对话里的 ID 换成占位符 |
| `packages/adapter-claude/src/test-fixtures/sdk/**` | Claude Code 2.1.287（本机 `claude`，`claude-haiku-4-5`）经 Claude Agent SDK 0.3.286 交出的消息的录制（2026-10-15，`record-sdk.test.ts`） | Claude Code 与 Claude Agent SDK 是 Anthropic 的商业条款（`© Anthropic PBC`） | 录的是 `claude` 发给 SDK 的消息与模型的回答，不是源码。含 Claude Code 的内置工具名与几段固定措辞（工具结果、“[Subagent hand-back] …” 等）；不读用户的设置，本机路径、用户的插件与命令清单抹掉 |
| `packages/adapter-opencode/src/test-fixtures/events/**` | opencode 1.18.34（`opencode-ai`，本机的 `opencode serve`，模型是 `test-fixtures/mock-model.ts` 的本机假服务）交出的事件流的录制（2026-10-15，`record-events.test.ts`） | MIT，`Copyright (c) 2025 opencode` | 录的是 opencode 服务器发给客户端的事件，不是源码；回答都是假模型的固定文字。含 opencode 的内置工具名、工具结果的几段固定措辞（拒绝审批时的 “The user rejected permission …”、task 的 `<task …>` 结果等）与它给子会话的权限规则；路径换成了占位符 |
| `packages/adapter-grok/src/test-fixtures/acp/*.ndjson` | T3 Code（MIT，`ec1313c8`）录的 xAI Grok Build 1.0.41 / 1.0.44 的 ACP 往返（`live-grok-recorder` 与 `live-grok-shape-probe`；T3 已把会话 ID、工作区、HOME 与 T3 的提示词换成占位符） | 文件以 MIT 随 T3 Code 发布；其中 Grok 的输出受 xAI 的条款约束 | adapter-grok 的样本回放与契约测试用（`../../packages/adapter-grok/src/test-fixtures/fake-grok.mjs`），产品代码不读 |
| `apps/desktop/src/renderer/src/components/{copy-glyph,glide,rolling-number,spinner}.tsx`、`components/toast.tsx`（叠放的布局）、`session/composer-button.tsx`（输入框的主按钮） | [kuratlielia/arc-library](https://github.com/kuratlielia/arc-library)（<https://uiarc.dev>）提交 `fff39c044c6e3b86006e3a6acc9a32a821a80d99` 的 `registry/components/` 下 copy-button（含 use-copy-feedback.ts）、toast-stack、floating-button-group 与 tabs、slot-text、button（加载圈；输入框主按钮的 primary 变体、按压与图标换场） | MIT，`Copyright (c) 2026 Elia Kuratli` | 只用免费的 MIT 部分，Pro 部分另有许可、不参考。Arc 用 motion 与 CSS modules，Wevir 照它的交互与布局参数改用 CSS 过渡和 theme.css 的弹簧令牌重写（`glide-mark`、`glide-group`、`digit-reel` 工具类），不引入 motion；修改说明在各文件头，署名在 `NOTICE` 第 18 节 |
| `apps/mobile/src/lib/bot-avatar-shapes.ts` | bot-avatars 0.1.2 包内 `dist/index.es.js` 的摘录（libraries.dev，<https://github.com/Jakubantalik/Libraries.dev>） | MIT，`Copyright (c) 2026 Jakub Antalik` | 手机端助理头像：只取桌面子会话头像用的六种形状（pebble、clover、drop、pill、circle、cloud）的路径与五官位置，原样照抄；画法在 `apps/mobile/src/lib/bot-avatar.ts` 按库的静止姿势重写，用 react-native-svg 画 |

### 4.2 字体

图标字体补充登记（2026-10-14）：`assets/icons/source/fonts/MonaSans-Bold.ttf` 与 `OFL.txt` 来自 [github/mona-sans](https://github.com/github/mona-sans/tree/4bc6ba8b354c36b4fb66d32cd67b4c1f2beb0a06) 的 `fonts/static/ttf/MonaSans-Bold.ttf` 与 `OFL.txt`，固定提交 `4bc6ba8b354c36b4fb66d32cd67b4c1f2beb0a06`，SIL OFL-1.1；版权为 `Copyright 2022 The Mona Sans Project Authors`，保留字体名 `Mona`。用于提取 Wevir 字标与社交横幅文案轮廓，派生数据为 `assets/icons/source/wordmark-paths.json`、`assets/icons/source/social-copy-paths.json`、各主题的 `wordmark.svg`、组合标识与横幅 SVG。字体来源说明在 `assets/icons/source/fonts/SOURCE.md`，派生 SVG 与转曲脚本带来源注释。主标与八个功能图标由 Wevir 自行设计，未从上游图标库移植。

桌面端随应用打包的字体（U1，2026-10-14）：`apps/desktop/src/renderer/src/assets/fonts/*.woff2` 由 `apps/desktop/scripts/build-fonts.py` 从固定版本生成（来源的 sha256 写在脚本里），来源说明在同目录的 `SOURCE.md`，各字体的 OFL 原文在 `apps/desktop/licenses/fonts/`，都是 SIL OFL-1.1：Mona Sans 2.0.27（[github/mona-sans](https://github.com/github/mona-sans) 发布包 `mona-sans-variable-v2.0.27.zip`，`Copyright 2022 The Mona Sans Project Authors`，保留字体名 `Mona`，只转 WOFF2、不改字形与名称）、JetBrains Mono 2.304（[JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono) 发布包，`Copyright 2020 The JetBrains Mono Project Authors`，只转 WOFF2）。

模型服务的标志（U6，2026-10-14）：`apps/desktop/src/renderer/src/assets/provider-logos/*.svg`（含 2026-10-15 新增的 `azure-color.svg`），原样取自 npm 包 `@lobehub/icons-static-svg@1.95.1`（[lobehub/lobe-icons](https://github.com/lobehub/lobe-icons)）的 `icons/` 目录，MIT，`Copyright (c) 2023 LobeHub`；文件与 sha256 在同目录的 `SOURCE.md`，署名在 `NOTICE` 第 9 节。标志是各公司的商标，只用来指认服务。

## 5. 移植文件的文件头

MIT 来源（OpenWork 的 MIT 区域）：

```ts
// SPDX-License-Identifier: MIT
// 移植自 different-ai/openwork apps/app/src/<path>.tsx
// 来源提交 ad22cdc2217370f28f24f0f8758016c2921e3c73
// Copyright (c) 2026-present Different AI, Inc.
// 修改：<改了什么>
```

Apache-2.0 来源（Paseo）：

```ts
// SPDX-License-Identifier: Apache-2.0
// 移植自 getpaseo/paseo packages/<path>.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra
// 由 Wevir 修改：<改了什么>
```

Apache-2.0 来源的 Markdown（Codex 的提示词模板，`prompts/*.md`）写在文件开头的 HTML 注释里，加载方渲染时删掉（prompts/README.md）：

```md
<!--
SPDX-License-Identifier: Apache-2.0
改写自 openai/codex codex-rs/<path>.md
来源提交 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d
Copyright 2025 OpenAI
由 Wevir 修改：<改了什么>
-->
```

由工具生成或从依赖包摘录的第三方文件（§4.1）写生成工具与版本、许可证与版权，再写 Wevir 的改动：

```ts
// 由 shadcn CLI 4.21.4 从官方 registry 生成（components.json：base-nova，Base UI，lucide）。
// MIT License，Copyright (c) 2023 shadcn。
// Wevir 的改动：<改了什么>
```

上游文件原有的版权与许可证注释原样保留在这几行下面。许可证全文不逐文件复制：移植与派生文件的许可证全文与版权声明在根目录 [`NOTICE`](../../NOTICE)，依赖的在分发物的第三方声明里（草稿与分发义务见 [third-party-notices.md](./third-party-notices.md)）。登记表、文件头、`NOTICE` 三处一起改。

## 6. 升级流程

1. **改 lock**：取上游分支最新提交，写进 `docs/upstream/upstream.lock`。
   ```bash
   git ls-remote https://github.com/different-ai/openwork refs/heads/dev
   ```
2. **同步**：`bash scripts/upstream-sync.sh`，确认每个仓库的 `git rev-parse HEAD` 与 lock 一致。
3. **看上游变更**：
   - OpenWork：`changelog/release-tracker-*.md`；
   - Paseo：根目录 `CHANGELOG.md`；
   - Codex：GitHub Releases（tag `rust-v*`）与根目录 `CHANGELOG.md`；协议面另用新版本的 `codex app-server generate-ts` 输出（或 `codex-rs/app-server-protocol/schema/`）与旧版本做 diff。
   同时对比新旧提交之间的许可证文件：
   ```bash
   git -C upstream/<名称> fetch --depth 1 origin <旧SHA>
   git -C upstream/<名称> diff <旧SHA> HEAD --stat -- LICENSE LICENSES NOTICE THIRD_PARTY_NOTICES.md ee/LICENSE
   ```
   许可证有变化，先更新本文件 §2 的结论。
4. **核对移植登记表**：§4 里每个来源文件在新提交下是否改动、移动或删除，需要的话同步修改 Wevir 文件并更新“来源提交”（文件头与 `NOTICE` 一起改）。然后按 §8 再做一次来源核查。
5. **跑契约测试**：`pnpm test`（包含 AgentRuntimeAdapter 契约测试）。升级 Codex 时按 §7 的检查清单逐项做。
6. **更新本文件 §1 仓库表**（提交、日期、结论），与 lock 改动放在同一个 commit 里。

## 7. Codex 升级检查清单

R3 建立。Codex 的 app-server 仍标 experimental（codex-notes §2.6），每个版本都可能改协议、通知与措辞。Wevir 碰 Codex 的代码都在 `packages/adapter-codex`（网关在 `packages/model-gateway`，与 Codex 版本无关，但它解析的是 Codex 发的请求），升级只改这两个包、§1 的表、`upstream.lock`、`scripts/fetch-codex.sh` 与下面列到的文档（ADR-0005 决策 7）。按顺序做，每一步的结论写进提交说明；哪一步发现不兼容，先在 ADR-0005 补记与 codex-event-mapping.md 写清楚，再改代码。下文的“旧 SHA / 新 SHA”是 `upstream.lock` 里 codex 行的旧锁定提交与新 tag `rust-v<版本>` 指向的提交，先按 §6 第 1、2 步把 `upstream/codex` 同步到新 SHA（tag 不在任何分支上，同步脚本按 tag 浅拉取）。

1. **读 release 说明。** GitHub Releases 里 `rust-v*` 的发布说明（Bug Fixes / Features），重点看 app-server、审批、沙箱、rollout 格式、模型 Provider 与配置键的变化。`codex-rs/app-server/README.md` 与 `codex-rs/docs/` 的改动一并看：

   ```bash
   git -C upstream/codex diff <旧SHA> <新SHA> --stat -- codex-rs/app-server codex-rs/app-server-protocol codex-rs/core/src/config codex-rs/features
   ```

2. **diff 协议 schema。** 稳定面以 `codex-rs/app-server-protocol/schema/typescript/`（及 `v2/`）为准，`packages/adapter-codex/src/protocol.ts` 的每个类型都注明了对应的 schema 文件，逐个对照：

   ```bash
   git -C upstream/codex diff <旧SHA> <新SHA> -- codex-rs/app-server-protocol/schema/typescript
   git -C upstream/codex diff <旧SHA> <新SHA> -- codex-rs/app-server-protocol/src/protocol/common.rs | grep -n "experimental"
   ```

   - 本包读写的字段改名、改类型、从稳定变成实验（`#[experimental]`）：改 `protocol.ts` 与用到的地方。Wevir 只用稳定面（`experimentalApi: false`），新出现的稳定字段不必用。
   - `CodexErrorInfo` 加了变体：对照 `turn-error.ts` 的归类（codex-event-mapping.md §6.7）。
   - 审批请求与回复（`CommandExecutionRequestApprovalParams`、`*ApprovalDecision`）变了：对照 §6.6 的选项表与终端界面 `tui/src/bottom_pane/approval_overlay.rs` 的 `exec_options` / `patch_options`。
   - 新的服务端请求：默认回复“不支持”，逐个决定要不要处理。
   - 配置键：`config.ts` 的加固项与 `title.ts` 的 `TITLE_THREAD_CONFIG` 在新版本里还在不在（进程带 `--strict-config`，写错的键启动就失败；`thread/start` 的覆盖不一定严格，要自己看 `core/src/config` 与 `features/src/lib.rs`）。`features` 的默认值变了（尤其新增的默认开启、会联网或进上下文的功能）要先决定关不关。

3. **更新锁定版本与校验和。**
   - `packages/adapter-codex/src/paths.ts` 的 `CODEX_VERSION`；`scripts/fetch-codex.sh` 的 `version` 与 6 个平台的 sha256（`codex-app-server` 与 `codex-code-mode-host` 各 6 个，Linux 另有 2 个 `bwrap`；取 GitHub Release API 的资产 `digest`，命令写在脚本开头）与 ripgrep 的版本、6 个 sha256（抄新锁定提交的 `scripts/codex_package/rg`，版本变了就重新下载核对）；`upstream.lock` 的 codex 行；本文件 §1 与 §1.2 的表；`spikes/codex-app-server` 不随产品升级。
   - CI 的二进制缓存键是 `fetch-codex.sh` 的内容，改了自动失效。
   - `bash scripts/fetch-codex.sh` 下载新二进制，`--version` 输出要与 `CODEX_VERSION` 一致。

4. **重新录制样本。** `WEVIR_RECORD_CODEX=1 pnpm vitest run --project adapter-codex record-app-server` 重录 `test-fixtures/app-server/` 下的通知样本、审批对话与错误样本（README.md 写了每类的格式），再看映射、归类测试与第 1 层：`git diff` 里样本的变化就是 Codex 行为的变化，逐条确认。审批对话的分支要对得上（同一场景几遍的 item 顺序一样），错误样本的措辞变了就同步改 `turn-error.ts` / `resume-error.ts` 的规则表与 codex-event-mapping.md §4.2、§6.7。

5. **跑三层契约测试与集成测试。**

   ```bash
   pnpm vitest run --project adapter-codex
   ```

   - 第 1 层回放（`codex-adapter.contract.test.ts`，用第 4 步新录的样本）与第 2 层真实二进制 + 网关 + mock 模型（`codex-adapter.contract.integration.test.ts`）：全部通过，能力开关全开，没有跳过的条款。
   - 第 3 层真实模型（`codex-adapter.contract.real.integration.test.ts`）：设 `WEVIR_TEST_API_KEY` 与 `WEVIR_TEST_PROVIDER` 在本机跑一次，结果贴进提交说明。
   - 审批、恢复与取消、计划、错误、标题与外连的集成测试（`codex-adapter.*.integration.test.ts`）一起跑；之后跑全仓 `pnpm test`（含 Host + 真实 Codex 的 `*.codex.integration.test.ts`）。

6. **外连审计。** `codex-adapter.isolation.integration.test.ts` 的外连用例经只记录目标的代理与 lsof 看进程的外连，必须仍为零（反例：打开 `features.plugins` 时抓到 chatgpt.com、github.com、api.github.com）。新版本新增的默认开启的功能（遥测、插件同步、更新检查、远程控制）要在这一步暴露出来；需要关的写进 `config.ts` 的加固项与 ADR-0005 决策 5 的补记。

7. **密钥检查。** 同一个测试文件的密钥用例：网关令牌与上游 Key 不出现在数据目录（含 CODEX_HOME 的 rollout、SQLite 库、`shell_snapshots/`）的任何文件、stderr 与日志里，模型跑的命令看不到 `WEVIR_*`。`env.ts` 的白名单与 `shell_environment_policy` 的排除规则按新版本核对一次（新版本可能读新的环境变量，例如别的 `*_API_KEY`）。

8. **网关与提示词。** Codex 发的 Responses 请求变了（新字段、新的输入项类型、`tool_choice` 等）：用 `spikes/codex-app-server/src/record-requests.ts`（`spikes/` 已移出公开仓库，只在维护者本机）重录 `packages/model-gateway/src/test-fixtures/codex-requests/`，跑网关的转换测试与快照（model-gateway.md）。`prompts/base.md` 的工具说明按新版本的工具清单核对（prompts/README.md「Codex 一回合里模型看到的说明」）；`prompts/` 下改写自 Codex 的文件按 §4 核对来源提交。

9. **ChatGPT 进程（R6）。** `account/*`、`model/list` 与 `v2/Account*.ts`、`LoginAccount*.ts`、`RateLimit*.ts`、`Model.ts` 的 schema 对照 `protocol.ts` 的“账号”一节；`cli_auth_credentials_store`、`forced_login_method`、`mcp_oauth_credentials_store`、`features.apps` 还在不在；登录服务与后端的地址与环境变量（`CODEX_APP_SERVER_LOGIN_ISSUER`、`CODEX_REFRESH_TOKEN_URL_OVERRIDE`、`chatgpt_base_url`、`openai_base_url`）、`/wham/accounts/check` 的形状变了没有。跑 `codex-runtime.chatgpt.integration.test.ts`（真实二进制 + mock 登录服务）；mock 的端点要跟着改。有真实 ChatGPT 账号时在桌面端登录一次、问一句，看外连（codex-event-mapping.md §8.5）。

10. **收尾。** ADR-0005 补记一条升级记录：版本、上游变化、映射或归类的改动、三层契约测试、外连与密钥检查的结果。`CODEX_VERSION` 变了以后，旧会话 `session.created` 里的 `engineVersion` 与之后 `session.resumed` 的不同，是预期的；rollout 格式不兼容时旧会话恢复会报 `session_lost`（会话只读），发版说明里要告诉用户。

## 8. 来源核查

T6.3 建立。登记表（§4、§4.1）、文件头与根目录 `NOTICE` 三处要一致。升级上游锁定提交（§6 第 4 步）、移植新文件的任务收尾、打包前各做一次：

1. **找带来源标记的文件。** 已跟踪的文件用下面的命令，还没提交的新文件另用 `grep -r` 查同一组标记；逐个与 §4、§4.1 对照，文件头的仓库、路径、SHA、许可证要与登记一致。

   ```bash
   git grep -n -I -E "SPDX-License-Identifier|移植自|改写自|由 shadcn CLI|摘自|Copyright" -- ':!docs' ':!upstream' ':!pnpm-lock.yaml'
   ```

   注释里写“参照”“做法参考”“Paseo A17”“openwork-notes §3.1”这类的是设计参考，不登记，由第 2 步确认没有带进代码。
2. **相似度检查。** 用 jscpd 把 Wevir 的源码（含未提交的）和 `upstream/` 下的上游仓库一起扫，只看一边是 Wevir、一边是上游的克隆。jscpd 装在仓库外的临时目录，不进仓库依赖。三遍：
   - 逐字：`--min-tokens 40 --min-lines 4`；
   - 忽略标识符与字面量：`--ignore-identifiers --ignore-literals --mode weak --min-tokens 50`，噪声大（import 块、对象字面量），逐条看 80 token 以上的；
   - 函数级 AST 相似：`--similarity 0.85 --kind ast --min-tokens 60`。

   共用参数：`--no-gitignore`（`upstream/` 被 gitignore）、`--cross-formats js-ts`、`-a`，排除 `node_modules`、`dist`、lockfile。另用逐字模式扫一遍 Markdown、JSON、YAML、SQL、Shell。OpenWork 的 `ee/` 也放进扫描范围，只用结果证明没有它的代码，不读其内容。再与打进渲染进程的依赖（highlight.js 的样式、shadcn 包的 `dist`、tailwindcss、tw-animate-css、marked）比一遍，找没写来源的摘录。
3. **结果写成下面的记录**，每次一节。

### T6.3（2026-10-14，上游锁定提交见 §1）

范围：325 个源码文件（ts、tsx、js、mjs、cjs、css、html、sql、sh、yml）与 219 个其他文本文件，含并行进行中、尚未提交的 T4.2 `apps/cli`（22 个源码文件）。jscpd 5.3.3。

- **带来源头部的文件**：OpenWork MIT 区域的移植 7 个（§4），shadcn 生成或摘录的 8 个与 Radix Colors 生成的 1 个（§4.1）。补登记 1 个：`theme-init.js` 此前没有文件头，只在 `theme.ts` 一行的来源里提到。
- **Paseo 与 dsh**：没有移植它们的源码。Paseo 的 A13、A17、A21 等只在 `host-lifecycle.ts`、`runtime-file.ts`、`transport.ts` 等的注释里作为设计参考，扫描没有命中它们的实现。
- **OpenWork `ee/`**：没有。代码、`package.json` 与 lockfile 里都没有 `@openwork-ee/*`。命中的都是通用写法：逐字 1 处（`connection-banner.tsx` 的“已复制”提示复位：`useState` + `useEffect` + `setTimeout`，5 行）；忽略标识符后 34 处、最大 89 token，是 import 块、`debug/info/warn/error` 这类对象字面量与同一写法；AST 相似 0 处。
- **逐字**：27 处，分布在 5 个文件。`markdown.ts` ↔ `markdown-primitive.ts` 4 段（已登记）；`palette.css` ↔ OpenWork `colors.css` 20 段（都是 Radix Colors 的色值）；`tooltip.tsx` ↔ OpenWork 的同名文件（都是 shadcn 生成）；以及上面的 `ee/` 1 处、`spikes/dsh-acp/src/mock-llm.ts` 的 http server 关闭写法 1 处。
- **忽略标识符与字面量**：582 处，分布在 82 个文件；80 token 以上 18 处，除已登记与同源生成的以外都是结构相同的数据：`theme.css` 的 `@theme inline` 映射与 `tokens.css` 的变量名 ↔ OpenWork `index.css`（都按 shadcn 的变量命名约定，取值由 Wevir 自定）、`zh-CN.ts` ↔ dsh 的 `en.ts`（键值表）、`env.ts` ↔ dsh 的文件类型表（字符串数组）、仓储的 `fromRow` 与 logger 的方法表（对象字面量）。
- **AST 相似**：13 处，分布在 11 个文件。shadcn 生成的 `sheet`、`dialog`、`tooltip`、`scroll-area` ↔ OpenWork 的同名文件；`markdown.ts` 已登记；`dsh-adapter.ts` 与 `dsh-process.ts` 的 `settledWithin` ↔ Paseo `acp-agent.test.ts` 的 `settlesWithin`（`Promise.race` 加超时、`finally` 清计时器，10 行的通用写法）；其余是测试里的断言表。
- **其他文本文件**：1 处，`spikes/dsh-acp/fixtures/sdk/mock/events/session.event_request_header.json` ↔ dsh `snapshots/sdk/bash-tool/tool-schemas.expected.json`，是 dsh 运行输出的录制（§4.1）。
- **与依赖比对**：只有 `shadcn-variants.css` ↔ shadcn `dist/tailwind.css`，已登记。
