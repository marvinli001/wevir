# 第三方声明草稿与分发义务清单

> T6.3 草稿（2026-10-14），打包阶段使用。依据是当天工作区的 `pnpm-lock.yaml`（HEAD `598779b`，加上并行进行中、尚未提交的 T4.2 引入的 `mute-stream`）。打包时按实际打进安装包的文件重新核对，据此生成随安装包分发的第三方声明文件。
>
> 仓库里移植与派生的代码见根目录 [`NOTICE`](../../NOTICE)；dsh 依赖闭包的核对过程见 [UPSTREAM.md](./UPSTREAM.md) §2.1。本文件是工程清单，MPL 与 LGPL 两部分正式发布前要请懂开源合规的人复核。

## 1. 分发范围

按目前的架构（ADR-0002、ADR-0004 补记 4），桌面安装包里会有：

| 部分 | 内容 | 第三方组件 |
|---|---|---|
| Electron 运行时 | Electron 44.7.0 的二进制 | Electron、Chromium、V8、Node.js 及其第三方组件 |
| 渲染进程与主进程的产物 | Vite 打包的 `apps/desktop/out/` | 打进包里的 `devDependencies`（§2.2）与工作区包的源码 |
| Host | `packages/host/dist` 与它的生产依赖 | `ws`、`zod`（§2.1）与 `@wevir/adapter-dsh` 带进来的 dsh 闭包（§2.4） |
| CLI（T4.2） | `apps/cli/dist` | `mute-stream`（§2.1） |
| Codex 引擎（R9） | 资源目录的 `engines/codex/`：`codex-app-server` 与 `codex-code-mode-host` 独立二进制，Linux 另有 `codex-resources/bwrap`（`pnpm --filter @wevir/desktop resources` 准备，ADR-0007 决策 5） | OpenAI Codex 与它静态链接的 Rust crate、bubblewrap（§2.5） |

不分发、不进声明的：构建与测试工具（TypeScript、Biome、Vitest、Vite、electron-vite、tsdown、`@tailwindcss/vite` 等）。其中 `lightningcss`（MPL-2.0，Tailwind 构建时用）、`caniuse-lite`（CC-BY-4.0）、`source-map-js`（BSD-3-Clause）只在构建时运行，产物里没有它们的代码。`electron` 这个 npm 包的依赖（`@electron/get` 等）只负责下载二进制，也不进安装包。

dsh 的闭包（§2.4）随 `@wevir/adapter-dsh` 的生产依赖带进来；ADR-0005 决策 8 要求它不随安装包分发、改为用户选用时下载，这一块推迟了（ADR-0007 决策 6），打包任务要先把它排除在安装包之外。

Host 目前用本机的 Node 运行（`HostLifecycle`，`WEVIR_NODE` 可指定）。打包阶段如果改为随安装包带一份 Node，要加上 Node.js 的 `LICENSE`（其中已含它捆绑的 OpenSSL、ICU 等的许可证）。

## 2. 第三方声明草稿

### 2.1 Wevir 包的运行时依赖

| 包 | 版本 | 许可证 | 版权 | 使用方 |
|---|---|---|---|---|
| `zod` | 4.6.5 | MIT | Copyright (c) 2025 Colin McDonnell | `@wevir/protocol` |
| `ws` | 8.22.0 | MIT | Copyright (c) 2011 Einar Otto Stangvik；Copyright (c) 2013 Arnout Kazemier and contributors | `@wevir/host` |
| `mute-stream` | 3.0.0 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors | `@wevir/cli`（T4.2，未提交，以提交时为准） |

### 2.2 打进桌面端产物的库

从 `apps/desktop` 的 `devDependencies` 里会打进产物的 12 个包出发（U1 去掉了 `@radix-ui/colors`；U3 加了 libraries.dev 的 6 个动效库与 `three`；0.20.0 加了 `@pierre/diffs`、`shiki`、`@shikijs/transformers`，见表末），沿 lockfile 走出的闭包（不含只有类型的 `@types/*`、`csstype`）。实际打进去的以构建产物为准。

| 包 | 版本 | 许可证 | 版权 |
|---|---|---|---|
| `@babel/runtime` | 7.29.10 | MIT | Copyright (c) 2014-present Sebastian McKenzie and other contributors |
| `@base-ui/react`、`@base-ui/utils` | 1.9.0、0.5.0 | MIT | Copyright (c) 2019 Material-UI SAS |
| `@floating-ui/core`、`dom`、`react-dom`、`utils` | 1.8.0、1.8.0、2.1.9、0.2.12 | MIT | Copyright (c) 2021-present Floating UI contributors |
| `@remix-run/route-pattern` | 0.22.1 | MIT | Copyright (c) 2025 Shopify Inc. |
| `class-variance-authority` | 0.7.1 | Apache-2.0 | Copyright 2022 Joe Bell（包内没有 `NOTICE`） |
| `clsx` | 2.1.1 | MIT | Copyright (c) Luke Edwards |
| `cn` | 0.4.0 | MIT | Copyright (c) 2026 shadcn |
| `cookie-es` | 3.1.1 | MIT | Copyright (c) 2012-2014 Roman Shtylman；Copyright (c) 2015 Douglas Christopher Wilson |
| `dompurify` | 3.4.16 | MPL-2.0 OR Apache-2.0，**Wevir 选 Apache-2.0**（ADR-0004 补记 6） | (c) Cure53 and other contributors |
| `highlight.js` | 11.12.0 | BSD-3-Clause | Copyright (c) 2006, Ivan Sagalaev |
| `lucide-react` | 1.55.0 | ISC | Copyright (c) 2026 Lucide Icons and Contributors；部分图标源自 Feather（MIT，Copyright (c) 2013-present Cole Bemis），两段都在包内 `LICENSE` |
| `marked` | 18.1.0 | MIT | Copyright (c) 2018+, MarkedJS；Copyright (c) 2011-2018, Christopher Jeffrey；包内 `LICENSE` 另附 Markdown 的 BSD 许可（Copyright © 2004, John Gruber） |
| `react`、`react-dom`、`scheduler`、`use-sync-external-store` | 19.3.0、19.3.0、0.28.0、1.7.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates |
| `react-router` | 8.4.0 | MIT | Copyright (c) React Training LLC 2015-2019；Remix Software Inc. 2020-2021；Shopify Inc. 2022-2023 |
| `reselect` | 5.3.0 | MIT | Copyright (c) 2015-2018 Reselect Contributors |
| `tailwindcss` | 4.3.3 | MIT | Copyright (c) Tailwind Labs, Inc.（生成的 CSS 含它的 preflight） |
| `tw-animate-css` | 1.4.0 | MIT | Copyright (c) 2025 Wombosvideo |
| `border-beam`、`thinking-orbs`、`bot-avatars`、`liquid-gooey`、`img-fx` | 1.4.1、0.3.2、0.1.2、0.2.2、0.5.1 | MIT | Copyright (c) 2026 Jakub Antalik（`liquid-gooey` 写作 Copyright (c) 2026 Jakub）；U3，零运行时依赖 |
| `metal-fx` | 2.0.11 | MIT；内含 Paper Shaders 的 `liquidMetal` 着色器（Apache-2.0，包内 `NOTICE`） | Copyright (c) 2026 Jakub Antalik；Copyright (c) Paper Design, Inc.。Wevir 打了补丁（`patches/metal-fx@2.0.11.patch`，根目录 `NOTICE` §8） |
| `three` | 0.186.1 | MIT | Copyright © 2010-2026 three.js authors（`img-fx` 的 peer，只在显现图片时动态加载） |
| `@pierre/diffs`、`@pierre/theming`、`@pierre/theme` | 1.5.1、1.0.1、2.0.0 | Apache-2.0 | Copyright 2025 Pierre Computer Company；`@pierre/theme` 带 `NOTICE`（派生自 primer/github-vscode-theme，MIT，Copyright (c) 2020 Primer），已抄在根目录 `NOTICE` §11。Wevir 给 `@pierre/diffs` 打了补丁（`patches/@pierre__diffs@1.5.1.patch`）；0.20.0 的“变更”窗格，打开时才加载 |
| `shiki`、`@shikijs/core`、`engine-javascript`、`engine-oniguruma`、`langs`、`primitive`、`themes`、`types`、`transformers` | 4.4.3 | MIT | Copyright (c) 2021 Pine Wu；Copyright (c) 2023 Anthony Fu。`engine-oniguruma` 内嵌 Oniguruma 的 WebAssembly 构建 |
| `@shikijs/vscode-textmate` | 10.0.2 | MIT | Copyright (c) Microsoft Corporation |
| `oniguruma-to-es`、`oniguruma-parser`、`regex`、`regex-recursion`、`regex-utilities` | 4.3.6、0.12.2、6.1.0、6.0.2、2.3.0 | MIT | Copyright (c) 2024-2026 Steven Levithan |
| `hast-util-to-html`、`hast-util-whitespace`、`mdast-util-to-hast`、`unist-util-*`（`is`、`position`、`stringify-position`、`visit`、`visit-parents`）、`vfile`、`vfile-message`、`micromark-util-*`（`character`、`encode`、`sanitize-uri`、`symbol`、`types`）、`property-information`、`stringify-entities`、`character-entities-html4`、`character-entities-legacy`、`ccount`、`comma-separated-tokens`、`space-separated-tokens`、`html-void-elements`、`trim-lines`、`zwitch`、`devlop` | 见 lockfile | MIT | Copyright (c) 2015-2023 Titus Wormer |
| `dequal` | 2.0.3 | MIT | Copyright (c) Luke Edwards |
| `lru_map` | 0.4.1 | MIT | Rasmus Andersson（包内 `LICENSE` 没有版权行，作者见 `package.json`） |
| `diff` | 9.0.0 | BSD-3-Clause | Copyright (c) 2009-2015, Kevin Decker |
| `@ungap/structured-clone` | 1.4.0 | ISC | Copyright (c) 2021, Andrea Giammarchi |

非 MIT 的：Apache-2.0 两个（`class-variance-authority`、按选择的 `dompurify`）加 0.20.0 的 `@pierre/*` 三个、BSD-3-Clause 两个（`highlight.js`、0.20.0 的 `diff`）、ISC 两个（`lucide-react`、0.20.0 的 `@ungap/structured-clone`）。与 ADR-0004 补记 5、6、10 记下的一致。`@pierre/theme` 带 `NOTICE`，内容要收进声明（已抄在根目录 `NOTICE` §11）。另有 `metal-fx` 打包进来的 Paper Shaders 代码是 Apache-2.0，它带 `NOTICE`，内容要收进声明（§3.1，已抄在根目录 `NOTICE` §8；ADR-0004 补记 9）。

### 2.3 Electron

`electron` 44.7.0，MIT，Copyright (c) Electron contributors；Copyright (c) 2013-2020 GitHub Inc.。二进制包里的 `dist/LICENSE` 是 Electron 自己的许可证，`dist/LICENSES.chromium.html`（约 20 MB）是 Chromium、V8、Node.js 等捆绑组件的许可证全集，两份都要随安装包分发。

### 2.4 dsh 依赖闭包

importer `packages/adapter-dsh` 的生产依赖闭包，含所有平台的可选包，共 622 个 name@version（方法与逐项结论见 UPSTREAM.md §2.1“T6.3 复核”）：

| 许可证 | 个数 |
|---|---|
| MIT | 497 |
| Apache-2.0 | 71 |
| BSD-3-Clause | 18 |
| ISC | 10 |
| BSD-2-Clause | 2 |
| 0BSD、Unlicense、Python-2.0、(MIT OR CC0-1.0) | 各 1 |
| **MPL-2.0** | 6：`@deepseek-ai/libreoffice-kit` 0.1.5 及 `darwin-arm64`、`darwin-x64`、`win32-arm64`、`win32-x64`、`wasm` |
| **LGPL-3.0-or-later**（含组合表达式） | 14：`@img/sharp-libvips-*` 1.3.4 共 10 个；`@img/sharp-win32-{arm64,ia32,x64}` 0.35.5（Apache-2.0 AND LGPL-3.0-or-later）；`@img/sharp-wasm32` 0.35.5（Apache-2.0 AND LGPL-3.0-or-later AND MIT） |

声明来源：

- dsh 自己：`@deepseek-ai/dsh` 包内的 `LICENSE`（MIT，Copyright (c) 2026 DeepSeek），以及上游仓库锁定提交 `d743267388641bc76f17c45ce8b4c231aed1d32c` 的 `THIRD_PARTY_NOTICES.md`（npm 包里没有，要从仓库取）。
- `@deepseek-ai/node-addon-system` 及其平台包：BSD-3-Clause，dsh 自己发布。
- `@deepseek-ai/libreoffice-kit`：`LICENSE`（MPL-2.0）与 `NOTICE`（dsh 的 MIT 部分与 LibreOffice `fontdefs.cxx` 的来源说明）；平台包的 `licenses/` 里是 LibreOffice 的 MPL-2.0、第三方声明 `LibreOffice-third-party.html` 与 dsh 的 MIT。
- `@img/sharp-libvips-*`：包里只有 README 的许可证表与 `versions.json`，没有许可证全文（§3.4）。
- `node-pty`：MIT，`LICENSE` 里有 Christopher Jeffrey、Daniel Imms、Microsoft Corporation 三段。Windows 上另带 `third_party/conpty/<版本>/<架构>/{conpty.dll,OpenConsole.exe}`，按路径推断来自 Microsoft Terminal 的 ConPTY 发布（MIT），包里没有它单独的许可证文件，打包前确认来源并补上声明。
- 其余包各自的 `LICENSE`。

`@anthropic-ai/claude-agent-sdk`（专有条款）不在闭包里，`@anthropic-ai/sdk` 0.129.0 为 MIT。

### 2.5 OpenAI Codex（`codex-app-server`）

`rust-v0.162.1`（锁定提交 `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`），Apache-2.0，`Copyright 2025 OpenAI`。随包的文件（`apps/desktop/licenses/codex/`，准备资源目录时复制到二进制旁边）：

- `LICENSE`：Apache License 2.0 全文。
- `NOTICE`：`OpenAI Codex`、`Copyright 2025 OpenAI`，以及派生自 Ratatui 的代码（MIT，`Copyright (c) 2016-2022 Florian Dehau`、`Copyright (c) 2023-2025 The Ratatui Developers`）。没有核实 `codex-app-server` 里是否链接了这部分代码，整份照附。

Linux 包另带 `bwrap`：bubblewrap，LGPL-2.0-or-later，源码在 Codex 锁定提交的 `codex-rs/vendor/bubblewrap/`（https://github.com/openai/codex/tree/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/vendor/bubblewrap ）。

二进制里静态链接的 Rust crate 闭包（`codex-rs/Cargo.lock`）的许可证还没有核对，打包前做（UPSTREAM.md §2.4）。

### 2.6 字体（U1）

渲染进程的产物里带三种字体的 WOFF2（`apps/desktop/src/renderer/src/assets/fonts/`，Vite 打进 `out/renderer/assets/`），都是 SIL OFL-1.1，来源、版本与处理方式见根目录 `NOTICE` 第 7 节与同目录的 `SOURCE.md`：

| 字体 | 版本 | 版权 | 处理 |
|---|---|---|---|
| Mona Sans | 2.0.27 | Copyright 2022 The Mona Sans Project Authors，保留字体名 “Mona” | TTF 转 WOFF2，不改字形与名称 |
| JetBrains Mono | 2.304 | Copyright 2020 The JetBrains Mono Project Authors | TTF 转 WOFF2，不改字形与名称 |
| Noto Serif SC | 2.003 | © 2017-2024 Adobe，没有保留字体名 | 按固定文案子集化（修改过的版本） |

各字体的 OFL 原文在 `apps/desktop/licenses/fonts/`。

## 3. 分发义务清单

打包时逐项勾掉。条款编号指各许可证的原文。

### 3.1 所有安装包

- [ ] Wevir 的 `LICENSE` 与 `NOTICE` 放进安装包的资源目录，设置 → 关于里有“开源许可”入口能看到它们和第三方声明。
- [ ] 第三方声明文件按**实际打进安装包的文件**生成：每个包的名称、版本、许可证、版权行与许可证全文（MIT、ISC、BSD 的条件就是保留版权与许可声明）。不能用 `pnpm licenses list --prod` 代替，它不列可选的平台包（UPSTREAM.md §2.1）。
- [ ] 打包后的 JS 是否保留了 `/*! @license … */` 横幅（例如 DOMPurify 的）不影响上一条：声明文件本身要覆盖所有打进去的库。
- [ ] Apache-2.0 的包：声明里附一次 Apache-2.0 全文；包里带 `NOTICE` 的，把其内容收进声明（第 4(d) 条）。目前已安装的 Apache-2.0 包都没有 `NOTICE`，构建机上没装的平台包要在打包环境里再看一次。例外是 `metal-fx` 里的 Paper Shaders（U3）：`metal-fx` 自己是 MIT，包内 `NOTICE` 记着它打包了 Paper Shaders 的 Apache-2.0 代码，这份内容要进声明。
- [ ] DOMPurify 在声明里写明按 Apache-2.0 使用。
- [ ] Electron 的 `LICENSE` 与 `LICENSES.chromium.html` 在产物里（electron-builder 默认会复制，以产物为准）。
- [ ] 每个平台的安装包只带本平台的可选包（`@img/sharp-*`、`libreoffice-kit-*`、`sherpa-onnx-*`、`node-addon-system-*` 等），声明按实际带的写。
- [ ] 不使用 OpenWork、Paseo、DeepSeek 的名称与 logo，说明来源的署名除外（UPSTREAM.md §2.2、§2.3）。
- [ ] 如果随安装包带 Node.js，加上它的 `LICENSE`。
- [ ] 字体（§2.6）：OFL 要求每份副本带版权声明与许可证全文。`apps/desktop/licenses/fonts/` 放进安装包，或由第三方声明文件收进三份版权行与一次 OFL 全文；不单独出售字体文件（OFL 第 1 条）。

### 3.2 dsh

- [ ] 随附 dsh 的 `LICENSE` 和上游锁定提交的 `THIRD_PARTY_NOTICES.md`。
- [ ] 每次升级 dsh（UPSTREAM.md §7 第 6 步）都重查闭包。出现 `@anthropic-ai/claude-agent-sdk` 或别的专有条款、GPL 类许可证时，先停下来决定，再打包。
- [ ] Windows：ConPTY 二进制的来源与 MIT 声明（§2.4）。

### 3.2a Codex

- [ ] 资源目录的 `engines/codex/` 里有 `LICENSE` 与 `NOTICE`（`pnpm resources` 复制，打包时随 `extraResources` 进安装包），“开源许可”页列出 Codex 并能看到这两份文件。
- [ ] 第三方声明收录 `codex-rs/Cargo.lock` 里静态链接进 `codex-app-server` 的 crate（按实际打进去的平台）。
- [ ] Linux 包：`codex-resources/bwrap` 在声明里写明 LGPL-2.0-or-later 与源码位置（§2.5），随附 LGPL-2.0 全文；ADR-0005 未决事项 4 决定 Linux 不带它时，这一条不适用。
- [ ] 不使用 OpenAI 或 Codex 的名称与商标，说明来源的署名除外（Apache-2.0 第 6 条）。

### 3.2b Claude Agent

- [ ] `@anthropic-ai/claude-agent-sdk`（`@wevir/adapter-claude` 的依赖，2026-10-15）是 Anthropic 的商业条款（包内 `LICENSE.md`），不是开源许可证：打包前定能不能随安装包分发（T3 Code 随应用分发它），能分发时随附它的条款。只带 SDK 本身，不带各平台的 Claude Code 二进制（`ignoredOptionalDependencies`，Wevir 用用户自己装的 `claude`）。
- [ ] 界面与安装包里不出现 “Claude Code” 的名字，只叫 “Claude Agent”（ADR-0005 补记 14）。

### 3.2c OpenCode

- [ ] `@opencode-ai/sdk` 1.18.34（`@wevir/adapter-opencode` 的依赖，2026-10-15）声明 MIT，包里没有 LICENSE 文件：第三方声明里用 opencode 仓库的许可证全文（`Copyright (c) 2025 opencode`）。不带 `opencode` 本身，用用户自己装的（opencode-event-mapping.md §1）。

### 3.3 MPL-2.0：`@deepseek-ai/libreoffice-kit*`

MPL-2.0 第 3.2 条：以可执行形式分发时，要让接收者能以合理方式拿到源码，并告诉他们怎么拿；第 3.4 条：不得删改许可证声明。

- [ ] 原样分发这些包，保留 `LICENSE`、`NOTICE`、`licenses/` 与 `sources/`（LibreOffice core 的上游仓库与提交 `bce0998afefdbc355585ca324285661a2170ba77`、`core-changes.patch`、构建脚本）。electron-builder 的 `files` 过滤与 asar 设置不能把它们剪掉。
- [ ] 第三方声明里写明这些组件按 MPL-2.0 授权，源码在包内 `sources/` 与 https://github.com/deepseek-ai/dsh-libreoffice-kit 。
- [ ] Wevir 不修改这些文件；以后要改，改过的文件按 MPL-2.0 公开源码。
- [ ] 平台包很大（`darwin-arm64` 约 148 MB）。要不要随安装包带 Office 能力是打包阶段的产品决定；不带时，这一节随之不适用。

### 3.4 LGPL-3.0-or-later：sharp 的 libvips

LGPL-3.0 第 4 条（组合作品）逐项：

- [ ] (a) 在每份副本里显著说明使用了 libvips 等 LGPL 库、它们按 LGPL 授权：写进第三方声明与“开源许可”页。
- [ ] (b) 随附 GPL-3.0 与 LGPL-3.0 全文。**npm 包里没有，要自己加。**
- [ ] (c) “开源许可”页显示版权声明时，带上 libvips 的版权声明并指向上面两份许可证。
- [ ] (d)(1) 以共享库的方式使用：`@img/sharp-libvips-<平台>/lib/` 的动态库与 Windows `@img/sharp-win32-*` 里的 DLL 作为独立文件放在 asar 之外（`asarUnpack`），运行时加载，用户能换成接口兼容的版本。macOS 上 `sharp-*.node` 经 `@rpath` 链接 `libvips-cpp.*.dylib`，满足这一点；要确认签名与公证（hardened runtime 的库校验）不会让替换后的库加载失败，或写明替换后怎样重新签名，把结论记下来。
- [ ] 不分发 `@img/sharp-wasm32`：它把 libvips 编进了 wasm，不是可替换的共享库，带上就要按 (d)(0) 提供最小对应源码与应用的对应代码。
- [ ] (e) 安装信息：GPL-3.0 第 6 条只在随“用户产品”一起转让时要求，桌面安装包一般不涉及；复核时确认。
- [ ] 分发 libvips 的目标代码本身，要按 GPL-3.0 第 6 条提供对应源码：`versions.json` 列出的 libvips 8.18.7 与 LGPL 库（glib 2.90.0、pango 1.58.2、fribidi 1.0.17、libheif 1.23.5、librsvg 2.63.2、libexif 0.6.26、proxy-libintl 0.5）的源码与 sharp-libvips 的构建脚本，跟发布物放在一起，或附书面要约。只给上游链接时，要在下载处写清楚去哪里拿，并保证一直能拿到。
- [ ] 同一个包里其他库的义务：cairo 1.18.6（MPL-1.1，同样提供源码获取方式并附 MPL-1.1 全文）；aom（BSD-2-Clause 加 Alliance for Open Media Patent License 1.0 全文）；FreeType（FTL，文档里要写 “Portions of this software are copyright © <年份> The FreeType Project (www.freetype.org). All rights reserved.”）；mozjpeg（含 IJG License，文档里要写 “this software is based in part on the work of the Independent JPEG Group”）；libpng、libtiff、fontconfig、zlib-ng、harfbuzz、libwebp、libxml2 等按各自许可证附全文。包里只有 README 的表，全文按 `versions.json` 的版本从各库的源码取。

## 4. 复核方法

1. dsh 闭包：按 UPSTREAM.md §2.1 与 §7 第 6 步。
2. Wevir 自己的：从 lockfile 的 importer `packages/protocol`、`packages/host`、`apps/cli` 的 `dependencies`，以及 `apps/desktop` 里会打进产物的 `devDependencies`（§2.2 表头所说的 13 个）出发，沿 `snapshots` 的 `dependencies` 与 `optionalDependencies` 走闭包。
3. 已安装的包读 `package.json` 的 `license` 与 `LICENSE` 的版权行，没安装的平台包用 `npm view <包>@<版本> license`；同时列出包里的 `NOTICE`、`third_party/`、`licenses/` 等文件。
4. 打包阶段改为对安装包的实际内容做一遍（`app.asar` 解包后的依赖、`asarUnpack` 的目录、Electron 的 `dist`），以那一遍的结果生成正式的第三方声明，并更新本文件。
