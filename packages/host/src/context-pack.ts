import { createHash } from 'node:crypto';
import type { ContextSourceRef } from '@wevir/protocol';

export interface PackBlock {
  text: string;
  source: ContextSourceRef;
}
export interface PackSection {
  key: string;
  mustCarry: boolean;
  blocks: readonly PackBlock[];
  select?:
    | 'all'
    | 'greedy'
    | ((blocks: readonly PackBlock[], remaining: number) => readonly number[]);
}
export type ContextPack =
  | { kind: 'empty' }
  | { kind: 'over_budget'; bytes: number; budgetBytes: number }
  | {
      kind: 'pack';
      text: string;
      bytes: number;
      hash: string;
      budgetBytes: number;
      included: ContextSourceRef[];
      omitted: ContextSourceRef[];
    };

export function assembleContextPack(input: {
  occasion: 'session_start' | 'handoff' | 'search';
  header: string | ((selected: number, omitted: number) => string);
  sections: readonly PackSection[];
  budget: number;
}): ContextPack {
  if (input.sections.every((section) => section.blocks.length === 0)) return { kind: 'empty' };
  const size = (text: string) => Buffer.byteLength(text, 'utf8');
  const optional = input.sections
    .filter((section) => !section.mustCarry)
    .reduce((count, section) => count + section.blocks.length, 0);
  const header = typeof input.header === 'string' ? () => input.header as string : input.header;
  const fixed = input.sections
    .filter((section) => section.mustCarry)
    .flatMap((section) => section.blocks);
  const fixedBytes = fixed.reduce((sum, block) => sum + size(block.text) + 2, 0);
  const minimum = size(header(0, optional)) + fixedBytes;
  if (minimum > input.budget)
    return { kind: 'over_budget', bytes: minimum, budgetBytes: input.budget };
  let remaining = input.budget - size(header(optional, optional)) - fixedBytes;
  const selections: Set<number>[] = [];
  let count = 0;
  for (const section of input.sections) {
    const selected = new Set<number>();
    selections.push(selected);
    if (section.mustCarry) {
      section.blocks.forEach((_, index) => {
        selected.add(index);
      });
      continue;
    }
    const order =
      typeof section.select === 'function'
        ? section.select(section.blocks, remaining)
        : section.blocks.map((_, index) => index);
    for (const index of order) {
      const block = section.blocks[index];
      if (block === undefined || selected.has(index)) continue;
      const cost = size(block.text) + 2;
      if (cost > remaining) continue;
      selected.add(index);
      remaining -= cost;
      count += 1;
    }
  }
  const blocks: string[] = [];
  const included: ContextSourceRef[] = [];
  const omitted: ContextSourceRef[] = [];
  input.sections.forEach((section, sectionIndex) => {
    section.blocks.forEach((block, index) => {
      if (selections[sectionIndex]?.has(index)) {
        blocks.push(block.text);
        included.push(block.source);
      } else omitted.push(block.source);
    });
  });
  const heading = header(count, optional - count);
  const text = [...(heading === '' ? [] : [heading]), ...blocks].join('\n\n');
  const bytes = size(text);
  if (bytes > input.budget) return { kind: 'over_budget', bytes, budgetBytes: input.budget };
  return {
    kind: 'pack',
    text,
    bytes,
    hash: createHash('sha256').update(text).digest('hex'),
    budgetBytes: input.budget,
    included,
    omitted,
  };
}
