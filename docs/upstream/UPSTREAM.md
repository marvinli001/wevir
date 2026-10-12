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
- `THIRD_PARTY_NOTICES.md` 里有不属于宽松许可证的运行时依赖：`@deepseek-ai/libreoffice-kit*`（MPL-2.0，需让接收者能拿到对应源码）、`@anthropic-ai/claude-agent-sdk` 及其平台包（`SEE LICENSE IN README.md` / `LICENSE.md`，专有条款）。桌面端打包 dsh 前，要先核对 npm 包 `@deepseek-ai/dsh` 实际会安装的依赖闭包（留给 T3.1 / T6.3）。
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
5. **跑契约测试**：`pnpm test`（M1 起包含 AgentRuntimeAdapter 契约测试，M3 起包含真实 dsh 的适配器契约测试）。升级 dsh 时，同步调整 `packages/adapter-dsh` 锁定的 npm 版本。
6. **更新本文件 §1 仓库表**（提交、日期、结论），与 lock 改动放在同一个 commit 里。
