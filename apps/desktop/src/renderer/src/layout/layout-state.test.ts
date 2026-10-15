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
      sidebarView: 'status',
      railShown: true,
      railOpen: ['environment'],
    });
  });

  it('旧版本的置顶摘要开关忽略；不合格的值回到默认', () => {
    expect(parseLayoutPrefs({ summaryPinned: false, sidebarWidth: 'x', railOpen: 'x' })).toEqual({
      sidebarWidth: 300,
      sidebarCollapsed: false,
      collapsedWorkspaces: [],
      projectsCollapsed: false,
      sidebarView: 'status',
      railShown: true,
      railOpen: ['environment'],
    });
    expect(parseLayoutPrefs(null)).toBeUndefined();
  });

  it('从 v1、v2 迁来时旧默认宽 260 换成新的默认 300，拖过的宽保留', () => {
    expect(parseLayoutPrefs({ sidebarWidth: 260 }, true)?.sidebarWidth).toBe(300);
    expect(parseLayoutPrefs({ sidebarWidth: 280 }, true)?.sidebarWidth).toBe(280);
    expect(parseLayoutPrefs({ sidebarWidth: 260 })?.sidebarWidth).toBe(260);
  });

  it('记住按项目分组', () => {
    expect(parseLayoutPrefs({ sidebarView: 'project' })?.sidebarView).toBe('project');
    expect(parseLayoutPrefs({ sidebarView: 'tree' })?.sidebarView).toBe('status');
  });

  it('记住关掉的会话侧栏与展开的卡片', () => {
    expect(
      parseLayoutPrefs({ railShown: false, railOpen: ['context', 1, 'changes'] }),
    ).toMatchObject({ railShown: false, railOpen: ['context', 'changes'] });
  });
});
