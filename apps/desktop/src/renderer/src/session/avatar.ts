// 子会话的头像（R5；U3 起是 bot-avatars 的小机器人）：由会话 ID 确定地选出一种形状与一种颜色，同一个子会话在消息流、
// 列表、详情、审批与置顶摘要里总是同一个样子。形状与颜色取自方向稿 A 静器（src/fx.jsx）；画在 canvas 上，颜色是字面值，
// 浅色、深色各一组，同一个序号是同一种颜色的两档。不用 Codex 的图标。

import type { SubagentStatus } from '@wevir/protocol';
import type { BotAvatarState, BotAvatarType } from 'bot-avatars';

export const AVATAR_TYPES = [
  'pebble',
  'clover',
  'drop',
  'pill',
  'circle',
  'cloud',
] as const satisfies readonly BotAvatarType[];

/** 浅色：褐、灰蓝、灰绿、灰粉、灰紫、麦黄；深色是各自亮一档。 */
export const AVATAR_COLORS = {
  light: ['#b59a6b', '#8e9fa3', '#a2ad95', '#bf9f98', '#9b98b0', '#c4b48e'],
  dark: ['#c9b083', '#9fb2b6', '#b2bda6', '#d2b0a8', '#aeabc4', '#d4c49e'],
} as const;

export interface Avatar {
  type: (typeof AVATAR_TYPES)[number];
  /** AVATAR_COLORS 里的序号，0 … 5。 */
  color: number;
  /** bot-avatars 的 seed（0–1）：错开眨眼与张望，一排头像不同步。 */
  seed: number;
}

/** 32 位 FNV-1a。ID 的随机部分（ULID）在末尾，按 UTF-16 码元逐个混进去，每一位都影响结果。 */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

export function avatarFor(sessionId: string): Avatar {
  const value = hash(sessionId);
  const colors = AVATAR_COLORS.light.length;
  return {
    type: AVATAR_TYPES[value % AVATAR_TYPES.length] ?? 'pebble',
    color: Math.floor(value / AVATAR_TYPES.length) % colors,
    seed: (Math.floor(value / (AVATAR_TYPES.length * colors)) % 1000) / 1000,
  };
}

/** 子会话的状态对应头像的动作：运行中蹦跳，关闭或取消了睡着，其余（完成、失败、不知道）闲着。 */
export function avatarState(status: SubagentStatus | undefined): BotAvatarState {
  if (status === 'running') return 'working';
  if (status === 'closed' || status === 'cancelled') return 'sleeping';
  return 'default';
}
