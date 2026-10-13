import { createMemoryRouter, matchPath } from 'react-router';
import { describe, expect, it } from 'vitest';
import { isSettingsTab, paths, ROUTE_PATTERNS } from './paths';

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
    expect(matchPath(ROUTE_PATTERNS.settingsTab, paths.settings('about'))?.params).toEqual({
      tab: 'about',
    });
    expect(paths.settings()).toBe('/settings/appearance');
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

  it('只认识列出的设置页', () => {
    expect(isSettingsTab('appearance')).toBe(true);
    expect(isSettingsTab('billing')).toBe(false);
    expect(isSettingsTab(undefined)).toBe(false);
  });
});
