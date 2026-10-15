// 关掉了哪些标签（U23.1）：窗格操作只改本机的布局状态，关掉标签之后要做的事（支线窗格关闭支线会话）由需要的地方订阅。

import type { PaneTab } from './pane-state';

type Listener = (tabs: readonly PaneTab[]) => void;

const listeners = new Set<Listener>();

/** 订阅关掉的标签；返回退订函数。 */
export function onPanesClosed(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitPanesClosed(tabs: readonly PaneTab[]): void {
  if (tabs.length === 0) return;
  for (const listener of listeners) listener(tabs);
}
