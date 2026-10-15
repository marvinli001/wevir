// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-opencode/src/server/status.ts（`flattenOpenCodeModels`、`subProviderLabelFor`、
// `inferDefaultVariant`）与 OpenCodeRuntime.ts（`parseOpenCodeModelSlug`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：输出 Wevir 的 `AccountModels`；子 Provider 写进显示名；没有变体的模型不再补一组假的推理档位（T3 为了界面一致补 low…xhigh，
// 发给 opencode 的变体它不认就忽略），只列模型自己报的。
//
// 模型（opencode-event-mapping.md §2.2）：`provider.list` 的 `connected` 里的上游，各自的模型拼成 `<上游>/<模型>`（opencode 自己
// 的写法，`promptAsync` 要拆回 providerID 与 modelID）。一个 opencode 后面可能接着好几家（OpenCode Zen、Anthropic、OpenRouter…），
// 目录还会重叠，所以显示名带上上游的名字。

import type { AccountModels, ProviderModelConfig } from '@wevir/runtime-adapter';
import type { ProviderListResponse } from './sdk.js';

export interface ParsedModelId {
  providerID: string;
  modelID: string;
}

/** `<上游>/<模型>` → 两段（T3 的 `parseOpenCodeModelSlug`）；模型 ID 本身可以带 `/`（OpenRouter 的 `vendor/model`）。 */
export function parseModelId(id: string | undefined): ParsedModelId | undefined {
  const trimmed = id?.trim() ?? '';
  const separator = trimmed.indexOf('/');
  if (separator <= 0 || separator === trimmed.length - 1) return undefined;
  return { providerID: trimmed.slice(0, separator), modelID: trimmed.slice(separator + 1) };
}

/** 接上的上游（`connected` 的顺序），带名字。 */
export function connectedProviders(
  list: ProviderListResponse,
): Array<{ id: string; name: string }> {
  const byId = new Map(list.all.map((provider) => [provider.id, provider]));
  return list.connected.map((id) => ({ id, name: byId.get(id)?.name.trim() || id }));
}

/** 套餐的说法：接上了哪些上游，按 `connected` 的顺序（例如 “Anthropic, OpenAI”）。没有时 undefined。 */
export function planLabel(list: ProviderListResponse): string | undefined {
  const names = connectedProviders(list).map((provider) => provider.name);
  return names.length === 0 ? undefined : names.join(', ');
}

/** 模型的显示名：“<上游> · <模型>”。 */
export function modelDisplayName(providerName: string, modelName: string): string {
  return `${providerName} · ${modelName}`;
}

/**
 * 接上的上游的模型（T3 的 `flattenOpenCodeModels`）：按上游、再按模型名排。推理档位是模型的变体（`variants` 的键，opencode 的
 * 原值，发消息时原样作 `variant`）；不推理的模型是空数组。默认模型取第一个上游在 opencode 里的默认模型。
 */
export function accountModels(list: ProviderListResponse): AccountModels {
  const byId = new Map(list.all.map((provider) => [provider.id, provider]));
  const models: ProviderModelConfig[] = [];
  let defaultModelId: string | undefined;
  for (const { id: providerID, name: providerName } of connectedProviders(list)) {
    const provider = byId.get(providerID);
    if (provider === undefined) continue;
    const entries = Object.entries(provider.models)
      .map(([key, model]) => ({ key, model, name: model.name?.trim() || key }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const { key, model, name } of entries) {
      const id = `${providerID}/${model.id?.trim() || key}`;
      const variants = Object.keys(model.variants ?? {});
      models.push({
        id,
        displayName: modelDisplayName(providerName, name),
        ...(model.limit?.context > 0 && { contextWindow: model.limit.context }),
        ...(model.limit?.output > 0 && { maxTokens: model.limit.output }),
        supportsImages: model.capabilities?.input?.image === true,
        reasoningEfforts: model.capabilities?.reasoning === false ? [] : variants,
      });
    }
    if (defaultModelId === undefined) {
      const preferred = list.default[providerID];
      if (preferred !== undefined && provider.models[preferred] !== undefined) {
        defaultModelId = `${providerID}/${provider.models[preferred]?.id?.trim() || preferred}`;
      }
    }
  }
  return {
    models,
    ...(models.length > 0 && { defaultModelId: defaultModelId ?? models[0]?.id }),
  };
}

type ProviderModel = ProviderListResponse['all'][number]['models'][string];

function findModel(
  list: ProviderListResponse | undefined,
  modelId: string,
): ProviderModel | undefined {
  const parsed = parseModelId(modelId);
  if (list === undefined || parsed === undefined) return undefined;
  const provider = list.all.find((candidate) => candidate.id === parsed.providerID);
  return (
    provider?.models[parsed.modelID] ??
    Object.values(provider?.models ?? {}).find((candidate) => candidate.id === parsed.modelID)
  );
}

/** 模型的上下文窗口（`usage.updated` 的 `contextSize`）。 */
export function contextWindowOf(
  list: ProviderListResponse | undefined,
  modelId: string,
): number | undefined {
  const context = findModel(list, modelId)?.limit?.context;
  return typeof context === 'number' && context > 0 ? context : undefined;
}

/** 模型的变体（推理档位）；不推理或不认识的模型是空数组。 */
export function variantsOf(list: ProviderListResponse | undefined, modelId: string): string[] {
  const model = findModel(list, modelId);
  if (model === undefined || model.capabilities?.reasoning === false) return [];
  return Object.keys(model.variants ?? {});
}

/** 推理档位从低到高（Wevir 的 `ProviderReasoningLevel`，加上 opencode 变体里常见的 `none`）。 */
const VARIANT_ORDER = ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * 最低的一档变体（生成标题用，同 Codex 与 Claude 的标题）。变体名是上游自己起的：一个都认不出时 undefined，让 opencode 用
 * 模型的默认值，不去猜。
 */
export function lowestVariant(variants: readonly string[]): string | undefined {
  return VARIANT_ORDER.find((level) => variants.includes(level));
}
