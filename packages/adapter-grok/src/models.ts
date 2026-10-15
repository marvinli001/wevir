// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-grok/src/server/status.ts（`parseGrokModelsCliOutput`、`displayNameFromGrokModelSlug`、`buildGrokModelsFromSessionModelState`、`grokReasoningOptionsFromModel`）、packages/provider-acp/src/server/runtimeModel.ts（`sessionModelStateFromInitialize`）、packages/provider-grok/src/server/acpSupport.ts（`GROK_DEFAULT_MODEL_SLUG`、`isValidGrokReasoningEffortToken`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写成不依赖 `effect` 的普通 TS，输出 Wevir 的 `AccountModels`（`ProviderModelConfig` 的上下文窗口与推理档位）；
// 不读 T3 的自定义模型设置。
//
// Grok 的模型（grok-event-mapping.md §2.2）：`grok models` 的输出（同时说明有没有登录），以及 `initialize` 的
// `_meta.modelState`（带上下文窗口与推理档位）。两者都有时用后者，照 T3。

import type { AccountModels, ProviderModelConfig } from '@wevir/runtime-adapter';

/**
 * T3 自带的 Grok 模型：CLI 的产品名，不是 ACP 认的模型 ID，选它表示“用 Grok 会话当前的模型”（不发 `session/set_model`）。
 * 检测不到模型时作为唯一的模型。
 */
export const GROK_DEFAULT_MODEL = 'grok-build';

export const GROK_DEFAULT_MODELS: AccountModels = Object.freeze({
  models: [{ id: GROK_DEFAULT_MODEL, displayName: 'Grok Build' }],
  defaultModelId: GROK_DEFAULT_MODEL,
});

const REASONING_EFFORT_TOKEN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

/** T3 的 `isValidGrokReasoningEffortToken`。 */
export function isValidReasoningEffort(value: string): boolean {
  return REASONING_EFFORT_TOKEN.test(value);
}

export interface GrokModelsCliOutput {
  /** 打印了已登录 / 未登录时为 true / false，两样都没有时为 null。 */
  authenticated: boolean | null;
  models: AccountModels;
}

/** 模型 ID → 显示名（T3 的 `displayNameFromGrokModelSlug`）：`grok-4.6` → `Grok 4.6`。 */
export function displayNameFromSlug(slug: string): string {
  return slug
    .split(/[-_]/g)
    .map((part) => (part.toLowerCase() === 'grok' ? 'Grok' : part))
    .join(' ');
}

/**
 * 解析 `grok models`（T3 的 `parseGrokModelsCliOutput`）。不论有没有登录命令都以 0 退出，只能看文字。现在的输出：
 *
 *     You are logged in with grok.com.
 *     Default model: grok-4.6
 *     Available models:
 *       * grok-4.6 (default)
 *       - grok-4.5
 */
export function parseGrokModelsOutput(output: string): GrokModelsCliOutput {
  const authenticated = /you are logged in/i.test(output)
    ? true
    : /not authenticated|not logged in/i.test(output)
      ? false
      : null;
  const seen = new Set<string>();
  const models: ProviderModelConfig[] = [];
  let defaultModelId: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const bullet = /^\s*[*-]\s+(\S+)(.*)$/.exec(line);
    const slug = bullet?.[1]?.trim();
    if (slug === undefined || slug === '' || seen.has(slug)) continue;
    seen.add(slug);
    models.push({ id: slug, displayName: displayNameFromSlug(slug) });
    if (defaultModelId === undefined && /\(default\)/i.test(bullet?.[2] ?? '')) {
      defaultModelId = slug;
    }
  }
  return {
    authenticated,
    models:
      models.length === 0
        ? { models }
        : { models, defaultModelId: defaultModelId ?? (models[0] as ProviderModelConfig).id },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * 一个模型的推理档位（T3 的 `grokReasoningOptionsFromModel`）：`_meta.reasoningEfforts` 里的 `value`（没有时 `id`），
 * `supportsReasoningEffort: false` 时没有。
 */
function reasoningEfforts(meta: Record<string, unknown> | undefined): string[] | undefined {
  if (meta === undefined || meta.supportsReasoningEffort === false) return undefined;
  if (!Array.isArray(meta.reasoningEfforts)) return undefined;
  const efforts: string[] = [];
  for (const entry of meta.reasoningEfforts) {
    const fields = record(entry);
    const value = [nonEmpty(fields?.value), nonEmpty(fields?.id)].find(
      (candidate) => candidate !== undefined && isValidReasoningEffort(candidate),
    );
    if (value !== undefined && !efforts.includes(value)) efforts.push(value);
  }
  return efforts.length > 0 ? efforts : undefined;
}

/**
 * `initialize` 的 `_meta.modelState`（`currentModelId` 与 `availableModels`，T3 的 `sessionModelStateFromInitialize` 与
 * `buildGrokModelsFromSessionModelState`）→ 模型列表，当前的模型是默认。没有或形状不对时 undefined。
 */
export function modelsFromInitialize(initialize: unknown): AccountModels | undefined {
  const state = record(record(record(initialize)?._meta)?.modelState);
  if (state === undefined || !Array.isArray(state.availableModels)) return undefined;
  const current = nonEmpty(state.currentModelId);
  const seen = new Set<string>();
  const models: ProviderModelConfig[] = [];
  for (const entry of state.availableModels) {
    const model = record(entry);
    const id = nonEmpty(model?.modelId);
    if (model === undefined || id === undefined || seen.has(id)) continue;
    seen.add(id);
    const meta = record(model._meta);
    const context = meta?.totalContextTokens;
    const efforts = reasoningEfforts(meta);
    models.push({
      id,
      displayName: nonEmpty(model.name) ?? displayNameFromSlug(id),
      ...(typeof context === 'number' && Number.isInteger(context) && context > 0
        ? { contextWindow: context }
        : {}),
      ...(efforts !== undefined && { reasoningEfforts: efforts }),
    });
  }
  if (models.length === 0) return undefined;
  const defaultModelId =
    current !== undefined && seen.has(current) ? current : (models[0] as ProviderModelConfig).id;
  return { models, defaultModelId };
}
