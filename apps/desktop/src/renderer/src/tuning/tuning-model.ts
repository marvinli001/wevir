// 调优页（0.85.0，desktop-layout.md §34）的纯逻辑：功能判断、分段、范围、层的名称与摘要、版本的变化摘要。

import { hostSupports } from '@wevir/client-sdk';
import {
  type HostFeatures,
  PROFILE_LAYERS,
  type ProfileItem,
  type ProfileLayer,
  type ProfileLayerChange,
  type ProfileLayerKey,
} from '@wevir/protocol';
import { type PlainMessageKey, t } from '@/i18n';
import { isTuningTab, type SettingsTab, TUNING_TABS, type TuningTab } from '@/routes/paths';

export type TuningAvailability = 'pending' | 'ready' | 'unsupported';

export function tuningAvailability(features: HostFeatures | undefined): TuningAvailability {
  if (features === undefined) return 'pending';
  return hostSupports(features, 'tuning') ? 'ready' : 'unsupported';
}

/** 这个 Host 能用的分段：“建议”要 `tuning_proposals`（0.87.0）。 */
export function visibleTuningTabs(features: HostFeatures): TuningTab[] {
  return TUNING_TABS.filter(
    (tab) => tab !== 'proposals' || hostSupports(features, 'tuning_proposals'),
  );
}

/** 地址里的分段：认不出或不能用时转到第一个。 */
export function resolveTuningTab(
  tab: string | undefined,
  features: HostFeatures,
): { tab: TuningTab; redirect: boolean } {
  const tabs = visibleTuningTabs(features);
  const first = tabs[0] ?? 'profile';
  if (tab !== undefined && isTuningTab(tab) && tabs.includes(tab)) return { tab, redirect: false };
  return { tab: first, redirect: true };
}

/** 范围：`global` 或工作区 ID。 */
export type TuningScope = 'global' | (string & {});

/** 范围对应的 `workspaceId` 参数。 */
export function scopeWorkspaceId(scope: TuningScope): string | undefined {
  return scope === 'global' ? undefined : scope;
}

/** 选中的范围：地址里给了就用它，否则上次的；都不在列表里时是全局。 */
export function pickScope(
  requested: string | null | undefined,
  remembered: TuningScope,
  workspaceIds: readonly string[],
): TuningScope {
  const valid = (scope: string | null | undefined): scope is string =>
    scope === 'global' || (scope != null && workspaceIds.includes(scope));
  if (valid(requested)) return requested;
  if (valid(remembered)) return remembered;
  return 'global';
}

const LAYER_KEYS = {
  system: 'tuning.layer.system',
  rules: 'tuning.layer.rules',
  instructions: 'tuning.layer.instructions',
  memory: 'tuning.layer.memory',
  skills: 'tuning.layer.skills',
  roles: 'tuning.layer.roles',
  guardrails: 'tuning.layer.guardrails',
  connectors: 'tuning.layer.connectors',
} as const satisfies Record<ProfileLayerKey, PlainMessageKey>;

export function isKnownLayer(key: string): key is ProfileLayerKey {
  return (PROFILE_LAYERS as readonly string[]).includes(key);
}

/** 层的名称；认不出的层原样写 key。 */
export function layerName(key: string): string {
  return isKnownLayer(key) ? t(LAYER_KEYS[key]) : key;
}

/** 按 `PROFILE_LAYERS` 排好、只留认得的层。 */
export function knownLayers(layers: readonly ProfileLayer[]): ProfileLayer[] {
  return PROFILE_LAYERS.flatMap((key) => layers.filter((layer) => layer.key === key));
}

export function scopeName(scope: string): string {
  return scope === 'project' ? t('tuning.project') : t('tuning.global');
}

/** 层里有哪几种范围：“全局 · 项目”。 */
export function layerScopes(layer: ProfileLayer): string {
  const scopes = new Set(
    layer.items.map((item) => (item.scope === 'project' ? 'project' : 'global')),
  );
  return (['global', 'project'] as const)
    .filter((scope) => scopes.has(scope))
    .map(scopeName)
    .join(' · ');
}

/** 层行右边的摘要：文件层写“n 个文件”，说明与风格写风格名，其余写“n 条”。 */
export function layerSummary(layer: ProfileLayer): string {
  const count = layer.items.length;
  if (layer.key === 'system' || layer.key === 'rules') return t('tuning.fileCount', { count });
  if (layer.key === 'instructions') {
    const style = layer.items.find((item) => item.id === 'outputStyle')?.detail;
    if (style !== undefined) return styleName(style);
  }
  return t('tuning.itemCount', { count });
}

const STYLE_KEYS = {
  default: 'outputStyle.default',
  concise: 'outputStyle.concise',
  explanatory: 'outputStyle.explanatory',
  learning: 'outputStyle.learning',
  proactive: 'outputStyle.proactive',
  pragmatic: 'outputStyle.pragmatic',
  friendly: 'outputStyle.friendly',
} as const satisfies Record<string, PlainMessageKey>;

/** 风格名：内置的用界面上的叫法，自定义的原样。 */
function styleName(style: string): string {
  return Object.hasOwn(STYLE_KEYS, style) ? t(STYLE_KEYS[style as keyof typeof STYLE_KEYS]) : style;
}

/** 条目的显示名：说明与风格两条用界面上的叫法。 */
export function itemLabel(layerKey: string, item: Pick<ProfileItem, 'id' | 'label' | 'detail'>) {
  if (layerKey === 'instructions' && item.id === 'agentInstructions') {
    return t('settings.personalization.instructions');
  }
  if (layerKey === 'instructions' && item.id === 'outputStyle') {
    return t('settings.personalization.outputStyle');
  }
  return item.label;
}

/** 条目名称右边的小字：风格名、命令、版本等。 */
export function itemDetail(layerKey: string, item: Pick<ProfileItem, 'id' | 'detail'>) {
  if (layerKey === 'instructions' && item.id === 'outputStyle' && item.detail !== undefined) {
    return styleName(item.detail);
  }
  // 记忆写种类、角色写来源，信息不大，不显示。
  if (layerKey === 'memory' || layerKey === 'roles' || layerKey === 'guardrails') return undefined;
  return item.detail;
}

/** 指纹与散列的显示：前 8 位。 */
export function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

/** 版本号的显示。 */
export function versionLabel(seq: number): string {
  return `v${seq}`;
}

/** 版本的变化摘要：“规则文件 · 记忆 +2”。只改了的层只写名称。 */
export function changesSummary(changes: readonly ProfileLayerChange[] | undefined): string {
  if (changes === undefined) return '';
  return changes
    .filter((change) => isKnownLayer(change.key))
    .map((change) => {
      const marks = [
        change.added > 0 ? `+${change.added}` : '',
        change.removed > 0 ? `−${change.removed}` : '',
      ].filter((mark) => mark !== '');
      return [layerName(change.key), ...marks].join(' ');
    })
    .join(' · ');
}

/** 待生效的层：“规则文件、记忆”。 */
export function pendingSummary(keys: readonly string[]): string {
  return keys.filter(isKnownLayer).map(layerName).join('、');
}

/** 层的管理入口：设置的一页或插件的一个分段；没有的层是 `undefined`。 */
export type LayerManage =
  | { kind: 'settings'; tab: SettingsTab }
  | { kind: 'plugins'; tab: 'skills' | 'connectors' };

export function layerManage(key: string): LayerManage | undefined {
  switch (key) {
    case 'instructions':
      return { kind: 'settings', tab: 'personalization' };
    case 'memory':
      return { kind: 'settings', tab: 'memory' };
    case 'guardrails':
      return { kind: 'settings', tab: 'approvalRules' };
    case 'skills':
      return { kind: 'plugins', tab: 'skills' };
    case 'connectors':
      return { kind: 'plugins', tab: 'connectors' };
    default:
      return undefined;
  }
}

/** 条目的文本散列（取 `tuning.blob` 用）；没有文本时 `undefined`。 */
export function textHashOf(item: ProfileItem | undefined): string | undefined {
  if (item?.text !== true) return undefined;
  return item.textHash ?? item.hash;
}
