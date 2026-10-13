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
