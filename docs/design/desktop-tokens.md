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
| `--switch-thumb` | `bg-switch-thumb` | 分段切换的滑块（输入框里的“插话 \| 排队”，U3 的 liquid-gooey 液面颜色；U4 起设置 → 外观的主题切换），轨道是 `--muted` | `#fbfaf7` | `#36383e` |
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
| `--overlay` | `bg-overlay` | 对话框与浮层的遮罩 | 正文色 25% | 侧栏色 60% |

静器没有彩色的强调色：主按钮、选中项、链接都是墨色，彩色只表示状态。状态色每种只有一档，文字、图标、圆点、描边与 `bg-warning/10` 这类淡底都用它（T5.2 的 `*-solid` 实色档已去掉）。

U3 起子会话头像是 bot-avatars 的小机器人（canvas 绘制），颜色要字面值，浅色、深色各六种写在 `session/avatar.ts`（方向稿 A 的头像配色）；thinking orb 的墨色（浅色 `#2b2a26`、深色 `#e9e8e2`）写在 `fx/orb.tsx`，金属与光束的颜色是库的 gold、mono 预设。原来的 `--avatar-1` … `--avatar-7` 与它们的原始色已删掉。

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
- **标题宋体的子集**：文字在 `apps/desktop/scripts/build-fonts.py` 的 `DISPLAY_TEXT`，是方向稿 A 首页标题的固定部分“今天在 … 里做什么？”（工作区名用界面字体）；U4 的首页标题就用这两段（`zh-CN.ts` 的 `home.title.before` / `home.title.after`），子集没有改。改这两条文案要同时改 `DISPLAY_TEXT` 并重新生成；文案里出现子集外的字会回落到系统宋体，样子不一致。首次使用的引导标题“开始使用 Wevir”不在子集里，用界面字体。
- **重新生成**：`build-fonts.py` 从固定版本的来源（发布包或固定提交，按 sha256 校验）生成全部 woff2 与 `apps/desktop/licenses/fonts/*/OFL.txt`，输出可复现；用法写在脚本开头（可选工具 `fonttools==4.60.1`、`brotli==1.1.0`，与图标的 `outline-wordmark.py` 同一套）。Mona Sans 与 JetBrains Mono 只把 TTF 转成 WOFF2，不做别的改动：Mona Sans 的版权行保留了字体名 “Mona”，按 OFL 第 3 条，改动过的版本不能再叫这个名字，所以不能子集化。Noto Serif SC 的版权行没有保留字体名，可以子集化。
- **构建**：Vite 默认把小于 4 KiB 的资源内联成 `data:` URI，宋体子集会被 CSP 拦下；`electron.vite.config.ts` 让 `.woff2` 总是单独成文件。
- 来源、版本与许可证见 `assets/fonts/SOURCE.md` 与仓库根目录的 [`NOTICE`](../../NOTICE)。

## 5. 品牌

- `--brand`：浅色金、深色铂金，只用于品牌主标与品牌时刻（`assets/icons/README.md`）。界面里的主标组件是 `components/brand-mark.tsx`（几何取自 `assets/icons/source/mark.svg`，`text-brand`）；左栏不放主标与产品名，界面上只有首页品牌行（U4）用它。
- 字标与线性功能图标（lucide）用文字色，不用品牌色；首页品牌行的字标例外：是金属字（`fx/metal.tsx` 的 `MetalWordmark`，金属预设 gold，字色浅色金棕、深色铂金），算品牌时刻（U4）。
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

方向稿 `src/styles.css` 的 `.app`（A 的浅色）与 `.app[data-dir='a'][data-mode='dark']` 里的变量与这里的对应：`--bg` → `--background`、`--side` → `--sidebar`、`--surface` → `--card` / `--popover`、`--surface-2` → `--muted` / `--accent` / `--secondary`、`--line` → `--border`、`--line-2` → `--border-strong`、`--ink` → `--foreground`、`--ink-2` → `--soft-foreground`、`--muted` → `--muted-foreground`、`--accent` / `--accent-ink` → `--primary` / `--primary-foreground`、`--brand` → `--brand`、`--run` / `--await` / `--ok` / `--bad` → `--running` / `--warning` / `--success` / `--destructive`、`--code-bg` → `--code-background`、`--shadow` → `--elevation`、`--radius` / `--radius-sm` → `--radius-card` / `--radius-control`、`--font-ui` / `--font-display` / `--font-mono` → `--font-ui` / `--font-display` / `--font-code`。方向稿里只有 B、C 用到的变量（`--glass`、`--grid`、`--f1`…）与加号按钮的专用色没有搬过来，U4 用到时再加；开关的 `--switch-thumb` U3 搬了（A 的浅色 `#ffffff`、深色 `#3a3c43`，取了最接近的原始色），`--switch-track` 用 `--muted`。

## 10. 首页与设置页（U4）

- **首页**（`routes/home-route.tsx`，方向稿的 `.home-col`）：一列最宽 700px（`max-w-175`）、水平居中、内容左对齐，上方留白 `clamp(2.5rem, 14vh, 8.75rem)`，块之间 22px；品牌行是 `BrandMark`（`text-brand`）加 `fx/metal.tsx` 的 `MetalWordmark`；标题 `font-display`、500、`clamp(1.75rem, 4vw, 2.5rem)`，工作区名是界面字体 600、0.86em、强分隔线色的虚线下划线；大输入框是 `Composer variant="home"`（焦点只用 border-beam 的 focus 预设表示，不换边框色）；“接着做”每行底部一条分隔线，7px 状态点（运行中 `--running`、待审批 `--warning`、出错 `--destructive`、空闲 `--border-strong`），右侧相对时间用说明文字色。顶栏在首页不画分隔线。
- **设置页**（`routes/settings-route.tsx`、`settings/settings-ui.tsx`）：标签列表是侧栏色，选中的一行与左栏的当前会话一样（表面色加一圈分隔线）；内容一列最宽 720px（`max-w-180`），标题 20px，按节排（`SettingsSection`：14px 半粗的节标题、说明文字、右侧操作），节与节之间一条分隔线；列表在表面色卡片里（`LIST_CARD`），行之间是分隔线；空列表是强分隔线色的虚线框。
- **表单控件**：输入框、多行输入框、原生下拉框（`settings-ui.tsx` 的 `SELECT`）与 outline 按钮在浅色、深色都是表面色底（`bg-card`）、强分隔线的边框（`border-input`），焦点环是运行色；禁用时是次表面色。shadcn 原语里 `dark:bg-input/30` 这类按主题另算的底色已去掉（文件头写明了改动）。单选是墨色圆环，分段切换的选中段是 `bg-switch-thumb` 加一圈分隔线。

## 11. 窗口框架与侧栏（U5）

- 侧栏的行（`layout/sidebar.tsx`）：悬停 `bg-sidebar-accent/70`，当前项 `bg-sidebar-accent`（表面色），颜色过渡 150 ms，不加描边（照 Codex 桌面端）。项目名用正文色，会话标题用次正文色，当前会话与未读的用正文色。
- 窗口按钮（后退、前进、侧栏开关）是 `icon-sm` 的 ghost 按钮，图标用说明文字色；`--window-controls-width` = 88 px。
- 布局过渡：侧栏、窗格区的开合与它们的浮层都是 260 ms、`cubic-bezier(0.32, 0.72, 0, 1)`（`index.css` 的 `.layout-transition`，[desktop-layout.md](../architecture/desktop-layout.md) §11）。减弱动效时照全局规则缩成瞬时。
- “创建项目”对话框：卡片圆角、内边距 20 px；名称框 40 px 高、左边是文件夹图标；没选文件夹时是虚线框加一个胶囊形的“添加”按钮，选了之后是一行路径（等宽、截掉开头）与“更换”、移除。

## 12. 首次引导（U6）

- 整窗、不带侧栏（`onboarding/welcome-route.tsx`）：一列最宽 704 px、左对齐，上方留白约 9vh；顶上是两段 2 px 的进度条（当前与做完的是正文色，其余是分隔线色）与“1 · 模型服务 / 2 · 开始”，然后是品牌主标、28 px 半粗的标题与一行说明文字色的副标题。
- 服务格：一行五格（窄窗口三格），120 px 高、卡片圆角、表面色底；标志 32 px，名字最多两行。悬停上浮 2 px 加阴影、标志放大 5%，按下缩到 98%；选中是正文色 70% 的描边加一圈同色细环，右上角一个正文色的勾。还没接上的服务去掉底色、标志 40% 不透明，名字下面一行“即将支持”。
- 表单从上方淡入滑入（300 ms），失败的结论是 `destructive/8` 的淡底；“下一步”在验证时换成转圈与“正在验证”，测试没通过时变成“仍然继续”。
- 标志：单色的（OpenAI、Anthropic、xAI、Ollama）经 CSS 遮罩画成文字色，彩色的原样显示（`components/provider-logo.tsx`）。
