// 听写（0.89.0）的界面，照 Codex 桌面端：空闲时发送键左边是麦克风按钮，按住说话、松开转写，点一下开始、再点结束
// （use-dictation.ts）。录音开始后底栏换成录音条：左边 ✕ 丢掉，中间是从右往左走的波形（安静处是一排点），右边是停止键（转写后
// 放进输入框）；发送键留在原处（转写后连同输入框里的文字一起发出，composer.tsx）。

import { cn } from 'cn';
import { LoaderCircle, Mic, Square, X } from 'lucide-react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/i18n';
import { formatShortcut, SHORTCUTS } from '@/lib/shortcuts';
import { DICTATION_LEVELS_MAX } from './dictation-model';
import type { Dictation } from './use-dictation';

const ROUND =
  'relative flex size-8 shrink-0 items-center justify-center rounded-full outline-none transition-colors duration-150 focus-visible:focus-ring disabled:opacity-40';

/** 空闲时的麦克风按钮。按下后底栏换成录音条、按钮随之卸载，所以松开在 window 上等。 */
export function DictationButton({
  dictation,
  disabled,
}: {
  dictation: Dictation;
  disabled: boolean;
}) {
  const label = t('dictation.start');
  const pressFor = (releaseOn: 'pointerup' | 'keyup', key?: string) => {
    dictation.press();
    const onRelease = (event: Event) => {
      if (key !== undefined && (event as globalThis.KeyboardEvent).key !== key) return;
      window.removeEventListener(releaseOn, onRelease, true);
      dictation.release();
    };
    window.addEventListener(releaseOn, onRelease, true);
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || disabled) return;
    // 不让按钮拿走焦点：文字要放回输入框的光标处。
    event.preventDefault();
    pressFor('pointerup');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key !== 'Enter' && event.key !== ' ') || event.repeat) return;
    event.preventDefault();
    if (!disabled) pressFor('keyup', event.key);
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            data-testid="composer-dictation"
            data-phase="idle"
            onPointerDown={onPointerDown}
            onKeyDown={onKeyDown}
            // 点击由 pointer 事件处理；屏幕阅读器的“激活”没有 pointer 事件，按点一下的方式处理。
            onClick={(event) => {
              if (event.detail !== 0 || disabled) return;
              dictation.press();
              dictation.release();
            }}
            className={cn(ROUND, 'text-muted-foreground hover:bg-muted hover:text-foreground')}
          />
        }
      >
        <Mic aria-hidden className="size-4" />
      </TooltipTrigger>
      <TooltipContent>
        {label}
        <kbd className="ml-1.5 font-sans opacity-70">{formatShortcut(SHORTCUTS.dictation)}</kbd>
      </TooltipContent>
    </Tooltip>
  );
}

/** 录音条：✕、波形、停止键。转写时波形停住变淡，停止键转圈。 */
export function DictationBar({ dictation }: { dictation: Dictation }) {
  const transcribing = dictation.phase === 'transcribing';
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2" data-testid="composer-dictation-bar">
      <RoundButton
        label={t('dictation.cancel')}
        shortcut="Esc"
        disabled={transcribing}
        onClick={dictation.cancel}
        data-dictation-action="cancel"
      >
        <X aria-hidden className="size-4" />
      </RoundButton>
      <Waveform levels={dictation.levels} dimmed={transcribing} />
      <RoundButton
        label={transcribing ? t('dictation.transcribing') : t('dictation.stop')}
        disabled={transcribing}
        onClick={dictation.stop}
        data-testid="composer-dictation"
        data-phase={dictation.phase}
        data-dictation-action="stop"
      >
        {transcribing ? (
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
        ) : (
          <Square aria-hidden className="size-3 fill-current" />
        )}
      </RoundButton>
    </div>
  );
}

function RoundButton({
  label,
  shortcut,
  disabled,
  onClick,
  children,
  ...rest
}: {
  label: string;
  shortcut?: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
} & Record<`data-${string}`, string>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            // 不拿走输入框的焦点。
            onPointerDown={(event) => event.preventDefault()}
            onClick={onClick}
            className={cn(ROUND, 'bg-muted text-foreground hover:bg-accent')}
            {...rest}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <kbd className="ml-1.5 font-sans opacity-70">{shortcut}</kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * 波形：每格一根 2 px 的竖条，最新的在最右边，往左推；没录到的格子和安静处都是点。格子总数固定，放不下的从左边裁掉，
 * 所以输入框多宽都铺满。
 */
function Waveform({ levels, dimmed }: { levels: readonly number[]; dimmed: boolean }) {
  const padded = Array.from(
    { length: DICTATION_LEVELS_MAX },
    (_, i) => levels[levels.length - DICTATION_LEVELS_MAX + i] ?? 0,
  );
  return (
    <div
      aria-hidden
      className={cn(
        'flex h-6 min-w-0 flex-1 items-center justify-end gap-[3px] overflow-hidden transition-opacity duration-200',
        dimmed && 'opacity-40',
      )}
    >
      {padded.map((level, i) => (
        <span
          // 格子按位置排，位置固定。
          // biome-ignore lint/suspicious/noArrayIndexKey: 每格只是一个位置。
          key={i}
          className={cn(
            'w-[2px] shrink-0 rounded-full',
            level < 0.12 ? 'bg-muted-foreground/45' : 'bg-foreground/70',
          )}
          style={{ height: level < 0.12 ? 2 : `${Math.round(4 + level * 20)}px` }}
        />
      ))}
    </div>
  );
}
