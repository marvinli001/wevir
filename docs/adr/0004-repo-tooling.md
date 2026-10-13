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
| 依赖提升 | 不开 `node-linker=hoisted`、`shamefully-hoist`，不用 `public-hoist-pattern` 提升 `@deepseek-ai/*` | AGENTS.md 规则 2（没声明的包解析不到，是引擎边界的第二道保险） |

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
- 色阶取自 `@radix-ui/colors` npm 包，只取用到的色系；三层 Token（色阶 → 一套语义变量 → `@theme inline`），暗色只认 `data-theme`（OpenWork 研读 §9.3）。
- 不引入网络字体，用系统字体栈。

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
