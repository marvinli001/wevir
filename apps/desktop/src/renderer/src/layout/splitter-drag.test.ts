import { describe, expect, it } from 'vitest';
import {
  COLLAPSE_OVERDRAG_PX,
  type CollapseRule,
  collapsedAt,
  DRAG_DEAD_ZONE_PX,
  type DragState,
  dragCancel,
  dragMove,
  EXPAND_HYSTERESIS_PX,
  IDLE_DRAG,
} from './splitter-drag';

/** 依次移到这些位移，返回每一步的状态。 */
function drag(deltas: number[], rule?: CollapseRule, from: DragState = IDLE_DRAG): DragState[] {
  const states: DragState[] = [];
  let state = from;
  for (const delta of deltas) {
    state = dragMove(state, delta, rule);
    states.push(state);
  }
  return states;
}

describe('dead zone', () => {
  it('ignores movement under 4 px', () => {
    const states = drag([1, -2, 3, -3]);
    expect(states.every((state) => !state.active && state.delta === 0)).toBe(true);
  });

  it('starts at the threshold and then reports the full delta', () => {
    const [, started, back] = drag([2, DRAG_DEAD_ZONE_PX, 1]);
    expect(started).toMatchObject({ active: true, delta: DRAG_DEAD_ZONE_PX });
    // 一旦开始，回到死区以内也照常报告。
    expect(back).toMatchObject({ active: true, delta: 1 });
  });

  it('works in both directions', () => {
    expect(dragMove(IDLE_DRAG, -DRAG_DEAD_ZONE_PX)).toMatchObject({ active: true, delta: -4 });
  });
});

describe('Escape', () => {
  it('cancels the drag and ignores later movement', () => {
    const [moved] = drag([40]);
    const cancelled = dragCancel(moved as DragState);
    expect(cancelled).toMatchObject({ cancelled: true, delta: 0, collapsed: false });
    expect(dragMove(cancelled, 120)).toBe(cancelled);
  });

  it('drops a pending collapse', () => {
    const rule: CollapseRule = { side: 'before', start: 260, min: 220 };
    const states = drag([-200], rule);
    expect(states.at(-1)?.collapsed).toBe(true);
    expect(dragCancel(states.at(-1) as DragState).collapsed).toBe(false);
  });
});

describe('snap collapse with hysteresis', () => {
  // 侧栏：在分隔条左边，向左拖变窄。
  const sidebar: CollapseRule = { side: 'before', start: 260, min: 220 };
  const collapseAt = sidebar.min - COLLAPSE_OVERDRAG_PX - sidebar.start; // 位移 -88
  const expandAt = collapseAt + EXPAND_HYSTERESIS_PX; // 位移 -64

  it('stays open just past the minimum width', () => {
    expect(collapsedAt(sidebar, -40, false)).toBe(false);
    expect(collapsedAt(sidebar, collapseAt + 1, false)).toBe(false);
  });

  it('collapses once dragged far enough past the minimum', () => {
    expect(collapsedAt(sidebar, collapseAt, false)).toBe(true);
  });

  it('needs to come back past the hysteresis before expanding', () => {
    const states = drag(
      [collapseAt, collapseAt + 10, expandAt - 1, expandAt, collapseAt + 4],
      sidebar,
    );
    expect(states.map((state) => state.collapsed)).toEqual([true, true, true, false, false]);
  });

  it('mirrors for a pane after the splitter (dragging right shrinks it)', () => {
    const aux: CollapseRule = { side: 'after', start: 400, min: 320 };
    const shrinkBy = aux.start - (aux.min - COLLAPSE_OVERDRAG_PX); // 位移 +128
    expect(collapsedAt(aux, shrinkBy - 1, false)).toBe(false);
    expect(collapsedAt(aux, shrinkBy, false)).toBe(true);
    expect(collapsedAt(aux, shrinkBy - EXPAND_HYSTERESIS_PX + 1, true)).toBe(true);
    expect(collapsedAt(aux, shrinkBy - EXPAND_HYSTERESIS_PX, true)).toBe(false);
  });

  it('never collapses without a rule (splits between panes)', () => {
    expect(drag([-500]).at(-1)?.collapsed).toBe(false);
  });
});
