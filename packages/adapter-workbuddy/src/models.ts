import type { AccountModels, ProviderModelConfig } from '@wevir/runtime-adapter';

/** 探测失败时的 Auto：沿用 CLI 当前模型，不把这个占位 ID 发给 CLI。 */
export const WORKBUDDY_DEFAULT_MODEL = 'workbuddy-auto';
export const WORKBUDDY_DEFAULT_MODELS: AccountModels = {
  models: [{ id: WORKBUDDY_DEFAULT_MODEL, displayName: 'Auto' }],
  defaultModelId: WORKBUDDY_DEFAULT_MODEL,
};

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function selectOption(configOptions: unknown, id: string) {
  if (!Array.isArray(configOptions)) return undefined;
  return configOptions.map(record).find((option) => option?.id === id && option.type === 'select');
}

export function selectEntries(options: unknown): Array<{ value: string; name: string }> {
  if (!Array.isArray(options)) return [];
  return options.flatMap((entry) => {
    const fields = record(entry);
    if (fields === undefined) return [];
    if (typeof fields.value === 'string' && fields.value.trim()) {
      return [
        { value: fields.value, name: typeof fields.name === 'string' ? fields.name : fields.value },
      ];
    }
    return selectEntries(fields.options);
  });
}

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** enabled 是 CLI 默认档位；disabled 才对应 Wevir 的 off，不扩展线缆枚举。 */
export function wevirEffort(value: unknown): string | undefined {
  if (value === 'disabled') return 'off';
  return typeof value === 'string' && EFFORTS.has(value) ? value : undefined;
}

export function nativeEffort(value: string | undefined): string | undefined {
  return value === 'off' ? 'disabled' : value;
}

/** thought_level 属于当前模型，绝不把它套给其他模型。 */
export function workBuddyModels(configOptions: unknown): AccountModels | undefined {
  const model = selectOption(configOptions, 'model');
  if (model === undefined) return undefined;
  const entries = selectEntries(model.options);
  const effort = selectOption(configOptions, 'thought_level');
  const efforts = selectEntries(effort?.options).flatMap(({ value }) => {
    const normalized = wevirEffort(value);
    return normalized === undefined ? [] : [normalized];
  });
  const seen = new Set<string>();
  const models: ProviderModelConfig[] = [];
  for (const entry of entries) {
    if (seen.has(entry.value)) continue;
    seen.add(entry.value);
    models.push({
      id: entry.value,
      displayName: entry.name || entry.value,
      ...(entry.value === model.currentValue &&
        effort !== undefined && {
          reasoningEfforts: [...new Set(efforts)],
        }),
    });
  }
  if (models.length === 0) return undefined;
  return {
    models,
    defaultModelId:
      typeof model.currentValue === 'string' && seen.has(model.currentValue)
        ? model.currentValue
        : (models[0] as ProviderModelConfig).id,
  };
}
