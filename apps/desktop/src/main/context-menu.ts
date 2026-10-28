// 右键菜单（编辑）：Electron 默认不给页面弹任何菜单。输入框里给撤销、重做、剪切、复制、粘贴、全选（做不了的置灰），选中的文字给
// 复制，其余地方不弹。页面自己处理了右键（侧边栏的会话、项目菜单）时 Chromium 不发 context-menu 事件，不会叠两层。
// 文字与应用菜单共用（app-menu.ts，渲染进程按界面语言送来）。
//
// 只拼模板，不碰 Electron 的运行时（index.ts 用 Menu.buildFromTemplate 弹出），单元测试直接检查模板。

import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';
import type { AppMenuLabels } from '../shared/desktop-api.js';

export type EditContextMenuParams = Pick<
  ContextMenuParams,
  'isEditable' | 'selectionText' | 'editFlags'
>;

/** 菜单项点下去要做的事，对应 webContents 上的同名方法。 */
export interface EditContextMenuActions {
  undo(): void;
  redo(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  selectAll(): void;
}

/** 快捷键只显示（弹出式菜单不注册），与系统一致：重做在 macOS 是 ⇧⌘Z，别处是 Ctrl+Y。 */
function shortcut(accelerator: string): Partial<MenuItemConstructorOptions> {
  return { accelerator, registerAccelerator: false };
}

export function editContextMenuTemplate(
  params: EditContextMenuParams,
  labels: AppMenuLabels,
  actions: EditContextMenuActions,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  const flags = params.editFlags;
  if (params.isEditable) {
    return [
      {
        label: labels.undo,
        enabled: flags.canUndo,
        click: actions.undo,
        ...shortcut('CmdOrCtrl+Z'),
      },
      {
        label: labels.redo,
        enabled: flags.canRedo,
        click: actions.redo,
        ...shortcut(platform === 'darwin' ? 'Shift+CmdOrCtrl+Z' : 'Ctrl+Y'),
      },
      { type: 'separator' },
      { label: labels.cut, enabled: flags.canCut, click: actions.cut, ...shortcut('CmdOrCtrl+X') },
      {
        label: labels.copy,
        enabled: flags.canCopy,
        click: actions.copy,
        ...shortcut('CmdOrCtrl+C'),
      },
      {
        label: labels.paste,
        enabled: flags.canPaste,
        click: actions.paste,
        ...shortcut('CmdOrCtrl+V'),
      },
      { type: 'separator' },
      {
        label: labels.selectAll,
        enabled: flags.canSelectAll,
        click: actions.selectAll,
        ...shortcut('CmdOrCtrl+A'),
      },
    ];
  }
  if (params.selectionText.trim() !== '') {
    return [
      {
        label: labels.copy,
        enabled: flags.canCopy,
        click: actions.copy,
        ...shortcut('CmdOrCtrl+C'),
      },
    ];
  }
  return [];
}
