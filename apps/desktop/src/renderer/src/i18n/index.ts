// 文案模块（T5.2；多语言 2026-10-15）：t(key, params) 从当前语言的目录取文案并替换参数。源语言是简体中文
// （zh-CN.ts，key 与参数以它为准），其他语言的目录在 locales/，启动时只加载用到的那一个。
//
// 写法是 ICU MessageFormat 的子集：`{name}` 是参数；要区分单复数的语言写
// `{count, plural, one {# file} other {# files}}`（类别按 Intl.PluralRules，另认 `=0` 这类精确值，`#` 是那个数）。

import {
  type LanguagePreference,
  type Locale,
  readLanguagePreference,
  resolveLocale,
  systemLanguages,
} from './locales.js';
import { type MessageKey, type Messages, zhCN } from './zh-CN.js';

export type { MessageKey, Messages } from './zh-CN.js';

type Placeholders<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never;

/** 某条文案需要的参数；没有占位符的文案不接受参数。 */
export type MessageParams<K extends MessageKey> = Record<
  Placeholders<(typeof zhCN)[K]>,
  string | number
>;

/** 没有占位符的文案 key：按变量取 key 时（标签表等）用它，t() 不需要参数。 */
export type PlainMessageKey = {
  [K in MessageKey]: [Placeholders<(typeof zhCN)[K]>] extends [never] ? K : never;
}[MessageKey];

type ParamsArg<K extends MessageKey> = [Placeholders<(typeof zhCN)[K]>] extends [never]
  ? []
  : [params: MessageParams<K>];

type Params = Record<string, string | number>;

const loaders: Record<Exclude<Locale, 'zh-CN'>, () => Promise<{ messages: Messages }>> = {
  en: () => import('./locales/en.js'),
  'zh-TW': () => import('./locales/zh-TW.js'),
  fr: () => import('./locales/fr.js'),
  de: () => import('./locales/de.js'),
  it: () => import('./locales/it.js'),
  es: () => import('./locales/es.js'),
  ja: () => import('./locales/ja.js'),
  ko: () => import('./locales/ko.js'),
  ru: () => import('./locales/ru.js'),
};

let activeLocale: Locale = 'zh-CN';
let messages: Messages = zhCN;
let plurals = new Intl.PluralRules('zh-CN');

export function currentLocale(): Locale {
  return activeLocale;
}

export async function loadCatalog(locale: Locale): Promise<Messages> {
  return locale === 'zh-CN' ? zhCN : (await loaders[locale]()).messages;
}

/** 换用某种语言的目录（测试与启动用；界面里换语言会重新加载窗口，见 settings/language-picker.tsx）。 */
export function setLocale(locale: Locale, catalog: Messages): void {
  activeLocale = locale;
  messages = catalog;
  plurals = new Intl.PluralRules(locale);
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}

/** 启动时、第一次渲染之前调用：按设置或系统语言加载目录，加载失败时留在简体中文。 */
export async function initI18n(
  preference: LanguagePreference = readLanguagePreference(),
): Promise<Locale> {
  const locale = resolveLocale(preference, systemLanguages());
  try {
    setLocale(locale, await loadCatalog(locale));
  } catch (error) {
    console.error('无法加载界面语言', locale, error);
    setLocale('zh-CN', zhCN);
  }
  return activeLocale;
}

export function t<K extends MessageKey>(key: K, ...[params]: ParamsArg<K>): string {
  const template = messages[key] ?? zhCN[key];
  if (!params) return template;
  return format(template, params as Params);
}

/** 按 ICU 子集替换参数；认不出的花括号原样保留，参数值里的花括号不再替换。 */
export function format(template: string, params: Params): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf('{', i);
    if (open === -1) break;
    const close = matchingBrace(template, open);
    if (close === -1) break;
    out += template.slice(i, open);
    out += argument(template.slice(open + 1, close), params) ?? template.slice(open, close + 1);
    i = close + 1;
  }
  return out + template.slice(i);
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

function argument(body: string, params: Params): string | undefined {
  const simple = /^\s*(\w+)\s*$/.exec(body);
  if (simple) {
    const name = simple[1] as string;
    return name in params ? String(params[name]) : undefined;
  }
  const plural = /^\s*(\w+)\s*,\s*plural\s*,/.exec(body);
  if (!plural) return undefined;
  const name = plural[1] as string;
  if (!(name in params)) return undefined;
  const value = Number(params[name]);
  const options = pluralOptions(body.slice(plural[0].length));
  const chosen =
    options.get(`=${value}`) ?? options.get(plurals.select(value)) ?? options.get('other');
  if (chosen === undefined) return undefined;
  return format(chosen.replace(/#/g, String(params[name])), params);
}

function pluralOptions(text: string): Map<string, string> {
  const options = new Map<string, string>();
  let i = 0;
  while (i < text.length) {
    const selector = /^\s*(=\d+|zero|one|two|few|many|other)\s*\{/.exec(text.slice(i));
    if (!selector) break;
    const open = i + selector[0].length - 1;
    const close = matchingBrace(text, open);
    if (close === -1) break;
    options.set(selector[1] as string, text.slice(open + 1, close));
    i = close + 1;
  }
  return options;
}
