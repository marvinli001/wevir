import type { AccountModels, ProviderModelConfig } from '@wevir/runtime-adapter';

/** 没读到模型时的“默认”：沿用 Devin 当前的模型（账号或团队设的默认），不把这个占位 ID 发给 CLI。 */
export const DEVIN_DEFAULT_MODEL = 'devin-default';
export const DEVIN_DEFAULT_MODELS: AccountModels = {
  models: [{ id: DEVIN_DEFAULT_MODEL, displayName: 'Default' }],
  defaultModelId: DEVIN_DEFAULT_MODEL,
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

/**
 * 会话 `configOptions` 里的 `model` 选项 → 账号的模型。没登录时 Devin 照样建会话，但模型选项是空的，这时 undefined（用“默认”）。
 */
export function devinModels(configOptions: unknown): AccountModels | undefined {
  const model = selectOption(configOptions, 'model');
  if (model === undefined) return undefined;
  const seen = new Set<string>();
  const models: ProviderModelConfig[] = [];
  for (const entry of selectEntries(model.options)) {
    if (seen.has(entry.value)) continue;
    seen.add(entry.value);
    models.push({ id: entry.value, displayName: entry.name || entry.value });
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
