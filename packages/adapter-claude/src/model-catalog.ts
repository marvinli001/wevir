// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/provider/ClaudeModelCatalog.ts、ClaudeModelManifest.ts，apps/server/src/claudeModelOptions.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写成不依赖 `effect` 的普通 TS；输出 Wevir 的 `ProviderModelConfig`（档位只留 Wevir 认识的值），去掉自定义模型、ultracode / ultrathink / fastMode 与 T3 的选项描述。
//
// Claude 的模型目录（claude-event-mapping.md §3）：随包清单 model-manifest.ts → Wevir 的 `ProviderModelConfig`。照 T3：
// 按装的 `claude` 版本过滤（`minVersion`），档位的 Wevir 值经 profile 的 `effortMap` 换成 Claude Code 的值，上下文窗口取
// `fixedContextWindowTokens` 或默认的 `contextWindow` 选项（带 `[1m]` 后缀的模型 ID 也照它）。T3 的 ultracode、
// ultrathink 与 fastMode 不在 Wevir 的档位里，不提供。

import type { AccountModels, ProviderModelConfig } from '@wevir/runtime-adapter';
import { CLAUDE_MODEL_MANIFEST } from './model-manifest.js';

/** Wevir 的推理档位（protocol `ProviderReasoningLevel`），按从低到高。 */
const WEVIR_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

interface OptionDescriptor {
  readonly id: string;
  readonly type: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly isDefault?: boolean }>;
}

interface Profile {
  readonly capabilities?: { readonly optionDescriptors: readonly OptionDescriptor[] };
  readonly adapter?: {
    readonly claudeCode?: {
      readonly effortMap?: Readonly<Record<string, string | null>>;
      readonly modelSuffixes?: Readonly<Record<string, Readonly<Record<string, string>>>>;
      readonly contextWindowTokens?: Readonly<Record<string, number>>;
      readonly fixedContextWindowTokens?: number;
    };
  };
}

interface ManifestModel {
  readonly slug: string;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly status: string;
  readonly profile?: string;
  readonly adapter?: {
    readonly claudeCode?: { readonly minVersion?: string; readonly maxVersionExclusive?: string };
  };
}

const PROFILES = CLAUDE_MODEL_MANIFEST.profiles as unknown as Readonly<Record<string, Profile>>;
const MODELS = CLAUDE_MODEL_MANIFEST.models as unknown as readonly ManifestModel[];

/** 清单里标的默认模型（T3 的 `defaults.chat`）。 */
export const DEFAULT_CLAUDE_MODEL = CLAUDE_MODEL_MANIFEST.defaults.chat;

/** 装的 `claude` 至少要这个版本（清单的 `compatibility`，T3 标 `unsupported` 的范围以下）。 */
export const MIN_CLAUDE_VERSION = '2.1.111';

/** 按 slug 或别名找模型（不分大小写的别名，同 T3 的 `resolveClaudeCatalogModel`）。 */
function findModel(slugOrAlias: string): ManifestModel | undefined {
  const value = slugOrAlias.trim();
  if (value === '') return undefined;
  const lower = value.toLowerCase();
  return (
    MODELS.find((model) => model.slug === value) ??
    MODELS.find((model) => model.aliases?.some((alias) => alias.toLowerCase() === lower))
  );
}

function profileOf(model: ManifestModel | undefined): Profile | undefined {
  return model?.profile === undefined ? undefined : PROFILES[model.profile];
}

function descriptor(profile: Profile | undefined, id: string): OptionDescriptor | undefined {
  return profile?.capabilities?.optionDescriptors.find((candidate) => candidate.id === id);
}

function defaultOption(profile: Profile | undefined, id: string): string | undefined {
  return descriptor(profile, id)?.options?.find((option) => option.isDefault === true)?.id;
}

/** 比较两个 `x.y.z` 版本；认不出的部分当 0。 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) =>
    value
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 这个 `claude` 版本能不能用这个模型（T3 的 `isVersionSupported`）；版本不知道时只放行没有版本要求的。 */
function supportedBy(model: ManifestModel, version: string | undefined): boolean {
  const compat = model.adapter?.claudeCode;
  if (compat?.minVersion === undefined && compat?.maxVersionExclusive === undefined) return true;
  if (version === undefined) return false;
  if (compat.minVersion !== undefined && compareVersions(version, compat.minVersion) < 0) {
    return false;
  }
  return !(
    compat.maxVersionExclusive !== undefined &&
    compareVersions(version, compat.maxVersionExclusive) >= 0
  );
}

/** 模型的 Wevir 推理档位：profile 的 effort 选项里 Wevir 认识的值。 */
function wevirEfforts(profile: Profile | undefined): string[] | undefined {
  const options = descriptor(profile, 'effort')?.options;
  if (options === undefined) return undefined;
  return options
    .map((option) => option.id)
    .filter((id) => (WEVIR_EFFORTS as readonly string[]).includes(id));
}

/** 模型的上下文窗口（T3 的 `resolveClaudeCatalogContextWindowTokens`，用默认的 contextWindow 选项）。 */
export function claudeContextWindow(slugOrAlias: string): number | undefined {
  const profile = profileOf(findModel(slugOrAlias));
  const runtime = profile?.adapter?.claudeCode;
  if (runtime?.fixedContextWindowTokens !== undefined) return runtime.fixedContextWindowTokens;
  const window = defaultOption(profile, 'contextWindow');
  return window === undefined ? undefined : runtime?.contextWindowTokens?.[window];
}

function toProviderModel(model: ManifestModel): ProviderModelConfig {
  const profile = profileOf(model);
  const efforts = wevirEfforts(profile);
  const contextWindow = claudeContextWindow(model.slug);
  return {
    id: model.slug,
    displayName: model.name,
    supportsImages: true,
    ...(contextWindow !== undefined && { contextWindow }),
    ...(efforts !== undefined && { reasoningEfforts: efforts }),
  };
}

/**
 * 这个版本的 `claude` 能用的模型（`EngineAccounts.models`）：current 的在前、legacy 的在后，各自保持清单的顺序；默认模型
 * 是清单的默认值，用不了时取第一个。
 */
export function claudeModels(version: string | undefined): AccountModels {
  const usable = MODELS.filter((model) => supportedBy(model, version));
  const ordered = [
    ...usable.filter((model) => model.status === 'current'),
    ...usable.filter((model) => model.status !== 'current'),
  ];
  const models = ordered.map(toProviderModel);
  const first = models[0];
  if (first === undefined) return { models };
  const defaultModelId = models.some((model) => model.id === DEFAULT_CLAUDE_MODEL)
    ? DEFAULT_CLAUDE_MODEL
    : first.id;
  return { models, defaultModelId };
}

/**
 * 交给 Claude Code 的模型 ID（T3 的 `resolveClaudeCatalogApiModelId`）：别名换成 slug；默认的 contextWindow 选项有后缀时
 * 带上（如 `claude-opus-4-6[1m]`）。清单里没有的原样交出去，由 `claude` 决定认不认。
 */
export function claudeApiModelId(slugOrAlias: string): string {
  const model = findModel(slugOrAlias);
  if (model === undefined) return slugOrAlias;
  const profile = profileOf(model);
  for (const [optionId, suffixes] of Object.entries(
    profile?.adapter?.claudeCode?.modelSuffixes ?? {},
  )) {
    const value = defaultOption(profile, optionId);
    const suffix = value === undefined ? undefined : suffixes[value];
    if (suffix !== undefined) return `${model.slug}${suffix}`;
  }
  return model.slug;
}

/** Claude Code 认的档位（SDK 的 `EffortLevel`）。 */
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const CLAUDE_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Wevir 的档位 → 交给 Claude Code 的档位（T3 的 `normalizeClaudeCatalogEffort`）：经 profile 的 `effortMap` 换算（如 Opus
 * 4.7 的 xhigh 跑成 max、Sonnet 4.6 的 max 跑成 high），映射成 null 的不传；Claude Code 不认的值（off、minimal）不传，
 * 用模型的默认档位。
 */
export function claudeEffort(
  slugOrAlias: string,
  effort: string | undefined,
): ClaudeEffort | undefined {
  if (effort === undefined) return undefined;
  const effortMap = profileOf(findModel(slugOrAlias))?.adapter?.claudeCode?.effortMap;
  const mapped =
    effortMap !== undefined && Object.hasOwn(effortMap, effort) ? effortMap[effort] : effort;
  return mapped !== null && mapped !== undefined && CLAUDE_EFFORTS.includes(mapped)
    ? (mapped as ClaudeEffort)
    : undefined;
}

/** 模型最低的一档（生成标题用，同 adapter-codex 的 `lowestEffort`）。 */
export function lowestClaudeEffort(slugOrAlias: string): ClaudeEffort | undefined {
  const efforts = wevirEfforts(profileOf(findModel(slugOrAlias))) ?? [];
  const lowest = WEVIR_EFFORTS.find((level) => efforts.includes(level));
  return claudeEffort(slugOrAlias, lowest);
}

/** 显示名（不认识的模型原样）。 */
export function claudeModelName(slugOrAlias: string): string {
  return findModel(slugOrAlias)?.name ?? slugOrAlias;
}

/** 规范化成清单里的 slug（别名、带后缀的 ID 都认）；不认识的原样。 */
export function canonicalClaudeModel(model: string): string {
  const trimmed = model.trim().replace(/\[[^\]]*\]$/, '');
  return findModel(trimmed)?.slug ?? model;
}
