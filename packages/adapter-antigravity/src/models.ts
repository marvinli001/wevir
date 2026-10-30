// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/provider/AntigravityProvider.ts（buildAntigravityModelsFromSession）与
// acp/AntigravityAcpSupport.ts（antigravityThinkingConfig）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8；思考档位照 4432fbef71817c279290f86549be660af25005f2
// Copyright (c) 2026 T3 Tools Inc.
// 修改：产出 Wevir 的 AccountModels（模型 ID 用原生值）；运行体的思考档位换成 Wevir 的推理档位（extra_high 记作 xhigh），
// 每个模型的档位记在 `reasoningEfforts` 里；另存一份到数据目录（models.json，模型 ID、名字与档位），Host 重启后不必为了
// 模型列表启动运行体。
//
// Antigravity 的模型列表只来自 ACP 会话的 `configOptions`（“model” 选项）：登录完成、显式刷新与每次建会话时更新
// （docs/architecture/antigravity-event-mapping.md §6）。运行体 1.4 起同一模型的不同思考档位合成一项，档位另报一个
// `thought_level` 选项，而且只报当前选中的模型的（1.3 把档位写在模型 ID 里，例如 `gemini-3.7-flash-high`）。

import * as fsp from 'node:fs/promises';
import path from 'node:path';
import type { AccountModels, ProviderModelConfig } from '@wevir/runtime-adapter';

/** 运行体的思考档位 → Wevir 的推理档位（运行体源码 config_options.py 的 `_LEVEL_ORDER`）；表外的档位不显示。 */
const THINKING_EFFORTS: Readonly<Record<string, string>> = Object.freeze({
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  extra_high: 'xhigh',
  max: 'max',
});

/** 思考档位选项（`category: "thought_level"`，1.4.1 的 ID 是 `thinking_level`）：ID、当前值与可选的运行体档位。 */
export interface AntigravityThinkingOption {
  id: string;
  currentValue?: string;
  values: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface SelectEntry {
  value: string;
  name: string;
}

function selectEntries(options: unknown): SelectEntry[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((entry): SelectEntry[] => {
    if (!isRecord(entry)) return [];
    if (typeof entry.value === 'string') {
      return [
        { value: entry.value, name: typeof entry.name === 'string' ? entry.name : entry.value },
      ];
    }
    // 分组（groupId + options）。
    return selectEntries(entry.options);
  });
}

/** `configOptions` 里的思考档位选项；当前模型没有档位（或运行体是 1.3）时 undefined。 */
export function antigravityThinkingOption(
  configOptions: unknown,
): AntigravityThinkingOption | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  const option = configOptions.find(
    (o) => isRecord(o) && o.category === 'thought_level' && typeof o.id === 'string',
  ) as Record<string, unknown> | undefined;
  if (option === undefined || option.type !== 'select') return undefined;
  return {
    id: option.id as string,
    ...(typeof option.currentValue === 'string' && { currentValue: option.currentValue }),
    values: selectEntries(option.options).map((entry) => entry.value),
  };
}

/** 运行体档位 → Wevir 的推理档位，按运行体给的顺序、去重；认不出的不要。 */
export function thinkingEfforts(values: readonly string[]): string[] {
  const efforts: string[] = [];
  for (const value of values) {
    const effort = THINKING_EFFORTS[value];
    if (effort !== undefined && !efforts.includes(effort)) efforts.push(effort);
  }
  return efforts;
}

/** Wevir 的推理档位 → 这个模型提供的运行体档位（xhigh 先找同名的，再找 extra_high）；没有时 undefined。 */
export function thinkingLevelFor(effort: string, values: readonly string[]): string | undefined {
  if (values.includes(effort) && THINKING_EFFORTS[effort] === effort) return effort;
  return values.find((value) => THINKING_EFFORTS[value] === effort);
}

/** 当前选中的模型（`model` 选项的值）。 */
export function antigravityCurrentModel(configOptions: unknown): string | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  const option = configOptions.find(
    (o) => isRecord(o) && (o.id === 'model' || o.category === 'model'),
  ) as Record<string, unknown> | undefined;
  return typeof option?.currentValue === 'string' ? option.currentValue : undefined;
}

/**
 * `session/new` / `session/resume` 的结果（或 `config_option_update`）→ 模型列表。认 `id: "model"` 或
 * `category: "model"` 的 select 选项；没有时退回 ACP 的 `models`（availableModels）。当前值是默认模型。没有模型选项时返回
 * undefined（不覆盖已有的列表）。
 *
 * 推理档位（T3 的 thinkingCapabilities）：当前模型取 `thought_level` 选项（没有就是固定档位）；别的模型用 `known` 里
 * 记下的推理档位（之前选中它时看到的，见 accounts.ts 的逐个探测），没记过的不写。
 */
export function antigravityModelsFromSetup(
  setup: { configOptions?: unknown; models?: unknown },
  known?: ReadonlyMap<string, readonly string[]>,
): AccountModels | undefined {
  const options = Array.isArray(setup.configOptions) ? setup.configOptions : [];
  const config = options.find(
    (option) => isRecord(option) && (option.id === 'model' || option.category === 'model'),
  ) as Record<string, unknown> | undefined;
  let entries: SelectEntry[];
  let current: string | undefined;
  if (config !== undefined) {
    if (config.type !== 'select') return undefined;
    entries = selectEntries(config.options);
    current = typeof config.currentValue === 'string' ? config.currentValue : undefined;
  } else if (isRecord(setup.models) && Array.isArray(setup.models.availableModels)) {
    entries = setup.models.availableModels.flatMap((model): SelectEntry[] =>
      isRecord(model) && typeof model.modelId === 'string'
        ? [
            {
              value: model.modelId,
              name: typeof model.name === 'string' ? model.name : model.modelId,
            },
          ]
        : [],
    );
    current =
      typeof setup.models.currentModelId === 'string' ? setup.models.currentModelId : undefined;
  } else {
    return undefined;
  }
  const thinking = antigravityThinkingOption(setup.configOptions);
  const seen = new Set<string>();
  const models: ProviderModelConfig[] = [];
  for (const entry of entries) {
    if (!entry.value.trim() || seen.has(entry.value)) continue;
    seen.add(entry.value);
    const efforts =
      entry.value === current && config !== undefined
        ? thinkingEfforts(thinking?.values ?? [])
        : (known?.get(entry.value) ?? []);
    models.push({
      id: entry.value,
      displayName: entry.name.trim() ? entry.name : entry.value,
      ...(efforts.length > 0 && { reasoningEfforts: [...efforts] }),
    });
  }
  if (models.length === 0) return { models: [] };
  const defaultModelId =
    current !== undefined && seen.has(current) ? current : (models[0] as ProviderModelConfig).id;
  return { models, defaultModelId };
}

/**
 * 逐个选一遍模型，记下各自的推理档位（T3 AntigravityDriver 的 publishCatalog：运行体只报当前选中的模型的档位）。只在登录与
 * 刷新用的一次性会话里做，只发 `session/set_config_option`，不发提示词；选不上的模型跳过（固定档位）。运行体没有档位选项
 * （1.3）时不探测。
 */
export async function probeThinkingLevels(
  setup: { configOptions?: unknown; models?: unknown },
  select: (modelId: string) => Promise<unknown>,
): Promise<AccountModels | undefined> {
  const initial = antigravityModelsFromSetup(setup);
  if (initial === undefined || antigravityThinkingOption(setup.configOptions) === undefined) {
    return initial;
  }
  const current = antigravityCurrentModel(setup.configOptions);
  const known = new Map<string, readonly string[]>();
  for (const model of initial.models) {
    if (model.id === current) continue;
    try {
      known.set(
        model.id,
        thinkingEfforts(antigravityThinkingOption(await select(model.id))?.values ?? []),
      );
    } catch {
      // 选不上（账号没有这个模型的权限等）：不写档位。
    }
  }
  return antigravityModelsFromSetup(setup, known);
}

/** 读存下的模型列表；没有或读不了时 undefined。 */
export async function loadModels(file: string): Promise<AccountModels | undefined> {
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as {
      models?: unknown;
      defaultModelId?: unknown;
    };
    if (!Array.isArray(parsed.models)) return undefined;
    const models = parsed.models.flatMap((model): ProviderModelConfig[] =>
      isRecord(model) && typeof model.id === 'string'
        ? [
            {
              id: model.id,
              ...(typeof model.displayName === 'string' && { displayName: model.displayName }),
              ...(Array.isArray(model.reasoningEfforts) &&
                model.reasoningEfforts.length > 0 &&
                model.reasoningEfforts.every((effort) => typeof effort === 'string') && {
                  reasoningEfforts: model.reasoningEfforts as string[],
                }),
            },
          ]
        : [],
    );
    return {
      models,
      ...(typeof parsed.defaultModelId === 'string' && { defaultModelId: parsed.defaultModelId }),
    };
  } catch {
    return undefined;
  }
}

/** 模型列表里各模型的推理档位（`antigravityModelsFromSetup` 的 `known`）。 */
export function knownEfforts(models: AccountModels | undefined): Map<string, readonly string[]> {
  const known = new Map<string, readonly string[]>();
  for (const model of models?.models ?? []) {
    if (model.reasoningEfforts !== undefined) known.set(model.id, model.reasoningEfforts);
  }
  return known;
}

export async function saveModels(file: string, models: AccountModels): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(models)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, file);
}

export async function clearModels(file: string): Promise<void> {
  await fsp.rm(file, { force: true });
}
