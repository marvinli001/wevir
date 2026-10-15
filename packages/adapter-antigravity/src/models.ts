// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/provider/AntigravityProvider.ts（buildAntigravityModelsFromSession）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：产出 Wevir 的 AccountModels（模型 ID 用原生值、含思考档位，没有单独的推理档位）；另存一份到数据目录
// （models.json，只有模型 ID 与名字），Host 重启后不必为了模型列表启动运行体。
//
// Antigravity 的模型列表只来自 ACP 会话的 `configOptions`（“model” 选项）：登录完成、显式刷新与每次建会话时更新
// （docs/architecture/antigravity-event-mapping.md §6）。

import * as fsp from 'node:fs/promises';
import path from 'node:path';
import type { AccountModels, ProviderModelConfig } from '@wevir/runtime-adapter';

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

/**
 * `session/new` / `session/resume` 的结果（或 `config_option_update`）→ 模型列表。认 `id: "model"` 或
 * `category: "model"` 的 select 选项；没有时退回 ACP 的 `models`（availableModels）。当前值是默认模型。没有模型选项时返回
 * undefined（不覆盖已有的列表）。
 */
export function antigravityModelsFromSetup(setup: {
  configOptions?: unknown;
  models?: unknown;
}): AccountModels | undefined {
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
  const seen = new Set<string>();
  const models: ProviderModelConfig[] = [];
  for (const entry of entries) {
    if (!entry.value.trim() || seen.has(entry.value)) continue;
    seen.add(entry.value);
    models.push({ id: entry.value, displayName: entry.name.trim() ? entry.name : entry.value });
  }
  if (models.length === 0) return { models: [] };
  const defaultModelId =
    current !== undefined && seen.has(current) ? current : (models[0] as ProviderModelConfig).id;
  return { models, defaultModelId };
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

export async function saveModels(file: string, models: AccountModels): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(models)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, file);
}

export async function clearModels(file: string): Promise<void> {
  await fsp.rm(file, { force: true });
}
