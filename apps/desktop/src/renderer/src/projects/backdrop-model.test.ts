import { describe, expect, it } from 'vitest';
import {
  BACKDROP_IMAGE_MAX_CHARS,
  parseBackdrops,
  sameBackdrop,
  withBackdrop,
} from './backdrop-model';

describe('项目背景', () => {
  it('读回存下的表：认识的预设与 data:image 图片照用，坏掉的项丢掉', () => {
    expect(
      parseBackdrops({
        ws_a: { kind: 'preset', preset: 'dawn' },
        ws_b: { kind: 'image', src: 'data:image/jpeg;base64,AAAA' },
        ws_c: { kind: 'preset', preset: 'neon' },
        ws_d: { kind: 'image', src: 'https://example.com/a.png' },
        ws_e: {
          kind: 'image',
          src: `data:image/jpeg;base64,${'A'.repeat(BACKDROP_IMAGE_MAX_CHARS)}`,
        },
        ws_f: null,
      }),
    ).toEqual({
      ws_a: { kind: 'preset', preset: 'dawn' },
      ws_b: { kind: 'image', src: 'data:image/jpeg;base64,AAAA' },
    });
    expect(parseBackdrops(null)).toEqual({});
    expect(parseBackdrops([])).toEqual({});
  });

  it('设上、换掉与去掉一个项目的背景', () => {
    const one = withBackdrop({}, 'ws_a', { kind: 'preset', preset: 'mist' });
    expect(one).toEqual({ ws_a: { kind: 'preset', preset: 'mist' } });
    expect(withBackdrop(one, 'ws_a', { kind: 'preset', preset: 'sage' })).toEqual({
      ws_a: { kind: 'preset', preset: 'sage' },
    });
    expect(withBackdrop(one, 'ws_a', undefined)).toEqual({});
  });

  it('比较两个背景', () => {
    expect(sameBackdrop(undefined, undefined)).toBe(true);
    expect(sameBackdrop({ kind: 'preset', preset: 'dusk' }, undefined)).toBe(false);
    expect(
      sameBackdrop({ kind: 'preset', preset: 'dusk' }, { kind: 'preset', preset: 'dusk' }),
    ).toBe(true);
    expect(
      sameBackdrop({ kind: 'image', src: 'data:image/png;a' }, { kind: 'preset', preset: 'dusk' }),
    ).toBe(false);
  });
});
