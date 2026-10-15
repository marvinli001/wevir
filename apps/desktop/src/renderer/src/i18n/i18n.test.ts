import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { format, loadCatalog, type Messages, setLocale, t } from './index';
import { LOCALES, matchLocale, resolveLocale } from './locales';
import { zhCN } from './zh-CN';

afterEach(() => setLocale('zh-CN', zhCN));

describe('文案模块', () => {
  it('取源语言（简体中文）文案并替换参数', () => {
    expect(t('sidebar.settings')).toBe('设置');
    expect(t('host.reconnecting', { attempt: 3 })).toBe('重连中（第 3 次）');
    expect(t('notFound.workspace', { id: 'ws_x' })).toBe('项目“ws_x”不存在');
  });

  it('参数值里的花括号不会被再次替换', () => {
    expect(t('notFound.page', { path: '/a/{path}' })).toBe('页面不存在：/a/{path}');
  });

  it('文案都是非空字符串，占位符只用 {name} 形式', () => {
    for (const [key, value] of Object.entries(zhCN)) {
      expect(value, key).not.toBe('');
      expect(value.replace(/\{\w+\}/g, ''), key).not.toMatch(/[{}]/);
    }
  });

  it('首页标题各句式的字都在标题宋体的子集里', () => {
    const script = readFileSync(
      new URL('../../../../scripts/build-fonts.py', import.meta.url),
      'utf8',
    );
    const subset = new Set(
      [...(script.match(/^DISPLAY_TEXT = \[([\s\S]*?)\]/m)?.[1] ?? '').matchAll(/"([^"]*)"/g)]
        .map((match) => match[1])
        .join(''),
    );
    const titles = Object.entries(zhCN).filter(([key]) => key.startsWith('home.title.'));
    expect(titles.length).toBeGreaterThan(0);
    for (const [key, value] of titles) {
      expect(
        [...value].filter((ch) => !subset.has(ch)),
        key,
      ).toEqual([]);
    }
  });

  it('换语言后 t() 用那种语言的目录', async () => {
    setLocale('en', await loadCatalog('en'));
    expect(t('sidebar.settings')).not.toBe('设置');
  });
});

describe('复数', () => {
  const files = '{count, plural, one {# file} other {# files}}';

  it('按语言的复数类别选写法，# 是那个数', () => {
    setLocale('en', zhCN);
    expect(format(files, { count: 1 })).toBe('1 file');
    expect(format(files, { count: 3 })).toBe('3 files');
    expect(format('{count, plural, =0 {none} other {# left}}', { count: 0 })).toBe('none');
  });

  it('俄语分 one / few / many', () => {
    setLocale('ru', zhCN);
    const ru = '{count, plural, one {# файл} few {# файла} many {# файлов} other {# файла}}';
    expect([1, 3, 5, 21, 22, 11].map((count) => format(ru, { count }))).toEqual([
      '1 файл',
      '3 файла',
      '5 файлов',
      '21 файл',
      '22 файла',
      '11 файлов',
    ]);
  });

  it('选项里还能有别的参数，认不出的写法原样保留', () => {
    setLocale('en', zhCN);
    expect(
      format('{count, plural, one {# file in {dir}} other {# files in {dir}}}', {
        count: 2,
        dir: 'src',
      }),
    ).toBe('2 files in src');
    expect(format('{count, select, a {x}}', { count: 1 })).toBe('{count, select, a {x}}');
  });
});

describe('界面语言', () => {
  it('自动检测按首选语言列表选第一种支持的，中文分简繁', () => {
    expect(matchLocale(['zh-Hans-CN'])).toBe('zh-CN');
    expect(matchLocale(['zh-CN', 'en-US'])).toBe('zh-CN');
    expect(matchLocale(['zh-Hant-TW'])).toBe('zh-TW');
    expect(matchLocale(['zh-HK'])).toBe('zh-TW');
    expect(matchLocale(['zh_TW'])).toBe('zh-TW');
    expect(matchLocale(['zh'])).toBe('zh-CN');
    expect(matchLocale(['ja-JP'])).toBe('ja');
    expect(matchLocale(['pt-BR', 'de-AT', 'en'])).toBe('de');
    expect(matchLocale(['ar-SA'])).toBe('en');
    expect(matchLocale([])).toBe('en');
  });

  it('指定的语言优先于系统语言', () => {
    expect(resolveLocale('fr', ['zh-CN'])).toBe('fr');
    expect(resolveLocale('auto', ['ko-KR'])).toBe('ko');
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

describe.each(LOCALES.filter((locale) => locale !== 'zh-CN'))('%s 目录', (locale) => {
  let catalog: Messages;

  it('与源语言的 key 一一对应，文案非空', async () => {
    catalog = await loadCatalog(locale);
    expect(Object.keys(catalog).sort()).toEqual(Object.keys(zhCN).sort());
    for (const [key, value] of Object.entries(catalog)) expect(value.trim(), key).not.toBe('');
  });

  it('参数与源语言相同，格式化后不留花括号', async () => {
    catalog = await loadCatalog(locale);
    setLocale(locale, catalog);
    for (const key of Object.keys(zhCN) as (keyof typeof zhCN)[]) {
      const names = placeholders(zhCN[key]);
      expect(placeholders(catalog[key]), key).toEqual(names);
      for (const count of [0, 1, 2, 5, 21]) {
        const params = Object.fromEntries(names.map((name) => [name, count]));
        expect(format(catalog[key], params), key).not.toMatch(/[{}]/);
      }
    }
  });
});
