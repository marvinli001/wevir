import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AVATAR_COLORS,
  AVATAR_LIGHT,
  AVATAR_TYPES,
  avatarGeometry,
  bodyColor,
  inkColor,
  normalizeAvatar,
  randomAvatar,
} from './bot-avatar';
import { AVATAR_SHAPES } from './bot-avatar-shapes';

const desktopAvatar = fileURLToPath(
  new URL('../../../desktop/src/renderer/src/session/avatar.ts', import.meta.url),
);

/** 固定序列的“随机数”。 */
function sequence(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
}

describe('bot avatars', () => {
  it('uses the same shapes and colours as the desktop subagent avatars', () => {
    const source = readFileSync(desktopAvatar, 'utf8');
    const quoted = (block: string) => [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const types = source.match(/AVATAR_TYPES = \[([\s\S]*?)\]/)?.[1] ?? '';
    const light = source.match(/light: \[([^\]]*)\]/)?.[1] ?? '';
    const dark = source.match(/dark: \[([^\]]*)\]/)?.[1] ?? '';
    expect(quoted(types)).toEqual([...AVATAR_TYPES]);
    expect(quoted(light)).toEqual([...AVATAR_COLORS.light]);
    expect(quoted(dark)).toEqual([...AVATAR_COLORS.dark]);
    expect(Object.keys(AVATAR_SHAPES).sort()).toEqual([...AVATAR_TYPES].sort());
  });

  it('draws the library colours at saturation 0.8 with dark eyes', () => {
    // 饱和度减 0.1、亮度不变。
    expect(bodyColor('#b59a6b')).toBe('#aa9776');
    expect(bodyColor('#808080')).toBe('#808080');
    for (const hex of [...AVATAR_COLORS.light, ...AVATAR_COLORS.dark]) {
      expect(inkColor(hex)).toBe('#1E1A33');
    }
    expect(inkColor('#101010')).toBe('#F7F5F2');
  });

  it('places the eyes on the face and closes them when asleep', () => {
    const awake = avatarGeometry('circle', 'default');
    expect(awake.roll).toBe(0);
    expect(awake.eyes[0]?.x).toBeCloseTo(37.5, 1);
    expect(awake.eyes[1]?.x).toBeCloseTo(62.5, 1);
    expect(awake.eyes[0]?.y).toBeCloseTo(51, 5);
    expect(awake.eyes[0]?.sx).toBeCloseTo(0.909, 3);
    expect(awake.eyes[0]?.width).toBe(12.6);

    const drop = avatarGeometry('drop', 'default');
    expect(drop.eyes[0]?.y).toBeCloseTo(62.9, 5);

    const asleep = avatarGeometry('circle', 'sleeping');
    expect(asleep.roll).toBeCloseTo(6, 5);
    expect(asleep.y).toBe(3);
    expect(asleep.eyes[0]?.width).toBe(4);
    expect(asleep.eyes[0]?.y).toBeGreaterThan(awake.eyes[0]?.y ?? 0);

    // 工作中微微抬头，眼睛往上一点。
    expect(avatarGeometry('circle', 'working').eyes[0]?.y).toBeLessThan(awake.eyes[0]?.y ?? 0);
  });

  it('lights from the left and shades the right', () => {
    expect(AVATAR_LIGHT.highlight.cx).toBeLessThan(50);
    expect(AVATAR_LIGHT.shadow.cx).toBeGreaterThan(50);
    expect(AVATAR_LIGHT.shadow.stops[0][0]).toBeCloseTo(6.2 / 130.2, 3);
  });

  it('picks a random avatar and rerolls to a different one', () => {
    expect(randomAvatar(sequence(0.99, 0.5, 0.25))).toEqual({
      type: 'cloud',
      color: 3,
      seed: 0.25,
    });
    const current = { type: 'pebble' as const, color: 0, seed: 0 };
    // 第一次抽到同一个，再抽一次。
    const next = randomAvatar(sequence(0, 0, 0.5, 0.2, 0.9, 0.1), current);
    expect(next).toEqual({ type: 'clover', color: 5, seed: 0.1 });
  });

  it('falls back for avatars it does not know', () => {
    expect(normalizeAvatar({ type: 'star' as never, color: 9, seed: 3 })).toEqual({
      type: 'pebble',
      color: 0,
      seed: 1,
    });
    expect(normalizeAvatar(undefined)).toEqual({ type: 'pebble', color: 0, seed: 0 });
    expect(normalizeAvatar({ type: 'cloud', color: 2, seed: 0.4 })).toEqual({
      type: 'cloud',
      color: 2,
      seed: 0.4,
    });
  });
});
