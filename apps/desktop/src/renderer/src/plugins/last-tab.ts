// 插件页上次所在的分段（plugin-market.md §9）：左栏的“插件”入口（`/plugins`）沿用它。只记在本机。

import { createPersistedStore } from '@/lib/store';
import { isPluginsTab, type PluginsTab } from '@/routes/paths';

const lastTab = createPersistedStore<PluginsTab | undefined>(
  'wevir.plugins-tab.v1',
  undefined,
  (raw) => (typeof raw === 'string' && isPluginsTab(raw) ? raw : undefined),
);

export const getLastPluginsTab = lastTab.get;

export function rememberPluginsTab(tab: PluginsTab): void {
  if (lastTab.get() !== tab) lastTab.set(tab);
}
