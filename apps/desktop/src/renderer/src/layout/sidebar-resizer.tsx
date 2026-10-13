import type { KeyboardEvent, PointerEvent } from 'react';
import { t } from '@/i18n';
import { LAYOUT } from './layout-rules';

const KEY_STEP = 16;

/**
 * 左栏右缘的拖动条：拖动时经 onDrag 报告新宽度（由调用方按 220–400 夹住），松开时 onCommit 记下；
 * 键盘左右方向键每次 16px，双击恢复默认宽度。
 */
export function SidebarResizer({
  width,
  onDrag,
  onCommit,
}: {
  width: number;
  onDrag: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    let latest = width;
    handle.setPointerCapture(event.pointerId);
    const onMove = (move: globalThis.PointerEvent) => {
      latest = width + move.clientX - startX;
      onDrag(latest);
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      onCommit(latest);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') onCommit(width - KEY_STEP);
    else if (event.key === 'ArrowRight') onCommit(width + KEY_STEP);
    else return;
    event.preventDefault();
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: 可拖动、可聚焦的分隔条是 ARIA 的 separator 控件，<hr> 不能交互。
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('layout.resizeSidebar')}
      aria-valuemin={LAYOUT.sidebarMin}
      aria-valuemax={LAYOUT.sidebarMax}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onCommit(LAYOUT.sidebarDefault)}
      className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:transition-colors hover:after:bg-ring focus-visible:after:bg-ring"
    />
  );
}
