import { afterEach, describe, expect, it } from 'vitest';
import { en } from './en.js';
import { detectLocale, format, type MessageKey, setLocale, t } from './index.js';
import { zh } from './zh.js';

afterEach(() => setLocale('zh'));

describe('detectLocale', () => {
  it('按 LC_ALL、LC_MESSAGES、LANG 的顺序取第一个非空的，zh* 为中文', () => {
    expect(detectLocale({ LANG: 'zh_CN.UTF-8' })).toBe('zh');
    expect(detectLocale({ LANG: 'zh_TW.UTF-8' })).toBe('zh');
    expect(detectLocale({ LANG: 'zh' })).toBe('zh');
    expect(detectLocale({ LANG: 'en_US.UTF-8' })).toBe('en');
    expect(detectLocale({ LC_ALL: 'en_US.UTF-8', LANG: 'zh_CN.UTF-8' })).toBe('en');
    expect(detectLocale({ LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh');
    expect(detectLocale({ LC_ALL: '', LC_MESSAGES: '', LANG: 'zh_CN.UTF-8' })).toBe('zh');
  });

  it('C / POSIX、其他语言与没有设置时为英文', () => {
    expect(detectLocale({})).toBe('en');
    expect(detectLocale({ LANG: 'C' })).toBe('en');
    expect(detectLocale({ LC_ALL: 'POSIX', LANG: 'zh_CN.UTF-8' })).toBe('en');
    expect(detectLocale({ LANG: 'C.UTF-8' })).toBe('en');
    expect(detectLocale({ LANG: 'ja_JP.UTF-8' })).toBe('en');
    expect(detectLocale({ LANG: 'zu_ZA.UTF-8' })).toBe('en');
  });

  it('WEVIR_LANG=zh|en 优先，认不出的值忽略', () => {
    expect(detectLocale({ WEVIR_LANG: 'en', LANG: 'zh_CN.UTF-8' })).toBe('en');
    expect(detectLocale({ WEVIR_LANG: 'zh', LC_ALL: 'C' })).toBe('zh');
    expect(detectLocale({ WEVIR_LANG: 'ZH', LANG: 'en_US.UTF-8' })).toBe('zh');
    expect(detectLocale({ WEVIR_LANG: 'fr', LANG: 'zh_CN.UTF-8' })).toBe('zh');
  });
});

/** 一条文案用到的参数名：`{name}` 与 `{name, plural, …}`，复数选项里的参数也算（选项的文字本身不算）。 */
function placeholders(template: string): string[] {
  const names = new Set<string>();
  const walk = (text: string) => {
    let depth = 0;
    let start = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{' && depth++ === 0) start = i;
      else if (text[i] === '}' && --depth === 0) {
        const body = text.slice(start + 1, i);
        const plural = /^\s*(\w+)\s*,\s*plural\s*,/.exec(body);
        if (plural) {
          names.add(plural[1] as string);
          for (const option of body
            .slice(plural[0].length)
            .matchAll(/\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
            walk(option[1] as string);
          }
        } else names.add(body.trim());
      }
    }
  };
  walk(template);
  return [...names].sort();
}

describe('目录', () => {
  it('英文与中文的 key 一一对应，文案非空', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    for (const [key, value] of Object.entries(en)) expect(value.trim(), key).not.toBe('');
  });

  it('参数与中文相同，格式化后不留花括号', () => {
    for (const key of Object.keys(zh) as MessageKey[]) {
      const names = placeholders(zh[key]);
      expect(placeholders(en[key]), key).toEqual(names);
      for (const count of [0, 1, 2, 5]) {
        const params = Object.fromEntries(names.map((name) => [name, count]));
        expect(format(en[key], params), key).not.toMatch(/[{}]/);
        expect(format(zh[key], params), key).not.toMatch(/[{}]/);
      }
    }
  });

  it('英文目录里没有汉字', () => {
    for (const [key, value] of Object.entries(en))
      expect(value, key).not.toMatch(/\p{Script=Han}/u);
  });
});

describe('t', () => {
  it('按当前语言取文案、替换参数，英文按数量选单复数', () => {
    setLocale('zh');
    expect(t('attach.held', { count: 1 })).toBe(
      '有 1 条暂停的待发消息（上一轮没有正常结束）；输入 /resume 继续发送。',
    );
    setLocale('en');
    expect(t('attach.held', { count: 1 })).toMatch(/^1 held message \(/);
    expect(t('attach.held', { count: 3 })).toMatch(/^3 held messages \(/);
    expect(t('state.awaiting_approval')).toBe('Awaiting approval');
  });
});
