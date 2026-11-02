// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-cursor/src/server/status.ts（buildCursorDiscoveredModelsFromSdk）、sdkModel.ts（cursorSdkModelSelection）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：T3 把每个模型参数做成一个选项；Wevir 的模型只有推理档位与快速模式，只取 effort / reasoning 参数里 Wevir 认识的档位与 `fast`
// 开关（T3 的 fastMode），其余参数用 Cursor 的默认值；列表第一个是 Auto。
//
// Cursor 的模型列表（`Cursor.models.list`）→ Wevir 的模型，以及会话的模型与推理档位 → SDK 的 `ModelSelection`
// （docs/architecture/cursor-event-mapping.md §3）。

import type { ModelSelection, SDKModel } from '@cursor/sdk';
import type { AccountModels, ProviderModelConfig } from '@wevir/runtime-adapter';

/** Cursor 的 Auto（T3 的默认模型 `auto`，交给 SDK 时是 `default`）。 */
export const AUTO_MODEL_ID = 'auto';
const SDK_AUTO_MODEL_ID = 'default';

/** 当作推理档位的参数（T3 的 cursorSdkParameterPriority 排在最前的两种）。 */
const EFFORT_PARAMETERS = ['effort', 'reasoning'];

/** protocol 的 ProviderReasoningLevel，按顺序。 */
const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function effortParameter(model: SDKModel) {
  return model.parameters?.find((parameter) => EFFORT_PARAMETERS.includes(parameter.id.trim()));
}

/** 快速模式的参数（0.148.0，T3 sdkModel.ts 的 `fast` ↔ `fastMode`）：值是字符串 `true` / `false`。 */
function fastParameter(model: SDKModel) {
  const parameter = model.parameters?.find((candidate) => candidate.id.trim() === 'fast');
  const values = new Set(parameter?.values.map((entry) => entry.value.trim()));
  return values.has('true') && values.has('false') ? parameter : undefined;
}

/** 模型默认的变体带 `fast: true`：Cursor 默认就用快速档跑它。 */
function fastByDefault(model: SDKModel): boolean {
  const variant = model.variants?.find((candidate) => candidate.isDefault === true);
  return (
    variant?.params?.some(
      (param) => param.id.trim() === 'fast' && param.value.trim() === 'true',
    ) === true
  );
}

function reasoningEfforts(model: SDKModel): string[] | undefined {
  const values = new Set(
    (effortParameter(model)?.values ?? []).map((entry) => entry.value.trim().toLowerCase()),
  );
  const levels = REASONING_LEVELS.filter((level) => values.has(level));
  return levels.length > 0 ? levels : undefined;
}

/** 账号的模型：第一个是 Auto（默认），其后是 SDK 列出的模型，去掉空的与重复的。 */
export function accountModels(models: readonly SDKModel[]): AccountModels {
  const list: ProviderModelConfig[] = [{ id: AUTO_MODEL_ID, displayName: 'Auto' }];
  const seen = new Set([AUTO_MODEL_ID, SDK_AUTO_MODEL_ID]);
  for (const model of models) {
    const id = model.id.trim();
    const displayName = model.displayName.trim();
    if (id === '' || displayName === '' || seen.has(id)) continue;
    seen.add(id);
    const efforts = reasoningEfforts(model);
    const fast = fastParameter(model) !== undefined;
    list.push({
      id,
      displayName,
      ...(efforts !== undefined && { reasoningEfforts: efforts }),
      ...(fast && { supportsFast: true }),
      ...(fast && fastByDefault(model) && { fastByDefault: true }),
    });
  }
  return { models: list, defaultModelId: AUTO_MODEL_ID };
}

/**
 * 会话的模型 → SDK 的 `ModelSelection`。推理档位只在模型列表里这个模型有对应参数时带上（参数 ID 与原值取自列表）；快速模式
 * （0.148.0）在模型有 `fast` 参数时明确带 `true` 或 `false`，不落到 Cursor 的默认变体。不认识的模型照原样交给 SDK，由它报错。
 */
export function modelSelection(
  modelId: string,
  reasoningEffort: string | undefined,
  fast: boolean | undefined,
  catalog: readonly SDKModel[] | undefined,
): ModelSelection {
  const id = modelId === AUTO_MODEL_ID ? SDK_AUTO_MODEL_ID : modelId;
  const model = catalog?.find((candidate) => candidate.id.trim() === modelId);
  if (model === undefined) return { id };
  const params: NonNullable<ModelSelection['params']> = [];
  const parameter = reasoningEffort === undefined ? undefined : effortParameter(model);
  const value = parameter?.values.find(
    (entry) => entry.value.trim().toLowerCase() === reasoningEffort,
  );
  if (parameter !== undefined && value !== undefined) {
    params.push({ id: parameter.id, value: value.value });
  }
  const speed = fastParameter(model);
  if (speed !== undefined) params.push({ id: speed.id, value: fast === true ? 'true' : 'false' });
  return params.length > 0 ? { id, params } : { id };
}
