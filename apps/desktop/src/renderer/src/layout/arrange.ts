// 窗格区的排布（R12，docs/architecture/desktop-layout.md §4）。纯函数：输入内容区的尺寸与一个会话的窗格状态，
// 输出窗格区停靠、浮层还是最大化，主窗格与窗格区各多宽，以及窗格区里的一棵窗格树（尺寸是像素）。
//
// 1. 窗格区最多能有 Amax = 内容区宽 − 主窗格最小宽 − 两道间距。按窗格数从模板里挑第一个放得下的；挑不到就把
//    最近没用的窗格并成标签（折叠）再挑，直到一个窗格。
// 2. 一个窗格也停靠不下时改浮层：浮层里只排一列。
// 3. 窗格区宽 = 记住的比例（按列数）× 内容区宽，夹在模板最小宽与 Amax 之间；模板里各窗格按记住的比例分，低于
//    最小尺寸的先补够。
// 例：内容区 1020 × 756（1280 × 800 的窗口、侧栏 260）开一个“概览” → 停靠，主窗格 596、窗格区 408。

import { PANE_KIND_SPECS } from './pane-kinds';
import {
  type PaneGroup,
  type PaneSizes,
  type PaneTab,
  PRIMARY,
  type ScopePanes,
} from './pane-state';

export const PANE_LAYOUT = {
  /** 窗格区停靠时主窗格至少这么宽（§4.1）。 */
  primaryMinWidth: 440,
  /** 主窗格与窗格区之间、窗格之间、窗格区与窗口边缘之间的间距；分隔条就在这里面。 */
  gap: 8,
  /** 窗格区默认宽占内容区宽的比例，按列数。 */
  auxRatio: { 1: 0.4, 2: 0.58 },
  overlayWidth: 420,
  /** 浮层最宽 = 内容区宽 − 这么多，左边总留一条能看到主窗格的边。 */
  overlayMargin: 48,
  maxVisible: 4,
  /** 会话侧栏（U18，§12）的宽，不含它右边的间距。 */
  railWidth: 288,
  /** 停靠的会话侧栏与窗口右边缘的间距：比 gap 宽，消息流贴着窗口右边的细滚动条（约 11 px）从这里过（§12）。 */
  railEdge: 12,
} as const;

export type TemplateId = 'one' | 'rows2' | 'cols2' | 'side3' | 'rows3' | 'grid4';

const COLUMNS: Record<TemplateId, 1 | 2> = {
  one: 1,
  rows2: 1,
  cols2: 2,
  side3: 2,
  rows3: 1,
  grid4: 2,
};

/** 要显示的一个窗格：一个窗格组，或空间不够时并在一起的几个（§4.4）。 */
export interface DisplayPane {
  /** 没有折叠时是窗格组的 ID；并在一起时取其中最近聚焦的那个。 */
  readonly id: string;
  /** 并在这里的窗格组，按排列顺序。 */
  readonly groupIds: readonly string[];
  readonly tabs: readonly PaneTab[];
  readonly activeTabId: string;
  /** 并在一起时每个窗格组的第一个标签的下标（标签条在这里画分隔）。没有折叠时是 [0]。 */
  readonly segmentStarts: readonly number[];
  readonly minWidth: number;
  readonly minHeight: number;
  readonly tall: boolean;
}

export type LayoutNode =
  | { readonly type: 'pane'; readonly pane: DisplayPane }
  | {
      readonly type: 'split';
      /** 记比例用的键：模板 ID，嵌套的节点加 `/<下标>`。 */
      readonly key: string;
      /** row：子节点左右排；column：上下排。 */
      readonly direction: 'row' | 'column';
      readonly children: readonly LayoutNode[];
      /** 子节点沿 direction 的像素尺寸，不含间距。 */
      readonly sizes: readonly number[];
      readonly mins: readonly number[];
    };

export type AuxMode = 'none' | 'docked' | 'overlay' | 'maximized';

export interface AuxPlan {
  readonly mode: AuxMode;
  /** 主窗格的宽；最大化时主窗格被盖住，为 0。 */
  readonly primaryWidth: number;
  /** 停靠时是窗格树的宽（不含外边距）；浮层时是浮层的宽（含 8 px 内边距）。 */
  readonly auxWidth: number;
  /** 停靠时拖动主窗格与窗格区之间的分隔条，窗格区宽的范围。 */
  readonly auxMinWidth: number;
  readonly auxMaxWidth: number;
  readonly columns: 1 | 2;
  readonly template?: TemplateId;
  readonly tree?: LayoutNode;
  /** 有窗格因为放不下被并成了标签。 */
  readonly folded: boolean;
}

export interface ArrangeInput {
  /** 内容区：侧栏右边、顶栏下面。 */
  width: number;
  height: number;
  /** 浮层可用的高（整窗高）。 */
  overlayHeight: number;
  panes: ScopePanes;
  /** 最大化的窗格组（只在本次运行内，§3.4）。 */
  maximized?: string;
}

const NONE = (width: number): AuxPlan => ({
  mode: 'none',
  primaryWidth: width,
  auxWidth: 0,
  auxMinWidth: 0,
  auxMaxWidth: 0,
  columns: 1,
  folded: false,
});

export function arrangePanes(input: ArrangeInput): AuxPlan {
  const { width, height, panes } = input;
  const { gap } = PANE_LAYOUT;
  if (!panes.auxVisible || panes.groups.length === 0) return NONE(width);

  const maximized = panes.groups.find((group) => group.id === input.maximized);
  if (maximized) {
    return {
      ...NONE(width),
      mode: 'maximized',
      primaryWidth: 0,
      auxWidth: width - 2 * gap,
      template: 'one',
      tree: { type: 'pane', pane: displayPane([maximized], maximized) },
    };
  }

  const regionHeight = height - 2 * gap;
  const maxAux = width - PANE_LAYOUT.primaryMinWidth - 2 * gap;
  const docked = choose(panes, maxAux, regionHeight, 2);
  if (docked) {
    const columns = COLUMNS[docked.template];
    const ratio = panes.sizes.aux[columns] ?? PANE_LAYOUT.auxRatio[columns];
    const auxWidth = clamp(Math.round(ratio * width), docked.minWidth, maxAux);
    return {
      mode: 'docked',
      primaryWidth: width - auxWidth - 2 * gap,
      auxWidth,
      auxMinWidth: docked.minWidth,
      auxMaxWidth: maxAux,
      columns,
      template: docked.template,
      tree: buildTree(docked.template, docked.display, auxWidth, regionHeight, panes.sizes),
      folded: docked.folded,
    };
  }

  const overlayHeight = input.overlayHeight - 2 * gap;
  const single = choose(panes, Number.POSITIVE_INFINITY, overlayHeight, 1) ?? foldAll(panes);
  const overlayWidth = Math.max(
    0,
    Math.min(
      width - PANE_LAYOUT.overlayMargin,
      Math.max(PANE_LAYOUT.overlayWidth, single.minWidth + 2 * gap),
    ),
  );
  return {
    ...NONE(width),
    mode: 'overlay',
    auxWidth: overlayWidth,
    template: single.template,
    tree: buildTree(
      single.template,
      single.display,
      overlayWidth - 2 * gap,
      overlayHeight,
      panes.sizes,
    ),
    folded: single.folded,
  };
}

interface Choice {
  template: TemplateId;
  display: DisplayPane[];
  minWidth: number;
  minHeight: number;
  folded: boolean;
}

/** 从多到少试要显示的窗格数，每个数按候选顺序试模板，返回第一个放得下的。 */
function choose(
  panes: ScopePanes,
  maxWidth: number,
  maxHeight: number,
  maxColumns: 1 | 2,
): Choice | undefined {
  const total = panes.groups.length;
  for (let count = Math.min(total, PANE_LAYOUT.maxVisible); count >= 1; count--) {
    const display = foldPanes(panes.groups, panes.focus, count);
    for (const template of candidates(display, panes.splitHint)) {
      if (COLUMNS[template] > maxColumns) continue;
      const min = templateMin(template, display);
      if (min.width <= maxWidth && min.height <= maxHeight) {
        return {
          template,
          display,
          minWidth: min.width,
          minHeight: min.height,
          folded: count < total,
        };
      }
    }
  }
  return undefined;
}

function foldAll(panes: ScopePanes): Choice {
  const display = foldPanes(panes.groups, panes.focus, 1);
  const min = templateMin('one', display);
  return {
    template: 'one',
    display,
    minWidth: min.width,
    minHeight: min.height,
    folded: panes.groups.length > 1,
  };
}

/** 各窗格数的候选模板，按顺序试（§4.3）。 */
export function candidates(
  display: readonly DisplayPane[],
  hint: ScopePanes['splitHint'],
): TemplateId[] {
  switch (display.length) {
    case 1:
      return ['one'];
    case 2: {
      const preferColumns =
        hint === 'right' || (hint === undefined && display.every((pane) => pane.tall));
      return preferColumns ? ['cols2', 'rows2'] : ['rows2', 'cols2'];
    }
    case 3:
      return ['side3', 'rows3'];
    default:
      return ['grid4'];
  }
}

function sumWithGaps(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) + PANE_LAYOUT.gap * (values.length - 1);
}

function maxOf(panes: readonly DisplayPane[], key: 'minWidth' | 'minHeight'): number {
  return Math.max(...panes.map((pane) => pane[key]));
}

/** 窗格在 side3 里的位置：T 是排列顺序里第一个“高”的窗格（都不是就取第一个），其余两个保持顺序。 */
function side3Order(display: readonly DisplayPane[]): [DisplayPane, DisplayPane, DisplayPane] {
  const tallIndex = Math.max(
    0,
    display.findIndex((pane) => pane.tall),
  );
  const rest = display.filter((_, index) => index !== tallIndex);
  return [display[tallIndex], rest[0], rest[1]] as [DisplayPane, DisplayPane, DisplayPane];
}

export function templateMin(
  template: TemplateId,
  display: readonly DisplayPane[],
): { width: number; height: number } {
  const [a, b, c, d] = display as DisplayPane[];
  switch (template) {
    case 'one':
      return { width: maxOf(display, 'minWidth'), height: maxOf(display, 'minHeight') };
    case 'rows2':
    case 'rows3':
      return {
        width: maxOf(display, 'minWidth'),
        height: sumWithGaps(display.map((pane) => pane.minHeight)),
      };
    case 'cols2':
      return {
        width: sumWithGaps(display.map((pane) => pane.minWidth)),
        height: maxOf(display, 'minHeight'),
      };
    case 'side3': {
      const [tall, x, y] = side3Order(display);
      return {
        width: sumWithGaps([tall.minWidth, Math.max(x.minWidth, y.minWidth)]),
        height: Math.max(tall.minHeight, sumWithGaps([x.minHeight, y.minHeight])),
      };
    }
    case 'grid4':
      if (!a || !b || !c || !d) throw new Error('grid4 needs four panes');
      return {
        width: sumWithGaps([Math.max(a.minWidth, b.minWidth), Math.max(c.minWidth, d.minWidth)]),
        height: Math.max(
          sumWithGaps([a.minHeight, b.minHeight]),
          sumWithGaps([c.minHeight, d.minHeight]),
        ),
      };
  }
}

function displayPane(groups: readonly PaneGroup[], active: PaneGroup): DisplayPane {
  const tabs = groups.flatMap((group) => group.tabs);
  const segmentStarts: number[] = [];
  let offset = 0;
  for (const group of groups) {
    segmentStarts.push(offset);
    offset += group.tabs.length;
  }
  const specs = tabs.map((tab) => PANE_KIND_SPECS[tab.kind]);
  return {
    id: active.id,
    groupIds: groups.map((group) => group.id),
    tabs,
    activeTabId: active.activeTabId,
    segmentStarts,
    minWidth: Math.max(...specs.map((spec) => spec.minWidth)),
    minHeight: Math.max(...specs.map((spec) => spec.minHeight)),
    tall: specs.some((spec) => spec.shape === 'tall'),
  };
}

/**
 * 折叠到 count 个（§4.4）：排列顺序里前 count − 1 个窗格原样显示，其余的并成最后一个。并在一起的那个以其中
 * 最近聚焦的窗格为准（ID 与当前标签），所以刚打开的窗格放不下时会作为当前标签出现在最后一个窗格里。按排列顺序
 * 而不按焦点决定谁被并，点进窗格时布局不会跳。
 */
export function foldPanes(
  groups: readonly PaneGroup[],
  focus: readonly string[],
  count: number,
): DisplayPane[] {
  if (count >= groups.length) return groups.map((group) => displayPane([group], group));
  const kept = groups.slice(0, Math.max(0, count - 1));
  const merged = groups.slice(kept.length);
  const recency = (group: PaneGroup) => {
    const at = focus.indexOf(group.id);
    return at >= 0 ? at : focus.length + (merged.length - merged.indexOf(group));
  };
  const leader = merged.reduce((best, group) => (recency(group) < recency(best) ? group : best));
  return [...kept.map((group) => displayPane([group], group)), displayPane(merged, leader)];
}

/** 竖着叠放时“高”的窗格分得多一些（3 : 2），横着排时平分。 */
function defaultFractions(panes: readonly DisplayPane[], direction: 'row' | 'column'): number[] {
  const weights = panes.map((pane) => (direction === 'column' && !pane.tall ? 2 : 3));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
}

function fractionsFor(
  sizes: PaneSizes,
  key: string,
  fallback: readonly number[],
): readonly number[] {
  const stored = sizes.splits[key];
  return stored && stored.length === fallback.length ? stored : fallback;
}

/**
 * 按比例把 total 分给各子节点，每个不少于自己的最小值：低于最小值的先补够，差额从其余的按比例扣，直到都够；
 * 最小值加起来都放不下时按最小值的比例分。结果是整数，和等于 total。
 */
export function distribute(
  total: number,
  fractions: readonly number[],
  mins: readonly number[],
): number[] {
  const minSum = mins.reduce((sum, min) => sum + min, 0);
  let raw: number[];
  if (minSum >= total) {
    raw = mins.map((min) => (minSum === 0 ? total / mins.length : (min / minSum) * total));
  } else {
    const fixed = new Map<number, number>();
    for (;;) {
      const freeIndexes = fractions.map((_, index) => index).filter((index) => !fixed.has(index));
      const fixedSum = [...fixed.values()].reduce((sum, value) => sum + value, 0);
      const freeFraction = freeIndexes.reduce((sum, index) => sum + (fractions[index] ?? 0), 0);
      const remaining = total - fixedSum;
      raw = fractions.map((fraction, index) =>
        fixed.has(index)
          ? (fixed.get(index) as number)
          : freeFraction > 0
            ? (fraction / freeFraction) * remaining
            : remaining / freeIndexes.length,
      );
      const short = freeIndexes.filter((index) => (raw[index] ?? 0) < (mins[index] ?? 0));
      if (short.length === 0) break;
      for (const index of short) fixed.set(index, mins[index] ?? 0);
    }
  }
  // 取整：先向下取整，剩下的像素按小数部分从大到小补。
  const floors = raw.map(Math.floor);
  let rest = total - floors.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((x, y) => y.fraction - x.fraction);
  for (const { index } of order) {
    if (rest <= 0) break;
    floors[index] = (floors[index] ?? 0) + 1;
    rest--;
  }
  return floors;
}

function split(
  key: string,
  direction: 'row' | 'column',
  children: LayoutNode[],
  mins: number[],
  defaults: readonly number[],
  length: number,
  sizes: PaneSizes,
): LayoutNode {
  const available = length - PANE_LAYOUT.gap * (children.length - 1);
  return {
    type: 'split',
    key,
    direction,
    children,
    mins,
    sizes: distribute(available, fractionsFor(sizes, key, defaults), mins),
  };
}

const leaf = (pane: DisplayPane): LayoutNode => ({ type: 'pane', pane });

function buildTree(
  template: TemplateId,
  display: readonly DisplayPane[],
  width: number,
  height: number,
  sizes: PaneSizes,
): LayoutNode {
  const column = (key: string, panes: readonly DisplayPane[]) =>
    split(
      key,
      'column',
      panes.map(leaf),
      panes.map((pane) => pane.minHeight),
      defaultFractions(panes, 'column'),
      height,
      sizes,
    );
  switch (template) {
    case 'one':
      return leaf(display[0] as DisplayPane);
    case 'rows2':
    case 'rows3':
      return column(template, display);
    case 'cols2':
      return split(
        template,
        'row',
        display.map(leaf),
        display.map((pane) => pane.minWidth),
        defaultFractions(display, 'row'),
        width,
        sizes,
      );
    case 'side3': {
      const [tall, x, y] = side3Order(display);
      return split(
        template,
        'row',
        [leaf(tall), column(`${template}/1`, [x, y])],
        [tall.minWidth, Math.max(x.minWidth, y.minWidth)],
        [0.5, 0.5],
        width,
        sizes,
      );
    }
    case 'grid4': {
      const left = display.slice(0, 2);
      const right = display.slice(2, 4);
      return split(
        template,
        'row',
        [column(`${template}/0`, left), column(`${template}/1`, right)],
        [maxOf(left, 'minWidth'), maxOf(right, 'minWidth')],
        [0.5, 0.5],
        width,
        sizes,
      );
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

// —— 拖动分隔条（§3.3） ——

/** 拖动主窗格与窗格区之间的分隔条（向左为负）：新的窗格区宽度比例。 */
export function auxRatioAfterDrag(
  plan: AuxPlan,
  contentWidth: number,
  startWidth: number,
  delta: number,
): number {
  const width = clamp(startWidth - delta, plan.auxMinWidth, plan.auxMaxWidth);
  return width / contentWidth;
}

/** 拖动拆分节点里第 index 与 index + 1 个子节点之间的分隔条：两个子节点此消彼长，各不小于最小值。 */
export function fractionsAfterDrag(
  sizes: readonly number[],
  mins: readonly number[],
  index: number,
  delta: number,
): number[] {
  const first = sizes[index] ?? 0;
  const second = sizes[index + 1] ?? 0;
  const pair = first + second;
  const nextFirst = clamp(first + delta, mins[index] ?? 0, pair - (mins[index + 1] ?? 0));
  const next = [...sizes];
  next[index] = nextFirst;
  next[index + 1] = pair - nextFirst;
  const total = next.reduce((sum, value) => sum + value, 0);
  return next.map((value) => value / total);
}

// —— 窗格的位置：键盘在窗格间移动焦点用（§3.10） ——

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function paneRects(
  node: LayoutNode,
  rect: Rect,
  out = new Map<string, Rect>(),
): Map<string, Rect> {
  if (node.type === 'pane') {
    out.set(node.pane.id, rect);
    return out;
  }
  let offset = node.direction === 'row' ? rect.x : rect.y;
  node.children.forEach((child, index) => {
    const size = node.sizes[index] ?? 0;
    paneRects(
      child,
      node.direction === 'row'
        ? { x: offset, y: rect.y, width: size, height: rect.height }
        : { x: rect.x, y: offset, width: rect.width, height: size },
      out,
    );
    offset += size + PANE_LAYOUT.gap;
  });
  return out;
}

/** 键盘在窗格间移动的顺序：主窗格在前，窗格区里从左到右、从上到下。 */
export function focusOrder(plan: AuxPlan): string[] {
  const order = plan.mode === 'maximized' ? [] : [PRIMARY];
  if (!plan.tree) return order;
  const rects = paneRects(plan.tree, { x: 0, y: 0, width: plan.auxWidth, height: 10_000 });
  const panes = [...rects.entries()].sort(([, a], [, b]) => a.x - b.x || a.y - b.y);
  return [...order, ...panes.map(([id]) => id)];
}

/** 所有显示出来的窗格（叶子），按树的顺序。 */
export function displayPanes(node: LayoutNode | undefined): DisplayPane[] {
  if (!node) return [];
  if (node.type === 'pane') return [node.pane];
  return node.children.flatMap(displayPanes);
}
