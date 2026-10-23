import { describe, expect, it } from 'vitest';
import { LOCALES, pickLocale, setLocale, t, timeAgo } from './index';
import { zhCN } from './zh-CN';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('mobile i18n', () => {
  it('has the same ten locales as the desktop app', () => {
    expect(Object.keys(LOCALES).sort()).toEqual(
      ['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'ru', 'zh-CN', 'zh-TW'].sort(),
    );
  });

  it('every locale has every key with the same placeholders', () => {
    for (const [name, messages] of Object.entries(LOCALES)) {
      expect(Object.keys(messages).sort(), name).toEqual(Object.keys(zhCN).sort());
      for (const key of Object.keys(zhCN) as (keyof typeof zhCN)[]) {
        expect(messages[key].trim(), `${name} ${key}`).not.toBe('');
        expect(placeholders(messages[key]), `${name} ${key}`).toEqual(placeholders(zhCN[key]));
      }
    }
  });

  it('keeps the source copy free of colloquial words (ui-copy rules)', () => {
    for (const [key, text] of Object.entries(zhCN)) {
      expect(text, key).not.toMatch(/请|您|你|这个|还没|例如/);
    }
  });

  it('picks the closest locale from system tags', () => {
    expect(pickLocale(['zh-Hans-CN'])).toBe('zh-CN');
    expect(pickLocale(['zh-Hant-TW'])).toBe('zh-TW');
    expect(pickLocale(['zh-HK'])).toBe('zh-TW');
    expect(pickLocale(['pt-BR', 'fr-CA'])).toBe('fr');
    expect(pickLocale(['pt-BR'])).toBe('en');
    expect(pickLocale([])).toBe('en');
  });

  it('formats parameters and relative times', () => {
    setLocale('en');
    expect(t('computer.pending', { count: 3 })).toBe('3 pending');
    const now = new Date('2026-10-23T12:00:00Z');
    expect(timeAgo('2026-10-23T11:59:40Z', now)).toBe('just now');
    expect(timeAgo('2026-10-23T11:15:00Z', now)).toBe('45 min ago');
    expect(timeAgo('2026-10-21T12:00:00Z', now)).toBe('2 d ago');
    setLocale('zh-CN');
    expect(timeAgo('2026-10-23T09:00:00Z', now)).toBe('3 小时前');
  });
});
