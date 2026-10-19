import { cn } from 'cn';
import { ChevronDown, Copy, Download } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useEffect, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { describe } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import {
  appearanceStore,
  TRANSLUCENT_SIDEBAR_SUPPORTED,
  updateAppearance,
  useAppearance,
} from '@/theme/appearance';
import {
  ACCENTS,
  type AccentId,
  accentSwatch,
  applyTheme,
  CODE_FONT_SIZE,
  CODE_FONTS,
  CONTENT_FONTS,
  type CodeFont,
  type ContentFont,
  clampFontSize,
  DEFAULT_APPEARANCE,
  DEFAULT_COLORS,
  exportTheme,
  matchPreset,
  normalizeColors,
  parseHexColor,
  parseTheme,
  THEME_PRESETS,
  type ThemeSpec,
  UI_FONT_SIZE,
  UI_FONTS,
  type UiFont,
} from '@/theme/appearance-model';
import { setThemeMode, useTheme } from '@/theme/theme';
import type { ResolvedTheme, ThemeMode } from '../../../shared/theme.js';
import { LIST_CARD, type Notice, NoticeBanner, SettingsRow, SettingsSection } from './settings-ui';

const CUSTOM = 'custom';

const UI_FONT_LABEL: Record<UiFont, PlainMessageKey> = {
  default: 'settings.appearance.font.default',
  system: 'settings.appearance.font.system',
};
const CONTENT_FONT_LABEL: Record<ContentFont, PlainMessageKey> = {
  ui: 'settings.appearance.font.sameAsUi',
  system: 'settings.appearance.font.system',
  serif: 'settings.appearance.font.serif',
};
const CODE_FONT_LABEL: Record<CodeFont, PlainMessageKey> = {
  default: 'settings.appearance.font.default',
  system: 'settings.appearance.font.system',
};

/**
 * 设置 → 外观（照 Codex 桌面端的外观页，各项不带说明文字）：模式（三张缩略图）；主题（预设、导入、复制）、强调色、当前模式下的
 * 背景与前景、界面字体；“高级”里是界面字号、代码字体大小、内容字体、代码字体、半透明侧栏（macOS）与对比度，右边“重置为默认设置”。
 * 都只存在本机（theme/appearance.ts），改了立即生效。
 */
export function AppearanceSettings() {
  const { mode, resolved } = useTheme();
  const appearance = useAppearance();
  const [advancedOpen, setAdvancedOpen] = useState(true);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<Notice>();

  useEffect(() => {
    if (notice?.tone !== 'success') return;
    const timer = setTimeout(() => setNotice(undefined), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  const preset = matchPreset(appearance);
  const colors = {
    background: appearance[resolved].background ?? DEFAULT_COLORS[resolved].background,
    foreground: appearance[resolved].foreground ?? DEFAULT_COLORS[resolved].foreground,
  };
  const setColor = (key: 'background' | 'foreground', value: string) =>
    updateAppearance({
      [resolved]: normalizeColors(resolved, { ...appearance[resolved], [key]: value }),
    });
  const isDefault = JSON.stringify(appearance) === JSON.stringify(DEFAULT_APPEARANCE);

  const copyTheme = async () => {
    try {
      await window.wevir.copyText(exportTheme(appearance));
      setNotice({ tone: 'success', text: t('settings.appearance.themeCopied') });
    } catch (reason) {
      setNotice({ tone: 'error', text: describe(reason) });
    }
  };

  return (
    <>
      {notice && (
        <div className="mb-4">
          <NoticeBanner notice={notice} />
        </div>
      )}
      <SettingsSection title={t('settings.section.visual')}>
        <div className="space-y-3">
          <div className={LIST_CARD}>
            <SettingsRow
              title={t('settings.appearance.mode')}
              data-setting="theme-mode"
              control={<ModePicker value={mode} onChange={setThemeMode} />}
            />
          </div>
          <div className={LIST_CARD}>
            <SettingsRow
              title={t('settings.appearance.theme')}
              data-setting="theme-preset"
              control={
                <>
                  <IconButton
                    label={t('settings.appearance.importTheme')}
                    onClick={() => setImporting(true)}
                  >
                    <Download />
                  </IconButton>
                  <IconButton
                    label={t('settings.appearance.copyTheme')}
                    onClick={() => void copyTheme()}
                  >
                    <Copy />
                  </IconButton>
                  <Select
                    className="ml-1 w-40 rounded-full"
                    aria-label={t('settings.appearance.theme')}
                    value={preset?.id ?? CUSTOM}
                    onValueChange={(id) => {
                      const next = THEME_PRESETS.find((candidate) => candidate.id === id);
                      if (next) appearanceStore.set((current) => applyTheme(current, next));
                    }}
                    options={[
                      ...THEME_PRESETS.map((candidate) => ({
                        value: candidate.id,
                        label: candidate.name,
                        icon: <ThemeBadge theme={candidate} resolved={resolved} />,
                      })),
                      ...(preset
                        ? []
                        : [
                            {
                              value: CUSTOM,
                              label: t('settings.appearance.custom'),
                              icon: <ThemeBadge theme={appearance} resolved={resolved} />,
                            },
                          ]),
                    ]}
                  />
                </>
              }
            />
            <SettingsRow
              title={t('settings.appearance.accent')}
              data-setting="accent"
              control={
                <Select<AccentId>
                  className="w-32 rounded-full"
                  aria-label={t('settings.appearance.accent')}
                  value={appearance.accent}
                  onValueChange={(accent) => updateAppearance({ accent })}
                  options={ACCENTS.map((accent) => ({
                    value: accent,
                    label: t(`settings.appearance.accent.${accent}`),
                    icon: <Swatch color={accentSwatch(accent, resolved)} />,
                  }))}
                />
              }
            />
            <SettingsRow
              title={t('settings.appearance.background')}
              data-setting="background"
              control={
                <ColorField
                  label={t('settings.appearance.background')}
                  value={colors.background}
                  onChange={(value) => setColor('background', value)}
                />
              }
            />
            <SettingsRow
              title={t('settings.appearance.foreground')}
              data-setting="foreground"
              control={
                <ColorField
                  label={t('settings.appearance.foreground')}
                  value={colors.foreground}
                  onChange={(value) => setColor('foreground', value)}
                />
              }
            />
            <SettingsRow
              title={t('settings.appearance.font')}
              data-setting="ui-font"
              control={
                <Select<UiFont>
                  className="w-28 rounded-full"
                  aria-label={t('settings.appearance.font')}
                  value={appearance.uiFont}
                  onValueChange={(uiFont) => updateAppearance({ uiFont })}
                  options={UI_FONTS.map((font) => ({ value: font, label: t(UI_FONT_LABEL[font]) }))}
                />
              }
            />
          </div>
        </div>
      </SettingsSection>

      <section className="mb-9 last:mb-0">
        <div className="mb-2.5 flex items-center gap-4">
          <button
            type="button"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
            className="-ml-1 inline-flex items-center gap-1 rounded-md px-1 text-sm font-semibold outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {t('settings.appearance.advanced')}
            <ChevronDown
              aria-hidden
              className={cn(
                'size-3.5 text-muted-foreground transition-transform duration-200 ease-smooth',
                !advancedOpen && '-rotate-90',
              )}
            />
          </button>
          <span className="flex-1" />
          <button
            type="button"
            disabled={isDefault}
            onClick={() => appearanceStore.set(DEFAULT_APPEARANCE)}
            data-action="reset-appearance"
            className="rounded-md px-1 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
          >
            {t('settings.appearance.reset')}
          </button>
        </div>
        {advancedOpen && (
          <div className="space-y-3 animate-in fade-in slide-in-from-top-1 duration-200 ease-smooth">
            <div className={LIST_CARD}>
              <SettingsRow
                title={t('settings.appearance.uiFontSize')}
                data-setting="ui-font-size"
                control={
                  <PxField
                    label={t('settings.appearance.uiFontSize')}
                    value={appearance.uiFontSize}
                    range={UI_FONT_SIZE}
                    onChange={(uiFontSize) =>
                      updateAppearance({ uiFontSize: clampFontSize(uiFontSize, 'ui') })
                    }
                  />
                }
              />
              <SettingsRow
                title={t('settings.appearance.codeFontSize')}
                data-setting="code-font-size"
                control={
                  <PxField
                    label={t('settings.appearance.codeFontSize')}
                    value={appearance.codeFontSize}
                    range={CODE_FONT_SIZE}
                    onChange={(codeFontSize) =>
                      updateAppearance({ codeFontSize: clampFontSize(codeFontSize, 'code') })
                    }
                  />
                }
              />
            </div>
            <div className={LIST_CARD}>
              <SettingsRow
                title={t('settings.appearance.contentFont')}
                data-setting="content-font"
                control={
                  <Select<ContentFont>
                    className="w-44 rounded-full"
                    aria-label={t('settings.appearance.contentFont')}
                    value={appearance.contentFont}
                    onValueChange={(contentFont) => updateAppearance({ contentFont })}
                    options={CONTENT_FONTS.map((font) => ({
                      value: font,
                      label: t(CONTENT_FONT_LABEL[font]),
                    }))}
                  />
                }
              />
              <SettingsRow
                title={t('settings.appearance.codeFont')}
                data-setting="code-font"
                control={
                  <Select<CodeFont>
                    className="w-28 rounded-full"
                    aria-label={t('settings.appearance.codeFont')}
                    value={appearance.codeFont}
                    onValueChange={(codeFont) => updateAppearance({ codeFont })}
                    options={CODE_FONTS.map((font) => ({
                      value: font,
                      label: t(CODE_FONT_LABEL[font]),
                    }))}
                  />
                }
              />
              {TRANSLUCENT_SIDEBAR_SUPPORTED && (
                <SettingsRow
                  title={t('settings.appearance.translucentSidebar')}
                  data-setting="translucent-sidebar"
                  control={
                    <Switch
                      label={t('settings.appearance.translucentSidebar')}
                      checked={appearance.translucentSidebar}
                      onChange={(translucentSidebar) => updateAppearance({ translucentSidebar })}
                    />
                  }
                />
              )}
              <SettingsRow
                title={t('settings.appearance.contrast')}
                data-setting="contrast"
                control={
                  <>
                    <Slider
                      min={0}
                      max={100}
                      step={1}
                      value={appearance.contrast}
                      aria-label={t('settings.appearance.contrast')}
                      onValueChange={(contrast) => updateAppearance({ contrast })}
                    />
                    <span className="w-7 text-right text-sm tabular-nums">
                      {appearance.contrast}
                    </span>
                  </>
                }
              />
            </div>
          </div>
        )}
      </section>

      <ImportThemeDialog
        open={importing}
        onOpenChange={setImporting}
        onImport={(theme) => {
          appearanceStore.set((current) => applyTheme(current, theme));
          setNotice(undefined);
        }}
      />
    </>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="block size-3 rounded-full ring-1 ring-foreground/15"
      style={{ background: color }}
    />
  );
}

/** 主题选择框里的小图标：主题在当前模式下的底色，上面用强调色写 Aa。 */
function ThemeBadge({ theme, resolved }: { theme: ThemeSpec; resolved: ResolvedTheme }) {
  const background = theme[resolved].background ?? DEFAULT_COLORS[resolved].background;
  const color =
    theme.accent === 'ink'
      ? (theme[resolved].foreground ?? DEFAULT_COLORS[resolved].foreground)
      : accentSwatch(theme.accent, resolved);
  return (
    <span
      aria-hidden
      className="flex size-4.5 items-center justify-center rounded-full text-[9px] leading-none font-semibold ring-1 ring-foreground/15"
      style={{ background, color }}
    >
      Aa
    </span>
  );
}

// 模式的缩略图（照 Codex 的三张小窗口）：画的是固定的浅色、深色界面，所以直接取 palette.css 的原始色，不随当前主题变。
const PREVIEW: Record<ResolvedTheme, Record<'bg' | 'sidebar' | 'line' | 'strong', string>> = {
  light: {
    bg: 'var(--ivory-1)',
    sidebar: 'var(--ivory-4)',
    line: 'var(--ivory-6)',
    strong: 'var(--sky-vivid)',
  },
  dark: {
    bg: 'var(--graphite-4)',
    sidebar: 'var(--graphite-1)',
    line: 'var(--graphite-7)',
    strong: 'var(--sky-soft)',
  },
};

function MiniWindow({ tone, className }: { tone: ResolvedTheme; className?: string }) {
  const c = PREVIEW[tone];
  const bar = (width: string, color: string, extra?: string) => (
    <span className={cn('block h-1 rounded-full', extra)} style={{ width, background: color }} />
  );
  return (
    <span className={cn('absolute inset-0 flex', className)} style={{ background: c.bg }}>
      <span className="flex w-[28%] flex-col gap-1 p-1.5" style={{ background: c.sidebar }}>
        <span className="mb-0.5 block size-1.5 rounded-full" style={{ background: c.line }} />
        {bar('80%', c.line)}
        {bar('60%', c.line)}
        {bar('70%', c.line)}
      </span>
      <span className="flex flex-1 flex-col gap-1 p-2">
        {bar('45%', c.strong, 'ml-auto')}
        {bar('80%', c.line)}
        {bar('65%', c.line)}
        {bar('35%', c.strong, 'ml-auto')}
        <span className="mt-auto block h-2.5 rounded-xs border" style={{ borderColor: c.line }} />
      </span>
    </span>
  );
}

const MODE_LABEL: Record<ThemeMode, PlainMessageKey> = {
  system: 'settings.appearance.theme.system',
  light: 'settings.appearance.theme.light',
  dark: 'settings.appearance.theme.dark',
};

function ModePicker({
  value,
  onChange,
}: {
  value: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}) {
  return (
    <fieldset className="flex gap-2.5">
      <legend className="sr-only">{t('settings.appearance.mode')}</legend>
      {(['system', 'light', 'dark'] as const).map((mode) => {
        const checked = mode === value;
        return (
          <Tooltip key={mode}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-pressed={checked}
                  aria-label={t(MODE_LABEL[mode])}
                  data-segment={mode}
                  onClick={() => onChange(mode)}
                  className={cn(
                    'relative h-12 w-19 overflow-hidden rounded-lg outline-none transition-[box-shadow,transform] duration-150 ease-smooth active:scale-[0.97] focus-visible:ring-offset-2 focus-visible:ring-offset-card',
                    checked
                      ? 'ring-2 ring-ring'
                      : 'ring-1 ring-border-strong hover:ring-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/60',
                  )}
                />
              }
            >
              {mode === 'system' ? (
                <>
                  <MiniWindow tone="light" />
                  <MiniWindow tone="dark" className="[clip-path:inset(0_0_0_50%)]" />
                </>
              ) : (
                <MiniWindow tone={mode} />
              )}
            </TooltipTrigger>
            <TooltipContent>{t(MODE_LABEL[mode])}</TooltipContent>
          </Tooltip>
        );
      })}
    </fieldset>
  );
}

/** 颜色：左边的圆点打开系统的取色器，右边可以直接改十六进制（回车或离开时生效，认不出时恢复）。 */
function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value.toUpperCase());
  useEffect(() => setDraft(value.toUpperCase()), [value]);
  const commit = () => {
    const parsed = parseHexColor(draft);
    if (parsed !== undefined && parsed !== value.toLowerCase()) onChange(parsed);
    else setDraft(value.toUpperCase());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') event.currentTarget.blur();
    if (event.key === 'Escape') {
      setDraft(value.toUpperCase());
      event.currentTarget.blur();
    }
  };
  return (
    <div className="flex h-8 w-32 items-center gap-2 rounded-full border border-input bg-card pr-3 pl-1.5 transition-colors focus-within:border-ring-soft focus-within:ring-2 focus-within:ring-ring/12">
      <span
        className="relative size-5 shrink-0 overflow-hidden rounded-full ring-1 ring-foreground/15"
        style={{ background: value }}
      >
        <input
          type="color"
          tabIndex={-1}
          aria-hidden
          value={value}
          onChange={(event) => onChange(event.target.value.toLowerCase())}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </span>
      <input
        aria-label={label}
        value={draft}
        spellCheck={false}
        maxLength={7}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        className="min-w-0 flex-1 bg-transparent font-mono text-xs uppercase outline-none"
      />
    </div>
  );
}

/** 字号：整数 px，超出范围的按边界算；输入中途不合法时先不改，离开时恢复。 */
function PxField({
  label,
  value,
  range,
  onChange,
}: {
  label: string;
  value: number;
  range: { min: number; max: number };
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const parsed = (text: string) => {
    const number = Number(text);
    return text.trim() !== '' && Number.isInteger(number) ? number : undefined;
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        inputMode="numeric"
        min={range.min}
        max={range.max}
        step={1}
        aria-label={label}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          const number = parsed(event.target.value);
          if (number !== undefined && number >= range.min && number <= range.max) onChange(number);
        }}
        onBlur={() => {
          const number = parsed(draft);
          if (number === undefined) setDraft(String(value));
          else {
            const clamped = Math.min(range.max, Math.max(range.min, number));
            onChange(clamped);
            setDraft(String(clamped));
          }
        }}
        onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        className="h-8 w-16 text-right tabular-nums"
      />
      <span className="text-sm text-muted-foreground">px</span>
    </div>
  );
}

function ImportThemeDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (theme: ThemeSpec) => void;
}) {
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    if (!open) return;
    setText('');
    setInvalid(false);
  }, [open]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const theme = parseTheme(text);
    if (!theme) {
      setInvalid(true);
      return;
    }
    onImport(theme);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>{t('settings.appearance.importTheme')}</DialogTitle>
          </DialogHeader>
          <Textarea
            autoFocus
            value={text}
            spellCheck={false}
            placeholder={t('settings.appearance.importHint')}
            aria-label={t('settings.appearance.importTheme')}
            aria-invalid={invalid || undefined}
            onChange={(event) => {
              setText(event.target.value);
              setInvalid(false);
            }}
            className="min-h-40 font-mono text-xs"
          />
          {invalid && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">
              {t('settings.appearance.importInvalid')}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={text.trim() === ''}>
              {t('settings.appearance.import')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
