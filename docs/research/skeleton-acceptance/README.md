# 骨架验收存档

Gate M5 的手动验收截图与录屏放在这里（[SKELETON_PLAN §6 M5](../../SKELETON_PLAN.md)），按任务分节。

## T5.2 设计 Token 与布局骨架（2026-10-13）

环境：`pnpm --filter @wevir/desktop dev`（开发模式，`WEVIR_HOME` 指向临时数据目录），桌面端附着到一个 EchoAdapter Host。Host 的步进调慢到 15 s，示例会话因此停在不同状态：

| 会话 | 状态 | 左栏标记 |
|---|---|---|
| 整理第三季度销售数据… | 运行中，且有没看过的新事件 | 左侧闪烁的靛蓝点、标题加粗、右侧未读点 |
| 汇总 data/ 下的 CSV | 空闲，打开过之后又有新回合 | 标题加粗、右侧未读点 |
| fail 读取季度数据 | 空闲，上一回合失败（`lastError`） | 左侧红点 |
| approve 写入 summary.md | 等待审批（当前打开的会话） | 左侧琥珀点 + “待审批”标签 |
| 把 README 的安装步骤改成中文 | 空闲，已读 | 无 |

截图经 Chrome DevTools 协议（开发模式的远程调试端口）设定视口宽度后截取，2 倍像素密度。窗口的最小宽度是 960（`main/index.ts`）；900 是界面放大（⌘+）后 CSS 视口比窗口窄的情形，折叠规则见 `apps/desktop/src/renderer/src/layout/layout-rules.ts`。

| 文件 | 内容 |
|---|---|
| `t5.2-1280-light.png` / `t5.2-1280-dark.png` | 1280 宽：左栏 260 停靠、中栏内容限宽 760 居中、右栏打开并停靠（“每会话一组标签”，骨架只有“概览”占位） |
| `t5.2-900-light.png` / `t5.2-900-dark.png` | 900 宽：左栏停靠，中栏 640，右栏收起 |
| `t5.2-900-light-right-panel-overlay.png` / `t5.2-900-dark-right-panel-overlay.png` | 900 宽打开右栏：放不下 260 + 560 + 360，改为浮层，不挤压中栏 |
| `t5.2-settings-appearance-light.png` / `t5.2-settings-appearance-dark.png` | `/settings/appearance`：主题“跟随系统 / 浅色 / 深色”的手动切换 |
| `t5.2-not-found-dark.png` | `/workspace/<wevir-site>/session/<属于“季度报告”的会话>`：会话不属于 URL 里的工作区，显示“未找到”，不改写到它真正所在的工作区 |

同一环境下逐项核对的行为（经 DevTools 协议执行，结果如实记录）：

- 主题：依次点“浅色 / 深色 / 跟随系统”，`<html data-theme>`、localStorage 的 `wevir.theme-mode`、计算出的 `color-scheme` 与页面底色一致；选浅色时渲染进程里 `prefers-color-scheme: dark` 变为 false、选回跟随系统后恢复系统值（nativeTheme 已同步）；刷新后保持所选模式。首帧前脚本与运行时的解析规则一致，由 `apps/desktop/src/shared/theme.test.ts` 在 `node:vm` 里核对。
- 左栏：拖动右缘从 260 到 340，继续拖到 900 时停在 400；聚焦分隔条按 ← 变为 384；双击恢复 260，宽度记在 `wevir.layout.v1`。⌘B 收起 / 展开并记住。
- 窄窗口：700 宽时左栏自动隐藏，按钮以浮层打开；Esc 关闭浮层（先关焦点触发的提示，再关浮层），焦点回到打开它的按钮。
- 路由：`/settings` 重定向到 `/settings/appearance`；`/settings/billing`、`/foo/bar`、不存在的工作区都显示“未找到”及原因；`/workspace/<id>/session` 是该工作区的新会话草稿；“关于”页显示 Host 已连接、协议版本 0.3.0。

## T5.3 会话视图（2026-10-13）

环境：`electron-vite dev`（开发模式，`WEVIR_HOME` 指向临时数据目录），桌面端附着到 `wevir-host --adapter dsh`（真实 dsh 0.2.1-alpha.2，stream-tap 旁路开启）。本机没有模型 Key，Provider 是本地脚本化的 OpenAI 兼容服务（`@wevir/adapter-dsh/testing` 的 `startMockModel`，经 `provider.upsert` 登记为 `openai-compatible`），dsh 照常发请求、执行工具、走沙箱与审批；脚本按提示里的 `[demo:A]`…`[demo:D]` 决定回复。审批用例写到 `packages/adapter-dsh/.test-outside/`（工作区之外、且不在系统临时目录，原因同 Gate M4），用完删掉。操作经 Chrome DevTools 协议（开发模式的远程调试端口 9339）发真实的按键与点击，截图 1 倍像素密度。

| 步骤 | 结果 | 截图 |
|---|---|---|
| 新会话草稿里输入任务，Enter 发送 | 建会话并跳到会话页；思考、`read` → `glob` → `grep` 三次工具调用聚合成“读取 1 个文件、搜索 2 次”，正文按块流式渲染（表格、列表、代码块），状态栏“运行中 · N 秒”、发送键变“停止” | `t5.3-1-streaming.png` |
| 回合结束 | 代码块进入视口后高亮；展开聚合卡片可见每次调用的参数摘要、状态与结果第一行，夹在中间的思考按原顺序保留；“本轮已完成 · 6.1 秒” | `t5.3-2-tools-done.png` |
| 写工作区外的文件（`[demo:B]`） | 第一次写被沙箱拒绝（失败）；模型带 `sandbox_permissions` 重试时输入框上方出现审批卡片：标题、目标、“完全访问，不受工作区限制”、Agent 给出的理由、内容预览、可折叠的完整参数，按钮按请求的选项渲染（允许一次 / 拒绝）；左栏会话行标“待审批”，状态栏“等待审批” | `t5.3-3-approval.png` |
| 点“允许一次” | 卡片收起，工具转成功，文件写入 `.test-outside/t53-demo/summary-allowed.md` | `t5.3-4-allowed.png` |
| 再一次审批（`[demo:C]`），点“拒绝” | 工具显示“被拒绝”，文件没有写入，模型说明未写入 | `t5.3-5-denied.png` |
| 长回答（`[demo:D]`）生成中点“停止” | 回合结算为“本轮已取消”，状态回到空闲、发送键恢复；已生成的半段保留（ACP 补发的已提交消息替换了增量） | `t5.3-6-before-cancel.png`、`t5.3-7-cancelled.png` |

另外核对（同样经 DevTools 协议，如实记录）：

- **另一端处理审批**：EchoAdapter Host 上桌面端显示审批卡片时，另一个客户端（CLI 身份、同一 `device-id`）先批准，卡片按 `approval.resolved` 收起并提示“已由本机的命令行处理：允许一次”（`t5.3-10-resolved-elsewhere.png`）。Esc 在等待审批时停止回合，卡片收起并提示“审批已取消（回合被取消）”。
- **左栏**：另一个客户端新建会话并触发审批，约 2 秒内出现在左栏（定时 / 获得焦点时重读列表），标“待审批”并按最近活动排到最前；已知会话的状态、标题经各自的事件订阅实时更新。
- **长会话**（`t5.3-9-long-session.png`）：EchoAdapter 灌入 1205 条事件（106 个回合，每回合另发一条 `engine.raw`）。打开会话到贴底渲染完成约 354 ms，首屏只渲染最后 60 条消息（1307 个 DOM 节点）。用滚轮事件从底滚到顶（200 次、每次 300 px），途中按 60 条一段向前扩展到全部 212 条：728 帧平均 7.0 ms（120 Hz 屏，约 142 fps），p95 8.3 ms，最长 28.5 ms，没有超过 50 ms 的帧。
- **engine.raw**：开发模式下以虚线框的调试样式显示（“未识别的引擎消息（仅开发模式可见）· 方法 · 类型”，可展开原文）；生产构建不投影（`import.meta.env.DEV`）。
- **复制与 CSP**：代码块“复制”经主进程写入系统剪贴板，按钮显示“已复制”；渲染、高亮期间没有 `securitypolicyviolation`。渲染进程里核对 DOMPurify：`javascript:` 链接只剩文字、原文 HTML 按文本显示、链接标题里的引号注入被转义。
- **浅色主题**：`t5.3-8-light.png`。

## T5.4 设置：Provider 与工作区（2026-10-14）

环境：`electron-vite dev`（开发模式），`WEVIR_HOME` 指向全新的临时数据目录，桌面端自己拉起 `wevir-host --adapter dsh`（真实 dsh 0.2.1-alpha.2）。本机没有模型 Key，Provider 用本地脚本化的 OpenAI 兼容服务（`@wevir/adapter-dsh/testing` 的 `startMockModel`，任意 Key）。操作经 Chrome DevTools 协议（远程调试端口 9339）发真实的点击与文字输入，截图 1 倍像素密度、系统深色。系统文件夹选择器无法经 DevTools 协议操作：开发进程加 `--inspect 9340`，经主进程的 V8 inspector 把 `dialog.showOpenDialog` 换成返回固定文件夹（记录到的调用参数是 `{properties: ['openDirectory', 'createDirectory']}`），IPC、发送方校验、渲染进程与 Host 的 `workspace.add` 都是真的；“添加文件夹”按钮到系统对话框这一段是 T5.1 的 `selectFolder`，没有改动。

| 步骤 | 结果 | 截图 |
|---|---|---|
| 全新数据目录启动 | 中栏显示“开始使用 Wevir”三步引导：配置模型 Provider（当前步）、添加工作区、新建会话 | `t5.4-1-onboarding.png` |
| 点“去配置”→“添加 Provider” | 设置 → 模型 Provider；先选服务：DeepSeek 官方，或 OpenAI 兼容模板（通义千问、Kimi、智谱 GLM、DeepSeek OpenAI 兼容、本机 Ollama，取自 providers.md §7）、其他 OpenAI 兼容服务 | `t5.4-2-provider-picker.png` |
| 选 Kimi 模板 | 地址、协议、模型（含上下文长度）都已填好，模板说明与官方文档链接在上方；Key（密码框）排在最前并获得焦点，只需填 Key | `t5.4-3-preset-form.png` |
| 选“其他 OpenAI 兼容服务”，填本地 mock 的地址、模型 `wevir-mock` 与 Key，保存 | 回到列表，卡片显示 ID、默认模型、地址、“Key 已设置”；有 Key 时保存后自动测一次连接：“连接成功，用时 3 毫秒”。Key 不在页面 DOM、localStorage 里，只在 Host 的 `secrets.json`（0600） | `t5.4-4-custom-form.png`、`t5.4-11-providers-light.png`（浅色） |
| 再加一个“本机 Ollama”（11434 端口没有服务） | 自动测试失败，读作“连不上服务”＋修复建议＋原文“127.0.0.1:11434 拒绝连接（ECONNREFUSED），服务是否在运行？” | `t5.4-5-test-failed.png` |
| 编辑 mock Provider | 标题“编辑 本地模拟模型”，ID 不可改，Key 框为空、占位“已设置，留空保持不变”；取消 | — |
| 删除 Ollama | 确认框写明会同时删除 Key、引用它的会话在重新添加同 ID 前不能继续；确认后从列表消失 | `t5.4-6-remove-provider.png` |
| 关窗口重开（同一数据目录），回到首页 | Provider 还在，引导第 1 步打勾；点“去添加”→“添加文件夹” | — |
| 选中 `…/t54/wevir-demo` | “已添加工作区“wevir-demo”。”，列表显示完整路径与会话数 | `t5.4-9-workspaces.png` |
| 以 `/tmp/…/wevir-demo/` 再添加一次（与 `/private/tmp/…` 同一 realpath） | “这个文件夹已经是工作区“wevir-demo”。”，列表仍只有一行 | — |
| 选一个不存在的路径 | “文件夹不存在：…” | — |
| 返回首页 | 前两步打勾，第 3 步“新建会话”可点 | `t5.4-7-onboarding-step3.png` |
| 新建会话：草稿页默认选中“本地模拟模型 · wevir-mock”，输入后 Enter | 建会话并跳到会话页，真实 dsh 经 mock Provider 流式回复，“本轮已完成 · 0.7 秒”；左栏出现该会话 | `t5.4-8-session.png` |
| 移除这个工作区（有 1 个未关闭的会话） | 确认框写明只注销、不删除磁盘文件（附完整路径），1 个会话会隐藏、1 个未关闭的会话会先被关闭；确认后列表为空，磁盘上的 `README.md` 仍在 | `t5.4-10-remove-workspace.png` |
| 再添加同一个文件夹 | “已重新添加工作区“wevir-demo”，之前的会话也回来了。”，1 个会话 | — |

有了 Provider、工作区与会话之后，首页回到“选择一个会话”，带“新建会话”按钮。

## Gate M5 与 T5.5 重启恢复、断线重连（2026-10-14）

环境：仓库根目录 `pnpm install --frozen-lockfile`（Lockfile is up to date）后 `pnpm dev`（开发模式），`WEVIR_HOME` 指向全新的临时数据目录，桌面端自己拉起 `wevir-host --adapter dsh`（真实 dsh 0.2.1-alpha.2，stream-tap 旁路开启）。本机没有模型 Key，Provider 是本地脚本化的 OpenAI 兼容服务（固定端口，按提示里的 `[demo:A]`…`[demo:E]` 决定回复：A 读文件 / glob 后流式输出表格与代码块，B / C / E 写工作区外的文件触发审批，D 长回答；其他提示回答“上下文里有几条你的消息”，用来确认重启后模型看得到之前的对话）。审批用例写到 `packages/adapter-dsh/.test-outside/t55/`（工作区外、不在系统临时目录），用完删掉。操作经 Chrome DevTools 协议（远程调试端口，`WEVIR_DESKTOP_DEBUG_PORT=9349`）发真实的点击、文字输入与按键，截图 1 倍像素密度、系统深色。系统文件夹选择器照 T5.4 的做法经主进程 inspector（`pnpm dev --inspect 9350`）换成返回固定文件夹，其余（IPC、发送方校验、`workspace.add`）都是真的。验收期间窗口有时被别的窗口挡住（`visibilityState: hidden`，不出帧），驱动脚本每次轮询前截一小块图强制出一帧，与界面逻辑无关。

### §4.2 第 1–7 条

| 条目 | 做法与结果 | 截图 |
|---|---|---|
| 1. `pnpm install && pnpm dev` 能启动 Host 与桌面应用 | 窗口打开，左栏底部“Host 已连接”，全新数据目录显示三步引导；主进程日志 `host owned {pid, startedAt}` | `m5-1-dev-started.png` |
| 2. 添加本地文件夹作为工作区、配置 Provider | 设置 → 模型 Provider →“其他 OpenAI 兼容服务”，填本地服务地址、模型 `wevir-mock` 与 Key，保存后自动测试“连接成功”；设置 → 工作区 →“添加文件夹”，“已添加工作区“quarterly-report””。DeepSeek 官方与真实 OpenAI 兼容地址需要 Key，本机未测 | `m5-2-provider-form.png`、`m5-2-provider-saved.png`、`m5-2-workspace-added.png` |
| 3. 新建会话、发送提示，看到流式输出和工具调用 | 引导第 3 步进草稿页，发送后跳到会话页；`read` → `glob` → `read` 聚合成“读取 2 个文件、搜索 1 次”，表格逐行出现时截图（状态“运行中 · 1 秒”、发送键变“停止”），回合结束后代码块高亮 | `m5-3-streaming.png`、`m5-3-done.png` |
| 4. 权限请求时出现审批卡片，允许 / 拒绝正确传回 | `[demo:B]`：沙箱先拒绝，模型带 `sandbox_permissions` 重试时输入框上方出现审批卡片（目标、所需权限、理由、内容预览），左栏标“待审批”；点“允许一次”，文件写入。`[demo:C]` 点“拒绝”，工具显示“被拒绝”，文件没有写入（目录里只有 allowed 与后面 CLI 批准的两份） | `m5-4-approval.png`、`m5-4-allowed.png`、`m5-4-denied.png` |
| 5. 运行中可以取消 | `[demo:D]` 输出到第 6 段时点“停止”，“本轮已取消 · 2.2 秒”，已生成的部分保留，回到空闲 | `m5-5-before-cancel.png`、`m5-5-cancelled.png` |
| 6. 完全退出再打开，会话列表与完整历史都在，能在原会话上继续 | 关窗口退出：主进程日志“closing the ownership pipe → owned host exited”，Host 进程不在、`run/` 为空。再 `pnpm dev`：拉起新 Host，**直接回到上次打开的会话**（T5.5 第 1 条，没有经过首页），会话区的文字、左栏与退出前逐字相同（1632 字符比对）。追问后显示“引擎会话已恢复（dsh 0.2.1-alpha.2）”，模型回答“上下文里有 6 条你的消息”，即 dsh 恢复了之前的对话 | `m5-6-reopened.png`、`m5-6-continued.png` |
| 7. `wevir session attach <id>` 与桌面看到同一事件流，在 CLI 中审批，桌面同步 | 伪终端里运行 `wevir session attach`：从头回放全部历史（含桌面发的消息、由桌面做的允许 / 拒绝、取消、“引擎会话已恢复”），“以上为历史，以下为实时”。桌面发 `[demo:E]`，两边同时出现审批；在 CLI 输入 `1`（允许一次），CLI 显示“本终端已处理：允许一次”，桌面的卡片收起并提示“已由本机的命令行处理：允许一次”，工具转成功、回合结束。CLI 是并行进行中的 T4.2（`apps/cli`，尚未提交）构建出的 `dist/main.js` | `m5-7-approval-both.png`、`m5-7-resolved-by-cli.png`、`m5-7-after-cli-approval.png`、`m5-7-cli-attach.txt`（CLI 屏幕记录，去掉了控制序列） |

### T5.5 的四项

| 场景 | 做法与结果 | 截图 |
|---|---|---|
| 拥有的 Host 在流式输出中途被 SIGKILL | 顶部“Host 意外退出，正在重新启动（第 1/3 次）…”，左栏底部“Host 重新启动中（第 1/3 次）”；主进程日志：`owned host exited unexpectedly {signal: SIGKILL}` → `restarting host {attempt: 1}` → `the previous host has exited; launching a new one {pid: <旧 pid>}`（host.json 还记着旧进程，确认它已退出才拉起）→ `host owned {pid: <新 pid>}`，约 1 s 后“已重新连接 Host。”。新 Host 的启动对账把被打断的回合记为“本轮被中断”，中断前已经显示的第 1–5 段保留（本任务调整了投影规则，见下）。刷新页面从头回放后，会话区文字与重连后的完全相同 | `t5.5-1-host-crashed-restarting.png`、`t5.5-2-reconnected.png` |
| 桌面断线期间别的客户端产生事件 | 暂停渲染进程（DevTools `Debugger.pause`）→ `wevir host stop` → `wevir host start`（换了端口与令牌）→ 另一个客户端（CLI 身份）在同一会话发一条 `[demo:A]` 并跑完（seq 560 → 613，53 条事件）→ 恢复渲染进程。顶部出现断线提示，约 1.1 s 后补齐：那条消息只出现一次、回合完整，再刷新页面从头回放，会话区文字与补齐后的逐字相同。（只暂停渲染进程而不重启 Host 时连接不会断：Chromium 的网络栈照常回应 WebSocket 心跳，事件只是缓冲，不算断线用例） | `t5.5-6-caught-up-after-disconnect.png` |
| 附着的 Host（`wevir host start` 启动） | 桌面端附着，设置 → 关于的“Host 进程”显示“外部启动，已附着（pid …）”。`wevir host stop` 后顶部“Host 已停止，等待它重新运行…”，说明这个 Host 不是桌面端启动的、不会替它启动；等了 5 s，主进程没有拉起任何 Host（日志里没有 `launching host`）。`wevir host start` 后自动附着到新进程并重连，会话区文字与停止前相同。退出桌面端后这个 Host 仍在运行 | `t5.5-3-attached-about.png`、`t5.5-4-external-host-stopped.png`、`t5.5-5-external-host-back.png` |
| 重新拉起 3 次都失败 | 把 `wevir.db` 设为不可读后 SIGKILL 拥有的 Host：顶部依次显示第 1/3、2/3、3/3 次，随后变为红色“Host 无法启动：Host 意外退出（信号 SIGKILL），重新拉起 3 次都没有成功：Host 启动失败（退出码 1）：wevir-host: 启动失败：unable to open database file”，下面是日志路径与“复制日志路径”（经主进程写入剪贴板，内容就是 `…/logs/host.log`），右侧“重试”；左栏底部“Host 无法启动”。恢复文件权限后点“重试”：拉起新 Host，“已重新连接 Host。” | `t5.5-7-restarting-2-of-3.png`、`t5.5-8-host-failed.png`、`t5.5-9-retried.png` |
| 会话出错 | 杀掉 Host 的 dsh 子进程：输入框上方“会话出错了”，写明“引擎退出：engine exited with signal SIGKILL”与提示，按钮“恢复会话”；点它后显示“引擎会话已恢复”、回到空闲 | `t5.5-10-session-error.png`、`t5.5-11-session-resumed.png` |
| 会话只读 | 再杀一次 dsh，并把这个会话在 `DSH_HOME` 里的会话日志移走，点“恢复会话”：转为“会话只读，不能继续对话”，原因“引擎找不到这个会话（引擎数据目录可能被清理过）”与引擎原文，按钮“基于历史新建会话”“再试一次恢复”，输入框禁用。把会话日志放回去后点“再试一次恢复”能解除只读（之后又移走一次做下一步） | `t5.5-12-session-read-only.png` |
| 基于历史新建会话 | 点“基于历史新建会话”：进同一工作区的新会话草稿，模型选的是原会话的 Provider，输入框里是整理好的对话记录（用户消息、助手正文、用到的工具），光标在末尾的“接下来：”之后，上方提示“已把会话“…”的对话记录放进输入框，可以先修改再发送”；补一句后发送，建出新会话并正常回复，左栏出现这个会话 | `t5.5-13-draft-from-history.png`、`t5.5-14-new-session-from-history.png` |

验收中发现并在本任务里改掉的：

- **Host 崩溃后已经显示的输出会消失。** 投影原来在回合结束时一律丢掉没被已提交消息替换的增量（domain-model §6.3 规则 4）；回合被中断（Host 非正常退出、引擎不可用）时已提交消息不会再来，这条规则就把已经显示的文字删掉了。改为 `interrupted` 的回合保留非空白的增量（`packages/client-sdk/src/projection.ts`，规则 4 同步修改）。
- 左栏底部的连接状态与顶部提示不一致（Host 已放弃时仍显示“重连中（第 4 次）”），改为同样先看 Host 进程的状态。
- “恢复会话”失败导致会话转为只读时，只读说明下面又重复了一遍同样的引擎原文，改为转只读时清掉失败提示。

## T6.1 开发文档：从全新克隆跑起 pnpm dev（2026-10-14）

按 [docs/development.md](../../development.md) 从零走一遍，同时验证 §7 的大陆网络配置。

环境：macOS 26（Apple Silicon）。干净环境用 `env -i` 构造：`HOME`、`TMPDIR` 是全新的空目录（没有任何 npm、pnpm、Electron、git 的配置与缓存，数据目录也随之是全新的），`PATH` 只有 Node 24.21.0 与系统目录（没有 Homebrew 的 Node 与 pnpm），git 是系统自带的 2.50.1。仓库是对本机仓库 `244825d`（T6.3）的全新 `git clone`。另起一个只记录目标域名的本地 HTTP 代理，经 `HTTPS_PROXY` 确认每一步访问了哪些域名。验证在维护者本机的网络上进行。

| 步骤 | 做法 | 耗时 | 结果 |
|---|---|---|---|
| Node | 从 `npmmirror.com/mirrors/node/` 下载 24.21.0 macOS arm64 包 | 9 s | SHA-256 与 nodejs.org 的 `SHASUMS256.txt` 一致 |
| pnpm | `npm install -g pnpm@12.6.0 --registry=https://registry.npmmirror.com` | 9 s | 只访问 `registry.npmmirror.com`、`cdn.npmmirror.com` |
| 克隆 | `git clone` | < 1 s | 本地克隆 |
| registry | `pnpm config set registry https://registry.npmmirror.com --location=global` | — | 写进 `~/Library/Preferences/pnpm/auth.ini`；`pnpm config delete … --location=global` 能改回 |
| 安装 | `pnpm install` | 24 s | 137 个连接全部是 npmmirror 的两个域名；5 个构建脚本照 `allowBuilds` 运行，node-pty、koffi 用预编译文件，没有源码编译；之后 `git status` 干净（lockfile 未变） |
| 第一次 `pnpm dev` | `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm dev` | 失败 | 问题 1、2，修好后重来 |
| 第一次 `pnpm dev`（修复后） | 同上 | 26 s 显示“Host 已连接” | Electron 44.7.0（129 MB）从 npmmirror 下载 19 s，按 `checksums.json` 校验通过；只访问 `npmmirror.com`、`cdn.npmmirror.com`；全新数据目录显示三步引导（`t6.1-fresh-clone-dev.png`） |
| 关窗口 | 经 DevTools 协议 `Browser.close` | — | 主进程日志 “closing the ownership pipe → owned host exited”，`run/` 为空 |
| 第二次 `pnpm dev` | 不设镜像变量 | 4 s | Electron 已安装，`install-electron` 立即退出 |
| 模型服务 | 经这个 Host 用无效 Key 登记 6 个 Provider 并 `provider.test`，测完删除 | — | DeepSeek（官方类型、OpenAI 兼容）、通义千问、Kimi、智谱：都是 `auth`（HTTP 401）；本机 Ollama 没装，未验证 |
| 上游参考仓库 | `WEVIR_GITHUB_MIRROR=https://ghfast.top/https://github.com bash scripts/upstream-sync.sh`；删掉 `upstream/` 后用 `https://gh-proxy.com/https://github.com` 再来一次 | 23 s、17 s | 三个仓库的 `HEAD` 都等于 lock 里的 SHA；两次分别只访问 `ghfast.top`、`gh-proxy.com`。同一天 `kkgithub.com`、`bgithub.xyz`、`githubfast.com` 不可用，`gitclone.com` 的分支头落后 |
| echo 离线开发 | `pnpm dev:host`；另一个终端 `WEVIR_HOME="$PWD/.wevir-dev" pnpm dev` | — | 桌面端日志 `host attached`；发 `think tool 你好`，会话里出现工具卡片、思考过程与 `Echo: think tool 你好`（`t6.1-echo-offline.png`）；关窗口后 echo Host 仍在，Ctrl-C 后 `run/` 为空 |
| 检查 | `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test` | 2 s、2 s、3 s、14 s | 前三项通过；测试 988 通过、9 跳过、3 失败（问题 4、5） |

遇到的问题：

1. **`Failed to resolve entry for package "@wevir/client-sdk"`，`pnpm dev` 构建主进程时失败。** 主进程按 SSR 构建，对它生效的是 `ssr.resolve.conditions`，`electron.vite.config.ts` 写在顶层的 `resolve.conditions: ['@wevir/source']` 对它不起作用（Vite 文档 `ssr.resolve.conditions`），主进程一直打包的是各工作区包的 `dist/`。dev 脚本只构建 `@wevir/host` 及其依赖，全新克隆里 client-sdk 没有 `dist/` 就失败；已有的 checkout 不报错，但主进程用的是上次构建留下的 client-sdk。改为 `ssr: { resolve: { conditions: ['@wevir/source', ...defaultServerConditions] } }`，主进程改为打包源码（`out/main/index.js` 290 kB）。
2. **`Error: Electron uninstall`。** electron-vite 5 找 Electron 时只看 `path.txt`，没有就直接报错，不会触发 Electron 44 自带的懒下载；`.npmrc` 原注释“第一次运行时下载”不对。桌面端的 dev 脚本在 `electron-vite dev` 之前加 `install-electron`：没装就按 `ELECTRON_MIRROR` 下载并校验，装好了立即退出。

   这两个问题在开发机上都被已有的状态掩盖（client-sdk 构建过、Electron 手动装过），Gate M5 §4.2 第 1 条当时是在这样的 checkout 上通过的。
3. **设了 `NODE_USE_ENV_PROXY=1` 与 `HTTPS_PROXY` 时，连本机的连接也走代理。** 验证时为了记录 Electron 的下载域名设了这两个变量，它们一路继承给了桌面主进程与 Host：代理日志里有一条到 Host 端口（127.0.0.1）的连接，`provider.test` 到本机 Ollama 也经过了代理，后者在测试代理上变成了 20 s 超时。写进开发指南的常见问题：同时设 `NO_PROXY=localhost,127.0.0.1`。
4. **审批相关的真实 dsh 测试在 `/tmp` 下的克隆里失败**（`dsh-adapter.approval.integration` 的 allow / deny，`dsh-adapter.contract.integration` 整个文件）。临时克隆在 `/private/tmp` 下，审批用例的写入目标 `.test-outside/` 也就在 dsh 不需审批即可写的系统临时目录里，测试按设计直接报错说明原因。在不在临时目录的主仓库里复跑这两组：38 通过、3 跳过（真实模型，没有 Key）。写进开发指南 §6.3。
5. **`host-process.dsh.integration` 的“重启 Host → 追问”偶发失败**：重启前取历史时最后一条 `session.state_changed` 还没到。与本任务无关，并行进行的 T6.2 已在 `4ca8e03` 里修好（按快照的 `lastSeq` 等最后一条事件到了再取历史）。

改动：`apps/desktop/electron.vite.config.ts`、`apps/desktop/package.json` 的 `dev` 脚本（问题 1、2），`.npmrc` 的 Electron 注释。修复后的全新克隆即上表“第一次 `pnpm dev`（修复后）”一行。

## T6.4 §4.2 九条复验（2026-10-14）

环境：仓库根目录 `pnpm install`（Already up to date）、`pnpm build` 后 `pnpm dev`（开发模式），`WEVIR_HOME` 指向全新的临时数据目录，桌面端自己拉起 `wevir-host --adapter dsh`（真实 dsh 0.2.1-alpha.2，stream-tap 旁路开启）。工作树里有并行进行、尚未提交的 T4.2（`apps/cli`），第 7 条用的就是它。本机没有模型 Key，Provider 是本地脚本化的 OpenAI 兼容服务（`@wevir/adapter-dsh/testing` 的 `startMockModel`），按提示里的 `[t64:X]` 决定回复：A 读 README、glob 后流式输出表格与代码块，B / C / E 写工作区外的文件（先被沙箱拒绝，带 `sandbox_permissions` 重试时请求审批），D 长回答，CSV 见第 8 条，其他提示回答“上下文里有几条你的消息”。审批用例写到 `packages/adapter-dsh/.test-outside/t64/`（工作区外、不在系统临时目录），用完删掉。工作区 `quarterly-report` 里有 `README.md` 与 `data/` 下三个 CSV。操作经 Chrome DevTools 协议（`WEVIR_DESKTOP_DEBUG_PORT=9361`）发点击、文字输入与按键，系统文件夹选择器照 T5.4 的做法经主进程 inspector（`pnpm dev --inspect 9362`）换成返回固定文件夹；截图 1 倍像素密度、系统浅色。

| 条目 | 结果 | 做法与观察 | 截图 |
|---|---|---|---|
| 1. `pnpm install && pnpm dev` 启动 Host 与桌面应用 | 通过 | 窗口打开，左栏底部“Host 已连接”，全新数据目录显示三步引导；主进程日志 `launching host` → `host owned {pid, startedAt}`，协议 0.3.0 | `t6.4-1-dev-started.png` |
| 2. 添加工作区、配置 Provider | 通过（mock Provider） | 引导“去配置”→“添加 Provider”→“其他 OpenAI 兼容服务”，填显示名称、ID、地址、模型与 Key，保存后自动测试“连接成功”，卡片显示“Key 已设置”；设置 → 工作区 →“添加文件夹”，“已添加工作区“quarterly-report””。DeepSeek 官方与真实的 OpenAI 兼容地址需要 Key，本机未测 | `t6.4-2-provider-form.png`、`t6.4-2-provider-saved.png`、`t6.4-2-workspace-added.png` |
| 3. 流式输出与工具调用过程 | 通过 | 首页“新建会话”进草稿页，Enter 发送；`read` → `glob` 聚合为“读取 1 个文件、搜索 1 次”，表格只出现第一行时截图（“运行中 · 0.2 秒”、发送键变“停止”）；回合结束后代码块高亮、“本轮已完成 · 1.4 秒” | `t6.4-3-streaming.png`、`t6.4-3-done.png` |
| 4. 审批卡片，允许 / 拒绝正确传回 | 通过 | `[t64:B]`：第一次写被沙箱拒绝，重试时输入框上方出现审批卡片（目标、“完全访问，不受工作区限制”、Agent 的理由、内容预览），左栏标“待审批”；点“允许一次”，`allowed.md` 写入、内容 `t64-B`。`[t64:C]` 点“拒绝”，工具显示“被拒绝”与 dsh 原文，目录里没有 `denied.md` | `t6.4-4-approval.png`、`t6.4-4-allowed.png`、`t6.4-4-denied.png` |
| 5. 运行中取消 | 通过 | `[t64:D]` 输出到第 6 段时点“停止”，“本轮已取消 · 2 秒”，已生成的 7 段保留，回到空闲 | `t6.4-5-before-cancel.png`、`t6.4-5-cancelled.png` |
| 6. 完全退出再打开，列表与历史都在，能继续 | 通过 | DevTools `Browser.close` 退出：主进程日志 “closing the ownership pipe → owned host exited”，没有 Host 进程，`run/` 为空。再 `pnpm dev`：拉起新 Host，直接回到上次的会话；URL、会话区文字（2300 字节）与左栏文字和退出前逐字节相同。追问后显示“引擎会话已恢复（dsh 0.2.1-alpha.2）”，模型回答“上下文里有 5 条你的消息”，即 dsh 恢复了之前的 4 轮对话 | `t6.4-6-reopened.png`、`t6.4-6-continued.png` |
| 7. CLI attach 同一事件流，CLI 审批、桌面同步 | 通过（未提交的 T4.2 CLI） | `expect` 起伪终端运行 `wevir session attach <id>`：从头回放全部历史（含桌面的允许 / 拒绝、取消、“引擎会话已恢复”），“以上为历史，以下为实时”。桌面发 `[t64:E]`，两边同时出现审批；CLI 输入 `1`，CLI 显示“本终端已处理：允许一次”，桌面卡片收起并提示“已由本机的命令行处理：允许一次”，工具转成功、`by-cli.md` 写入 | `t6.4-7-approval-both.png`、`t6.4-7-resolved-by-cli.png`、`t6.4-7-cli-attach.txt`（CLI 屏幕，去掉了控制序列，临时目录写作 `<scratch>`） |
| 8. 临时工作区里的真实多步骤文件任务 | 部分通过：真实 dsh 通过，真实模型未跑 | 新会话发“读取 data 目录下的所有 CSV，按文件汇总行数和金额，再算销售减退款的净额，写成 summary.md”。dsh 依次执行 `glob` → 3 次 `read` → `write`，脚本化的模型只根据 dsh 读回的内容计算；`summary.md` 的三行合计 445.75、550.00、55.50 与净额 940.25 和手算一致。**真实模型下的同一任务没有执行**（本机没有 Key），与 Gate M3 第 3 层、Gate M4 是同一个缺口 | `t6.4-8-csv-summary.png` |
| 9. CI 在 macOS 与 Windows 上跑通 lint、typecheck、test | 通过（截至 `4ca8e03`） | `main` 上 run 38475778589（T6.2 推送）四个 job 全部成功：macOS / Windows × Node 24（`.node-version`）/ 22.19。HEAD `31a91ea`（T6.1）尚未推送，CI 没跑过；本地对当前工作树（含未提交的 `apps/cli`）`pnpm lint`、`pnpm typecheck` 通过，`pnpm vitest run --maxWorkers=2` 1038 通过、9 跳过（真实模型层，没有 Key），46 s | — |

验收中看到、本任务不改的（记入复盘与 Phase 1 计划）：

- 写类工具卡片的结果行显示 dsh 的原始包装 `<path>…</path>`（`t6.4-8-csv-summary.png`），读写工具的结果应按 dsh 的格式解析成路径与摘要。
- 审批之前那次被沙箱拒绝的写入显示为红色“失败”的工具卡片，带 dsh 的英文原文（`t6.4-7-approval-both.png`）；用户看到的是“先失败、再请求审批”，应与随后的审批合并展示。
