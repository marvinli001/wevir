// 菜单栏（macOS）与通知区域（Windows、Linux）的图标：关掉主窗口后 Wevir 留在后台（Host 与进行中的回合照常），从这里
// 打开窗口或退出。图标是品牌资源（assets/icons 的 README）：macOS 用 16pt 的黑色透明模板（系统负责深浅色），Windows 用
// 托盘 ICO，跟随系统的 Windows 模式（与 app-icon.ts 的任务栏图标一样）。菜单文字由渲染进程按界面语言送来（setLabels），
// 送来之前用英文。

import { Menu, nativeImage, nativeTheme, Tray } from 'electron';
import macTemplate2x from '../../../../assets/icons/exports/macos/menubar/Wevir16Template@2x.png?asset';
import macTemplate from '../../../../assets/icons/exports/macos/menubar/Wevir16Template.png?asset';
import winDarkPng from '../../../../assets/icons/exports/windows/dark/tray-32.png?asset';
import winDark from '../../../../assets/icons/exports/windows/dark/WevirTray.ico?asset';
import winLightPng from '../../../../assets/icons/exports/windows/light/tray-32.png?asset';
import winLight from '../../../../assets/icons/exports/windows/light/WevirTray.ico?asset';

export interface TrayLabels {
  open: string;
  quit: string;
}

const DEFAULT_LABELS: TrayLabels = { open: 'Open Wevir', quit: 'Quit Wevir' };
const MAX_LABEL = 100;

/** 渲染进程送来的菜单文字：两个非空、不太长的字符串。 */
export function parseTrayLabels(value: unknown): TrayLabels | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const { open, quit } = value as Partial<Record<keyof TrayLabels, unknown>>;
  const ok = (text: unknown): text is string =>
    typeof text === 'string' && text.trim() !== '' && text.length <= MAX_LABEL;
  return ok(open) && ok(quit) ? { open, quit } : undefined;
}

function trayImage(): Electron.NativeImage {
  if (process.platform === 'darwin') {
    // ?asset 复制出来的文件名带哈希，@2x 不会被自动配对，手动加两个分辨率。
    const image = nativeImage.createEmpty();
    image.addRepresentation({
      scaleFactor: 1,
      buffer: nativeImage.createFromPath(macTemplate).toPNG(),
    });
    image.addRepresentation({
      scaleFactor: 2,
      buffer: nativeImage.createFromPath(macTemplate2x).toPNG(),
    });
    image.setTemplateImage(true);
    return image;
  }
  const dark = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
  if (process.platform === 'win32') return nativeImage.createFromPath(dark ? winDark : winLight);
  return nativeImage.createFromPath(dark ? winDarkPng : winLightPng);
}

export interface AppTray {
  setLabels(labels: TrayLabels): void;
  destroy(): void;
}

/** app ready 之后调用。`onOpen` 显示并聚焦主窗口，`onQuit` 真正退出。 */
export function createAppTray({
  onOpen,
  onQuit,
}: {
  onOpen: () => void;
  onQuit: () => void;
}): AppTray {
  const tray = new Tray(trayImage());
  tray.setToolTip('Wevir');
  let labels = DEFAULT_LABELS;
  const buildMenu = () => {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: labels.open, click: onOpen },
        { type: 'separator' },
        { label: labels.quit, click: onQuit },
      ]),
    );
  };
  buildMenu();
  // Windows 与 Linux 习惯单击托盘图标打开窗口、右键出菜单；macOS 单击就出菜单（setContextMenu 的默认行为）。
  if (process.platform !== 'darwin') tray.on('click', onOpen);
  const updateImage = () => {
    if (process.platform !== 'darwin') tray.setImage(trayImage());
  };
  nativeTheme.on('updated', updateImage);
  return {
    setLabels(next) {
      labels = next;
      buildMenu();
    },
    destroy() {
      nativeTheme.off('updated', updateImage);
      tray.destroy();
    },
  };
}
