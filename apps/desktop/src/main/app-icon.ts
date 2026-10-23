// 应用图标：已确认的品牌资源在仓库根目录的 assets/icons（见其 README）。浅色是香槟金主标 + 象牙白底，深色是
// 铂金白主标 + 石墨黑底。
//
// macOS：安装包里有 Icon Composer 编译出的 Assets.car（electron-builder.yml 的 mac.icon 是 Wevir.icon，Info.plist 有
// CFBundleIconName）时，图标由系统按系统外观画（浅色、深色、着色、透明），没启动时与启动后一样，这里不碰程序坞图标。没有
// Assets.car 时（开发模式；没有 Xcode 26 的机器上打的包只有浅色 ICNS）才在运行时设程序坞图标，跟随系统外观，不跟随应用
// 自己的主题模式。Windows 设窗口与任务栏图标，跟随系统的 Windows 模式。Linux 设窗口图标（X11 的 _NET_WM_ICON；AppImage 没有
// 装 .desktop 时任务栏只有它），用 hicolor 的浅色一套，与 electron-builder.yml 装进系统的图标一致，不跟随外观（Linux 的应用
// 图标没有深色变体的约定）。electron-vite 把 ?asset 导入的文件复制进 out/main。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, nativeTheme, systemPreferences } from 'electron';
import linuxIcon from '../../../../assets/icons/exports/linux/light/hicolor/256x256/apps/wevir.png?asset';
import macDark from '../../../../assets/icons/exports/macos/dark/AppIcon.appiconset/icon_512x512@2x.png?asset';
import macLight from '../../../../assets/icons/exports/macos/light/AppIcon.appiconset/icon_512x512@2x.png?asset';
import winDark from '../../../../assets/icons/exports/windows/dark/Wevir.ico?asset';
import winLight from '../../../../assets/icons/exports/windows/light/Wevir.ico?asset';

/**
 * 新建窗口用的图标：Windows 与 Linux 需要（macOS 的窗口没有图标）。Windows 的任务栏跟随系统的“Windows 模式”，与应用自己的
 * 主题模式无关，所以看 shouldUseDarkColorsForSystemIntegratedUI。
 */
export function windowIcon(): string | undefined {
  if (process.platform === 'linux') return linuxIcon;
  if (process.platform !== 'win32') return undefined;
  return nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? winDark : winLight;
}

/** 安装包里有没有系统按外观画的图标（Icon Composer 编译出的 Assets.car）。 */
function hasSystemAppIcon(): boolean {
  return app.isPackaged && existsSync(join(process.resourcesPath, 'Assets.car'));
}

/**
 * 系统（不是应用）现在是不是深色：nativeTheme 受应用自己的 themeSource 影响，这里读全局的 AppleInterfaceStyle（自动切换时
 * 系统也会随时改它）。
 */
function systemIsDark(): boolean {
  return systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') === 'Dark';
}

/**
 * 设置程序坞（macOS，只在没有 Assets.car 时）与已打开窗口（Windows、Linux）的图标，并在外观变化时更新。app ready 之后调用一次。
 */
export function applyAppIcon(): void {
  const macDock = process.platform === 'darwin' && !hasSystemAppIcon();
  const update = () => {
    if (macDock) app.dock?.setIcon(systemIsDark() ? macDark : macLight);
    const icon = windowIcon();
    if (icon === undefined) return;
    for (const window of BrowserWindow.getAllWindows()) window.setIcon(icon);
  };
  update();
  nativeTheme.on('updated', update);
  // 应用固定了浅色或深色时，系统切换外观不会触发 nativeTheme 的 updated，另外听系统的通知。
  if (macDock)
    systemPreferences.subscribeNotification('AppleInterfaceThemeChangedNotification', update);
}
