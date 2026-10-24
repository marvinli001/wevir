import { cn } from 'cn';
import { Ban, Check, ImagePlus } from 'lucide-react';
import { useRef } from 'react';
import { type PlainMessageKey, t } from '@/i18n';
import { loadBackdropImage } from './backdrop';
import { BACKDROP_PRESETS, type BackdropPreset, type ProjectBackdrop } from './backdrop-model';

const PRESET_LABEL: Record<BackdropPreset, PlainMessageKey> = {
  dawn: 'project.backdrop.dawn',
  mist: 'project.backdrop.mist',
  sage: 'project.backdrop.sage',
  dusk: 'project.backdrop.dusk',
  ember: 'project.backdrop.ember',
};

const SWATCH =
  'relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-input bg-card text-muted-foreground outline-none transition-[border-color,transform] duration-150 ease-smooth hover:border-border-strong active:scale-95 focus-visible:focus-ring';

/**
 * 编辑项目里的“背景”（backdrop-model.ts）：无、几种预设光晕、自定义图片。色板的底同卡片顶上的背景（index.css 的 --backdrop），
 * 选中的打勾。选图片走隐藏的文件输入框，缩成 JPEG 后交给 onChange；读不出来时 onError。
 */
export function BackdropPicker({
  value,
  onChange,
  onError,
}: {
  value: ProjectBackdrop | undefined;
  onChange: (backdrop: ProjectBackdrop | undefined) => void;
  onError: (message: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    try {
      onChange({ kind: 'image', src: await loadBackdropImage(file) });
    } catch {
      onError(t('project.backdrop.imageFailed'));
    }
  };
  const mark = <Check aria-hidden className="size-4 text-foreground drop-shadow-sm" />;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        aria-pressed={value === undefined}
        aria-label={t('project.backdrop.none')}
        title={t('project.backdrop.none')}
        className={cn(SWATCH, value === undefined && 'border-foreground')}
        onClick={() => onChange(undefined)}
      >
        {value === undefined ? mark : <Ban aria-hidden className="size-4" />}
      </button>
      {BACKDROP_PRESETS.map((preset) => {
        const selected = value?.kind === 'preset' && value.preset === preset;
        return (
          <button
            key={preset}
            type="button"
            aria-pressed={selected}
            aria-label={t(PRESET_LABEL[preset])}
            title={t(PRESET_LABEL[preset])}
            data-backdrop={preset}
            className={cn(SWATCH, 'backdrop-swatch', selected && 'border-foreground')}
            onClick={() => onChange({ kind: 'preset', preset })}
          >
            {selected && mark}
          </button>
        );
      })}
      <button
        type="button"
        aria-pressed={value?.kind === 'image'}
        aria-label={t('project.backdrop.image')}
        title={t('project.backdrop.image')}
        className={cn(SWATCH, value?.kind === 'image' && 'border-foreground')}
        onClick={() => input.current?.click()}
      >
        {value?.kind === 'image' ? (
          <>
            <img src={value.src} alt="" className="absolute inset-0 size-full object-cover" />
            <span className="relative">{mark}</span>
          </>
        ) : (
          <ImagePlus aria-hidden className="size-4" />
        )}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(event) => {
          void pick(event.currentTarget.files?.[0]);
          event.currentTarget.value = '';
        }}
      />
    </div>
  );
}
