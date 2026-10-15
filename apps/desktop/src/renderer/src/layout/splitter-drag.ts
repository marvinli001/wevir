// 分隔条拖动的状态（交互手感一轮，splitter.tsx）：死区、Esc 取消与拖过最小宽度后的吸附折叠，不碰 DOM，单独测。

/** 按下后移动不到这么多像素不算拖动：双击复位、单击都不会先改一下宽度。 */
export const DRAG_DEAD_ZONE_PX = 4;
/** 拖到比最小尺寸还小这么多像素时折叠。 */
export const COLLAPSE_OVERDRAG_PX = 48;
/** 折叠后要往回拖这么多像素（相对折叠的位置）才重新展开，免得在阈值附近来回跳。 */
export const EXPAND_HYSTERESIS_PX = 24;

/** 拖动能把哪一侧折叠：before 是分隔条左边或上边的那块，after 是右边或下边的那块。 */
export type CollapsibleSide = 'before' | 'after';

export interface CollapseRule {
  side: CollapsibleSide;
  /** 按下时那一块的尺寸。 */
  start: number;
  /** 那一块的最小尺寸。 */
  min: number;
}

export interface DragState {
  /** 已经超过死区，开始改尺寸。 */
  active: boolean;
  /** 从按下起累计的位移（px，向右或向下为正）；没超过死区时是 0。 */
  delta: number;
  /** 拖过了最小尺寸，那一块折叠。 */
  collapsed: boolean;
  /** 按了 Esc：恢复按下前的尺寸，之后的移动都不算。 */
  cancelled: boolean;
}

export const IDLE_DRAG: DragState = { active: false, delta: 0, collapsed: false, cancelled: false };

/** 那一块在这个位移下的尺寸（没有夹到最小值）。 */
function sizeAt(rule: CollapseRule, delta: number): number {
  return rule.start + (rule.side === 'before' ? delta : -delta);
}

/** 带回滞的折叠判断：展开时拖过 min − 48 折叠，折叠后拖回 min − 24 以上才展开。 */
export function collapsedAt(rule: CollapseRule, delta: number, wasCollapsed: boolean): boolean {
  const size = sizeAt(rule, delta);
  const collapseBelow = rule.min - COLLAPSE_OVERDRAG_PX;
  return wasCollapsed ? size < collapseBelow + EXPAND_HYSTERESIS_PX : size <= collapseBelow;
}

/** 指针移到距按下处 `delta` 的位置。 */
export function dragMove(state: DragState, delta: number, rule?: CollapseRule): DragState {
  if (state.cancelled) return state;
  if (!state.active && Math.abs(delta) < DRAG_DEAD_ZONE_PX) return state;
  return {
    active: true,
    delta,
    collapsed: rule ? collapsedAt(rule, delta, state.collapsed) : false,
    cancelled: false,
  };
}

/** 按了 Esc。 */
export function dragCancel(state: DragState): DragState {
  return { ...state, cancelled: true, collapsed: false, delta: 0 };
}
