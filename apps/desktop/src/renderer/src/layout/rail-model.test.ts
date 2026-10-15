import type { ProviderProfile } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  abbreviateHome,
  contextUsage,
  formatTokens,
  parentDirectory,
  RAIL_DOCKED_WIDTH,
  railDocks,
} from './rail-model';

const providers = [
  {
    id: 'p',
    models: [{ id: 'declared', contextWindow: 200_000 }, { id: 'guessed' }],
  },
] as unknown as ProviderProfile[];

describe('railDocks', () => {
  const docked = (primaryWidth: number) => () => ({ mode: 'docked', primaryWidth });
  it('扣掉侧栏后主窗格仍不窄于 440、窗格区不改浮层才停靠', () => {
    expect(railDocks(1420, () => ({ mode: 'none', primaryWidth: 1420 - RAIL_DOCKED_WIDTH }))).toBe(
      true,
    );
    expect(railDocks(700, () => ({ mode: 'none', primaryWidth: 700 - RAIL_DOCKED_WIDTH }))).toBe(
      false,
    );
    expect(railDocks(1100, docked(500))).toBe(true);
    expect(railDocks(1100, docked(430))).toBe(false);
    expect(railDocks(1100, () => ({ mode: 'overlay', primaryWidth: 804 }))).toBe(false);
  });
});

describe('contextUsage', () => {
  it('百分比取整、不超过 100；模型没声明上下文长度时标出估计', () => {
    expect(
      contextUsage(
        { contextUsed: 36_500, contextSize: 200_000 },
        { providerId: 'p', modelId: 'declared' },
        providers,
      ),
    ).toEqual({ used: 36_500, size: 200_000, percent: 18, estimated: false });
    expect(
      contextUsage(
        { contextUsed: 300, contextSize: 200 },
        { providerId: 'p', modelId: 'guessed' },
        providers,
      ),
    ).toMatchObject({ percent: 100, estimated: true });
    expect(
      contextUsage(
        { contextUsed: 1, contextSize: 0 },
        { providerId: 'p', modelId: 'guessed' },
        providers,
      ),
    ).toBeUndefined();
    expect(contextUsage(undefined, { providerId: 'p', modelId: 'x' }, providers)).toBeUndefined();
  });
});

describe('写法', () => {
  it('token 数', () => {
    expect([999, 1000, 182_400, 1_000_000, 1_250_000].map(formatTokens)).toEqual([
      '999',
      '1k',
      '182.4k',
      '1M',
      '1.3M',
    ]);
  });

  it('家目录与上一级目录', () => {
    expect(abbreviateHome('/Users/marvin/Developer/wevir')).toBe('~/Developer/wevir');
    expect(abbreviateHome('/home/me')).toBe('~');
    expect(abbreviateHome('C:\\Users\\me\\code')).toBe('~\\code');
    expect(abbreviateHome('/opt/Users/x')).toBe('/opt/Users/x');
    expect(parentDirectory('/Users/marvin/Developer/wevir')).toBe('/Users/marvin/Developer');
    expect(parentDirectory('/wevir/')).toBe('/');
    expect(parentDirectory('C:\\code\\wevir')).toBe('C:\\code');
  });
});
