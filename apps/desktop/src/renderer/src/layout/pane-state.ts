// 一个会话的窗格状态与它的操作（R12，docs/architecture/desktop-layout.md §2.3、§3、§5）。纯函数，不碰 DOM、
// React 与 localStorage；持久化在 pane-store.ts，排布在 arrange.ts。
//
// 状态里只有窗格组的顺序、焦点顺序与比例，没有“谁在左谁在右”的树：树每次由 arrange.ts 按窗口尺寸算出来。

import {
  isPaneKind,
  PANE_KIND_SPECS,
  type PaneKind,
  type PaneParams,
  paneIdentity,
} from './pane-kinds';

/** 焦点顺序里代表主窗格的 ID。 */
export const PRIMARY = 'primary';

export interface PaneTab {
  readonly id: string;
  readonly kind: PaneKind;
  readonly params?: PaneParams;
}

/** 窗格：窗格区里的一张卡片，装一个或多个标签，一次显示 `activeTabId` 那个。 */
export interface PaneGroup {
  readonly id: string;
  readonly tabs: readonly PaneTab[];
  readonly activeTabId: string;
}

export type SplitDirection = 'right' | 'down';

export interface PaneSizes {
  /** 窗格区宽度占内容区宽的比例，按列数分开记。 */
  readonly aux: Readonly<Partial<Record<1 | 2, number>>>;
  /** 排布树里各拆分节点的比例（和为 1），键是节点在模板里的位置，例如 `side3`、`side3/1`。 */
  readonly splits: Readonly<Record<string, readonly number[]>>;
}

export interface ScopePanes {
  /** 排列顺序。 */
  readonly groups: readonly PaneGroup[];
  /** 最近聚焦的在前；`PRIMARY` 是主窗格。 */
  readonly focus: readonly string[];
  readonly auxVisible: boolean;
  /** 最近一次拆分的方向，恰好两个窗格时优先（arrange.ts）。 */
  readonly splitHint?: SplitDirection;
  readonly sizes: PaneSizes;
}

export const EMPTY_SIZES: PaneSizes = { aux: {}, splits: {} };

export function emptyScope(sizes: PaneSizes = EMPTY_SIZES): ScopePanes {
  return { groups: [], focus: [], auxVisible: false, sizes };
}

/**
 * 窗格集的键：会话 ID；新会话草稿用 `draft:<工作区 ID>`。首页这类没有工作区的页面没有窗格区。
 */
export function paneScopeKey(workspaceId?: string, sessionId?: string): string | undefined {
  if (sessionId !== undefined) return sessionId;
  if (workspaceId !== undefined) return draftScopeKey(workspaceId);
  return undefined;
}

export function draftScopeKey(workspaceId: string): string {
  return `draft:${workspaceId}`;
}

export type IdFactory = () => string;

export function findTab(
  state: ScopePanes,
  tabId: string,
): { group: PaneGroup; tab: PaneTab } | undefined {
  for (const group of state.groups) {
    const tab = group.tabs.find((candidate) => candidate.id === tabId);
    if (tab) return { group, tab };
  }
  return undefined;
}

export function tabCount(state: ScopePanes): number {
  return state.groups.reduce((sum, group) => sum + group.tabs.length, 0);
}

/** 最近聚焦的窗格组（不算主窗格）。 */
export function focusedGroup(state: ScopePanes): PaneGroup | undefined {
  for (const id of state.focus) {
    const group = state.groups.find((candidate) => candidate.id === id);
    if (group) return group;
  }
  return state.groups.at(-1);
}

function withFocus(focus: readonly string[], id: string): string[] {
  return [id, ...focus.filter((candidate) => candidate !== id)];
}

function replaceGroup(groups: readonly PaneGroup[], next: PaneGroup): PaneGroup[] {
  return groups.map((group) => (group.id === next.id ? next : group));
}

export interface OpenRequest {
  kind: PaneKind;
  params?: PaneParams;
  /** 从某个窗格头的“＋”打开时，加进这个窗格。 */
  into?: string;
}

/**
 * 打开一个标签（§3.1）：已经开着同一个就激活它；从“＋”打开的加进那个窗格；能多开的种类加进已经装着同种标签
 * 的窗格；否则新建一个窗格放在最后。窗格区随之显示，打开的窗格获得焦点。
 */
export function openPane(state: ScopePanes, request: OpenRequest, newId: IdFactory): ScopePanes {
  const identity = paneIdentity(request.kind, request.params);
  if (identity !== undefined) {
    for (const group of state.groups) {
      const existing = group.tabs.find((tab) => paneIdentity(tab.kind, tab.params) === identity);
      if (existing) return activateTab(state, existing.id);
    }
  }

  const tab: PaneTab =
    request.params === undefined
      ? { id: newId(), kind: request.kind }
      : { id: newId(), kind: request.kind, params: request.params };
  let target =
    request.into === undefined
      ? undefined
      : state.groups.find((group) => group.id === request.into);
  if (!target && PANE_KIND_SPECS[request.kind].multiple) {
    target = state.groups.find((group) => group.tabs.some((other) => other.kind === request.kind));
  }
  if (target) {
    return {
      ...state,
      groups: replaceGroup(state.groups, {
        ...target,
        tabs: [...target.tabs, tab],
        activeTabId: tab.id,
      }),
      focus: withFocus(state.focus, target.id),
      auxVisible: true,
    };
  }
  const group: PaneGroup = { id: newId(), tabs: [tab], activeTabId: tab.id };
  return {
    ...state,
    groups: [...state.groups, group],
    focus: withFocus(state.focus, group.id),
    auxVisible: true,
  };
}

/** 激活一个标签并聚焦它的窗格；窗格区收起着就显示出来。 */
export function activateTab(state: ScopePanes, tabId: string): ScopePanes {
  const found = findTab(state, tabId);
  if (!found) return state;
  const { group } = found;
  if (group.activeTabId === tabId && state.focus[0] === group.id && state.auxVisible) return state;
  return {
    ...state,
    groups:
      group.activeTabId === tabId
        ? state.groups
        : replaceGroup(state.groups, { ...group, activeTabId: tabId }),
    focus: withFocus(state.focus, group.id),
    auxVisible: true,
  };
}

/** 记下最近聚焦的窗格（窗格组 ID 或 `PRIMARY`）。已经是最近的就原样返回，不触发保存。 */
export function focusPane(state: ScopePanes, id: string): ScopePanes {
  if (state.focus[0] === id) return state;
  if (id !== PRIMARY && !state.groups.some((group) => group.id === id)) return state;
  return { ...state, focus: withFocus(state.focus, id) };
}

/** 去掉一个标签；窗格里没有标签了就去掉窗格，最后一个窗格去掉后窗格区随之收起。 */
function removeTab(state: ScopePanes, tabId: string): ScopePanes {
  const found = findTab(state, tabId);
  if (!found) return state;
  const { group } = found;
  const index = group.tabs.findIndex((tab) => tab.id === tabId);
  const tabs = group.tabs.filter((tab) => tab.id !== tabId);
  if (tabs.length === 0) return closeGroup(state, group.id);
  const activeTabId =
    group.activeTabId === tabId
      ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? group.activeTabId)
      : group.activeTabId;
  return { ...state, groups: replaceGroup(state.groups, { ...group, tabs, activeTabId }) };
}

export function closeTab(state: ScopePanes, tabId: string): ScopePanes {
  return removeTab(state, tabId);
}

export function closeGroup(state: ScopePanes, groupId: string): ScopePanes {
  if (!state.groups.some((group) => group.id === groupId)) return state;
  const groups = state.groups.filter((group) => group.id !== groupId);
  return {
    ...state,
    groups,
    focus: state.focus.filter((id) => id !== groupId),
    auxVisible: groups.length > 0 && state.auxVisible,
  };
}

/** 当前窗格的下一个（delta = 1）或上一个（-1）标签，首尾相接。 */
export function cycleTab(state: ScopePanes, groupId: string, delta: number): ScopePanes {
  const group = state.groups.find((candidate) => candidate.id === groupId);
  if (!group || group.tabs.length < 2) return state;
  const index = group.tabs.findIndex((tab) => tab.id === group.activeTabId);
  const next = group.tabs[(index + delta + group.tabs.length) % group.tabs.length];
  return next ? activateTab(state, next.id) : state;
}

/**
 * 把一个标签拆进紧跟在它的窗格后面的新窗格（§3.5）。窗格里只有这一个标签时不能拆。拆分方向记为 splitHint。
 */
export function splitTab(
  state: ScopePanes,
  tabId: string,
  direction: SplitDirection,
  newId: IdFactory,
): ScopePanes {
  const found = findTab(state, tabId);
  if (!found || found.group.tabs.length < 2) return state;
  const removed = removeTab(state, tabId);
  const group: PaneGroup = { id: newId(), tabs: [found.tab], activeTabId: found.tab.id };
  const at = removed.groups.findIndex((candidate) => candidate.id === found.group.id) + 1;
  return {
    ...removed,
    groups: [...removed.groups.slice(0, at), group, ...removed.groups.slice(at)],
    focus: withFocus(removed.focus, group.id),
    splitHint: direction,
    auxVisible: true,
  };
}

/** 把一个标签移进另一个窗格并激活；原来的窗格空了就去掉。 */
export function moveTab(state: ScopePanes, tabId: string, targetGroupId: string): ScopePanes {
  const found = findTab(state, tabId);
  if (!found || found.group.id === targetGroupId) return state;
  if (!state.groups.some((group) => group.id === targetGroupId)) return state;
  const removed = removeTab(state, tabId);
  const target = removed.groups.find((group) => group.id === targetGroupId);
  if (!target) return state;
  return {
    ...removed,
    groups: replaceGroup(removed.groups, {
      ...target,
      tabs: [...target.tabs, found.tab],
      activeTabId: found.tab.id,
    }),
    focus: withFocus(removed.focus, targetGroupId),
    auxVisible: true,
  };
}

/** 窗格区开关（§3.9）：没有窗格时打开“概览”，否则显示或收起（收起不关窗格）。 */
export function toggleAux(state: ScopePanes, newId: IdFactory): ScopePanes {
  if (state.groups.length === 0) return openPane(state, { kind: 'overview' }, newId);
  return { ...state, auxVisible: !state.auxVisible };
}

export function setAuxRatio(state: ScopePanes, columns: 1 | 2, ratio: number): ScopePanes {
  if (!isRatio(ratio)) return state;
  return { ...state, sizes: { ...state.sizes, aux: { ...state.sizes.aux, [columns]: ratio } } };
}

export function setSplitRatios(
  state: ScopePanes,
  key: string,
  fractions: readonly number[],
): ScopePanes {
  if (!isFractions(fractions)) return state;
  return {
    ...state,
    sizes: { ...state.sizes, splits: { ...state.sizes.splits, [key]: fractions } },
  };
}

/** 双击分隔条：回到默认比例。 */
export function resetAuxRatio(state: ScopePanes, columns: 1 | 2): ScopePanes {
  if (state.sizes.aux[columns] === undefined) return state;
  const { [columns]: _, ...aux } = state.sizes.aux;
  return { ...state, sizes: { ...state.sizes, aux } };
}

export function resetSplitRatios(state: ScopePanes, key: string): ScopePanes {
  if (state.sizes.splits[key] === undefined) return state;
  const { [key]: _, ...splits } = state.sizes.splits;
  return { ...state, sizes: { ...state.sizes, splits } };
}

// —— 解析与校验（§5.1）：从 localStorage 读回来的东西逐项检查，不合格的丢掉 ——

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRatio(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1;
}

function isFractions(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length < 2 || !value.every(isRatio)) return false;
  const sum = value.reduce((total: number, item: number) => total + item, 0);
  return Math.abs(sum - 1) < 0.01;
}

function parseParams(raw: unknown): PaneParams | undefined | false {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return false;
  const entries = Object.entries(raw);
  if (!entries.every(([, value]) => typeof value === 'string')) return false;
  return Object.fromEntries(entries) as PaneParams;
}

function parseTab(raw: unknown): PaneTab | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id === '' || !isPaneKind(raw.kind)) {
    return undefined;
  }
  const params = parseParams(raw.params);
  if (params === false) return undefined;
  return params === undefined
    ? { id: raw.id, kind: raw.kind }
    : { id: raw.id, kind: raw.kind, params };
}

export function parseSizes(raw: unknown): PaneSizes {
  if (!isRecord(raw)) return EMPTY_SIZES;
  const aux: Partial<Record<1 | 2, number>> = {};
  if (isRecord(raw.aux)) {
    if (isRatio(raw.aux[1])) aux[1] = raw.aux[1];
    if (isRatio(raw.aux[2])) aux[2] = raw.aux[2];
  }
  const splits: Record<string, readonly number[]> = {};
  if (isRecord(raw.splits)) {
    for (const [key, value] of Object.entries(raw.splits)) {
      if (isFractions(value)) splits[key] = value;
    }
  }
  return { aux, splits };
}

/** 读回一个会话的窗格状态：不认识的种类、格式不对的标签丢掉，丢空了的窗格丢掉，ID 重复的只留第一个。 */
export function parseScopePanes(raw: unknown): ScopePanes | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.groups)) return undefined;
  const seen = new Set<string>();
  const groups: PaneGroup[] = [];
  for (const rawGroup of raw.groups) {
    if (!isRecord(rawGroup) || typeof rawGroup.id !== 'string' || !Array.isArray(rawGroup.tabs)) {
      continue;
    }
    if (rawGroup.id === PRIMARY || seen.has(rawGroup.id)) continue;
    const tabs: PaneTab[] = [];
    for (const rawTab of rawGroup.tabs) {
      const tab = parseTab(rawTab);
      if (!tab || seen.has(tab.id)) continue;
      seen.add(tab.id);
      tabs.push(tab);
    }
    const first = tabs[0];
    if (!first) continue;
    seen.add(rawGroup.id);
    const activeTabId = tabs.some((tab) => tab.id === rawGroup.activeTabId)
      ? (rawGroup.activeTabId as string)
      : first.id;
    groups.push({ id: rawGroup.id, tabs, activeTabId });
  }
  const ids = new Set(groups.map((group) => group.id));
  const focus = Array.isArray(raw.focus)
    ? [
        ...new Set(
          raw.focus.filter(
            (id): id is string => typeof id === 'string' && (id === PRIMARY || ids.has(id)),
          ),
        ),
      ]
    : [];
  const splitHint =
    raw.splitHint === 'right' || raw.splitHint === 'down' ? raw.splitHint : undefined;
  return {
    groups,
    focus,
    auxVisible: groups.length > 0 && raw.auxVisible === true,
    ...(splitHint && { splitHint }),
    sizes: parseSizes(raw.sizes),
  };
}

// —— 存在 localStorage 里的全部窗格状态（§5.3） ——

export const MAX_STORED_SCOPES = 200;

export interface StoredScope extends ScopePanes {
  readonly usedAt: number;
}

export interface StoredPanes {
  readonly version: 1;
  /** 键是会话 ID 或 `draft:<工作区 ID>`。 */
  readonly scopes: Readonly<Record<string, StoredScope>>;
  /** 每个工作区最近一次调过的尺寸，新会话从它开始。 */
  readonly workspaces: Readonly<Record<string, PaneSizes>>;
}

export const EMPTY_STORED: StoredPanes = { version: 1, scopes: {}, workspaces: {} };

export function parseStoredPanes(raw: unknown): StoredPanes | undefined {
  if (!isRecord(raw) || raw.version !== 1) return undefined;
  const scopes: Record<string, StoredScope> = {};
  if (isRecord(raw.scopes)) {
    for (const [key, value] of Object.entries(raw.scopes)) {
      const scope = parseScopePanes(value);
      if (!scope || !isRecord(value)) continue;
      const usedAt =
        typeof value.usedAt === 'number' && Number.isFinite(value.usedAt) ? value.usedAt : 0;
      scopes[key] = { ...scope, usedAt };
    }
  }
  const workspaces: Record<string, PaneSizes> = {};
  if (isRecord(raw.workspaces)) {
    for (const [key, value] of Object.entries(raw.workspaces)) workspaces[key] = parseSizes(value);
  }
  return { version: 1, scopes, workspaces };
}

/** 一个会话的窗格状态；还没有记录时是空的，尺寸从所在工作区最近一次调过的开始（§5.1）。 */
export function scopeOf(stored: StoredPanes, key: string, workspaceId: string): ScopePanes {
  const scope = stored.scopes[key];
  if (scope) return scope;
  return emptyScope(stored.workspaces[workspaceId] ?? EMPTY_SIZES);
}

/** 写回一个会话的窗格状态；尺寸变了同时记为工作区最近的尺寸；超过上限时淘汰最久没用的。 */
export function storeScope(
  stored: StoredPanes,
  key: string,
  workspaceId: string,
  next: ScopePanes,
  now: number,
): StoredPanes {
  const previous = scopeOf(stored, key, workspaceId);
  if (next === previous) return stored;
  const { usedAt: _, ...plain } = next as StoredScope;
  let scopes: Record<string, StoredScope> = { ...stored.scopes, [key]: { ...plain, usedAt: now } };
  const keys = Object.keys(scopes);
  if (keys.length > MAX_STORED_SCOPES) {
    const keep = keys
      .sort((a, b) => (scopes[b]?.usedAt ?? 0) - (scopes[a]?.usedAt ?? 0))
      .slice(0, MAX_STORED_SCOPES);
    scopes = Object.fromEntries(keep.map((k) => [k, scopes[k] as StoredScope]));
  }
  const workspaces =
    next.sizes === previous.sizes
      ? stored.workspaces
      : { ...stored.workspaces, [workspaceId]: next.sizes };
  return { ...stored, scopes, workspaces };
}

/** 草稿发出第一条消息变成会话（§2.2）：草稿的窗格集搬到会话 ID 下。 */
export function moveScope(stored: StoredPanes, from: string, to: string, now: number): StoredPanes {
  const scope = stored.scopes[from];
  if (!scope) return stored;
  const { [from]: _, ...rest } = stored.scopes;
  return { ...stored, scopes: { ...rest, [to]: { ...scope, usedAt: now } } };
}

/**
 * 清掉已经不在的会话与工作区（§5.1）。只在会话列表读成功时调用，Host 断开时不清。草稿的窗格集跟着工作区走。
 */
export function pruneStored(
  stored: StoredPanes,
  liveSessionIds: ReadonlySet<string>,
  liveWorkspaceIds: ReadonlySet<string>,
): StoredPanes {
  const isLive = (key: string) =>
    key.startsWith('draft:')
      ? liveWorkspaceIds.has(key.slice('draft:'.length))
      : liveSessionIds.has(key);
  const scopeKeys = Object.keys(stored.scopes);
  const workspaceKeys = Object.keys(stored.workspaces);
  if (scopeKeys.every(isLive) && workspaceKeys.every((id) => liveWorkspaceIds.has(id)))
    return stored;
  return {
    ...stored,
    scopes: Object.fromEntries(
      scopeKeys.filter(isLive).map((key) => [key, stored.scopes[key] as StoredScope]),
    ),
    workspaces: Object.fromEntries(
      workspaceKeys
        .filter((id) => liveWorkspaceIds.has(id))
        .map((id) => [id, stored.workspaces[id] as PaneSizes]),
    ),
  };
}
