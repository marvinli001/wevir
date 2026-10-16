// 内置浏览器的标签页归属（OpenWork 的 @openwork/browser-tabs）：谁的标签页能上屏、关掉之后谁接着当前。

import { describe, expect, it } from 'vitest';
import {
  activeBrowserTabIdForSession,
  backgroundTabEmulationCommands,
  browserTabsForSession,
  createBrowserTabRegistry,
  foregroundTabEmulationCommands,
} from './browser-tabs.js';

describe('createBrowserTabRegistry', () => {
  it('每个标签页属于开它的会话；只有正在看的会话的标签页能上屏', () => {
    const registry = createBrowserTabRegistry();
    registry.add({ tabId: 'a1', ownerSessionId: 'ses_a' });
    registry.add({ tabId: 'b1', ownerSessionId: 'ses_b' });
    registry.setVisibleSession('ses_a');
    expect(registry.surfacingFor('a1')).toBe('foreground');
    expect(registry.surfacingFor('b1')).toBe('background');
    expect(registry.onScreenTabId()).toBe('a1');
    // 选中别的会话的标签页只改那个会话的当前标签页，不抢屏幕。
    registry.select('b1');
    expect(registry.onScreenTabId()).toBe('a1');
    expect(registry.activeTabIdFor('ses_b')).toBe('b1');
    registry.setVisibleSession('ses_b');
    expect(registry.onScreenTabId()).toBe('b1');
    expect(registry.tabsFor('ses_a').map((tab) => tab.tabId)).toEqual(['a1']);
  });

  it('关掉当前标签页：右边的接上，没有就左边的；会话没有标签页了要说出来', () => {
    const registry = createBrowserTabRegistry();
    for (const tabId of ['t1', 't2', 't3']) registry.add({ tabId, ownerSessionId: 'ses_a' });
    registry.select('t2');
    expect(registry.remove('t2')).toMatchObject({ wasActive: true, nextActiveTabId: 't3' });
    registry.select('t3');
    expect(registry.remove('t3')).toMatchObject({ nextActiveTabId: 't1', ownerHasTabs: true });
    expect(registry.remove('t1')).toMatchObject({ nextActiveTabId: null, ownerHasTabs: false });
    expect(registry.remove('t1')).toBeNull();
  });

  it('同一个 ID 不能开两次', () => {
    const registry = createBrowserTabRegistry();
    registry.add({ tabId: 't', ownerSessionId: 'ses_a' });
    expect(() => registry.add({ tabId: 't', ownerSessionId: 'ses_b' })).toThrow();
  });
});

describe('渲染进程的过滤', () => {
  it('窗格只看到自己会话的标签页与它的当前标签页', () => {
    const tabs = [
      { id: 'a1', ownerSessionId: 'ses_a' },
      { id: 'b1', ownerSessionId: 'ses_b' },
      { id: 'a2', ownerSessionId: 'ses_a' },
    ];
    const mine = browserTabsForSession(tabs, 'ses_a');
    expect(mine.map((tab) => tab.id)).toEqual(['a1', 'a2']);
    expect(
      activeBrowserTabIdForSession({ activeTabIdByOwner: { ses_a: 'a2' } }, 'ses_a', mine),
    ).toBe('a2');
    expect(activeBrowserTabIdForSession({ activeTabIdByOwner: {} }, 'ses_a', mine)).toBe('a1');
  });
});

describe('后台标签页的模拟', () => {
  it('给后台标签页一个真实的视口与焦点，回到前台时撤销', () => {
    expect(backgroundTabEmulationCommands().map((command) => command.method)).toEqual([
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setFocusEmulationEnabled',
    ]);
    expect(foregroundTabEmulationCommands().map((command) => command.method)).toEqual([
      'Emulation.setFocusEmulationEnabled',
      'Emulation.clearDeviceMetricsOverride',
    ]);
  });
});
