// SPDX-License-Identifier: MIT
// 模型探测参考 pingdotgg/t3code packages/provider-kiro/src/server/status.ts，
// 提交 55e25385619c7680dad0b0f34f5185187806c57a（MIT，Copyright (c) 2026 T3 Tools Inc.）。
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

/** 已登录账号的 `kiro-cli chat --list-models --format json`。 */
export function parseKiroModelList(output: string, withEfforts = false): AccountModels | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  const fields = record(parsed);
  if (!Array.isArray(fields?.models)) return undefined;
  const catalog = kiroModels(undefined, {
    currentModelId: fields.default_model ?? 'auto',
    availableModels: fields.models.map((entry: unknown) => {
      const model = record(entry);
      return { modelId: model?.model_id, name: model?.model_name };
    }),
  });
  if (catalog === undefined || !withEfforts) return catalog;
  return {
    ...catalog,
    models: catalog.models.map((model) => ({ ...model, ...documentedEfforts(model.id) })),
  };
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

export function kiroSelectOption(configOptions: unknown, id: string) {
  if (!Array.isArray(configOptions)) return undefined;
  const option = configOptions
    .map(record)
    .find((entry) => entry?.id === id && entry.type === 'select');
  return option === undefined
    ? undefined
    : {
        id,
        currentValue: typeof option.currentValue === 'string' ? option.currentValue : undefined,
        values: selectEntries(option.options).map((entry) => entry.value),
      };
}

const EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export function fromKiroEffort(value: string): string {
  return value === 'none' ? 'off' : value;
}

type ModelEfforts = Pick<ProviderModelConfig, 'reasoningEfforts' | 'defaultReasoningEffort'>;

/** 初次打开模型选择时 CLI 目录没有档位，用 Kiro 官方的模型表；写档位前仍以会话实际公布的选项为准。 */
function documentedEfforts(id: string): ModelEfforts | undefined {
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
  switch (id) {
    case 'claude-opus-5.5':
      return { reasoningEfforts: levels, defaultReasoningEffort: 'medium' };
    case 'claude-opus-5':
    case 'claude-opus-4.8':
    case 'claude-opus-4.7':
    case 'claude-sonnet-5.5':
    case 'claude-sonnet-5':
      return { reasoningEfforts: levels };
    case 'claude-opus-4.6':
    case 'claude-sonnet-4.6':
      return { reasoningEfforts: ['low', 'medium', 'high', 'max'] };
    case 'gpt-5.6-sol':
    case 'gpt-5.6-terra':
    case 'gpt-5.6-luna':
      return { reasoningEfforts: ['off', ...levels], defaultReasoningEffort: 'high' };
    default:
      return undefined;
  }
}

/**
 * 会话的模型 → 账号的模型。Kiro 的 v2 引擎用 ACP 的 `session/set_model`，模型列表应在 `session/new` 结果的 `models`
 * （`availableModels` 与 `currentModelId`）里；`configOptions` 里的模型选项也认（v3 引擎换成了 `set_config_option`）。登录后的
 * 形状没有账号核对过。都没有或是空的时 undefined（用“默认”）。
 */
export function kiroModels(
  configOptions: unknown,
  models?: unknown,
  previous?: AccountModels,
): AccountModels | undefined {
  const seen = new Set<string>();
  const list: ProviderModelConfig[] = [];
  const previousModels = new Map(previous?.models.map((model) => [model.id, model]));
  const nativeModel = modelOption(configOptions);
  const nativeEffort = kiroSelectOption(configOptions, 'effortLevel');
  const hasV3Options =
    nativeEffort !== undefined || kiroSelectOption(configOptions, 'autopilot') !== undefined;
  const add = (id: string, name: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const prior = previousModels.get(id);
    const documented = hasV3Options ? documentedEfforts(id) : undefined;
    const reasoningEfforts =
      nativeModel?.currentValue === id && nativeEffort !== undefined
        ? [
            ...new Set(
              nativeEffort.values.map(fromKiroEffort).filter((effort) => EFFORTS.has(effort)),
            ),
          ]
        : (prior?.reasoningEfforts ?? documented?.reasoningEfforts);
    const defaultReasoningEffort =
      prior?.defaultReasoningEffort ?? documented?.defaultReasoningEffort;
    list.push({
      id,
      displayName: name || id,
      ...(reasoningEfforts !== undefined && { reasoningEfforts }),
      ...(defaultReasoningEffort !== undefined &&
        reasoningEfforts?.includes(defaultReasoningEffort) && { defaultReasoningEffort }),
    });
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
    current = nativeModel?.currentValue;
    for (const entry of selectEntries(nativeModel?.options)) add(entry.value, entry.name);
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
