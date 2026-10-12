# AGENTS.md

本文件是 Wevir 仓库对所有贡献者（包括 AI 编程助手）的规则。`CLAUDE.md` 只是指向这里。

Wevir 是面向中国大陆用户的本地优先、开源、多模型、可跨设备接续的 Agent 工作台：以 DeepSeek Harness（dsh）为 Agent 执行内核，以 OpenWork 为桌面交互参考，以 Paseo 为多端与远程架构参考，Wevir 自己拥有 Local Agent Host、会话协议和客户端。

开始工作前先读 [docs/SKELETON_PLAN.md](docs/SKELETON_PLAN.md) 的 §0–§4，以及当前任务所在里程碑的 §6 小节。

## 仓库规则

1. **一次改动只做一个任务。** 任务以 `docs/SKELETON_PLAN.md` §5 的 ID 为准。发现计划与现实不符，先改计划和对应 ADR，再改代码；不擅自扩大范围或提前做后续任务。
2. **引擎在适配器后面。** 除 `packages/adapter-dsh` 外，任何代码不得 import `@deepseek-ai/*`，也不得在 package.json 里声明它。`spikes/` 是不进入产品构建的一次性验证代码，可以直接用 dsh；反过来，产品代码不得引用 `spikes/`。`pnpm lint` 用两道检查强制：
   - Biome `noRestrictedImports`（`biome.json`）：拦截静态 import、`import type`、`export … from`、动态 `import()`、子路径，以及指向 `spikes/` 的导入。
   - `scripts/check-engine-boundary.mjs`：检查根目录和各工作区包的依赖声明（含 `npm:` 别名、指向 `spikes/` 的 `file:`/`link:`）。pnpm 的 node_modules 是隔离的，没声明的包解析不到，所以 `require()`、`createRequire()` 这类 lint 看不见的写法在运行时也会失败。因此不要开启 `node-linker=hoisted`、`shamefully-hoist`，也不要用 `public-hoist-pattern` 提升 `@deepseek-ai/*`。
3. **`upstream/` 只读。** 那里是上游仓库的参考克隆，不修改、不提交。移植上游代码时，在文件头写明来源仓库、路径、提交 SHA 和许可证，并登记到 `docs/upstream/UPSTREAM.md`。OpenWork 的 `ee/` 目录禁止参考和移植。
4. **不读原始调研聊天记录。** `~/Downloads` 下约 7MB 的调研记录不要喂给模型，需要的结论已经在 `docs/SKELETON_PLAN.md` 里。
5. **密钥不落地。** 模型 API Key 等密钥不得写入仓库、日志、测试快照或 `DSH_HOME`。Host 通过子进程环境变量把 Key 传给 dsh。
6. **先查文档再写 API。** 涉及第三方库、框架或上游项目的 API 时，先查当前文档或 `upstream/` 中的源码，不凭记忆写。
7. **风格跟随仓库。** 代码风格与已有代码保持一致，格式交给 Biome；不加与任务无关的抽象。

### 完成一个任务时

- 运行该任务的验收步骤，如实记录命令和结果。
- 在 `docs/SKELETON_PLAN.md` §5 把任务改为 `[x]`，备注写主要产出或提交号。
- 提交一次 commit，message 以任务 ID 开头，例如 `T1.2: add Host API v0 schemas`。

## 目录结构

当前：

```text
wevir/
├─ packages/
│  └─ protocol/        Host API 协议包（目前只有 PROTOCOL_VERSION 占位）
├─ docs/               规划、任务 prompt、ADR、研究笔记
├─ scripts/            仓库脚本（check-engine-boundary.mjs）
├─ biome.json          lint + format（含引擎边界规则）
├─ tsconfig.base.json  所有包共用的 TS 配置
└─ vitest.config.ts    根测试配置，每个包是一个 project
```

骨架阶段的目标结构（`apps/desktop`、`apps/cli`、`packages/host`、`packages/adapter-dsh` 等）见 [docs/SKELETON_PLAN.md §4.1](docs/SKELETON_PLAN.md#41-目标仓库结构)。gitignore 掉的本地目录：`upstream/`（上游克隆）、`.wevir-dev/`（开发期运行时数据）、`spikes/**/.dsh-home/`（Spike 用的独立 DSH_HOME）。

## 常用命令

环境：Node ≥ 22.19（`.node-version` 为 24 LTS），pnpm 版本见 `package.json` 的 `packageManager`。

| 命令 | 作用 |
|---|---|
| `pnpm install` | 安装依赖 |
| `pnpm build` | 构建所有包（库用 tsdown） |
| `pnpm dev` | 并行运行各包的 `dev` 脚本（目前没有包提供） |
| `pnpm lint` | `biome check`（lint、格式检查、import 边界）+ 依赖声明边界检查 |
| `pnpm lint:fix` | 自动修复 lint 与格式问题 |
| `pnpm format` | 只格式化 |
| `pnpm typecheck` | 各包 `tsc --noEmit` |
| `pnpm test` | 从根目录运行全部 Vitest project |
| `pnpm --filter @wevir/protocol test` | 只跑单个包 |

国内网络：npm 镜像与 `ELECTRON_MIRROR` 的切换方法写在 `.npmrc` 注释里。

## 写代码的约定

- 全仓库 ESM（`"type": "module"`），TypeScript strict。模块解析用 `NodeNext`，所以相对导入要写 `.js` 后缀：`import { x } from './x.js'`。只走打包器的包可以在自己的 tsconfig 里改用 `bundler`。
- 测试文件与源码放在一起，命名 `*.test.ts`，从 `vitest` 显式 import `describe` / `it` / `expect`。
- 新建一个库包时照 `packages/protocol` 抄：
  - `package.json`：`"type": "module"`，`exports` 指向 `dist/`，脚本 `build`（tsdown）、`typecheck`（`tsc --noEmit`）、`test`（`vitest run`）。
  - `tsconfig.json`：继承 `../../tsconfig.base.json`；运行在 Node 上的包加 `"types": ["node"]`。
  - `tsdown.config.ts` 与 `vitest.config.ts`（用 `defineProject` 写 `name`）。
- 公共开发工具（TypeScript、Biome、Vitest、tsdown、`@types/node`）装在根目录，包里只声明自己的运行时依赖。
