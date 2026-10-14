# 桌面端设计变量（静器）

> 建立：2026-10-14（U1）· 依据：维护者 2026-10-14 选定的视觉方向「A 静器」，方向稿见 [CODEX_RUNTIME_PROMPTS.md](../CODEX_RUNTIME_PROMPTS.md)「界面参考」的 `design-refs/wevir-directions/`
> 代码：`apps/desktop/src/renderer/src/styles/`。界面改造分四步：U1 设计变量与字体（本文）→ U2 消息流折叠 → U3 libraries.dev 动效 → U4 首页与设置页。

## 1. 结构

三层，界面代码只碰最后一层：

| 层 | 文件 | 内容 |
|---|---|---|
| 原始色 | `palette.css` | 有名字的颜色：象牙（浅色中性色）、石墨（深色中性色）、金与铂金、四种状态色的 deep / pale 两档、七种头像色。手写，不随主题切换，每个都要被 `tokens.css` 用到 |
| 语义变量 | `tokens.css` | 全应用唯一的一套：背景、文字、边框、主按钮、品牌、状态、代码、头像、遮罩、阴影、圆角、字体。浅色在 `:root`，深色只认 `<html data-theme="dark">`，两块定义同一组变量 |
| Tailwind 主题 | `theme.css` | `@theme inline` 把语义变量映射成工具类（`bg-background`、`text-muted-foreground`、`rounded-xl`…）。Tailwind 自带的调色板与阴影用 `initial` 清空，`bg-red-500`、`text-white`、`shadow-xl` 不生成 CSS |

另有 `fonts.css`（随应用打包的字体，§4）、`markdown.css`（助手消息的排版，只用语义变量）。

暗色只认 `data-theme`：不认 `.dark` 类，也不直接跟 `prefers-color-scheme`。外观设置的“跟随系统”由 `theme/theme.ts` 解析后写进 `data-theme`。

## 2. 颜色

| 语义变量 | Tailwind | 用途 | 浅色 | 深色 |
|---|---|---|---|---|
| `--background` | `bg-background` | 画布 | `#f4f3ed` | `#101114` |
| `--sidebar` | `bg-sidebar` | 侧栏（左栏、设置页导航、右侧浮层） | `#ecebe4` | `#0c0d10` |
| `--card`、`--popover` | `bg-card`、`bg-popover` | 表面：卡片、浮层、菜单、输入框；侧栏里选中的行（`--sidebar-accent`） | `#fbfaf7` | `#17181c` |
| `--muted`、`--accent`、`--secondary` | `bg-muted` 等 | 次表面：弱填充、悬停与选中、次要按钮 | `#efede6` | `#1d1e23` |
| `--border` | `border-border` | 分隔线 | `#dedbd1` | `#26282d` |
| `--border-strong`（`--input`） | `border-input`、`bg-border-strong` | 强分隔线：控件边框、空闲的状态点 | `#ccc8bc` | `#36383e` |
| `--foreground` | `text-foreground` | 正文 | `#1a1a17` | `#eeede8` |
| `--soft-foreground` | `text-soft-foreground` | 次正文：左栏的会话标题、代码的元信息 | `#45433d` | `#c4c3bd` |
| `--muted-foreground` | `text-muted-foreground` | 说明文字：标签、时间、快捷键提示、图标、代码注释 | `#67635a` | `#9d9e9b` |
| `--primary` / `--primary-foreground` | `bg-primary` | 主按钮（墨底，字是画布色）、选中项 | `#1a1a17` / `#f4f3ed` | `#eeede8` / `#101114` |
| `--brand` | `text-brand` | 品牌主标与品牌时刻，不用于别处（§5） | 金 `#9b7840` | 铂金 `#dfded8` |
| `--running`（`--ring`） | `text-running`、`bg-running` | 运行中、进行中的状态点；焦点环 | `#2f5f8a` | `#8db4dc` |
| `--warning` | `text-warning` | 待审批、警告 | `#94570a` | `#e3a857` |
| `--success` | `text-success` | 成功 | `#2f6b42` | `#86c597` |
| `--destructive` | `text-destructive` | 失败、删除 | `#a23b30` | `#ee8f84` |
| `--code-background` | — | 代码块底色（`markdown.css`） | `#efede6` | `#141519` |
| `--code-keyword` / `string` / `number` / `title` | — | 语法高亮：运行蓝、成功绿、待审批赭、失败红 | deep 档 | pale 档 |
| `--code-comment` / `--code-meta` | — | 注释用说明文字色，元信息用次正文色 | | |
| `--avatar-1` … `--avatar-7` | — | 子会话头像（`session/avatar.ts`）；`-soft` 是它与画布的 45% 混合 | 方向稿 A 的六种头像色加一种青 | 各自浅一档 |
| `--overlay` | `bg-overlay` | 对话框与浮层的遮罩 | 正文色 25% | 侧栏色 60% |

静器没有彩色的强调色：主按钮、选中项、链接都是墨色，彩色只表示状态。状态色每种只有一档，文字、图标、圆点、描边与 `bg-warning/10` 这类淡底都用它（T5.2 的 `*-solid` 实色档已去掉）。

T5.2 的 `--faint-foreground`（比说明文字更淡一级的提示色）已去掉，原来用它的地方改用说明文字：方向稿里时间、提示这类文字也是说明文字色，而且它对背景不到 4.5:1。

## 3. 圆角、阴影、字号

- **圆角**：`--radius-card`（12px）与 `--radius-control`（8px）。Tailwind 的阶梯由它们推导：`rounded-xs` 2、`sm` 4、`md` 6、`lg` 8、`xl` 12、`2xl` 16。卡片（审批卡片、设置里的列表卡片、窗格、对话框、浮层与菜单、消息输入框）用 `rounded-xl`，按钮、输入控件与列表项（左栏的行、菜单项、窗格标签）用 `rounded-lg`；嵌在卡片里的代码块、徽标用 `md` / `sm`。外层比内层大一阶。消息流里的执行过程不用卡片（U2：工作组与回合都是一行文字），子智能体标记与“N 个文件已更改”是 `rounded-full` 的小标签。
- **阴影**：只有一档 `--elevation`，Tailwind 的 `shadow-xs` … `shadow-lg` 都是它。卡片默认不带阴影，浮起的东西（消息输入框、浮层、菜单、审批卡片）才带。浅色 `0 1px 2px rgba(26,26,23,.05), 0 10px 30px -16px rgba(26,26,23,.18)`，深色 `0 1px 2px rgba(0,0,0,.4), 0 12px 32px -16px rgba(0,0,0,.6)`。
- **字号**：正文 `text-base` 14px / 行高 1.55；代码与控件 `text-sm` 13px；`text-xs` 12px。根字号仍是 16px，间距的 4px 网格不变。

## 4. 字体

全部随应用打包，不从网络加载（国内访问不了 Google Fonts；渲染进程的 CSP 只放行 `font-src 'self'`）。

| 变量 | 用途 | 字体 | 文件（`assets/fonts/`） |
|---|---|---|---|
| `--font-ui`（`font-sans`） | 界面与正文 | 拉丁字母 Mona Sans 2.0.27（可变字体，字重 200–900，带光学尺寸轴），中文用系统字体：PingFang SC / Hiragino Sans GB / Microsoft YaHei UI / Noto Sans CJK SC | `mona-sans.woff2` 134 KiB、`mona-sans-italic.woff2` 123 KiB |
| `--font-code`（`font-mono`） | 代码、路径、命令 | JetBrains Mono 2.304（可变字体，100–800），中文回落到系统字体 | `jetbrains-mono.woff2` 111 KiB、`jetbrains-mono-italic.woff2` 120 KiB |
| `--font-display`（`font-display`） | 标题宋体，只用在固定文案上（U4 的首页标题） | Noto Serif SC 2.003 Medium，按文案做的子集，CSS 里叫 `"Wevir Display"`；子集里没有的字回落到系统宋体 | `noto-serif-sc-display.woff2` 3.6 KiB |

- **中文正文不打包**：用系统字体（维护者 2026-10-14 定）。
- **Mona Sans 不负责中文语境的标点**：`fonts.css` 的 `unicode-range` 把“”‘’——…（U+201C/D、U+2018/9、U+2014、U+2026）排除在外，交给中文字体，免得中文句子里出现窄的西文引号与破折号。
- **标题宋体的子集**：文字在 `apps/desktop/scripts/build-fonts.py` 的 `DISPLAY_TEXT`，现在是方向稿 A 首页标题的固定部分“今天在 … 里做什么？”（工作区名用界面字体）。U4 定首页文案时改这里并重新生成；文案里出现子集外的字会回落到系统宋体，样子不一致。
- **重新生成**：`build-fonts.py` 从固定版本的来源（发布包或固定提交，按 sha256 校验）生成全部 woff2 与 `apps/desktop/licenses/fonts/*/OFL.txt`，输出可复现；用法写在脚本开头（可选工具 `fonttools==4.60.1`、`brotli==1.1.0`，与图标的 `outline-wordmark.py` 同一套）。Mona Sans 与 JetBrains Mono 只把 TTF 转成 WOFF2，不做别的改动：Mona Sans 的版权行保留了字体名 “Mona”，按 OFL 第 3 条，改动过的版本不能再叫这个名字，所以不能子集化。Noto Serif SC 的版权行没有保留字体名，可以子集化。
- **构建**：Vite 默认把小于 4 KiB 的资源内联成 `data:` URI，宋体子集会被 CSP 拦下；`electron.vite.config.ts` 让 `.woff2` 总是单独成文件。
- 来源、版本与许可证见 `assets/fonts/SOURCE.md` 与仓库根目录的 [`NOTICE`](../../NOTICE)。

## 5. 品牌

- `--brand`：浅色金、深色铂金，只用于品牌主标与品牌时刻（`assets/icons/README.md`）。左栏顶部的主标是 `components/brand-mark.tsx`（几何取自 `assets/icons/source/mark.svg`，`text-brand`）。
- 字标（左栏的 “Wevir”）与线性功能图标（lucide）用文字色，不用品牌色。
- 主标在浅色画布上约 3.4:1，够图形的 3:1，不能当文字色用。

## 6. 窗口与首帧的底色

`src/shared/theme.ts` 的 `THEME_BACKGROUND` 是两种主题的 `--background`。主进程的窗口底色用它（窗口缩放时露出的未绘制区域）；首帧前脚本 `public/theme-init.js` 在样式表生效之前按存储的主题给 `<html>` 涂上同样的底色，`theme.ts` 启动时去掉。

## 7. 校验

`styles/tokens.test.ts`（desktop 的 Vitest project）从 `palette.css` 与 `tokens.css` 读出浅色、深色两套变量：

- 正文、次正文、说明文字对所有底色（画布、侧栏、表面、次表面、代码底等）至少 4.5:1；主按钮的字、状态色（也用作文字）、语法高亮色对各自的背景至少 4.5:1；品牌色对画布、侧栏、表面至少 3:1。
- `--background` 等于 `THEME_BACKGROUND`；`shared/theme.test.ts` 核对首帧前脚本写的底色。
- `palette.css` 不随主题切换、每个原始色都被用到；`tokens.css` 的浅色块与深色块定义同一组变量；`fonts.css` 引用的字体文件都在，`assets/fonts/` 里没有多余的。

改色以后跑 `pnpm vitest run --project desktop`。淡底上的状态文字（如 `bg-warning/10` 上的 `text-warning`）没有算进去：混色要按 oklab 算，测试没有实现。

## 8. 改动的做法

- 改色：只改 `palette.css` 的原始色或 `tokens.css` 的引用，跑测试。
- 加语义变量：浅色、深色两块都写，需要工具类时在 `theme.css` 的 `@theme inline` 里加 `--color-<名字>`，在 §2 的表里登记。
- 组件里不写 `#…`、`rgb()`、写死的字体与圆角（`rounded-[4px]` 这类）；shadcn 新生成的原语若带这些，换成阶梯里的类名并在文件头写明改动。

## 9. 与方向稿的对应

方向稿 `src/styles.css` 的 `.app`（A 的浅色）与 `.app[data-dir='a'][data-mode='dark']` 里的变量与这里的对应：`--bg` → `--background`、`--side` → `--sidebar`、`--surface` → `--card` / `--popover`、`--surface-2` → `--muted` / `--accent` / `--secondary`、`--line` → `--border`、`--line-2` → `--border-strong`、`--ink` → `--foreground`、`--ink-2` → `--soft-foreground`、`--muted` → `--muted-foreground`、`--accent` / `--accent-ink` → `--primary` / `--primary-foreground`、`--brand` → `--brand`、`--run` / `--await` / `--ok` / `--bad` → `--running` / `--warning` / `--success` / `--destructive`、`--code-bg` → `--code-background`、`--shadow` → `--elevation`、`--radius` / `--radius-sm` → `--radius-card` / `--radius-control`、`--font-ui` / `--font-display` / `--font-mono` → `--font-ui` / `--font-display` / `--font-code`。方向稿里只有 B、C 用到的变量（`--glass`、`--grid`、`--f1`…）与开关、加号按钮的专用色没有搬过来，U3、U4 用到时再加。
