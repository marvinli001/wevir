import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_MENU_LABELS } from './app-menu.js';
import { type EditContextMenuParams, editContextMenuTemplate } from './context-menu.js';

const NO_FLAGS: EditContextMenuParams['editFlags'] = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canDelete: false,
  canSelectAll: false,
  canEditRichly: false,
};

function template(params: Partial<EditContextMenuParams>, platform: NodeJS.Platform = 'darwin') {
  const calls: string[] = [];
  const record = (name: string) => () => {
    calls.push(name);
  };
  const items = editContextMenuTemplate(
    { isEditable: false, selectionText: '', editFlags: NO_FLAGS, ...params },
    DEFAULT_APP_MENU_LABELS,
    {
      undo: record('undo'),
      redo: record('redo'),
      cut: record('cut'),
      copy: record('copy'),
      paste: record('paste'),
      selectAll: record('selectAll'),
    },
    platform,
  );
  return { items, calls };
}

describe('edit context menu', () => {
  it('输入框：撤销、重做、剪切、复制、粘贴、全选，做不了的置灰', () => {
    const { items, calls } = template({
      isEditable: true,
      editFlags: { ...NO_FLAGS, canPaste: true, canSelectAll: true, canUndo: true },
    });
    expect(items.map((item) => item.label ?? item.type)).toEqual([
      'Undo',
      'Redo',
      'separator',
      'Cut',
      'Copy',
      'Paste',
      'separator',
      'Select All',
    ]);
    expect(items.filter((item) => item.label).map((item) => item.enabled)).toEqual([
      true,
      false,
      false,
      false,
      true,
      true,
    ]);
    expect(items.map((item) => item.accelerator).filter(Boolean)).toEqual([
      'CmdOrCtrl+Z',
      'Shift+CmdOrCtrl+Z',
      'CmdOrCtrl+X',
      'CmdOrCtrl+C',
      'CmdOrCtrl+V',
      'CmdOrCtrl+A',
    ]);
    expect(
      items.every((item) => item.type === 'separator' || item.registerAccelerator === false),
    ).toBe(true);
    for (const item of items) item.click?.({} as never, undefined, {} as never);
    expect(calls).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
  });

  it('Windows / Linux 的重做显示 Ctrl+Y', () => {
    const { items } = template({ isEditable: true }, 'win32');
    expect(items[1]?.accelerator).toBe('Ctrl+Y');
  });

  it('选中的文字只给复制；空白选区与其他地方不弹', () => {
    const { items } = template({
      selectionText: 'hello',
      editFlags: { ...NO_FLAGS, canCopy: true },
    });
    expect(items.map((item) => [item.label, item.enabled])).toEqual([['Copy', true]]);
    expect(template({ selectionText: '  \n' }).items).toEqual([]);
    expect(template({}).items).toEqual([]);
  });
});
