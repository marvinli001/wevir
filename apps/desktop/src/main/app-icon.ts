// 应用图标：已确认的品牌资源在仓库根目录的 assets/icons（见其 README）。浅色是香槟金主标 + 象牙白底，深色是
// 铂金白主标 + 石墨黑底；ICNS / ICO 本身不随主题切换，桌面端也还没有打包配置，所以由主进程在运行时按主题选：
// macOS 设程序坞图标，Windows 设窗口与任务栏图标。electron-vite 把 ?asset 导入的文件复制进 out/main。

import { app, BrowserWindow, nativeTheme } from 'electron';
import macDark from '../../../../assets/icons/exports/macos/dark/AppIcon.appiconset/icon_512x512@2x.png?asset';
import macLight from '../../../../assets/icons/exports/macos/light/AppIcon.appiconset/icon_512x512@2x.png?asset';
import winDark from '../../../../assets/icons/exports/windows/dark/Wevir.ico?asset';
import winLight from '../../../../assets/icons/exports/windows/light/Wevir.ico?asset';

/**
 * 新建窗口用的图标：只有 Windows 需要（macOS 的窗口没有图标）。任务栏跟随系统的“Windows 模式”，与应用自己的
 * 主题模式无关，所以看 shouldUseDarkColorsForSystemIntegratedUI。
 */
export function windowIcon(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  return nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? winDark : winLight;
}

/**
 * 设置程序坞（macOS）与已打开窗口（Windows）的图标，并在主题变化时更新。app ready 之后调用一次。macOS 拿不到
 * 不受 themeSource 影响的系统外观，程序坞图标跟随应用当前的深浅色。
 */
export function applyAppIcon(): void {
  const update = () => {
    if (process.platform === 'darwin') {
      app.dock?.setIcon(nativeTheme.shouldUseDarkColors ? macDark : macLight);
    }
    const icon = windowIcon();
    if (icon === undefined) return;
    for (const window of BrowserWindow.getAllWindows()) window.setIcon(icon);
  };
  update();
  nativeTheme.on('updated', update);
}
