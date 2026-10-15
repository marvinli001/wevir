import { describe, expect, it } from 'vitest';
import { openableKinds, paneIdentity } from './pane-kinds';
import {
  activateTab,
  closeGroup,
  closeTab,
  cycleTab,
  EMPTY_STORED,
  emptyScope,
  focusedGroup,
  focusPane,
  MAX_STORED_SCOPES,
  moveScope,
  moveTab,
  openPane,
  PRIMARY,
  paneScopeKey,
  parseScopePanes,
  parseStoredPanes,
  pruneStored,
  resetAuxRatio,
  resetSplitRatios,
  type ScopePanes,
  scopeOf,
  setAuxRatio,
  setSplitRatios,
  splitTab,
  storeScope,
  tabCount,
  toggleAux,
} from './pane-state';

function ids() {
  let next = 0;
  return () => `id${++next}`;
}

/** 依次打开几个标签。 */
function opened(...requests: Parameters<typeof openPane>[1][]): ScopePanes {
  const newId = ids();
  return requests.reduce((state, request) => openPane(state, request, newId), emptyScope());
}

describe('pane-kinds', () => {
  it('单开的种类按种类判同一个；能多开的按参数，没有参数就每次新开', () => {
    expect(paneIdentity('overview', undefined)).toBe('overview');
    expect(paneIdentity('file', { path: 'a.ts' })).toBe('file:a.ts');
    expect(paneIdentity('file', undefined)).toBeUndefined();
  });

  it('正式构建只能打开已经实现的种类，开发模式下还有占位', () => {
    expect(openableKinds(false)).toEqual(['subagents', 'tasks']);
    expect(openableKinds(true)).toContain('terminal');
  });
});

describe('openPane', () => {
  it('新种类自成一个窗格放在最后，获得焦点，窗格区显示', () => {
    const state = opened({ kind: 'overview' }, { kind: 'tasks' });
    expect(state.groups.map((group) => group.tabs.map((tab) => tab.kind))).toEqual([
      ['overview'],
      ['tasks'],
    ]);
    expect(state.focus).toEqual(['id4', 'id2']);
    expect(state.auxVisible).toBe(true);
  });

  it('已经开着同一个就激活它，不重复开', () => {
    const state = opened(
      { kind: 'file', params: { path: 'a.ts' } },
      { kind: 'file', params: { path: 'b.ts' } },
      { kind: 'overview' },
      { kind: 'file', params: { path: 'a.ts' } },
    );
    expect(tabCount(state)).toBe(3);
    expect(state.groups[0]).toMatchObject({ activeTabId: 'id1' });
    expect(state.focus[0]).toBe('id2');
  });

  it('能多开的种类加进已经装着同种标签的窗格', () => {
    const state = opened(
      { kind: 'file', params: { path: 'a.ts' } },
      { kind: 'overview' },
      { kind: 'file', params: { path: 'b.ts' } },
    );
    expect(state.groups).toHaveLength(2);
    expect(state.groups[0]?.tabs.map((tab) => tab.params?.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('从“＋”打开的加进那个窗格', () => {
    const state = opened({ kind: 'overview' }, { kind: 'plan', into: 'id2' });
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]).toMatchObject({ activeTabId: 'id3' });
  });

  it('在收起的窗格区里激活已有的标签会显示窗格区', () => {
    const hidden = { ...opened({ kind: 'overview' }), auxVisible: false };
    expect(openPane(hidden, { kind: 'overview' }, ids()).auxVisible).toBe(true);
  });
});

describe('关闭', () => {
  it('关掉当前标签后激活同位置的下一个，没有就上一个', () => {
    const state = opened(
      { kind: 'file', params: { path: 'a' } },
      { kind: 'file', params: { path: 'b' } },
      { kind: 'file', params: { path: 'c' } },
    );
    const middle = closeTab(activateTab(state, 'id3'), 'id3');
    expect(middle.groups[0]?.activeTabId).toBe('id4');
    const last = closeTab(state, 'id4');
    expect(last.groups[0]?.activeTabId).toBe('id3');
  });

  it('窗格里最后一个标签关掉，窗格就没了；最后一个窗格关掉，窗格区收起', () => {
    const state = opened({ kind: 'overview' }, { kind: 'tasks' });
    const one = closeTab(state, 'id3');
    expect(one.groups).toHaveLength(1);
    expect(one.focus).toEqual(['id2']);
    const none = closeGroup(one, 'id2');
    expect(none).toMatchObject({ groups: [], focus: [], auxVisible: false });
  });
});

describe('拆分、移动、切换', () => {
  const twoFiles = () =>
    opened({ kind: 'file', params: { path: 'a' } }, { kind: 'file', params: { path: 'b' } });

  it('拆分把标签移进紧跟在后面的新窗格，记下方向', () => {
    const state = splitTab(
      opened(
        { kind: 'overview' },
        { kind: 'file', params: { path: 'a' } },
        { kind: 'file', params: { path: 'b' } },
      ),
      'id5',
      'right',
      () => 'new',
    );
    expect(state.groups.map((group) => group.id)).toEqual(['id2', 'id4', 'new']);
    expect(state.groups[1]?.tabs.map((tab) => tab.id)).toEqual(['id3']);
    expect(state).toMatchObject({ splitHint: 'right', focus: ['new', 'id4', 'id2'] });
  });

  it('只有一个标签的窗格不能拆', () => {
    const state = opened({ kind: 'overview' });
    expect(splitTab(state, 'id1', 'down', ids())).toBe(state);
  });

  it('移动标签到另一个窗格，原窗格空了就去掉', () => {
    const split = splitTab(twoFiles(), 'id3', 'right', () => 'new');
    const merged = moveTab(split, 'id3', 'id2');
    expect(merged.groups).toHaveLength(1);
    expect(merged.groups[0]).toMatchObject({ activeTabId: 'id3' });
    expect(merged.focus).toEqual(['id2']);
  });

  it('下一个 / 上一个标签首尾相接', () => {
    const state = twoFiles();
    expect(cycleTab(state, 'id2', 1).groups[0]?.activeTabId).toBe('id1');
    expect(cycleTab(state, 'id2', -1).groups[0]?.activeTabId).toBe('id1');
  });

  it('焦点：已经是最近的就原样返回；最近聚焦的窗格不算主窗格', () => {
    const state = opened({ kind: 'overview' }, { kind: 'tasks' });
    expect(focusPane(state, 'id4')).toBe(state);
    const primary = focusPane(state, PRIMARY);
    expect(primary.focus).toEqual([PRIMARY, 'id4', 'id2']);
    expect(focusedGroup(primary)?.id).toBe('id4');
    expect(focusPane(state, 'missing')).toBe(state);
  });
});

describe('窗格区开关与尺寸', () => {
  it('没有窗格时打开后台任务，否则显示或收起（不关窗格）', () => {
    const opened1 = toggleAux(emptyScope(), ids());
    expect(opened1.groups[0]?.tabs[0]?.kind).toBe('tasks');
    const hidden = toggleAux(opened1, ids());
    expect(hidden).toMatchObject({ auxVisible: false });
    expect(hidden.groups).toHaveLength(1);
  });

  it('比例只接受 (0, 1) 与和为 1 的数组', () => {
    const state = emptyScope();
    expect(setAuxRatio(state, 1, 0.5).sizes.aux).toEqual({ 1: 0.5 });
    expect(setAuxRatio(state, 1, 1.5)).toBe(state);
    expect(setSplitRatios(state, 'rows2', [0.3, 0.7]).sizes.splits).toEqual({ rows2: [0.3, 0.7] });
    expect(setSplitRatios(state, 'rows2', [0.3, 0.3])).toBe(state);
  });

  it('双击分隔条回到默认比例', () => {
    const state = setSplitRatios(setAuxRatio(emptyScope(), 1, 0.5), 'rows2', [0.3, 0.7]);
    expect(resetAuxRatio(state, 1).sizes).toEqual({ aux: {}, splits: { rows2: [0.3, 0.7] } });
    expect(resetSplitRatios(state, 'rows2').sizes).toEqual({ aux: { 1: 0.5 }, splits: {} });
    expect(resetSplitRatios(state, 'cols2')).toBe(state);
  });
});

describe('parseScopePanes', () => {
  it('合格的状态原样读回', () => {
    const state = setAuxRatio(
      opened({ kind: 'overview' }, { kind: 'file', params: { path: 'a' } }),
      2,
      0.6,
    );
    expect(parseScopePanes(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('不认识的种类、格式不对的标签与重复的 ID 丢掉，丢空的窗格丢掉，当前标签与焦点随之修正', () => {
    const parsed = parseScopePanes({
      groups: [
        { id: 'g1', tabs: [{ id: 't1', kind: 'hologram' }], activeTabId: 't1' },
        {
          id: 'g2',
          tabs: [
            { id: 't2', kind: 'file', params: { path: 3 } },
            { id: 't3', kind: 'overview' },
            { id: 't3', kind: 'plan' },
          ],
          activeTabId: 't2',
        },
        { id: 'g2', tabs: [{ id: 't4', kind: 'plan' }], activeTabId: 't4' },
        { id: PRIMARY, tabs: [{ id: 't5', kind: 'plan' }], activeTabId: 't5' },
      ],
      focus: ['g1', 'g2', 'g2', PRIMARY, 7],
      auxVisible: true,
      splitHint: 'sideways',
      sizes: { aux: { 1: 2, 2: 0.5 }, splits: { rows2: [0.5, 0.6], cols2: [0.4, 0.6] } },
    });
    expect(parsed).toEqual({
      groups: [{ id: 'g2', tabs: [{ id: 't3', kind: 'overview' }], activeTabId: 't3' }],
      focus: ['g2', PRIMARY],
      auxVisible: true,
      sizes: { aux: { 2: 0.5 }, splits: { cols2: [0.4, 0.6] } },
    });
  });

  it('没有窗格时窗格区不算显示；不是对象就读不出', () => {
    expect(parseScopePanes({ groups: [], auxVisible: true })?.auxVisible).toBe(false);
    expect(parseScopePanes('nope')).toBeUndefined();
  });
});

describe('存在 localStorage 里的全部窗格状态', () => {
  const panes = opened({ kind: 'overview' });

  it('版本不对就读不出（回到空的），能读的逐项校验', () => {
    expect(parseStoredPanes({ version: 2 })).toBeUndefined();
    expect(
      parseStoredPanes({
        version: 1,
        scopes: { s1: { ...panes, usedAt: 5 }, s2: 'bad' },
        workspaces: { w1: { aux: { 1: 0.5 } } },
      }),
    ).toEqual({
      version: 1,
      scopes: { s1: { ...panes, usedAt: 5 } },
      workspaces: { w1: { aux: { 1: 0.5 }, splits: {} } },
    });
  });

  it('新会话没有窗格，尺寸从所在工作区最近一次调过的开始', () => {
    const resized = setAuxRatio(panes, 1, 0.5);
    const stored = storeScope(EMPTY_STORED, 's1', 'w1', resized, 1);
    expect(stored.workspaces.w1).toEqual(resized.sizes);
    expect(scopeOf(stored, 's2', 'w1')).toEqual(emptyScope(resized.sizes));
    expect(scopeOf(stored, 's2', 'w2')).toEqual(emptyScope());
  });

  it('没变就不写；超过上限淘汰最久没用的', () => {
    const stored = storeScope(EMPTY_STORED, 's1', 'w1', panes, 1);
    expect(storeScope(stored, 's1', 'w1', scopeOf(stored, 's1', 'w1'), 2)).toBe(stored);
    let many = EMPTY_STORED;
    for (let index = 0; index <= MAX_STORED_SCOPES; index++) {
      many = storeScope(many, `s${index}`, 'w1', panes, index);
    }
    expect(Object.keys(many.scopes)).toHaveLength(MAX_STORED_SCOPES);
    expect(many.scopes.s0).toBeUndefined();
  });

  it('草稿转正：窗格集搬到会话 ID 下', () => {
    const stored = storeScope(EMPTY_STORED, paneScopeKey('w1') as string, 'w1', panes, 1);
    const moved = moveScope(stored, 'draft:w1', 's9', 2);
    expect(Object.keys(moved.scopes)).toEqual(['s9']);
    expect(moved.scopes.s9).toMatchObject({ groups: panes.groups, usedAt: 2 });
  });

  it('清掉不在了的会话、草稿与工作区；都在就原样返回', () => {
    let stored = storeScope(EMPTY_STORED, 's1', 'w1', setAuxRatio(panes, 1, 0.5), 1);
    stored = storeScope(stored, 's2', 'w2', setAuxRatio(panes, 1, 0.6), 1);
    stored = storeScope(stored, 'draft:w2', 'w2', panes, 1);
    expect(pruneStored(stored, new Set(['s1', 's2']), new Set(['w1', 'w2']))).toBe(stored);
    const pruned = pruneStored(stored, new Set(['s1']), new Set(['w1']));
    expect(Object.keys(pruned.scopes)).toEqual(['s1']);
    expect(Object.keys(pruned.workspaces)).toEqual(['w1']);
  });

  it('窗格集的键：会话、草稿，首页没有', () => {
    expect(paneScopeKey('w1', 's1')).toBe('s1');
    expect(paneScopeKey('w1')).toBe('draft:w1');
    expect(paneScopeKey()).toBeUndefined();
  });
});
