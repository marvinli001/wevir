# T0.5 OpenWork 架构研读：信息架构、桌面壳与可移植组件

> 日期：2026-10-12 · 任务：[SKELETON_PLAN §6 T0.5](../SKELETON_PLAN.md) · 上游：`different-ai/openwork@ad22cdc`（`ee/` 之外 MIT，见 [UPSTREAM.md §2.2](../upstream/UPSTREAM.md)）
> 只读研究，没有移植任何代码，也没有打开 `ee/` 下的任何文件。MIT 区域里指向 `@openwork-ee/*` 的引用只记下引用位置，不跟进。

## 0. 怎么读这份报告

- 路径相对 `upstream/openwork/`，`文件:行号` 按锁定提交 `ad22cdc` 核对过。为了缩短引用，五个常用根目录用前缀表示：

  | 前缀 | 实际目录 |
  |---|---|
  | `A/` | `apps/app/src/`（React 界面） |
  | `S/` | `apps/server/src/`（openwork-server） |
  | `E/` | `apps/desktop/electron/`（Electron 主进程与 preload） |
  | `T/` | `packages/types/src/` |
  | `U/` | `packages/ui/src/` |

  其他路径写全。例如 `A/react-app/shell/app-root.tsx:451-565` 即 `apps/app/src/react-app/shell/app-root.tsx` 第 451–565 行。
- OpenWork 的文档和代码不一致时以代码为准，并标注“文档漂移”。
- “§x.y”指本文小节，“计划 §x.y”指 [SKELETON_PLAN](../SKELETON_PLAN.md)，“T0.3 §x”指 [dsh 接入 Spike 报告](dsh-integration-spike.md)，“A1–A21 / D1–D11 / N1–N12”指 [Paseo 研读](paseo-notes.md) §9 的条目。
- 术语对照：

  | OpenWork | Wevir | 说明 |
  |---|---|---|
  | OpenCode engine（`opencode serve`） | dsh（`dsh --profile acp`） | Agent 执行内核 |
  | openwork-server | Local Agent Host 的一部分 | OpenWork 的 server 没有自己的会话事件库，转录稿由 OpenCode 保存（§2.4） |
  | workspace | Workspace | 都是“本地文件夹 + 元数据” |
  | session | Session | 一条长期对话 |
  | Library（扩展库） | — | Skills、Connectors（MCP）、Plugins 合在一起的管理页 |
  | Den | — | OpenWork 的组织云控制面，全部在 `ee/`，与 Wevir 无关 |

- 结论先行：
  1. **信息架构可以直接借鉴**：左栏“工作区 → 会话”两级树、中间对话、右侧可选面板；URL（`/workspace/:id/session/:sid`）是当前工作区和会话的唯一事实；审批是输入框上方的内联面板而不是弹窗；Skills、MCP、插件合并为一个“扩展库”。这些与计划 §6 T5.2 的三栏布局一致（§1、§9）。
  2. **进程与通信不能照搬**：openwork-server 跑在 Electron 主进程里，再拉起 `opencode serve` 子进程；渲染进程经 server 的 `/workspace/:id/opencode/*` 反向代理直接调 OpenCode SDK、订阅 OpenCode 的 SSE。会话数据模型、事件名、配置格式、插件钩子都是 OpenCode 的。Wevir 的 Host 是独立进程、自有事件库和 JSON-RPC 协议，这一层要整体自写（§2）。
  3. **会话视图的渲染层可移植性最好**：OpenWork 先把 OpenCode 的 `Part` 转成 Vercel AI SDK v6 的 `UIMessage` 再渲染，耦合集中在 `sync/` 下三个文件；流式 Markdown 增量渲染、消息列表虚拟化、贴底滚动、事件流重连状态机都与引擎无关（§3、§8）。
  4. **工作区与扩展的格式大多是 OpenCode 的**：授权目录写成 OpenCode 的 `permission.external_directory` 且对所有工作区生效；MCP 配置用 `opencode.json` 的 `mcp` 结构；Skills 放在 `.opencode/skills`。可借的是概念和流程，不是存储格式（§4、§5）。
  5. **设计 Token 只借结构，不借视觉**：Radix Colors 色阶 → 语义变量 → Tailwind v4 `@theme inline` 三层，`data-theme` 切换暗色。OpenWork 同时维护两套语义变量（旧 DLS 与 shadcn），还有若干漂移和 bug，Wevir 应只保留一套（§6）。
  6. **许可证结论成立，但需补充**：`ee/` 之外确为 MIT；MIT 区域里另有未署名的第三方派生内容（Radix Colors 数值、shadcn 生成的组件、与 prompt-kit 同 API 的聊天组件），以及 Apache-2.0 的 npm 依赖。移植这些部分要另外保留原始声明，或者干脆从原始来源获取（§7）。

---

## 1. 信息架构：页面、导航与界面组织

### 1.1 路由表

全部路由声明在 `A/react-app/shell/app-root.tsx:451-565`，路径构造函数在 `A/react-app/shell/workspace-routes.ts`。

| 路径 | 组件 | 说明 |
|---|---|---|
| `/workspace/:workspaceId/session[/:sessionId]` | `SessionRoute`（`app-root.tsx:493-508`） | **主路由**：会话视图 |
| `/workspace/:workspaceId/extensions/*` | `SessionRoute` → 主区域被扩展库接管（`:530-545`） | 扩展库（Library） |
| `/workspace/:workspaceId/settings/*` | `SettingsRoute`（`:546-561`） | 全屏设置 |
| `/session`、`/session/:sessionId`、`/settings/*`、`/extensions/*` | 同上 | 兼容入口，能解析出工作区时重定向到工作区作用域路由（`A/react-app/shell/settings-route.tsx:2115-2120`） |
| `/automations`、`/calendar`、`/dashboard`、`/apps[/:appId]`、`/activity` | `SessionRoute` 主区域渲染页面（`app-root.tsx:509-529`；选择逻辑 `A/react-app/shell/session-route.tsx:3756-3795`） | 全局页面，依赖 Den（§1.9） |
| `/signin`、`/onboarding`、`/welcome` | 登录、选组织、Web 欢迎页（`:452-472`） | Cloud / Web 专用；桌面端 `/welcome` 直接跳 `/session` |
| `/`、`*` | 重定向 `/session`（`:564-565`） | |

**URL 是工作区与会话身份的唯一事实**（`A/react-app/ARCHITECTURE.md:87-128`）：会话路由先读 URL 的 `workspaceId`，再读 `sessionId`；localStorage 里的 `openwork.react.activeWorkspace` / `sessionByWorkspace` 只用于恢复；URL 指向的资源不存在时显示“未找到”，不悄悄回落到第一个工作区。URL 表达不了的工作台状态（保留的会话标签、分屏的副会话、焦点在哪一栏）放在 `A/react-app/domains/session/chat/workbench-store.ts`（进程内存）。

### 1.2 主窗口布局

布局代码在 `A/react-app/domains/session/chat/session-page.tsx:1353-2000`。

```text
┌ 左栏 260（220–600，可拖，⌘B 收起）┬ 顶栏：会话标题 · 工作区名     [更新][查找⌘F][登录*][▣ 右栏] ┐
│ [≡]                    [←][→]    ├─────────────────────────────────────┬──────────────────┬────┤
│ ◆ OpenWork          [🔍][🔔]     │ 主区域（最小 360）                    │ 右侧面板 520      │右轨│
│ ✎ 新会话              ⌘N         │ ┌ 主会话 ───────┬ 分屏副会话 ────┐   │ [标签][标签][+][x]│ 40 │
│ ▦ Dashboard*                     │ │ 消息流         │（可选，各≥320）│   │ 浏览器 / 文件成果 │ 🌐 │
│ ⏱ Automations*                   │ │ 审批/提问面板  │               │   │ / App / MCP App  │ 📄n│
│ 📅 Calendar*                     │ │ 输入框         │               │   │ 或“选择去处”     │    │
│ ▤ Library（扩展库）               │ └───────────────┴───────────────┘   │ 或内嵌扩展库      │    │
│ 置顶（跨工作区）                   │ ─ 终端坞（⌘J，默认 280）──────────   │                  │    │
│ 工作区                    [+]    │                                     │                  │    │
│  ▾ 工作区 A        [+][⋯]        │                                     │                  │    │
│     分组 ▾ / 未分组               │                                     │                  │    │
│       会话 ⌘1 …  显示更多         │                                     │                  │    │
│  ▸ 工作区 B                       │                                     │                  │    │
│ ▸ 已归档（跨工作区）               │                                     │                  │    │
│ ─ (头像) 账户 · 运行状态 ▾        │                                     │                  │    │
└──────────────────────────────────┴─────────────────────────────────────┴──────────────────┴────┘
                                                                      * = 依赖 Den / Cloud
```

- **左栏**：shadcn `Sidebar`，`collapsible="offcanvas"`（`A/react-app/domains/session/sidebar/app-sidebar.tsx:753-756`）；宽度默认 260、范围 220–600（`A/react-app/shell/ui-state-store.ts:9-11`），通过 `--sidebar-width` 生效（`session-page.tsx:661-663`），拖动边缘调整（`app-sidebar.tsx:900-908`），⌘B 切换（`A/components/ui/sidebar.tsx:33`）。
- **顶栏**（`session-page.tsx:1446-1624`）：侧栏隐藏时出现侧栏开关与搜索；“返回父会话”；标题与工作区名；右侧是更新、查找、Cloud 登录、右栏开关。
- **主区域**：水平可调分组“主区域（≥360）+ 右侧面板”（`:1627-1632`）；主区域内再纵向分“内容（≥180）+ 终端坞（默认 280，160 至 55%）”（`:1928-1937`）。内容是会话、页面或接管视图三选一（`:1674-1679`）。
- **分屏**：`WorkbenchPanelGroup` 放主、副两个会话，各≥320，比例默认 50% 并记住（`A/react-app/domains/session/chat/workbench-panel-group.tsx:20-27`）。会话“标签”只在内存里，没有可见的标签条，用 ⌘T / ⌘⇧T 或命令面板切换。
- **右侧面板**：`sidePanelState[sessionId]` 为 `"panel"` 或 `"extensions"` 时显示（`ui-state-store.ts:17-19`），默认 520、最小 320（扩展库 420）、最大 70%（`session-page.tsx:656-659,1944-1957`）。
- **右轨**：`lg` 断点以上的 40px 竖条，放浏览器按钮（仅 Electron）和带数量角标的“文件”按钮（`:1961-1997`）。
- **没有状态栏**：运行状态并入左栏底部的账户菜单（`A/react-app/domains/session/sidebar/account-status-menu.tsx:206-210`）。
- **窄屏**：宽度 < 1024 视为移动端（`A/hooks/use-mobile.ts:3-4`），左栏变抽屉，主区域用 `NarrowPaneSwitcher` 在“对话 / 分屏 / 工具”间切换（`session-page.tsx:1096-1105`）。

### 1.3 左栏：工作区与会话

- 顶部：新会话（⌘N）、Dashboard / Automations / Calendar（Den）、Library（打开 `/workspace/:id/extensions`）（`app-sidebar.tsx:778-842`；`session-route.tsx:1485-1497`）。
- 滚动区：跨工作区的“置顶”（`:852-854,914-947`）→“工作区”标题与添加按钮（`:857-872`）→ 可拖动排序的工作区列表（`:873-889`）→ 跨工作区的“已归档”（`:890-892,949-992`）。
- 工作区行：可折叠；悬停出现“新会话”和 ⋯ 菜单（改名 / 在访达中显示 / 新建分组 / 移除工作区）（`:543-586,1194-1318`）。
- 工作区下的会话：每次显示 6 条加“显示更多”（`A/react-app/domains/session/sidebar/utils.ts:6`）；可拖动排序；可放进用户自建分组或“未分组”，分组同步到 server（`app-sidebar.tsx:1250-1277,1659-1781`）。会话菜单：置顶、在分屏打开、改名、移到分组、归档、删除（`:372-422`）。
- 会话行状态：运行中加载动画、未读与“需要处理”圆点（`app-sidebar.tsx:154,266,276`）。
- **会话如何归属工作区**：每个工作区有自己的 server 端点，会话列表按端点分别拉取（`A/react-app/shell/route-workspaces.ts:96-130`），再拼成 `{workspace, sessions, status}`（`:486-500`）。会话不跨工作区。
- 文档漂移：`ARCHITECTURE.md:158-166` 把 `TO DO` 写成分组标签示例，代码里没有任何硬编码的 TO DO 分组。

### 1.4 右侧面板

- 标签类型只有四种：`artifact | browser | app | mcp-app`，按会话保存并持久化（`A/react-app/domains/session/panel/panel-tab-store.ts:8-27`，key `openwork:panel-tabs:v1`）。**没有**终端、Diff、Todo 标签；终端是底部坞。
- 标签条可拖动（`A/components/panel-tabs.tsx`）；“+”新开浏览器标签；Ctrl+Tab 轮换、Esc 关闭（`A/react-app/domains/session/panel/side-panel.tsx:682-764`）。
- 空面板是“选择去处”页：浏览器 / 文件与成果 / 扩展库（`A/react-app/domains/session/panel/panel-empty.tsx:27-61`）。成果标签里带工作区文件树（`A/react-app/domains/session/artifacts/artifact-panel.tsx:381-397`）。
- `"extensions"` 模式把扩展库嵌入右栏：`SettingsSurface embedded initialPath="extensions"`（`session-route.tsx:3737-3750`）。

### 1.5 文件、Skills、MCP、设置在导航中的位置

| 功能 | 位置 |
|---|---|
| 文件 / 成果 | 右侧面板的成果标签与文件树；右轨“文件”按钮；消息中的文件 chip（§3.6） |
| Skills | 扩展库 → Skills（`/workspace/:id/extensions/skills`）；也是设置里的 Library 标签，也可嵌在右栏 |
| MCP | 扩展库 → Connectors（`extensions/mcps`）；添加与授权弹窗 `A/react-app/domains/connections/modals/add-mcp-modal.tsx`、`A/react-app/domains/connections/mcp-auth-modal.tsx` |
| 插件 | 扩展库 → Plugins；OpenCode 插件在可折叠区块里（`A/react-app/domains/settings/pages/extensions-view.tsx:127-147`） |
| 模型 Provider | 设置 → AI Providers、Ollama；`ProviderAuthModal`；输入框里的模型选择器与 `ModelPickerModal`（`session-route.tsx:4091`） |
| 通用设置 | `/workspace/:id/settings/:tab` 全屏设置；关闭后回到来源会话（`workspace-routes.ts:22-32`） |

扩展库的分区类型有 `all | apps | connections | mcps | skills | commands | agents | plugins | …`（`extensions-view.tsx:8-19`），但界面只显示四个筛选：全部、Connectors、Skills、Plugins（`A/react-app/domains/settings/extension-taxonomy.ts:19-24`）；`commands`、`agents` 归入 Skills，`mcp` 归入 Connectors（`:31-35`）。

### 1.6 设置页

标签值定义在 `A/app/types.ts:186-206`，标签名在 `A/react-app/domains/settings/shell/settings-page.tsx:106-149`，页面组件在 `settings-route.tsx:2140-2554` 的 switch 里。导航分组（`settings-page.tsx:196-268`）：

| 分组 | 标签（id → 页面） |
|---|---|
| 入口 | `general` → 卡片式总览 `GeneralSettingsView` |
| 工作区 | `preferences`（默认模型等）、`permissions` → `AuthorizedFoldersPanel`、`extensions` → 扩展库、`advanced` → 高级 + 恢复 + 生效权限 |
| 全局 | `ai`（AI Providers）、`ollama`、`appearance`（主题与语言）、`shortcuts`、`environment`（环境变量）、`updates`（可自动更新时）、`debug`（开发者模式） |
| Cloud | `cloud-account`、`usage`（另有可路由但不在导航里的 `cloud-providers`） |

`connect`、`cloud-marketplaces`、`skills`、`mcp`、`recovery`、`den`、`cloud-workers` 是旧 id，只做重定向（`settings-route.tsx:311-323`）。组织策略可以把设置收窄到只剩 Cloud 两项（`A/app/cloud/desktop-app-restrictions.ts:35-45`）。

```text
┌ 设置侧栏（可收成图标）──────┬ 顶栏：<标签名>  <工作区名>        [更新][🔔][x] ┐
│ ← 返回应用                  ├──────────────────────────────────────────────┤
│ [工作区 A ▾]                │ <标签名> / 说明                                │
│ ⚙ 设置（总览）               │ 页面组件（卡片 / 表单 / 扩展库）                 │
│ 工作区：偏好、权限、          │                                              │
│        扩展库、高级           │                                              │
│ 全局：AI Providers、Ollama、 │                                              │
│      外观、快捷键、环境、      │                                              │
│      更新、调试               │                                              │
│ Cloud：账户、用量             │                                              │
└─────────────────────────────┴──────────────────────────────────────────────┘
```

设置页布局在 `A/react-app/domains/settings/shell/settings-shell.tsx:97-157`、`settings-page.tsx:327-411`；嵌入右栏的紧凑模式把侧栏换成下拉框（`settings-shell.tsx:54-95`）。

### 1.7 命令面板、快捷键、首次运行

- 命令面板 ⌘K（`A/react-app/shell/use-shell-shortcuts.ts:40-49`，组件 `A/react-app/shell/command-palette.tsx`）：结果分“最近 / 操作 / 设置 / 会话”四组（`A/react-app/shell/command-palette-search.ts:5,27`），有模型、Agent、分组、分屏等子模式（`command-palette.tsx:630-641`），并列出所有设置标签与扩展库分区（`A/react-app/shell/command-palette-settings.ts:16-97`）。
- 快捷键（`use-shell-shortcuts.ts:113-125`）：⌘N 新会话、⌘J 终端、⌘F 会话内查找、⌘⇧F 搜索全部会话、⌘1–9 跳到可见会话、⌘B 侧栏，另有思考模式、快速模式、常用模型等组合键。
- 首次运行：桌面端是“对话优先”，没有工作区时直接显示空输入框（`session-page.tsx:1888-1897`），第一条消息自动创建 `~/OpenWork Chat` 工作区（`session-route.tsx:3544-3563`）。Web 端走欢迎页 → 选文件夹 → 选 Provider（`A/react-app/shell/welcome-route.tsx:310-384`）。

### 1.8 国际化

- 10 种语言，含简体中文（`A/i18n/index.ts:1-22`）。英文约 2352 个 key，中文约 736 个；缺失的 key 先回退英文、再回退 key 本身（`index.ts:115,158-166`）。
- key 是扁平点分格式 `namespace.key`，复数用 `_one` / `_other` 后缀（`A/i18n/locales/en.ts:7-8`）。语言存在 localStorage 的 `openwork.language`，不检测系统语言，默认 `en`（`index.ts:11,198-221`）。
- `A/i18n/locales/zh.ts:1-6` 写了中文翻译约定（产品名、MCP 等保留英文），可供 Wevir 的术语表参考。
- 不少导航文案绕过了 `t()` 直接写英文，例如设置标签名（`settings-page.tsx:108-145`）、左栏的 Dashboard 等（`app-sidebar.tsx:802-830`）、右栏“选择去处”（`panel-empty.tsx:36-55`）。Wevir 要求中文默认、文案集中（计划 §6 T5.4），这类写法要避免。

### 1.9 Cloud / Den 专属（与 Wevir 无关）

`/signin`、`/onboarding`、启动时的登录与企业激活闸门（`app-root.tsx:95-229,447-449`）；`cloud-account`、`usage`、`cloud-providers` 设置标签；Dashboard、Automations、Calendar、Apps、Activity 页面（`session-route.tsx:407-435`）；顶栏“登录”；扩展库的分享与“加入组织库”；`docs/architecture/` 下唯一的文档 `team-execution-policy.md`（Den 的团队执行策略如何映射成引擎权限与钩子，`:1-12`）。

---

## 2. apps/desktop、apps/app、apps/server 的关系与 OpenCode 耦合

### 2.1 进程树

```text
Electron 主进程（E/main.mjs）
 ├─ 进程内：openwork-server（apps/server/dist/embedded.js，动态 import）
 │    ├─ 子进程：opencode serve（v1 主引擎；改配置时蓝绿切换，短暂并存两个）
 │    └─ 子进程（可选）：opencode2 serve（v2 预览通道）
 ├─ 渲染进程：BrowserWindow → apps/app/dist/index.html
 ├─ WebContentsView（内置浏览器面板）、node-pty 终端
 └─ 本机回环：UI 控制 HTTP 服务、Chrome DevTools Protocol 调试端口
```

- **server 不是独立进程**：`apps/desktop/scripts/prepare-sidecar.mjs:204-206` 写明 openwork-server 已不再编译成 sidecar，而是在 Electron 主进程里直接 import。`E/runtime.mjs:1875-1892` 找到 `embedded.js` 并动态 import，再以 `host:"127.0.0.1"`、`corsOrigins:["*"]`、`approvalMode:"auto"`、令牌等参数调用 `startEmbeddedServer`（`:1896-1913`）。打包时只下载并签名 `opencode` / `opencode2` 两个二进制（`prepare-sidecar.mjs:36-48,224-237`；版本钉在 `constants.json:2-3`）。
- **引擎拉起**：`S/embedded.ts:187-198` 先绑定 HTTP 监听再拉引擎；引擎环境变量带 `OPENWORK_SERVER_URL`、`OPENWORK_SERVER_TOKEN`、`OPENCODE_CONFIG`（server 生成的配置文件）（`:222-229`）。`S/managed-opencode.ts:155-191` 执行 `opencode serve --hostname 127.0.0.1 --port <空闲端口> --cors *`，每次随机生成 Basic 认证的用户名与密码；就绪判定靠解析 stdout 的“opencode server listening on …”（`:228-233`），端口冲突时换端口重试一次（`:276-288`）。
- **端口与令牌**：server 绑 127.0.0.1（`E/runtime.mjs:1842`），优先复用 `openwork-server-state.json` 里记的端口（`:1504-1513`），冲突时退回系统分配（`S/serve-node.ts:256-262`）。桌面端生成 `clientToken` 与 `hostToken` 两个 UUID，存 `userData/openwork-server-tokens.json`（`E/runtime.mjs:185-206`），启动后用 host token 调 `POST /tokens` 换出 owner 令牌（`:1934-1948`）。渲染进程经 IPC（`runtimeBootstrap` / `engineStart`）拿到 URL 与令牌后写进 localStorage（`A/react-app/shell/desktop-runtime-boot.ts:100-108,166-191`）。
- **生命周期**：`whenReady` 时先清掉残留引擎再启动（`E/main.mjs:2729-2755`）；生命周期操作串行化（`E/runtime.mjs:1377-1396`）；退出时 `quitSequencer` → 释放引擎池并停 HTTP（`E/main.mjs:1386-1411`、`S/embedded.ts:91-158`），引擎先 SIGTERM 后 SIGKILL（`S/managed-opencode.ts:69-88`）；引擎连续 3 次连不上由引擎池替换（`S/engine-pool.ts:490-500`）；孤儿引擎登记在 `engine-instances.json`，启动时回收。server 在主进程内，server 的致命错误会直接拖垮 Electron 主进程。

### 2.2 通信方式

| 通道 | 内容 | 依据 |
|---|---|---|
| Electron IPC | preload 暴露 `window.__OPENWORK_ELECTRON__`；核心是 `invokeDesktop(command, …)` → 通道 `openwork:desktop`，命令类型由 `T/desktop-ipc.ts:380-512` 的 `DesktopCommandMap` 约束：工作区、引擎启停、Skills 导入、读写 opencode 配置、文件夹选择、`__fetch` 中转等；另有 `shell`、`browser`（约 25 个通道）、`terminal`、`updater` 等命名空间。主进程推送深链、菜单事件、终端输出等 | `E/preload.mjs:158-333,349-382`；`E/main.mjs:1742-2281`；渲染侧用 Proxy 把任意属性访问转成 `invokeDesktop`（`A/app/lib/desktop.ts:287-312`） |
| HTTP | 渲染进程直接 `fetch` 本机 server；非回环地址经主进程 `__fetch` 中转 | `A/app/lib/desktop.ts:325-333,372-447` |
| HTTP 反向代理 | `/workspace/:id/opencode/*`（v2 为 `/opencode2/*`）：server 把客户端令牌换成引擎的 Basic 认证，注入 `x-opencode-directory` 头与 `?directory=` 参数 | `S/server.ts:936-975,1736-1757,1869-1889` |
| SSE | 渲染进程用 OpenCode SDK 的 `client.event.subscribe()` 订阅代理后的 `/event`；server 把所有存活引擎的事件流合并成一条 | `A/react-app/domains/session/sync/session-sync.ts:236-245`；`S/server.ts:2015-2018,2225-2297` |
| 轮询 | OpenWork 自己的事件（配置重载、会话分组）是轮询 JSON，不走 SSE | `S/routes/operations.ts:31-37` |
| 引擎回调 | OpenCode 插件用 `OPENWORK_SERVER_URL` / `TOKEN` 回调 server | `S/opencode-plugins/openwork-extensions-preview.ts:1090-1094` |

渲染进程按功能找谁：

| 功能 | 对端 |
|---|---|
| 会话、消息、发送提示 | OpenCode（经代理）；`/session/:id/prompt_async`（`A/app/lib/opencode.ts:390-407`） |
| 事件流 | OpenCode SSE（经代理） |
| 文件读写、成果 | server `/workspace/:id/files/*`（`S/routes/files.ts:592-1019`）；@提及的文件搜索用 OpenCode `find.files` |
| 工作区 | 桌面 IPC `workspace*` **和** server `/workspaces`，两处各存一份（§4.1） |
| Skills | server `/workspace/:id/skills` 与 IPC 的 Skills 命令 |
| MCP | server `/workspace/:id/mcp` + 引擎的 `mcp.status/add/auth`（经代理） |
| Provider | 引擎的 `config.providers`、`provider.list`、`auth.set`（经代理）+ server 的配置接口 |

### 2.3 Electron 安全设置

- 主窗口：`contextIsolation: true`、`nodeIntegration: false`、**`sandbox: false`**、`plugins: true`（PDF 预览）、`backgroundThrottling: false`（`E/main.mjs:2426-2437`）。preload 是 ESM（`preload.mjs`），推断这是关掉 sandbox 的原因：沙箱化的渲染进程不支持 ESM preload。
- 导航与 `window.open` 被拦截并改送内置浏览器（`E/main.mjs:2495-2538`）；内置浏览器的 View 用 `sandbox: true` 与独立 partition（`E/browser-panel.mjs:33-40`）。
- **CDP 调试端口在正式版也开着**：`E/main.mjs:1004-1014` 无条件在 127.0.0.1:9223–9227 上开启 `remote-debugging-port`，没有开发模式判断，本机任何进程都能驱动渲染进程。
- server 的 `GET /workspaces` 会把引擎的 Basic 认证用户名密码返回给持有客户端令牌的调用方（`S/server.ts:2634-2650`）。

对 Wevir T5.1 的启示：`sandbox: true` 是计划里的硬要求，preload 要输出 CJS；调试端口只在开发模式开；渲染进程不需要“任意 fetch 中转”这类万能通道。

### 2.4 持久化

- 桌面（`userData`）：`openwork-workspaces.json`（`E/workspace-store.mjs:166-171`）、令牌与端口状态 JSON（`E/runtime.mjs:1415-1425`）、受 safeStorage 保护的 MCP 保险库密钥（`E/main.mjs:1283-1286`）、渲染进程 localStorage。
- server（`~/.config/openwork` 或 `OPENWORK_SERVER_CONFIG`，`packages/paths/index.mjs:95-130`）：`server.json`（工作区列表）、`tokens.json`、`env.json`、**`runtime.sqlite`**（`node:sqlite` 或 `bun:sqlite`，`S/runtime-db.ts:34-67`；表有 `runtime_opencode_configs`、`openwork_workspace_configs`、`session_group_states`、`thread_approvals` 等）、审计 JSONL。
- **转录稿不归 OpenWork 存**：会话与消息在 OpenCode 自己的 `opencode.db` 里（`S/engine-pool.ts:11`、`packages/paths/index.mjs:233-272`）。这与 Wevir“Host 事件库是唯一事实来源”（计划 §2.1）正好相反。

### 2.5 与 OpenCode 的耦合点（Wevir 不能带走的部分）

| 路径 | 用到 OpenCode 的什么 | 程度 |
|---|---|---|
| `S/managed-opencode.ts:150-288`、`S/managed-opencode-v2.ts:193-275` | `opencode serve` 命令行、stdout 就绪行、`OPENCODE_SERVER_*` 环境变量 | 深 |
| `S/engine-pool.ts` | 蓝绿切换依赖 OpenCode 的实例与配置重载、`/session/status` 忙闲判断 | 深 |
| `S/server.ts:1839-2297` | 按路径识别的反向代理：`/session/:id/command` 去重、`/abort` 停止栅栏、`/permission/:id/reply`、`/event` 合并、`x-opencode-directory` | 深 |
| `S/openwork-runtime-config.ts:61-149`、`S/runtime-opencode-config-store.ts` | 生成 `opencode.json` 结构的配置（`agent`、`plugin`、`mcp`、`provider`、`permission`）经 `OPENCODE_CONFIG` 注入 | 深 |
| `S/opencode-plugins/*` | 引擎内插件钩子：`chat.params`、`chat.headers`、`experimental.chat.system.transform`、`tool.execute.before/after`、`event` 等；PDF/表格附件、策略、标题恢复等功能都跑在引擎里 | 深 |
| `S/skills.ts:192-202`、`S/plugins.ts:59,84`、`S/mcp.ts:315-316`、`packages/paths/index.mjs:139-178` | `.opencode/{skills,commands,plugins}`、`opencode.json(c)`、`~/.config/opencode` 路径约定 | 中 |
| `E/runtime.mjs:1588-1633,2201-2227`、`apps/desktop/scripts/prepare-sidecar.mjs` | 定位与下载 `opencode` 二进制、写 `opencode.json` 的 `$schema`、调用 `opencode mcp auth` | 中 |
| `A/app/lib/opencode.ts:1,361-423` | OpenCode SDK 客户端，覆写 `promptAsync` / `command`，使用 OpenCode 的 `msg_` ID 格式 | 深 |
| `A/app/types.ts:1-9`、`A/app/lib/openwork-server.ts:378-397` | 把 OpenCode 的 `Message`、`Part`、`Session`、`Todo` 当作应用的领域类型 | 深 |
| `A/react-app/domains/session/sync/session-sync.ts` | SSE 事件名（`message.part.updated/delta`、`session.status/idle/error`、`permission.asked/replied`、`question.*`、`todo.updated` 等） | 深 |
| `A/react-app/domains/session/sync/usechat-adapter.ts`、`parse-tool-parts.ts` | 把 OpenCode `Part` / `ToolPart` 的状态转成 AI SDK `UIMessage`：**这就是适配缝** | 深（但集中） |
| `A/app/lib/opencode-v2-adapter.ts`（2589 行） | 把 OpenCode v2 的 `/api/*` 和事件翻译回 v1 形状 | 深 |
| `A/react-app/domains/connections/provider-auth/store.ts`、`A/react-app/infra/provider-list-query.ts`、`A/react-app/domains/connections/store.ts` | 引擎的 Provider、认证、OAuth、MCP 接口 | 深 / 中 |
| `A/components/chat/message-list.tsx:32`、`A/react-app/domains/session/modals/question-modal.tsx`、`A/react-app/shell/command-palette.tsx` | 只 import OpenCode SDK 的类型（`SessionStatus`、`QuestionInfo` 等） | 浅 |

结论：**OpenWork 的“后端”= OpenCode + 一层包装**。Wevir 能从 server 借的只有与引擎无关的部分（§2.6），会话 API、事件流、配置注入、插件这些全部要由 Wevir Host + `adapter-dsh` 重新实现。

### 2.6 server 里与引擎无关的部分

- 通用：令牌与作用域（`S/tokens.ts`，`owner / collaborator / viewer`，`S/types.ts:7`）；配置写入的审批门（`S/approvals.ts:31-47`）与审计日志（`S/audit.ts:11-16`）；文件 API、收件箱 / 发件箱（`S/routes/files.ts`）；工作区登记（`S/routes/workspaces.ts`）；环境变量存储；健康检查与能力声明。
- 混合：Skills（文件格式通用，但目录是 `.opencode/skills`）；MCP（存在 OpenWork 自己的 SQLite，但结构是 OpenCode 的 `mcp` 键，并热注册进引擎，`S/server.ts:4129-4138`）。
- 每次配置写入都走“审批 → 审计 → 重载事件 → 引擎重新同步”的固定流水线（例如 `S/server.ts:3755-3789`），这个模式值得 Wevir 在 Phase 1 的扩展管理中沿用。

### 2.7 packages/types 与 packages/sdk

- `packages/types`：依赖只有 `zod` 与 `@openwork/managed-deployments`，**不 import OpenCode SDK**。内容是桌面 IPC 契约（`T/desktop-ipc.ts`）、`WorkspaceWire`（`T/workspace.ts`）、大量 Den 线缆类型（`T/den/*`）、自动化与 MCP App 类型。OpenCode 的痕迹只在字段层：`WorkspaceWire` 上的引擎账号密码（`T/workspace.ts:34-42`）、`EngineInfo`（`T/desktop-ipc.ts:36-52`）。整体以 Den 耦合为主，对 Wevir 只有“用一个包定义跨进程线缆类型，生产方用类型断言保证可赋值”这一做法可借（`A/react-app/ARCHITECTURE.md` 依赖规则第 5 条；`S/types.ts:57-59`）。
- `packages/sdk`：hey-api 生成的 **Den 云 API** 客户端，README 写明不封装本地 server 或 OpenCode（`packages/sdk/README.md:1-5`），运行时无人 import；生成脚本引用了 `@openwork-ee/den-api`（`packages/sdk/script/generate.mjs:36`）。与 Wevir 无关。

---

## 3. 会话视图：流式消息、工具调用、审批、文件成果

### 3.1 数据通路

```text
OpenCode SSE（经 server 代理）
  → client.event.subscribe()（每个 工作区+baseUrl 一条流）           session-sync.ts:236-245,1922-2019
  → normalizeEvent（兼容 {type,properties} 与 {payload}）           A/app/utils/index.ts:272-297
  → applyEvent：按事件类型分派                                      session-sync.ts:979-1467
  → 文本增量进 deltaFlushBuffer                                     :147,260-281
      可见会话每帧（requestAnimationFrame）冲刷一次，后台会话每 100 ms
      按 part 合并，每条消息只克隆一次                                session-transcript-deltas.ts:61-177
  → TanStack Query 缓存（每会话 transcript/status/todos/permissions/questions 五个 key，gcTime: Infinity）
                                                                   session-sync.ts:306-317；A/react-app/infra/query-client.ts:48-54
  → 界面用 useQuery({enabled:false}) 读缓存                          A/react-app/domains/session/surface/session-surface.tsx:749-756
```

（本节 `session-sync.ts` 等 `sync/` 下文件都在 `A/react-app/domains/session/sync/`。）

- **重连状态机**（`sync/sync-stream-lifecycle.ts`，文件头注明故意零依赖）：阶段 `connecting / live / reconnecting / auth-blocked / stale`（`:17-22`）；退避 1 s→10 s；401/403/404 走 5 s→60 s 的慢速通道并持续重试（因为本地 server 重启时也会短暂返回这些码）（`:64-69,91-106,130-140`）；30 s 静默看门狗（`:163-170`）；令牌轮换立即重连（`:146-159`）。阶段发布到 Zustand（`session-sync.ts:369-414`）。
- **没有事件序号续传**：代码里没有 `Last-Event-ID`。只有 v2 的 `session.execution.*` / `session.status` 带 `sequence`，用于丢弃过期事件（`session-sync.ts:986-994`）。断线恢复靠“电平式”对账：每次（重）连后重读 `/session/status`、待处理审批与 todo（`:1570-1572,1740-1811`）；会话运行期间 250 ms 轮询状态（`:1826-1849`）；回合结束时整段重新拉取历史（`:1672-1680`）；合并快照时保证转录稿不倒退（`sync/transcript-reconcile.ts:26-34`）。
- **对 Wevir 的意义**：Wevir 已决定 Host 事件库 + `seq` + `sinceSeq` 补齐（A6、A7），比 OpenWork 的轮询对账更确定。可借的是**客户端渲染侧的节流**：增量按帧冲刷、后台会话降频、未声明的 part 先挂起增量。

### 3.2 消息模型

界面渲染的**不是** OpenCode 的模型，而是 Vercel AI SDK v6 的 `UIMessage`（`ai@^6`）。转换在 `session-sync.ts:900-943` 与 `sync/usechat-adapter.ts:171-241`：

| OpenCode part | UIMessage part |
|---|---|
| `text` | `text`（合成或忽略的文本丢弃；附件说明转成 `file`，`usechat-adapter.ts:126-162`） |
| `reasoning` | `reasoning` |
| `file` | `file`，外加 `source-url` / `source-document` |
| `tool` | `dynamic-tool`：`pending/running` → `input-streaming`，`completed` → `output-available`，`error` → `output-error`（`sync/parse-tool-parts.ts:128-181`） |
| `step-start` | `step-start` |
| `step-finish`、`patch`、`snapshot`、`compaction`、`subtask`、`retry` | 丢弃（`session-sync.ts:929-930`） |

part ID 放在 `providerMetadata.opencode.partId`；错误是带 ID 前缀的合成助手消息（`usechat-adapter.ts:32-50`）；输入为空 `{}` 的工具调用在参数到达前隐藏（`parse-tool-parts.ts:101-107`）。

对 Wevir 的意义：**渲染层以 `UIMessage` 为界**是个好缝。Wevir 若在客户端把 Host 事件投影成同样形状的消息部件，`ai` 包的类型（Apache-2.0，只用类型）和下游渲染组件就能少改。但 Wevir 的事件是自己协议定义的，是否直接依赖 `ai` 的类型留给 T1.1 决定，最低限度是照这个分层：协议事件 → 客户端投影（消息 + 部件）→ 渲染。

### 3.3 Markdown 渲染

- 技术栈（`A/components/markdown/markdown-primitive.ts:1-14`）：`marked` 17、`marked-emoji`、KaTeX（`markdown-math.ts`）、DOMPurify 清洗（`:243-286`）、Shiki 高亮（`:515-551`）；Mermaid 懒加载（`mermaid.ts:252`）。输出 HTML 字符串，用 `dangerouslySetInnerHTML` 渲染，代码复制、文件路径点击等用事件委托（`markdown.tsx:311-379`）。
- **流式**：`createStreamingMarkdownRenderer` 保留上一帧的顶层 token，每次只重新 lex 最后 2 个块（正在增长的块会回头改变前一个块：懒续列表、setext 标题、表格分隔行），未变的块复用同一个 `{__html}` 对象，React 不动它们的 DOM（`markdown-primitive.ts:624-699`）。未闭合的代码围栏靠 `marked` 自身容错，没有额外修补。Shiki 高亮等流式结束且块进入视口后才做（`markdown.tsx:186-207`）。用户有文本选区时推迟 HTML 替换，避免选区被冲掉（`selection-stability.ts:33-45`）。

### 3.4 工具调用卡片

- 分组：连续的助手消息合成一组（`A/components/chat/utils.ts:144-168`），组内再分 text / reasoning / file / tool / tool-aggregate（`:237-339`）。连续的 bash / edit / write / apply_patch / read / grep / glob 合并成一个 `tool-aggregate`，推理块按时间顺序嵌在里面（`A/lib/tool-aggregate.ts:65-75`）。
- 聚合卡片 `ToolAggregateGroup`（`A/components/chat/tool-aggregate-group.tsx:195-468`）：标题如“正在编辑 3 个文件、运行 8 条命令”（进行时 / 完成时两套），外加一行闪烁的“当前动作”（`A/lib/tool-aggregate.ts:126-169`）；展开后每行是状态、文件 chip 或命令框、重复读取的 ×N、单行时长；最多 8 行，余下“再显示 N 条”。
- 状态：running / waiting / unknown / completed / failed（`A/lib/tool-aggregate.ts:35-63`）。`resolveCurrentToolLifecycle` 结合会话活动状态，**回合已停止但工具未收尾时显示“状态未知”**，不会一直转圈（`A/lib/current-tool-lifecycle.ts:17-25`）。
- 单个工具：按工具名分派专用渲染（子 agent、websearch、MCP 调用、MCP App 等，`A/components/chat/message-list.tsx:238-365`），每个工具外包一层错误边界（`:184-203`）。兜底卡片 `A/components/ui/tool.tsx:143-288`：可折叠，图标或加载动画，输入输出用 `<pre>`，自带简易 diff 行着色（`:87-131`），可复制结果。聊天里没有富 diff 查看器。
- 时长：优先用持久化的开始时间，否则用首次观察到的时间（`A/lib/tool-call-duration.ts:13-51`）；回合摘要“用时 1 分 19 秒 · N 步”，超过 4 步的已完成回合自动折叠（`message-list.tsx:151,1450-1490`）。

### 3.5 审批与提问

- **审批是输入框上方的内联面板，不是弹窗**（`A/react-app/domains/session/chat/permission-approval-modal.tsx:181-282`，挂载点 `session-surface.tsx:3689-3697`）。内容：按类别（bash / edit / read / external_directory / task，另有防死循环变体）给标题和说明（`:62-97,150-179`）、权限名、作用范围模式、“由子会话请求”、可折叠的元数据 JSON。按钮三个：拒绝 / 允许一次 / 本会话允许，对应 OpenCode 的 `reject / once / always`（`:214-245`）。
- 回复：`client.v2.session.permission.reply(...)` 或旧版 `client.permission.reply`，再本地结算（`sync/use-session-interactions.ts:387-426`）。
- 多个待审批：收集本会话及所有子会话的请求，按到达时间排序，**一次只显示第一个**（`use-session-interactions.ts:386`）；已结算的 ID 记作水位，迟到的读取不会让它复活（`session-sync.ts:710-737`）；对应工具已终结的请求自动结算（`:745-754`）。转录稿里等待审批的工具显示“等待你的操作”（`message-list.tsx:256-270`）。
- 提问面板 `A/react-app/domains/session/modals/question-modal.tsx:92-279`：多题逐个、单选（150 ms 后自动下一题）/ 多选、自由文本。dsh ACP 没有对应能力（T0.3 §8），骨架不需要。

### 3.6 文件成果

- **识别**（`A/react-app/domains/session/artifacts/open-target.ts:344-430`）：不靠 OpenCode 的 `patch` part（已被丢弃），而是扫描文本 part 里的 URL、Markdown 链接、路径正则（助手正文只在含“created / saved / wrote”等词时才扫，`:65,142-144`）、`file://` 文件 part、写类工具的输入输出（`filePath` 字段、`*** Add/Update File:` 补丁头，`:79-91,319-333`）。候选路径再交给 server 的 `resolveArtifacts` 确认是否存在（`session-surface.tsx:1931-1949`），存在且类型可预览（markdown、代码、表格、幻灯片、文档、图片、PDF、HTML）才算成果（`open-target.ts:218-220`），然后同步进右栏标签（`panel-tab-store.ts:344-353`）。
- **展示**：聚合行里的文件 chip（打开 / 用默认应用打开 / 复制路径，`A/components/chat/file-chip.tsx:28-64`）；图片内联预览、附件 chip、Electron 下“在访达中显示”（`message-list.tsx:396-523`）；Markdown 里的文件链接 chip。
- **成果面板**（`A/react-app/domains/session/artifacts/artifact-panel.tsx:403-438`）：Markdown、代码（`@pierre/diffs`）、表格（`@openwork/workbook`）、HTML（`allow-scripts` 沙箱 iframe）、图片、PDF（`<embed>`）、纯文本（CodeMirror 可编辑，保存时带 `baseUpdatedAt` 并发检查，`:181-193`）。类型映射在 `A/lib/artifacts.ts:8-57`。

### 3.7 输入框与取消

- 编辑器是 Lexical 0.35（纯文本插件 + 历史插件），用自定义节点实现 @提及、/命令、Skill、连接器、粘贴块、附件 chip（`A/react-app/domains/session/surface/composer/editor.tsx:2-37`）。
- 按键（`editor.tsx:1075-1105`、`composer.tsx:315-335`）：Enter 发送、Shift+Enter 换行、输入法合成期间不发送；Agent 运行时 Enter **排队**、⌘/Ctrl+Enter **插话**（立即发送）；3 秒内连按两次 Esc 停止（`composer.tsx:258-274`）。
- 发送按钮在运行中变成停止（方块图标）（`composer.tsx:337,1592-1597`）；停止会把排队的草稿退回输入框，并对根会话和子会话调用 `session.abort`（`session-surface.tsx:2482-2502`；`A/app/lib/opencode-interruption.ts:219-251`）。

### 3.8 状态、待办、标题

- 原始状态 idle / busy / retry 映射为 submitted / streaming / retrying / ready（`session-surface.tsx:1977-1996`）；活动状态再细分 idle / thinking / responding / waiting / compacting / error（`A/react-app/domains/session/status/session-activity-store.ts:9,133-139`）。
- 指示：“正在启动… / 已工作 N 秒”行（`message-list.tsx:1089-1095`）；连续 3 次状态检查失败后显示“连接中断，正在重连…”且计时冻结（`:1119-1142`）；重试倒计时与尝试次数（`:1199-1238`）；错误与恢复卡片；左栏的运行中、未读、需要处理标记。
- 待办：输入框上方的 `TodoPanel`，折叠时显示“完成数 / 总数”（`session-surface.tsx:790-850`）。dsh 不发 plan（T0.3 §3），骨架不做。
- 标题：标题仍是默认值时按 1 s / 5 s / 25 s 重新拉取（`sync/session-title-recovery.ts:3`）。dsh 有 `session/title` 事件（T0.3 §8），Wevir 直接用事件。

### 3.9 对照 dsh 实际给的数据

| 界面元素 | OpenWork 的数据来源 | Wevir 骨架的数据来源（T0.3） |
|---|---|---|
| 流式文本 | `message.part.delta` | ACP 只给整条已提交消息；增量来自 stream-tap 旁路（T3.2a），Host 合并后按 `seq` 推送 |
| 工具卡片类型 | 工具名 + OpenCode 输入字段 | ACP `kind` 恒为 `other`，Host 按工具名映射展示类型（A20），从 `rawInput` 提取路径 |
| 工具状态 | pending / running / completed / error | `in_progress` / `completed` / `failed`；回合停止时未收尾的工具在客户端显示“状态未知”（借 OpenWork） |
| 审批按钮 | 固定 reject / once / always | 渲染请求携带的选项列表（dsh 只有 `allow_once` / `reject_once`）；“本会话允许”要靠 Host 规则，骨架不做 |
| 审批详情 | permission 元数据 | 同一 `toolCallId` 之前那条 `tool_call` 的 `rawInput`（T0.3 §5） |
| 文件成果 | 扫描文本与写工具输入 | 骨架只做写类工具 `rawInput` 里的路径 chip；成果面板放 Phase 1 |
| 待办 / 计划 / 提问 | `todo.updated` / `question.*` | dsh 不提供，骨架不做 |

---

## 4. 工作区模型

### 4.1 工作区是什么

- 线缆类型 `WorkspaceWire`（`T/workspace.ts:17-43`）：`id`、`name`、`path`、`preset`、`workspaceType`（只能是 `"local"`，`:15`）、`displayName`、沙箱字段，以及 OpenCode 的连接与账号字段。应用侧 `WorkspaceInfo = WorkspaceWire`（`A/app/lib/desktop-types.ts:53`）。
- ID 是路径 SHA-256 的前 12 位十六进制加 `ws_` 前缀，server 与桌面算法一致（`S/workspaces.ts:5-12`、`E/workspace-store.mjs:651-657`）。同一路径重复添加得到同一个 ID。
- **两份列表**：桌面的 `userData/openwork-workspaces.json`（`E/workspace-store.mjs:167-171`，临时文件 + rename 原子写，`:81-88`，含 `selectedId` / `watchedId` / `activeId`）和 server 的 `server.json`（`S/routes/workspaces.ts:75-99`）。界面把两份合并显示（`A/react-app/shell/use-workspace-route-state.ts:572-590`），删除时两边都删，防止复活（`session-route.tsx:2423-2430`）。
- 每个工作区的设置原来在 `.opencode/openwork.json`，现在 server 存进 SQLite 表 `openwork_workspace_configs`（`S/openwork-workspace-config-store.ts:16-21`），桌面端仍在写旧文件（`E/workspace-store.mjs:679-693`）。
- 远程工作区已移除，旧条目加载时静默丢弃（`S/workspaces.ts:19-21`）。

### 4.2 添加、改名、移除、切换

- **添加**：弹窗调用 `onPickFolder` → IPC `pickDirectory` → `dialog.showOpenDialog`，属性 `openDirectory`、`createDirectory`（可多选）（`E/main.mjs:1941-1954`）→ `POST /workspaces/local`（`A/app/lib/openwork-server.ts:1742-1749`）→ server 创建目录、初始化文件、写设置行、把路径加入 `authorizedRoots`、写审计（`S/routes/workspaces.ts:118-173`）→ 设为选中与运行中，首个工作区顺带启动引擎（`session-route.tsx:3396-3460`）。
- **改名**：`PATCH /workspaces/:id/display-name`（`S/routes/workspaces.ts:175-211`），只改显示名。
- **移除**：只注销，不删除任何文件；server 移除对应的 `authorizedRoot`，桌面忘掉令牌（`S/routes/workspaces.ts:244-279`、`E/workspace-store.mjs:876-890`），界面先确认。
- **切换**：`POST /workspaces/:id/activate` 只把它挪到列表首位并把它的 MCP 重新送进引擎，**不重启引擎**（`S/routes/workspaces.ts:213-242`）。桌面的 `engineStart` 也是让运行中的 server 换目标而不是重启（`E/runtime.mjs:2056-2073`）。
- 导出 / 导入：zip，过滤 `.env`、`.key`、`.pem` 等密钥文件（`E/workspace-archive.mjs:17-22`）。

### 4.3 权限范围（两个概念，不要混）

1. **`authorizedRoots`：server 愿意服务哪些工作区**。路径不在任何根之下的工作区请求一律 403（`S/server.ts:4435-4448,4478-4486`），默认就是各工作区路径本身（`S/config.ts:332-335`）。
2. **“授权目录”：Agent 在工作区之外还能碰哪些目录**。每个目录写成 OpenCode 规则 `permission.external_directory["<目录>/*"] = "allow"`（`S/server.ts:2551-2624`），接口 `GET/PUT /workspace/:id/authorized-folders`（`:3105-3180`）。虽然接口挂在工作区下，实际存进引擎全局行，**对所有工作区同时生效**（`:3142-3161` 的注释写明）。界面是设置 → 权限 → `AuthorizedFoldersPanel`。
3. **执行由引擎负责**：`S/effective-permissions.ts:1-11` 直说 OpenWork 自己不评估策略，Agent 工具能碰什么完全交给 OpenCode 的权限合并（引擎默认 → 全局配置 → OpenWork 注入 → 工作区配置）。OpenWork 自己的文件接口用 `resolveSafeChildPath` 限制在工作区内（`S/routes/files.ts:182-190`）；桌面“打开文件”先 realpath 再判断，防止符号链接逃出工作区（`E/workspace-file-access.mjs:23-78`）。

### 4.4 多工作区与引擎

一个 server 只有一个 OpenCode 引擎（改配置时短暂两个），所有工作区共享；每个请求用 `x-opencode-directory` 头与 `?directory=` 参数指定目录（`S/server.ts:1732-1757`；目录取 `workspace.directory`，空则用路径，`:4779-4784`）。按目录排队的维护操作在 `S/engine-directory-fence.ts:14-44`；注入的配置文件对所有工作区相同（`S/openwork-runtime-config.ts:49-59`）。

### 4.5 对 Wevir 的含义

- 可直接采用：路径规范化后去重（OpenWork 用路径哈希做 ID，Wevir 的 ID 由 Host 分配也可以，但必须按 realpath 去重）；“移除 = 注销，不删文件”；“界面选中”与“运行中”分开记；系统文件夹选择器的 IPC；realpath 包含判断。
- 不照搬：两份工作区列表（Wevir 只在 Host 的 SQLite 存一份，计划 §2.1）；授权目录全局生效（Wevir 若做，应按工作区）；权限完全交给引擎（Wevir 的审批由 Host 中转并落事件，计划 §2.1、A9）。
- 与 dsh 的对应：ACP 只支持一个主 workspace（计划 §8），骨架一个会话对应一个工作区目录，`session/new` 的 `cwd` 就是工作区路径。dsh 有自己的会话进程模型（T0.3），是否“一个 dsh 进程服务多个工作区”由 T3.1 决定，OpenWork 的单引擎 + 按请求指定目录只是参考。

---

## 5. Skills 与 MCP 管理

### 5.1 Skills

- **数据模型**：server 侧 `SkillItem {name, path, description, scope: project|global, trigger?, error?}`（`S/types.ts:186-193`）；界面侧 `SkillCard` 加了 `origin` 与来源字段（`A/app/types.ts:288-300`）。
- **格式**：`<目录>/<name>/SKILL.md`，YAML frontmatter 含 `name`、`description`、`trigger`（或 `when`；都没有时取“## When to use”下第一条）（`S/skills.ts:49-74,121-128`）。名称 kebab-case 1–64 字符，描述 1–1024 字符（`S/validators.ts:9-19`）；frontmatter 的 name 必须与目录名一致（`S/skills.ts:135`）；frontmatter 坏掉的条目带 `error` 列出而不是跳过（`:100-119`）。
- **发现**：从工作区向上到 git 根，读 `.opencode/skills` 与 `.claude/skills`；全局读 `~/.config/opencode/skills`、`~/.claude/skills`、`~/.agents/skills`、`~/.agent/skills`（`S/skills.ts:35-47,188-207`）；允许一层分类子目录（`:159-182`）；同名先到先得（`:212-217`）。
- **写入**：只写 `<工作区>/.opencode/skills/<name>/SKILL.md`（`S/skills.ts:261-274`）。接口 `GET/POST/DELETE /workspace/:id/skills[/:name]`，每次都走审批、审计、重载事件、引擎同步（`S/server.ts:3731-3823`）。
- **界面流程**：扩展库“添加”菜单可选连接、MCP、Skill、插件（`A/react-app/domains/settings/pages/library-add-kind-picker.tsx:20-25`）；Skill 可从文件夹导入（IPC `importSkill` 复制目录，`E/main.mjs:1968-1986`）、从模板创建（“skill-creator”，`A/react-app/domains/settings/state/extensions-store.ts:1255-1315`）、在线编辑后经 server 保存（`:1451-1483`）。
- **没有启用 / 停用开关**：唯一的门控是注入配置里 OpenCode 的 `permission.skill` 拒绝列表（`S/openwork-runtime-config.ts:88-98`）。

### 5.2 MCP

- **配置结构**：`{type: local|remote, command[], url, enabled, headers, environment, oauth: {clientId, clientSecret, scope} | false, timeout}`（`A/app/types.ts:325-334`；校验 `S/validators.ts:52-89`）。列表项 `McpItem` 带来源（`config.project / config.global / config.remote`）和“被工具拒绝列表禁用”的诊断（`S/types.ts:173-184`）。状态值 `connected / disabled / failed / needs_auth / reconnect_required / needs_client_registration`（`A/app/types.ts:360-368`）。接受 Claude Desktop 的 `command + args` 写法并转换（`A/app/mcp.ts:80-93`）。
- **存放**：三层合并显示——全局 `~/.config/opencode/opencode.json(c)`、项目 `opencode.json(c)` 或 `.opencode/opencode.json(c)`、OpenWork 的 SQLite 表 `runtime_opencode_configs`（每工作区一行加一个引擎全局行，`S/runtime-opencode-config-store.ts:9-21,60-65`）。**server 的写入进 SQLite，不改 `opencode.json`**（`S/mcp.ts:662-721`）；没有 server 时界面才用 jsonc-parser 直接改项目文件（`A/app/mcp.ts:43-74`）。
- **装载**：新增或修改后用 `POST /mcp?directory=` 热注册进引擎，无需重启（`S/server.ts:4130-4138`）；启动时把每个工作区的 MCP 重新送一遍（`:6480-6491`）。
- **OAuth 两条路**：
  1. 交给 OpenCode：配置 `oauth: {}`，弹窗调 `client.mcp.auth.authenticate`（`A/react-app/domains/connections/mcp-auth-modal.tsx:191`），令牌落在 `~/.config/opencode/mcp-auth.json`。
  2. OpenWork 托管（“managed OAuth”）：server 自己当 OAuth 客户端（`S/local-managed-mcp.ts:27-38`），密钥存 AES-256-GCM 加密的 `local-managed-mcp-vault.json`（`:55-98`），主密钥由 Electron safeStorage 保护（`E/secure-vault-key.mjs:72-111`）；**引擎只看到一个指向本地 `/mcp/managed/:ws/:name` 的远程 MCP，带 HMAC 令牌、`oauth:false`**（`S/local-managed-mcp.ts:725-741`），真正的第三方令牌永远不进引擎。回调 `/mcp/oauth/callback`，界面打开浏览器后轮询最多 120 秒（`A/react-app/domains/connections/store.ts:1092-1110`）。
- **界面**：添加弹窗有远程 / 本地切换，展开 OAuth 区（client ID、secret、scope）即切到托管 OAuth（`A/react-app/domains/connections/modals/add-mcp-modal.tsx:89-143`）；状态检查 `mcp.status({directory})` 并尝试修复异常连接（`connections/store.ts:467-485,618`）。

### 5.3 插件与扩展清单

- OpenCode JS/TS 插件：`PluginItem`（`S/types.ts:166-171`），来自 `opencode.json` 的 `plugin` 列表、`.opencode/plugins/*`、`~/.config/opencode/plugins`（`S/plugins.ts:58-92`）；OpenWork 自带的插件注入每个引擎配置（`S/openwork-runtime-config.ts:102-118`）。
- 扩展清单 schema（`A/app/extensions.ts:5-131`，零外部依赖）：来源格式（`claude-plugin`、`opencode-plugin`、`mcp-directory` 等）、资源（skill、mcp、provider、secret、native-binary…）、UI 贡献点、安装步骤（必需环境变量、测试动作）、需要的重载、启用条件（`mcp-connected`、`provider-connected`、`env-set`、`toggle-enabled`）。概念说明见 `docs/extensions-manifest-foundation.md:3-13`。
- Anthropic / Claude 插件的转换在 Den 云端完成，桌面安装已移除（`docs/extensions-manifest-foundation.md:3,20`；`docs/marketplace-capabilities-architecture.md:221`）。

### 5.4 三类归纳

| 类别 | 内容 |
|---|---|
| Wevir 可借的概念（Phase 1） | “扩展库”统一入口（Skills / 连接器 / 插件）；`SKILL.md` frontmatter 约定、校验与多根发现，并兼容 `.claude/skills`、`~/.agents/skills` 这些已成事实标准的位置；MCP 的 `local / remote` 联合类型与状态枚举、Claude Desktop 写法转换；**托管 OAuth：加密保险库 + 本地网关，引擎拿不到第三方令牌**（与计划 §2.8“密钥不落引擎文件”同一思路）；配置写入的“审批 → 审计 → 重载 → 引擎同步”流水线；扩展清单的资源 / 贡献 / 启用条件 schema；坏条目带错误列出而非静默跳过 |
| OpenCode 专属（不能带走） | `opencode.json(c)` 结构及 `mcp`、`plugin`、`permission.external_directory`、`permission.skill`、`agent` 键；`OPENCODE_CONFIG` 注入；`x-opencode-directory`、`POST /mcp`、`client.mcp.*`；`.opencode/` 目录约定；`runtime_opencode_configs` 表结构 |
| Cloud / Den 专属 | `docs/external-mcp-oauth.md`、`docs/mcp-client-oauth.md`（第三方客户端接入 Den 的 `/mcp/agent`）、`docs/marketplace-capabilities-architecture.md`；`openwork-cloud` 连接 MCP（`S/routes/cloud-mcp.ts`）；组织 MCP 连接；`allowManageExtensions` 等桌面策略；云端插件导入 |

dsh 侧对应物（Skills 与 MCP 在 dsh 里如何声明、ACP `session/new` 可挂载 MCP，见计划 §3.1）在 Phase 1 规划时再对齐，骨架阶段不做扩展管理（计划 §7）。

---

## 6. packages/ui 与设计 Token

### 6.1 packages/ui（`@openwork/ui`）

- 私有包，两个子路径 `./react`、`./provider-icon` 直接指向源码（`packages/ui/package.json:5-16`），另配了 tsup（ESM、es2022、`react` 外置，`packages/ui/tsup.config.react.ts:4-18`）。依赖只有 `@paper-design/shaders(-react)` 0.0.72，`react` 为 peer。
- 内容（`U/react/index.ts:1-27`）：Paper 着色器渐变封装与纯 CSS 的 `StaticSeededGradient`（长列表里不创建 WebGL 上下文，`U/react/paper/static-seeded-gradient.tsx:9-15`）、种子化配置与确定性哈希（`U/common/paper.ts`）；下载卡片、路线图、平台检测、Den / 桌面共用的抖动背景引导壳（营销与引导用）；`ProviderIcon`（`U/react/provider-icon.tsx`），按 simpleicons CDN → Google s2 favicon 服务 → 两字母缩写的顺序取图标（`U/react/provider-logo-src.ts:86-123`）。
- 在 `ee/` 之外只有 `apps/app` 用它：会话空态的着色器球与 Provider 图标。**它不是组件库**；真正的 UI 原语在 `apps/app` 里（§6.3）。

### 6.2 Token 架构：三层

1. **原始色阶**：`A/styles/colors.css`（3040 行），文件头注明是由 Radix UI Colors 源文件生成并调整的（`:1`）。31 个色系 × 24 阶（`-1..12` 与 alpha `-a1..a12`），亮色在 `:root`，Display-P3 版本在 `@supports (color: color(display-p3 …))` 里，暗色用 `[data-theme="dark"]` 覆盖。
2. **Tailwind v4 映射**：`A/styles/tailwind-theme.css` 用 `@theme inline` 把每个 Radix 变量映射成 `--color-*`（`:3-746`），`inline` 让工具类经 `var()` 解析，切换主题时不需要重新生成 CSS：

   ```css
   @theme inline {
     --color-slate-1: var(--slate-1);
     ...
     --color-dls-accent: var(--dls-accent);
   ```

3. **语义变量（两套并存）**，都在 `A/app/index.css`：
   - 旧的 DLS：`--dls-surface`、`--dls-border`（写死的十六进制）、`--dls-accent: #011627`、`--dls-accent-rgb`（RGB 三元组，供 `rgb(var(...)/a)`）、`--dls-radius: 16px` 等（`:127-148` 亮、`:185-205` 暗）。
   - shadcn 语义：`--background: var(--slate-1)`、`--foreground`、`--card`、`--popover`、`--primary: var(--blue-9)`、`--muted`、`--destructive`、`--warning`、`--border`、`--input`、`--ring`、`--sidebar-*`、`--radius: 0.45rem`（`:149-182` 亮，`:568-603` 暗，选择器 `.dark, [data-theme="dark"]`），再由第二个 `@theme inline` 映射成工具类，圆角阶梯从 `--radius` 推导（`:605-649`）：

   ```css
   --radius-sm: calc(var(--radius) * 0.6);
   --radius-md: calc(var(--radius) * 0.8);
   --radius-lg: var(--radius);
   --radius-xl: calc(var(--radius) * 1.4);
   ```

- 其他：`@import "tailwindcss" source(none)` + 显式 `@source` 与色阶 safelist（`index.css:1-18`）；`@custom-variant dark` 同时匹配 `.dark` 与 `[data-theme="dark"]`（`:20`）；`electron`、`mac`、`windows`、`linux` 自定义变体，由 preload 给 `<html>` 加类驱动（`:21-40`；`E/preload.mjs:44-53`）；标题栏拖拽与窗口控制工具类（`:42-83`）；`html { font-size: var(--openwork-font-size, 16px) }` 实现界面缩放（`:218-219`）；正文 13px / 1.5（`:236-237`）。
- 没有 `tailwind.config` 和 PostCSS 配置，Tailwind 通过 `@tailwindcss/vite` 4.3 接入（`apps/app/vite.config.ts:8,114`）。
- 问题：Radix 色系名（`gray`、`slate`…）与 Tailwind 默认调色板同名，两套都可用；DLS 的圆角和阴影不在 `@theme` 里，只能写任意值；引入了 Geist 和 IBM Plex 字体但没有任何 `font-family` 用到。

### 6.3 组件分层

- `A/components/ui/`（47 个文件）：shadcn 的 **Base UI 版本**（`apps/app/components.json:3` `"style": "base-luma"`），底层是 `@base-ui/react`，图标 lucide，变体用 `cva` + `cn = twMerge(clsx(...))`（`A/lib/utils.ts:1-6`）+ `data-slot` 属性；按钮是标准样例（`A/components/ui/button.tsx:6-39`）。全仓没有 `@radix-ui/*` 包。聊天相关的 message、chain-of-thought、source、tool、image 五个文件的导出 API 与 prompt-kit 一致（推断，文件里没写来源）。`components.json:24-26` 还配置了 `@ai-elements` registry。
- 原语层不纯：`tool.tsx`、`message.tsx`、`sonner.tsx`、`action-menu-model.ts` 都反向 import 了应用代码（任务恢复、Markdown、主题、桌面 IPC 类型）。
- `A/react-app/design-system/`：名为“可复用展示原语”（`ARCHITECTURE.md:29`），实际是共享复合组件（扩展卡片与详情弹窗、头像、Provider 图标再导出、确认弹窗等），并且反向 import 了 `domains/`（`extension-card.tsx:6-11`）。
- 领域组件在 `A/components/{chat,markdown,tools}` 与 `A/react-app/domains/*`。

### 6.4 主题切换

- `A/app/theme.ts`：模式 `light | dark | system`（`:1`），存 localStorage `openwork.react.settings.theme-mode`，首次读取时迁移旧 key `openwork.themePref`（`:4-5,20-39`）；应用时设置 `documentElement.dataset.theme` 与 `style.colorScheme`，**不加 `.dark` 类**（`:46-51`）；`system` 模式监听 `prefers-color-scheme`（`:73-88`）；订阅者经 `useSyncExternalStore` 接收变化（Sonner、Mermaid）；同时经 IPC `__setNativeTheme` 同步 Electron `nativeTheme.themeSource`，macOS 上切换窗口 vibrancy（`E/main.mjs:1717-1730,2269-2271`）。
- 首帧前脚本 `apps/app/index.html:19-32` 在 React 加载前设置 `data-theme`，避免闪白；但它**只读旧 key** `openwork.themePref`，迁移后用户再改主题只写新 key，首帧会按旧值渲染，直到 `bootstrapTheme()` 纠正。
- `A/components/chat/mcp-app-frame.tsx:448` 用 `classList.contains("dark")` 判断主题，而 `.dark` 类从不设置，MCP App 永远拿到 light。
- `BrandTheme`（`A/react-app/domains/cloud/brand-theme.tsx`）：读组织策略，只覆盖 `--dls-accent*` 三个变量（`:21-44`），属于 Den 功能；它碰不到 shadcn 的 `--primary`，所以品牌色只影响 DLS 的使用者——两套语义变量并存的直接后果。

### 6.5 DESIGN.md 与界面守卫

- `DESIGN.md` 的规则分 P / S / C / V / T 几族，PR 必须引用规则 id（`AGENTS.md:58-61`）。与 Wevir 相关的要点：复用组件、不重新实现键盘 / 焦点 / ARIA（P5，`DESIGN.md:35-38`）；Linear / Vercel 式密度，内边距 12–16px（P6）；不嵌套卡片（S1）；列表行高 40–48px、发丝分隔线（S2）；系统字体、正文 13px / 1.5、标题 ≤ 20px、靠字重和透明度分层级（V1，`:111-115`）；颜色只经语义变量、禁止 `#000` / `#fff` 字面量（V2）；发丝边框和分层阴影二选一（V3）；圆角按层级同心（V4）；lucide 16px / 1.5 描边、不用“AI 闪光”图标（V5）；动效 120–200 ms ease-out、退出快于进入、尊重减少动效（V6）；禁用紫蓝渐变、玻璃拟态、`transition: all`（V7）。代码与规则有漂移（`button.tsx:7` 用了 `transition-all`）。
- 会话视图专门有一组规则（`DESIGN.md:140-156`）：一个回合的各步骤读作一条“轨”，前置图标 + 一句话标签 + 右侧时长，完成的回合折叠成一行“用时 1 分 19 秒 · 12 步”（T1）；失败就地给出修复动作，原始输入输出收进“技术细节”，行内不出现引擎 ID 和原始 Provider 文本（T2）；**待决定时审批卡片是焦点，放在用户操作的位置（输入框上方），写清动作、数据、风险**（T4）；输入框只有一个圆形发送 / 停止按钮，模型与运行模式做成安静的小标签（T5）。另有“状态”一节要求每个数据界面都设计加载（与目标布局一致的骨架屏）、空、错误、受限、离线（显示最后已知状态及确认时间）、成功几种状态（`:97-104`）。
- `scripts/check-ui-guardrails.mjs`：基于 TypeScript AST 的语法扫描，四条规则——原生 `<select>` / checkbox、未经 Portal 的弹出层、过淡的文字色、≤ 10px 的字号（`:11-16`）；以指纹基线做棘轮，只拦新增（`:91-100`，基线 190 条）。这种“基线 + 只拦新增”的做法适合 Wevir 在 M5 之后引入。

---

## 7. 许可证边界复核

**结论：[UPSTREAM.md §2.2](../upstream/UPSTREAM.md) 的结论成立，无需修改，建议补充三点。**

- 复核结果：
  - `REUSE.toml:8-12` 把 `**` 标为 MIT（`2026-present Different AI, Inc.`），`:14-18` 把 `ee/**` 标为 `LicenseRef-OpenWork-EE`；`ee/` 之外没有其他 LICENSE 文件，唯一的 NOTICE 是 `packages/codemode/NOTICE`（与本次参考范围无关）。
  - 本次读过的目录（`apps/app`、`apps/desktop`、`apps/server`、`packages/ui`、`packages/types`、`packages/sdk`）里，对 `ee/` 的引用正是 UPSTREAM.md 已列出的三处：`apps/app/package.json:84`（`@openwork-ee/telemetry-contracts`）、`A/app/lib/models-task-analytics.ts:2`、`packages/sdk/script/generate.mjs:36`。没有新增。
- 建议补充到 UPSTREAM.md §2.2（交 T0.6）：
  1. **MIT 区域里有未署名的第三方派生内容**，移植时要另外保留原始版权声明，或直接从原始来源获取：
     - `A/styles/colors.css`：Radix Colors 生成值（MIT，© WorkOS）。
     - `A/components/ui/*`：shadcn CLI 生成的组件（MIT，© shadcn）。
     - `A/components/ui/{message,chain-of-thought,source,tool,image}.tsx`：导出 API 与 prompt-kit 一致（MIT），来源未注明，按推断处理。
     - `A/components/markdown/markdown-math.ts:6`：注释称数学公式的分隔规则“与上游 opencode web 相同”（opencode 为 MIT），属于做法借鉴，移植时保留该注释。
     - `apps/app/components.json` 配置了 `@ai-elements` registry（Apache-2.0）；本次没有发现明确来自它的文件，但上面五个聊天组件的出处无法从文件本身确认，因此一律只参考、不移植。
  2. **npm 依赖中的非 MIT 许可证**（2026-10-12 `npm view` 核对）：`@pierre/diffs` 1.3.5、`@pierre/trees` 1.0.0-beta.6、`ai` 6.x 为 Apache-2.0；`dompurify` 3.x 为 `(MPL-2.0 OR Apache-2.0)`。`@paper-design/shaders` 0.0.72 的 package.json 只写“SEE LICENSE IN …/LICENSE”，tarball 内 LICENSE 为 MIT（© Lost Coast Labs）；后续版本须重新核对。其余用到的 `@base-ui/react`、`marked`、`shiki`、`lexical`、`@tanstack/react-virtual`、`react-resizable-panels`、`sonner`、`mermaid`、`zustand`、`fuzzysort`、`@modelcontextprotocol/ext-apps` 为 MIT。Wevir 引入这些依赖时由 T6.3 汇总进第三方声明。
  3. **商标与网络**：`ProviderIcon` 运行时从 simpleicons CDN 和 Google s2 服务拉取各模型厂商的 logo（`U/react/provider-logo-src.ts:86-123`）。厂商 logo 是商标，MIT 不授权；Google 服务在大陆不可达。Wevir 不移植这一机制。

---

## 8. 可移植组件候选清单

- 全部路径都在 `ee/` 之外，许可证均按 `REUSE.toml` 的 `**` → MIT（© 2026-present Different AI, Inc.）判断；“另需署名”列出派生自第三方、移植时还要保留的声明。
- “外部依赖”只列 npm 包，同仓的内部 import 在“耦合 / 说明”里提及。
- 建议：**直接移植** = 基本原样搬入，按 UPSTREAM.md §5 写文件头并登记；**改写** = 以它为蓝本重写或大幅裁剪，仍可辨认出来源，同样登记；**只参考** = 不搬代码，只借做法。
- 计划 §7 的边界不变：终端、Diff、文件预览、Skills / MCP 管理都在 Phase 1，下表中这些条目标注了时机。

| # | 路径 | 用途 | 许可证 | 外部依赖 | 与 OpenCode 的耦合 | 建议 |
|---|---|---|---|---|---|---|
| 1 | `apps/app/src/react-app/domains/session/sync/sync-stream-lifecycle.ts`（184 行） | 事件流重连状态机：五个阶段、指数退避、鉴权类失败慢速重试、30 s 静默看门狗、令牌轮换立即重连 | MIT | 无（仅同仓 `connection-diagnostic-history.ts`，也无外部依赖） | 无 | **改写** → T4.1 client-sdk / T5.5：保留阶段与退避，传输换成 WebSocket，重连后按 `sinceSeq` 补齐（A6） |
| 2 | `apps/app/src/components/chat/progressive-message-list.tsx`（473 行） | 虚拟化消息列表：按组虚拟化、按会话与宽度缓存高度、展开 / 聚焦的组保持挂载、贴底与阅读位置锚定 | MIT | `@tanstack/react-virtual`、`react` | 无 | **直接移植**（时机：会话变长出现性能问题时；T5.3 可先不虚拟化） |
| 3 | `apps/app/src/react-app/domains/session/surface/scroll-controller.ts`、`scroll-store.ts`、`scroll-overlay.tsx`（707 / 316 / 119 行） | 贴底 / 手动两种滚动模式、ResizeObserver 对账、`overflow-anchor` 切换、“跳到最新”按钮 | MIT | `react`、`zustand`、`lucide-react` | 浅：一处处理 OpenCode v2 乐观消息 ID（`scroll-controller.ts:311`） | **改写** → T5.3：保留两模式状态机，去掉移动端轮次留白与滚动位置持久化 |
| 4 | `apps/app/src/components/markdown/markdown-primitive.ts`、`markdown-math.ts`、`selection-stability.ts`（705 / 120 / 67 行） | 流式安全的增量 Markdown 渲染（只重 lex 末尾 2 块，已定块复用 HTML）、KaTeX、DOMPurify 清洗、Shiki 高亮、选区保护 | MIT；`markdown-math.ts` 注明做法同 opencode web（MIT），保留该注释 | `marked`、`marked-emoji`、`emojilib`、`katex`、`marked-katex-extension`、`dompurify`（MPL-2.0 OR Apache-2.0）、`shiki`、`@shikijs/transformers` | 无；内部依赖会话引用、favicon 两个模块，需剪掉 | **改写** → T5.3：保留 `createStreamingMarkdownRenderer` 与清洗管线，去掉 emoji、会话引用、favicon；收益最高的一项 |
| 5 | `apps/app/src/components/markdown/markdown.tsx`、`mermaid.ts`（496 / 422 行） | React 包装：流式 / 静态切换、代码复制、文件路径点击、进入视口才高亮；Mermaid 懒加载 | MIT | `react`、`mermaid`、`dompurify` | 无；但深度依赖成果面板、打开目标等应用模块 | **只参考**（高亮延迟到流式结束且进入视口这一策略写进 T5.3） |
| 6 | `apps/app/src/lib/tool-aggregate.ts`、`tool-activity.ts`、`tool-call-duration.ts`、`current-tool-lifecycle.ts`（231 / 97 / 73 / 25 行） | 连续工具调用聚合与标题（“编辑 3 个文件、运行 8 条命令”）、活动标签、时长、回合停止后显示“状态未知” | MIT | `ai`（仅类型，Apache-2.0） | 中：工具名集合与输入字段名来自 OpenCode（经 `lib/build-in-tools.ts`） | **改写** → T5.3：分类表换成 Wevir 的工具展示类型（A20），“状态未知”规则照搬 |
| 7 | `apps/app/src/components/chat/tool-aggregate-group.tsx`（468 行） | 聚合工具卡片 UI：进行时 / 完成时标题、当前动作行、最多 8 行加“再显示 N 条” | MIT | `react`、`lucide-react` | 间接（经 #6） | **只参考** |
| 8 | `apps/app/src/components/ui/tool.tsx`（290 行） | 单个工具的可折叠卡片：状态图标、输入 / 输出 `<pre>`、简易 diff 行着色、复制结果 | MIT；API 与 prompt-kit `Tool` 一致（推断，MIT），见 §7 | `ai`（类型）、`lucide-react`、`@base-ui/react` | 无直接耦合；依赖任务恢复等应用模块 | **只参考**（出处不明，T5.3 自写卡片：名称、参数摘要、状态、结果） |
| 9 | `apps/app/src/react-app/domains/session/chat/permission-approval-modal.tsx`（282 行） | 输入框上方的内联审批面板：按类别给标题与说明、作用范围、可折叠元数据、三个按钮 | MIT | `react`、`lucide-react` | 中：`once / always / reject` 三值与权限类别是 OpenCode 的；`PendingPermission` 基于 SDK 类型（`A/app/types.ts:395-406`） | **改写** → T5.3：按钮改为渲染 `ApprovalRequest` 携带的选项（A20），详情取同一 `toolCallId` 的 `rawInput`（T0.3 §5） |
| 10 | `apps/app/src/react-app/domains/session/modals/question-modal.tsx`（279 行） | 多问题、单选 / 多选、自由文本的提问面板 | MIT | `react`、`lucide-react` | 中：`QuestionInfo` 类型来自 `@opencode-ai/sdk` | **只参考**（dsh 无对应能力） |
| 11 | `apps/app/src/react-app/domains/session/artifacts/open-target.ts`、`apps/app/src/lib/artifacts.ts`（430 / 98 行） | 从消息中推导文件成果（URL、链接、路径、写工具输入、补丁头），按扩展名映射预览类型 | MIT | `ai`（类型） | 中：`filePath` 字段与 `*** Add/Update File:` 补丁头是 OpenCode 工具的格式 | **改写**（Phase 1 成果面板；骨架只在工具卡片里显示 `rawInput` 中的路径） |
| 12 | `apps/app/src/react-app/domains/session/sync/session-sync.ts`、`usechat-adapter.ts`、`parse-tool-parts.ts`、`transcript-reconcile.ts`、`session-transcript-deltas.ts` | SSE 订阅、事件分派、OpenCode Part → `UIMessage` 转换、快照对账、增量合并 | MIT | `@opencode-ai/sdk`、`ai`、`zustand` | **深**：事件名、Part 模型、v1/v2 差异 | **只参考**：借“按帧冲刷可见会话、后台会话降频、未声明 part 先挂起增量、渲染层以消息部件为界”四个做法 |
| 13 | `apps/app/src/react-app/shell/workspace-routes.ts`（116 行） | 工作区作用域路由构造：`/workspace/:id/session/:sid`、`/workspace/:id/settings/:tab` 等 | MIT | 无 | 无 | **改写** → T5.2：同样以 URL 为工作区与会话身份的唯一事实 |
| 14 | `apps/app/src/react-app/domains/session/sidebar/sidebar-lanes.tsx`（51 行） | 左栏两条对齐轨（20px 图标轨、44px 标签轨）与按深度缩进的规则 | MIT | `react` | 无 | **只参考**（对齐规则写进 T5.2 的布局 Token） |
| 15 | `apps/app/src/react-app/domains/session/chat/workbench-panel-group.tsx`（89 行） | 主 / 副会话分屏，比例记忆 | MIT | `react`、`react-resizable-panels` | 无 | **只参考**（分屏不在骨架范围） |
| 16 | `apps/app/src/react-app/domains/session/surface/composer/editor.tsx`（1561 行） | Lexical 富输入：@提及、/命令、Skill 与附件 chip、粘贴块 | MIT | `lexical`、`@lexical/react`、`fuzzysort` | 浅（类型） | **只参考**：骨架用 `<textarea>`；“Enter 发送、Shift+Enter 换行、输入法合成期间不发送”的按键逻辑照做 |
| 17 | `apps/app/src/app/theme.ts`（125 行）+ `apps/app/index.html:19-32` | 主题模式存储、`data-theme` 与 `colorScheme`、系统主题监听、`useSyncExternalStore` 订阅、Electron `nativeTheme` 同步；首帧前脚本防闪白 | MIT | 无 | 无 | **直接移植** → T5.2，修两处：首帧脚本与运行时读同一个 key；暗色只认 `data-theme`，删掉对 `.dark` 类的依赖 |
| 18 | `apps/app/src/styles/colors.css`、`apps/app/src/styles/tailwind-theme.css`（3040 / 758 行） | Radix Colors 色阶（含 P3 与暗色）及其到 Tailwind v4 `@theme inline` 的映射 | MIT；数值来自 Radix Colors（MIT，© WorkOS），另需署名 | 无（CSS） | 无 | **只参考**：Wevir 直接依赖 `@radix-ui/colors` npm 包，只取用到的几个色系，自写 `@theme inline` 映射 |
| 19 | `apps/app/src/app/index.css`（670 行） | 语义变量层、`@custom-variant dark`、平台变体、标题栏拖拽工具类、从 `--radius` 推导的圆角阶梯、界面缩放 | MIT | `tailwindcss` 4、`tw-animate-css`、`shadcn/tailwind.css` | 无 | **只参考**：结构照三层走，视觉不复制（计划 §6 T5.2）；只保留一套语义变量 |
| 20 | `apps/app/src/components/ui/*`（47 个文件） | Base UI 版 shadcn 原语：按钮、对话框、菜单、侧栏、可调分栏、Toast 等 | MIT；由 shadcn CLI 生成（MIT，© shadcn），另需署名 | `@base-ui/react`、`class-variance-authority`、`clsx`、`tailwind-merge`、`lucide-react`、`sonner`、`react-resizable-panels` | 个别文件反向依赖应用代码 | **只参考**：Wevir 用 shadcn CLI 从官方 registry 生成同风格（Base UI）原语，不从 OpenWork 拷 |
| 21 | `apps/app/src/i18n/index.ts`、`apps/app/src/i18n/locales/zh.ts`（221 / 746 行） | 扁平点分 key、复数后缀、缺失回退链、语言持久化；中文术语约定 | MIT | 无 | 无 | **改写** → T5.4：中文为源语言与默认语言，所有导航文案走 `t()`；`zh.ts:1-6` 的术语约定可参考 |
| 22 | `apps/desktop/electron/workspace-file-access.mjs`（78 行） | realpath 后判断文件是否仍在工作区内（防符号链接逃逸，Windows 大小写不敏感） | MIT | 无（`node:fs`、`node:path`） | 无 | **直接移植** → 放进 Host（T2 / T5.4），渲染进程不直接碰文件（计划 §6 T5.1） |
| 23 | `apps/desktop/electron/main.mjs:1941-1954`（`pickDirectory`） | 系统文件夹选择器 IPC | MIT | `electron` | 无 | **只参考**（十几行标准 API，T5.4 自写） |
| 24 | `apps/desktop/electron/workspace-store.mjs`（981 行） | 工作区列表 JSON 存储：原子写、从旧存储恢复、选中与运行中分开记 | MIT | `@openwork/paths`、Node 内置 | 中：`.opencode/openwork.json`、旧 Tauri 字段 | **只参考**：Wevir 工作区存 Host 的 SQLite（T2.1）；只借“选中 / 运行中分开”“移除只注销”两条 |
| 25 | `apps/desktop/electron/secure-vault-key.mjs`（124 行） | 用 Electron safeStorage 保护本地加密主密钥；解不开时隔离旧文件重建；Linux 无安全存储时拒绝 | MIT | `electron`、Node 内置 | 无 | **改写**（时机：计划 §8“密钥迁移系统钥匙串”；Host 是独立进程，不能直接调 safeStorage，需由桌面主进程代管或改用系统钥匙串库） |
| 26 | `apps/server/src/skills.ts`、`validators.ts`、`frontmatter.ts`（296 / 89 / 22 行） | `SKILL.md` 解析与校验、多根目录发现、坏条目带错误列出 | MIT | `yaml`（ISC）、Node 内置 | 中：`.opencode/skills`、`~/.config/opencode/skills` 路径 | **改写**（Phase 1 Skills 管理：发现根目录换成 dsh 的约定，保留 `.claude/skills` 兼容） |
| 27 | `apps/app/src/app/mcp.ts`（125 行） | MCP 配置编辑：Claude Desktop `command + args` 写法转换、jsonc 编辑 | MIT | `jsonc-parser` | 深：写 `opencode.json` 的 `mcp` 键 | **只参考**（Phase 1） |
| 28 | `apps/server/src/local-managed-mcp.ts`（1321 行） | 托管 MCP OAuth：server 当 OAuth 客户端、AES-256-GCM 保险库、引擎只见本地网关与 HMAC 令牌 | MIT | `@modelcontextprotocol/sdk`、`@modelcontextprotocol/client`、`@openwork/enterprise-mcp-client`（同仓 `packages/`，MIT） | 中 | **只参考**（Phase 1 远程 MCP OAuth 的设计范本） |
| 29 | `apps/app/src/app/extensions.ts`（212 行） | 扩展清单 schema：来源格式、资源、UI 贡献、安装步骤、启用条件 | MIT | 无 | 浅：来源格式枚举含 `opencode-plugin` | **只参考**（Phase 1 扩展库的数据模型） |
| 30 | `packages/types/src/desktop-ipc.ts`（545 行） | 用一张 `DesktopCommandMap` 类型表约束所有 preload 命令 | MIT | 无 | 浅：`EngineInfo` 等字段 | **只参考**（T5.1 的 preload 面很小，借“单表约束命令”的写法即可） |
| 31 | `packages/ui/src/react/provider-icon.tsx`、`provider-logo-src.ts` | 模型 Provider 图标：CDN logo → favicon 服务 → 两字母缩写 | MIT；厂商 logo 是商标 | `react` | 浅：`opencode` / `openwork` provider id | **只参考**：Wevir 只做本地缩写头像回退，不在运行时拉外网图标（大陆网络、商标） |
| 32 | `packages/ui/src/common/paper.ts`、`packages/ui/src/react/paper/*` | 种子化着色器渐变与纯 CSS 版本 | MIT | `@paper-design/shaders(-react)` 0.0.72（tarball 内为 MIT） | 无 | **只参考**（装饰性，骨架不需要） |

---

## 9. 对 Wevir 骨架 UI（M5）的布局建议

### 9.1 主窗口

```text
┌ 左栏 260（220–400 可拖，⌘B 收起）┬ 顶栏：会话标题 · 工作区名 · 状态           [■ 停止][▣ 右栏] ┐
│ Wevir                Host ●已连接  ├───────────────────────────────────────────┬────────────────┤
│ ＋ 新会话                ⌘N        │ 消息流（单列，内容最大宽约 760，居中）          │ 右栏 360（默认收起）│
│ 工作区                      [＋]   │   用户消息                                  │ 骨架：占位       │
│ ▾ 工作区 A             [＋][⋯]     │   助手消息（Markdown，流式）                   │ · 工作区路径      │
│     会话 1          ● 运行中        │   ▸ 读取 3 个文件（聚合工具卡片）               │ · 本会话涉及的    │
│     会话 2          ◐ 待审批        │   ▸ bash  npm test   ✓ 2.1s                 │   文件路径列表    │
│     会话 3                         │   助手消息 …                                 │ Phase 1：        │
│ ▸ 工作区 B                         │ ┌ 审批：写入 ./summary.md ─────────────────┐ │ 文件 / Diff /    │
│                                    │ │ 理由 · 路径 · 内容摘要    [详情 ▾]         │ │ 成果标签         │
│                                    │ │                    [拒绝] [允许一次]     │ │                │
│ ───────────────                    │ └─────────────────────────────────────────┘ │                │
│ ⚙ 设置                             │ [ 输入框  Enter 发送 · Shift+Enter 换行 ]  [发送] │                │
└────────────────────────────────────┴───────────────────────────────────────────┴────────────────┘
```

1. **路由**（T5.2）：`/workspace/:wid/session/:sid`、`/workspace/:wid/session`（新会话草稿）、`/settings/:tab`。URL 是当前工作区与会话的唯一事实；“上次打开的会话”只用于启动时恢复（T5.5），资源不存在时显示“未找到”，不回落到第一个工作区（§1.1）。
2. **左栏**（T5.2）：工作区为可折叠分组，会话挂在所属工作区下（会话不跨工作区，与计划 §8“一个会话对应一个工作区目录”一致）。会话行带状态标记：运行中 / **待审批** / 出错 / 未读。待审批必须在左栏可见，因为审批可能来自另一个客户端（计划 §4.2 第 7 条）。行高 32–36px，图标轨与标题轨固定对齐（借 `sidebar-lanes.tsx`）。底部放“设置”和 Host 连接状态，不另设状态栏。骨架不做置顶、分组、归档、拖动排序。
3. **中间**（T5.3）：
   - 单列消息流，内容限宽居中；贴底 / 手动两种滚动模式，离开底部时出现“跳到最新”（#3）。
   - 流式 Markdown 用增量渲染（#4）；可见会话按帧冲刷、后台会话降频；代码高亮等流式结束后再做。
   - 工具卡片默认折叠，显示名称、参数摘要、状态、时长；连续的读取 / 搜索类调用聚合成一张（#6）；回合结束而工具未收尾时显示“状态未知”，不无限转圈。
   - **审批卡片固定在输入框上方，不用模态框**：不遮挡上下文，一次显示一个，标出“还有 N 个待审批”；内容取同一 `toolCallId` 的 `rawInput`（路径、内容摘要、模型给的理由）；按钮按请求携带的选项渲染（骨架只有“允许一次 / 拒绝”）。另一端先审批时，卡片按 `approval.resolved` 收起并提示“已由 <设备> 处理”（A9）。
   - 输入框：Enter 发送、Shift+Enter 换行、输入法合成期间不发送；运行中发送键变为“停止”，Esc 也可停止；运行中不允许再发送（对应 A11 的 `session_busy`），排队与插话留到后续（D10）。
4. **右栏**（T5.2）：默认收起，顶栏按钮打开；骨架只放占位（工作区路径、本会话涉及的文件路径）。数据结构先按“每会话一组标签 `{type, …}`”设计，Phase 1 加文件、Diff、成果标签时不改布局。不做右轨、内置浏览器、终端坞。
5. **Host 连接状态**（T5.5）：左栏底部常驻状态点；断线时在消息流顶部出横幅“与 Host 的连接已断开，正在重连…”，状态阶段照 `sync-stream-lifecycle.ts` 的五阶段（#1），重连后按 `sinceSeq` 补齐。
6. **窗口**：最小宽度约 960px（左栏 220 + 中间 ≥ 560 + 右栏收起）；macOS 用 `hiddenInset` 标题栏并留出红绿灯区域，Windows 用标题栏覆盖，拖拽区与平台变体照 `index.css:21-83` 的做法。骨架不做窄屏模式。

### 9.2 设置页

全屏覆盖层，左侧标签列表，右侧内容，关闭后回到来源会话。骨架只需要计划 §6 T5.4 的内容：

| 分组 | 标签 | 骨架内容 |
|---|---|---|
| 全局 | 模型 Provider | 增删改、测试连接；Key 只经 Host，不在渲染进程持久化 |
| 全局 | 外观 | 主题（浅色 / 深色 / 跟随系统）、语言（默认简体中文） |
| 工作区 | 工作区 | 添加（系统文件夹选择器）、改显示名、移除（只注销，不删文件，二次确认） |
| 关于 | 关于与诊断 | 版本、Host 状态、协议版本、日志位置 |

Phase 1 再加“扩展库”（Skills / MCP / 插件统一入口，§5.4）、快捷键、授权目录（按工作区，不像 OpenWork 那样全局生效）。

### 9.3 设计 Token（T5.2）

- **三层**：原始色阶（`@radix-ui/colors` npm 包，只取一个中性色系加一个强调色和红 / 琥珀 / 绿三个状态色）→ 一套语义变量（`--background`、`--foreground`、`--muted`、`--muted-foreground`、`--border`、`--primary`、`--destructive`、`--warning`、`--success`、`--sidebar-*`）→ `@theme inline` 映射成 Tailwind 工具类。**只要一套语义变量**，避免 OpenWork DLS 与 shadcn 并存导致品牌色只覆盖一半（§6.4）。
- **暗色**：只认 `<html data-theme="dark">`，用 `@custom-variant dark` 声明；首帧前脚本与运行时读同一个 key；`nativeTheme.themeSource` 同步（#17）。
- **字号**：OpenWork 正文 13px 是按英文密度定的；中文笔画密，建议正文 14px / 行高 1.6，代码 13px。字体用系统栈（`-apple-system, "PingFang SC", "Microsoft YaHei", …`），不引入网络字体（体积与大陆 CDN）。
- **圆角与间距**：照 OpenWork 用一个 `--radius` 推导圆角阶梯，按层级同心；间距用 Tailwind 默认 4px 网格。
- **动效**：120–200 ms ease-out，尊重 `prefers-reduced-motion`，禁用 `transition: all`（DESIGN.md V6、V7）。
- **原语**：用 shadcn CLI 生成 Base UI 版原语（#20），首批只要按钮、输入框、文本域、对话框、下拉菜单、提示、可折叠、可调分栏、Toast。

---

## 10. 对 SKELETON_PLAN 的修改建议（由 T0.6 落实）

本任务不改计划，以下建议交 T0.6 统一处理。

1. **§6 T5.1**：补充 preload 必须输出 CJS，才能满足 `sandbox: true`（OpenWork 用 ESM preload，只好关掉 sandbox，§2.3）；Chrome DevTools 远程调试端口只在开发模式开启（OpenWork 正式版也开着，§2.3）；外部链接经 `shell.openExternal`，拦截 `will-navigate` 与 `window.open`。
2. **§6 T5.2**：把“参考 OpenWork 的信息架构”具体化为 §9.1 第 1、2、4 条（路由方案、左栏两级树与状态标记、右栏默认收起的标签模型），以及 §9.3 的三层 Token、单套语义变量、`data-theme` 暗色、中文字号与系统字体栈。
3. **§6 T5.3**：写明审批卡片内联在输入框上方，详情取同一 `toolCallId` 的 `rawInput`，按请求携带的选项渲染按钮，另一端已处理时自动收起；运行中禁止再发送（与 A11 一致）；Markdown 采用“只重渲染末尾块”的增量方式；回合结束时未收尾的工具显示“状态未知”。
4. **§6 T5.4**：工作区移除只注销、不删文件；添加时由 Host 按 realpath 去重；中文为源语言，所有导航文案走 `t()`。
5. **§6 T1.1**：`Workspace` 至少含 `id`、`rootPath`（realpath 规范化）、`displayName`、`createdAt`；`Session` 恰属一个工作区；工具调用的展示类型与 A20 合并考虑 §3.9 的映射。客户端消息投影是否直接采用 AI SDK `UIMessage` 的部件形状（`ai` 包为 Apache-2.0，只用类型），在 T1.1 定。
6. **docs/upstream/UPSTREAM.md §2.2**：补充 §7 的三点（未署名的第三方派生内容、非 MIT 的 npm 依赖、Provider logo 的商标与网络问题）。
7. **§6 T6.4（Phase 1 规划）**：扩展库作为 Skills / MCP / 插件的统一入口；`SKILL.md` 兼容 `.claude/skills` 与 `~/.agents/skills`；远程 MCP 的 OAuth 采用“加密保险库 + 本地网关，引擎拿不到第三方令牌”的模式（§5.2）；授权目录按工作区生效；配置写入走“审批 → 审计 → 重载”流水线。

文档漂移（供以后读 OpenWork 时注意）：`A/react-app/ARCHITECTURE.md:26-27` 说 `kernel/` 下有 `global-sdk`、`global-sync` provider，`A/react-app/kernel/` 里没有这两个文件；`docs/opencode-v2-parallel-lane.md` 引用的 `S/server.ts` 行号已过时。
