import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assembleContextPack, type PackBlock } from './context-pack.js';
import { assembleHandoff, type HandoffInput } from './handoff.js';
import frozenHandoffs from './test-fixtures/handoff-context-packs.json' with { type: 'json' };

const block = (text: string, index = 0): PackBlock => ({
  text,
  source: { kind: 'constraint', index },
});
describe('context packs', () => {
  it('is deterministic, carries mandatory blocks intact, and reports every omitted source', () => {
    const input = {
      occasion: 'session_start' as const,
      header: 'Context',
      budget: 40,
      sections: [
        { key: 'must', mustCarry: true, blocks: [block('原文\n\n🙂')] },
        {
          key: 'optional',
          mustCarry: false,
          blocks: [block('x'.repeat(40), 1), block('small', 2)],
        },
      ],
    };
    const result = assembleContextPack(input);
    expect(result).toEqual(assembleContextPack(input));
    expect(result.kind).toBe('pack');
    if (result.kind !== 'pack') return;
    expect(result.text).toContain('原文\n\n🙂');
    expect(result.text).toContain('small');
    expect(result.bytes).toBe(Buffer.byteLength(result.text));
    expect(result.bytes).toBeLessThanOrEqual(40);
    expect(result.hash).toBe(createHash('sha256').update(result.text).digest('hex'));
    expect(result.included).toHaveLength(2);
    expect(result.omitted).toEqual([{ kind: 'constraint', index: 1 }]);
  });

  it('rejects an oversized mandatory block instead of truncating it', () => {
    expect(
      assembleContextPack({
        occasion: 'handoff',
        header: 'Header',
        budget: 5,
        sections: [{ key: 'must', mustCarry: true, blocks: [block('constraint')] }],
      }).kind,
    ).toBe('over_budget');
    expect(
      assembleContextPack({ occasion: 'session_start', header: '', budget: 5, sections: [] }),
    ).toEqual({ kind: 'empty' });
  });

  it.each(frozenHandoffs.map((sample, index) => ({ ...sample, index })))(
    'preserves handoff bytes from the previous assembler: $index',
    ({ input, expected }) => {
      expect(assembleHandoff(input as HandoffInput)).toEqual(expected);
    },
  );
});
