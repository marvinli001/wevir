import type { AccountModels, ProviderModelConfig } from '@wevir/runtime-adapter';

/** 没读到模型时的“默认”：沿用 Kiro 当前的模型（Auto 或用户设的默认），不把这个占位 ID 发给 CLI。 */
export const KIRO_DEFAULT_MODEL = 'kiro-default';
export const KIRO_DEFAULT_MODELS: AccountModels = {
  models: [{ id: KIRO_DEFAULT_MODEL, displayName: 'Default' }],
  defaultModelId: KIRO_DEFAULT_MODEL,
};

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 会话 `configOptions` 里的模型选项：类别是 `model` 的第一个 select，没有类别时 ID 是 `model` 的。与选模型时用的
 * （`@wevir/adapter-acp` 的 `routeModelOption`）是同一个。
 */
export function modelOption(configOptions: unknown) {
  if (!Array.isArray(configOptions)) return undefined;
  const options = configOptions
    .map(record)
    .filter(
      (option) =>
        option?.type === 'select' && typeof option.id === 'string' && option.id.trim() !== '',
    );
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
 * 会话的模型 → 账号的模型。Kiro 的 v2 引擎用 ACP 的 `session/set_model`，模型列表应在 `session/new` 结果的 `models`
 * （`availableModels` 与 `currentModelId`）里；`configOptions` 里的模型选项也认（v3 引擎换成了 `set_config_option`）。登录后的
 * 形状没有账号核对过。都没有或是空的时 undefined（用“默认”）。
 */
export function kiroModels(configOptions: unknown, models?: unknown): AccountModels | undefined {
  const seen = new Set<string>();
  const list: ProviderModelConfig[] = [];
  const add = (id: string, name: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    list.push({ id, displayName: name || id });
  };
  const state = record(models);
  let current: unknown = state?.currentModelId;
  for (const entry of Array.isArray(state?.availableModels) ? state.availableModels : []) {
    const fields = record(entry);
    const id = fields?.modelId;
    if (typeof id === 'string' && id.trim()) {
      add(id, typeof fields?.name === 'string' ? fields.name : id);
    }
  }
  if (list.length === 0) {
    const option = modelOption(configOptions);
    current = option?.currentValue;
    for (const entry of selectEntries(option?.options)) add(entry.value, entry.name);
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

/**
 * `session/new` 的 `models` 换成 `configOptions` 里的模型选项（ID `model`）：adapter-acp 的 `session/set_model` 从
 * `configOptions` 读当前的模型，Kiro 的 v2 引擎不给 `configOptions`。已有模型选项时原样返回。
 */
export function withModelOption(configOptions: unknown, models: unknown): unknown {
  if (modelOption(configOptions) !== undefined) return configOptions;
  const state = record(models);
  const available = Array.isArray(state?.availableModels) ? state.availableModels : [];
  const options = available.flatMap((entry) => {
    const fields = record(entry);
    const id = fields?.modelId;
    return typeof id === 'string' && id.trim()
      ? [{ value: id, name: typeof fields?.name === 'string' ? fields.name : id }]
      : [];
  });
  if (options.length === 0) return configOptions;
  const option = {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    ...(typeof state?.currentModelId === 'string' && { currentValue: state.currentModelId }),
    options,
  };
  return [...(Array.isArray(configOptions) ? configOptions : []), option];
}
