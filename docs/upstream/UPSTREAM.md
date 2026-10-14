# 上游参考快照与许可证

> 建立于 T0.2（2026-10-12）。锁定提交以 [`upstream.lock`](./upstream.lock) 为准，本文件记录对应的核实结论。

`upstream/` 是四个上游仓库的只读浅克隆，已被 gitignore。不修改、不提交其中任何文件。复现或更新：

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
| `codex`（OpenAI Codex） | https://github.com/openai/codex | tag `rust-v0.162.1` | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | 2026-10-09 | 2026-10-14 | **Apache-2.0**，带 `NOTICE`（见 §2.4） |

补充：

- dsh 的锁定提交就是 tag `dsh-v0.2.1-alpha.2` 指向的提交（GitHub compare 结果 `identical`），与 T0.3 锁定的 npm 版本 `@deepseek-ai/dsh@0.2.1-alpha.2` 是同一份源码。
- codex 锁定的是 release tag `rust-v0.162.1` 指向的提交（2026-10-14 时的最新 release），与 `spikes/codex-app-server` 下载的二进制同一版本，源码与运行的程序一致。Codex 的 release 提交不在任何分支上（与 `main` 分叉：领先 4 个版本号提交，落后 245 个），所以 lock 的“分支”一栏写 tag，`upstream-sync.sh` 的回退路径按 tag 浅拉取。

### 1.1 作为依赖运行的 npm 包

写精确版本（ADR-0001 §1、ADR-0004 §2）。dsh 只在 `packages/adapter-dsh/package.json` 声明；ACP SDK 从 R7 起只在 `packages/adapter-acp/package.json` 声明（通用 ACP 适配器），adapter-dsh 与它的测试经 `@wevir/adapter-acp` 及其子路径 `./sdk` 使用。

| npm 包 | 锁定版本 | npm `latest`（2026-10-12） | 许可证 | 说明 |
|---|---|---|---|---|
| `@deepseek-ai/dsh` | `0.2.1-alpha.2` | `0.2.0-rc.2` | MIT | 与上表 dsh 锁定提交同源；`packages/adapter-dsh/src/paths.ts` 的 `DSH_VERSION` 与之相同，解析到别的版本时启动报错 |
| `@agentclientprotocol/sdk` | `1.4.0` | `1.8.0` | Apache-2.0（Zed Industries） | 与 dsh-acp 自己锁定的版本相同；peer `zod` 由 pnpm 自动安装为工作区里的 4.6.x |

### 1.2 作为二进制运行的上游程序

R2（2026-10-14）起产品开始用它：`packages/adapter-codex` 以子进程运行 `codex-app-server`（ADR-0005 决策 1，[codex-event-mapping.md](../architecture/codex-event-mapping.md)）。开发环境用 `scripts/fetch-codex.sh` 下载到仓库的开发缓存，或用 `WEVIR_CODEX_BIN` 指定；安装包内置由 R9 做（决策 8）。版本必须与 adapter-codex 的 `CODEX_VERSION` 一致，启动前用 `--version` 核对。

| 程序 | 版本 | 来源 | 校验 | 用处 |
|---|---|---|---|---|
| `codex-app-server`（独立二进制） | `rust-v0.162.1` | GitHub Release 资产 `codex-app-server-<target>.tar.gz`（Windows 是 `codex-app-server-<target>.exe.tar.gz`） | 6 个平台（macOS arm64 / x64、Linux musl x64 / arm64、Windows x64 / arm64）的 sha256 写在 `scripts/fetch-codex.sh`，取自 GitHub API 的 `digest` | `packages/adapter-codex`：下载到 gitignore 的 `.wevir-dev/bin/`，CI 按脚本内容缓存；`spikes/codex-app-server` 仍用它自己的 `scripts/fetch-binary.sh`（下载到 `.bin/`，只有 4 个平台） |

同一个 release 还有 `codex-app-server-package-<target>.tar.gz`（压缩后大 20–40 MiB），R2 没有用；随包需要哪些附带程序（例如 Linux 的 `bwrap`）由 R9 定（§2.4）。

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

- Wevir 把 dsh **作为锁定版本的依赖运行，不移植源码**（SKELETON_PLAN §1.2）。分发 dsh 时随附它的 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`。
- `THIRD_PARTY_NOTICES.md` 里有不属于宽松许可证的运行时依赖：`@deepseek-ai/libreoffice-kit*`（MPL-2.0，需让接收者能拿到对应源码）、`@anthropic-ai/claude-agent-sdk` 及其平台包（`SEE LICENSE IN README.md` / `LICENSE.md`，专有条款）。
- **npm 依赖闭包的初步核对**（T0.6，依据 `spikes/dsh-acp/package-lock.json`：`@deepseek-ai/dsh@0.2.1-alpha.2` 加 `dsh-sdk-client`、`@agentclientprotocol/sdk@1.4.0`，npm 11 安装，共 632 个包，含各平台的可选包条目）：
  - **没有** `@anthropic-ai/claude-agent-sdk`；`@anthropic-ai/sdk` 0.129.0 是 MIT。
  - MPL-2.0：`@deepseek-ai/libreoffice-kit` 0.1.5 及其 5 个平台 / wasm 可选包，由 `dsh-office-to-pdf`、`dsh-skill-office` 引入。分发时要让接收者能拿到对应源码。
  - LGPL-3.0-or-later：`sharp` 0.35.5（本身 Apache-2.0，由 `dsh-attachment-local` 引入）的预编译 libvips 包 `@img/sharp-libvips-*`，以及 `@img/sharp-win32-*`（`Apache-2.0 AND LGPL-3.0-or-later`）、`@img/sharp-wasm32`。分发时要满足 LGPL-3.0 对所用库的义务（随附许可证、提供对应源码或获取方式、以用户可替换的共享库形式使用），具体条款由 T6.3 按 LGPL-3.0 第 4 条逐项核对。
  - 其余均为宽松许可证（MIT、ISC、Apache-2.0、BSD、0BSD、BlueOak、CC0、CC-BY-4.0、Python-2.0 等）。
  - 这只是 Spike 环境下的结果。T3.1 改用 pnpm 安装后重新核对一次；桌面端打包 dsh 前（T6.3 / 打包阶段）按实际打进安装包的文件再核对，并据此生成第三方声明。
- **pnpm 安装后的复核**（T3.1，2026-10-13，依据 `pnpm-lock.yaml`）：从 importer `packages/adapter-dsh` 沿 `snapshots` 的 `dependencies` 与 `optionalDependencies` 走出生产依赖闭包，含所有平台的可选包，共 622 个 name@version（Spike 的 632 个里多了 `dsh-sdk-client` 及其依赖）。已安装的 552 个读各自 `package.json` 的 `license`，其他平台的 70 个用 `npm view <包>@<版本> license` 查。结论与 T0.6 一致：
  - 计数：MIT 497、Apache-2.0 71、BSD-3-Clause 18、ISC 10、BSD-2-Clause 2，以及 0BSD、Unlicense（`fast-sha256`）、Python-2.0（`argparse`）、`(MIT OR CC0-1.0)`（`type-fest`）各 1。
  - MPL-2.0（6 个）：`@deepseek-ai/libreoffice-kit` 0.1.5 及其 `darwin-arm64`、`darwin-x64`、`win32-arm64`、`win32-x64`、`wasm` 可选包。
  - 含 LGPL-3.0-or-later（14 个）：`@img/sharp-libvips-*` 1.3.4 共 10 个（LGPL-3.0-or-later），`@img/sharp-win32-{arm64,ia32,x64}` 0.35.5（`Apache-2.0 AND LGPL-3.0-or-later`），`@img/sharp-wasm32` 0.35.5（`Apache-2.0 AND LGPL-3.0-or-later AND MIT`）。
  - 仍然**没有** `@anthropic-ai/claude-agent-sdk`；`@anthropic-ai/sdk` 0.129.0 为 MIT。`sherpa-onnx-node` 1.13.8 及其平台包为 Apache-2.0。
  - `pnpm licenses list --prod` 不列出可选的平台包（本机已安装的 `@img/sharp-libvips-darwin-arm64`、`libreoffice-kit-darwin-arm64` 也不在其中），所以不能用它代替上面的闭包核对。
- **T6.3 复核**（2026-10-14，同一方法，依据当时工作区的 `pnpm-lock.yaml`）：闭包仍是 622 个 name@version（已安装 554 个、`npm view` 68 个），各许可证计数、MPL-2.0 的 6 个与含 LGPL-3.0-or-later 的 14 个都与 T3.1 相同，仍然没有 `@anthropic-ai/claude-agent-sdk`。看了已安装的包的实际内容，补充四点，分发时的做法见 [third-party-notices.md](./third-party-notices.md)：
  - `@deepseek-ai/dsh` 的 npm 包里只有 `LICENSE`，**没有** `THIRD_PARTY_NOTICES.md`，分发时从锁定提交的上游仓库取。
  - `@img/sharp-libvips-*` 包里没有 LGPL 许可证全文，只有 README 里的许可证表：libvips 与 glib、pango、fribidi、libheif、librsvg、libexif、proxy-libintl 为 LGPLv3，cairo 为 MPL-1.1，aom 为 BSD-2-Clause 加 AOM 专利许可，其余为宽松许可证；各库版本在包内 `versions.json`。macOS 上 `sharp-*.node` 经 `@rpath` 动态链接 `libvips-cpp.*.dylib`；`@img/sharp-wasm32` 把 libvips 编进了 wasm，不是可替换的共享库。
  - `@deepseek-ai/libreoffice-kit-<平台>` 自带 `licenses/`（LibreOffice 的 MPL-2.0 与第三方声明、dsh 的 MIT）与 `sources/`（LibreOffice core 的上游提交、改动补丁与构建脚本），这就是 MPL-2.0 要求的源码获取途径；`@deepseek-ai/libreoffice-kit` 另有 `NOTICE`。
  - 已安装的 554 个包里只有 `@deepseek-ai/libreoffice-kit` 带 `NOTICE` 文件；71 个 Apache-2.0 包中已安装的都没有，Apache-2.0 第 4(d) 条的 NOTICE 义务目前不涉及。没装的平台包（`@img/sharp-*`、`sherpa-onnx-*` 等）按同系列已安装的包推断，打包时按实际打进的文件再看一次。
- **构建脚本**（T3.1，`pnpm-workspace.yaml` 的 `allowBuilds`，键带精确版本）：pnpm 报出的与 T0.3 在 npm 下相同的 5 个包。放行 `@deepseek-ai/dsh-subprocess-local`（给 node-pty 的 `spawn-helper` 恢复执行位）、`node-pty`（缺预编译时 node-gyp 编译；Windows 上放置 ConPTY 的 DLL）、`koffi`（验证预编译可加载，否则 CMake 编译）；拒绝 `@google/genai`（只有 `echo` 的 preinstall）与 `protobufjs`（只打印版本前缀警告）。与上游 dsh 仓库自己的 `allowBuilds` 取舍一致。
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

T0.5 复核（[openwork-notes.md §7](../research/openwork-notes.md)）确认以上结论成立，并补充三点：

1. **MIT 区域里有未署名的第三方派生内容**。移植时要另外保留原始版权声明，或者直接从原始来源获取：
   - `apps/app/src/styles/colors.css`：Radix Colors 生成的数值（MIT，© WorkOS）。Wevir 改为直接依赖 `@radix-ui/colors`。
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

移植 Paseo 代码时的义务（Apache-2.0 第 4 条起；骨架阶段按计划不移植 Paseo 代码，此处为后续阶段预先写明）：

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

- 移植了四份提示词文本（§4 的 `prompts/*.md`，ADR-0005 补记 2），没有移植代码。它们按 Apache-2.0 第 4 条处理：文件头写明来源、版权与修改（4(b)、4(c)），根目录 `NOTICE` 收录 Codex `NOTICE` 中与之相关的署名（`OpenAI Codex`、`Copyright 2025 OpenAI`）与 Apache License 2.0 全文（4(a)、4(d)）；Ratatui 那一条只涉及 TUI 代码，与这些文件无关，不收录。将来随安装包分发 `codex-app-server` 二进制时，按 Apache-2.0 第 4 条随附 `LICENSE` 全文与 `NOTICE` 的署名内容（4(a)、4(d)），由打包任务汇总进第三方声明；Linux 包若带上 `bwrap`，另按 LGPL-2.0 提供其源码获取方式。
- 二进制里静态链接的 Rust crate 闭包（`codex-rs/Cargo.lock`）的许可证在打包前另做一次核对，方法同 §2.1 对 npm 闭包的做法。
- 不得使用 OpenAI 或 Codex 的名称与商标，说明来源的用途除外（Apache-2.0 第 6 条）。

## 3. 各仓库的参考重点

与 SKELETON_PLAN §3 保持一致，以下路径在锁定提交下均已确认存在。

- **dsh**（作为依赖，读文档和接口，不移植）：`docs/architecture.zh.md`、`docs/agent-lifecycle.zh.md`、`docs/capability-seams.zh.md`、`packages/acp/acp/README.zh.md`、`packages/sdk/{client,protocol,server}/README.zh.md`、`docs/user/guide/providers.md`。
- **OpenWork**（桌面产品与交互参考，仅 MIT 区域）：`apps/app`（React + Vite + Tailwind v4 主界面）、`apps/desktop`（Electron 壳）、`apps/server`、`packages/ui`、`packages/sdk`、`packages/types`、`docs/architecture`。**`ee/` 排除**。
- **Paseo**（多端与远程架构参考，骨架阶段不移植）：`packages/server`（daemon）、`packages/protocol`（`@getpaseo/protocol`）、`packages/client`、`packages/relay`、`packages/app`（Expo）、`packages/desktop`、`packages/cli`、`public-docs/sdk`。
- **Codex**（Agent 运行时候选，作为二进制运行，读协议与源码，不移植）：`codex-rs/app-server/README.md` 与 `codex-rs/app-server-protocol/`（`schema/typescript/`、`schema/json/` 是这个版本生成的协议类型）、`codex-rs/model-provider-info/`（`[model_providers]` 配置）、`codex-rs/codex-api/src/sse/responses.rs`（解析模型流的事件）、`codex-rs/core/tests/common/responses.rs`（Responses SSE 的测试帮手）、`codex-rs/models-manager/`（模型目录）、`codex-rs/config/`（配置键）、`codex-rs/linux-sandbox/README.md`、`codex-rs/mxc-sandbox/README.md`。研读结论见 [docs/research/codex-notes.md](../research/codex-notes.md)。

## 4. 移植登记表

每移植一个文件（含大幅改写后仍可辨认出来源的文件）登记一行。“来源提交”写完整 SHA。

| Wevir 文件 | 来源路径 | 来源提交 | 许可证 | 修改说明 |
|---|---|---|---|---|
| `packages/client-sdk/src/lifecycle.ts` | OpenWork `apps/app/src/react-app/domains/session/sync/sync-stream-lifecycle.ts` | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | MIT | 改写（T4.1，OpenWork 候选 #1）：从事件流 SSE 的重连改为 Host 连接（建立传输 + `host.hello`）的重连状态机。保留两套指数退避（普通 1 s → 10 s、鉴权类 5 s → 60 s）、单一重试计时器、换代时重置退避并立即重连、换代前发起的尝试报的鉴权失败按普通失败处理；阶段改为 connecting / connected / reconnecting / closed，新增不可恢复的失败与首次连接失败即关闭；静默看门狗移到每条连接上（`rpc-channel.ts` 的心跳超时）；去掉诊断历史 |
| `apps/desktop/src/renderer/src/theme/theme.ts` | OpenWork `apps/app/src/app/theme.ts` | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | MIT | 移植（T5.2，OpenWork 候选 #17），修掉两处问题：首帧前脚本只读旧 key（Wevir 的 `public/theme-init.js` 与运行时共用 `shared/theme.ts` 的 `THEME_STORAGE_KEY`，测试核对）；暗色同时认 `.dark` 类（只写 `data-theme`，CSS 的暗色变体也只认它，`color-scheme` 由 tokens.css 设置）。另外去掉旧 key 迁移，nativeTheme 经 preload 的 `setThemeSource` 同步，加 `useTheme` |
| `apps/desktop/src/renderer/public/theme-init.js` | OpenWork `apps/app/index.html` 第 19–32 行的内联脚本 | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | MIT | 移植（T5.2，候选 #17 的首帧前脚本；T6.3 补上文件头与本行，此前只在上一行的来源里提到）：改为单独的普通脚本文件（生产 CSP 不放行内联脚本）；存储 key 换成 `THEME_STORAGE_KEY`；不认识的值按跟随系统处理，与 `theme.ts` 一致（`shared/theme.test.ts` 在 `node:vm` 里核对）；只写 `data-theme`，不写内联 `color-scheme` |
| `apps/desktop/src/renderer/src/session/markdown/markdown.ts` | OpenWork `apps/app/src/components/markdown/markdown-primitive.ts` | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | MIT | 改写（T5.3，OpenWork 候选 #4）：保留 `createStreamingMarkdownRenderer`（流式时只重新 lex 末尾 2 个块、已定的块复用同一个 `{__html}`、有引用式链接定义时整篇重来）与 DOMPurify 清洗；去掉 emoji、KaTeX、Mermaid、会话引用、favicon、视频与图片预览、Shiki。渲染器输出几乎不带类名的语义 HTML（样式在 `styles/markdown.css`），表格对齐用 `align` 属性、图片只显示为链接（CSP 不放行内联样式与外部图片），原文 HTML 按文本显示；高亮另在 `highlight.ts` 用 highlight.js 做（ADR-0004 补记 6） |
| `apps/desktop/src/renderer/src/session/scroll-controller.ts` | OpenWork `apps/app/src/react-app/domains/session/surface/scroll-controller.ts`（另参照同目录 `scroll-store.ts`、`scroll-overlay.tsx`） | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | MIT | 改写（T5.3，OpenWork 候选 #3）：保留贴底 / 手动两种模式的状态机（只有真实输入手势能切换模式、ResizeObserver 对账、`overflow-anchor` 随模式切换、键盘焦点把旧内容滚进视野时转手动、发送即回到贴底）；去掉移动端轮次留白、滚动位置与几何信息的持久化、历史分页、“跳到消息开头”，状态不进全局 store，只交出“是否贴底”给“跳到最新”按钮 |
| `apps/desktop/src/renderer/src/session/tool-model.ts` | OpenWork `apps/app/src/lib/tool-aggregate.ts`、`apps/app/src/lib/current-tool-lifecycle.ts` | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | MIT | 改写（T5.3，OpenWork 候选 #6）：分类从 OpenCode 工具名换成 Wevir 的展示类型（`ToolDisplay.kind`），只聚合读取与搜索；标题改为中文计数；聚合内的思考按原顺序保留；“回合停止后未收尾的工具显示状态未知”照搬，另加“被拒绝” |
| `apps/desktop/src/renderer/src/session/approval-card.tsx` | OpenWork `apps/app/src/react-app/domains/session/chat/permission-approval-modal.tsx` | `ad22cdc2217370f28f24f0f8758016c2921e3c73` | MIT | 改写（T5.3，OpenWork 候选 #9）：保留输入框上方的内联面板、一次只显示第一个、可折叠的完整参数；按钮按审批请求携带的选项渲染，内容取同一 `toolCallId` 的 `rawInput`（`ApprovalRequest.detail`），标出“还有 N 个待审批”，另一端先处理时按 `approval.resolved` 收起并提示处理者 |
| `prompts/base.md` | Codex `codex-rs/protocol/src/prompts/base_instructions/default.md` | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | Apache-2.0 | 改写（ADR-0005 补记 2）：用中文重写并重排；自我介绍改为 Wevir 与实际的底层模型；保留 AGENTS.md 规则、编辑与 git 约束、验证、审查、`update_plan` 的用法；按 Wevir 的 Codex 配置重写工具说明并补上子智能体；新增授权与确认、不可信内容、过程说明与最终回答、中文写作要求；skills、插件、MCP、联网搜索留占位 |
| `prompts/plan-mode.md` | Codex `codex-rs/collaboration-mode-templates/templates/plan.md` | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | Apache-2.0 | 改写（ADR-0005 补记 2）：用中文重写，结构与规则不变；补充只读阶段能做与不能做的例子，最终计划的小节名改为中文，`<proposed_plan>` 标签保持原样 |
| `prompts/auto-review.md` | Codex `codex-rs/prompts/templates/guardian/policy_template.md`、`policy.md`、`node_repl_policy.md` | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | Apache-2.0 | 改写（ADR-0005 补记 2）：用中文重写并合并三份模板，默认策略写进正文，组织策略改为用户配置的可信目的地与补充规则；输入改为 Host 拼装的 `<transcript>` 与 `<planned_action>`；第一版不给复核员工具，“先做只读检查”改为“信息不足时从严”；补充国内常见的外发目的地；`rationale` 用用户的语言 |
| `prompts/thread-title.md` | Codex `codex-rs/tui/src/app/thread_title.rs`（`thread_title_instructions` 等函数里的说明文字） | `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d` | Apache-2.0 | 改写（ADR-0005 补记 2）：用中文重写标题规则；中文与其他语言分别给长度上限；增加检索摘要字段；补充只有链接或编号、寒暄、按最近对话重新生成三种情况；示例改为中文为主 |

### 4.1 其他第三方来源的文件

不来自上面四个上游仓库、但含第三方作品的文件：由工具生成、从依赖包摘录，或是录下来的上游运行输出。根目录 [`NOTICE`](../../NOTICE) 同样列出它们。

| Wevir 文件 | 来源 | 许可证与版权 | 说明 |
|---|---|---|---|
| `apps/desktop/src/renderer/src/components/ui/{button,dialog,input,scroll-area,sheet,textarea,tooltip}.tsx` | shadcn CLI 4.21.4 从官方 registry 生成（`components.json`：`base-nova`、Base UI、lucide） | MIT，`Copyright (c) 2023 shadcn` | T5.2 生成；button、dialog、scroll-area、sheet 有 Wevir 的改动，写在各自的文件头。OpenWork 的 `apps/app/src/components/ui/*` 也是 shadcn 生成的，两边相近属于同源（§9），不从 OpenWork 拷贝（§2.2 T0.5 复核第 1 点） |
| `apps/desktop/src/renderer/src/styles/shadcn-variants.css` | shadcn 4.21.4 包内 `dist/tailwind.css` 的摘录 | MIT，`Copyright (c) 2023 shadcn` | 只取原语用到的 `@custom-variant` |
| `apps/desktop/src/renderer/src/styles/palette.css` | `apps/desktop/scripts/generate-palette.ts` 从依赖 `@radix-ui/colors` 3.0.0 生成 | MIT，`Copyright (c) 2021 Radix` | 色值数据，文件头带声明。与 OpenWork `colors.css` 的色值相同是因为同源，不从那里拷贝 |
| `packages/model-gateway/src/test-fixtures/codex-requests/**`、`packages/model-gateway/src/__snapshots__/codex-requests/**` | OpenAI Codex `rust-v0.162.1`（`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`）的 `codex-app-server` 发出的请求的录制（R1，`spikes/codex-app-server/src/record-requests.ts`），及其经网关转换后的快照 | Apache-2.0，`Copyright 2025 OpenAI` | 录的是 Codex 发给模型服务的请求体，不是源码。含 Codex 内置工具的定义与描述（apply_patch 的 Lark 语法等）与 Codex 注入的权限、skills、环境说明文字；基础提示词已换成长度说明，本机路径与 ID 换成占位符 |
| `packages/adapter-codex/src/test-fixtures/app-server/**` | OpenAI Codex `rust-v0.162.1`（`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`）的 `codex-app-server` 运行输出的录制（R2 起，`record-app-server.test.ts`）：通知序列、审批对话、回合与恢复的错误 | Apache-2.0，`Copyright 2025 OpenAI` | 录的是 app-server 发给客户端的消息，不是源码。含 Codex 的 item 结构、内置工具名、错误措辞（如 500 时的“We’re currently experiencing high demand…”）；本机路径换成占位符，审批对话里的 ID 换成占位符 |
| `spikes/dsh-acp/fixtures/**`、`packages/adapter-dsh/src/test-fixtures/acp/**` | dsh 0.2.1-alpha.2 运行时输出的录制（T0.3 起） | MIT，`Copyright (c) 2026 DeepSeek` | 录的是 dsh 发出的协议消息与事件，不是源码。`spikes/dsh-acp/fixtures/sdk/mock/events/session.event_request_header.json` 含 dsh 内置工具的 schema 与描述文本，与上游 `snapshots/sdk/bash-tool/tool-schemas.expected.json` 相同 |

### 4.2 图标字体

图标字体补充登记（2026-10-14）：`assets/icons/source/fonts/MonaSans-Bold.ttf` 与 `OFL.txt` 来自 [github/mona-sans](https://github.com/github/mona-sans/tree/4bc6ba8b354c36b4fb66d32cd67b4c1f2beb0a06) 的 `fonts/static/ttf/MonaSans-Bold.ttf` 与 `OFL.txt`，固定提交 `4bc6ba8b354c36b4fb66d32cd67b4c1f2beb0a06`，SIL OFL-1.1；版权为 `Copyright 2022 The Mona Sans Project Authors`，保留字体名 `Mona`。仅用来提取 Wevir 字标轮廓，派生数据为 `assets/icons/source/wordmark-paths.json`、各主题的 `wordmark.svg` 与组合标识 SVG。字体来源说明在 `assets/icons/source/fonts/SOURCE.md`，派生 SVG 与转曲脚本带来源注释。主标与八个功能图标由 Wevir 自行设计，未从上游图标库移植。

## 5. 移植文件的文件头

MIT 来源（dsh、OpenWork 的 MIT 区域）：

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
   - dsh：GitHub Releases（tag `dsh-v*`）和 `docs/persistence-changes/releases/`（会话持久化格式变化）；
   - OpenWork：`changelog/release-tracker-*.md`；
   - Paseo：根目录 `CHANGELOG.md`；
   - Codex：GitHub Releases（tag `rust-v*`）与根目录 `CHANGELOG.md`；协议面另用新版本的 `codex app-server generate-ts` 输出（或 `codex-rs/app-server-protocol/schema/`）与旧版本做 diff。
   同时对比新旧提交之间的许可证文件：
   ```bash
   git -C upstream/<名称> fetch --depth 1 origin <旧SHA>
   git -C upstream/<名称> diff <旧SHA> HEAD --stat -- LICENSE LICENSES NOTICE THIRD_PARTY_NOTICES.md ee/LICENSE
   ```
   许可证有变化，先更新本文件 §2 的结论。
4. **核对移植登记表**：§4 里每个来源文件在新提交下是否改动、移动或删除，需要的话同步修改 Wevir 文件并更新“来源提交”（文件头与 `NOTICE` 一起改）。然后按 §9 再做一次来源核查。
5. **跑契约测试**：`pnpm test`（M1 起包含 AgentRuntimeAdapter 契约测试，M3 起包含 dsh 适配器的回放与真实 dsh 两层契约测试）。升级 dsh 时按 §7 的检查清单逐项做。
6. **更新本文件 §1 仓库表**（提交、日期、结论），与 lock 改动放在同一个 commit 里。

## 7. dsh 升级检查清单

T3.6 建立。dsh 是 developer preview，会有不兼容变更（SKELETON_PLAN §1.2）。Wevir 碰 dsh 的代码都在 `packages/adapter-dsh`，升级只改这个包、§1 的表和下面列到的文档。按顺序做，每一步的结论写进提交说明。哪一步发现不兼容，先改 ADR-0001 补记与对应的架构文档，再改代码（AGENTS.md）。下文的“旧 SHA / 新 SHA”是 `upstream.lock` 里 dsh 的旧锁定提交与新 tag `dsh-v<版本>` 指向的提交，先按 §6 第 1、2 步把 `upstream/deepseek-harness` 同步到新 SHA。

1. **读上游变更。** dsh 仓库没有 CHANGELOG 文件，变更记录分在三处，再加上旁路依赖的一处内部接口：
   - GitHub Releases 里 `dsh-v*` 的发布说明。
   - `docs/persistence-changes/releases/`：各版本的会话日志格式变化。格式不兼容时，旧会话 resume 报 `session_lost`（`incompatible`，ADR-0001 补记 6），会话变成只读；发版说明里要告诉用户。
   - `packages/acp/acp/README.zh.md` 的“已知限制与延期工作”：与 SKELETON_PLAN §3.1 的缺口表、ADR-0001 逐条对照。缺口补上了（例如 ACP 自己发增量、工具带 `locations` / `diff`、支持 `session/load`），Wevir 的补偿（旁路、Host 侧的历史与列表）可能变得重复或冲突；多了新限制，先补 ADR。
   - 旁路依赖的进程内事件 `agent/assistant-stream`：帧的形状在 `packages/core/agent/src/runtime-types.ts`（`AssistantStreamFrame`）。它不是 dsh 的公开契约（ADR-0001“后果”），改名、改形状都不会写进发布说明。

   ```bash
   git -C upstream/deepseek-harness diff <旧SHA> <新SHA> --stat -- \
     docs/persistence-changes/releases packages/acp/acp packages/core/agent/src/runtime-types.ts
   ```

2. **更新锁定版本，dsh 与 `@agentclientprotocol/sdk` 一起核对。** ACP SDK 取新 dsh 的 `packages/acp/acp/package.json` 锁定的版本（当前两者是 `0.2.1-alpha.2` 与 `1.4.0`），不单独追 npm 的 `latest`。npm 上 dsh 的 `latest` 标签可能落后于要用的版本（§1.1），一律写精确版本。要改的地方：
   - `packages/adapter-dsh/package.json`（dsh）与 `packages/adapter-acp/package.json`（ACP SDK），都写精确版本；`packages/adapter-dsh/src/paths.ts` 的 `DSH_VERSION`；
   - `docs/upstream/upstream.lock` 与本文件 §1、§1.1 的表；
   - SKELETON_PLAN §1.4 与 §3.1 里的版本号。

   然后 `pnpm install`。换了版本的构建脚本会报 `ERR_PNPM_IGNORED_BUILDS`，留到第 6 步审查。

3. **重新录制 fixtures。** 样本来源见 `packages/adapter-dsh/src/test-fixtures/README.md`。
   - T0.3 的 ACP 样本：把 `spikes/dsh-acp/package.json` 里三个包的版本改成新的，`npm install` 后运行 `npm run spike:mock`（不需要 Key，约 25 秒）。用 `spikes/dsh-acp/fixtures/acp/` 替换 `packages/adapter-dsh/src/test-fixtures/acp/` 中来自 T0.3 的文件，`errors/` 下 T3.2、T3.5 补录的 8 个除外；`stream-tap/frames.sample.json` 同样从 `spikes/dsh-acp/fixtures/stream-tap/mock/` 取。有 Key 时再跑一次 `npm run spike`，真实模型的结论补记到 ADR-0001 未决事项 3。
   - T3.5 的 resume 错误：`WEVIR_RECORD_FIXTURES=1` 运行 `dsh-adapter.resume.integration.test.ts`，改写 `errors/resume-*.json`。
   - T3.2 的 Provider 错误：`turn-error.integration.test.ts` 用新 dsh 复现 `errors/prompt-provider-*.json` 并逐字比对，不一致时按失败输出更新样本。
   - 运行 `acp-mapping.test.ts`：快照的变化就是映射结果的变化，逐条确认后再更新快照（`vitest -u`）。新增的样本文件要在该测试里归到某条用例。

4. **跑三层契约测试，必须包含增量旁路。**

   ```bash
   pnpm vitest run --project adapter-dsh dsh-adapter.contract
   ```

   - 第 1 层回放（`dsh-adapter.contract.test.ts`，用第 3 步新录的样本）：除增量条款外全部通过。
   - 第 2 层真实 dsh + mock Provider（`dsh-adapter.contract.integration.test.ts`）：全部通过，**增量条款要显示为通过，不能是跳过**。它失败说明 stream-tap 没装上、没加载或帧的形状变了；跑 `stream-tap.integration.test.ts` 与 `dsh-adapter.integration.test.ts`，看适配器告警的 `kind` 是 `stream_tap_install_failed`、`stream_tap_not_loaded`，还是 `stream_tap_malformed` 这类解码问题。
   - 第 3 层真实模型（`dsh-adapter.contract.real.integration.test.ts`）：设 `WEVIR_TEST_API_KEY` 与 `WEVIR_TEST_PROVIDER`（见 ADR-0001 补记 7）在本机跑一次，结果贴进提交说明。
   - 之后跑全仓 `pnpm test`（含其余 `*.integration.test.ts` 与 Host + 真实 dsh 的 `*.dsh.integration.test.ts`）和 `pnpm gate:m2`。设了 Key 时，`*.integration.test.ts` 里的真实模型用例一并运行。

5. **对比事件映射表与错误文本归类。**
   - [acp-event-mapping.md](../architecture/acp-event-mapping.md) 的三张表与代码由 `acp-event-mapping.test.ts` 核对。新出现或改了形状的 `sessionUpdate` 落成 `engine.raw`，每种告警一次（“ACP session/update 无法映射，保留为 engine.raw”，字段带 `sessionUpdate` 与 `reason`），逐个决定要不要映射。
   - 工具名表 `DSH_TOOLS`（`tool-display.ts`）与新 dsh 的内置工具对照，没登记的工具展示类型是 `unknown`。
   - 错误文本：`turn-error.ts` 的 `TURN_ERROR_RULES`（`-32603` 的前缀）与 `resume-error.ts`（acp-event-mapping.md §6）按第 3 步的新样本核对。dsh 改了措辞时原文仍然保留，但会归到 `unknown` 或 `engine_unavailable`，`session_lost` 也可能认不出来。
   - 发给 Provider 的附加数据：`git -C upstream/deepseek-harness grep -n "deepseekLlmApiExtensions.register\|x-deepseek-harness-" <新SHA> -- packages ':!**/tests/**'` 列出 `llm-deepseek` 请求体的扩展字段与请求头，与 [security.md §4](../security.md) 的清单对照：新字段先决定关不关（关的话写进 `provider-config.ts` 的 overlay），再更新清单；`session-log-deepseek`、`plugin-package-inventory-deepseek` 的 `enabled` 开关改名或去掉时，overlay 会被 dsh 拒绝或悄悄失效，`dsh-adapter.providers.integration.test.ts` 的 DeepSeek 用例会失败。
   - 审批：选项仍是 `allow_once` / `reject_once`、审批仍只来自沙箱升级（ADR-0001 §6），第 2 层的审批条款与 `dsh-adapter.approval.integration.test.ts` 覆盖。`DSH_PERMISSION_MODE` 等进程环境变量的名字按 dsh-base 的 `cordis.patch.yml` 再核对一次（ADR-0001 补记 1）。

6. **重新核对依赖闭包的许可证与 `allowBuilds`。**
   - 许可证：按 §2.1“pnpm 安装后的复核”的方法，从 `pnpm-lock.yaml` 的 importer `packages/adapter-dsh` 与 `packages/adapter-acp`（R7 起 ACP SDK 在后者，两者合起来才与 §2.1 的计数可比）沿 `dependencies` 与 `optionalDependencies` 走出生产依赖闭包（含各平台的可选包），已安装的读 `package.json`，其他平台的用 `npm view <包>@<版本> license`。与 §2.1 的计数对比，新出现的非宽松许可证（MPL、LGPL、GPL、专有条款）写进 §2.1 的结论。`pnpm licenses list --prod` 不列可选的平台包，不能代替。
   - `allowBuilds`：第 2 步报出的每个构建脚本，读过脚本内容再决定放行还是拒绝；键带新版本，取舍与理由记在 §2.1“构建脚本”。旧版本的键删掉。

7. **收尾。** ADR-0001 补记一条升级记录：版本、上游变化、映射或归类的改动、三层契约测试的结果。`DSH_VERSION` 变了以后，旧会话 `session.created` 里的 `engineVersion` 与之后 `session.resumed` 的不同，这是预期的，正好用来排查跨版本问题（ADR-0001 补记 6）。

## 8. Codex 升级检查清单

R3 建立。Codex 的 app-server 仍标 experimental（codex-notes §2.6），每个版本都可能改协议、通知与措辞。Wevir 碰 Codex 的代码都在 `packages/adapter-codex`（网关在 `packages/model-gateway`，与 Codex 版本无关，但它解析的是 Codex 发的请求），升级只改这两个包、§1 的表、`upstream.lock`、`scripts/fetch-codex.sh` 与下面列到的文档（ADR-0005 决策 7）。按顺序做，每一步的结论写进提交说明；哪一步发现不兼容，先在 ADR-0005 补记与 [codex-event-mapping.md](../architecture/codex-event-mapping.md) 写清楚，再改代码。下文的“旧 SHA / 新 SHA”是 `upstream.lock` 里 codex 行的旧锁定提交与新 tag `rust-v<版本>` 指向的提交，先按 §6 第 1、2 步把 `upstream/codex` 同步到新 SHA（tag 不在任何分支上，同步脚本按 tag 浅拉取）。

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
   - `packages/adapter-codex/src/paths.ts` 的 `CODEX_VERSION`；`scripts/fetch-codex.sh` 的 `version` 与 6 个平台的 sha256（取 GitHub Release API 的资产 `digest`，命令写在脚本开头）；`upstream.lock` 的 codex 行；本文件 §1 与 §1.2 的表；`spikes/codex-app-server` 不随产品升级。
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

8. **网关与提示词。** Codex 发的 Responses 请求变了（新字段、新的输入项类型、`tool_choice` 等）：用 `spikes/codex-app-server/src/record-requests.ts` 重录 `packages/model-gateway/src/test-fixtures/codex-requests/`，跑网关的转换测试与快照（model-gateway.md）。`prompts/base.md` 的工具说明按新版本的工具清单核对（prompts/README.md「Codex 一回合里模型看到的说明」）；`prompts/` 下改写自 Codex 的文件按 §4 核对来源提交。

9. **ChatGPT 进程（R6）。** `account/*`、`model/list` 与 `v2/Account*.ts`、`LoginAccount*.ts`、`RateLimit*.ts`、`Model.ts` 的 schema 对照 `protocol.ts` 的“账号”一节；`cli_auth_credentials_store`、`forced_login_method`、`mcp_oauth_credentials_store`、`features.apps` 还在不在；登录服务与后端的地址与环境变量（`CODEX_APP_SERVER_LOGIN_ISSUER`、`CODEX_REFRESH_TOKEN_URL_OVERRIDE`、`chatgpt_base_url`、`openai_base_url`）、`/wham/accounts/check` 的形状变了没有。跑 `codex-runtime.chatgpt.integration.test.ts`（真实二进制 + mock 登录服务）；mock 的端点要跟着改。有真实 ChatGPT 账号时在桌面端登录一次、问一句，看外连（codex-event-mapping.md §8.5）。

10. **收尾。** ADR-0005 补记一条升级记录：版本、上游变化、映射或归类的改动、三层契约测试、外连与密钥检查的结果。`CODEX_VERSION` 变了以后，旧会话 `session.created` 里的 `engineVersion` 与之后 `session.resumed` 的不同，是预期的；rollout 格式不兼容时旧会话恢复会报 `session_lost`（会话只读），发版说明里要告诉用户。

## 9. 来源核查

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
