// 命令行的文案（2026-10-15）：中文与英文两种目录，t(key, params) 从当前语言的目录取文案并替换参数。源语言是中文
// （zh.ts，key 与参数以它为准），en.ts 满足 `Messages` 类型；i18n.test.ts 核对两种目录的 key 与参数。
//
// 语言：WEVIR_LANG=zh|en 优先；否则按 POSIX 的顺序取 LC_ALL、LC_MESSAGES、LANG 里第一个非空的，zh 开头用中文，
// 其他（含 C / POSIX）用英文；都没有时用英文（维护者 2026-10-15 定，命令行不做桌面端的十种语言）。
//
// 写法与桌面端的 i18n 相同，是 ICU MessageFormat 的子集：`{name}` 是参数；英文要区分单复数时写
// `{count, plural, one {# message} other {# messages}}`（类别按 Intl.PluralRules，另认 `=0` 这类精确值，`#` 是那个数）。

import { en } from './en.js';
import { type MessageKey, type Messages, zh } from './zh.js';

export type { MessageKey, Messages } from './zh.js';

export type Locale = 'zh' | 'en';

type Placeholders<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never;

/** 某条文案需要的参数；没有占位符的文案不接受参数。 */
export type MessageParams<K extends MessageKey> = Record<
  Placeholders<(typeof zh)[K]>,
  string | number
>;

/** 没有占位符的文案 key：按变量取 key 时（标签表等）用它，t() 不需要参数。 */
export type PlainMessageKey = {
  [K in MessageKey]: [Placeholders<(typeof zh)[K]>] extends [never] ? K : never;
}[MessageKey];

type ParamsArg<K extends MessageKey> = [Placeholders<(typeof zh)[K]>] extends [never]
  ? []
  : [params: MessageParams<K>];

type Params = Record<string, string | number>;

const CATALOGS: Record<Locale, Messages> = { zh, en };

/** 按环境变量选语言。 */
export function detectLocale(env: NodeJS.ProcessEnv): Locale {
  const forced = env.WEVIR_LANG?.trim().toLowerCase();
  if (forced?.startsWith('zh')) return 'zh';
  if (forced?.startsWith('en')) return 'en';
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const) {
    const value = env[name]?.trim();
    if (value) return /^zh([_.@-]|$)/i.test(value) ? 'zh' : 'en';
  }
  return 'en';
}

let activeLocale: Locale = detectLocale(process.env);
let messages: Messages = CATALOGS[activeLocale];
let plurals = new Intl.PluralRules(activeLocale);

export function currentLocale(): Locale {
  return activeLocale;
}

/** `Intl` 用的语言标签（时间格式）。 */
export function intlLocale(): string {
  return activeLocale === 'zh' ? 'zh-CN' : 'en-US';
}

/** 换用某种语言（`runCli` 开始时按它的环境变量设；测试里直接设）。 */
export function setLocale(locale: Locale): void {
  activeLocale = locale;
  messages = CATALOGS[locale];
  plurals = new Intl.PluralRules(locale);
}

export function t<K extends MessageKey>(key: K, ...[params]: ParamsArg<K>): string {
  const template = messages[key] ?? zh[key];
  if (!params) return template;
  return format(template, params as Params);
}

/** 列表的连接：中文用顿号，英文用逗号。 */
export function joinList(items: readonly string[]): string {
  return items.join(t('list.separator'));
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
