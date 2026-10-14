import { describe, expect, it } from 'vitest';
import { AVATAR_COLORS, AVATAR_TYPES, avatarFor, avatarState } from './avatar';

const ids = Array.from(
  { length: 200 },
  (_, i) => `ses_01JA2B3C4D5E6F7G8H9JK${i.toString(36).toUpperCase().padStart(5, '0')}`,
);

describe('子会话头像', () => {
  it('同一个会话 ID 总是同一种形状、颜色与 seed', () => {
    for (const id of ids) expect(avatarFor(id)).toEqual(avatarFor(id));
  });

  it('形状是登记的几种，颜色序号在范围内，seed 在 0–1', () => {
    expect(AVATAR_COLORS.dark).toHaveLength(AVATAR_COLORS.light.length);
    for (const id of ids) {
      const { type, color, seed } = avatarFor(id);
      expect(AVATAR_TYPES).toContain(type);
      expect(color).toBeGreaterThanOrEqual(0);
      expect(color).toBeLessThan(AVATAR_COLORS.light.length);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(1);
    }
  });

  it('只差最后一位的 ID 也分得开；一批 ID 用到了全部形状与颜色，组合不绑定', () => {
    expect(avatarFor('ses_01JA2B3C4D5E6F7G8H9JKMNPZY')).not.toEqual(
      avatarFor('ses_01JA2B3C4D5E6F7G8H9JKMNPZZ'),
    );
    const avatars = ids.map(avatarFor);
    expect(new Set(avatars.map((a) => a.type)).size).toBe(AVATAR_TYPES.length);
    expect(new Set(avatars.map((a) => a.color)).size).toBe(AVATAR_COLORS.light.length);
    expect(new Set(avatars.map((a) => `${a.type}:${a.color}`)).size).toBeGreaterThan(24);
  });

  it('状态：运行中蹦跳，关闭或取消睡着，其余闲着', () => {
    expect(avatarState('running')).toBe('working');
    expect(avatarState('closed')).toBe('sleeping');
    expect(avatarState('cancelled')).toBe('sleeping');
    expect(avatarState('completed')).toBe('default');
    expect(avatarState('failed')).toBe('default');
    expect(avatarState(undefined)).toBe('default');
  });
});
