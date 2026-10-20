// 会话侧栏“上下文”卡片展开后的分布（0.50.0）：协议的 `UsageBreakdown` → 画条与列表用的行。

import type { UsageBreakdown } from '@wevir/protocol';
import { t } from '@/i18n';

export type BreakdownKind = 'used' | 'free' | 'buffer' | 'deferred';

/** 引擎给的类别名里桌面端认得的：按界面语言显示。键是小写的类别名。 */
const CATEGORY_LABELS = {
  messages: () => t('rail.context.cat.messages'),
  'system prompt': () => t('rail.context.cat.systemPrompt'),
  'system tools': () => t('rail.context.cat.systemTools'),
  'mcp tools': () => t('rail.context.cat.mcpTools'),
  'mcp server instructions': () => t('rail.context.cat.mcpInstructions'),
  'memory files': () => t('rail.context.cat.memoryFiles'),
  'custom agents': () => t('rail.context.cat.agents'),
  skills: () => t('rail.context.cat.skills'),
  'slash commands': () => t('rail.context.cat.slashCommands'),
  'autocompact buffer': () => t('rail.context.cat.buffer'),
  'free space': () => t('rail.context.cat.free'),
  input: () => t('rail.context.cat.input'),
  'cached input': () => t('rail.context.cat.cachedInput'),
  output: () => t('rail.context.cat.output'),
  reasoning: () => t('rail.context.cat.reasoning'),
} satisfies Record<string, () => string>;

const GROUP_LABELS = {
  mcp_tools: () => t('rail.context.cat.mcpTools'),
  memory_files: () => t('rail.context.cat.memoryFiles'),
  agents: () => t('rail.context.cat.agents'),
  skills: () => t('rail.context.cat.skills'),
} satisfies Record<string, () => string>;

/**
 * 色块：已知的类别各有固定的一格（换回合颜色不跳），照 Claude 桌面端只给消息、MCP 工具、系统工具、技能这几类上色，其余是
 * 深浅不同的灰；不认识的也是灰，按出现顺序先取这一组分布里没被占着的，不够了再轮回来。类名要写全，Tailwind 才扫得到。
 * 剩余空间与压缩余量另有颜色（`FREE_SWATCH`、`BUFFER_SWATCH`）。
 */
const SWATCHES = [
  'bg-chart-3',
  'bg-chart-4',
  'bg-chart-5',
  'bg-chart-1',
  'bg-chart-2',
  'bg-chart-6',
  'bg-soft-foreground/80',
  'bg-muted-foreground',
  'bg-muted-foreground/70',
  'bg-muted-foreground/50',
] as const;
/** 灰的几格，不认识的类别从这里取。 */
const GRAYS = [6, 7, 8, 9];
const FIXED_SWATCH: Record<string, number> = {
  messages: 0,
  'mcp tools': 1,
  'system tools': 2,
  skills: 3,
  'slash commands': 4,
  'system prompt': 6,
  'memory files': 7,
  'mcp server instructions': 8,
  'custom agents': 9,
  input: 0,
  'cached input': 2,
  output: 1,
  reasoning: 3,
};
export const FREE_SWATCH = 'bg-muted';
export const BUFFER_SWATCH = 'bg-border-strong';

const DEFERRED_SUFFIX = / \(deferred\)$/i;

export interface BreakdownRow {
  label: string;
  tokens: number;
  /** 占窗口的比例，0–100，不取整。 */
  percent: number;
  kind: BreakdownKind;
  /** 色块的 Tailwind 类。 */
  swatch: string;
}

export interface BreakdownItem {
  name: string;
  source?: string;
  tokens: number;
}

export interface BreakdownGroup {
  id: string;
  label: string;
  /** 这一组一共有多少项（`items` 只带占得最多的前几项）。 */
  count: number;
  items: BreakdownItem[];
}

export interface ContextBreakdownView {
  /** 画在条上的段与列表的前部：占着的、压缩余量、剩余空间；按占用从多到少，余量与剩余垫后。 */
  rows: BreakdownRow[];
  /** 按需载入、不算在窗口里的行（只列出来，不画在条上）。 */
  deferred: BreakdownRow[];
  groups: BreakdownGroup[];
}

function kindOf(kind: string): BreakdownKind {
  return kind === 'free' || kind === 'buffer' || kind === 'deferred' ? kind : 'used';
}

/** 类别名的显示：认得的翻译，`(deferred)` 的写成“…（按需载入）”，其余照写。 */
export function categoryLabel(name: string): string {
  const deferred = DEFERRED_SUFFIX.test(name);
  const base = deferred ? name.replace(DEFERRED_SUFFIX, '') : name;
  const label = (CATEGORY_LABELS as Record<string, (() => string) | undefined>)[base.toLowerCase()];
  const text = label?.() ?? base;
  return deferred ? t('rail.context.deferred', { name: text }) : text;
}

export function groupLabel(group: string): string {
  return (GROUP_LABELS as Record<string, (() => string) | undefined>)[group]?.() ?? group;
}

/** 没有可画的（没有行、或占用全是 0）时返回 undefined。 */
export function contextBreakdown(
  breakdown: UsageBreakdown | undefined,
): ContextBreakdownView | undefined {
  if (!breakdown) return undefined;
  const entries = breakdown.categories.filter((row) => row.tokens > 0);
  const windowed = entries.filter((row) => kindOf(row.kind) !== 'deferred');
  const total = windowed.reduce((sum, row) => sum + row.tokens, 0);
  if (total <= 0) return undefined;

  // 不认识的类别用这一组分布里没被已知类别占着的灰，按出现顺序取；都占着或不够了就在灰里轮。
  const taken = new Set(
    windowed.flatMap((row) => {
      const fixed = FIXED_SWATCH[row.name.replace(DEFERRED_SUFFIX, '').toLowerCase()];
      return fixed === undefined ? [] : [fixed];
    }),
  );
  const free = GRAYS.filter((index) => !taken.has(index));
  const spare = free.length > 0 ? free : GRAYS;
  let nextSpare = 0;
  const swatchFor = (name: string, kind: BreakdownKind): string => {
    if (kind === 'free') return FREE_SWATCH;
    if (kind === 'buffer') return BUFFER_SWATCH;
    const fixed = FIXED_SWATCH[name.replace(DEFERRED_SUFFIX, '').toLowerCase()];
    if (fixed !== undefined) return SWATCHES[fixed] as string;
    const index = spare[nextSpare % spare.length] as number;
    nextSpare += 1;
    return SWATCHES[index] as string;
  };
  const toRow = (row: UsageBreakdown['categories'][number]): BreakdownRow => {
    const kind = kindOf(row.kind);
    return {
      label: categoryLabel(row.name),
      tokens: row.tokens,
      percent: kind === 'deferred' ? 0 : (row.tokens / total) * 100,
      kind,
      swatch: swatchFor(row.name, kind),
    };
  };

  const rank = { used: 0, buffer: 1, free: 2, deferred: 3 } as const;
  const rows = windowed
    .map(toRow)
    .sort((a, b) => rank[a.kind] - rank[b.kind] || b.tokens - a.tokens);
  const deferred = entries
    .filter((row) => kindOf(row.kind) === 'deferred')
    .map(toRow)
    .sort((a, b) => b.tokens - a.tokens);
  const groups = (breakdown.groups ?? [])
    .filter((group) => group.count > 0 && group.items.length > 0)
    .map((group) => ({
      id: group.group,
      label: groupLabel(group.group),
      count: group.count,
      items: group.items.map((item) => ({
        name: item.name,
        ...(item.source !== undefined && { source: item.source }),
        tokens: item.tokens,
      })),
    }));
  return { rows, deferred, groups };
}

/** 占比的写法：一位小数（21.0%）；不到 0.1% 写 <0.1%。 */
export function formatPercent(percent: number): string {
  if (percent > 0 && percent < 0.05) return '<0.1%';
  return `${percent.toFixed(1)}%`;
}
