import { describe, expect, it } from 'vitest';
import { AVATAR_COLORS, AVATAR_SHAPES, avatarFor } from './avatar';

const ids = Array.from(
  { length: 200 },
  (_, i) => `ses_01JA2B3C4D5E6F7G8H9JK${i.toString(36).toUpperCase().padStart(5, '0')}`,
);

describe('子会话头像', () => {
  it('同一个会话 ID 总是同一种颜色与形状', () => {
    for (const id of ids) expect(avatarFor(id)).toEqual(avatarFor(id));
    expect(avatarFor('ses_01JA2B3C4D5E6F7G8H9JKMNPZZ')).toEqual(
      avatarFor('ses_01JA2B3C4D5E6F7G8H9JKMNPZZ'),
    );
  });

  it('颜色在 1 … 7 之内、形状是登记的几种', () => {
    for (const id of ids) {
      const { color, shape } = avatarFor(id);
      expect(color).toBeGreaterThanOrEqual(1);
      expect(color).toBeLessThanOrEqual(AVATAR_COLORS);
      expect(AVATAR_SHAPES).toContain(shape);
    }
  });

  it('只差最后一位的 ID 也分得开；一批 ID 用到了全部颜色与形状', () => {
    expect(avatarFor('ses_01JA2B3C4D5E6F7G8H9JKMNPZY')).not.toEqual(
      avatarFor('ses_01JA2B3C4D5E6F7G8H9JKMNPZZ'),
    );
    const avatars = ids.map(avatarFor);
    expect(new Set(avatars.map((a) => a.color)).size).toBe(AVATAR_COLORS);
    expect(new Set(avatars.map((a) => a.shape)).size).toBe(AVATAR_SHAPES.length);
    // 颜色与形状不是绑在一起的：组合数远多于颜色数。
    expect(new Set(avatars.map((a) => `${a.color}:${a.shape}`)).size).toBeGreaterThan(30);
  });
});
