# Wevir 图标资源

已确认的「共核 / Open Host」：方块、斜切接口与内侧台阶代表围绕同一本地核心工作的客户端。浅色使用香槟金主标及灰调象牙白底色 **#F4F3ED**；深色使用铂金白主标与石墨黑底色 **#101114**。浅色图标底板保留象牙白，Wevir 字标与线性功能图标保留深色；金色只用于品牌主标。

[完整预览](preview/index.html) · [总览 PNG](preview/overview.png) · [导出清单与 SHA-256](manifest.json)

## 文件与规格

| 路径（相对于本目录） | 交付 |
| --- | --- |
| `source/` | 32 单位主标几何、材质配色、八个线性图标路径、已转曲字标及字体来源 |
| `source/Wevir.icon` | Icon Composer 工程，iOS / iPadOS / macOS 26 起的 Liquid Glass 应用图标（见下文「Icon Composer 工程」） |
| `svg/` | 每张位图对应的独立 SVG；材质、渐变、线条均保留为矢量，未嵌入位图或依赖系统字体 |
| `exports/brand/` | 浅深色主标（16–1024px）、转曲 Wevir 字标、横向/上下组合标识、黑白单色版本 |
| `exports/macos/{light,dark}/` | Big Sur 风格圆角矩形应用图标、ICNS、iconset、AppIcon.appiconset；16/32/128/256/512pt，各 @1x/@2x |
| `exports/macos/menubar/` | 16/18pt 的黑色透明模板，@1x/@2x 与 Xcode imageset；`previews/` 提供浅色/深色显示效果 |
| `exports/windows/{light,dark}/` | 应用 ICO（含 16/20/24/30/32/36/40/48/60/64/72/80/96/128/256px）、托盘 ICO（16/20/24/32/40/48/64px）与单独 PNG；另有 AppList targetsize 资源 |
| `exports/ios/Assets.xcassets/` | 可导入的单尺寸 AppIcon：默认、深色、tinted 各 1024px；深色为透明前景，tinted 为中性灰度 |
| `exports/ios/{light,dark}/` | 完整底色的 1024 主图、浅深灰度 tinted 补充稿、20–180px 的 iPhone/iPad 尺寸位图 |
| `exports/apple-layers/{light,dark}/` | 给当前 Icon Composer 使用的无预烘焙高光前景和完整方形背景；SVG 与 PNG 分层；另有与 macOS 应用图标同款的金属主标 `foreground-metal` 和渐变底板 `background-tile`，`source/Wevir.icon` 用的是这两组 |
| `exports/android/res/` | v26 双层、v33 含单色层的 adaptive-icon XML；108dp 前景/背景的 mdpi–xxxhdpi 位图；默认/夜间资源、legacy launcher 图标与单色 VectorDrawable |
| `exports/android/{light,dark}/` | 单色主题图标、512px Play 主图、三种系统遮罩预览；遮罩没有写入前景/背景源层 |
| `exports/linux/` | 浅深色 hicolor 16–1024px、scalable SVG |
| `exports/web/` | favicon SVG（自动浅深色）、浅深色 ICO、Apple Touch 图标、192/512px PWA/maskable 图标及 manifest 片段 |
| `exports/ui/` | 新建会话、工作区、会话、模型、文件、终端、扩展、设置；currentColor SVG、SVG sprite、浅深色 16/18/20/24/32px @1x/@2x |
| `preview/` | 可离线打开的预览页、总览 SVG/PNG |
| `release/` | `pnpm icons:pack` 生成的 ZIP 和 SHA256SUMS（gitignore） |

全部 PNG 直接从 SVG 渲染；原生资源目录中需要复用的 PNG 是同一导出内容的复制。ICNS、ICO 封装这些已导出的 PNG。`manifest.json` 记录独立渲染的 SVG/PNG 对及尺寸、透明度、SHA-256。

字标使用 Mona Sans Bold 的轮廓路径，使用时无需安装字体。源字体、固定提交与 OFL 全文在 `source/fonts/`；组合标识的 SVG 也带来源注释。主标和八个功能图标是 Wevir 自有设计。

## 小尺寸与主题

- 主标在 16/18px 下去掉金属反光，32px 减少材质细节，大尺寸保留亮面和切边。macOS 应用图标的 Retina 表示按逻辑点数选细节；菜单栏模板只保留黑色与透明度。
- 功能图标为 24 单位网格、2 单位线宽，统一软方角与端点。品牌主标保留实心结构以便区分；功能图标不添加金属纹理。`current-color/` 与 sprite 由调用方设置 `color`。
- 桌面端界面里的主标组件（`apps/desktop/src/renderer/src/components/brand-mark.tsx`；左栏不放主标与产品名，界面上只有首页的品牌行用它）用 `source/mark.svg` 的几何、颜色取 `currentColor`，由设计变量 `--brand` 给出浅色金 `#9B7840`、深色铂金 `#DFDED8`；旁边的字标与界面里的功能图标用文字色，首页品牌行的金属字标除外（desktop-tokens.md §5）。
- macOS 正式模板始终是黑色透明图，系统负责显示深浅色；白色稿仅位于 `previews/`，不要作为正式模板使用。原生调用需设置 `isTemplate`，Electron 使用 `setTemplateImage(true)`。
- ICNS 与 ICO 本身不根据系统主题自动切换。macOS 安装包用 `source/Wevir.icon`（`apps/desktop/electron-builder.yml` 的 `mac.icon`），由 electron-builder 调 Xcode 26 起的 `actool` 编译成 `Assets.car` 并写入 `CFBundleIconName`，macOS 26 起图标由系统按系统外观画，应用没启动时也跟随；旧系统用同时生成的 ICNS。没有 Xcode 26 的机器上打包改用 `macos/light/Wevir.icns`（`apps/desktop/scripts/package.ts`），这时与开发模式一样由主进程在运行时用 `macos/{light,dark}/AppIcon.appiconset/icon_512x512@2x.png` 设程序坞图标，跟随系统外观。Windows 用 `windows/{light,dark}/Wevir.ico` 设窗口与任务栏图标，跟随系统的 Windows 模式（`apps/desktop/src/main/app-icon.ts`）。iOS / Android 还没有客户端，签名配置与安装包也未涉及。
- iOS/iPadOS 的默认主图与 tinted 主图为完整方形；系统施加圆角。Xcode 的深色槽使用透明前景，保留完整石墨底色的稿在 `ios/dark/`。两个额外 tinted 主图用于比较，资源目录中的 tinted 槽只指向一个中性灰度稿。Apple 当前推荐 Icon Composer 的分层工作流；这里同时保留按需求交付的传统资源和可导入的基础图层，系统实时材质需在项目接入时检查。
- Android 前景层保持在中心直径 66dp 的安全圆内，背景完整覆盖 108dp，不预先写入系统遮罩。`res/` 可复制进 Android 项目，Manifest 选择 `@mipmap/ic_launcher`；需要 roundIcon 时使用 `@mipmap/ic_launcher_round`。颜色随默认/`night` 资源变化，单色主题颜色由启动器控制。
- Linux hicolor 的两个主题目录择一安装，文件名都为 `wevir`。Web 两个 manifest 是资源片段；接入网站时补充网站的 `start_url`、`id` 与 `scope`。

## Icon Composer 工程

`source/Wevir.icon` 在 Icon Composer（Xcode 26 自带）里组装，不由 `icons:build` 生成。它让系统画出与 `exports/macos/` 的 ICNS 相同的图标（金属主标、渐变底板），同时在系统深色外观下换成深色版；macOS 26 再给它套上系统的圆角与边缘高光。两个图层，参数如下：

| 项 | 默认 | 深色 |
| --- | --- | --- |
| 背景 Fill（Solid） | `#F4F3ED` | `#101114` |
| 图层 `mark` | `Assets/mark-light.svg`（香槟金） | `Assets/mark-dark.svg`（铂金） |
| 图层 `tile` | `Assets/tile-light.svg`（象牙白渐变） | `Assets/tile-dark.svg`（石墨渐变） |

- `Assets/mark-{light,dark}.svg` 与 `svg/apple-layers/{light,dark}/foreground-metal.svg`、`Assets/tile-{light,dark}.svg` 与 `background-tile.svg` 逐字节相同（1024 画布；主标 560px 居中，金属渐变、拉丝纹与边线同 macOS 应用图标）。图层用 Image 的外观变体按浅深色换图，不用 Fill 覆盖；`mark` 缩放 125%，与 ICNS 里主标占底板的比例一致。背景直接用 Fill 纯色，不导入 `background.svg`。
- 两个图层都关了 Liquid Glass，两个 Group 的 Specular、Translucency、Shadow 也都关着，反光全靠烘焙的金属渐变。Tinted / Clear 外观由系统从这两个图层生成，底板是不透明的，所以 Clear 下整块偏白。
- 主标几何或配色改动后，先 `pnpm icons:build`，再把新的 `{light,dark}/foreground-metal.svg`、`background-tile.svg` 复制成 `Assets/mark-*.svg`、`Assets/tile-*.svg`，在 Icon Composer 里检查后保存。`icons:check` 会核对这四份副本、图层的外观变体与玻璃开关，以及两个背景色与 `manifest.json` 的调色板一致。
- `icon.json` 保持 Icon Composer 保存时的原样（它的写法是 `"key" : value`），所以 `biome.json` 把整个 `Wevir.icon` 排除在格式检查之外；别用 `pnpm lint:fix` 或手工改它，改参数回 Icon Composer。
- Xcode 工程把 `Wevir.icon` 加入目标、App Icon 名称填 `Wevir` 即可；`actool` 会同时输出 `Assets.car` 和给旧系统用的 ICNS / PNG。桌面端的打包由 electron-builder 用 `actool` 编译它（App Icon 名称是 `Icon`），在 Info.plist 写入 `CFBundleIconName`。

## 重建与检查

在 Wevir 仓库根目录执行（Node ≥22.19、pnpm 12.6）：

```bash
pnpm install
pnpm icons:build
pnpm icons:check
pnpm icons:pack
```

`icons:build` 使用根目录开发依赖 Sharp 0.35.5，不启动 Host、不读取密钥、不调用模型、不需要先构建产品包。`icons:check` 校验 SVG 是否为真实矢量、PNG 宽高/透明度/灰度/摘要、ICNS/ICO 帧、菜单模板颜色、iOS 槽位、Android 安全区域，以及 `Wevir.icon` 的图层与颜色；在装有 Xcode 的 macOS 上还会用 `actool` 把它分别编译成 macOS 和 iOS 资源，有警告或错误即失败，其他系统跳过这一步并在输出里注明。`icons:pack` 生成包含源文件、导出资源、预览、导出脚本和独立 package.json 的交付 ZIP；不打包 node_modules 或应用源码。

字标转曲只在字体或字样变化时需要重跑：安装可选工具 `fonttools==4.60.1` 后运行 `python3 scripts/icons/outline-wordmark.py`，再执行 `pnpm icons:build`。正常导出不需要 Python，直接使用已提交的转曲路径。

本次文件层验证还包括 Apple `actool` 编译 iOS 与两套 macOS 资源目录、`iconutil` 解码两个 ICNS，以及将交付 ZIP 解压到仓库外、独立安装依赖后重跑导出和校验。真实设备、启动器缓存、系统主题切换及应用打包后的外观属于接入验证，尚未执行。

## 规范与来源

- [Apple App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons)：主标一致性、系统裁切与当前分层工作流。
- [Apple asset catalog](https://developer.apple.com/documentation/xcode/configuring-your-app-icon)：默认/深色/tinted、灰度及透明深色前景。
- [Apple template image](https://developer.apple.com/documentation/appkit/nsimage/istemplate)：黑色与透明度模板。
- [Microsoft icon construction](https://learn.microsoft.com/en-us/windows/apps/design/iconography/app-icon-construction)：ICO 尺寸、targetsize 与主题变体。
- [Android adaptive icons](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive)：108dp 图层、66dp 安全区域及单色主题层。
- [Mona Sans 固定来源](https://github.com/github/mona-sans/tree/4bc6ba8b354c36b4fb66d32cd67b4c1f2beb0a06)：字标字体，SIL OFL-1.1。
