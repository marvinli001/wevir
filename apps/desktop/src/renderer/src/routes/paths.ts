// 路由表（T5.2）。URL 是当前工作区与会话的唯一事实：界面从 URL 读 workspaceId / sessionId，再到 Host
// 的数据里找；找不到就显示“未找到”，不回落到第一个工作区（openwork-notes §1.1、§9.1）。路由走 hash
// （`wevir://app/index.html#/workspace/…`），因为构建产物经自定义协议按文件路径提供，没有 SPA 回退。

export const ROUTE_PATTERNS = {
  home: '/',
  /** 某个工作区里的一个会话。 */
  session: '/workspace/:workspaceId/session/:sessionId',
  /**
   * 会话的一个子智能体（R5，desktop-layout.md §5.2）：主窗格仍是父会话，“子智能体”窗格显示这个子会话。路由表里
   * 是会话路由的子路由，进出详情时会话视图不重建。
   */
  agent: '/workspace/:workspaceId/session/:sessionId/agent/:childId',
  /** 在某个工作区里新建会话的草稿页（还没有会话 ID）。 */
  draft: '/workspace/:workspaceId/session',
  settings: '/settings',
  settingsTab: '/settings/:tab',
  /** 插件页（0.42.0，desktop-layout.md §23）：`/plugins` 转到默认分段，`/plugins/:tab` 是分段。 */
  plugins: '/plugins',
  pluginsTab: '/plugins/:tab',
  /** 使用统计（0.62.0）：每次模型请求的 token 与估算成本。 */
  usage: '/usage',
  /** 自动化（0.66.0）：列表与模板；`/automations/:automationId` 是一个自动化的详情。 */
  automations: '/automations',
  automation: '/automations/:automationId',
  /** 首次使用的分步引导（U6），整窗页面。 */
  welcome: '/welcome',
} as const;

/** `agent` 相对于会话路由的那一段（路由表里的子路由）。 */
export const AGENT_SEGMENT = 'agent/:childId';

/** 设置的各页（U7 起“对话”并进“常规”）。 */
export const SETTINGS_TABS = [
  'general',
  'appearance',
  'notifications',
  'shortcuts',
  'storage',
  'providers',
  'web',
  'memory',
  'workspaces',
  'archived',
  'about',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export const DEFAULT_SETTINGS_TAB: SettingsTab = 'general';

export function isSettingsTab(value: string | undefined): value is SettingsTab {
  return (SETTINGS_TABS as readonly (string | undefined)[]).includes(value);
}

/** 插件页的各分段（0.42.0）；Host 没有 `plugin_packages` 时没有“插件”（plugins/plugins-model.ts 的 visibleTabs）。 */
export const PLUGINS_TABS = ['plugins', 'connectors', 'skills'] as const;
export type PluginsTab = (typeof PLUGINS_TABS)[number];

export function isPluginsTab(value: string | undefined): value is PluginsTab {
  return (PLUGINS_TABS as readonly (string | undefined)[]).includes(value);
}

const segment = encodeURIComponent;

export const paths = {
  home: (): string => ROUTE_PATTERNS.home,
  session: (workspaceId: string, sessionId: string): string =>
    `/workspace/${segment(workspaceId)}/session/${segment(sessionId)}`,
  agent: (workspaceId: string, sessionId: string, childId: string): string =>
    `${paths.session(workspaceId, sessionId)}/agent/${segment(childId)}`,
  draft: (workspaceId: string): string => `/workspace/${segment(workspaceId)}/session`,
  settings: (tab: SettingsTab = DEFAULT_SETTINGS_TAB): string => `/settings/${tab}`,
  /** 不带分段是 `/plugins`，由路由转到默认分段（左栏的入口用它）。 */
  plugins: (tab?: PluginsTab): string =>
    tab === undefined ? ROUTE_PATTERNS.plugins : `${ROUTE_PATTERNS.plugins}/${tab}`,
  usage: (): string => ROUTE_PATTERNS.usage,
  automations: (): string => ROUTE_PATTERNS.automations,
  automation: (automationId: string): string =>
    `${ROUTE_PATTERNS.automations}/${segment(automationId)}`,
  welcome: (): string => ROUTE_PATTERNS.welcome,
};
