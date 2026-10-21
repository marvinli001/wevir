import { createMemoryRouter, matchPath } from 'react-router';
import { describe, expect, it } from 'vitest';
import {
  AGENT_SEGMENT,
  isPluginsTab,
  isSettingsTab,
  isTuningTab,
  PLUGINS_TABS,
  paths,
  ROUTE_PATTERNS,
  seqParam,
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
    expect(paths.usage()).toBe('/usage');
    expect(matchPath(ROUTE_PATTERNS.usage, paths.usage())).not.toBeNull();
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

  it('市场：分组与条目详情的地址，与 /plugins/:tab 不冲突', () => {
    expect(paths.marketGroup('popular')).toBe('/plugins/market/group/popular');
    expect(paths.marketEntry('official', 'notion')).toBe('/plugins/market/official/notion');
    expect(
      matchPath(ROUTE_PATTERNS.marketEntry, paths.marketEntry('official', 'notion'))?.params,
    ).toEqual({ source: 'official', entry: 'notion' });
    const routes = [
      { path: ROUTE_PATTERNS.plugins },
      { path: ROUTE_PATTERNS.pluginsTab },
      { path: ROUTE_PATTERNS.marketGroup },
      { path: ROUTE_PATTERNS.marketEntry },
      { path: '*' },
    ];
    for (const [url, pattern] of [
      ['/plugins/market', ROUTE_PATTERNS.pluginsTab],
      ['/plugins/market/group/popular', ROUTE_PATTERNS.marketGroup],
      ['/plugins/market/official/notion', ROUTE_PATTERNS.marketEntry],
    ] as const) {
      const router = createMemoryRouter(routes, { initialEntries: [url] });
      expect(router.state.matches.map((match) => match.route.path)).toEqual([pattern]);
      router.dispose();
    }
  });

  it('调优页：/tuning 与 /tuning/:tab 都匹配；范围与版本放在查询串里', () => {
    expect(paths.tuning()).toBe('/tuning');
    expect(paths.tuning('profile')).toBe('/tuning/profile');
    expect(paths.tuning('profile', { workspace: 'ws_1', version: 'pfv_2' })).toBe(
      '/tuning/profile?workspace=ws_1&version=pfv_2',
    );
    expect(matchPath(ROUTE_PATTERNS.tuning, paths.tuning())).not.toBeNull();
    const target = paths.tuning('profile', { workspace: 'global' });
    expect(matchPath(ROUTE_PATTERNS.tuningTab, target.split('?')[0] as string)?.params).toEqual({
      tab: 'profile',
    });
    expect(isTuningTab('profile')).toBe(true);
    expect(isTuningTab('trials')).toBe(false);
  });

  it('只认识列出的插件页分段', () => {
    expect(isPluginsTab('skills')).toBe(true);
    expect(isPluginsTab('market')).toBe(true);
    expect(isPluginsTab('store')).toBe(false);
    expect(isPluginsTab(undefined)).toBe(false);
  });

  it('只认识列出的设置页', () => {
    expect(isSettingsTab('appearance')).toBe(true);
    expect(isSettingsTab('billing')).toBe(false);
    expect(isSettingsTab(undefined)).toBe(false);
  });
});

describe('跳到事件', () => {
  it('sessionAt 带 ?seq=，seqParam 只认正整数', () => {
    const path = paths.sessionAt('ws_a', 'ses_1', 42);
    expect(path).toBe('/workspace/ws_a/session/ses_1?seq=42');
    expect(seqParam('?seq=42')).toBe(42);
    expect(seqParam('')).toBeUndefined();
    for (const bad of ['?seq=0', '?seq=-1', '?seq=1.5', '?seq=abc', '?seq=']) {
      expect(seqParam(bad)).toBeUndefined();
    }
  });
});
