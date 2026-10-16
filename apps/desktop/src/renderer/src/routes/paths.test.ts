import { createMemoryRouter, matchPath } from 'react-router';
import { describe, expect, it } from 'vitest';
import {
  AGENT_SEGMENT,
  isPluginsTab,
  isSettingsTab,
  PLUGINS_TABS,
  paths,
  ROUTE_PATTERNS,
} from './paths';

describe('路由', () => {
  it('会话、草稿、设置的路径与路由表匹配，ID 原样取回', () => {
    expect(paths.session('ws_a', 'ses_1')).toBe('/workspace/ws_a/session/ses_1');
    expect(matchPath(ROUTE_PATTERNS.session, paths.session('ws_a', 'ses_1'))?.params).toEqual({
      workspaceId: 'ws_a',
      sessionId: 'ses_1',
    });
    expect(matchPath(ROUTE_PATTERNS.draft, paths.draft('ws_a'))?.params).toEqual({
      workspaceId: 'ws_a',
    });
    expect(matchPath(ROUTE_PATTERNS.session, paths.draft('ws_a'))).toBeNull();
    expect(paths.agent('ws_a', 'ses_1', 'ses_2')).toBe('/workspace/ws_a/session/ses_1/agent/ses_2');
    expect(matchPath(ROUTE_PATTERNS.agent, paths.agent('ws_a', 'ses_1', 'ses_2'))?.params).toEqual({
      workspaceId: 'ws_a',
      sessionId: 'ses_1',
      childId: 'ses_2',
    });
    expect(ROUTE_PATTERNS.agent).toBe(`${ROUTE_PATTERNS.session}/${AGENT_SEGMENT}`);
    expect(matchPath(ROUTE_PATTERNS.settingsTab, paths.settings('about'))?.params).toEqual({
      tab: 'about',
    });
    expect(paths.settings()).toBe('/settings/general');
  });

  it('ID 里的特殊字符被编码，路由器匹配后还原（手改 URL 也不会串到别的路由）', () => {
    const path = paths.session('ws/a b', 'ses?1');
    expect(path).toBe('/workspace/ws%2Fa%20b/session/ses%3F1');
    const router = createMemoryRouter(
      [{ path: ROUTE_PATTERNS.session }, { path: ROUTE_PATTERNS.draft }, { path: '*' }],
      { initialEntries: [path] },
    );
    expect(router.state.matches.map((match) => [match.route.path, match.params])).toEqual([
      [ROUTE_PATTERNS.session, { workspaceId: 'ws/a b', sessionId: 'ses?1' }],
    ]);
    router.dispose();
  });

  it('子智能体详情是会话路由的子路由：会话路由照样匹配，多出的别的段是“未找到”', () => {
    const routes = [
      { path: ROUTE_PATTERNS.session, children: [{ path: AGENT_SEGMENT }] },
      { path: ROUTE_PATTERNS.draft },
      { path: '*' },
    ];
    const agent = createMemoryRouter(routes, {
      initialEntries: [paths.agent('ws_a', 'ses_1', 'ses?2')],
    });
    expect(agent.state.matches.map((match) => match.route.path)).toEqual([
      ROUTE_PATTERNS.session,
      AGENT_SEGMENT,
    ]);
    expect(agent.state.matches[0]?.params).toEqual({
      workspaceId: 'ws_a',
      sessionId: 'ses_1',
      childId: 'ses?2',
    });
    agent.dispose();
    const other = createMemoryRouter(routes, {
      initialEntries: ['/workspace/ws_a/session/ses_1/files/x'],
    });
    expect(other.state.matches.map((match) => match.route.path)).toEqual(['*']);
    other.dispose();
  });

  it('插件页：/plugins 与 /plugins/:tab 都匹配，分段 ID 原样取回', () => {
    expect(paths.plugins()).toBe('/plugins');
    expect(paths.plugins('connectors')).toBe('/plugins/connectors');
    expect(matchPath(ROUTE_PATTERNS.plugins, paths.plugins())).not.toBeNull();
    expect(matchPath(ROUTE_PATTERNS.pluginsTab, paths.plugins())).toBeNull();
    for (const tab of PLUGINS_TABS) {
      expect(matchPath(ROUTE_PATTERNS.pluginsTab, paths.plugins(tab))?.params).toEqual({ tab });
    }
    // 工作台里 /plugins 与会话路由互不相干，多出的段是“未找到”。
    const router = createMemoryRouter(
      [{ path: ROUTE_PATTERNS.plugins }, { path: ROUTE_PATTERNS.pluginsTab }, { path: '*' }],
      { initialEntries: ['/plugins/skills/extra'] },
    );
    expect(router.state.matches.map((match) => match.route.path)).toEqual(['*']);
    router.dispose();
  });

  it('只认识列出的插件页分段', () => {
    expect(isPluginsTab('skills')).toBe(true);
    expect(isPluginsTab('market')).toBe(false);
    expect(isPluginsTab(undefined)).toBe(false);
  });

  it('只认识列出的设置页', () => {
    expect(isSettingsTab('appearance')).toBe(true);
    expect(isSettingsTab('billing')).toBe(false);
    expect(isSettingsTab(undefined)).toBe(false);
  });
});
