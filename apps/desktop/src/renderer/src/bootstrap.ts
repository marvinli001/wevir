// 第一次渲染之前要做的：主题与外观（首帧前定好 data-theme 等）、窗口标题栏形态、界面语言的目录。桌面端（main.tsx）与别的外壳
// （embed.ts）共用。

import { initI18n } from './i18n/index.js';
import { bootstrapWindowChrome } from './layout/window-chrome.js';
import { bootstrapAppearance } from './theme/appearance.js';
import { bootstrapTheme } from './theme/theme.js';

export async function bootstrapRenderer(): Promise<void> {
  bootstrapTheme();
  bootstrapAppearance();
  bootstrapWindowChrome();
  // 界面语言的目录在第一次渲染之前加载好，t() 始终是同步的。
  await initI18n();
}
