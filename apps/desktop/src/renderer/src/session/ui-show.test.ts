import { describe, expect, it } from 'vitest';
import { settingsPath, shouldShow, UI_SHOW_FRESH_MS } from './ui-show';

describe('shouldShow', () => {
  const now = Date.parse('2026-10-16T08:00:20.000Z');
  it('新到的、刚发生的才打开', () => {
    expect(shouldShow({ seq: 5, ts: '2026-10-16T08:00:19.000Z' }, undefined, now)).toBe(true);
    expect(shouldShow({ seq: 5, ts: '2026-10-16T08:00:19.000Z' }, 4, now)).toBe(true);
  });
  it('处理过的、历史里的不打开', () => {
    expect(shouldShow({ seq: 5, ts: '2026-10-16T08:00:19.000Z' }, 5, now)).toBe(false);
    const old = new Date(now - UI_SHOW_FRESH_MS - 1).toISOString();
    expect(shouldShow({ seq: 9, ts: old }, undefined, now)).toBe(false);
  });
});

describe('settingsPath', () => {
  it('设置的分页与插件页有路径，认不出的页不打开', () => {
    expect(settingsPath('providers')).toBe('/settings/providers');
    expect(settingsPath('plugins')).toBe('/plugins');
    expect(settingsPath('nowhere')).toBeUndefined();
  });
});
