import { cn } from 'cn';
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
} from 'react';
import {
  type CollapsibleSide,
  type DragState,
  dragCancel,
  dragMove,
  IDLE_DRAG,
} from './splitter-drag';

const KEY_STEP = 16;

/**
 * 可拖动的分隔条（R12，由 T5.2 的侧栏拖动条改写）：占两侧之间的间距，悬停或聚焦时显示 1 px 的线。拖动时经
 * onResize 报告从按下起累计的位移（px，向右或向下为正），松开时 onResizeEnd；键盘方向键每次 16 px，双击
 * onReset 回到默认。夹住尺寸、记住结果由调用方做。
 *
 * 交互手感一轮（splitter-drag.ts）：移动不到 4 px 不算拖动，松开时只 onResizeCancel（双击复位不先抖一下）；拖动中
 * 按 Esc 取消，onResizeCancel 后由调用方恢复按下前的尺寸；给了 collapsible 时，那一侧拖过最小尺寸 48 px 就经
 * onCollapseChange 报告折叠，往回拖过 24 px 回滞才展开，松开时 onResizeEnd 带上是否折叠。
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
  onResizeCancel,
  onReset,
  collapsible,
  onCollapseChange,
  className,
  style,
}: {
  /** vertical：竖线，分开左右两侧；horizontal：横线，分开上下。 */
  orientation: 'vertical' | 'horizontal';
  label: string;
  valueNow: number;
  valueMin: number;
  valueMax: number;
  onResizeStart?: () => void;
  onResize: (delta: number) => void;
  onResizeEnd: (delta: number, collapsed: boolean) => void;
  /** 没拖出死区就松开，或拖动中按了 Esc：丢掉草稿，回到按下前。 */
  onResizeCancel?: () => void;
  onReset: () => void;
  /** 拖过最小尺寸能折叠的一侧（before：左或上；after：右或下）。 */
  collapsible?: CollapsibleSide;
  onCollapseChange?: (collapsed: boolean) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const vertical = orientation === 'vertical';
  // 拖动中被卸载（窗格区被快捷键收起、换了会话）：当作取消，调用方不会留着草稿。
  const abortDrag = useRef<() => void>(undefined);
  useEffect(() => () => abortDrag.current?.(), []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const start = vertical ? event.clientX : event.clientY;
    const rule = collapsible ? { side: collapsible, start: valueNow, min: valueMin } : undefined;
    let state: DragState = IDLE_DRAG;
    handle.setPointerCapture(pointerId);
    onResizeStart?.();
    const onMove = (move: globalThis.PointerEvent) => {
      const next = dragMove(state, (vertical ? move.clientX : move.clientY) - start, rule);
      if (next === state) return;
      const collapseChanged = next.collapsed !== state.collapsed;
      state = next;
      if (collapseChanged) onCollapseChange?.(next.collapsed);
      onResize(next.delta);
    };
    const finish = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onEscape, true);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      abortDrag.current = undefined;
    };
    const onUp = () => {
      finish();
      if (state.active) onResizeEnd(state.delta, state.collapsed);
      else onResizeCancel?.();
    };
    // 捕获阶段拦下 Esc：拖动中按它只取消拖动，不再关掉所在的浮层。
    const onEscape = (key: globalThis.KeyboardEvent) => {
      if (key.key !== 'Escape') return;
      key.preventDefault();
      key.stopPropagation();
      state = dragCancel(state);
      finish();
      onResizeCancel?.();
    };
    abortDrag.current = () => {
      finish();
      onResizeCancel?.();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onEscape, true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = vertical ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const index = keys.indexOf(event.key);
    if (index < 0) return;
    event.preventDefault();
    onResizeStart?.();
    onResizeEnd(index === 0 ? -KEY_STEP : KEY_STEP, false);
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
      style={style}
    />
  );
}
