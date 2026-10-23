// 手机端的文案：按系统语言从十种里选一种（与桌面同一组），选不到时用英文。

import { de } from './locales/de';
import { en } from './locales/en';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { it } from './locales/it';
import { ja } from './locales/ja';
import { ko } from './locales/ko';
import { ru } from './locales/ru';
import { zhTW } from './locales/zh-TW';
import { type MessageKey, type Messages, zhCN } from './zh-CN';

export type { MessageKey, Messages };

export const LOCALES = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  en,
  de,
  es,
  fr,
  it,
  ja,
  ko,
  ru,
} as const satisfies Record<string, Messages>;

export type Locale = keyof typeof LOCALES;

/** 系统给的语言标签（`zh-Hans-CN`、`zh-Hant-TW`、`pt-BR`…）选最接近的一种。 */
export function pickLocale(tags: readonly string[]): Locale {
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    const [language] = lower.split(/[-_]/);
    if (language === 'zh') {
      return /hant|-tw|-hk|-mo/.test(lower) ? 'zh-TW' : 'zh-CN';
    }
    if (language !== undefined && language in LOCALES) return language as Locale;
  }
  return 'en';
}

let current: Messages = en;
let currentLocale: Locale = 'en';

export function setLocale(locale: Locale): void {
  currentLocale = locale;
  current = LOCALES[locale];
}

export function locale(): Locale {
  return currentLocale;
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = current[key] ?? zhCN[key];
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** 相对时间：刚刚、N 分钟前… */
export function timeAgo(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return t('time.justNow');
  if (minutes < 60) return t('time.minutes', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hours', { n: hours });
  return t('time.days', { n: Math.floor(hours / 24) });
}

/** 文件大小：按 1024 进位，保留一位小数。 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const number = new Intl.NumberFormat(currentLocale, {
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
  return `${number} ${units[unit]}`;
}
