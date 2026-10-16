// “添加”插件与 Skills 的流程判断（0.42.0，desktop-layout.md §23）：主进程的 `inspectInstallSource` 说来源是什么，这里决定下一步——
// 直接装 Skills、直接装插件包、先在对话框里填输入项、还是已经装过要先问升级。纯函数。

import { isRpcError } from '@wevir/client-sdk';
import {
  type Plugin,
  type Skill,
  type WevirPluginManifest,
  WevirPluginManifestSchema,
} from '@wevir/protocol';
import type { InstallSourceInspection } from '../../../shared/desktop-api.js';

export type AddPlan =
  /** `skill.install`。 */
  | { action: 'skill' }
  /** `plugin.install`，没有要先问的。 */
  | { action: 'plugin' }
  /** 新的 Wevir 插件包有输入项：先在对话框里填，再 `plugin.install`。 */
  | { action: 'inputs'; manifest: WevirPluginManifest }
  /** 清单的 id 已经装过：问升级，确认后 `plugin.install` 带 `replace`（保留已填的输入项，不再问）。 */
  | { action: 'upgrade'; manifest: WevirPluginManifest; installed: Plugin }
  /** 装不了：不是文件夹 / ZIP / SKILL.md，或 Host 没有插件包。 */
  | { action: 'error'; reason: 'unsupported' | 'packages' };

/**
 * 按来源的判断与已装的插件决定下一步。Wevir 包的清单这里能读（协议的 zod）就按 id 与输入项判断；读不出的（没有清单、
 * 校验不过）直接交给 Host 装，它报的原因显示在对话框里。Claude / Codex 的包没有可读的清单，同 id 的冲突由 Host 报错后再问升级
 * （`isAlreadyInstalled`）。
 */
export function planAdd(
  inspection: InstallSourceInspection,
  installed: readonly Plugin[],
  packagesSupported: boolean,
): AddPlan {
  if (inspection.kind === 'unsupported') return { action: 'error', reason: 'unsupported' };
  if (inspection.kind === 'skill') return { action: 'skill' };
  if (!packagesSupported) return { action: 'error', reason: 'packages' };
  if (inspection.format !== 'wevir' || inspection.manifest === undefined) {
    return { action: 'plugin' };
  }
  const parsed = WevirPluginManifestSchema.safeParse(inspection.manifest);
  if (!parsed.success) return { action: 'plugin' };
  const manifest = parsed.data;
  const existing = installed.find((plugin) => plugin.id === manifest.id);
  if (existing) return { action: 'upgrade', manifest, installed: existing };
  return (manifest.inputs ?? []).length > 0 ? { action: 'inputs', manifest } : { action: 'plugin' };
}

/** Host 回的“同 id 已装、要带 replace 才升级”（INVALID_PARAMS，host/src/plugins.ts）。 */
export function isAlreadyInstalled(error: unknown): boolean {
  return isRpcError(error, 'INVALID_PARAMS') && /already installed/i.test(error.message);
}

/** 输入项还没填的必填项（去掉首尾空白后为空）。 */
export function missingRequired(
  manifest: Pick<WevirPluginManifest, 'inputs'>,
  values: Readonly<Record<string, string>>,
): string[] {
  return (manifest.inputs ?? [])
    .filter((input) => input.required === true && (values[input.key] ?? '').trim() === '')
    .map((input) => input.key);
}

/** 交给 `plugin.install` 的输入值：只送填了的（空的不送，Host 当作没填）。 */
export function inputValues(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim() !== ''));
}

/** `skill.install` 回的是装完后的全部 Skills：这次新出现的那些。 */
export function newlyInstalled(before: readonly Skill[], after: readonly Skill[]): Skill[] {
  const known = new Set(before.map((skill) => skill.id));
  return after.filter((skill) => !known.has(skill.id));
}
