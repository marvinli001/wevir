# 随应用打包的字体

由 `apps/desktop/scripts/build-fonts.py` 生成，不要手改；用法、子集文字与来源的 sha256 写在脚本里。用途与字体栈见 [docs/design/desktop-tokens.md](../../../../../../docs/design/desktop-tokens.md) §4，许可证全文在 `apps/desktop/licenses/fonts/`，署名在仓库根目录的 `NOTICE` 第 7 节。

| 文件 | 来源 | 版本 | 处理 | 许可证与版权 |
|---|---|---|---|---|
| `mona-sans.woff2`、`mona-sans-italic.woff2` | [github/mona-sans](https://github.com/github/mona-sans) 发布包 `mona-sans-variable-v2.0.27.zip` 的 `fonts/variable/MonaSansVF[opsz,wght].ttf`、`MonaSansVF-Italic[opsz,wght].ttf` | v2.0.27 | TTF 转 WOFF2，字形与名称不变 | SIL OFL 1.1，Copyright 2022 The Mona Sans Project Authors，保留字体名 “Mona” |
| `jetbrains-mono.woff2`、`jetbrains-mono-italic.woff2` | [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono) 发布包 `JetBrainsMono-2.304.zip` 的 `fonts/variable/JetBrainsMono[wght].ttf`、`JetBrainsMono-Italic[wght].ttf` | 2.304 | TTF 转 WOFF2，字形与名称不变 | SIL OFL 1.1，Copyright 2020 The JetBrains Mono Project Authors |
| `noto-serif-sc-display.woff2` | [notofonts/noto-cjk](https://github.com/notofonts/noto-cjk) 标签 `Serif2.003`（提交 `9b0f1436e455d902de067a2501422e5dc71ad16b`）的 `Serif/SubsetOTF/SC/NotoSerifSC-Medium.otf` | 2.003 | 按 `DISPLAY_TEXT`（首页标题各句式的固定部分加空格）子集化后转 WOFF2，保留全部名称记录 | SIL OFL 1.1，© 2017-2024 Adobe，没有保留字体名 |
