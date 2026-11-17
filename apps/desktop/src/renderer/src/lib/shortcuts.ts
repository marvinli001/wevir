import { useMemo } from 'react';
import { createPersistedStore } from './store';

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
  /** 由原生菜单执行，不依赖渲染 DOM。 */
  restoreDefaultTheme: { code: 'Digit0', mod: true, alt: true, shift: true },
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
  previousSession: { code: 'ArrowUp', mod: true, alt: true },
  nextSession: { code: 'ArrowDown', mod: true, alt: true },
  lowerEffort: { code: 'BracketLeft', mod: true, shift: true },
  higherEffort: { code: 'BracketRight', mod: true, shift: true },
} as const satisfies Record<string, Shortcut>;

export const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

type KeyState = Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;
export type ShortcutId = keyof typeof SHORTCUTS;
type Overrides = Partial<Record<ShortcutId, Shortcut>>;
const IDS = Object.keys(SHORTCUTS) as ShortcutId[];

// Electron 菜单优先于页面收到系统编辑、退出和缩放等按键。
const NATIVE_KEYS = /^(?:Key[QWHMCVXZARY]|Digit0|Minus|Equal)$/;
const FUNCTION_KEY = /^F(?:[1-9]|1[0-9]|2[0-4])$/;
const RECORDABLE_CODE =
  /^(?:Key[A-Z]|Digit[0-9]|Arrow(?:Left|Right|Up|Down)|Tab|Space|Enter|Comma|Period|Slash|Backslash|BracketLeft|BracketRight|Minus|Equal|Semicolon|Quote|Backquote|Home|End|PageUp|PageDown|Backspace|Delete|Insert)$/;

export const shortcutOverrides = createPersistedStore<Overrides>(
  'wevir.shortcuts.v1',
  {},
  (raw) => {
    if (typeof raw !== 'object' || !raw) return undefined;
    const overrides: Overrides = {};
    for (const id of IDS) {
      const value = (raw as Record<string, unknown>)[id];
      if (
        typeof value !== 'object' ||
        !value ||
        !('code' in value) ||
        typeof value.code !== 'string'
      )
        continue;
      const keys = value as Shortcut;
      const modifiers = [keys.mod, keys.ctrl, keys.alt, keys.shift];
      if (
        modifiers.every((value) => value === undefined || typeof value === 'boolean') &&
        recordable(keys)
      )
        overrides[id] = keys;
    }
    return overrides;
  },
);

export function getShortcut(id: ShortcutId): Shortcut {
  return shortcutOverrides.get()[id] ?? SHORTCUTS[id];
}

export function useKeybindings(): Record<ShortcutId, Shortcut> {
  const overrides = shortcutOverrides.use();
  return useMemo(() => ({ ...SHORTCUTS, ...overrides }), [overrides]);
}

function recordable(keys: Shortcut): boolean {
  return (
    FUNCTION_KEY.test(keys.code) ||
    (RECORDABLE_CODE.test(keys.code) && !!(keys.mod || keys.ctrl || keys.alt))
  );
}

export function shortcutFromEvent(event: KeyState, mac = IS_MAC): Shortcut | undefined {
  if (!mac && event.metaKey) return undefined;
  const keys: Shortcut = {
    code: event.code,
    ...((mac ? event.metaKey : event.ctrlKey) && { mod: true }),
    ...(mac && event.ctrlKey && { ctrl: true }),
    ...(event.altKey && { alt: true }),
    ...(event.shiftKey && { shift: true }),
  };
  if (!recordable(keys)) return undefined;
  if (keys.mod && !keys.alt && !keys.ctrl && !keys.shift && NATIVE_KEYS.test(keys.code))
    return undefined;
  if (keys.alt && keys.code === 'F4') return undefined;
  return keys;
}

export function shortcutConflict(
  id: ShortcutId,
  value: Shortcut,
  mac = IS_MAC,
): ShortcutId | undefined {
  const label = formatShortcut(value, mac);
  return IDS.find((other) => other !== id && formatShortcut(getShortcut(other), mac) === label);
}

export function setShortcut(id: ShortcutId, value: Shortcut): void {
  const updated = { ...shortcutOverrides.get() };
  if (formatShortcut(value) === formatShortcut(SHORTCUTS[id])) delete updated[id];
  else updated[id] = value;
  shortcutOverrides.set(updated);
}

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
  ArrowUp: ['↑', '↑'],
  ArrowDown: ['↓', '↓'],
  Period: ['.', '.'],
  Slash: ['/', '/'],
  Semicolon: [';', ';'],
  Quote: ["'", "'"],
  Backquote: ['`', '`'],
  Equal: ['+', '+'],
  Minus: ['-', '-'],
};

/** 原生菜单用 Electron Accelerator 的键名。 */
export function menuAccelerator(shortcut: Shortcut): string {
  const keys: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Equal: '=',
  };
  const key =
    keys[shortcut.code] ??
    KEY_LABELS[shortcut.code]?.[1] ??
    shortcut.code.replace(/^(Key|Digit)/, '');
  return [
    shortcut.mod && 'CommandOrControl',
    shortcut.ctrl && 'Control',
    shortcut.alt && 'Alt',
    shortcut.shift && 'Shift',
    key,
  ]
    .filter(Boolean)
    .join('+');
}

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
