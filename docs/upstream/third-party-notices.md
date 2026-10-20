# 第三方声明草稿与分发义务清单

> T6.3 草稿（2026-10-14），打包阶段使用。依据是当天工作区的 `pnpm-lock.yaml`（HEAD `598779b`，加上并行进行中、尚未提交的 T4.2 引入的 `mute-stream`）。打包时按实际打进安装包的文件重新核对，据此生成随安装包分发的第三方声明文件。
>
> 仓库里移植与派生的代码见根目录 [`NOTICE`](../../NOTICE)。本文件是工程清单，正式发布前要请懂开源合规的人复核。

## 1. 分发范围

按目前的架构（ADR-0002、ADR-0004 补记 4），桌面安装包里会有：

| 部分 | 内容 | 第三方组件 |
|---|---|---|
| Electron 运行时 | Electron 44.7.0 的二进制 | Electron、Chromium、V8、Node.js 及其第三方组件 |
| 渲染进程与主进程的产物 | Vite 打包的 `apps/desktop/out/` | 打进包里的 `devDependencies`（§2.2）与工作区包的源码 |
| Host | `packages/host/dist` 与它的生产依赖 | `ws`、`zod` 等（§2.1） |
| CLI（T4.2） | `apps/cli/dist` | `mute-stream`（§2.1） |
| Codex 引擎（R9） | 资源目录的 `engines/codex/`：`codex-app-server` 与 `codex-code-mode-host` 独立二进制，Linux 另有 `codex-resources/bwrap`（`pnpm --filter @wevir/desktop resources` 准备，ADR-0007 决策 5） | OpenAI Codex 与它静态链接的 Rust crate、bubblewrap（§2.5） |

不分发、不进声明的：构建与测试工具（TypeScript、Biome、Vitest、Vite、electron-vite、tsdown、`@tailwindcss/vite` 等）。其中 `lightningcss`（MPL-2.0，Tailwind 构建时用）、`caniuse-lite`（CC-BY-4.0）、`source-map-js`（BSD-3-Clause）只在构建时运行，产物里没有它们的代码。`electron` 这个 npm 包的依赖（`@electron/get` 等）只负责下载二进制，也不进安装包。

Host 目前用本机的 Node 运行（`HostLifecycle`，`WEVIR_NODE` 可指定）。打包阶段如果改为随安装包带一份 Node，要加上 Node.js 的 `LICENSE`（其中已含它捆绑的 OpenSSL、ICU 等的许可证）。

## 2. 第三方声明草稿

### 2.1 Wevir 包的运行时依赖

| 包 | 版本 | 许可证 | 版权 | 使用方 |
|---|---|---|---|---|
| `zod` | 4.6.5 | MIT | Copyright (c) 2025 Colin McDonnell | `@wevir/protocol` |
| `ws` | 8.22.0 | MIT | Copyright (c) 2011 Einar Otto Stangvik；Copyright (c) 2013 Arnout Kazemier and contributors | `@wevir/host` |
| `yaml` | 2.9.1 | ISC | Copyright Eemeli Aro | `@wevir/host`，P1 的 SKILL.md YAML 解析 |
| `yauzl` | 3.4.0 | MIT | Copyright (c) 2014 Josh Wolfe | `@wevir/host`，P1 的本地 ZIP 安装；adapter-antigravity 也使用同一版本 |
| `vscode-languageserver-protocol` | 3.18.4 | MIT | Copyright (c) Microsoft Corporation | `@wevir/host`，代码智能的 LSP 连接 |
| `vscode-jsonrpc` | 9.0.3 | MIT | Copyright (c) Microsoft Corporation | 同上（`vscode-languageserver-protocol` 的依赖） |
| `vscode-languageserver-types` | 3.18.4 | MIT | Copyright (c) Microsoft Corporation | 同上 |
| `mute-stream` | 3.0.0 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors | `@wevir/cli`（T4.2，未提交，以提交时为准） |
| `node-pty` | 1.1.0 | MIT | Copyright (c) 2012-2015, Christopher Jeffrey；Copyright (c) 2016, Daniel Imms；Copyright (c) 2018 - present Microsoft Corporation（三段都在包内 `LICENSE`） | `@wevir/host` 的可选依赖，用户终端（0.69.0）。安装包只带目标平台的预编译（`pty.node`，macOS 另有 `spawn-helper`；Windows 是 `conpty.node`、`conpty_console_list.node` 与 winpty 的 `pty.node`、`winpty.dll`、`winpty-agent.exe`，winpty 同为 MIT），不带源码与调试符号；它的依赖 `node-addon-api` 只有编译用的头文件，不进安装包 |
| `@xterm/headless`、`@xterm/addon-serialize` | 6.0.0、0.14.0 | MIT | Copyright (c) 2017-2019, The xterm.js authors；Copyright (c) 2014-2016, SourceLair Private Company；Copyright (c) 2012-2013, Christopher Jeffrey（包内没有 `LICENSE`，用 xterm.js 仓库的许可证全文） | `@wevir/host`，用户终端重连时的屏幕快照 |

### 2.2 打进桌面端产物的库

从 `apps/desktop` 的 `devDependencies` 里会打进产物的 12 个包出发（U1 去掉了 `@radix-ui/colors`；U3 加了 libraries.dev 的 6 个动效库与 `three`；0.20.0 加了 `@pierre/diffs`、`shiki`、`@shikijs/transformers`；0.32.0 加了 `mermaid`、`katex`、`marked-katex-extension`、`htmlparser2`，见表末），沿 lockfile 走出的闭包（不含只有类型的 `@types/*`、`csstype`）。实际打进去的以构建产物为准。

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
| `mermaid`、`@mermaid-js/parser` | 11.17.2、1.2.1 | MIT | Copyright (c) 2014 - 2022 Knut Sveidqvist。0.32.0 的文件窗格里 Markdown 的 Mermaid 图，第一次用到时才加载。`@mermaid-js/parser` 的产物里打包了 Langium（MIT，Copyright TypeFox GmbH）与 Chevrotain（Apache-2.0，Copyright (c) 2021 the original author or authors；`@chevrotain/types` 11.1.2 同为 Apache-2.0） |
| `katex`、`marked-katex-extension` | 0.18.10（Mermaid 另带 0.16.47）、5.1.13 | MIT | Copyright (c) 2013-2020 Khan Academy and other contributors；Copyright (c) 2021 @markedjs。KaTeX 的字体（SIL Open Font License 1.1）随 `katex.min.css` 打进产物 |
| `htmlparser2`、`domhandler`、`domutils`、`domelementtype`、`dom-serializer`、`entities` | 8.0.2、5.0.3、3.2.2、2.3.0、2.0.0、4.5.0 | MIT（`htmlparser2`、`dom-serializer`）、BSD-2-Clause（其余） | Copyright 2010, 2011, Chris Winberry；Copyright (c) Felix Böhm。0.32.0 的 Office 文件预览（OpenWork 的 workbook） |
| `d3` 与它的 `d3-*` 子包（`array`、`axis`、`brush`、`chord`、`color`、`contour`、`delaunay`、`dispatch`、`drag`、`dsv`、`fetch`、`force`、`format`、`geo`、`hierarchy`、`interpolate`、`path`、`polygon`、`quadtree`、`random`、`scale`、`scale-chromatic`、`selection`、`shape`、`time`、`time-format`、`timer`、`transition`、`zoom`）、`internmap`、`delaunator` | 见 lockfile | ISC | Copyright 2010-2023 Mike Bostock；`delaunator` Copyright (c) 2021, Mapbox |
| `d3-sankey`、`d3-array` 2.12.1、`d3-path` 1.0.9、`d3-shape` 1.3.7、`d3-ease`、`rw` | 0.12.3 等 | BSD-3-Clause | Copyright 2010-2021 Mike Bostock |
| `cytoscape`、`cytoscape-cose-bilkent`、`cytoscape-fcose`、`cose-base`、`layout-base` | 3.34.3、4.1.0、2.2.0、1.0.3 / 2.2.0、1.0.2 / 2.0.1 | MIT | Copyright (c) 2016-2026, The Cytoscape Consortium；cose-base 与 layout-base Copyright (c) 2016 – present, iVis@Bilkent |
| `dagre-d3-es`、`lodash-es`、`dayjs`、`roughjs`（`hachure-fill`、`path-data-parser`、`points-on-curve`、`points-on-path`）、`stylis`、`uuid`、`khroma`、`@braintree/sanitize-url`、`@upsetjs/venn.js`、`@iconify/utils`（`@antfu/install-pkg`、`package-manager-detector`、`import-meta-resolve`）、`es-toolkit`、`marked` 16.4.2、`ts-dedent`、`fastdom`、`strictdom` | 见 lockfile | MIT | Copyright (c) 2013 Chris Pettitt（dagre-d3）；OpenJS Foundation；iamkun；Preet Shihn；Sultan Tarimo；Robert Kieffer；Fabio Spampinato, Andrew Maney；Braintree；各包 `LICENSE` |
| `robust-predicates` | 3.0.3 | Unlicense | Vladimir Agafonkin（公有领域） |
| `@xterm/xterm`、`@xterm/addon-fit` | 6.0.0、0.11.0 | MIT | Copyright (c) 2017-2019, The xterm.js authors；Copyright (c) 2014-2016, SourceLair Private Company；Copyright (c) 2012-2013, Christopher Jeffrey（`@xterm/addon-fit` 包内没有 `LICENSE`，同上） | 0.69.0 的“终端”窗格，打开时才加载 |
| `commander`、`iconv-lite`、`safer-buffer` | 7.2.0 / 8.3.0、0.6.3、2.1.2 | MIT | Mermaid 依赖树里的 Node 端工具，渲染进程的产物里不会用到，以构建产物为准 |

非 MIT 的：Apache-2.0 两个（`class-variance-authority`、按选择的 `dompurify`）加 0.20.0 的 `@pierre/*` 三个、BSD-3-Clause 两个（`highlight.js`、0.20.0 的 `diff`）、ISC 两个（`lucide-react`、0.20.0 的 `@ungap/structured-clone`）。0.32.0 加的（文件预览：`mermaid`、`katex`、`marked-katex-extension`、`htmlparser2` 与它们的闭包，均钉住版本，发布满两周）里非 MIT 的：ISC 的 `d3` 一族、BSD-3-Clause 的 `d3-sankey` 等五个与 `rw`、BSD-2-Clause 的 `domhandler` 等四个、Unlicense 的 `robust-predicates`、`@mermaid-js/parser` 打包的 Chevrotain（Apache-2.0，没有 `NOTICE`）。与 ADR-0004 补记 5、6、10 记下的一致。`@pierre/theme` 带 `NOTICE`，内容要收进声明（已抄在根目录 `NOTICE` §11）。另有 `metal-fx` 打包进来的 Paper Shaders 代码是 Apache-2.0，它带 `NOTICE`，内容要收进声明（§3.1，已抄在根目录 `NOTICE` §8；ADR-0004 补记 9）。

### 2.3 Electron

`electron` 44.7.0，MIT，Copyright (c) Electron contributors；Copyright (c) 2013-2020 GitHub Inc.。二进制包里的 `dist/LICENSE` 是 Electron 自己的许可证，`dist/LICENSES.chromium.html`（约 20 MB）是 Chromium、V8、Node.js 等捆绑组件的许可证全集，两份都要随安装包分发。

### 2.4 OpenAI Codex（`codex-app-server`）

`rust-v0.162.1`（锁定提交 `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`），Apache-2.0，`Copyright 2025 OpenAI`。随包的文件（`apps/desktop/licenses/codex/`，准备资源目录时复制到二进制旁边）：

- `LICENSE`：Apache License 2.0 全文。
- `NOTICE`：`OpenAI Codex`、`Copyright 2025 OpenAI`，以及派生自 Ratatui 的代码（MIT，`Copyright (c) 2016-2022 Florian Dehau`、`Copyright (c) 2023-2025 The Ratatui Developers`）。没有核实 `codex-app-server` 里是否链接了这部分代码，整份照附。

Linux 包另带 `bwrap`：bubblewrap，LGPL-2.0-or-later，源码在 Codex 锁定提交的 `codex-rs/vendor/bubblewrap/`（https://github.com/openai/codex/tree/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/vendor/bubblewrap ）。

二进制里静态链接的 Rust crate 闭包（`codex-rs/Cargo.lock`）的许可证还没有核对，打包前做（UPSTREAM.md §2.4）。

### 2.5 字体（U1）

渲染进程的产物里带两种字体的 WOFF2（`apps/desktop/src/renderer/src/assets/fonts/`，Vite 打进 `out/renderer/assets/`），都是 SIL OFL-1.1，来源、版本与处理方式见根目录 `NOTICE` 第 7 节与同目录的 `SOURCE.md`：

| 字体 | 版本 | 版权 | 处理 |
|---|---|---|---|
| Mona Sans | 2.0.27 | Copyright 2022 The Mona Sans Project Authors，保留字体名 “Mona” | TTF 转 WOFF2，不改字形与名称 |
| JetBrains Mono | 2.304 | Copyright 2020 The JetBrains Mono Project Authors | TTF 转 WOFF2，不改字形与名称 |

各字体的 OFL 原文在 `apps/desktop/licenses/fonts/`。

## 3. 分发义务清单

打包时逐项勾掉。条款编号指各许可证的原文。

### 3.1 所有安装包

- [ ] Wevir 的 `LICENSE` 与 `NOTICE` 放进安装包的资源目录，设置 → 关于里有“开源许可”入口能看到它们和第三方声明。
- [ ] 第三方声明文件按**实际打进安装包的文件**生成：每个包的名称、版本、许可证、版权行与许可证全文（MIT、ISC、BSD 的条件就是保留版权与许可声明）。不能用 `pnpm licenses list --prod` 代替，它不列可选的平台包。
- [ ] 打包后的 JS 是否保留了 `/*! @license … */` 横幅（例如 DOMPurify 的）不影响上一条：声明文件本身要覆盖所有打进去的库。
- [ ] Apache-2.0 的包：声明里附一次 Apache-2.0 全文；包里带 `NOTICE` 的，把其内容收进声明（第 4(d) 条）。目前已安装的 Apache-2.0 包都没有 `NOTICE`，构建机上没装的平台包要在打包环境里再看一次。例外是 `metal-fx` 里的 Paper Shaders（U3）：`metal-fx` 自己是 MIT，包内 `NOTICE` 记着它打包了 Paper Shaders 的 Apache-2.0 代码，这份内容要进声明。
- [ ] DOMPurify 在声明里写明按 Apache-2.0 使用。
- [ ] Electron 的 `LICENSE` 与 `LICENSES.chromium.html` 在产物里（electron-builder 默认会复制，以产物为准）。
- [ ] 每个平台的安装包只带本平台的可选包，声明按实际带的写。
- [ ] 不使用 OpenWork、Paseo、DeepSeek 的名称与 logo，说明来源的署名除外（UPSTREAM.md §2.2、§2.3）。
- [ ] 如果随安装包带 Node.js，加上它的 `LICENSE`。
- [ ] 字体（§2.5）：OFL 要求每份副本带版权声明与许可证全文。`apps/desktop/licenses/fonts/` 放进安装包，或由第三方声明文件收进各字体的版权行与一次 OFL 全文；不单独出售字体文件（OFL 第 1 条）。

### 3.2 Codex

- [ ] 资源目录的 `engines/codex/` 里有 `LICENSE` 与 `NOTICE`（`pnpm resources` 复制，打包时随 `extraResources` 进安装包），“开源许可”页列出 Codex 并能看到这两份文件。
- [ ] 第三方声明收录 `codex-rs/Cargo.lock` 里静态链接进 `codex-app-server` 的 crate（按实际打进去的平台）。
- [ ] Linux 包：`codex-resources/bwrap` 在声明里写明 LGPL-2.0-or-later 与源码位置（§2.4），随附 LGPL-2.0 全文；ADR-0005 未决事项 4 决定 Linux 不带它时，这一条不适用。
- [ ] 不使用 OpenAI 或 Codex 的名称与商标，说明来源的署名除外（Apache-2.0 第 6 条）。

### 3.3 Claude

- [ ] `@anthropic-ai/claude-agent-sdk`（`@wevir/adapter-claude` 的依赖，2026-10-15）是 Anthropic 的商业条款（包内 `LICENSE.md`），不是开源许可证。2026-10-17 起随安装包分发（ADR-0007 补记 6），包内 `LICENSE.md` 原样保留；第三方声明里写明它按 Anthropic 的条款使用。只带 SDK 本身，不带各平台的 Claude Code 二进制（`ignoredOptionalDependencies`，Wevir 用用户自己装的 `claude`）。
- [ ] 界面与安装包里不出现 “Claude Code” 的名字；来源叫 “Claude”（2026-10-17 起，原来是 “Claude Agent”，ADR-0005 补记 14）。

### 3.4 OpenCode

- [ ] `@opencode-ai/sdk` 1.18.34（`@wevir/adapter-opencode` 的依赖，2026-10-15）声明 MIT，包里没有 LICENSE 文件：第三方声明里用 opencode 仓库的许可证全文（`Copyright (c) 2025 opencode`）。不带 `opencode` 本身，用用户自己装的（opencode-event-mapping.md §1）。

## 4. 复核方法

1. Wevir 自己的：从 lockfile 的 importer `packages/protocol`、`packages/host`、`apps/cli` 的 `dependencies`，以及 `apps/desktop` 里会打进产物的 `devDependencies`（§2.2 表头所说的 13 个）出发，沿 `snapshots` 的 `dependencies` 与 `optionalDependencies` 走闭包。
2. 已安装的包读 `package.json` 的 `license` 与 `LICENSE` 的版权行，没安装的平台包用 `npm view <包>@<版本> license`；同时列出包里的 `NOTICE`、`third_party/`、`licenses/` 等文件。
3. 打包阶段改为对安装包的实际内容做一遍（`app.asar` 解包后的依赖、`asarUnpack` 的目录、Electron 的 `dist`），以那一遍的结果生成正式的第三方声明，并更新本文件。
