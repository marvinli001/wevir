import { describe, expect, it } from 'vitest';
import {
  type AuxPlan,
  arrangePanes,
  auxRatioAfterDrag,
  displayPanes,
  distribute,
  focusOrder,
  foldPanes,
  fractionsAfterDrag,
  type LayoutNode,
  PANE_LAYOUT,
} from './arrange';
import type { PaneKind } from './pane-kinds';
import { EMPTY_SIZES, type PaneGroup, PRIMARY, type ScopePanes } from './pane-state';

/** 每个种类一个窗格组，组 ID 就是种类名（同种的第二个加后缀）。 */
function scope(kinds: PaneKind[], extra: Partial<ScopePanes> = {}): ScopePanes {
  const groups: PaneGroup[] = kinds.map((kind, index) => {
    const id = kinds.indexOf(kind) === index ? kind : `${kind}-${index}`;
    return { id, tabs: [{ id: `${id}-tab`, kind }], activeTabId: `${id}-tab` };
  });
  return { groups, focus: [], auxVisible: true, sizes: EMPTY_SIZES, ...extra };
}

/** 视口 → 内容区：减去停靠的侧栏与 44 px 的顶栏。 */
function arrange(
  viewport: [number, number],
  panes: ScopePanes,
  {
    sidebar = 260,
    maximized,
    maxColumns,
  }: { sidebar?: number; maximized?: string; maxColumns?: 1 | 2 } = {},
): AuxPlan {
  const [width, height] = viewport;
  return arrangePanes({
    width: width - sidebar,
    height: height - 44,
    overlayHeight: height,
    panes,
    maximized,
    maxColumns,
  });
}

/** 树的形状，便于断言：叶子是窗格 ID，拆分是 `row(...)` / `column(...)`。 */
function shape(node: LayoutNode | undefined): string {
  if (!node) return '';
  if (node.type === 'pane') return node.pane.id;
  return `${node.direction}(${node.children.map(shape).join(', ')})`;
}

describe('arrangePanes：§4.5 的例子（侧栏 260 停靠）', () => {
  it('1280 × 800，没有窗格：单窗格', () => {
    expect(arrange([1280, 800], scope([]))).toMatchObject({ mode: 'none', primaryWidth: 1020 });
  });

  it('1280 × 800，概览：左右，主窗格 596 / 窗格区 408', () => {
    const plan = arrange([1280, 800], scope(['overview']));
    expect(plan).toMatchObject({
      mode: 'docked',
      template: 'one',
      primaryWidth: 596,
      auxWidth: 408,
      columns: 1,
    });
    expect(plan.primaryWidth + plan.auxWidth + 2 * PANE_LAYOUT.gap).toBe(1020);
  });

  it('1280 × 800，子智能体 + 变更：两个都高，左右放不下，改上下', () => {
    const plan = arrange([1280, 800], scope(['subagents', 'changes']));
    expect(plan).toMatchObject({ mode: 'docked', template: 'rows2', auxWidth: 408 });
    expect(shape(plan.tree)).toBe('column(subagents, changes)');
    // 窗格区高 800 − 44 − 16 = 740，两个都高，平分。
    expect(plan.tree).toMatchObject({ sizes: [366, 366] });
  });

  it('1280 × 800，后台任务 + 文件 + 计划：side3 放不下，三个上下；“矮”的计划分得少', () => {
    const plan = arrange([1280, 800], scope(['tasks', 'file', 'plan']));
    expect(plan).toMatchObject({ mode: 'docked', template: 'rows3', primaryWidth: 596 });
    expect(shape(plan.tree)).toBe('column(tasks, file, plan)');
    // 724 按 3 : 3 : 2 分。
    expect(plan.tree).toMatchObject({ sizes: [272, 271, 181] });
  });

  it('1440 × 900：一列高 + 一列上下（截图 05 的排法）', () => {
    const plan = arrange([1440, 900], scope(['tasks', 'file', 'plan']));
    expect(plan).toMatchObject({
      template: 'side3',
      primaryWidth: 480,
      auxWidth: 684,
      columns: 2,
    });
    expect(shape(plan.tree)).toBe('row(tasks, column(file, plan))');
  });

  it('1920 × 1080：side3，两列默认占内容区的 58%', () => {
    const plan = arrange([1920, 1080], scope(['tasks', 'file', 'plan']));
    expect(plan).toMatchObject({ template: 'side3', primaryWidth: 681, auxWidth: 963 });
  });

  it('side3 的整列给排列顺序里第一个“高”的窗格', () => {
    const plan = arrange([1920, 1080], scope(['plan', 'overview', 'file']));
    expect(shape(plan.tree)).toBe('row(file, column(plan, overview))');
  });

  it('1920 × 1080，两个文件：都高，左右', () => {
    const plan = arrange([1920, 1080], scope(['file', 'file']));
    expect(plan).toMatchObject({ template: 'cols2', auxWidth: 963 });
    expect(plan.tree).toMatchObject({ sizes: [478, 477] });
  });

  it('拆分方向优先：拆到下方的两个文件上下排', () => {
    const plan = arrange([1920, 1080], scope(['file', 'file'], { splitHint: 'down' }));
    expect(plan.template).toBe('rows2');
  });

  it('1920 × 1080，四个窗格：网格', () => {
    const plan = arrange([1920, 1080], scope(['subagents', 'changes', 'tasks', 'plan']));
    expect(plan.template).toBe('grid4');
    expect(shape(plan.tree)).toBe('row(column(subagents, changes), column(tasks, plan))');
  });

  it('960 × 600，概览：停靠不下（Amax 244 < 280），改浮层 420', () => {
    expect(arrange([960, 600], scope(['overview']))).toMatchObject({
      mode: 'overlay',
      primaryWidth: 700,
      auxWidth: 420,
    });
  });

  it('960 × 600、侧栏收起，概览：左右，主窗格 560 / 窗格区 384', () => {
    expect(arrange([960, 600], scope(['overview']), { sidebar: 0 })).toMatchObject({
      mode: 'docked',
      primaryWidth: 560,
      auxWidth: 384,
    });
  });

  it('960 × 600、侧栏收起，子智能体 + 变更：上下', () => {
    const plan = arrange([960, 600], scope(['subagents', 'changes']), { sidebar: 0 });
    expect(plan).toMatchObject({ mode: 'docked', template: 'rows2', auxWidth: 384 });
  });

  it('960 × 600、侧栏收起，三个窗格放不下：后台任务原样，文件与计划并成一个，当前是最近聚焦的文件', () => {
    const panes = scope(['tasks', 'file', 'plan'], { focus: ['file', 'plan', 'tasks'] });
    const plan = arrange([960, 600], panes, { sidebar: 0 });
    expect(plan).toMatchObject({ mode: 'docked', template: 'rows2', folded: true });
    const [tasks, merged] = displayPanes(plan.tree);
    expect(tasks?.groupIds).toEqual(['tasks']);
    expect(merged).toMatchObject({
      id: 'file',
      groupIds: ['file', 'plan'],
      activeTabId: 'file-tab',
      segmentStarts: [0, 1],
    });
    expect(merged?.tabs.map((tab) => tab.kind)).toEqual(['file', 'plan']);
  });

  it('760 × 600（放大界面，侧栏浮层）：概览仍能停靠，主窗格 440', () => {
    expect(arrange([760, 600], scope(['overview']), { sidebar: 0 })).toMatchObject({
      mode: 'docked',
      primaryWidth: 440,
      auxWidth: 304,
    });
  });

  it('720 × 600：窗格区也改浮层', () => {
    expect(arrange([720, 600], scope(['overview']), { sidebar: 0 })).toMatchObject({
      mode: 'overlay',
      auxWidth: 420,
      primaryWidth: 720,
    });
  });
});

describe('arrangePanes：其他规则', () => {
  it('窗格区收起时主窗格占满，窗格还在', () => {
    expect(arrange([1280, 800], scope(['overview'], { auxVisible: false }))).toMatchObject({
      mode: 'none',
      primaryWidth: 1020,
    });
  });

  it('最大化：那个窗格占满内容区（留 8 px 边），主窗格被盖住', () => {
    const plan = arrange([1280, 800], scope(['overview', 'tasks']), { maximized: 'tasks' });
    expect(plan).toMatchObject({ mode: 'maximized', primaryWidth: 0, auxWidth: 1004 });
    expect(shape(plan.tree)).toBe('tasks');
  });

  it('最大化的窗格不在了就照常排', () => {
    expect(arrange([1280, 800], scope(['overview']), { maximized: 'gone' }).mode).toBe('docked');
  });

  it('记住的窗格区比例按列数生效，夹在模板最小宽与 Amax 之间', () => {
    const ratio = (aux: number) =>
      arrange([1280, 800], scope(['overview'], { sizes: { aux: { 1: aux }, splits: {} } }));
    expect(ratio(0.5).auxWidth).toBe(510);
    expect(ratio(0.9).auxWidth).toBe(1020 - 440 - 16);
    expect(ratio(0.1).auxWidth).toBe(280);
    // 一列的比例不影响两列的排布。
    const wide = arrange(
      [1920, 1080],
      scope(['tasks', 'file', 'plan'], { sizes: { aux: { 1: 0.3 }, splits: {} } }),
    );
    expect(wide.auxWidth).toBe(963);
  });

  it('记住的拆分比例按节点生效，仍不小于最小高', () => {
    const plan = arrange(
      [1280, 800],
      scope(['subagents', 'changes'], { sizes: { aux: {}, splits: { rows2: [0.2, 0.8] } } }),
    );
    // 732 × 0.2 = 146 < 子智能体的最小高 200，补到 200。
    expect(plan.tree).toMatchObject({ sizes: [200, 532] });
  });

  it('五个窗格先折叠成四个', () => {
    const plan = arrange(
      [1920, 1080],
      scope(['subagents', 'changes', 'tasks', 'plan', 'overview']),
    );
    expect(plan).toMatchObject({ template: 'grid4', folded: true });
    expect(displayPanes(plan.tree)).toHaveLength(4);
  });

  it('浮层里只排一列：三个上下放不下就折叠成两个，再矮就全部并成一个', () => {
    const plan = arrange([720, 600], scope(['tasks', 'file', 'plan']), { sidebar: 0 });
    expect(plan).toMatchObject({ mode: 'overlay', template: 'rows2', folded: true });
    const low = arrange([720, 420], scope(['tasks', 'file', 'plan']), { sidebar: 0 });
    expect(low).toMatchObject({ mode: 'overlay', template: 'one', folded: true });
    expect(displayPanes(low.tree)[0]?.tabs).toHaveLength(3);
  });

  it('会话侧栏停靠时只排一列：两个高窗格也上下叠放，四个折叠成三个上下', () => {
    // 2000 × 900、左栏 300，扣掉侧栏 300 后排 1400 宽。
    const options = { sidebar: 600, maxColumns: 1 } as const;
    const two = arrange([2000, 900], scope(['tasks', 'files']), options);
    expect(two).toMatchObject({
      mode: 'docked',
      template: 'rows2',
      columns: 1,
      auxWidth: 560,
      primaryWidth: 824,
    });
    expect(arrange([2000, 900], scope(['tasks', 'files']), { sidebar: 600 })).toMatchObject({
      template: 'cols2',
    });
    const four = arrange([2000, 900], scope(['subagents', 'changes', 'tasks', 'plan']), options);
    expect(four).toMatchObject({ template: 'rows3', folded: true });
    expect(shape(four.tree)).toBe('column(subagents, changes, plan)');
  });
});

describe('foldPanes', () => {
  const groups = scope(['tasks', 'file', 'plan', 'overview']).groups;

  it('不需要折叠时原样', () => {
    expect(foldPanes(groups, [], 4).map((pane) => pane.id)).toEqual([
      'tasks',
      'file',
      'plan',
      'overview',
    ]);
  });

  it('排列顺序里前面的原样，其余的并成最后一个；没有焦点记录时以排得最后的为准', () => {
    const folded = foldPanes(groups, [], 2);
    expect(folded.map((pane) => pane.groupIds)).toEqual([['tasks'], ['file', 'plan', 'overview']]);
    expect(folded[1]).toMatchObject({ id: 'overview', activeTabId: 'overview-tab' });
  });

  it('焦点只决定并在一起的那个显示哪个标签，不改变谁被并', () => {
    const folded = foldPanes(groups, ['tasks', 'plan'], 2);
    expect(folded.map((pane) => pane.groupIds)).toEqual([['tasks'], ['file', 'plan', 'overview']]);
    expect(folded[1]).toMatchObject({ id: 'plan', activeTabId: 'plan-tab' });
  });

  it('折叠成一个时全部并在一起，当前标签取最近聚焦的那个窗格', () => {
    const [only] = foldPanes(groups, ['file'], 1);
    expect(only).toMatchObject({ id: 'file', activeTabId: 'file-tab' });
    expect(only?.segmentStarts).toEqual([0, 1, 2, 3]);
  });
});

describe('distribute', () => {
  it('按比例分，取整后和不变', () => {
    expect(distribute(100, [1 / 3, 1 / 3, 1 / 3], [0, 0, 0])).toEqual([34, 33, 33]);
  });

  it('不够最小值的先补够，差额从其余的扣', () => {
    expect(distribute(500, [0.1, 0.45, 0.45], [100, 0, 0])).toEqual([100, 200, 200]);
  });

  it('最小值加起来都放不下时按最小值的比例分', () => {
    expect(distribute(300, [0.5, 0.5], [200, 400])).toEqual([100, 200]);
  });
});

describe('拖动分隔条', () => {
  it('窗格区宽：向左拖变宽，夹在范围内', () => {
    const plan = arrange([1280, 800], scope(['overview']));
    expect(auxRatioAfterDrag(plan, 1020, 408, -102)).toBeCloseTo(0.5);
    expect(auxRatioAfterDrag(plan, 1020, 408, 1000)).toBeCloseTo(280 / 1020);
    expect(auxRatioAfterDrag(plan, 1020, 408, -1000)).toBeCloseTo(564 / 1020);
  });

  it('拆分比例：两侧此消彼长，各不小于最小值', () => {
    expect(fractionsAfterDrag([300, 300], [100, 100], 0, 100)).toEqual([400 / 600, 200 / 600]);
    expect(fractionsAfterDrag([300, 300], [100, 100], 0, 1000)).toEqual([500 / 600, 100 / 600]);
    expect(fractionsAfterDrag([200, 200, 200], [100, 100, 100], 1, -150)).toEqual([
      1 / 3,
      100 / 600,
      300 / 600,
    ]);
  });
});

describe('focusOrder', () => {
  it('主窗格在前，窗格区从左到右、从上到下', () => {
    const plan = arrange([1920, 1080], scope(['subagents', 'changes', 'tasks', 'plan']));
    expect(focusOrder(plan)).toEqual([PRIMARY, 'subagents', 'changes', 'tasks', 'plan']);
  });

  it('最大化时只有那个窗格', () => {
    const plan = arrange([1280, 800], scope(['overview', 'tasks']), { maximized: 'tasks' });
    expect(focusOrder(plan)).toEqual(['tasks']);
  });
});
