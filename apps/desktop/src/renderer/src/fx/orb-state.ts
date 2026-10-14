// 每个回合的 thinking orb（U3）：回合开始时从 9 种里抽一种，同一回合内不变，不和上一回合重复。以回合 ID 做种子
// （同一个回合 ID 总是先得到同一个结果），并按会话记在进程内：消息流、左栏、重渲染、断线重连后的回放、切走会话再回来
// 问的都是同一张表，第一次问到时定下来。表里没有上一回合（刚启动、这个会话的上一回合没显示过）时从 9 种里抽。

import type { OrbState } from 'thinking-orbs';

export const ORB_STATES = [
  'working',
  'searching',
  'solving',
  'listening',
  'connecting',
  'weaving',
  'composing',
  'breathing',
  'shaping',
] as const satisfies readonly OrbState[];

/** 每个会话记最近几个回合，保留最近用过的几个会话。 */
const KEEP_TURNS = 8;
const KEEP_SESSIONS = 64;

/** 32 位 FNV-1a，同 session/avatar.ts。 */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/** 由回合 ID 确定地选一种，避开上一回合的那种。 */
export function pickOrb(turnId: string, previous: OrbState | undefined): OrbState {
  const pool = previous === undefined ? ORB_STATES : ORB_STATES.filter((s) => s !== previous);
  return pool[hash(turnId) % pool.length] ?? 'working';
}

const sessions = new Map<string, Map<string, OrbState>>();

/** 会话 `sessionId` 的回合 `turnId` 用哪种 orb。 */
export function turnOrb(sessionId: string, turnId: string): OrbState {
  let turns = sessions.get(sessionId);
  const known = turns?.get(turnId);
  if (known !== undefined) return known;
  turns ??= new Map();
  sessions.delete(sessionId);
  sessions.set(sessionId, turns);
  for (const id of sessions.keys()) {
    if (sessions.size <= KEEP_SESSIONS) break;
    sessions.delete(id);
  }
  const orb = pickOrb(turnId, [...turns.values()].at(-1));
  turns.set(turnId, orb);
  for (const id of turns.keys()) {
    if (turns.size <= KEEP_TURNS) break;
    turns.delete(id);
  }
  return orb;
}

/** 测试用：清空记下的回合。 */
export function resetTurnOrbs(): void {
  sessions.clear();
}
