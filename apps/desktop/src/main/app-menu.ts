// macOS 的应用菜单（菜单栏最左边的 Wevir 与文件、编辑、显示、窗口）。不设时 Electron 给一份英文的默认菜单，没有设置与
// 检查更新。这里照 macOS 应用的惯例：关于、设置…（⌘,）、检查更新…、服务、隐藏、退出；其余几个菜单保持默认菜单的内容。
// 文字由渲染进程按界面语言送来（setAppMenuLabels），送来之前用英文。
//
// 只拼模板，不碰 Electron 的运行时（index.ts 用 Menu.buildFromTemplate 装上），单元测试直接检查模板。

import type { MenuItemConstructorOptions } from 'electron';
import { APP_MENU_LABEL_KEYS, type AppMenuLabels } from '../shared/desktop-api.js';

export const DEFAULT_APP_MENU_LABELS: AppMenuLabels = {
  about: 'About Wevir',
  settings: 'Settings…',
  checkForUpdates: 'Check for Updates…',
  services: 'Services',
  hide: 'Hide Wevir',
  hideOthers: 'Hide Others',
  showAll: 'Show All',
  quit: 'Quit Wevir',
  file: 'File',
  closeWindow: 'Close Window',
  edit: 'Edit',
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  pasteAndMatchStyle: 'Paste and Match Style',
  delete: 'Delete',
  selectAll: 'Select All',
  view: 'View',
  reload: 'Reload',
  forceReload: 'Force Reload',
  toggleDevTools: 'Toggle Developer Tools',
  resetZoom: 'Actual Size',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  toggleFullScreen: 'Toggle Full Screen',
  window: 'Window',
  minimize: 'Minimize',
  zoom: 'Zoom',
  bringAllToFront: 'Bring All to Front',
};

const MAX_LABEL = 100;

/** 渲染进程送来的菜单文字：每一项都是非空、不太长的字符串，多余的键不收。 */
export function parseAppMenuLabels(value: unknown): AppMenuLabels | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const labels: Partial<AppMenuLabels> = {};
  for (const key of APP_MENU_LABEL_KEYS) {
    const text = input[key];
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_LABEL) return undefined;
    labels[key] = text;
  }
  return labels as AppMenuLabels;
}

export interface AppMenuActions {
  openSettings(): void;
  checkForUpdates(): void;
}

export function appMenuTemplate(
  labels: AppMenuLabels,
  actions: AppMenuActions,
): MenuItemConstructorOptions[] {
  return [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about', label: labels.about },
        { type: 'separator' },
        // ⌘, 由渲染进程的快捷键处理（routes/router.tsx），菜单只显示它，不另外注册，免得同一次按键跳两次。
        {
          label: labels.settings,
          accelerator: 'Command+,',
          registerAccelerator: false,
          click: actions.openSettings,
        },
        { label: labels.checkForUpdates, click: actions.checkForUpdates },
        { type: 'separator' },
        { role: 'services', label: labels.services },
        { type: 'separator' },
        { role: 'hide', label: labels.hide },
        { role: 'hideOthers', label: labels.hideOthers },
        { role: 'unhide', label: labels.showAll },
        { type: 'separator' },
        { role: 'quit', label: labels.quit },
      ],
    },
    {
      role: 'fileMenu',
      label: labels.file,
      submenu: [{ role: 'close', label: labels.closeWindow }],
    },
    {
      role: 'editMenu',
      label: labels.edit,
      submenu: [
        { role: 'undo', label: labels.undo },
        { role: 'redo', label: labels.redo },
        { type: 'separator' },
        { role: 'cut', label: labels.cut },
        { role: 'copy', label: labels.copy },
        { role: 'paste', label: labels.paste },
        { role: 'pasteAndMatchStyle', label: labels.pasteAndMatchStyle },
        { role: 'delete', label: labels.delete },
        { role: 'selectAll', label: labels.selectAll },
      ],
    },
    {
      role: 'viewMenu',
      label: labels.view,
      submenu: [
        { role: 'reload', label: labels.reload },
        { role: 'forceReload', label: labels.forceReload },
        { role: 'toggleDevTools', label: labels.toggleDevTools },
        { type: 'separator' },
        { role: 'resetZoom', label: labels.resetZoom },
        { role: 'zoomIn', label: labels.zoomIn },
        { role: 'zoomOut', label: labels.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: labels.toggleFullScreen },
      ],
    },
    {
      role: 'windowMenu',
      label: labels.window,
      submenu: [
        { role: 'minimize', label: labels.minimize },
        { role: 'zoom', label: labels.zoom },
        { type: 'separator' },
        { role: 'front', label: labels.bringAllToFront },
      ],
    },
  ];
}
