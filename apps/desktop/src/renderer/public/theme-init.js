// SPDX-License-Identifier: MIT
// 移植自 different-ai/openwork apps/app/index.html（第 19–32 行的内联脚本）
// 来源提交 ad22cdc2217370f28f24f0f8758016c2921e3c73
// Copyright (c) 2026-present Different AI, Inc.
// 修改：改为单独的普通脚本文件（生产 CSP 不放行内联脚本）；存储 key 换成运行时同一个 THEME_STORAGE_KEY
// （OpenWork 这里只读旧 key，候选 #17 的问题之一）；不认识的值按跟随系统处理，与 theme.ts 一致；不再写内联的
// color-scheme（由 tokens.css 按 data-theme 设置）；U1 起先涂上首帧的底色，theme.ts 启动时去掉。
//
// 首帧前设置 <html data-theme>（T5.2），暗色用户启动时不会先闪一帧亮色。index.html 在 <head> 里以普通
// （非 module）脚本同步加载它；不内联，因为生产 CSP 是 script-src 'self'，不放行内联脚本。
//
// 解析规则必须与 src/theme/theme.ts 一致，存储 key 是 src/shared/theme.ts 的 THEME_STORAGE_KEY：
// 'dark' / 'light' 照用，其他值（含没有存过）按跟随系统处理。
//
// 首帧的底色：样式表生效之前页面是透明的，露出主进程按系统深浅色设的窗口底色；存储的模式与系统不同时会先闪一下另一种
// 底色。所以这里按解析出的主题先给 <html> 涂上 tokens.css 的 --background（值同 src/shared/theme.ts 的
// THEME_BACKGROUND）。这是 CSSOM 写入，不受 CSP 的 style-src 限制；样式表加载后由 theme.ts 的 bootstrapTheme 去掉，
// 之后切换主题只看 CSS。src/shared/theme.test.ts 在 node:vm 里执行本文件核对存储 key、解析规则与底色。
(() => {
  let theme = 'light';
  try {
    const mode = localStorage.getItem('wevir.theme-mode');
    const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
    theme = mode === 'dark' || (mode !== 'light' && systemDark) ? 'dark' : 'light';
  } catch {
    // localStorage 不可用时按亮色渲染，theme.ts 启动后会再算一次。
  }
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.backgroundColor = theme === 'dark' ? '#101114' : '#fcfbfa';
})();
