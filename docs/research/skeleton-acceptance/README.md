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
