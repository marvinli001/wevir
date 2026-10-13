// Provider 表单（T5.4）：表单状态的来源（新建 DeepSeek 官方、按模板新建 OpenAI 兼容、编辑已有）、本地检查、
// 转成 provider.upsert 的参数，以及 Host 退回的 INVALID_PARAMS 落到哪个字段。纯函数，组件在 provider-editor.tsx。
//
// Key 不在 ProviderProfile 里（只有 hasSecret），表单也拿不到已存的 Key：留空表示保留已存的，填了才替换。

import {
  HttpUrlSchema,
  type MethodParams,
  type ProviderCompat,
  ProviderIdSchema,
  type ProviderKind,
  type ProviderModel,
  type ProviderProfile,
} from '@wevir/protocol';
import { t } from '@/i18n';
import {
  DEEPSEEK_OFFICIAL_ID,
  DSH_DEEPSEEK_MODELS,
  FORM_APIS,
  type FormApi,
  type OpenAIPreset,
  RESERVED_PROVIDER_IDS,
} from './provider-presets';

export interface ModelRow {
  /** 行的稳定 key（React 列表用），与模型 ID 无关。 */
  key: string;
  id: string;
  /** 上下文长度（token）的输入框原文，可以留空。 */
  contextWindow: string;
  /** 编辑已有 Provider 或模板带来的原模型：保存时保留表单不编辑的字段（图片、推理档位、最大输出等）。 */
  base?: ProviderModel;
}

export interface ProviderForm {
  kind: ProviderKind;
  /** 编辑已有的 Provider：ID 与类型不可改（providers.md §2.1）。 */
  editing: boolean;
  /** 已存了 Key（编辑时）。 */
  hasSecret: boolean;
  id: string;
  displayName: string;
  api: FormApi;
  /** `deepseek-official` 可以留空（用官方地址）。 */
  baseURL: string;
  /**
   * `openai-compatible`：表单编辑的模型列表，默认模型是 `defaultIndex` 那一行。`deepseek-official`：已列出的
   * 自定义模型（通常为空，用 dsh 自带目录），原样保留、不在表单里编辑。
   */
  models: ModelRow[];
  defaultIndex: number;
  /** `deepseek-official` 的默认模型。 */
  defaultModelId: string;
  /** 原样保留（模板或已有 Provider 的 compat），表单不编辑。 */
  compat?: ProviderCompat;
  apiKey: string;
  /** 新建时选的模板，界面据此显示说明与文档链接。 */
  preset?: OpenAIPreset;
}

let rowSeq = 0;

export function modelRow(model?: ProviderModel): ModelRow {
  rowSeq += 1;
  return {
    key: `row-${rowSeq}`,
    id: model?.id ?? '',
    contextWindow: model?.contextWindow?.toString() ?? '',
    ...(model && { base: model }),
  };
}

export function newDeepSeekForm(): ProviderForm {
  return {
    kind: 'deepseek-official',
    editing: false,
    hasSecret: false,
    id: DEEPSEEK_OFFICIAL_ID,
    displayName: 'DeepSeek',
    api: 'openai-completions',
    baseURL: '',
    models: [],
    defaultIndex: 0,
    defaultModelId: DSH_DEEPSEEK_MODELS[0] ?? '',
    apiKey: '',
  };
}

/** 按模板新建 OpenAI 兼容 Provider；不选模板时是空白表单。建议的 ID 与已有的重复时加 `-2`、`-3`。 */
export function newOpenAIForm(preset: OpenAIPreset | undefined, takenIds: string[]): ProviderForm {
  const models = preset?.models.map(modelRow) ?? [modelRow()];
  return {
    kind: 'openai-compatible',
    editing: false,
    hasSecret: false,
    id: preset ? uniqueId(preset.id, takenIds) : '',
    displayName: preset ? t(preset.name) : '',
    api: preset?.api ?? 'openai-completions',
    baseURL: preset?.baseURL ?? '',
    models,
    defaultIndex: Math.max(0, preset?.models.findIndex((m) => m.id === preset.defaultModelId) ?? 0),
    defaultModelId: '',
    apiKey: preset?.placeholderKey ?? '',
    ...(preset && { preset }),
  };
}

export function editForm(provider: ProviderProfile): ProviderForm {
  const models = provider.models.map(modelRow);
  const api = (FORM_APIS as readonly string[]).includes(provider.api ?? '')
    ? (provider.api as FormApi)
    : 'openai-completions';
  return {
    kind: provider.kind,
    editing: true,
    hasSecret: provider.hasSecret,
    id: provider.id,
    displayName: provider.displayName,
    api,
    baseURL: provider.baseURL ?? '',
    models: provider.kind === 'openai-compatible' && models.length === 0 ? [modelRow()] : models,
    defaultIndex: Math.max(
      0,
      provider.models.findIndex((m) => m.id === provider.defaultModelId),
    ),
    defaultModelId: provider.defaultModelId,
    ...(provider.compat && { compat: provider.compat }),
    apiKey: '',
  };
}

function uniqueId(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** `deepseek-official` 默认模型的可选项：列了自定义模型就是它们，否则是 dsh 自带目录（providers.md §2.2）。 */
export function deepseekModelChoices(form: ProviderForm): string[] {
  return form.models.length > 0 ? form.models.map((row) => row.id) : [...DSH_DEEPSEEK_MODELS];
}

/**
 * 字段错误，key 与 Host 的 INVALID_PARAMS `issues[].path` 用点连起来的写法一致（`baseURL`、`models.0.id`），
 * 这样本地检查与 Host 的检查落到同一个位置。
 */
export type FormErrors = Record<string, string>;

export function validateForm(form: ProviderForm, takenIds: string[]): FormErrors {
  const errors: FormErrors = {};
  if (form.displayName.trim() === '') errors.displayName = t('provider.form.error.required');

  if (form.kind === 'openai-compatible' && !form.editing) {
    const id = form.id.trim();
    if (id === '') errors.id = t('provider.form.error.required');
    else if (!ProviderIdSchema.safeParse(id).success) errors.id = t('provider.form.error.idFormat');
    else if (RESERVED_PROVIDER_IDS.includes(id))
      errors.id = t('provider.form.error.idReserved', { id });
    else if (takenIds.includes(id)) errors.id = t('provider.form.error.idTaken', { id });
  }

  const baseURL = form.baseURL.trim();
  if (baseURL === '') {
    if (form.kind === 'openai-compatible') errors.baseURL = t('provider.form.error.required');
  } else {
    const problem = baseURLProblem(baseURL);
    if (problem) errors.baseURL = problem;
  }

  if (form.kind === 'openai-compatible') {
    const seen = new Set<string>();
    form.models.forEach((row, index) => {
      const id = row.id.trim();
      if (id === '') errors[`models.${index}.id`] = t('provider.form.error.required');
      else if (seen.has(id)) errors[`models.${index}.id`] = t('provider.form.error.modelDuplicate');
      seen.add(id);
      if (row.contextWindow.trim() !== '' && parseContextWindow(row.contextWindow) === undefined) {
        errors[`models.${index}.contextWindow`] = t('provider.form.error.contextWindow');
      }
    });
    if (form.models.length === 0) errors.models = t('provider.form.error.noModels');
  } else if (!deepseekModelChoices(form).includes(form.defaultModelId)) {
    errors.defaultModelId = t('provider.form.error.required');
  }
  return errors;
}

function baseURLProblem(value: string): string | undefined {
  if (!HttpUrlSchema.safeParse(value).success) return t('provider.form.error.url');
  const url = new URL(value);
  // 地址会原样写进 dsh 的配置文件（providers.md §2.2），凭据要单独填在 Key 里。
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return t('provider.form.error.urlExtras');
  }
  return undefined;
}

function parseContextWindow(text: string): number | undefined {
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** 表单 → provider.upsert 的参数（先过 validateForm）。Key 留空时不带 `apiKey`，Host 保留已存的 Key。 */
export function toUpsertParams(form: ProviderForm): MethodParams<'provider.upsert'> {
  const apiKey = form.apiKey.trim();
  const common = {
    displayName: form.displayName.trim(),
    ...(apiKey !== '' && { apiKey }),
  };
  const baseURL = form.baseURL.trim();
  if (form.kind === 'deepseek-official') {
    return {
      ...common,
      id: DEEPSEEK_OFFICIAL_ID,
      kind: 'deepseek-official',
      models: form.models.flatMap((row) => (row.base ? [row.base] : [])),
      defaultModelId: form.defaultModelId,
      ...(baseURL !== '' && { baseURL }),
    };
  }
  const models = form.models.map((row): ProviderModel => {
    const id = row.id.trim();
    // 改了模型 ID 就是另一个模型，原模型的图片、推理档位等设置不再沿用。
    const { contextWindow: _previous, ...rest } = row.base?.id === id ? row.base : { id };
    const contextWindow =
      row.contextWindow.trim() === '' ? undefined : parseContextWindow(row.contextWindow);
    return { ...rest, id, ...(contextWindow !== undefined && { contextWindow }) };
  });
  return {
    ...common,
    id: form.id.trim(),
    kind: 'openai-compatible',
    api: form.api,
    baseURL,
    models,
    defaultModelId: models[form.defaultIndex]?.id ?? models[0]?.id ?? '',
    ...(form.compat && { compat: form.compat }),
  };
}
