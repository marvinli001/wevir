// 左栏的拖动置顶（照 Claude Code 桌面端）：按住会话行移动 4 px 起拖，行跟着指针走；拖进“置顶”一组时组里让出一格，
// 松开就置顶在那一格；置顶的会话拖出组外时变成“松开取消置顶”的红色标签，松开取消置顶。Esc 取消。拖到列表上下沿时
// 自动滚动。计算在 pin-drag-model.ts。

import { cn } from 'cn';
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { Collapse } from '@/components/collapse';
import { pinnedSessions } from '@/data/session-actions';
import { t } from '@/i18n';
import { createStore } from '@/lib/store';
import {
  applyPinDrop,
  dropTarget,
  inPinZone,
  PIN_ROW_PITCH,
  pinInsertIndex,
  pinLayout,
} from './pin-drag-model';
import { DRAG_DEAD_ZONE_PX } from './splitter-drag';

interface PinDrag {
  sessionId: string;
  title: string;
  wasPinned: boolean;
  /** 指针位置（视口坐标）。 */
  x: number;
  y: number;
  /** 按下时指针在行里的位置，行跟着指针走时保持不变。 */
  grabX: number;
  grabY: number;
  width: number;
  /** 指针在置顶组里。 */
  over: boolean;
  /** 在组里时的插入位置（pin-drag-model.ts 的 pinInsertIndex）。 */
  index: number;
}

const pinDrag = createStore<PinDrag | undefined>(undefined);

/** 正在拖的会话；只在开始与结束时变，行不随指针移动重绘。 */
export function usePinDragId(): string | undefined {
  return useSyncExternalStore(pinDrag.subscribe, () => pinDrag.get()?.sessionId);
}

/** 离列表上下沿这么近时自动滚动。 */
const AUTO_SCROLL_EDGE_PX = 40;
/** 自动滚动每帧最多这么多像素。 */
const AUTO_SCROLL_MAX_PX = 14;

/** 拖到列表上下沿附近时这一帧滚多少（向上为负）；不在沿上时 0。项目拖动（project-drag.tsx）也用。 */
export function edgeScrollStep(pointerY: number, rect: { top: number; bottom: number }): number {
  const above = rect.top + AUTO_SCROLL_EDGE_PX - pointerY;
  const below = pointerY - (rect.bottom - AUTO_SCROLL_EDGE_PX);
  return above > 0
    ? -Math.min(AUTO_SCROLL_MAX_PX, Math.ceil(above / 3))
    : below > 0
      ? Math.min(AUTO_SCROLL_MAX_PX, Math.ceil(below / 3))
      : 0;
}

/** 松开后吞掉紧跟着的那一次点击，免得拖完还打开了会话。 */
export function swallowNextClick(): void {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    window.removeEventListener('click', swallow, true);
  };
  window.addEventListener('click', swallow, true);
  setTimeout(() => window.removeEventListener('click', swallow, true), 0);
}

/** 置顶组里现在列出的会话（按顺序），不含已经不在列表里的（归档、移除）。 */
function listedPins(nav: HTMLElement): string[] {
  return Array.from(
    nav.querySelectorAll<HTMLElement>('[data-pin-list] > li[data-session-id]'),
    (li) => li.dataset.sessionId ?? '',
  );
}

/** 会话行的 onPointerDown：主键按下（不带修饰键、不在行里的按钮上）后开始跟踪。 */
export function beginPinDrag(
  event: ReactPointerEvent<HTMLElement>,
  session: { id: string; title: string },
): void {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
    return;
  }
  if ((event.target as Element).closest('button')) return;
  const row = event.currentTarget;
  const nav = row.closest('nav');
  if (!nav) return;
  const viewport = nav.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
  const pointerId = event.pointerId;
  const start = { x: event.clientX, y: event.clientY };
  const pointer = { ...start };
  let active = false;
  let cancelled = false;
  let frame = 0;

  const hitTest = () => {
    const zone = nav.querySelector<HTMLElement>('[data-pin-zone]');
    const list = nav.querySelector<HTMLElement>('[data-pin-list]');
    let over = false;
    let index = 0;
    if (zone && list) {
      const navRect = nav.getBoundingClientRect();
      const zoneRect = zone.getBoundingClientRect();
      over = inPinZone(pointer, {
        left: navRect.left,
        right: navRect.right,
        top: zoneRect.top,
        bottom: zoneRect.bottom,
      });
      const count = listedPins(nav).filter((id) => id !== session.id).length;
      index = pinInsertIndex(pointer.y, list.getBoundingClientRect().top, count);
    }
    pinDrag.set((current) => current && { ...current, x: pointer.x, y: pointer.y, over, index });
  };

  const autoScroll = () => {
    frame = requestAnimationFrame(autoScroll);
    if (!viewport) return;
    const step = edgeScrollStep(pointer.y, viewport.getBoundingClientRect());
    if (step === 0) return;
    const before = viewport.scrollTop;
    viewport.scrollTop = before + step;
    if (viewport.scrollTop !== before) hitTest();
  };

  const activate = () => {
    active = true;
    const rect = row.getBoundingClientRect();
    pinDrag.set({
      sessionId: session.id,
      title: session.title,
      wasPinned: pinnedSessions.get().includes(session.id),
      x: pointer.x,
      y: pointer.y,
      grabX: start.x - rect.left,
      grabY: start.y - rect.top,
      width: rect.width,
      over: false,
      index: 0,
    });
    document.documentElement.dataset.sidebarDragging = '';
    window.getSelection()?.removeAllRanges();
    frame = requestAnimationFrame(autoScroll);
    hitTest();
  };

  const stopDragging = () => {
    cancelAnimationFrame(frame);
    delete document.documentElement.dataset.sidebarDragging;
    pinDrag.set(undefined);
  };

  const onMove = (move: PointerEvent) => {
    if (move.pointerId !== pointerId || cancelled) return;
    pointer.x = move.clientX;
    pointer.y = move.clientY;
    if (!active) {
      if (Math.hypot(pointer.x - start.x, pointer.y - start.y) < DRAG_DEAD_ZONE_PX) return;
      activate();
      return;
    }
    hitTest();
  };

  const onUp = (up: PointerEvent) => {
    if (up.pointerId !== pointerId) return;
    detach();
    if (!active) return;
    swallowNextClick();
    if (cancelled) return;
    const drag = pinDrag.get();
    stopDragging();
    if (!drag) return;
    const target = dropTarget(drag.over, drag.index, drag.wasPinned);
    const listed = listedPins(nav);
    const next = applyPinDrop(listed, session.id, target);
    if (next === listed) return;
    // 不在列表里的置顶（例如还没加载的项目里的）留在后面，不丢。
    pinnedSessions.set((current) => [
      ...next,
      ...current.filter((id) => id !== session.id && !listed.includes(id)),
    ]);
  };

  const onKey = (key: KeyboardEvent) => {
    if (key.key !== 'Escape' || !active || cancelled) return;
    key.preventDefault();
    key.stopPropagation();
    cancelled = true;
    stopDragging();
  };

  const onBlur = () => {
    detach();
    if (active && !cancelled) stopDragging();
  };

  const detach = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', onBlur);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onBlur);
}

/**
 * “置顶”一组：没有置顶、也没在拖时不显示；拖动中组里的行按 pinLayout 让位（位移过渡），空位是一格淡底。组是空的时拖动
 * 一开始就展开出一格。
 */
export function PinnedGroup<T extends { session: { id: string } }>({
  rows,
  render,
}: {
  rows: readonly T[];
  render: (row: T) => ReactNode;
}) {
  const drag = pinDrag.use();
  const ids = rows.map((row) => row.session.id);
  const layout = pinLayout(
    ids,
    drag && { sessionId: drag.sessionId, over: drag.over, index: drag.index },
  );
  return (
    <Collapse open={rows.length > 0 || drag !== undefined}>
      <section
        aria-labelledby="sidebar-group-pinned"
        data-testid="sidebar-group-pinned"
        data-pin-zone=""
      >
        <h3
          id="sidebar-group-pinned"
          className="flex h-6 items-center px-2 text-xs font-medium text-muted-foreground"
        >
          {t('sidebar.group.pinned')}
        </h3>
        <ul
          data-pin-list=""
          className={cn(
            'relative space-y-px',
            drag && 'transition-[height] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]',
          )}
          style={drag ? { height: Math.max(0, layout.slots * PIN_ROW_PITCH - 1) } : undefined}
        >
          {drag && layout.gap !== undefined && (
            <div
              aria-hidden
              className={cn(
                'absolute inset-x-0 h-8 rounded-lg transition-[top,background-color] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]',
                drag.over ? 'bg-sidebar-accent/60' : 'bg-transparent',
              )}
              style={{ top: layout.gap * PIN_ROW_PITCH }}
            />
          )}
          {rows.map((row, i) => (
            <li
              key={row.session.id}
              data-session-id={row.session.id}
              className={cn(
                'relative',
                drag && 'transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]',
                drag?.sessionId === row.session.id && 'invisible',
              )}
              style={
                drag && layout.shifts[i]
                  ? { transform: `translateY(${(layout.shifts[i] ?? 0) * PIN_ROW_PITCH}px)` }
                  : undefined
              }
            >
              {render(row)}
            </li>
          ))}
        </ul>
      </section>
    </Collapse>
  );
}

/** 跟着指针走的那一行；置顶的会话在组外时换成“松开取消置顶”。挂在 body 上，浮层侧栏的位移不影响它。 */
export function PinDragGhost() {
  const drag = pinDrag.use();
  if (!drag) return null;
  const unpin = drag.wasPinned && !drag.over;
  return createPortal(
    <div aria-hidden className="pointer-events-none fixed inset-0 z-50">
      {unpin ? (
        <div
          className="absolute flex h-7 -translate-x-1/2 -translate-y-1/2 items-center rounded-md bg-destructive px-2.5 text-sm font-medium whitespace-nowrap text-background shadow-lg"
          style={{ left: drag.x, top: drag.y }}
        >
          {t('sidebar.releaseToUnpin')}
        </div>
      ) : (
        <div
          className="absolute flex h-8 items-center gap-2 rounded-lg bg-sidebar-accent px-2 text-base text-sidebar-accent-foreground shadow-lg ring-1 ring-border"
          style={{ left: drag.x - drag.grabX, top: drag.y - drag.grabY, width: drag.width }}
        >
          <span className="w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{drag.title || t('session.untitled')}</span>
        </div>
      )}
    </div>,
    document.body,
  );
}
