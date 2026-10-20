import { cn } from 'cn';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ScrollFade } from '@/components/scroll-fade';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { currentLocale, t } from '@/i18n';
import {
  type LanguagePreference,
  LOCALE_NAMES,
  LOCALES,
  readLanguagePreference,
  resolveLocale,
  systemLanguages,
  writeLanguagePreference,
} from '@/i18n/locales';

interface Option {
  value: LanguagePreference;
  /** 列表里的名字：自动检测用界面语言，各语言用它自己的文字。 */
  name: string;
  /** 右侧淡色的名字：这种语言在当前界面语言里的叫法，与自称相同时不写。 */
  localized?: string;
}

/**
 * 设置 → 常规 → 语言（维护者 2026-10-15 定，照 Codex）：按钮写着当前选择，点开是搜索框、“自动检测”与各语言。
 * 选择存在本机；换成另一种语言时重新加载窗口，让所有文案（包括已经算好的）一起换掉。
 */
export function LanguagePicker() {
  const [preference, setPreference] = useState(readLanguagePreference);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const options = useMemo<Option[]>(() => {
    const display = displayNames();
    return [
      { value: 'auto', name: t('settings.language.auto') },
      ...LOCALES.map((locale) => {
        const localized = display?.of(DISPLAY_CODE[locale] ?? locale);
        return {
          value: locale,
          name: LOCALE_NAMES[locale],
          localized: localized && localized !== LOCALE_NAMES[locale] ? localized : undefined,
        };
      }),
    ];
  }, []);

  const needle = query.trim().toLowerCase();
  const visible = options.filter(
    (option) =>
      needle === '' ||
      [option.name, option.localized, option.value].some((text) =>
        text?.toLowerCase().includes(needle),
      ),
  );

  const choose = (next: LanguagePreference) => {
    setOpen(false);
    if (next === preference) return;
    writeLanguagePreference(next);
    setPreference(next);
    if (resolveLocale(next, systemLanguages()) !== currentLocale()) window.location.reload();
  };

  const label = preference === 'auto' ? t('settings.language.auto') : LOCALE_NAMES[preference];

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger
        data-testid="language-picker"
        aria-label={t('settings.appearance.language')}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-input bg-card px-2.5 text-sm outline-none transition-colors hover:bg-muted focus-visible:focus-field aria-expanded:bg-muted"
      >
        <span className="max-w-40 truncate">{label}</span>
        <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-64 gap-0 p-0">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-2.5">
          <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            // biome-ignore lint/a11y/noAutofocus: 打开语言列表就是要找语言。
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              const first = visible[0];
              if (event.key === 'Enter' && first) choose(first.value);
            }}
            placeholder={t('settings.language.search')}
            aria-label={t('settings.language.search')}
            className="h-8 min-w-0 flex-1 bg-transparent px-1.5 text-sm outline-none placeholder:text-muted-foreground"
            data-testid="language-search"
          />
        </div>
        <ScrollFade as="ul" className="max-h-80 overflow-y-auto p-1.5 [--scroll-fade-size:16px]">
          {visible.length === 0 && (
            <li className="px-2 py-6 text-center text-xs text-muted-foreground">
              {t('settings.language.empty')}
            </li>
          )}
          {visible.map((option) => {
            const selected = option.value === preference;
            return (
              <li key={option.value}>
                <button
                  type="button"
                  aria-pressed={selected}
                  data-language={option.value}
                  onClick={() => choose(option.value)}
                  className={cn(
                    'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm outline-none transition-colors duration-150 hover:bg-muted focus-visible:bg-muted',
                    selected && 'font-medium',
                  )}
                >
                  <span
                    className="min-w-0 truncate"
                    lang={option.value === 'auto' ? undefined : option.value}
                  >
                    {option.name}
                  </span>
                  {option.localized && (
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {option.localized}
                    </span>
                  )}
                  {selected && <Check aria-hidden className="ml-auto size-4 shrink-0" />}
                </button>
              </li>
            );
          })}
        </ScrollFade>
      </PopoverContent>
    </Popover>
  );
}

/** 简繁按书写系统取名字（“简体中文”），不按地区（“中文（中国）”）。 */
const DISPLAY_CODE: Partial<Record<string, string>> = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant' };

function displayNames(): Intl.DisplayNames | undefined {
  try {
    return new Intl.DisplayNames([currentLocale()], { type: 'language' });
  } catch {
    return undefined;
  }
}
