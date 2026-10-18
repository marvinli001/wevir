// 离开后回顾（0.54.0，domain-model §3.24、desktop-tokens §61）的纯逻辑：什么时候算“离开”与“回来”、回来时要不要向 Host 要摘要、
// 摘要的显示与关闭。不碰 DOM 与 React，时钟由调用方传入；状态放在 recap-store.ts 的进程内存里。

import { SESSION_RECAP_MIN_AWAY_MS, type SessionRecap, type SessionState } from '@wevir/protocol';

export interface AwayEntry {
  /** 离开的时刻（毫秒时间戳）。 */
  readonly leftAt: number;
  /** 离开时这个会话看到的最后一个事件。 */
  readonly seenSeq: number;
}

/** 按会话记的离开登记：每个会话至多一条。 */
export type AwayMap = Readonly<Record<string, AwayEntry>>;

/**
 * 离开：切走会话、窗口失焦或隐藏都算。一段离开只记最早的那次（窗口先失焦、之后又切走会话，起点仍是失焦那一刻），
 * 回来时才清掉。
 */
export function markLeft(map: AwayMap, sessionId: string, now: number, seenSeq: number): AwayMap {
  if (map[sessionId] !== undefined) return map;
  return { ...map, [sessionId]: { leftAt: now, seenSeq } };
}

export interface Returned {
  readonly map: AwayMap;
  /** 离开够久时要向 Host 报告的内容；不够久或本来就没离开过时没有。 */
  readonly request?: { readonly seenSeq: number; readonly awayMs: number };
}

/** 回来：清掉这一段离开；离开了至少 `SESSION_RECAP_MIN_AWAY_MS` 才值得要摘要。 */
export function markReturned(map: AwayMap, sessionId: string, now: number): Returned {
  const entry = map[sessionId];
  if (entry === undefined) return { map };
  const { [sessionId]: _left, ...rest } = map;
  const awayMs = Math.max(0, now - entry.leftAt);
  if (awayMs < SESSION_RECAP_MIN_AWAY_MS) return { map: rest };
  return { map: rest, request: { seenSeq: entry.seenSeq, awayMs } };
}

export interface RecapEntry {
  readonly recap: SessionRecap;
  readonly dismissed: boolean;
}

/** 按会话记的摘要：每个会话至多一张卡片。 */
export type RecapMap = Readonly<Record<string, RecapEntry>>;

/** 会话正在回合里（运行、等审批、取消中）：摘要说的是回合结束之后的样子，回合开始就过时了。 */
export function isActiveState(state: SessionState | undefined): boolean {
  return state === 'running' || state === 'awaiting_approval' || state === 'cancelling';
}

/**
 * 收到 Host 给的摘要。同一个位置（`throughSeq`）的摘要已经有了就保持原样（关掉的不再冒出来）；新的位置替换旧的。
 * 收到时会话已经又开始回合了（生成期间用户发了消息）就当场算关闭。
 */
export function receiveRecap(
  map: RecapMap,
  sessionId: string,
  recap: SessionRecap,
  state: SessionState | undefined,
): RecapMap {
  if (map[sessionId]?.recap.throughSeq === recap.throughSeq) return map;
  return { ...map, [sessionId]: { recap, dismissed: isActiveState(state) } };
}

/** 关闭卡片（用户点关闭，或会话开始了新的回合）。 */
export function dismissRecap(map: RecapMap, sessionId: string): RecapMap {
  const entry = map[sessionId];
  if (entry === undefined || entry.dismissed) return map;
  return { ...map, [sessionId]: { ...entry, dismissed: true } };
}

/** 新的一段离开开始要摘要时，上一段的摘要不再算数。 */
export function clearRecap(map: RecapMap, sessionId: string): RecapMap {
  if (map[sessionId] === undefined) return map;
  const { [sessionId]: _old, ...rest } = map;
  return rest;
}

/** 现在该显示的摘要：没关闭、会话不在回合里。 */
export function visibleRecap(
  map: RecapMap,
  sessionId: string,
  state: SessionState | undefined,
): SessionRecap | undefined {
  const entry = map[sessionId];
  if (entry === undefined || entry.dismissed || isActiveState(state)) return undefined;
  return entry.recap;
}

/** 要不要追踪这个会话的离开：Host 有功能、设置里开着、是主窗格里的顶层会话（子智能体与支线没有摘要）。 */
export function recapEnabled(options: {
  featureSupported: boolean;
  settingOn: boolean | undefined;
  variant: 'main' | 'pane';
  side: boolean | undefined;
  parentSessionId: string | undefined;
}): boolean {
  return (
    options.featureSupported &&
    options.settingOn !== false &&
    options.variant === 'main' &&
    options.side !== true &&
    options.parentSessionId === undefined
  );
}
