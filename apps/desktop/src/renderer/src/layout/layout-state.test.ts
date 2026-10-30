import { describe, expect, it } from 'vitest';
import {
  layoutPrefs,
  OPTIONAL_RAIL_CARDS,
  parseLayoutPrefs,
  revealRailCard,
  transientLayout,
} from './layout-state';

describe('parseLayoutPrefs', () => {
  it('读 v1 的格式；没有会话侧栏的字段时开着、只展开“环境”', () => {
    expect(
      parseLayoutPrefs({ sidebarWidth: 300, sidebarCollapsed: true, collapsedWorkspaces: ['w1'] }),
    ).toEqual({
      sidebarWidth: 300,
      sidebarCollapsed: true,
      collapsedWorkspaces: ['w1'],
      projectsCollapsed: false,
      collapsedThreads: [],
      sidebarView: 'status',
      railShown: true,
      railOpen: ['environment'],
      railCards: [],
    });
  });

  it('旧版本的置顶摘要开关忽略；不合格的值回到默认', () => {
    expect(parseLayoutPrefs({ summaryPinned: false, sidebarWidth: 'x', railOpen: 'x' })).toEqual({
      sidebarWidth: 300,
      sidebarCollapsed: false,
      collapsedWorkspaces: [],
      projectsCollapsed: false,
      collapsedThreads: [],
      sidebarView: 'status',
      railShown: true,
      railOpen: ['environment'],
      railCards: [],
    });
    expect(parseLayoutPrefs(null)).toBeUndefined();
  });

  it('从 v1、v2 迁来时旧默认宽 260 换成新的默认 300，拖过的宽保留', () => {
    expect(parseLayoutPrefs({ sidebarWidth: 260 }, true)?.sidebarWidth).toBe(300);
    expect(parseLayoutPrefs({ sidebarWidth: 280 }, true)?.sidebarWidth).toBe(280);
    expect(parseLayoutPrefs({ sidebarWidth: 260 })?.sidebarWidth).toBe(260);
  });

  it('记住收起的子会话线程', () => {
    expect(parseLayoutPrefs({ collapsedThreads: ['ses_a', 3] })?.collapsedThreads).toEqual([
      'ses_a',
    ]);
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

  it('可选卡片默认都不显示，记住设置里打开的', () => {
    expect(parseLayoutPrefs({})).toMatchObject({ railCards: [] });
    expect(OPTIONAL_RAIL_CARDS).toEqual(
      expect.arrayContaining(['instructions', 'rules', 'preview', 'task-board']),
    );
    expect(parseLayoutPrefs({ railCards: ['retro', 2, 'lsp'] })).toMatchObject({
      railCards: ['retro', 'lsp'],
    });
  });
});

describe('revealRailCard（0.140.0）', () => {
  it('展开那张卡片、请布局露出侧栏，不动设置里打开的可选卡片', () => {
    const before = transientLayout.get().railRequest;
    const cards = layoutPrefs.get().railCards;
    revealRailCard('verification');
    revealRailCard('verification');
    expect(layoutPrefs.get().railOpen.filter((id) => id === 'verification')).toEqual([
      'verification',
    ]);
    expect(layoutPrefs.get().railCards).toBe(cards);
    expect(transientLayout.get().railRequest).toBe(before + 2);
  });
});
