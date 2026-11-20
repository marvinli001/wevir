import type { UsageUpdatedEvent } from './events.js';
import type { UsageBreakdown } from './types.js';

export type ContextCategory =
  | 'Messages'
  | 'System prompt'
  | 'System tools'
  | 'MCP tools'
  | 'MCP server instructions'
  | 'Memory files'
  | 'Skills';

/** 数量与条目名可以留给适配器；请求正文、工具参数和供给的 schema 不进入事件流。 */
export interface ContextPart {
  category: ContextCategory;
  bytes: number;
  weight: number;
  name?: string;
  source?: string;
  deferred?: boolean;
}

export function contextPart(
  category: ContextCategory,
  text: string,
  name?: string,
  source?: string,
): ContextPart {
  const wide =
    text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)
      ?.length ?? 0;
  return {
    category,
    bytes: Buffer.byteLength(text),
    weight: (text.length - wide) / 4 + wide * 0.8,
    name,
    source,
  };
}

/** 只有 Host 生成的记忆索引行带 mem:scope/name 句柄。相邻的回顾条目仍属于说明。 */
export function instructionParts(
  text: string,
  category: 'System prompt' | 'MCP server instructions',
): ContextPart[] {
  const index: string[] = [];
  const rest = text.replace(
    /^- \[(?:project|global)\] [^\n]*; mem:(?:project|global)\/[^\s]+$/gm,
    (line) => {
      index.push(line);
      return '';
    },
  );
  return [
    contextPart(category, rest),
    ...(index.length ? [contextPart('Memory files', index.join(''), 'Wevir memory index')] : []),
  ];
}

function apportion(weights: number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const shares = weights.map((value) => {
    const share = (value / sum) * total;
    const tokens = Math.floor(share);
    return { tokens, remainder: share - tokens };
  });
  const leftover = total - shares.reduce((sum, share) => sum + share.tokens, 0);
  for (const share of [...shares].sort((a, b) => b.remainder - a.remainder).slice(0, leftover))
    share.tokens++;
  return shares.map((share) => share.tokens);
}

const groupNames: Partial<Record<ContextCategory, string>> = {
  'MCP tools': 'mcp_tools',
  'Memory files': 'memory_files',
  Skills: 'skills',
};

export function measureContext(
  parts: readonly ContextPart[],
  {
    contextUsed,
    contextSize,
    autoCompactAt,
  }: Pick<UsageUpdatedEvent, 'contextUsed' | 'contextSize' | 'autoCompactAt'>,
  precision: 'exact-split' | 'estimate',
  measuredAt = new Date().toISOString(),
): UsageBreakdown {
  const used = new Map<ContextCategory, ContextPart[]>();
  const deferred = new Map<ContextCategory, number>();
  let weight = 0;
  for (const part of parts) {
    if (!part.weight) continue;
    if (part.deferred) {
      deferred.set(part.category, (deferred.get(part.category) ?? 0) + part.weight);
    } else {
      const entries = used.get(part.category) ?? [];
      entries.push(part);
      used.set(part.category, entries);
      weight += part.weight;
    }
  }
  if (precision === 'estimate' || (!weight && contextUsed > 0)) {
    const entries = used.get('Messages') ?? [];
    entries.push({ category: 'Messages', bytes: 0, weight: Math.max(0, contextUsed - weight) });
    used.set('Messages', entries);
  }
  const entries = [...used];
  const tokens = apportion(
    entries.map(([, parts]) => parts.reduce((sum, p) => sum + p.weight, 0)),
    contextUsed,
  );
  const categories: UsageBreakdown['categories'] = [];
  const groups: NonNullable<UsageBreakdown['groups']> = [];
  for (const [i, [name, parts]] of entries.entries()) {
    const count = tokens[i] as number;
    categories.push({ name, tokens: count, kind: 'used' });
    const group = groupNames[name];
    if (!group) continue;
    const shares = apportion(
      parts.map((p) => p.weight),
      count,
    );
    const items = new Map<string, { name: string; source?: string; tokens: number }>();
    for (const [j, p] of parts.entries()) {
      if (!p.name) continue;
      const key = JSON.stringify([p.source, p.name]);
      const item = items.get(key) ?? {
        name: p.name.slice(0, 300),
        ...(p.source && { source: p.source.slice(0, 100) }),
        tokens: 0,
      };
      item.tokens += shares[j] as number;
      items.set(key, item);
    }
    if (items.size)
      groups.push({
        group,
        count: items.size,
        items: [...items.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 100),
      });
  }
  const available = Math.max(0, contextSize - contextUsed);
  const buffer = Math.min(available, Math.max(0, contextSize - (autoCompactAt ?? contextSize)));
  if (buffer) categories.push({ name: 'Autocompact buffer', tokens: buffer, kind: 'buffer' });
  if (available > buffer)
    categories.push({ name: 'Free space', tokens: available - buffer, kind: 'free' });
  for (const [name, weight] of deferred)
    categories.push({ name: `${name} (deferred)`, tokens: Math.round(weight), kind: 'deferred' });
  return {
    categories,
    ...(groups.length && { groups }),
    measuredAt,
    measuredUsed: contextUsed,
    precision,
  };
}
