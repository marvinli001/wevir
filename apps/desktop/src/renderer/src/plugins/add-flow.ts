import type { Skill, WevirPluginManifest } from '@wevir/protocol';
import type { InstallSourceInspection } from '../../../shared/desktop-api.js';

export type AddPlan =
  | { action: 'skill' }
  | { action: 'preview' }
  | { action: 'error'; reason: 'unsupported' | 'packages' };

export function planAdd(inspection: InstallSourceInspection, packagesSupported: boolean): AddPlan {
  if (inspection.kind === 'unsupported') return { action: 'error', reason: 'unsupported' };
  if (inspection.kind === 'skill') return { action: 'skill' };
  return packagesSupported ? { action: 'preview' } : { action: 'error', reason: 'packages' };
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
