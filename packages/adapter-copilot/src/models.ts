import type { AccountModels, ProviderModelConfig } from '@wevir/runtime-adapter';

/** 没读到模型时的“默认”：沿用 Copilot 当前的模型（Auto 或用户设的默认），不把这个占位 ID 发给 CLI。 */
export const COPILOT_DEFAULT_MODEL = 'copilot-default';
export const COPILOT_DEFAULT_MODELS: AccountModels = {
  models: [{ id: COPILOT_DEFAULT_MODEL, displayName: 'Default' }],
  defaultModelId: COPILOT_DEFAULT_MODEL,
};

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 会话 `configOptions` 里的模型选项：类别是 `model` 的 select，没有类别时 ID 是 `model` 的。 */
export function modelOption(configOptions: unknown) {
  if (!Array.isArray(configOptions)) return undefined;
  const options = configOptions.map(record).filter((option) => option?.type === 'select');
  return (
    options.find((option) => option?.category === 'model') ??
    options.find((option) => option?.id === 'model')
  );
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
 * 会话的模型选项 → 账号的模型。ACP 的 `models`（`availableModels` 与 `currentModelId`）也认：哪个引擎版本用哪种没有核对过。都没有
 * 或是空的时 undefined（用“默认”）。
 */
export function copilotModels(configOptions: unknown, models?: unknown): AccountModels | undefined {
  const seen = new Set<string>();
  const list: ProviderModelConfig[] = [];
  const add = (id: string, name: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    list.push({ id, displayName: name || id });
  };
  const option = modelOption(configOptions);
  let current: unknown = option?.currentValue;
  for (const entry of selectEntries(option?.options)) add(entry.value, entry.name);
  if (list.length === 0) {
    const state = record(models);
    current = state?.currentModelId;
    for (const entry of Array.isArray(state?.availableModels) ? state.availableModels : []) {
      const fields = record(entry);
      const id = fields?.modelId;
      if (typeof id === 'string' && id.trim()) {
        add(id, typeof fields?.name === 'string' ? fields.name : id);
      }
    }
  }
  if (list.length === 0) return undefined;
  return {
    models: list,
    defaultModelId:
      typeof current === 'string' && seen.has(current)
        ? current
        : (list[0] as ProviderModelConfig).id,
  };
}
