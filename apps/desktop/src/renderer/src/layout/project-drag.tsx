// 左栏项目的拖动排序：按住项目标题移动 4 px 起拖，标题跟着指针走，列表里一条横线标出松开后落在哪；松开就记下新的顺序
// （本机，workspace-actions.ts 的 projectOrder）。置顶的项目只在置顶的之间换位置。Esc 取消；拖到列表上下沿时自动滚动。
// 计算在 project-drag-model.ts，指针跟踪的做法同 pin-drag.tsx。

import { Folder } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { pinnedWorkspaces, reorderProjects } from '@/data/workspace-actions';
import { createStore } from '@/lib/store';
import { edgeScrollStep, swallowNextClick } from './pin-drag';
import { moveProject, projectDropIndex, projectInsertIndex } from './project-drag-model';
import { DRAG_DEAD_ZONE_PX } from './splitter-drag';

interface ProjectDrag {
  workspaceId: string;
  title: string;
  /** 指针位置（视口坐标）。 */
  x: number;
  y: number;
  /** 按下时指针在标题里的位置。 */
  grabX: number;
  grabY: number;
  width: number;
  /** 去掉被拖的那一个之后的插入位置（已夹在它那一段里）。 */
  index: number;
  /** 插入线相对项目列表上沿的位置；落下不改变顺序时 undefined。 */
  lineTop: number | undefined;
}

const projectDrag = createStore<ProjectDrag | undefined>(undefined);

/** 正在拖的项目；只在开始与结束时变。 */
export function useProjectDragId(): string | undefined {
  return useSyncExternalStore(projectDrag.subscribe, () => projectDrag.get()?.workspaceId);
}

/** 项目列表里的项目行（按顺序）。 */
function projectRows(list: HTMLElement): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>(':scope > li[data-project-row]'));
}

/** 项目标题的 onPointerDown：主键按在标题上（不带修饰键、不在“新会话”按钮上）后开始跟踪。 */
export function beginProjectDrag(
  event: ReactPointerEvent<HTMLElement>,
  project: { id: string; title: string },
): void {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
    return;
  }
  const header = event.currentTarget;
  if ((event.target as Element).closest('button') !== header) return;
  const list = header.closest<HTMLElement>('[data-project-list]');
  if (!list) return;
  const viewport = list.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
  const pointerId = event.pointerId;
  const start = { x: event.clientX, y: event.clientY };
  const pointer = { ...start };
  let active = false;
  let cancelled = false;
  let frame = 0;

  const listed = () => projectRows(list).map((li) => li.dataset.projectRow ?? '');

  const hitTest = () => {
    const rows = projectRows(list);
    const ids = rows.map((li) => li.dataset.projectRow ?? '');
    const others = rows.filter((li) => li.dataset.projectRow !== project.id);
    const midlines = others.map((li) => {
      const rect = (li.querySelector('[data-project-id]') ?? li).getBoundingClientRect();
      return (rect.top + rect.bottom) / 2;
    });
    const pinned = pinnedWorkspaces.get();
    const index = projectDropIndex(
      ids,
      pinned,
      project.id,
      projectInsertIndex(pointer.y, midlines),
    );
    let lineTop: number | undefined;
    if (moveProject(ids, pinned, project.id, index) !== ids) {
      const below = others[index];
      const edge = below
        ? below.getBoundingClientRect().top
        : (others.at(-1)?.getBoundingClientRect().bottom ?? 0);
      lineTop = edge - list.getBoundingClientRect().top;
    }
    projectDrag.set(
      (current) => current && { ...current, x: pointer.x, y: pointer.y, index, lineTop },
    );
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
    const rect = header.getBoundingClientRect();
    projectDrag.set({
      workspaceId: project.id,
      title: project.title,
      x: pointer.x,
      y: pointer.y,
      grabX: start.x - rect.left,
      grabY: start.y - rect.top,
      width: rect.width,
      index: 0,
      lineTop: undefined,
    });
    document.documentElement.dataset.sidebarDragging = '';
    window.getSelection()?.removeAllRanges();
    frame = requestAnimationFrame(autoScroll);
    hitTest();
  };

  const stopDragging = () => {
    cancelAnimationFrame(frame);
    delete document.documentElement.dataset.sidebarDragging;
    projectDrag.set(undefined);
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
    const drag = projectDrag.get();
    stopDragging();
    if (!drag) return;
    const ids = listed();
    const next = moveProject(ids, pinnedWorkspaces.get(), project.id, drag.index);
    if (next !== ids) reorderProjects(next);
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

/** 项目列表里的插入线；放在列表（relative）里面。 */
export function ProjectDropLine() {
  const lineTop = useSyncExternalStore(projectDrag.subscribe, () => projectDrag.get()?.lineTop);
  if (lineTop === undefined) return null;
  return (
    <div
      aria-hidden
      data-testid="project-drop-line"
      className="pointer-events-none absolute inset-x-1 z-10 h-0.5 -translate-y-1/2 rounded-full bg-primary"
      style={{ top: lineTop }}
    />
  );
}

/** 跟着指针走的项目标题。挂在 body 上，浮层侧栏的位移不影响它。 */
export function ProjectDragGhost() {
  const drag = projectDrag.use();
  if (!drag) return null;
  return createPortal(
    <div aria-hidden className="pointer-events-none fixed inset-0 z-50">
      <div
        className="absolute flex h-8 items-center gap-2 rounded-lg bg-sidebar-accent px-2 text-base text-sidebar-accent-foreground shadow-lg ring-1 ring-border"
        style={{ left: drag.x - drag.grabX, top: drag.y - drag.grabY, width: drag.width }}
      >
        <Folder className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{drag.title}</span>
      </div>
    </div>,
    document.body,
  );
}
