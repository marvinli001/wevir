// 首帧前设置 <html data-theme>（T5.2），暗色用户启动时不会先闪一帧亮色。index.html 在 <head> 里以普通
// （非 module）脚本同步加载它；不内联，因为生产 CSP 是 script-src 'self'，不放行内联脚本。
//
// 解析规则必须与 src/theme/theme.ts 一致，存储 key 是 src/shared/theme.ts 的 THEME_STORAGE_KEY：
// 'dark' / 'light' 照用，其他值（含没有存过）按跟随系统处理。src/shared/theme.test.ts 在 node:vm 里
// 执行本文件核对这两点。
(() => {
  let theme = 'light';
  try {
    const mode = localStorage.getItem('wevir.theme-mode');
    const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
    theme = mode === 'dark' || (mode !== 'light' && systemDark) ? 'dark' : 'light';
  } catch {
    // localStorage 不可用时按亮色渲染，theme.ts 启动后会再算一次。
  }
  document.documentElement.dataset.theme = theme;
})();
