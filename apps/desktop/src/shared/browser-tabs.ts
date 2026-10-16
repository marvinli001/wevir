// SPDX-License-Identifier: MIT
// 改写自 different-ai/openwork packages/browser-tabs/index.mjs（@openwork/browser-tabs）
// 来源提交 ad22cdc2217370f28f24f0f8758016c2921e3c73
// Copyright (c) 2026 Different AI
// 修改：改写成 TypeScript；“会话”就是 Wevir 的会话（OpenWork 叫 conversation / session），没有归属的共享标签页保留（Wevir 的
// 标签页总有归属，留着它只为与上游一致）；后台标签页的视口与命令照搬。主进程（browser-host.ts）与渲染进程（浏览器窗格）都用它。
//
// 内置浏览器（0.33.0）：整个窗口只有一个原生浏览器表面，每个标签页属于开它的会话。这里决定哪个标签页在屏幕上、一个会话看得到
// 哪些标签页，以及属于后台会话的标签页在没人看时怎样仍像一个真实的页面。

/** 没有会话认领的标签页（共享标签页）的归属键。 */
export const SHARED_OWNER_KEY = '*';

/** 后台标签页离开屏幕时布局与绘制用的视口。 */
export const BACKGROUND_TAB_VIEWPORT = Object.freeze({ width: 1280, height: 800 });

export interface DevToolsCommand {
  method: string;
  params: Record<string, unknown> | undefined;
}

/**
 * 让后台标签页像用户正看着的页面的 DevTools 命令：一个真实的视口（布局、点击、截图），加上焦点模拟（打字与 `:focus` 照常）。
 * 无头浏览器靠的也是这一套。
 */
export function backgroundTabEmulationCommands(
  viewport: { width: number; height: number } = BACKGROUND_TAB_VIEWPORT,
): DevToolsCommand[] {
  return [
    {
      method: 'Emulation.setDeviceMetricsOverride',
      params: {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 0,
        mobile: false,
      },
    },
    { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } },
  ];
}

/** 标签页回到屏幕之前撤销 `backgroundTabEmulationCommands`。 */
export function foregroundTabEmulationCommands(): DevToolsCommand[] {
  return [
    { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: false } },
    { method: 'Emulation.clearDeviceMetricsOverride', params: undefined },
  ];
}

export interface RegisteredTab {
  tabId: string;
  ownerSessionId: string | null;
}

export type Surfacing = 'foreground' | 'background';

function ownerKey(ownerSessionId: string | null): string {
  return ownerSessionId ?? SHARED_OWNER_KEY;
}

function normalizeOwner(ownerSessionId: unknown): string | null {
  return typeof ownerSessionId === 'string' && ownerSessionId.trim() ? ownerSessionId : null;
}

export interface BrowserTabRegistry {
  add(tab: { tabId: string; ownerSessionId?: string | null }): RegisteredTab;
  select(tabId: string): RegisteredTab;
  remove(tabId: string): {
    tab: RegisteredTab;
    wasActive: boolean;
    nextActiveTabId: string | null;
    ownerHasTabs: boolean;
  } | null;
  get(tabId: string): RegisteredTab | null;
  has(tabId: string): boolean;
  list(): RegisteredTab[];
  tabsFor(ownerSessionId: string | null): RegisteredTab[];
  ownerOf(tabId: string | null | undefined): string | null;
  surfacingFor(tabId: string): Surfacing | null;
  setVisibleSession(sessionId: string | null): string | null;
  visibleSessionId(): string | null;
  onScreenTabId(): string | null;
  activeTabIdFor(ownerSessionId: string | null): string | null;
  activeTabIdByOwner(): Record<string, string>;
  clear(): void;
  size(): number;
}

/** 所有打开的标签页的账：顺序、归属、每个归属的当前标签页、正在屏幕上的会话。纯状态，不碰 Electron 与 React。 */
export function createBrowserTabRegistry(): BrowserTabRegistry {
  const tabs = new Map<string, RegisteredTab>();
  let order: string[] = [];
  /** 归属键 → 当前标签页。 */
  const activeByOwner = new Map<string, string>();
  let visibleSessionId: string | null = null;
  /** 最近一次在能上屏时被选中的标签页。 */
  let onScreenSelection: string | null = null;

  const list = () =>
    order.map((tabId) => tabs.get(tabId)).filter((tab): tab is RegisteredTab => tab !== undefined);

  const isOwnerOnScreen = (ownerSessionId: string | null) =>
    ownerSessionId === null || ownerSessionId === visibleSessionId;

  /** 标签页现在能不能上屏：正在看的会话的（和共享的）上屏，其余留在后台。 */
  const surfacingFor = (tabId: string): Surfacing | null => {
    const tab = tabs.get(tabId);
    if (!tab) return null;
    return isOwnerOnScreen(tab.ownerSessionId) ? 'foreground' : 'background';
  };

  return {
    add({ tabId, ownerSessionId = null }) {
      if (tabs.has(tabId)) throw new Error(`Duplicate browser tab: ${tabId}`);
      const tab = { tabId, ownerSessionId: normalizeOwner(ownerSessionId) };
      tabs.set(tabId, tab);
      order.push(tabId);
      const key = ownerKey(tab.ownerSessionId);
      if (!activeByOwner.has(key)) activeByOwner.set(key, tabId);
      return tab;
    },
    /** 设为它所属会话的当前标签页；能上屏的同时成为屏幕上的标签页。 */
    select(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`Unknown browser tab: ${tabId}`);
      activeByOwner.set(ownerKey(tab.ownerSessionId), tabId);
      if (isOwnerOnScreen(tab.ownerSessionId)) onScreenSelection = tabId;
      return tab;
    },
    /** 忘掉一个标签页；返回它所属会话接下来的当前标签页（右边的，没有就左边的）与那个会话还有没有标签页。 */
    remove(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) return null;
      const key = ownerKey(tab.ownerSessionId);
      const siblings = order.filter((id) => tabs.get(id)?.ownerSessionId === tab.ownerSessionId);
      const index = siblings.indexOf(tabId);
      const wasActive = activeByOwner.get(key) === tabId;
      tabs.delete(tabId);
      order = order.filter((id) => id !== tabId);
      if (onScreenSelection === tabId) onScreenSelection = null;
      const remaining = siblings.filter((id) => id !== tabId);
      let nextActiveTabId = activeByOwner.get(key) ?? null;
      if (wasActive) {
        nextActiveTabId =
          remaining[Math.min(index, remaining.length - 1)] ?? remaining[index - 1] ?? null;
        if (nextActiveTabId) activeByOwner.set(key, nextActiveTabId);
        else activeByOwner.delete(key);
      }
      return { tab, wasActive, nextActiveTabId, ownerHasTabs: remaining.length > 0 };
    },
    get: (tabId) => tabs.get(tabId) ?? null,
    has: (tabId) => tabs.has(tabId),
    list,
    tabsFor(ownerSessionId) {
      const owner = normalizeOwner(ownerSessionId);
      return list().filter((tab) => tab.ownerSessionId === owner);
    },
    ownerOf: (tabId) => (tabId ? (tabs.get(tabId)?.ownerSessionId ?? null) : null),
    surfacingFor,
    setVisibleSession(sessionId) {
      const next = normalizeOwner(sessionId);
      if (next !== visibleSessionId) onScreenSelection = null;
      visibleSessionId = next;
      return visibleSessionId;
    },
    visibleSessionId: () => visibleSessionId,
    /** 该上屏的标签页：最近一次在能上屏时选中的，否则正在看的会话的当前标签页，否则共享的那个。 */
    onScreenTabId() {
      if (
        onScreenSelection &&
        tabs.has(onScreenSelection) &&
        surfacingFor(onScreenSelection) === 'foreground'
      ) {
        return onScreenSelection;
      }
      if (visibleSessionId !== null) {
        const owned = activeByOwner.get(visibleSessionId);
        if (owned) return owned;
      }
      return activeByOwner.get(SHARED_OWNER_KEY) ?? null;
    },
    activeTabIdFor: (ownerSessionId) =>
      activeByOwner.get(ownerKey(normalizeOwner(ownerSessionId))) ?? null,
    activeTabIdByOwner: () => Object.fromEntries(activeByOwner),
    clear() {
      tabs.clear();
      order = [];
      activeByOwner.clear();
      onScreenSelection = null;
    },
    size: () => tabs.size,
  };
}

/** 一个会话的浏览器窗格能显示的标签页：它自己的，加上共享的。 */
export function browserTabsForSession<T extends { ownerSessionId: string | null }>(
  tabs: readonly T[],
  sessionId: string,
): T[] {
  return tabs.filter((tab) => tab.ownerSessionId == null || tab.ownerSessionId === sessionId);
}

/** 一个会话的当前标签页：它自己的当前标签页，否则共享的，否则屏幕上的，否则它看得到的第一个。 */
export function activeBrowserTabIdForSession(
  payload: { activeTabIdByOwner?: Record<string, string>; activeTabId?: string | null },
  sessionId: string,
  tabs: readonly { id: string }[],
): string | null {
  const byOwner = payload.activeTabIdByOwner ?? {};
  const candidates = [byOwner[sessionId], byOwner[SHARED_OWNER_KEY], payload.activeTabId];
  for (const candidate of candidates) {
    if (candidate && tabs.some((tab) => tab.id === candidate)) return candidate;
  }
  return tabs[0]?.id ?? null;
}
