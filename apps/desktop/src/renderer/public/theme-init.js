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
// 首帧的底色：样式表生效之前页面是透明的，露出主进程设的窗口底色；存储的模式与系统不同时会先闪一下另一种
// 底色。所以这里按解析出的主题先给 <html> 涂上 tokens.css 的 --background（值同 src/shared/theme.ts 的
// THEME_BACKGROUND）。这是 CSSOM 写入，不受 CSP 的 style-src 限制；样式表加载后由 theme.ts 的 bootstrapTheme 去掉，
// 之后切换主题只看 CSS。src/shared/theme.test.ts 在 node:vm 里执行本文件核对存储 key、解析规则与底色。
//
// 设置 → 外观里自定义了这个主题的背景（APPEARANCE_STORAGE_KEY，src/theme/appearance-model.ts 只存 #rrggbb）时，首帧与启动
// 画面用它：底色换成它，启动画面的底色与主标色经 --splash-custom-bg / --splash-custom-mark 给 splash.css（主标是背景往
// 前景色偏 14%，前景没改时取默认的前景色）。
// Host 主题缓存的 colorScheme 与当前模式背景优先，设备模式只读不改；CSS 与背景素材留给运行时。
(() => {
  let theme = 'light';
  let custom = {};
  let cached;
  try {
    const mode = localStorage.getItem('wevir.theme-mode');
    const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
    theme = mode === 'dark' || (mode !== 'light' && systemDark) ? 'dark' : 'light';
  } catch {
    // 无法读取设备模式时用默认模式。
  }
  try {
    const value = JSON.parse(localStorage.getItem('wevir.custom-theme.v1') || 'null');
    if (
      value?.version === 1 &&
      typeof value.hostId === 'string' &&
      typeof value.id === 'string' &&
      /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.id) &&
      typeof value.revision === 'string' &&
      value.variables?.light &&
      value.variables?.dark &&
      (value.colorScheme === undefined ||
        value.colorScheme === 'light' ||
        value.colorScheme === 'dark')
    ) {
      cached = value;
      theme = value.colorScheme || theme;
    }
  } catch {
    // 损坏的主题缓存不影响设备外观。
  }
  try {
    const appearance = JSON.parse(localStorage.getItem('wevir.appearance.v1') || '{}');
    if (appearance && typeof appearance[theme] === 'object' && appearance[theme] !== null) {
      custom = appearance[theme];
    }
  } catch {
    // 损坏的设备外观不影响主题缓存。
  }
  const hex = (value) => typeof value === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value);
  const variables = cached?.variables[theme] || {};
  const background = hex(variables['--background'])
    ? variables['--background']
    : hex(custom.background)
      ? custom.background
      : theme === 'dark'
        ? '#101114'
        : '#fcfbfa';
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.backgroundColor = background;
  if (hex(variables['--background']) || hex(custom.background)) {
    const foreground = hex(variables['--foreground'])
      ? variables['--foreground']
      : hex(custom.foreground)
        ? custom.foreground
        : theme === 'dark'
          ? '#eeede8'
          : '#1a1a17';
    root.style.setProperty('--splash-custom-bg', background);
    root.style.setProperty(
      '--splash-custom-mark',
      `color-mix(in oklab, ${background}, ${foreground} 14%)`,
    );
  }
})();
