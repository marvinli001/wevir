// 界面语言（维护者 2026-10-15 定）：默认自动检测，可在设置 → 常规里指定。支持的语言与它们的自称在这里，
// 选择存在本机（wevir.language.v1），启动时在第一次渲染之前解析并加载对应目录（i18n/index.ts 的 initI18n）。

export const LOCALES = ['en', 'zh-CN', 'zh-TW', 'fr', 'de', 'it', 'es', 'ja', 'ko', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];

/** 设置里的选择：`auto` 跟随系统语言。 */
export type LanguagePreference = 'auto' | Locale;

/** 每种语言用它自己的文字写名字，不随界面语言变，选错了语言也认得出来。 */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  es: 'Español',
  ja: '日本語',
  ko: '한국어',
  ru: 'Русский',
};

/** 系统语言不在支持之列时用英语。 */
export const FALLBACK_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * 按系统的首选语言列表（BCP 47，如 `navigator.languages`）选第一种支持的：中文按书写系统分简繁
 * （`zh-Hant`，或台湾、香港、澳门地区记为繁体），其余只看语言子标签。都不支持时用英语。
 */
export function matchLocale(tags: readonly string[]): Locale {
  for (const tag of tags) {
    const parts = tag.toLowerCase().replace(/_/g, '-').split('-');
    const language = parts[0];
    if (language === 'zh') {
      const traditional =
        parts.includes('hant') || parts.some((p) => ['tw', 'hk', 'mo'].includes(p));
      const simplified = parts.includes('hans');
      return traditional && !simplified ? 'zh-TW' : 'zh-CN';
    }
    const match = LOCALES.find((locale) => locale === language);
    if (match) return match;
  }
  return FALLBACK_LOCALE;
}

export function resolveLocale(preference: LanguagePreference, system: readonly string[]): Locale {
  return preference === 'auto' ? matchLocale(system) : preference;
}

const STORAGE_KEY = 'wevir.language.v1';

export function readLanguagePreference(): LanguagePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isLocale(stored) ? stored : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeLanguagePreference(preference: LanguagePreference): void {
  try {
    if (preference === 'auto') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // 存不下时只影响下次启动。
  }
}

export function systemLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}
