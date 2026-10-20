// 插件页的纯逻辑（0.42.0，docs/architecture/desktop-layout.md §23）：功能门控与分段、连接器的状态、Skills 的分组与短描述、
// 插件包含的各项、SKILL.md 的预览正文。不碰 DOM 与 Host，组件与测试都用它。

import { hostSupports } from '@wevir/client-sdk';
import type { Connector, HostFeatures, Plugin, PluginsList, Skill } from '@wevir/protocol';
import type { StatusTone } from '@/components/status-dot';
import type { PlainMessageKey } from '@/i18n';
import { PLUGINS_TABS, type PluginsTab } from '@/routes/paths';

export type PluginInputView = Plugin['inputs'][number];

// ---- 功能门控与分段 ----

/** 页面能不能用：还没连上（`features` 未知）、Host 没有 `plugins` 功能、可用。 */
export type PluginsAvailability = 'pending' | 'unsupported' | 'ready';

/** `features` 是 `host.hello` 的功能表；还没连上时是 undefined。左栏的入口只在 `ready` 时显示。 */
export function pluginsAvailability(features: HostFeatures | undefined): PluginsAvailability {
  if (features === undefined) return 'pending';
  return hostSupports(features, 'plugins') ? 'ready' : 'unsupported';
}

/** Host 有 `plugin_packages`（0.42.0）才有“插件”分段；0.41.0 的 Host 只有连接器与 Skills。 */
export function visibleTabs(features: HostFeatures): readonly PluginsTab[] {
  return hostSupports(features, 'plugin_packages')
    ? PLUGINS_TABS
    : PLUGINS_TABS.filter((tab) => tab !== 'plugins');
}

export function defaultTab(features: HostFeatures): PluginsTab {
  return visibleTabs(features)[0] ?? 'connectors';
}

/** URL 里的分段：认得且 Host 支持就用，否则要转到默认分段（`redirect`）。 */
export function resolveTab(
  param: string | undefined,
  features: HostFeatures,
): { tab: PluginsTab; redirect: boolean } {
  const visible = visibleTabs(features);
  const found = visible.find((tab) => tab === param);
  return found ? { tab: found, redirect: false } : { tab: defaultTab(features), redirect: true };
}

// ---- 连接器 ----

export type ConnectorStateKey =
  | 'disabled'
  | 'missingInputs'
  | 'connected'
  | 'starting'
  | 'failed'
  | 'authRequired'
  | 'idle';

export interface ConnectorState {
  key: ConnectorStateKey;
  tone: StatusTone;
  /** 进行中的状态让圆点闪烁。 */
  pulse: boolean;
}

/** 状态的文案 key（zh-CN.ts 的 `plugins.connector.state.*`）。 */
export const CONNECTOR_STATE_LABEL: Record<ConnectorStateKey, PlainMessageKey> = {
  disabled: 'plugins.connector.state.disabled',
  missingInputs: 'plugins.connector.state.missingInputs',
  connected: 'plugins.connector.state.connected',
  starting: 'plugins.connector.state.starting',
  failed: 'plugins.connector.state.failed',
  authRequired: 'plugins.connector.state.authRequired',
  idle: 'plugins.connector.state.idle',
};

const STATES: Record<ConnectorStateKey, Omit<ConnectorState, 'key'>> = {
  disabled: { tone: 'neutral', pulse: false },
  missingInputs: { tone: 'warning', pulse: false },
  connected: { tone: 'success', pulse: false },
  starting: { tone: 'accent', pulse: true },
  failed: { tone: 'danger', pulse: false },
  authRequired: { tone: 'warning', pulse: false },
  idle: { tone: 'neutral', pulse: false },
};

/**
 * 连接器此刻的状态：连接器自己或所属插件关着是“已关闭”，缺必填输入项是“缺少输入项”，其余按引擎报的 `status`（Codex 的
 * McpServerConnectionStatus：notStarted、starting、connected、authenticationRequired、failed、cancelled、disabled）；引擎还
 * 没启动、没有状态时是“未启动”。
 */
export function connectorState(connector: Connector, plugin?: Plugin): ConnectorState {
  return {
    key: connectorStateKey(connector, plugin),
    ...STATES[connectorStateKey(connector, plugin)],
  };
}

function connectorStateKey(connector: Connector, plugin?: Plugin): ConnectorStateKey {
  if (!connector.enabled || plugin?.enabled === false) return 'disabled';
  if (connector.missingInputs !== undefined && connector.missingInputs.length > 0) {
    return 'missingInputs';
  }
  switch (connector.status) {
    case 'connected':
      return 'connected';
    case 'starting':
      return 'starting';
    case 'failed':
    case 'cancelled':
      return 'failed';
    case 'authenticationRequired':
      return 'authRequired';
    case 'disabled':
      return 'disabled';
    default:
      return 'idle';
  }
}

/** 命令与参数的显示写法：带空白的参数加引号（只用于显示）。 */
export function commandLine(command: string, args: readonly string[] = []): string {
  return [command, ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(' ');
}

// ---- 范围与来源（0.74.0） ----

/**
 * 名字与这个范围冲突的连接器（添加、编辑时校验重名）：名字在全局与同一项目之间唯一，不同项目可以重名，所以全局的新名字与
 * 所有连接器比，项目的与全局及同一项目的比。`exceptId` 是编辑时它自己。
 */
export function conflictingNames(
  connectors: readonly Connector[],
  workspaceId: string | undefined,
  exceptId?: string,
): Set<string> {
  return new Set(
    connectors
      .filter(
        (item) =>
          item.id !== exceptId &&
          (workspaceId === undefined ||
            item.workspaceId === undefined ||
            item.workspaceId === workspaceId),
      )
      .map((item) => item.name),
  );
}

/** 散装连接器还没填值的环境变量或请求头键（导入的连接器）；插件的输入项不算，那些在插件详情里填。 */
export function missingSecretKeys(connector: Connector): string[] {
  return connector.pluginId === undefined ? (connector.missingInputs ?? []) : [];
}

// ---- Skills ----

export interface SkillGroups {
  wevir: Skill[];
  user: Skill[];
  project: Skill[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** 按名字排（数字按大小），同名按路径，列表不随 Host 返回的顺序跳。 */
export function byName<T extends { name: string }>(
  items: readonly T[],
  tie?: (a: T, b: T) => number,
) {
  return [...items].sort((a, b) => collator.compare(a.name, b.name) || (tie?.(a, b) ?? 0));
}

/** 三组：Wevir（含插件里的）、我的（`~/.agents/skills`）、项目；没有的组是空表。 */
export function groupSkills(skills: readonly Skill[]): SkillGroups {
  const sorted = byName(skills, (a, b) => collator.compare(a.path, b.path));
  return {
    wevir: sorted.filter((skill) => skill.source === 'wevir'),
    user: sorted.filter((skill) => skill.source === 'user'),
    project: sorted.filter((skill) => skill.source === 'project'),
  };
}

/** 行里的一行描述：短描述优先，没有就取描述，折成一行。 */
export function skillSummary(skill: Pick<Skill, 'shortDescription' | 'description'>): string {
  return (skill.shortDescription ?? skill.description).replace(/\s+/g, ' ').trim();
}

/**
 * 项目 Skills 所在的项目文件夹名：路径形如 `<项目>/.agents/skills/<名字>/SKILL.md` 或 `<项目>/.codex/skills/…`（Host 也会列
 * 已登记项目的祖先文件夹里的，这时是那个祖先）；认不出时没有。
 */
export function skillProject(skill: Pick<Skill, 'path'>): string | undefined {
  const parts = skill.path.split(/[\\/]+/);
  for (let index = parts.length - 3; index >= 1; index--) {
    if (
      (parts[index] === '.agents' || parts[index] === '.codex') &&
      parts[index + 1] === 'skills'
    ) {
      return parts[index - 1] || undefined;
    }
  }
  return undefined;
}

/** 预览用的 SKILL.md 正文：去掉开头的 YAML frontmatter（`---` 包起来的头）。没有 frontmatter 时原样返回。 */
export function skillBody(text: string): string {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  return match ? source.slice(match[0].length).replace(/^(?:[ \t]*\r?\n)+/, '') : source;
}

// ---- 插件 ----

/** 必填、还没填的输入项；插件行写“缺少输入项”、详情里标出来。 */
export function missingRequiredInputs(plugin: Plugin): PluginInputView[] {
  return plugin.inputs.filter((input) => input.required && !input.set);
}

/** 插件包含的连接器与 Skills（按插件记的 ID 找，找不到的跳过），各自按名字排。 */
export function pluginItems(
  plugin: Plugin,
  list: Pick<PluginsList, 'connectors' | 'skills'>,
): { connectors: Connector[]; skills: Skill[] } {
  const connectors = new Set(plugin.connectors);
  const skills = new Set(plugin.skills);
  return {
    connectors: byName(list.connectors.filter((item) => connectors.has(item.id))),
    skills: byName(list.skills.filter((item) => skills.has(item.id))),
  };
}

/** 项目里每个 ID 对应的插件，给“来自〈插件名〉”用。 */
export function pluginsById(plugins: readonly Plugin[]): ReadonlyMap<string, Plugin> {
  return new Map(plugins.map((plugin) => [plugin.id, plugin]));
}

/** “来自”那一行写的名字：插件的显示名，插件不在列表里时退回 ID。 */
export function originName(
  pluginId: string | undefined,
  plugins: ReadonlyMap<string, Plugin>,
): string | undefined {
  return pluginId === undefined ? undefined : (plugins.get(pluginId)?.name ?? pluginId);
}

// ---- 本地合并 ----

function replaceById<T extends { id: string }>(items: readonly T[], next: T): T[] {
  return items.map((item) => (item.id === next.id ? next : item));
}

/** 方法的结果（开关改了、输入项存了）立即合进列表，不等 `plugins.changed` 触发的重读。 */
export function replaceConnector(list: PluginsList, connector: Connector): PluginsList {
  return { ...list, connectors: replaceById(list.connectors, connector) };
}

export function replaceSkill(list: PluginsList, skill: Skill): PluginsList {
  return { ...list, skills: replaceById(list.skills, skill) };
}

export function replacePlugin(list: PluginsList, plugin: Plugin): PluginsList {
  return { ...list, plugins: replaceById(list.plugins ?? [], plugin) };
}
