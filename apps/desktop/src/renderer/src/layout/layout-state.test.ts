import { describe, expect, it } from 'vitest';
import { parseLayoutPrefs } from './layout-state';

describe('parseLayoutPrefs', () => {
  it('读 v1 的格式：没有置顶摘要开关时默认开', () => {
    expect(
      parseLayoutPrefs({ sidebarWidth: 300, sidebarCollapsed: true, collapsedWorkspaces: ['w1'] }),
    ).toEqual({
      sidebarWidth: 300,
      sidebarCollapsed: true,
      collapsedWorkspaces: ['w1'],
      summaryPinned: true,
    });
  });

  it('记住关掉的置顶摘要；不合格的值回到默认', () => {
    expect(parseLayoutPrefs({ summaryPinned: false, sidebarWidth: 'x' })).toMatchObject({
      summaryPinned: false,
      sidebarWidth: 260,
    });
    expect(parseLayoutPrefs(null)).toBeUndefined();
  });
});
