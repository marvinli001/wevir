# AGENTS.md

本文件是 Wevir 仓库对所有贡献者（包括 AI 编程助手）的规则。`CLAUDE.md` 只是指向这里。

Wevir 是面向中国大陆用户的本地优先、开源、多模型、可跨设备接续的 Agent 工作台：以 OpenAI Codex 的 app-server 为默认 Agent 执行内核、经 Host 内置的模型协议网关接各家模型服务（[ADR-0005](docs/adr/0005-agent-runtime-and-model-gateway.md)，迁移中；目前代码里的引擎仍是 DeepSeek Harness（dsh），它以后保留为可选引擎），桌面交互混合参考 Codex 桌面端与 Claude Code 桌面端（维护者 2026-10-14 定，见 docs/CODEX_RUNTIME_PROMPTS.md「界面参考」；已移植的 OpenWork 代码保留），以 Paseo 为多端与远程架构参考，Wevir 自己拥有 Local Agent Host、会话协议和客户端。

**工作方式：** 开发方向、范围与优先级由维护者在对话中直接决定，AI 助手负责辅助思考、补充遗漏和实现。骨架阶段的计划与任务 prompt、骨架复盘时起草的 Phase 1 规划已归档在 [docs/archive/](docs/archive/)，只作历史参考，不作为任务来源。仍然有效的设计依据是 [ADR](docs/adr/README.md) 与 [架构文档](docs/architecture/overview.md)。迁到 Codex 运行时的任务（R1–R10，维护者 2026-10-14 定的顺序）各有一个 prompt，在 [docs/CODEX_RUNTIME_PROMPTS.md](docs/CODEX_RUNTIME_PROMPTS.md)。

## 仓库规则

1. **一次改动只做一件事。** 范围以维护者确认的为准，不擅自扩大范围或顺手做别的事。发现 ADR 或架构文档与现实不符，先改文档再改代码。
2. **引擎在适配器后面。** 每个引擎的 npm 包只能由它的适配器包 import 和声明：`@deepseek-ai/*` 只在 `packages/adapter-dsh`，`@openai/codex`（含 `@openai/codex-*`）只在 `packages/adapter-codex`（ADR-0005 草案，包尚未建立）。`spikes/` 是不进入产品构建的一次性验证代码，可以直接用引擎；反过来，产品代码不得引用 `spikes/`。`pnpm lint` 用两道检查强制：
   - Biome `noRestrictedImports`（`biome.json`）：拦截静态 import、`import type`、`export … from`、动态 `import()`、子路径，以及指向 `spikes/` 的导入。
   - `scripts/check-engine-boundary.mjs`：检查根目录和各工作区包的依赖声明（含 `npm:` 别名、指向 `spikes/` 的 `file:`/`link:`）。pnpm 的 node_modules 是隔离的，沿目录向上查找时没声明的包解析不到，所以 `require()`、`createRequire()` 这类 lint 看不见的写法在运行时也会失败。例外是 `NODE_PATH`：CommonJS 解析认它（ESM 的 `import` 不认），而 pnpm 默认让 `node_modules/.bin` 的命令 shim 把私有提升目录 `node_modules/.pnpm/node_modules`（`@deepseek-ai/*` 都在里面）写进 `NODE_PATH`，经 shim 启动的 Vitest 及其子进程里这类写法能解析到，测试通过、生产失败。仓库在 `pnpm-workspace.yaml` 设了 `extendNodePath: false` 关掉它（ADR-0004 补记 3）；这个设置只在创建 shim 时生效，之前装过依赖的 checkout 要 `pnpm install --force` 一次；`pnpm lint` 会检查已生成的 shim，发现导出 `NODE_PATH` 就失败。因此不要开启 `node-linker=hoisted`、`shamefully-hoist`、`enableGlobalVirtualStore`、`preferSymlinkedExecutables`，不要用 `public-hoist-pattern` 提升引擎包，也不要去掉 `extendNodePath: false`。
3. **`upstream/` 只读。** 那里是上游仓库的参考克隆，不修改、不提交。移植上游代码时，在文件头写明来源仓库、路径、提交 SHA 和许可证，并登记到 `docs/upstream/UPSTREAM.md`。OpenWork 的 `ee/` 目录禁止参考和移植。
4. **不读原始调研聊天记录。** `~/Downloads` 下约 7MB 的调研记录不要喂给模型，需要的结论已经提炼进 `docs/archive/skeleton/SKELETON_PLAN.md`（已归档）。
5. **密钥不落地。** 模型 API Key 等密钥不得写入仓库、日志、测试快照或 `DSH_HOME`。Host 通过子进程环境变量把 Key 传给 dsh。
6. **先查文档再写 API。** 涉及第三方库、框架或上游项目的 API 时，先查当前文档或 `upstream/` 中的源码，不凭记忆写。
7. **风格跟随仓库。** 代码风格与已有代码保持一致，格式交给 Biome；不加与任务无关的抽象。

### 完成一项改动时

- 运行相关的验证（lint、typecheck、测试，必要时在真实应用里走一遍），如实报告命令和结果，没跑的要说明。
- 改动影响到的 ADR、架构文档、`docs/development.md` 和本文件的目录说明一并更新。
- 提交一次 commit，message 用一句话说明改了什么。

## 目录结构

当前：

```text
wevir/
├─ apps/
│  ├─ cli/             wevir 命令行客户端（T4.2，可执行入口 src/main.ts → dist/main.js）：参数用 node:util parseArgs 自行分发（cli.ts，帮助与报错都是中文，错误带“下一步”，errors.ts）；host start|status|stop（commands/host.ts：start 以分离方式拉起 @wevir/host 的 wevir-host，自成进程组、不持有归属管道，stdout/stderr 写 logs/host-stdio.log，就绪以 host.json 有地址且能 hello 为准；stop 走 host.shutdown）；workspace、provider（不回显的 Key 输入，不接受命令行参数）、session 命令；attach（attach.ts：从头回放再接实时、按请求的选项交互式审批、另一端处理时显示处理者、SESSION_BUSY 提示、Ctrl-C 先取消后退出）、事件渲染（render.ts）、输入框与流式输出共处的终端（terminal.ts，readline + mute-stream）、一问一答（prompt.ts）；身份存在数据目录的 device-id / cli-client-id（identity.ts）。测试：进程内 echo Host + 伪 TTY 的集成测试（test-utils.ts 的 screen() 按终端效果还原屏幕），以及分离启动 Host 子进程的测试（要先 pnpm build）
│  └─ desktop/         Electron 桌面端（T5.1，electron-vite 5 + Vite 7，产物在 out/）：主进程 src/main（index.ts：窗口与安全基线——sandbox、contextIsolation、拒绝新窗口与跨 origin 导航、权限一律拒绝、IPC 校验发送方、开发模式才开的远程调试端口 9339；macOS 隐藏系统标题栏，红绿灯浮在页面左上角，进出全屏时把 WindowChrome 推给渲染进程；host-lifecycle.ts：读 run/host.json 探活后附着，否则用本机 Node 拉起 wevir-host 并持有 stdin 归属管道，退出时只停自己拉起的；T5.5 起拉起的 Host 意外退出时最多重新拉起 3 次（先按 host.json 的 {pid, startedAt} 确认旧进程已退出，都失败进入 failed 并给出日志路径），附着的 Host 不在了只等它回来，Host 进程状态 HostProcessStatus 经 onStatus 推给渲染进程；不依赖 Electron，对着真实 Host 测试（test-fixtures/ 里是测试用的 Host）；renderer-files.ts：构建产物经 wevir://app 协议加载并带 CSP；identity.ts：desktop-client-id）、preload src/preload（单个 CJS，只暴露 window.wevir 的 getHostConnection / getHostStatus / onHostStatus / retryHost / selectFolder / openExternal / copyText / setThemeSource / getWindowChrome / onWindowChrome；copyText 由主进程代写剪贴板，因为渲染进程的权限一律拒绝）、渲染进程 src/renderer（React + Tailwind v4，经 client-sdk 连 Host；自己的 tsconfig，只有 DOM 类型，测试另用 tsconfig.test.json；T5.2 起：设计 Token 三层在 src/styles——palette.css 由 scripts/generate-palette.ts 从 @radix-ui/colors 生成、tokens.css 是唯一一套语义变量、theme.css 是 Tailwind 的 @theme，暗色只认 <html data-theme="dark">；主题模式 theme/theme.ts（移植自 OpenWork）与首帧前脚本 public/theme-init.js 共用一个存储 key；shadcn CLI 生成的 Base UI 原语在 components/ui（components.json 在 apps/desktop，别名 @/ 指向 src/renderer/src），Wevir 的 IconButton / StatusDot 在 components；文案只经 i18n 的 t()，源语言 zh-CN；hash 路由 routes/（/workspace/:wid/session/:sid、草稿 /workspace/:wid/session、/settings/:tab，URL 是唯一事实，找不到就“未找到”）；三栏布局 layout/（折叠规则 layout-rules.ts、每会话一组右栏标签 right-panel-tabs.ts；顶栏用 index.css 的 app-drag 充当标题栏，红绿灯在时 window-chrome.ts 给 <html> 加 data-traffic-lights，左上角的顶栏按 --traffic-lights-inset 让位）；data/：左栏的工作区与会话列表 workbench-store.ts（连同 Provider 列表；连上 Host、每 10 s、获得焦点时重读列表，每个会话一条从 lastSeq 开始的订阅实时跟上状态与标题，按最近活动排序）与每会话的消息投影 transcript-store.ts（从 seq 0 订阅、client-sdk 的 TranscriptProjection、按帧取快照，保留最近 4 个会话）；T5.3 起会话视图在 session/：消息流 transcript-view.tsx（分段渲染 + content-visibility，贴底 / 手动滚动 scroll-controller.ts 改写自 OpenWork）、Markdown markdown/（marked + DOMPurify 的流式增量渲染改写自 OpenWork，高亮 highlight.js 定稿且进入视口后才做，样式在 styles/markdown.css）、工具卡片 tool-card.tsx 与纯逻辑 tool-model.ts（状态未知、被拒绝、读取 / 搜索聚合）、审批卡片 approval-card.tsx 与文案 approval-model.ts、输入框 composer.tsx、状态指示 session-status.tsx；engine.raw 只在开发模式投影；T5.4 起设置页在 settings/：Provider 列表与表单 provider-settings.tsx / provider-editor.tsx（纯逻辑 provider-form.ts，国内服务模板 provider-presets.ts 取自 providers.md §7，测试结果文案 provider-test-result.ts）、工作区 workspace-settings.tsx（经 selectFolder 添加；移除工作区或删除 Provider 被未关闭的会话挡住时先关闭它们，remove.ts）；首页 routes/home-route.tsx 在没有 Provider、工作区或会话时显示三步引导；T5.5 起：host/ 是到 Host 的连接（host-connection.tsx，client-sdk 自动重连、按 seq 续订，主进程报 Host 回到 running 时立即重连）与窗口顶部的连接提示 connection-banner.tsx（纯逻辑在 host-status.ts，左栏底部同一口径）；上次打开的工作区与会话记在 localStorage，新开窗口停在首页时恢复（routes/last-location.ts）；会话出错或只读时输入框上方的说明与操作 session/recovery-panel.tsx（恢复会话 / 基于历史新建会话，后者由 session/history-digest.ts 把对话记录放进新会话的输入框））、共用 src/shared（IPC 接口、渲染进程 origin、CSP、主题模式）。工作区包按 @wevir/source 条件用源码打进 main 与 renderer（main 是 SSR 构建，条件写在 ssr.resolve.conditions）；Host 本身跑 packages/host/dist，dev 脚本先构建它，再用 install-electron 装好 Electron 二进制
├─ packages/
│  ├─ protocol/        Host API 协议包：zod schema、方法注册表、事件、错误码（见 docs/architecture/host-api.md）
│  ├─ runtime-adapter/ 引擎适配接口 AgentRuntimeAdapter / AgentEvent；子路径 ./contract 是契约测试套件，./echo 是开发用假引擎
│  ├─ storage/         Host 本地存储：node:sqlite 驱动（只在 src/driver.ts）、事务、手写 SQL 迁移（migrations/）、各表仓储、SecretStore
│  ├─ adapter-dsh/     dsh 适配器（唯一可以依赖 @deepseek-ai/* 的包）：可执行入口解析与独立 DSH_HOME（paths.ts）、白名单环境（env.ts）、DshProcess（dsh --profile acp 的启动、initialize、退出上报与有限重启、stdin EOF → SIGTERM → SIGKILL 回收）；增量流式旁路：stream-tap/ 是在 dsh 进程里运行的 Cordis 插件（纯 JS，不 import @deepseek-ai/*），src/stream-tap.ts 负责把它装进 acp profile 并解码 fd 3 的 NDJSON；ACP → AgentEvent 映射（acp-mapping.ts、tool-display.ts、turn-error.ts，表见 docs/architecture/acp-event-mapping.md）、增量与已提交消息的对齐（delta-merge.ts）、每会话有序事件队列（session-events.ts）与 AgentRuntimeAdapter 实现 DshAdapter（dsh-adapter.ts，含审批桥接，见 acp-event-mapping.md §5）；Provider 桥接：ProviderConfig → `<DSH_HOME>/wevir/providers.yml` overlay 与 `WEVIR_PROVIDER_<ID>_KEY` 环境（provider-config.ts）、provider.test 的最小请求与失败归类（provider-test.ts），见 docs/architecture/providers.md；会话恢复：`session/resume` 与失败归类（resume-error.ts，丢失的会话报 `session_lost`），取消得不到确认时重启 dsh，见 acp-event-mapping.md §6；契约测试分三层（`dsh-adapter.contract*.test.ts`：T0.3 样本回放、真实 dsh + mock Provider、真实模型），dsh 升级按 docs/upstream/UPSTREAM.md §7 的检查清单；测试用假引擎（含样本回放）、mock 模型、真实模型的配置、审批用例的工作区外目录（`.test-outside/`，gitignore）、契约测试的共用部分与 ACP 样本（T0.3 的副本与后来补录的错误）在 src/test-fixtures/；子路径 ./testing 导出本地 mock Provider，给依赖本包做集成测试的包用
│  ├─ host/            Local Agent Host：事件库 EventStore（seq 分配、增量合并、截断、进程内事件总线）、会话快照推导、会话管理器 SessionManager（状态机、审批、引擎事件映射、启动对账、引擎会话恢复与只读标记）、WebSocket JSON-RPC 服务 HostRpcServer（升级校验、hello、分发与校验、订阅、连接健康）与 Host API 方法实现 createHostMethods；进程组装 startHost（运行时文件 run/host.json、结构化日志、按 ADR-0002 §6 优雅退出）与可执行入口 wevir-host（src/main.ts，`--adapter dsh` 为默认，经 @wevir/adapter-dsh 的公开导出建 DshAdapter，`--adapter echo` 是开发用假引擎）；子路径 ./runtime（src/runtime.ts：数据目录、host.json 的解析与陈旧判断、退出码 EXIT_CODE，只依赖 Node 内置模块，给拉起 Host 的客户端进程用）；Host + 真实 dsh 的端到端测试为 `*.dsh.integration.test.ts`
│  └─ client-sdk/      Host 的 TS 客户端（运行时只依赖 protocol，浏览器与 Node 共用）：WevirClient（connect 与 host.hello、默认能力表与功能判断、类型安全的 request 与类型化错误 errors.ts、断线排队）、订阅的异步迭代器（subscription.ts：按 seq 去重、缺口补订、回放结束标记、重连续订）、客户端消息投影（projection.ts 的 TranscriptProjection：事件 → 消息与部件，domain-model §8，CLI 与桌面共用）与会话列表的实时推导（session-state.ts 的 applySessionEvent）、每条连接的 JSON-RPC 与心跳（rpc-channel.ts）、重连状态机（lifecycle.ts，改写自 OpenWork）、可替换的传输层（transport.ts，WebSocket 由调用方注入）；子路径 ./node 读 run/host.json（node.ts，Node 内置模块只在这里）；tsconfig.browser.json 与 Biome noNodejsModules 守浏览器入口；对着真实 Host 的验收测试 `client.integration.test.ts` 以 devDependency 引用 @wevir/host
├─ docs/               Codex 运行时迁移的任务 prompt CODEX_RUNTIME_PROMPTS.md、已归档的计划（docs/archive/）、复盘、开发指南 development.md、安全说明 security.md、上游登记（docs/upstream/）、ADR、研究笔记、架构文档（docs/architecture/，总览 overview.md）
├─ prompts/            Wevir 自己的提示词（ADR-0005 补记 2）：Codex 引擎上第三方模型的基础提示词 base.md、计划模式 plan-mode.md、审批自动复核 auto-review.md、会话标题 thread-title.md，以及内置浏览器、Chrome、电脑操作三个插件的技能说明草稿（plugins/，插件未建）；只是文本，由 adapter-codex 与 Host 加载（尚未接入），模板语法、变量、占位与来源见 prompts/README.md
├─ scripts/            仓库脚本（check-engine-boundary.mjs、upstream-sync.sh、gate-m2.ts）
├─ biome.json          lint + format（含引擎边界规则）
├─ tsconfig.base.json  所有包共用的 TS 配置
└─ vitest.config.ts    根测试配置，每个包是一个 project
```

gitignore 掉的本地目录：`upstream/`（上游克隆）、`.wevir-dev/`（开发期运行时数据）、`spikes/**/.dsh-home/`（Spike 用的独立 DSH_HOME）、`spikes/**/.bin/`（Spike 下载的引擎二进制，如 codex-app-server）、`spikes/**/.run/`（Spike 运行时的临时目标目录）、`design-refs/`（维护者给的界面参考截图，第三方产品的界面，不进仓库）。

## 常用命令

环境：Node ≥ 22.19（`.node-version` 为 24 LTS），pnpm 版本见 `package.json` 的 `packageManager`。

| 命令 | 作用 |
|---|---|
| `pnpm install` | 安装依赖 |
| `pnpm build` | 构建所有包（库用 tsdown）；typecheck 和 test 不依赖它，只有在 Node 里直接运行包时才需要先构建 |
| `pnpm dev` | 并行运行各包的 `dev` 脚本，目前只有桌面端：先构建 `@wevir/host` 及其依赖，再 `install-electron`（第一次下载 Electron 二进制，之后立即退出），再 `electron-vite dev` 打开窗口，由桌面端附着到已有的 Host 或拉起一个（关窗口即退出，并停掉自己拉起的 Host）；数据目录同 Host（`WEVIR_HOME` 或平台默认），`WEVIR_NODE` 指定拉起 Host 用的 Node |
| `pnpm dev:host` | 构建 `@wevir/host` 及其依赖，以 EchoAdapter 在 `./.wevir-dev` 启动 `wevir-host`（Ctrl-C 优雅退出） |
| `pnpm --silent wevir <命令>` | 运行 CLI（先 `pnpm build`）：`host start`、`provider add`、`session new -w <路径> "<提示>"` 等，见 `pnpm --silent wevir --help`；数据目录与 Host 相同（`WEVIR_HOME` 或 `--home`） |
| `pnpm gate:m2` | 构建后运行 `scripts/gate-m2.ts`：Gate M2 端到端验收（子进程 Host + 最小 WebSocket 客户端），加 `--keep` 保留临时数据目录 |
| `pnpm lint` | `biome check`（lint、格式检查、import 边界）+ 依赖声明边界检查 |
| `pnpm lint:fix` | 自动修复 lint 与格式问题 |
| `pnpm format` | 只格式化 |
| `pnpm typecheck` | 各包 `tsc --noEmit` |
| `pnpm test` | 从根目录运行全部 Vitest project |
| `pnpm vitest run --project adapter-dsh dsh-adapter.contract` | dsh 适配器的三层契约测试；第 3 层要设 `WEVIR_TEST_API_KEY` 与 `WEVIR_TEST_PROVIDER`，否则跳过并打印原因 |
| `pnpm --filter @wevir/protocol test` | 只跑单个包 |
| `bash scripts/upstream-sync.sh` | 按 `docs/upstream/upstream.lock` 把上游参考仓库浅克隆到 `upstream/`；`WEVIR_GITHUB_MIRROR` 可替换 GitHub 前缀 |

安装、运行、数据目录、测试与常见问题见 [docs/development.md](docs/development.md)；国内网络（npm 镜像、`ELECTRON_MIRROR`、`WEVIR_GITHUB_MIRROR`、模型服务）见其 §7。

## 写代码的约定

- 全仓库 ESM（`"type": "module"`），TypeScript strict。模块解析用 `NodeNext`，所以相对导入要写 `.js` 后缀：`import { x } from './x.js'`。只走打包器的包可以在自己的 tsconfig 里改用 `bundler`。
- 测试文件与源码放在一起，命名 `*.test.ts`，从 `vitest` 显式 import `describe` / `it` / `expect`。
- 新建一个库包时照 `packages/protocol` 抄：
  - `package.json`：`"type": "module"`；`exports` 的每个子路径第一个条件写 `"@wevir/source": "./src/<入口>.ts"`，其后是指向 `dist/` 的 `types` / `default`；脚本 `build`（tsdown）、`typecheck`（`tsc --noEmit`）、`test`（`vitest run`）。
  - `tsconfig.json`：继承 `../../tsconfig.base.json`；运行在 Node 上的包加 `"types": ["node"]`。
  - `tsdown.config.ts` 与 `vitest.config.ts`（用 `defineProject` 写 `name`，并照抄 `ssr.resolve.conditions`）。
  - pnpm 12.6 的坑：新包没有 `dependencies`（什么都不依赖，或只声明了可选 peer）时，`pnpm install` 显示 “Already up to date”，不会往 `pnpm-lock.yaml` 写这个包的 `importers` 条目，之后 `pnpm install --frozen-lockfile`（CI）报 `ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER`；报错里建议的 `--lockfile-only` 也补不上。运行 `pnpm install --fix-lockfile`，确认 lockfile 里有 `packages/<名字>` 条目再提交。
- 工作区包之间的依赖用 `"workspace:*"` 声明。类型检查（`tsconfig.base.json` 的 `customConditions`）和 Vitest（各包的 `ssr.resolve.conditions`）都认 `@wevir/source` 条件，直接用依赖包的源码，不需要先 `pnpm build`；Node 直接运行、打包和发布走 `dist/`（ADR-0004 补记 1）。由此带来三条要求：
  - 消费方的 `types` 要覆盖依赖源码用到的环境类型，例如依赖 `@wevir/runtime-adapter` 要有 `"types": ["node"]`。
  - 测试里启动 Node 子进程不要继承 Vitest worker 的 `execArgv`（里面有 `--conditions @wevir/source`）：用 `spawn(process.execPath, …)`，或给 `fork` 显式传 `execArgv`。子进程跑 `dist/`，这类测试要先 `pnpm build`。
  - Web 环境（jsdom 等）的 Vitest project 还要设顶层 `resolve.conditions: ['@wevir/source']`。
- 公共开发工具（TypeScript、Biome、Vitest、tsdown、`@types/node`）装在根目录，包里只声明自己的运行时依赖。
