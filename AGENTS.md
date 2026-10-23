# AGENTS.md

本文件是 Wevir 仓库对所有贡献者（包括 AI 编程助手）的规则。`CLAUDE.md` 只是指向这里。

Wevir 是本地优先、开源、多模型的 AI Agent 工作台：以 OpenAI Codex 的 app-server 为默认执行引擎，经 Host 内置的模型协议网关接各家模型服务；桌面端与命令行共用本地 Host（会话协议、事件流、审批与存储）。

## 仓库规则

1. **一次改动只做一件事。** 不顺手做别的；发现文档与代码不符，先改文档再改代码。
2. **引擎在适配器后面。** 每个引擎的 npm 包只能由它的适配器包 import 和声明：`@openai/codex*` 只在 `packages/adapter-codex`（它目前不依赖任何 npm 包，运行官方发布的 `codex-app-server` 独立二进制），`@anthropic-ai/claude-agent-sdk` 与 `@anthropic-ai/claude-code` 只在 `packages/adapter-claude`，`@cursor/sdk*` 只在 `packages/adapter-cursor`，`@opencode-ai/*` 与 `@opencode/*` 只在 `packages/adapter-opencode`。Grok Build 的 CLI（`@xai-official/grok`）由用户自己装，谁都不声明，`packages/adapter-grok` 只启动它。WorkBuddy 经 `packages/adapter-workbuddy` 启动用户自己装的 `codebuddy --acp`，不声明或分发 `@tencent-ai/codebuddy-code` / `@tencent-ai/agent-sdk`。Devin 经 `packages/adapter-devin` 启动 `devin acp`（用户自己装的，或设置里按官方清单下载的独立程序），它不是 npm 包，适配器只依赖 `@wevir/adapter-acp`。Antigravity 的运行体不是 npm 包，`packages/adapter-antigravity` 只依赖 `@wevir/adapter-acp` 与解 ZIP 的 `yauzl`。`pnpm lint` 用两道检查强制：
   - Biome `noRestrictedImports`（`biome.json`）：拦截静态 import、`import type`、`export … from`、动态 `import()`、子路径。
   - `scripts/check-engine-boundary.mjs`：检查根目录和各工作区包的依赖声明（含 `npm:` 别名）。pnpm 的 node_modules 是隔离的，没声明的包解析不到，所以 `require()`、`createRequire()` 这类 lint 看不见的写法在运行时也会失败。例外是 `NODE_PATH`：pnpm 默认让 `node_modules/.bin` 的命令 shim 把私有提升目录 `node_modules/.pnpm/node_modules` 写进 `NODE_PATH`，经 shim 启动的 Vitest 及其子进程里这类写法能解析到，测试通过、生产失败。仓库在 `pnpm-workspace.yaml` 设了 `extendNodePath: false` 关掉它；这个设置只在创建 shim 时生效，之前装过依赖的 checkout 要 `pnpm install --force` 一次；`pnpm lint` 会检查已生成的 shim，发现导出 `NODE_PATH` 就失败。因此不要开启 `node-linker=hoisted`、`shamefully-hoist`、`enableGlobalVirtualStore`、`preferSymlinkedExecutables`，不要用 `public-hoist-pattern` 提升引擎包，也不要去掉 `extendNodePath: false`。
3. **`upstream/` 只读。** 那里是上游仓库的参考克隆，不修改、不提交。移植上游代码时，在文件头写明来源仓库、路径、提交 SHA 和许可证，并登记到 `docs/upstream/UPSTREAM.md`。OpenWork 的 `ee/` 目录禁止参考和移植。
4. **密钥不落地。** 模型 API Key 等密钥不得写入仓库、日志或测试快照。
5. **先查文档再写 API。** 涉及第三方库、框架或上游项目的 API 时，先查当前文档或 `upstream/` 中的源码，不凭记忆写。
6. **风格跟随仓库。** 代码风格与已有代码保持一致，格式交给 Biome；不加与任务无关的抽象。

### 完成一项改动时

- 运行相关的验证（lint、typecheck、测试，必要时在真实应用里走一遍），如实报告命令和结果，没跑的要说明。
- 提交一次 commit，message 用一句话说明改了什么。

## 界面文案

桌面端的文案都在 `apps/desktop/src/renderer/src/i18n/`，源语言是 `zh-CN.ts`，改一条要同时改全部语言的目录。

- 只写名称与必要信息：按钮、菜单、选项、状态用一两个词或名词短语，不加说明行、副标题、提示行与举例占位符。
- 判断标准是“删掉这段字，用户会不会用错、看不懂”，不会就删。保留的只有错误的原因与处理、确认框里的后果、配置事实与安全提醒。
- 书面语，不用口语：不写“请”“你”“这个”“还没”“例如”，不写解释概念的句子（“这是…不是…”“只说明…不代表…”），不在选项后用冒号解释（“增量：只补…”）。
- `i18n/copy-style.test.ts` 检查说明类 key（`*Hint`、`*.note`、`*.body` 等）、口语词与长度；不要为了过检查往名单里加条目。

## 目录结构

```text
wevir/
├─ apps/
│  ├─ cli/              wevir 命令行客户端
│  ├─ desktop/          Electron 桌面端（electron-vite）
│  ├─ mobile/           手机端（Expo 开发构建 + expo-router）：配对电脑、看会话
│  ├─ push/             推送网关（只收推送令牌与加密载荷，转给 APNs / FCM；Dockerfile 与环境变量说明）
│  ├─ relay/            远程访问的中继（默认关的兜底，只转发 Noise 密文；Dockerfile 与自建说明；共用的协议测试 conformance.ts）
│  └─ relay-worker/     同一中继的 Cloudflare Workers + Durable Objects 实现（线路协议相同，wrangler 配置与部署说明）
├─ assets/icons/        品牌图标的源文件与导出
├─ packages/
│  ├─ protocol/         Host API 协议：zod schema、方法与事件注册表、错误码
│  ├─ runtime-adapter/  引擎适配接口 AgentRuntimeAdapter / AgentEvent 与契约测试
│  ├─ storage/          Host 本地存储（node:sqlite、SQL 迁移）
│  ├─ host/             Local Agent Host：会话、事件库、审批、工具、WebSocket JSON-RPC 服务
│  ├─ client-sdk/       Host 的 TypeScript 客户端（浏览器与 Node 共用）
│  ├─ noise/            远程访问的 Noise 握手（XXpsk2 与 IK）与传输分片，Host、CLI 与手机共用
│  ├─ model-gateway/    模型协议网关：把 Codex 的 Responses 请求转成各家模型服务的协议
│  ├─ adapter-acp/      通用 ACP 适配器
│  ├─ adapter-codex/    Codex（app-server）适配器，默认引擎
│  ├─ adapter-claude/   Claude Agent 适配器
│  ├─ adapter-cursor/   Cursor 适配器
│  ├─ adapter-opencode/ OpenCode 适配器
│  ├─ adapter-grok/     Grok Build 适配器
│  ├─ adapter-antigravity/ Antigravity 适配器
│  ├─ adapter-workbuddy/   WorkBuddy 适配器
│  └─ adapter-devin/       Devin 适配器
├─ patches/             pnpm 的依赖补丁（`pnpm-workspace.yaml` 的 `patchedDependencies`）
├─ prompts/             Wevir 自己的提示词，随安装包分发
├─ scripts/             仓库脚本（引擎边界检查、上游同步、Codex 下载等）
├─ docs/upstream/       上游移植登记与第三方版权声明
├─ biome.json           lint 与格式化（含引擎边界规则）
├─ tsconfig.base.json   所有包共用的 TypeScript 配置
└─ vitest.config.ts     根测试配置，每个包是一个 project
```

`.gitignore` 里的本地目录：`upstream/`（上游克隆）、`.wevir-dev/`（开发期运行时数据）、`apps/desktop/resources/` 与 `apps/desktop/release/`（打包产物）。

## 常用命令

环境：Node ≥ 24.22.1（`.node-version` 钉在 24 LTS 的安全修复版），pnpm 版本见 `package.json` 的 `packageManager`。

| 命令 | 作用 |
|---|---|
| `pnpm install` | 安装依赖 |
| `pnpm build` | 构建所有包（库用 tsdown）；typecheck 和 test 不依赖它，只有在 Node 里直接运行包时才需要先构建 |
| `pnpm dev` | 构建 `@wevir/host` 及其依赖后启动桌面端（electron-vite dev）；桌面端附着到已有的 Host 或拉起一个，数据目录取 `WEVIR_HOME` 或平台默认 |
| `pnpm dev:host` | 以 EchoAdapter 在 `./.wevir-dev` 启动 `wevir-host`（Ctrl-C 优雅退出） |
| `pnpm --silent wevir <命令>` | 运行 CLI（先 `pnpm build`）：`host start`、`provider add`、`session new -w <路径> "<提示>"` 等，见 `--help` |
| `pnpm gate:m2` | 构建后运行 `scripts/gate-m2.ts`：Host 端到端验收，加 `--keep` 保留临时数据目录 |
| `pnpm lint` | `biome check`（lint、格式检查、import 边界）与依赖声明边界检查 |
| `pnpm lint:fix` / `pnpm format` | 自动修复 lint 与格式问题 / 只格式化 |
| `pnpm typecheck` | 各包 `tsc --noEmit` |
| `pnpm test` | 从根目录运行全部 Vitest project |
| `pnpm --filter @wevir/protocol test` | 只跑单个包 |
| `bash scripts/fetch-codex.sh` | 下载锁定版本的 `codex-app-server` 到 `.wevir-dev/bin/` 并校验 sha256（`WEVIR_GITHUB_MIRROR` 可替换 GitHub 前缀）；adapter-codex 的集成测试与 `--adapter codex` 要用，也可用 `WEVIR_CODEX_BIN` 指定别处的二进制 |
| `pnpm --filter @wevir/desktop resources` | 准备随安装包分发的运行时（要先 `pnpm build`），放进 `apps/desktop/resources/` |
| `pnpm --filter @wevir/mobile ios` / `android` | 生成原生工程并编译、安装手机端的开发构建（要 Xcode / Android SDK）；之后 `pnpm --filter @wevir/mobile start` 起 Metro |
| `pnpm --filter @wevir/desktop package` | 打安装包（要先 `pnpm build`），`--target <三元组>` 打别的平台，产物在 `apps/desktop/release/` |
| `pnpm vitest run --project adapter-<名字>` | 单个适配器的测试；真实引擎或真实模型的测试默认跳过并打印原因，要按各适配器测试文件头的说明设置环境变量（如 `WEVIR_TEST_API_KEY` 与 `WEVIR_TEST_PROVIDER`，或 `WEVIR_TEST_CLAUDE=1`、`WEVIR_TEST_GROK=1`、`WEVIR_TEST_OPENCODE=1`、`WEVIR_TEST_WORKBUDDY=1`、`WEVIR_TEST_DEVIN=1`；订阅类的会用掉额度） |
| `bash scripts/upstream-sync.sh` | 按 `docs/upstream/upstream.lock` 把上游参考仓库浅克隆到 `upstream/`；`WEVIR_GITHUB_MIRROR` 可替换 GitHub 前缀 |

国内网络：npm 镜像用 npmmirror，Electron 二进制用 `ELECTRON_MIRROR`，上游与 Codex 下载用 `WEVIR_GITHUB_MIRROR`。

## 写代码的约定

- 全仓库 ESM（`"type": "module"`），TypeScript strict。模块解析用 `NodeNext`，所以相对导入要写 `.js` 后缀：`import { x } from './x.js'`（`apps/desktop/scripts/` 里由 node 直接运行的脚本互相导入时写 `.ts`，那里的 tsconfig 开了 `allowImportingTsExtensions`）。只走打包器的包可以在自己的 tsconfig 里改用 `bundler`。`apps/mobile` 由 Metro 打包，不设 `"type"`、导入不写后缀，工作区包从源码解析（`metro.config.js`）。
- 测试文件与源码放在一起，命名 `*.test.ts`，从 `vitest` 显式 import `describe` / `it` / `expect`。
- 新建一个库包时照 `packages/protocol` 抄：
  - `package.json`：`"type": "module"`；`exports` 的每个子路径第一个条件写 `"@wevir/source": "./src/<入口>.ts"`，其后是指向 `dist/` 的 `types` / `default`；脚本 `build`（tsdown）、`typecheck`（`tsc --noEmit`）、`test`（`vitest run`）。
  - `tsconfig.json`：继承 `../../tsconfig.base.json`；运行在 Node 上的包加 `"types": ["node"]`。
  - `tsdown.config.ts` 与 `vitest.config.ts`（用 `defineProject` 写 `name`，并照抄 `ssr.resolve.conditions`）。
  - pnpm 12.6 的坑：新包没有 `dependencies`（什么都不依赖，或只声明了可选 peer）时，`pnpm install` 显示 “Already up to date”，不会往 `pnpm-lock.yaml` 写这个包的 `importers` 条目，之后 `pnpm install --frozen-lockfile`（CI）报 `ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER`；报错里建议的 `--lockfile-only` 也补不上。运行 `pnpm install --fix-lockfile`，确认 lockfile 里有 `packages/<名字>` 条目再提交。
- 工作区包之间的依赖用 `"workspace:*"` 声明。类型检查（`tsconfig.base.json` 的 `customConditions`）和 Vitest（各包的 `ssr.resolve.conditions`）都认 `@wevir/source` 条件，直接用依赖包的源码，不需要先 `pnpm build`；Node 直接运行、打包和发布走 `dist/`。由此带来三条要求：
  - 消费方的 `types` 要覆盖依赖源码用到的环境类型，例如依赖 `@wevir/runtime-adapter` 要有 `"types": ["node"]`。
  - 测试里启动 Node 子进程不要继承 Vitest worker 的 `execArgv`（里面有 `--conditions @wevir/source`）：用 `spawn(process.execPath, …)`，或给 `fork` 显式传 `execArgv`。子进程跑 `dist/`，这类测试要先 `pnpm build`。
  - Web 环境（jsdom 等）的 Vitest project 还要设顶层 `resolve.conditions: ['@wevir/source']`。
- 公共开发工具（TypeScript、Biome、Vitest、tsdown、`@types/node`）装在根目录，包里只声明自己的运行时依赖。
