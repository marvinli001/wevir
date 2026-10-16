// 内置浏览器（0.33.0，desktop-layout.md §21）在渲染进程这边的状态：标签页由主进程管（main/browser/browser-host.ts），这里只
// 订阅它推来的状态，给浏览器窗格画标签与地址栏；agent 请显示标签页（`wevir_show`）时打开窗格。

import type { SessionId } from '@wevir/protocol';
import { useEffect } from 'react';
import type { PaneController } from '@/layout/pane-controller';
import { createStore } from '@/lib/store';
import {
  activeBrowserTabIdForSession,
  browserTabsForSession,
} from '../../../shared/browser-tabs.js';
import type { BrowserStatePayload, BrowserTabState } from '../../../shared/desktop-api.js';

const EMPTY: BrowserStatePayload = {
  activeTabId: null,
  activeTabIdByOwner: {},
  visibleSessionId: null,
  tabs: [],
};

const store = createStore<BrowserStatePayload>(EMPTY);
let subscribed = false;

/** 第一次用到时订阅主进程的推送，并读一次当前状态。 */
function ensureSubscribed(): void {
  if (subscribed || typeof window === 'undefined' || !window.wevir?.browser) return;
  subscribed = true;
  window.wevir.browser.onState((state) => store.set(state));
  void window.wevir.browser.state().then(
    (state) => store.set(state),
    () => {},
  );
}

export function useBrowserState(): BrowserStatePayload {
  ensureSubscribed();
  return store.use();
}

/** 一个会话的标签页与它的当前标签页。 */
export function sessionTabs(
  state: BrowserStatePayload,
  sessionId: string,
): { tabs: BrowserTabState[]; active: BrowserTabState | undefined } {
  const tabs = browserTabsForSession(state.tabs, sessionId);
  const activeId = activeBrowserTabIdForSession(
    state,
    sessionId,
    tabs.map((tab) => ({ id: tab.id })),
  );
  return { tabs, active: tabs.find((tab) => tab.id === activeId) };
}

/** 标签上的名字：标题，没有时是地址，空白页是“新标签页”。 */
export function tabLabel(tab: BrowserTabState, untitled: string): string {
  if (tab.title) return tab.title;
  if (tab.url && tab.url !== 'about:blank') return tab.url;
  return untitled;
}

/** 主会话视图用：agent 请显示这个会话的标签页时打开浏览器窗格（标签页由主进程选好）。 */
export function useBrowserReveal(sessionId: SessionId, panes: PaneController | undefined): void {
  useEffect(() => {
    if (!panes || !window.wevir?.browser) return;
    return window.wevir.browser.onReveal((reveal) => {
      if (reveal.sessionId === sessionId) panes.open({ kind: 'browser' });
    });
  }, [sessionId, panes]);
}
