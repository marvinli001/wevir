// 电脑操作（0.112.0）的授权档位：按应用的种类定，用户在授权框里只能批准或拒绝，改不了档位。浏览器只读（网页交给浏览器工具），
// 终端与 IDE 只能左键点击与滚动（命令与改文件交给 agent 自己的工具），Wevir 自己不能授权，其余完全控制。浏览器由 helper 按
// “能打开 https 地址的应用”认出，这里另有一张常见浏览器的表兜底。

import type { ComputerAccessTier } from '@wevir/protocol';

/** Wevir 自己（安装包的 bundle ID）：不能授权。开发时的 Electron 由 helper 按父进程认出。 */
export const SELF_BUNDLE_IDS: readonly string[] = ['si.wevir.desktop'];

const BROWSERS = new Set([
  'com.apple.Safari',
  'com.apple.SafariTechnologyPreview',
  'com.google.Chrome',
  'com.google.Chrome.beta',
  'com.google.Chrome.canary',
  'org.chromium.Chromium',
  'org.mozilla.firefox',
  'org.mozilla.firefoxdeveloperedition',
  'com.microsoft.edgemac',
  'company.thebrowser.Browser',
  'company.thebrowser.dia',
  'com.brave.Browser',
  'com.operasoftware.Opera',
  'com.vivaldi.Vivaldi',
  'app.zen-browser.zen',
  'ai.perplexity.comet',
  'com.openai.atlas',
]);

const TERMINALS_AND_IDES = new Set([
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'dev.warp.Warp',
  'net.kovidgoyal.kitty',
  'com.mitchellh.ghostty',
  'io.alacritty',
  'org.alacritty',
  'co.zeit.hyper',
  'com.github.wez.wezterm',
  'org.tabby',
  'com.raphaelamorim.rio',
  'com.apple.dt.Xcode',
  'com.microsoft.VSCode',
  'com.microsoft.VSCodeInsiders',
  'com.vscodium',
  'com.todesktop.230313mzl4w4u92',
  'com.exafunction.windsurf',
  'com.google.antigravity',
  'dev.zed.Zed',
  'dev.zed.Zed-Preview',
  'com.sublimetext.4',
  'com.sublimetext.3',
  'com.panic.Nova',
  'com.barebones.bbedit',
  'org.vim.MacVim',
  'com.google.android.studio',
]);

export interface AppKind {
  bundleId: string;
  /** helper 认出它能打开 https 地址。 */
  browser?: boolean;
}

/** 应用的档位；Wevir 自己是 `undefined`（不能授权）。 */
export function accessTier(app: AppKind): ComputerAccessTier | undefined {
  if (SELF_BUNDLE_IDS.includes(app.bundleId)) return undefined;
  if (app.browser === true || BROWSERS.has(app.bundleId)) return 'read';
  if (TERMINALS_AND_IDES.has(app.bundleId) || app.bundleId.startsWith('com.jetbrains.')) {
    return 'click';
  }
  return 'full';
}

/** 给模型看的档位说明。 */
export const TIER_TEXT: Record<ComputerAccessTier, string> = {
  read: 'read-only: screenshots and reading only',
  click: 'left clicks and scrolling only',
  full: 'full control',
};
