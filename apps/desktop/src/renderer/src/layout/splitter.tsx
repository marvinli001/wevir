import { cn } from 'cn';
import type { KeyboardEvent, PointerEvent } from 'react';

const KEY_STEP = 16;

/**
 * 可拖动的分隔条（R12，由 T5.2 的侧栏拖动条改写）：占两侧之间的间距，悬停或聚焦时显示 1 px 的线。拖动时经
 * onResize 报告从按下起累计的位移（px，向右或向下为正），松开时 onResizeEnd；键盘方向键每次 16 px，双击
 * onReset 回到默认。夹住尺寸、记住结果由调用方做。
 */
export function Splitter({
  orientation,
  label,
  valueNow,
  valueMin,
  valueMax,
  onResizeStart,
  onResize,
  onResizeEnd,
  onReset,
  className,
}: {
  /** vertical：竖线，分开左右两侧；horizontal：横线，分开上下。 */
  orientation: 'vertical' | 'horizontal';
  label: string;
  valueNow: number;
  valueMin: number;
  valueMax: number;
  onResizeStart?: () => void;
  onResize: (delta: number) => void;
  onResizeEnd: (delta: number) => void;
  onReset: () => void;
  className?: string;
}) {
  const vertical = orientation === 'vertical';

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const start = vertical ? event.clientX : event.clientY;
    let delta = 0;
    handle.setPointerCapture(event.pointerId);
    onResizeStart?.();
    const onMove = (move: globalThis.PointerEvent) => {
      delta = (vertical ? move.clientX : move.clientY) - start;
      onResize(delta);
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      onResizeEnd(delta);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = vertical ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const index = keys.indexOf(event.key);
    if (index < 0) return;
    event.preventDefault();
    onResizeStart?.();
    onResizeEnd(index === 0 ? -KEY_STEP : KEY_STEP);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: 可拖动、可聚焦的分隔条是 ARIA 的 separator 控件，<hr> 不能交互。
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuemin={Math.round(valueMin)}
      aria-valuemax={Math.round(valueMax)}
      aria-valuenow={Math.round(valueNow)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className={cn(
        'relative z-10 shrink-0 touch-none outline-none after:absolute after:transition-colors hover:after:bg-ring focus-visible:after:bg-ring',
        vertical
          ? 'w-2 cursor-col-resize after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2'
          : 'h-2 cursor-row-resize after:inset-x-0 after:top-1/2 after:h-px after:-translate-y-1/2',
        className,
      )}
    />
  );
}
