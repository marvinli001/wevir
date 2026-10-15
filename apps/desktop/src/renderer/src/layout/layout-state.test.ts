import { describe, expect, it } from 'vitest';
import { parseLayoutPrefs } from './layout-state';

describe('parseLayoutPrefs', () => {
  it('读 v1 的格式；没有会话侧栏的字段时开着、只展开“环境”', () => {
    expect(
      parseLayoutPrefs({ sidebarWidth: 300, sidebarCollapsed: true, collapsedWorkspaces: ['w1'] }),
    ).toEqual({
      sidebarWidth: 300,
      sidebarCollapsed: true,
      collapsedWorkspaces: ['w1'],
      projectsCollapsed: false,
      railShown: true,
      railOpen: ['environment'],
    });
  });

  it('旧版本的置顶摘要开关忽略；不合格的值回到默认', () => {
    expect(parseLayoutPrefs({ summaryPinned: false, sidebarWidth: 'x', railOpen: 'x' })).toEqual({
      sidebarWidth: 260,
      sidebarCollapsed: false,
      collapsedWorkspaces: [],
      projectsCollapsed: false,
      railShown: true,
      railOpen: ['environment'],
    });
    expect(parseLayoutPrefs(null)).toBeUndefined();
  });

  it('记住关掉的会话侧栏与展开的卡片', () => {
    expect(
      parseLayoutPrefs({ railShown: false, railOpen: ['context', 1, 'changes'] }),
    ).toMatchObject({ railShown: false, railOpen: ['context', 'changes'] });
  });
});
