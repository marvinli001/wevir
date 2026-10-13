// 路由表（T5.2）。URL 是当前工作区与会话的唯一事实：界面从 URL 读 workspaceId / sessionId，再到 Host
// 的数据里找；找不到就显示“未找到”，不回落到第一个工作区（openwork-notes §1.1、§9.1）。路由走 hash
// （`wevir://app/index.html#/workspace/…`），因为构建产物经自定义协议按文件路径提供，没有 SPA 回退。

export const ROUTE_PATTERNS = {
  home: '/',
  /** 某个工作区里的一个会话。 */
  session: '/workspace/:workspaceId/session/:sessionId',
  /** 在某个工作区里新建会话的草稿页（还没有会话 ID）。 */
  draft: '/workspace/:workspaceId/session',
  settings: '/settings',
  settingsTab: '/settings/:tab',
} as const;

export const SETTINGS_TABS = ['appearance', 'providers', 'workspaces', 'about'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export const DEFAULT_SETTINGS_TAB: SettingsTab = 'appearance';

export function isSettingsTab(value: string | undefined): value is SettingsTab {
  return (SETTINGS_TABS as readonly (string | undefined)[]).includes(value);
}

const segment = encodeURIComponent;

export const paths = {
  home: (): string => ROUTE_PATTERNS.home,
  session: (workspaceId: string, sessionId: string): string =>
    `/workspace/${segment(workspaceId)}/session/${segment(sessionId)}`,
  draft: (workspaceId: string): string => `/workspace/${segment(workspaceId)}/session`,
  settings: (tab: SettingsTab = DEFAULT_SETTINGS_TAB): string => `/settings/${tab}`,
};
