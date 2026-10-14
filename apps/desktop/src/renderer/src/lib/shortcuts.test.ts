import { describe, expect, it } from 'vitest';
import { formatShortcut, matchesShortcut, SHORTCUTS } from './shortcuts';

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
  it('macOS 用符号，其他平台用 Ctrl+…', () => {
    expect(formatShortcut(SHORTCUTS.toggleAux, true)).toBe('⌥⌘B');
    expect(formatShortcut(SHORTCUTS.toggleAux, false)).toBe('Ctrl+Alt+B');
    expect(formatShortcut(SHORTCUTS.back, true)).toBe('⌘[');
    expect(formatShortcut(SHORTCUTS.forward, false)).toBe('Ctrl+]');
    expect(formatShortcut(SHORTCUTS.previousTab, true)).toBe('⌃⇧⇥');
    expect(formatShortcut(SHORTCUTS.splitRight, false)).toBe('Ctrl+\\');
  });
});
