// 子会话的头像（R5）：由会话 ID 确定地选出一种颜色与一种形状，同一个子会话在消息流、列表、详情、审批与置顶摘要里
// 总是同一个样子。颜色是 tokens.css 的 --avatar-1 … --avatar-7（Wevir 调色板），形状是 subagent-avatar.tsx 画的
// 几何图形。不用 Codex 的图标。

/** 头像颜色的个数（tokens.css 的 --avatar-N）。 */
export const AVATAR_COLORS = 7;

export const AVATAR_SHAPES = [
  'ring',
  'diamond',
  'triad',
  'hexagon',
  'halves',
  'bars',
  'badge',
  'venn',
] as const;

export type AvatarShape = (typeof AVATAR_SHAPES)[number];

export interface Avatar {
  /** 1 … AVATAR_COLORS。 */
  color: number;
  shape: AvatarShape;
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
  return {
    color: (value % AVATAR_COLORS) + 1,
    shape: AVATAR_SHAPES[Math.floor(value / AVATAR_COLORS) % AVATAR_SHAPES.length] ?? 'ring',
  };
}
