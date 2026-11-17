import { describe, expect, it } from 'vitest';
import {
  formatShortcut,
  getShortcut,
  matchesShortcut,
  menuAccelerator,
  SHORTCUTS,
  setShortcut,
  shortcutConflict,
  shortcutFromEvent,
  shortcutOverrides,
} from './shortcuts';

const key = (
  code: string,
  modifiers: Partial<Record<'meta' | 'ctrl' | 'alt' | 'shift', boolean>> = {},
) => ({
  code,
  metaKey: modifiers.meta === true,
  ctrlKey: modifiers.ctrl === true,
  altKey: modifiers.alt === true,
  shiftKey: modifiers.shift === true,
});

describe('matchesShortcut', () => {
  it('mod 在 macOS 是 ⌘，其他平台是 Ctrl；修饰键要完全一致', () => {
    expect(matchesShortcut(key('KeyB', { meta: true }), SHORTCUTS.toggleSidebar, true)).toBe(true);
    expect(matchesShortcut(key('KeyB', { ctrl: true }), SHORTCUTS.toggleSidebar, true)).toBe(false);
    expect(matchesShortcut(key('KeyB', { ctrl: true }), SHORTCUTS.toggleSidebar, false)).toBe(true);
    expect(
      matchesShortcut(key('KeyB', { meta: true, alt: true }), SHORTCUTS.toggleSidebar, true),
    ).toBe(false);
    expect(matchesShortcut(key('KeyB', { meta: true, alt: true }), SHORTCUTS.toggleAux, true)).toBe(
      true,
    );
  });

  it('⌃Tab 两个平台都是 Control', () => {
    expect(matchesShortcut(key('Tab', { ctrl: true }), SHORTCUTS.nextTab, true)).toBe(true);
    expect(matchesShortcut(key('Tab', { ctrl: true }), SHORTCUTS.nextTab, false)).toBe(true);
    expect(matchesShortcut(key('Tab', { ctrl: true, shift: true }), SHORTCUTS.nextTab, false)).toBe(
      false,
    );
  });
});

describe('formatShortcut', () => {
  it('记录按键、检查冲突并恢复当前设置，原生菜单使用同一按键', () => {
    const assigned = shortcutFromEvent(key('KeyL', { meta: true, alt: true }), true);
    expect(assigned).toEqual({ code: 'KeyL', mod: true, alt: true });
    expect(shortcutFromEvent(key('KeyL'), true)).toBeUndefined();
    expect(shortcutFromEvent(key('KeyQ', { meta: true }), true)).toBeUndefined();
    const initial = shortcutOverrides.get();
    try {
      if (!assigned) throw new Error('missing binding');
      setShortcut('previousSession', assigned);
      expect(shortcutConflict('nextSession', assigned, true)).toBe('previousSession');
      expect(menuAccelerator(getShortcut('previousSession'))).toBe('CommandOrControl+Alt+L');
      setShortcut('previousSession', SHORTCUTS.previousSession);
      expect(shortcutOverrides.get().previousSession).toBeUndefined();
    } finally {
      shortcutOverrides.set(initial);
    }
  });
  it.each([true, false])(
    'declares the native theme recovery shortcut without an application conflict (mac=%s)',
    (mac) => {
      const shortcut = formatShortcut(SHORTCUTS.restoreDefaultTheme, mac);
      expect(shortcut).toBe(mac ? '⌥⇧⌘0' : 'Ctrl+Alt+Shift+0');
      expect(
        Object.entries(SHORTCUTS)
          .filter(([name]) => name !== 'restoreDefaultTheme')
          .some(([, value]) => formatShortcut(value, mac) === shortcut),
      ).toBe(false);
    },
  );
  it('macOS 用符号，其他平台用 Ctrl+…', () => {
    expect(formatShortcut(SHORTCUTS.toggleAux, true)).toBe('⌥⌘B');
    expect(formatShortcut(SHORTCUTS.toggleAux, false)).toBe('Ctrl+Alt+B');
    expect(formatShortcut(SHORTCUTS.back, true)).toBe('⌘[');
    expect(formatShortcut(SHORTCUTS.forward, false)).toBe('Ctrl+]');
    expect(formatShortcut(SHORTCUTS.previousTab, true)).toBe('⌃⇧⇥');
    expect(formatShortcut(SHORTCUTS.splitRight, false)).toBe('Ctrl+\\');
  });
});
