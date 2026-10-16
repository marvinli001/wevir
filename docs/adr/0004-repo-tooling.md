# ADR-0004：仓库工具链

- 状态：Accepted（2026-10-12）
- 日期：2026-10-12
- 任务：T0.6；影响 T1.2、T2.4、T3.1、T5.1、T5.2、T6.2
- 依据：计划 §1.4 的默认值；T0.1 的实际配置（`package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`biome.json`、`vitest.config.ts`，提交 `fe8f3f4`、`50d7a73`）；pnpm 文档 `settings/build`；electron-vite 与 Electron 文档；npm registry 上的当前版本（2026-10-12 查询）

## 背景

计划 §1.4 列了骨架阶段的工具链默认值，并约定由 T0.1 / T0.6 在 ADR 中确认或推翻。T0.1 已按这些默认值搭好仓库；M0 的研究又带来几条新约束：dsh 的依赖需要安装脚本（T0.3 §1）、渲染进程开 `sandbox: true` 时 preload 不能用 ESM（OpenWork 研读 §2.3）、存储不引入原生模块（ADR-0003）。

## 决策

### 1. 确认 §1.4 的默认值

| 项 | 决定 | 当前版本 / 说明 |
|---|---|---|
| 包管理 | pnpm workspace（`apps/*`、`packages/*`） | pnpm 12.6.0（`packageManager` 字段） |
| Node | `engines.node >=22.19`；开发与 CI 基线是 `.node-version` 的 24 LTS | dsh 要求 `^22.19.0 \|\| >=24.0.0`；`@types/node` 保持 22.x，类型检查按下限进行，避免误用新版 API（ADR-0003） |
| 语言 | TypeScript strict，ESM，`module` / `moduleResolution` 为 `nodenext` | TypeScript 7.0.x；只走打包器的包（桌面 renderer）可在自己的 tsconfig 改用 `bundler` |
| 库构建 | tsdown | 0.23.x |
| 测试 | Vitest，根配置按包划分 projects | 5.0.x |
| Lint / Format | Biome，含引擎边界规则；另有 `scripts/check-engine-boundary.mjs` 检查依赖声明 | 2.5.x |
| 校验 / Schema | zod 4 | 4.6.x；schema 只做结构声明（ADR-0002 决策 2） |
| UI | React + Tailwind v4（`@tailwindcss/vite`） | React 19.x，Tailwind 4.3.x |
| 桌面构建 | electron-vite（只负责开发与构建，不负责打包） | 见下文决策 3 |

### 2. 新增的确定项

| 项 | 决定 | 依据 |
|---|---|---|
| dsh | `@deepseek-ai/dsh` 精确锁定 `0.2.1-alpha.2`，只在 `packages/adapter-dsh` 声明 | ADR-0001 |
| ACP 客户端 | `@agentclientprotocol/sdk` 精确锁定 `1.4.0`，只在 `packages/adapter-dsh` 声明 | ADR-0001 |
| WebSocket 服务端 | `ws`（8.x），只在 `packages/host` 使用；client-sdk 不依赖它，WebSocket 由调用方注入 | ADR-0002 决策 7 |
| SQLite | Node 内置 `node:sqlite`，无 npm 依赖 | ADR-0003 |
| 依赖的构建脚本 | 用 `pnpm-workspace.yaml` 的 `allowBuilds` 逐个登记（`true` 允许、`false` 拒绝）；保持 pnpm 默认的 `strictDepBuilds: true`，未登记的构建脚本让安装直接失败；不用 `dangerouslyAllowAllBuilds` | pnpm v11 起 `onlyBuiltDependencies` 等设置已移除，由 `allowBuilds` 取代（pnpm 文档 `settings/build`）。T0.3 报告里“pnpm 的 `onlyBuiltDependencies`”的说法据此更正 |
| 版本策略 | 开发工具用 `^` 范围加 lockfile；与引擎和协议直接相关的依赖（dsh、ACP SDK）写精确版本 | 计划 §8“精确锁版本” |
| 依赖提升 | 不开 `node-linker=hoisted`、`shamefully-hoist`，不用 `public-hoist-pattern` 提升 `@deepseek-ai/*`；另设 `extendNodePath: false`，并禁用会注入 `NODE_PATH` 的设置（补记 3） | AGENTS.md 规则 2（没声明的包解析不到，是引擎边界的第二道保险） |

需要登记到 `allowBuilds` 的包，由引入它们的任务在 `pnpm install` 的输出里确认后逐个写入：

- T3.1：dsh 的依赖。T0.3 在 npm 下需要 5 个（`@deepseek-ai/dsh-subprocess-local`、`koffi`、`node-pty`、`protobufjs`、`@google/genai`）；pnpm 判定“有构建脚本”的范围可能更大（例如带 `binding.gyp` 的包），以实际输出为准，每一项写明允许或拒绝的理由。
- T5.1：`electron`（postinstall 下载 Electron 二进制，镜像见 `.npmrc` 注释的 `ELECTRON_MIRROR`）。

### 3. 桌面构建的细则（T5.1）

- **版本**：T5.1 开工时用 electron-vite 的最新**正式版**及它支持的最高 Vite 主版本，不用 beta。2026-10-12 的情况：electron-vite 5.0.0 的 peer 是 Vite 5–7，支持 Vite 8 的 6.0 还在 beta（`6.0.0-beta.8`）；`@vitejs/plugin-react` 5.2 与 `@tailwindcss/vite` 4.3 同时支持 Vite 7 和 8。所以现在开工就是 electron-vite 5 + Vite 7。
- **Electron**：用开工时的最新稳定版（2026-10-12 为 44.7.0，内置 Node 24.18.1）。
- **preload**：渲染进程 `sandbox: true` 时 preload 不能用 ESM（Electron 文档 “ES Modules”：sandboxed preload scripts are run as plain JavaScript without an ESM context），所以 preload 打成单个 CJS 文件；有多个 preload 入口时用 electron-vite 的 `isolatedEntries`，必要时 `externalizeDeps: false`。
- **打包工具**（electron-builder 或 Electron Forge）不在骨架范围（计划 §7），到打包阶段与 ADR-0002 未决事项 1 一起决定。

### 4. UI 原语与样式的默认值（T5.2，可在 T5.2 的 ADR 中推翻）

- 原语用 shadcn CLI 从官方 registry 生成 Base UI 版本（不从 OpenWork 拷贝，OpenWork #20），图标用 lucide。
- 色阶取自 `@radix-ui/colors` npm 包，只取用到的色系；三层 Token（色阶 → 一套语义变量 → `@theme inline`），暗色只认 `data-theme`（OpenWork 研读 §9.3）。U1 起原始色改为手写，不再用 Radix（补记 8）。
- 不引入网络字体，用系统字体栈。U1 起界面与代码字体随应用打包，中文仍用系统字体（补记 8）。

## 备选方案

| 方案 | 结论 | 原因 |
|---|---|---|
| npm / yarn workspace | 不采纳 | 与 dsh、OpenWork 一致用 pnpm；pnpm 的隔离 node_modules 正好是引擎边界的第二道保险 |
| `tsc` 直接构建库 | 不采纳 | tsdown 与 dsh 一致，产物与 d.ts 一次生成；`tsc --noEmit` 仍用于类型检查 |
| ESLint + Prettier | 不采纳 | Biome 单工具已能表达 import 边界（`noRestrictedImports`），速度快 |
| Electron Forge 的 Vite 插件代替 electron-vite | 不采纳 | electron-vite 用一套配置管 main / preload / renderer，且有 sandbox 所需的单文件 preload 构建；打包工具另行决定 |
| 等 electron-vite 6 正式版再开工 / 先用 6 beta | 不采纳 | 骨架不需要 Vite 8 的特性；beta 会增加 T5.1 的不确定性 |
| `dangerouslyAllowAllBuilds: true` | 不采纳 | 失去对依赖安装脚本的逐个审查；dsh 依赖闭包有 600 多个包 |

## 后果

- 计划 §1.4 的默认值全部确认，没有被推翻；表里补上了实际版本与新增的确定项。
- 每引入一个带构建脚本的依赖，都要在 `allowBuilds` 里留下一行审查记录，`pnpm install` 才会通过。
- 桌面端暂时停在 Vite 7；electron-vite 6 发正式版后可以单独升级，不影响其他包。
- `@types/node` 停在 22.x 意味着 Node 24 / 26 新增的 API 在类型上不可见；真需要时先改本 ADR（提高 `engines` 下限）。

## 补记

1. **2026-10-13，chore（M2 前置）：工作区包之间按源码解析。** 库包的 `exports` 原先只指向 `dist/`；M2 起 `packages/host` 依赖 `@wevir/protocol` 与 `@wevir/runtime-adapter`（测试里 import `./echo`、`./contract`），T3.x 的 adapter-dsh 跑 `runAdapterContract`。实测在没有 `dist/` 时消费方 `tsc --noEmit` 报 TS2307（找不到 `@wevir/runtime-adapter/echo`），Vitest 报 `Failed to resolve entry`；有 `dist/` 但过期时则静默地检查和测试旧代码。定为：
   - 每个库包 `exports` 的每个子路径，第一个条件写 `"@wevir/source": "./src/<入口>.ts"`，其后照旧是指向 `dist/` 的 `types` / `default`。条件名带作用域，外部工具和第三方包不会启用它。
   - `tsconfig.base.json` 设 `"customConditions": ["@wevir/source"]`，所有包继承。
   - 每个包的 `vitest.config.ts` 设 `ssr: { resolve: { conditions: ['@wevir/source'] } }`。
   - Node 直接运行、tsdown 打包和发布不认这个条件，照常走 `dist/`。

   按 node_modules 里实际安装的版本核实：
   - **TypeScript 7.0.2（tsgo）**：`tsc --all` 列出 `--customConditions`，与 `nodenext` 一起生效；`tsc --listFiles` 显示消费方程序里是 `packages/*/src/*.ts`。
   - **Vitest 5.0.3 + Vite 8.3.4**：按 glob 发现的 project 配置文件不继承根配置（`extends` 只存在于内联 project 的类型 `TestProjectInlineConfiguration`），写在根 `vitest.config.ts` 实测无效。Node 环境的测试跑在 Vite 的 `ssr` 环境里，Vitest 的 `vitest:config` 插件给 `environments.ssr.resolve` 设了默认条件 `['node', 'development|production']`，所以顶层 `resolve.conditions` 到不了 ssr 环境（实测仍失败）；`ssr.resolve.conditions` 生效，并与默认值拼接成 `['@wevir/source', 'node', 'development|production']`，不需要手动带上 `defaultServerConditions`。
   - **tsdown 0.23.1**：消费方构建时，`dependencies` 里的 `@wevir/*` 默认 external，JS 与 d.ts 产物都保留 `import … from '@wevir/protocol'`，运行时由 Node 按默认条件解析到 `dist/`（构建后用纯 Node 运行通过）。tsdown 自带的 `exports.devExports: '<条件名>'` 能生成同样形状的 exports，但它在每次构建时改写 `package.json`，生成的条目也没有 `types`，所以 exports 继续手写；条件名不变，以后改用它不影响本约定。
   - **验收**：临时消费方包同时 import 两个包（含 `./echo`、`./contract`，并跑一遍 `runAdapterContract`，另用 `@ts-expect-error` 确认类型没有退化成 `any`）。删除全部 `dist/` 后 `pnpm typecheck`、`pnpm test`（9 个测试文件，255 通过、3 跳过）、`pnpm lint` 通过；把 protocol 的 `dist/` 换成一加载就抛错、类型故意写错的文件后，消费方的测试和类型检查仍通过，说明优先走源码。临时包已删除。

   备选方案：TS project references + `tsc -b`（tsgo 7.0 支持 `--build`）只解决类型检查，Vitest 仍按 exports 解析到 `dist/`，而且 `composite` 要输出 d.ts 和 tsbuildinfo，与 tsdown 的 `dist/` 成为两个 d.ts 来源；要求先 `pnpm build` 会让每次类型检查和测试都全量构建，`dist/` 过期时静默测旧代码，CI 多一步；tsconfig `paths` 或 Vitest `resolve.alias` 要在 exports 之外再维护一份子路径映射，还绕过了 exports 的封装。三者都不采纳。

   后果：
   - 消费方类型检查会用**自己的** compilerOptions 检查依赖包的源码，所以消费方的 `types` 要覆盖依赖源码用到的环境类型。例如依赖 `@wevir/runtime-adapter` 的包要有 `"types": ["node"]`（`contract.ts` 用了 `process`）。
   - 只有类型检查和 Vitest 认这个条件。在 Node 里直接运行工作区包（如 T2.5 的 `wevir-host` 入口）仍要先 `pnpm build`。不要给 `node` 传 `--conditions=@wevir/source`：Node 22.18 起虽然能剥离类型，但源码里的相对导入写的是 `.js`，实测（Node 26）报 `ERR_MODULE_NOT_FOUND`。
   - Vitest 把 `ssr.resolve.conditions` 原样作为 `--conditions` 传给测试 worker（换成 `environments.ssr` 写法也一样）。`child_process.fork` 默认继承 `process.execArgv`，所以测试里 fork 出来的 Node 子进程加载工作区包时会落到 `src/` 并失败。启动子进程用 `spawn(process.execPath, …)`，或给 `fork` 显式传 `execArgv`；子进程跑的是 `dist/`，这类测试（如 Gate M2 里杀掉并重启 Host）要先 `pnpm build`。
   - T6.2 的 CI 跑 typecheck / test 前不需要构建，只有上一条那类测试出现时再加。
   - 以后有 jsdom / happy-dom 等 Web 环境的 project（T5.x 的 renderer）时，这些测试走 Vite 的 client 环境，要再设顶层 `resolve.conditions: ['@wevir/source']`（实测同样与默认值拼接）。electron-vite 的开发构建如果要直接用源码，也要在 renderer 配置里加这个条件，否则按默认条件走 `dist/`。
   - 包都是 `private`，`files` 只含 `dist`；万一将来发布，`@wevir/source` 指向的 `src/` 不在包里，但外部不会启用这个条件。

2. **2026-10-13，T3.1：dsh 依赖的构建脚本。** pnpm 12.6 安装 `@deepseek-ai/dsh@0.2.1-alpha.2` 时 `ERR_PNPM_IGNORED_BUILDS` 报出的正好是 T0.3 在 npm 下的那 5 个包。闭包里另有 sharp、sherpa-onnx、libreoffice-kit 等原生包，它们的预编译文件放在可选的平台包里，没有安装脚本，所以 pnpm 没有报。`allowBuilds` 的键写成 `<包>@<精确版本>`：依赖升级换了版本，安装就会重新报错，迫使逐个重新审查。每一项的理由写在 `pnpm-workspace.yaml` 的注释里：
   - 放行：`@deepseek-ai/dsh-subprocess-local`、`node-pty`、`koffi`；
   - 拒绝：`@google/genai`、`protobufjs`。

   取舍与上游 dsh 仓库自己 `pnpm-workspace.yaml` 的 `allowBuilds` 一致。另外两点：
   - 报 `ERR_PNPM_IGNORED_BUILDS` 的同时，pnpm 会往 `pnpm-workspace.yaml` 里写入值为 `set this to true or false` 的占位条目，审查时要把它们换成真正的布尔值。
   - 本机实测：没有执行安装脚本时，`koffi` 与 `node-pty` 的预编译文件在 macOS arm64 上也能加载。放行它们是为了覆盖缺预编译的平台、被省略的可选包，以及 Windows 上 ConPTY 的文件放置。

3. **2026-10-13，chore（T3.1 的发现）：命令 shim 的 `NODE_PATH` 绕过依赖隔离。** pnpm 默认（`extendNodePath: true`）在 `node_modules/.bin` 的每个命令 shim 里导出 `NODE_PATH=<该工具自己的依赖目录>:node_modules/.pnpm/node_modules`。后者是 `hoistPattern` 默认 `*` 的私有提升目录，`@deepseek-ai/dsh` 及其依赖闭包里共 300 个 `@deepseek-ai/*` 包都在里面。CommonJS 解析沿目录查找失败后会再查 `NODE_PATH`，所以经 shim 启动的进程（`pnpm test` 和包目录里的 `pnpm test` 都走 `.bin/vitest`）及其子进程里，没声明依赖也能 `createRequire(…).resolve('@deepseek-ai/dsh/package.json')`。规则 2 原先“`require()`、`createRequire()` 在运行时也会失败”的说法只对纯 `node` 成立：违规代码的测试会通过，生产会失败。

   本机复现（pnpm 12.6.0、Vitest 5.0.3，`packages/host` 里的临时测试，已删除）：
   - Vitest worker 的 `NODE_PATH` 是 vitest 自己的两个依赖目录加 `node_modules/.pnpm/node_modules`，`createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')` 解析到 `.pnpm/@deepseek-ai+dsh@0.2.1-alpha.2_…`。
   - 在 `packages/host` 下直接 `node -e`、`pnpm exec node`、`pnpm run` 脚本里的 `node`（`pnpm dev:host`、`pnpm gate:m2` 就是这种）都没有 `NODE_PATH`，同样的调用报 `MODULE_NOT_FOUND`。
   - ESM 不受影响：同一个 worker 里 `import('@deepseek-ai/dsh/package.json')` 和 `import.meta.resolve('@deepseek-ai/dsh')` 都报找不到包。

   定为：`pnpm-workspace.yaml` 设 `extendNodePath: false`，shim 不再导出 `NODE_PATH`，经 shim 启动的进程与纯 `node` 的解析结果一致。核实：
   - pnpm 12.6 认这个设置，但只在创建 shim 时生效：改了设置后普通的 `pnpm install` 报 “Already up to date”，旧 shim 原样保留；`pnpm install --force`（或删掉 `node_modules` 重装）后 shim 里没有 `NODE_PATH`。lockfile 不记录这个设置，`pnpm-lock.yaml` 没有变化。
   - 设置后，从根目录跑和在包目录里跑 Vitest，上面的探针都报 `Cannot find module`。`pnpm lint`、`pnpm typecheck`、`pnpm test`（33 个测试文件，526 通过、1 跳过）、`pnpm build` 通过。
   - pnpm 文档（`settings/other` 的 `extendNodePath`）说这个 `NODE_PATH` 是给从工作目录解析模块的 CLI 准备的（例如 jest、eslint 用的 `import-local`）。仓库现有的工具（Vitest、tsc、Biome、tsdown）不靠它；以后引入这类工具，要先确认它在 `extendNodePath: false` 下能用，不能为它重新打开。

   设置只在创建 shim 时生效，单靠它的话，设置被去掉或 checkout 在设置之前装过依赖，测试都会静默放过违规写法。所以 `check-engine-boundary.mjs` 再检查根目录和各工作区包 `node_modules/.bin` 里已生成的 shim：任何一个普通文件里出现 `NODE_PATH` 就失败，提示补上设置并 `pnpm install --force`。符号链接（指向工具自己的 JS）不检查。实测把设置改成 `true` 并 `pnpm install --force` 后，`pnpm lint` 对全部 6 个 shim 报错；改回并重装后通过。

   备选方案：
   - 在根 `vitest.config.ts` 顶部 `delete process.env.NODE_PATH`（配置在 Vitest 主进程里先于 worker 求值）：实测对根目录的 `pnpm test` 有效，但在包目录里跑只加载包自己的配置，仍然泄漏；每个包都写一遍又要求新包照抄。不采纳。
   - 在 `check-engine-boundary.mjs` 里 grep `require(` / `createRequire` 配 `@deepseek-ai`：包名通常是 `createRequire(…)` 返回函数的参数，正则只能退化成“禁止任何 `@deepseek-ai/` 字符串”，与 Biome 规则重叠，也挡不住拼出来的包名；而且只管引擎包，其他没声明的依赖照样测试通过、生产失败。不采纳。
   - 收窄 `hoistPattern`（例如加 `!@deepseek-ai/*`）：改的是 dsh 依赖闭包的安装布局，dsh 子包之间若靠私有提升互相解析就会坏，要重新验证整个 dsh；同样只管引擎包。不采纳。

   后果：
   - 之前装过依赖的 checkout 要执行一次 `pnpm install --force`，否则 `pnpm lint` 失败。以后 T6.2 的 CI 每次全新安装，不受影响。
   - 另外两个设置也会注入 `NODE_PATH`，一并禁用（pnpm 12 CHANGELOG）：`enableGlobalVirtualStore` 让 `pnpm run` / `pnpm exec` 起的每个进程都带 `NODE_PATH`，还用 `NODE_OPTIONS` 的 `--import` 钩子让 ESM 也认它；`preferSymlinkedExecutables` 把 `.bin` 换成符号链接，同时给脚本导出 `NODE_PATH`（`node-linker=hoisted` 时自动开启）。这两项注入的 `NODE_PATH` 不写在 shim 文件里，上面的 shim 检查发现不了，只靠文档禁止。
   - adapter-dsh 给 dsh 子进程的白名单环境本来就不传 `NODE_PATH`（ADR-0001），不变。

4. **2026-10-13，T5.1：桌面端的版本、构建细则与构建脚本。** 按决策 3 选定（2026-10-13 查 npm registry）：electron-vite 5.0.0（最新正式版，peer 为 Vite 5–7；6.0 仍是 `6.0.0-beta.8`）+ Vite 7.3.7；Electron 44.7.0（最新稳定版）；`@vitejs/plugin-react` 5.2.0（6.x 只支持 Vite 8）；React 19.3、Tailwind 4.3（`@tailwindcss/vite`）。都是 `apps/desktop` 的 devDependencies，由打包器打进产物。与决策 2、3 不符或没写到的部分：
   - **Electron 不再有 postinstall。** 决策 2 预计 T5.1 要在 `allowBuilds` 登记 `electron`（postinstall 下载二进制）。Electron 44 的包里已经没有 `scripts`：二进制在第一次 `require('electron')`（electron-vite 启动 Electron 时）由 `index.js` 调用自带的 `install.js` 下载，仍经 `@electron/get`，`ELECTRON_MIRROR` 照常生效（`.npmrc` 注释已更新）；也可以手动 `npx install-electron`。所以 `electron` 不需要登记，pnpm 也没有报它。
   - **登记的是 esbuild。** 引入桌面端后 pnpm 报出 `esbuild@0.25.12`（electron-vite 5 的依赖）与 `esbuild@0.28.2`（Vite 7 的依赖，Vitest 用的 Vite 8 也解析到它）。两者都放行，理由写在 `pnpm-workspace.yaml`：postinstall 核对平台可选包里的二进制版本、在非 Windows 上用二进制替换 JS 转发脚本，可选包缺失时才从 registry 下载；与上游 dsh、OpenWork 的取舍一致。
   - **preload**：包是 `"type": "module"`，electron-vite 默认把 main 与 preload 都打成 ESM（preload 输出 `.mjs`）。preload 显式设 `build.rollupOptions.output.format: 'cjs'`，产物是单个 `out/preload/index.cjs`，只 `require('electron')`；`build.externalizeDeps: false`，不外置任何依赖。只有一个 preload 入口，用不到 `isolatedEntries`。main 保持 ESM（`out/main/index.js`）。
   - **工作区包走源码**：main 与 renderer 都按补记 1 的 `@wevir/source` 条件把 `@wevir/client-sdk`、`@wevir/host`（只用 `./runtime`）、`@wevir/protocol` 的源码打进产物（main 的 `externalizeDeps.exclude` 去掉它们；renderer 的 `resolve.conditions` 是 `['@wevir/source', ...defaultClientConditions]`）。核实：产物里没有 `@wevir/*` 的 import，也没有 tsdown 产物特有的 `//#region` 标记。Host 本身仍是 `packages/host/dist` 的子进程，所以桌面端的 `dev` 脚本先 `pnpm --filter "@wevir/host..." build`。
   - **electron-vite 的配置文件**由 esbuild 打包、裸导入一律外置，所以 `electron.vite.config.ts` 只引用相对路径的 `src/shared/*.ts`（开发服务器端口、CSP），不引用工作区包，免得配置加载依赖 `dist/`。
   - **TypeScript**：主进程、preload、共用模块按根配置的 NodeNext 检查（`apps/desktop/tsconfig.json`）；渲染进程有自己的 `src/renderer/tsconfig.json`（`module: preserve`、`moduleResolution: bundler`、只有 DOM 类型）。Biome 对 renderer、preload、shared 开 `noNodejsModules`。

5. **2026-10-13，T5.2：UI 原语、样式与路由的实际选择。** 决策 4 的默认值全部采用，没有推翻。版本（2026-10-13 查 npm registry）与决策 4 没写到的部分：
   - **原语**：shadcn CLI 4.21.4 的 `base-nova` 风格（`apps/desktop/components.json`：Base UI 1.9.0、lucide）。Nova 是紧凑型（控件高 32px、正文类控件用 `text-sm`），适合桌面工作台；Mira 更紧凑，但控件字号 12px，对中文偏小；不用 OpenWork 的 `base-luma`。生成的文件头写明“由 shadcn CLI 生成（MIT，© shadcn）”和 Wevir 的改动（遮罩改用语义色、`transition-all` 改为只过渡颜色与阴影、关闭按钮文案走 `t()`）。除任务列出的几个原语外多生成了 `sheet`，左栏与右栏在窄窗口下的浮层用它。
   - **`cn` 包**：shadcn 4.x 生成的组件直接 `import { cn } from 'cn'`（cn 0.4.0，shadcn 维护，替代 `clsx` + `tailwind-merge`），不再有 `lib/utils.ts`。shadcn 默认还依赖 `shadcn/tailwind.css`（为一份 CSS 把 CLI 装成依赖），改为把用到的 `data-open` 等自定义变体摘进 `src/renderer/src/styles/shadcn-variants.css`；动画工具类照常依赖 `tw-animate-css` 1.4.0。
   - **shadcn CLI 只认当前目录的 `package.json` 与 `tsconfig.json`**：在 `src/renderer` 下运行会被当成新项目。所以 `components.json` 放在 `apps/desktop`，`@/` 别名写三处：`apps/desktop/tsconfig.json` 的 `paths`（只给 CLI 解析用）、`src/renderer/tsconfig.json` 的 `paths`、`electron.vite.config.ts` 与 `vitest.config.ts` 的 `resolve.alias`。以后加原语：在 `apps/desktop` 下 `npx shadcn@<版本> add <名字>`。
   - **CSP 与 Base UI**：Base UI 的 ScrollArea 运行时插入一个内联 `<style>` 隐藏原生滚动条，被渲染进程的 CSP（`style-src` 不含 `'unsafe-inline'`，当时生产也没有 nonce；U3 起有了，见补记 9，这里的做法不变）拦下，界面上露出滚动条轨道。按 Base UI 文档（`utils/csp-provider`）用 `<CSPProvider disableStyleElements>`，规则写进 `index.css`。以后引入 Select（`alignItemWithTrigger`）同样受影响。首帧前设置主题的脚本也因为 CSP 不能内联，放在 `src/renderer/public/theme-init.js`，以普通脚本同步加载。
   - **色阶**：`@radix-ui/colors` 3.0.0。不 import 它自带的 CSS（暗色选择器是 `.dark, .dark-theme`），由 `apps/desktop/scripts/generate-palette.ts` 从 JS 导出生成 `palette.css`（亮色在 `:root`、暗色在 `:root[data-theme="dark"]`、P3 写法同 Radix），测试核对文件与生成结果一致。Tailwind 自带调色板用 `--color-*: initial` 清空，只留语义色。
   - **路由**：react-router 8.4.0 的 `createHashRouter`。构建产物经 `wevir://` 协议按文件路径提供（`renderer-files.ts`），没有 SPA 回退，history 路由刷新会 404。
   - **lucide-react 1.55.0**：当时最新的 1.56.0 发布不到一天，被 pnpm 的 `minimumReleaseAge` 拦下；没有往 `pnpm-workspace.yaml` 加 `minimumReleaseAgeExclude`，改用前一个版本。注意 `pnpm add` 被拦时会自动写入这条豁免，审查时要删掉。
   - **Biome**：CSS 里有 `@theme`、`@custom-variant`、`@apply`，打开 `css.parser.tailwindDirectives`。
   - **渲染进程的测试**：只测不碰 DOM 的纯逻辑（路由、折叠规则、数据模型、文案），跑在 Node 上；Vitest 的类型会带进 Node 类型，所以测试另由 `src/renderer/tsconfig.test.json` 检查，`src/renderer/tsconfig.json` 排除测试，渲染进程源码仍然只有 DOM 类型。
   - 许可证：新增依赖里 `lucide-react` 为 ISC、`class-variance-authority` 为 Apache-2.0，其余 MIT，由 T6.3 汇总进第三方声明。

6. **2026-10-13，T5.3：会话视图的 Markdown 与高亮依赖。** 版本（2026-10-13 查 npm registry，都是 `apps/desktop` 的 devDependencies，由打包器打进产物）：
   - **marked 18.1.0 + DOMPurify 3.4.16**：与 OpenWork 候选 #4 同一套（marked 解析、DOMPurify 清洗、`dangerouslySetInnerHTML`），渲染器改写自它的 `markdown-primitive.ts`（UPSTREAM.md §4）。当时最新的 marked 18.1.1、DOMPurify 3.4.17 发布不到一天，被 `minimumReleaseAge` 拦下，用前一个版本；`pnpm add` 自动写进 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 已删掉，lockfile 里的条目改回旧版本后重装核对（同补记 5 的 lucide-react）。DOMPurify 是 MPL-2.0 OR Apache-2.0，选 Apache-2.0，T6.3 汇总进第三方声明。
   - **highlight.js 11.12.0（BSD-3-Clause），不用 OpenWork 的 Shiki**：渲染进程的 CSP 不放行 HTML 里的 `style` 属性（`style-src` 不含 `'unsafe-inline'`），Shiki 的输出是逐个 token 的内联 `style`；它默认的 Oniguruma 引擎还要 WebAssembly，CSP 的 `script-src` 没有 `'wasm-unsafe-eval'`。highlight.js 输出带类名的 `<span>`，颜色在 `styles/markdown.css` 里映射到 `tokens.css` 的代码 Token，亮暗主题跟着语义变量走。只用 `highlight.js/lib/common`（常见语言），动态 `import()` 成单独的 chunk，代码块进入视口附近才加载、才高亮。
   - **剪贴板**：渲染进程的权限一律拒绝（T5.1），`navigator.clipboard.writeText` 要 `clipboard-sanitized-write`，被拒；不放开权限，preload 加 `copyText`，由主进程 `clipboard.writeText` 代写（只写不读，校验发送方与长度）。
   - **渲染进程的测试**：Markdown 渲染器的测试跑在 Node 上，没有 DOM，DOMPurify 用不了，测试里 `vi.mock('dompurify')` 换成原样返回，只核对 marked 的输出与流式时的块复用；清洗本身在 Electron 渲染进程里核对（`javascript:` 链接、原文 HTML、属性注入）。

7. **2026-10-14，Codex 运行时调研：引擎边界加上 `@openai/codex*`。** ADR-0005 草案打算以 `codex app-server` 为默认引擎，将来由新包 `packages/adapter-codex` 独占它的 npm 包，与 dsh 的做法相同。提前把边界写进两道检查，免得以后有人先在别的包里引入：
   - `scripts/check-engine-boundary.mjs` 改为按引擎列表检查：`@deepseek-ai/*` → `packages/adapter-dsh`，`@openai/codex` 与 `@openai/codex-*`（含 `npm:@openai/codex…` 别名，平台包就是这样声明的）→ `packages/adapter-codex`。`@openai/codexfoo`、`@openai/agents` 这类名字不算。
   - `biome.json` 的 `noRestrictedImports` 在根规则、adapter-dsh 与 stream-tap 的覆盖里加上 `@openai/codex` 系列，另为 `packages/adapter-codex/**` 加一条覆盖：放行 codex，照旧拦 `@deepseek-ai/**` 与 `spikes/`。
   - 用临时的探针包核对过：其他包里的 `import '@openai/codex-sdk'`、`'@openai/codex/bin'` 与依赖声明（含别名）都报错，adapter-codex 里的 codex 不报、`@deepseek-ai/dsh` 报；探针已删除。
   - 目前没有任何包声明 codex：Spike 用的是 GitHub Release 的独立二进制（UPSTREAM.md §1.2），`spikes/` 不在 pnpm workspace 里。

8. **2026-10-14，U1：设计变量与字体换成「A 静器」，决策 4 与补记 5 的色阶、字体两项改了。** 维护者当天选定桌面端的视觉方向「A 静器」（方向稿登记在 CODEX_RUNTIME_PROMPTS.md「界面参考」），说明见 [docs/design/desktop-tokens.md](../design/desktop-tokens.md)。
   - **色阶不再取自 `@radix-ui/colors`**：静器的颜色是一组定值（品牌的象牙白与石墨黑、墨色主按钮、四种状态色），没有可用的 Radix 色阶，`palette.css` 改为手写的原始色（不随主题切换，浅色、深色各用哪些由 `tokens.css` 定），删掉 `scripts/generate-palette.ts`、它的测试、`palette` 脚本与依赖；主进程的窗口底色改用 `src/shared/theme.ts` 的 `THEME_BACKGROUND`。三层结构与“暗色只认 `data-theme`”不变；Tailwind 自带的阴影也清空，只留语义的一档。
   - **字体随应用打包**：决策 4 的“不引入网络字体”不变，“用系统字体栈”改为：拉丁字母用 Mona Sans、代码用 JetBrains Mono、标题宋体用 Noto Serif SC 的固定文案子集，WOFF2 由 `apps/desktop/scripts/build-fonts.py` 从固定版本生成并提交（可选工具 fonttools，同图标的转曲脚本），中文正文仍用系统字体（维护者定，不打包）。CSP 不变（`font-src 'self'`）；Vite 默认把小于 4 KiB 的资源内联成 `data:` URI，`electron.vite.config.ts` 让 `.woff2` 总是单独成文件。
   - **校验**：`styles/tokens.test.ts` 从 CSS 读值核对文字对背景的对比度（正文与说明文字至少 4.5:1）与几条结构约定，代替原来“生成结果一致”的测试。

9. **2026-10-14，U3：接入 libraries.dev 的动效库，生产 CSP 的样式改用每次加载的 nonce。** 维护者定的位置与参数见 CODEX_RUNTIME_PROMPTS.md「界面参考」的方向稿（`src/fx.jsx`）。
   - **版本**（2026-10-14 查 npm registry，取发布满两周的，精确版本，都是 `apps/desktop` 的 devDependencies）：`border-beam` 1.4.1、`thinking-orbs` 0.3.2、`bot-avatars` 0.1.2（0.2.x 不满两周）、`liquid-gooey` 0.2.2、`metal-fx` 2.0.11、`img-fx` 0.5.1 与它的 peer `three` 0.186.1。都是 MIT、零运行时依赖；`metal-fx` 内含 Paper Shaders 的 `liquidMetal`（Apache-2.0，`NOTICE` 收进根目录 `NOTICE` §8 与 third-party-notices.md）。`voice-glow` 没装：语音输入还没做（TODO.md）。
   - **封装**在 `apps/desktop/src/renderer/src/fx/`：所有库都显式传 Wevir 自己的主题（`theme/theme.ts`，可以和系统不同），不用库的 `'auto'`；减弱动效由 `fx/motion.ts` 的 `useReducedMotion` 订阅。逐个核对的结果：thinking-orbs、liquid-gooey、border-beam 的 pulse 类自己处理（静帧 / 不动）；border-beam 的 line、metal-fx 的金属流动、img-fx 不管，由封装停下（光束不亮、金属暂停、图片直接显示）；bot-avatars 与 MetalText / MetalBadge 只在挂载时看一次或没有暂停属性，前者设置变了重挂、后两者换成不动的同款文字与徽标。Wevir 自己的扫光（`.shimmer`）已在 U2 照顾到。
   - **CSP**：border-beam 每个实例渲染一个 `<style>`（按实例与属性生成），metal-fx、img-fx 在模块加载时往 `<head>` 插全局样式，`style-src 'self'` 全部拦下（开发服务器也拦，不是只有生产）。比较了只对样式放开 `'unsafe-inline'`、把样式静态提取（border-beam 只能 fork / patch）、每次加载随机 nonce 三种，选了 nonce：构建时 Vite 的 `html.cspNonce` 写占位符，`wevir:` 协议处理器每次提供 index.html 生成 128 位 nonce 并写进那次的响应头，渲染进程的 `lib/style-nonce.ts`（`main.tsx` 第一个 import）给 `document.createElement('style')` 建出的元素盖上它。注入的标记（innerHTML、DOMParser 建的 `<style>`）与 `style` 属性照旧被拦，`script-src` 不带 nonce；代价是能在渲染进程执行脚本的人能加样式（这种人本来就拿到了全部权限）。理由与取舍写在 `src/shared/csp.ts` 的文件头。WebGL 不受 CSP 管，这些库不建 Worker、不用 `blob:` 与 `eval`，`default-src 'none'` 不用放开别的；生产构建里实测只有一条既有的 `script-src eval` 报告，是 zod 4 探测能不能用 `new Function` 的（catch 住，与 U3 无关）。Base UI 的 `CSPProvider disableStyleElements`（补记 5）不变。
   - **metal-fx 的补丁**（`patches/metal-fx@2.0.11.patch`，`pnpm-workspace.yaml` 的 `patchedDependencies`）：最后一个实例卸载时库调 `WEBGL_lose_context.loseContext()`，那次异步的 `webglcontextlost` 回调写的是模块级的共享状态；同一次提交里新建的实例（切换会话时输入框按会话 ID 重挂）拿到的新状态被标成“上下文丢失”，永远 `visibility: hidden`，发送按钮整个不见（方向稿记的“初始化到一半被卸载”就是它）。在生产构建里复现（会话 A → B 必现），屏蔽 `loseContext` 后消失，补丁让两个回调只认自己那块画布，复测正常。只改 ESM 产物；升级 metal-fx 时先看上游修了没有。另外全页只有一套金属预设，MetalText / MetalBadge 写死了 chromatic，`fx/metal.tsx` 用 `setSharedPresetMode` 把它钉在当前主题的 gold。
   - **性能**（Electron 44，M 系列 Mac，生产构建，窗口可见时 10 s 内 CPU 时间 / 墙钟）：空闲的会话页 GPU 进程约 0.7%、渲染进程约 0.8%（U3 之前约 0）；回合进行中约 30–38% / 37–42%（U3 之前约 12–16% / 12–15%，差额主要是输入框的 line 光束、两个 orb 与流动的金属，JS 只占 6 s 里的 23 ms，开销在重绘与合成）；窗口被遮住时全部停下（rAF 停）。两处按测量改了：bot-avatars 的闲置动画每个实例 60fps 重画，两个闲着的头像就要 GPU 约 20%、渲染约 12%，改为只有运行中的子智能体与指针悬停的可交互头像在动；金属框只在有字可发、回合进行中或悬停时流动（一个流动的金属框约 GPU 11%、渲染 7%）。同屏 WebGL：metal-fx 全页共用一个 GL 上下文；img-fx 也共用一个渲染器，显现完换成普通 `<img>`，不留实例。
   - **体积**（Vite 产物，未压缩 / gzip）：同步加载的五个库共约 463 KB / 120 KB（metal-fx 119/35、liquid-gooey 104/27、border-beam 99/14、bot-avatars 91/30、thinking-orbs 50/14），主 chunk 从 2.22 MB 到 2.67 MB；`img-fx` + `three` 是单独的 chunk，约 1.16 MB（gzip 约 216 KB），只有出现图片时才请求（生产构建里核对过：会话页不加载，`window.__THREE__` 只在显现图片后出现）。
   - **图片**：协议的工具结果只有文本（Codex 的 `imageView` 只给本机路径），img-fx 的显现组件 `fx/image-reveal.tsx` 先做好、暂时只在动效样张里用，接入点与协议工作记在 TODO.md（维护者 2026-10-14 定）。动效样张 `fx/fx-gallery.tsx` 在开发模式的 `#/dev/fx`，正式构建带 `VITE_WEVIR_FX_GALLERY=1` 才有，用来在生产 CSP 下核对效果。
10. **2026-10-15，0.20.0：“变更”窗格的 diff 渲染依赖与 CSP。** 维护者定照搬 T3 Code 的 diff 右栏（UPSTREAM.md §2.5、§4），渲染用它用的 `@pierre/diffs`。
   - **版本**（2026-10-15 查 npm registry，取发布满两周的，精确版本，都是 `apps/desktop` 的 devDependencies，由 Vite 打进产物）：`@pierre/diffs` 1.5.1（2026-09-25；T3 钉的 1.5.2 发布于 2026-10-05，不满两周，两版的 API 差别只在 1.5.2 新加的滚动锚定与 worker 报错，Wevir 用不到）、`shiki` 4.4.3 与 `@shikijs/transformers` 4.4.3（2026-08-10；4.5.0 发布刚满两周，没取）。新进 lockfile 的传递依赖（`@pierre/theme` 2.0.0、`@pierre/theming` 1.0.1、`@shikijs/*`、hast / unist 一族等）逐个核对过发布时间，最新的是 2026-09-26。没有构建脚本。许可证：`@pierre/*` 是 Apache-2.0（`@pierre/theme` 带 NOTICE，收进根目录 `NOTICE` 第 11 节），Shiki 是 MIT。
   - **补丁**（`patches/@pierre__diffs@1.5.1.patch`）：Pierre 把 diff 的行写成带 `style` 属性的 HTML（`grid-row` 的跨行、行号列宽、高亮的颜色），渲染进程的 CSP 不放行 HTML 里的 `style` 属性（补记 9）：属性留在元素上但不生效，每一处还报一次违规。比较过对 `style-src-attr` 放开 `'unsafe-inline'`（补记 9 不放开内联样式的理由同样成立）、全局拦截 `innerHTML`（会给别处注入的标记也补上样式）与补丁三种，选了补丁：只在 `FileDiff.js` 写 Pierre 自己的 HAST 生成的 HTML 时，先把 `style` 挪到 `data-csp-style`，写完经 CSSOM（不受 CSP 管）补上。另外分隔条上写死的英文（“N unmodified lines”等）改由新加的 `setDiffsText` 提供，文案走 i18n。T3 自己的补丁（搜索）没有用。升级 Pierre 时重新核对写 HTML 的地方。
   - **CSP**（`apps/desktop/src/shared/csp.ts`）：`script-src` 加 `'wasm-unsafe-eval'`，Shiki 的 oniguruma 高亮引擎是 WebAssembly（二进制以 base64 内嵌在 JS 里），编译它要这一项；它不放行 `eval` / `new Function`。显式加 `worker-src 'self'`（高亮在同 origin 的模块 worker 里跑，`electron.vite.config.ts` 的 `worker.format: 'es'`，worker 里有动态 import）。实测（构建版的 `wevir://` 与开发服务器各一次）：worker 里 WebAssembly 编译成功、高亮正常，`securitypolicyviolation` 只有既有的 zod 那一条；去掉 `'wasm-unsafe-eval'` 后窗格画不出文件内容，说明这一项既必要、也确实在 worker 里生效。样式仍然只有 `'self'` 与 nonce。
   - **体积**（Vite 产物，未压缩 / gzip）：窗格第一次打开时才加载（`React.lazy`）：窗格与 Pierre 1.23 MB / 258 KB，高亮 worker 419 KB / 98 KB，oniguruma 的 WASM 622 KB / 231 KB；Shiki 的语法各自成块（约 300 个文件，渲染进程的产物目录从此约 16 MB），用到哪种语言才加载。启动时加载的主块里没有这些库。

11. **2026-10-16，0.32.0：文件预览的依赖与 CSP。** 维护者要文件窗格补齐办公格式，照搬 T3 Code 的文件预览与 OpenWork 的 workbook、Markdown 公式与 Mermaid（UPSTREAM.md §4，desktop-layout.md §19）。
   - **版本**（2026-10-16 查 npm registry，取发布满两周的，精确版本，都是 `apps/desktop` 的 devDependencies，由 Vite 打进产物）：`mermaid` 11.17.2（2026-08-25；T3 与 OpenWork 也在 11.17，12.x 的 12.1.0 发布刚满两周、12.2.0 不满，没取）、`katex` 0.18.10（2026-09-30；0.18.11 被作者标为误发、建议换 0.19.0，而 `marked-katex-extension` 的 peer 要 `<0.19`）、`marked-katex-extension` 5.1.13（2026-09-16，peer `marked <19`，Wevir 是 18.1）、`htmlparser2` 8.0.2（OpenWork 的 workbook 钉的版本）。新进 lockfile 的传递依赖约 120 个（Mermaid 的 d3、cytoscape、dagre 等），没有构建脚本。许可证见 third-party-notices.md §2.2：MIT 为主，d3 一族 ISC、几个 BSD，`@mermaid-js/parser` 打包的 Chevrotain 是 Apache-2.0（没有 NOTICE）。
   - **CSP**（`apps/desktop/src/shared/csp.ts`）：`img-src`、`media-src`、`frame-src`、`connect-src` 放行 Host 的文件地址 `http://127.0.0.1:*`（`workspace.fileUrl`，host-api.md §1 的 `GET /files/…`；端口每次启动由系统分配，同 `connect-src` 的 WebSocket 只能放行整个端口范围）。比较过三种把大文件交给渲染进程的做法：base64 走 JSON-RPC（PDF、视频动辄几十 MB，超过连接的发送缓冲，不采纳）；主进程的自定义协议（要渲染进程告诉主进程会话目录、主进程信它，Chromium 的 PDF 查看器与自定义协议配合不确定，不采纳）；Host 发的令牌地址（采用，照 T3 Code 的签名资源地址：Host 知道会话目录、自己校验，令牌只在内存里、一小时作废，只读、只给能预览的几类文件）。脚本与样式仍然只有 `'self'`、nonce 与 `'wasm-unsafe-eval'`，没有 `'unsafe-inline'`。
   - **框架里的内容**：PDF 用 Chromium 自带的查看器（不加沙箱的框架；实测 Electron 44 不需要 `webPreferences.plugins`），网页放进 `sandbox` 框架（不透明 origin），Host 的 HTML 响应另带沙箱与不能联网的 CSP（T3 + Paseo）。主进程的子框架规则：`will-frame-navigate` 与 `session.webRequest.onBeforeRequest` 只许子框架加载 Host 的文件地址与 PDF 查看器自己的框架（`chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai`；`chrome-extension:` 不是特殊协议，`URL.origin` 是 `'null'`，按协议与主机比）。沙箱里跨 origin 的框架自己发起的跳转不触发 `will-frame-navigate`，所以另用 `webRequest` 拦，实测脚本跳转与 meta refresh 都发不出请求。页面里点外部链接由 Host 插进页面的一段脚本请窗格打开（T3 的 htmlRender），框架有焦点、用户刚点过时才交给系统浏览器。
   - **内联样式**：KaTeX 的 HTML 与 Mermaid 的 SVG 都带 `style` 属性。照补记 10 的做法不放开 `style-src-attr`：KaTeX 的输出在清洗前把 `style` 挪到 `data-csp-style`，挂上后经 CSSOM 补回；Mermaid 的 SVG 在解析前从字符串里挪开 `style` 属性与 `<style>`（DOMParser 与 DOMPurify 解析出的文档继承页面的 CSP，每个属性报一次违规），挂上后经 CSSOM 与样式 nonce 补回，Mermaid 渲染期间同样处理（`setAttribute('style')` 改走 CSSOM、它新建的 `<style>` 盖 nonce、它自己的 DOMPurify 解析前改名；渲染排队、结束后还原）。实测每张图从约 300 条违规报告降到 2 条（Mermaid 自己清洗时解析它的 `<style>`，惰性文档里不生效）。
   - **体积**（Vite 产物，未压缩）：KaTeX、OpenWork 的 workbook 与新的预览组件只在文件窗格的块里（`React.lazy`，1.10 MB，另有 25 KB 的 CSS 与 KaTeX 字体），Mermaid 第一次渲染图时才加载（主体 1.16 MB，各种图各自成块）；启动时加载的主块里只多了 Mermaid 的挂载代码与预览的数据钩子。
