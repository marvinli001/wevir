import { describe, expect, it } from 'vitest';
import { contextPart, measureContext } from './context-breakdown.js';

describe('context measurement', () => {
  it('weights CJK text separately from ASCII', () => {
    expect(contextPart('Messages', 'abcd')).toMatchObject({ weight: 1, bytes: 4 });
    expect(contextPart('Messages', '四个汉字')).toMatchObject({ weight: 3.2, bytes: 12 });
  });
  it.each([0, 1, 2, 7, 10, 101, 4096])(
    'allocates exactly %d input tokens independently of deferred tools and buffer',
    (contextUsed) => {
      const parts = [
        contextPart('System prompt', 'ab'),
        contextPart('Skills', '技', 'one'),
        contextPart('Skills', '能', 'two'),
        contextPart('Messages', 'ok'),
        { ...contextPart('MCP tools', 'some args'), deferred: true },
      ];
      const { categories, groups } = measureContext(
        parts,
        { contextUsed, contextSize: 1024, autoCompactAt: 900 },
        'exact-split',
      );
      expect(
        categories.filter((c) => c.kind === 'used').reduce((sum, c) => sum + c.tokens, 0),
      ).toBe(contextUsed);
      expect(groups?.[0]?.items.reduce((s, i) => s + i.tokens, 0)).toBe(
        categories.find((c) => c.name === 'Skills')?.tokens,
      );
      expect(categories.find((c) => c.kind === 'deferred')?.tokens).toBe(2);
      expect(
        categories.filter((c) => c.kind !== 'deferred').reduce((s, c) => s + c.tokens, 0),
      ).toBe(Math.max(contextUsed, 1024));
    },
  );
  it('assigns the estimate remainder to messages and scales oversized supply', () => {
    const parts = [
      contextPart('System prompt', '0123456789'),
      contextPart('Skills', 'abcdefghij', 'one'),
    ];
    const used = (total: number) =>
      measureContext(parts, { contextUsed: total, contextSize: total }, 'estimate').categories.map(
        (c) => [c.name, c.tokens],
      );
    expect(used(9)).toEqual([
      ['System prompt', 3],
      ['Skills', 2],
      ['Messages', 4],
    ]);
    expect(used(3)).toEqual([
      ['System prompt', 2],
      ['Skills', 1],
      ['Messages', 0],
    ]);
    expect(
      measureContext([], { contextUsed: 7, contextSize: 7 }, 'exact-split').categories,
    ).toEqual([{ name: 'Messages', tokens: 7, kind: 'used' }]);
  });
});
