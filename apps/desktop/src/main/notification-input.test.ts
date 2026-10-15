import { describe, expect, it } from 'vitest';
import { isBadgeCount, parseDesktopNotification } from './notification-input.js';

describe('parseDesktopNotification', () => {
  const valid = { tag: 'session:a', title: '需要批准', body: '修复登录', sound: true };

  it('accepts a well-formed notification and drops unknown fields', () => {
    expect(parseDesktopNotification({ ...valid, extra: 1 })).toEqual(valid);
    expect(parseDesktopNotification({ ...valid, body: '' })).toEqual({ ...valid, body: '' });
  });

  it('rejects missing, empty, oversized or mistyped fields', () => {
    expect(parseDesktopNotification(null)).toBeUndefined();
    expect(parseDesktopNotification('x')).toBeUndefined();
    expect(parseDesktopNotification({ ...valid, tag: '' })).toBeUndefined();
    expect(parseDesktopNotification({ ...valid, title: '' })).toBeUndefined();
    expect(parseDesktopNotification({ ...valid, title: 'x'.repeat(201) })).toBeUndefined();
    expect(parseDesktopNotification({ ...valid, body: 'x'.repeat(1001) })).toBeUndefined();
    expect(parseDesktopNotification({ ...valid, sound: 'yes' })).toBeUndefined();
    const { sound: _, ...noSound } = valid;
    expect(parseDesktopNotification(noSound)).toBeUndefined();
  });
});

describe('isBadgeCount', () => {
  it('accepts small non-negative integers only', () => {
    expect(isBadgeCount(0)).toBe(true);
    expect(isBadgeCount(12)).toBe(true);
    expect(isBadgeCount(-1)).toBe(false);
    expect(isBadgeCount(1.5)).toBe(false);
    expect(isBadgeCount(10_000)).toBe(false);
    expect(isBadgeCount('3')).toBe(false);
  });
});
