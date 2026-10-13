# 上游参考快照与许可证

> 建立于 T0.2（2026-10-12）。锁定提交以 [`upstream.lock`](./upstream.lock) 为准，本文件记录对应的核实结论。

`upstream/` 是三个上游仓库的只读浅克隆，已被 gitignore。不修改、不提交其中任何文件。复现或更新：

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

补充：

- dsh 的锁定提交就是 tag `dsh-v0.2.1-alpha.2` 指向的提交（GitHub compare 结果 `identical`），与 T0.3 锁定的 npm 版本 `@deepseek-ai/dsh@0.2.1-alpha.2` 是同一份源码。

### 1.1 作为依赖运行的 npm 包

只在 `packages/adapter-dsh/package.json` 声明，写精确版本（ADR-0001 §1、ADR-0004 §2）。

| npm 包 | 锁定版本 | npm `latest`（2026-10-12） | 许可证 | 说明 |
|---|---|---|---|---|
| `@deepseek-ai/dsh` | `0.2.1-alpha.2` | `0.2.0-rc.2` | MIT | 与上表 dsh 锁定提交同源；`packages/adapter-dsh/src/paths.ts` 的 `DSH_VERSION` 与之相同，解析到别的版本时启动报错 |
| `@agentclientprotocol/sdk` | `1.4.0` | `1.8.0` | Apache-2.0（Zed Industries） | 与 dsh-acp 自己锁定的版本相同；peer `zod` 由 pnpm 自动安装为工作区里的 4.6.x |

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
2. **npm 依赖中的非 MIT 许可证**（2026-10-12 `npm view` 核对）：`@pierre/diffs` 1.3.5、`@pierre/trees` 1.0.0-beta.6、`ai` 6.x 为 Apache-2.0；`dompurify` 3.x 为 `(MPL-2.0 OR Apache-2.0)`；`@paper-design/shaders` 0.0.72 的 package.json 只写“SEE LICENSE IN …”，tarball 内 LICENSE 为 MIT（© Lost Coast Labs），后续版本须重新核对。Wevir 引入这些依赖时由 T6.3 汇总进第三方声明。
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

## 3. 各仓库的参考重点

与 SKELETON_PLAN §3 保持一致，以下路径在锁定提交下均已确认存在。

- **dsh**（作为依赖，读文档和接口，不移植）：`docs/architecture.zh.md`、`docs/agent-lifecycle.zh.md`、`docs/capability-seams.zh.md`、`packages/acp/acp/README.zh.md`、`packages/sdk/{client,protocol,server}/README.zh.md`、`docs/user/guide/providers.md`。
- **OpenWork**（桌面产品与交互参考，仅 MIT 区域）：`apps/app`（React + Vite + Tailwind v4 主界面）、`apps/desktop`（Electron 壳）、`apps/server`、`packages/ui`、`packages/sdk`、`packages/types`、`docs/architecture`。**`ee/` 排除**。
- **Paseo**（多端与远程架构参考，骨架阶段不移植）：`packages/server`（daemon）、`packages/protocol`（`@getpaseo/protocol`）、`packages/client`、`packages/relay`、`packages/app`（Expo）、`packages/desktop`、`packages/cli`、`public-docs/sdk`。

## 4. 移植登记表

每移植一个文件（含大幅改写后仍可辨认出来源的文件）登记一行。“来源提交”写完整 SHA。

| Wevir 文件 | 来源路径 | 来源提交 | 许可证 | 修改说明 |
|---|---|---|---|---|
| — | — | — | — | — |

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

上游文件原有的版权与许可证注释原样保留在这几行下面。许可证全文不逐文件复制，统一在分发物的第三方声明里提供（T6.3）。

## 6. 升级流程

1. **改 lock**：取上游分支最新提交，写进 `docs/upstream/upstream.lock`。
   ```bash
   git ls-remote https://github.com/different-ai/openwork refs/heads/dev
   ```
2. **同步**：`bash scripts/upstream-sync.sh`，确认每个仓库的 `git rev-parse HEAD` 与 lock 一致。
3. **看上游变更**：
   - dsh：GitHub Releases（tag `dsh-v*`）和 `docs/persistence-changes/releases/`（会话持久化格式变化）；
   - OpenWork：`changelog/release-tracker-*.md`；
   - Paseo：根目录 `CHANGELOG.md`。
   同时对比新旧提交之间的许可证文件：
   ```bash
   git -C upstream/<名称> fetch --depth 1 origin <旧SHA>
   git -C upstream/<名称> diff <旧SHA> HEAD --stat -- LICENSE LICENSES NOTICE THIRD_PARTY_NOTICES.md ee/LICENSE
   ```
   许可证有变化，先更新本文件 §2 的结论。
4. **核对移植登记表**：§4 里每个来源文件在新提交下是否改动、移动或删除，需要的话同步修改 Wevir 文件并更新“来源提交”。
5. **跑契约测试**：`pnpm test`（M1 起包含 AgentRuntimeAdapter 契约测试，M3 起包含真实 dsh 的适配器契约测试）。升级 dsh 时，同步调整 `packages/adapter-dsh` 锁定的 npm 版本与 `src/paths.ts` 的 `DSH_VERSION`、§1.1 的表；`allowBuilds` 的键带版本，`pnpm install` 会对换了版本的构建脚本报 `ERR_PNPM_IGNORED_BUILDS`，逐个重新审查后改键；按 §2.1 的方法重新核对依赖闭包的许可证。完整的检查清单由 T3.6 写入。
6. **更新本文件 §1 仓库表**（提交、日期、结论），与 lock 改动放在同一个 commit 里。
