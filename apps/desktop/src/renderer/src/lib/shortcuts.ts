// 键盘快捷键（R12，docs/architecture/desktop-layout.md §3.10）：按 KeyboardEvent.code 匹配（macOS 上按住 ⌥
// 时 event.key 会变成别的字符），“mod”在 macOS 是 ⌘、其他平台是 Ctrl；修饰键要完全一致才算。

export interface Shortcut {
  /** KeyboardEvent.code，例如 KeyB、Backslash、Tab、ArrowRight。 */
  code: string;
  /** macOS 的 ⌘，其他平台的 Ctrl。 */
  mod?: boolean;
  /** 字面上的 Control 键（⌃Tab 这类两个平台都用 Ctrl 的组合）。 */
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export const SHORTCUTS = {
  /** U35：新建会话（当前项目的草稿页，没有项目时回首页）与打开设置。 */
  newSession: { code: 'KeyN', mod: true },
  settings: { code: 'Comma', mod: true },
  /** 0.77.0：会话全文搜索的浮窗（search/search-dialog.tsx）。 */
  search: { code: 'KeyK', mod: true },
  toggleSidebar: { code: 'KeyB', mod: true },
  back: { code: 'BracketLeft', mod: true },
  forward: { code: 'BracketRight', mod: true },
  toggleAux: { code: 'KeyB', mod: true, alt: true },
  openTabs: { code: 'KeyA', mod: true, shift: true },
  maximize: { code: 'KeyM', mod: true, shift: true },
  /** 顶栏的终端、浏览器、文件按钮（照 Claude Code 桌面端）：显示那种窗格，没有就新开。 */
  terminal: { code: 'KeyJ', mod: true },
  browser: { code: 'KeyB', mod: true, shift: true },
  files: { code: 'KeyF', mod: true, shift: true },
  splitRight: { code: 'Backslash', mod: true },
  nextTab: { code: 'Tab', ctrl: true },
  previousTab: { code: 'Tab', ctrl: true, shift: true },
  /** 0.92.0：输入框里听写，按住说话、松开转写；点一下开始，再按一次结束。 */
  dictation: { code: 'KeyD', mod: true, shift: true },
  nextPane: { code: 'ArrowRight', mod: true, alt: true },
  previousPane: { code: 'ArrowLeft', mod: true, alt: true },
} as const satisfies Record<string, Shortcut>;

export const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

type KeyState = Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

export function matchesShortcut(event: KeyState, shortcut: Shortcut, mac = IS_MAC): boolean {
  const meta = mac && shortcut.mod === true;
  const ctrl = shortcut.ctrl === true || (!mac && shortcut.mod === true);
  return (
    event.code === shortcut.code &&
    event.metaKey === meta &&
    event.ctrlKey === ctrl &&
    event.altKey === (shortcut.alt === true) &&
    event.shiftKey === (shortcut.shift === true)
  );
}

const KEY_LABELS: Record<string, [mac: string, other: string]> = {
  Comma: [',', ','],
  Backslash: ['\\', '\\'],
  BracketLeft: ['[', '['],
  BracketRight: [']', ']'],
  Tab: ['⇥', 'Tab'],
  ArrowRight: ['→', '→'],
  ArrowLeft: ['←', '←'],
};

/** 提示里显示的写法：macOS 是 ⌃⌥⇧⌘B，其他平台是 Ctrl+Alt+Shift+B。 */
export function formatShortcut(shortcut: Shortcut, mac = IS_MAC): string {
  const key = KEY_LABELS[shortcut.code]?.[mac ? 0 : 1] ?? shortcut.code.replace(/^(Key|Digit)/, '');
  const ctrl = shortcut.ctrl === true || (!mac && shortcut.mod === true);
  if (mac) {
    return `${ctrl ? '⌃' : ''}${shortcut.alt ? '⌥' : ''}${shortcut.shift ? '⇧' : ''}${shortcut.mod ? '⌘' : ''}${key}`;
  }
  return [ctrl && 'Ctrl', shortcut.alt && 'Alt', shortcut.shift && 'Shift', key]
    .filter(Boolean)
    .join('+');
}
