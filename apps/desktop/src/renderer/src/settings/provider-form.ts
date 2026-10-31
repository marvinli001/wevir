// Provider 表单（T5.4）：表单状态的来源（新建 DeepSeek 官方、按模板新建 OpenAI 兼容、编辑已有）、本地检查、
// 转成 provider.upsert 的参数，以及 Host 退回的 INVALID_PARAMS 落到哪个字段。纯函数，组件在 provider-editor.tsx。
//
// Key 不在 ProviderProfile 里（只有 hasSecret），表单也拿不到已存的 Key：留空表示保留已存的，填了才替换。

import {
  HttpUrlSchema,
  type MethodParams,
  PROVIDER_IMAGE_MODELS_MAX,
  PROVIDER_TRANSCRIPTION_MODELS_MAX,
  type ProviderCompat,
  ProviderIdSchema,
  type ProviderImageModel,
  type ProviderKind,
  type ProviderModel,
  type ProviderProfile,
  type ProviderReasoningLevel,
  type ProviderTranscriptionModel,
} from '@wevir/protocol';
import { t } from '@/i18n';
import {
  DEEPSEEK_DEFAULT_MODELS,
  DEEPSEEK_OFFICIAL_ID,
  DEEPSEEK_OFFICIAL_PRESET,
  FORM_APIS,
  type FormApi,
  OPENAI_PRESETS,
  type OpenAIPreset,
  RESERVED_PROVIDER_IDS,
  VERTEX_PRESETS,
} from './provider-presets';

export interface ModelRow {
  /** 行的稳定 key（React 列表用），与模型 ID 无关。 */
  key: string;
  id: string;
  /** 上下文长度（token）的输入框原文，可以留空。 */
  contextWindow: string;
  /** 收图片输入（`supportsImages`）：Codex 只给标了的模型开图片输入。 */
  images: boolean;
  /** undefined keeps the original value; null restores automatic detection. */
  reasoningEfforts?: ProviderReasoningLevel[] | null;
  /** 编辑已有 Provider 或模板带来的原模型：保存时保留表单不编辑的字段（推理档位、最大输出等）。 */
  base?: ProviderModel;
}

/**
 * 表单管的 Provider：DeepSeek 官方与 OpenAI 兼容。ChatGPT（R6）与订阅来源（0.19.0）由账号登录后 Host 自己建，没有表单。
 */
export type FormKind = Extract<
  ProviderKind,
  'deepseek-official' | 'openai-compatible' | 'google-vertex'
>;
export type EditableProvider = ProviderProfile & { kind: FormKind };

export function isEditableProvider(provider: ProviderProfile): provider is EditableProvider {
  return (
    provider.kind === 'deepseek-official' ||
    provider.kind === 'openai-compatible' ||
    provider.kind === 'google-vertex'
  );
}

export interface ProviderForm {
  kind: FormKind;
  /** 编辑已有的 Provider：ID 与类型不可改（providers.md §2.1）。 */
  editing: boolean;
  /** 已存了 Key（编辑时）。 */
  hasSecret: boolean;
  id: string;
  displayName: string;
  api: FormApi;
  /** `deepseek-official` 可以留空（用官方地址）。 */
  baseURL: string;
  /** Editing: binds discovery's stored credential to the unchanged saved endpoint. */
  savedBaseURL?: string;
  /**
   * `openai-compatible`：表单编辑的模型列表，默认模型是 `defaultIndex` 那一行。`deepseek-official`：已列出的
   * 模型（新建时显式列出，旧 Profile 可能为空），原样保留、不在表单里编辑。
   */
  models: ModelRow[];
  defaultIndex: number;
  /** `deepseek-official` 的默认模型。 */
  defaultModelId: string;
  /** 原样保留（模板或已有 Provider 的 compat），表单不编辑。 */
  compat?: ProviderCompat;
  apiKey: string;
  vertex?: { project: string; location?: string };
  serviceAccountJson?: string;
  /** 新建时选的模板，界面据此显示说明与文档链接。 */
  preset?: OpenAIPreset;
  /** `openai-compatible` 的转写模型（0.92.0）：逗号分隔的模型 ID，听写设置里可选。 */
  transcriptionModels: string;
  /** 已存的转写模型：保存时同 ID 的保留显示名称。 */
  savedTranscriptionModels?: readonly ProviderTranscriptionModel[];
  /** `openai-compatible` 的图片模型（0.139.0）：逗号分隔的模型 ID，第一个是生图工具的默认模型。 */
  imageModels: string;
  /** 已存的图片模型：保存时同 ID 的保留显示名称。 */
  savedImageModels?: readonly ProviderImageModel[];
}

let rowSeq = 0;

export function modelRow(model?: ProviderModel): ModelRow {
  rowSeq += 1;
  return {
    key: `row-${rowSeq}`,
    id: model?.id ?? '',
    contextWindow: model?.contextWindow?.toString() ?? '',
    images: model?.supportsImages === true,
    ...(model && { base: model }),
  };
}

export function modelReasoningEfforts(row: ModelRow): ProviderReasoningLevel[] | undefined {
  if (row.reasoningEfforts !== undefined) return row.reasoningEfforts ?? undefined;
  return row.base && (row.base.id === row.id.trim() || hasProviderPlaceholder(row.base.id))
    ? row.base.reasoningEfforts
    : undefined;
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
    models: DEEPSEEK_OFFICIAL_PRESET.models.map(modelRow),
    defaultIndex: 0,
    defaultModelId: DEEPSEEK_OFFICIAL_PRESET.defaultModelId,
    apiKey: '',
    preset: DEEPSEEK_OFFICIAL_PRESET,
    transcriptionModels: '',
    imageModels: '',
  };
}

/** 按模板新建 OpenAI 兼容 Provider；不选模板时是空白表单。建议的 ID 与已有的重复时加 `-2`、`-3`。 */
export function newOpenAIForm(preset: OpenAIPreset | undefined, takenIds: string[]): ProviderForm {
  const models = preset?.models.map(modelRow) ?? [modelRow()];
  return {
    kind: preset?.kind ?? 'openai-compatible',
    ...(preset?.kind === 'google-vertex' && { vertex: { project: '', location: 'global' } }),
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
    ...(preset?.compat && { compat: { ...preset.compat } }),
    ...(preset && { preset }),
    transcriptionModels: '',
    imageModels: preset?.imageModels?.join(', ') ?? '',
  };
}

export function editForm(provider: EditableProvider): ProviderForm {
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
    savedBaseURL: provider.baseURL ?? '',
    models: provider.kind === 'openai-compatible' && models.length === 0 ? [modelRow()] : models,
    defaultIndex: Math.max(
      0,
      provider.models.findIndex((m) => m.id === provider.defaultModelId),
    ),
    defaultModelId: provider.defaultModelId,
    ...(provider.compat && { compat: provider.compat }),
    ...(provider.vertex && { vertex: { ...provider.vertex } }),
    apiKey: '',
    transcriptionModels: (provider.transcriptionModels ?? []).map((model) => model.id).join(', '),
    ...(provider.transcriptionModels && {
      savedTranscriptionModels: provider.transcriptionModels,
    }),
    imageModels: (provider.imageModels ?? []).map((model) => model.id).join(', '),
    ...(provider.imageModels && { savedImageModels: provider.imageModels }),
  };
}

function uniqueId(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** 转写模型与图片模型输入框里的 ID：逗号或换行分隔，去掉空的与重复的。 */
export function transcriptionIds(text: string): string[] {
  return [...new Set(text.split(/[,，\n]/u).map((id) => id.trim()))].filter((id) => id !== '');
}

/** `deepseek-official` 默认模型的可选项：列了自定义模型就是它们，否则是默认模型（providers.md §2.2）。 */
export function deepseekModelChoices(form: ProviderForm): string[] {
  return form.models.length > 0 ? form.models.map((row) => row.id) : [...DEEPSEEK_DEFAULT_MODELS];
}

/**
 * 字段错误，key 与 Host 的 INVALID_PARAMS `issues[].path` 用点连起来的写法一致（`baseURL`、`models.0.id`），
 * 这样本地检查与 Host 的检查落到同一个位置。
 */
export type FormErrors = Record<string, string>;

/** 模板里的尖括号或花括号占位；URL 编码不应绕过检查。供设置页与首次引导共用。 */
export function hasProviderPlaceholder(value: string): boolean {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // 非法百分号仍检查原文，URL 的其他错误由 baseURLProblem 处理。
  }
  return /<[^<>]+>|\{[^{}]+\}/.test(decoded);
}

/** 选模板后立即标出待填项，保存时使用同一条校验。 */
export function placeholderError(value: string): string | undefined {
  return hasProviderPlaceholder(value) ? t('provider.form.error.placeholder') : undefined;
}

export function validateForm(form: ProviderForm, takenIds: string[]): FormErrors {
  const errors: FormErrors = {};
  if (form.displayName.trim() === '') errors.displayName = t('provider.form.error.required');

  if (form.kind !== 'deepseek-official' && !form.editing) {
    const id = form.id.trim();
    if (id === '') errors.id = t('provider.form.error.required');
    else if (!ProviderIdSchema.safeParse(id).success) errors.id = t('provider.form.error.idFormat');
    else if (RESERVED_PROVIDER_IDS.includes(id))
      errors.id = t('provider.form.error.idReserved', { id });
    else if (takenIds.includes(id)) errors.id = t('provider.form.error.idTaken', { id });
  }

  const baseURL = form.baseURL.trim();
  if (form.kind === 'google-vertex') {
    if (!/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,32})$/.test(form.vertex?.project.trim() ?? ''))
      errors['vertex.project'] = t('provider.vertex.projectInvalid');
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(form.vertex?.location?.trim() || 'global'))
      errors['vertex.location'] = t('provider.vertex.locationInvalid');
    if (form.serviceAccountJson?.trim() && !serviceAccountEmail(form.serviceAccountJson))
      errors.serviceAccountJson = t('provider.vertex.accountInvalid');
  } else if (baseURL === '') {
    if (form.kind === 'openai-compatible') errors.baseURL = t('provider.form.error.required');
  } else {
    const problem = baseURLProblem(baseURL);
    if (problem) errors.baseURL = problem;
  }

  if (form.kind !== 'deepseek-official') {
    const seen = new Set<string>();
    form.models.forEach((row, index) => {
      const id = row.id.trim();
      if (id === '') errors[`models.${index}.id`] = t('provider.form.error.required');
      else if (hasProviderPlaceholder(id))
        errors[`models.${index}.id`] = t('provider.form.error.placeholder');
      else if (
        form.kind === 'google-vertex' &&
        !(
          form.api === 'openai-completions'
            ? /^google\/gemini-[a-z0-9][a-z0-9.-]*$/
            : /^claude-[a-z0-9][a-z0-9.-]*(?:@[0-9]{8})?$/
        ).test(id)
      )
        errors[`models.${index}.id`] = t('provider.vertex.modelInvalid');
      else if (seen.has(id)) errors[`models.${index}.id`] = t('provider.form.error.modelDuplicate');
      seen.add(id);
      if (row.contextWindow.trim() !== '' && parseContextWindow(row.contextWindow) === undefined) {
        errors[`models.${index}.contextWindow`] = t('provider.form.error.contextWindow');
      }
    });
    if (form.models.length === 0) errors.models = t('provider.form.error.noModels');
    const transcription = transcriptionIds(form.transcriptionModels);
    if (transcription.some(hasProviderPlaceholder))
      errors.transcriptionModels = t('provider.form.error.placeholder');
    else if (transcription.some((id) => id.length > 200 || /\s/.test(id)))
      errors.transcriptionModels = t('provider.form.error.transcriptionModels');
    else if (transcription.length > PROVIDER_TRANSCRIPTION_MODELS_MAX)
      errors.transcriptionModels = t('provider.form.error.transcriptionLimit', {
        count: PROVIDER_TRANSCRIPTION_MODELS_MAX,
      });
    const images = transcriptionIds(form.imageModels);
    if (images.some(hasProviderPlaceholder))
      errors.imageModels = t('provider.form.error.placeholder');
    else if (images.some((id) => id.length > 200 || /\s/.test(id)))
      errors.imageModels = t('provider.form.error.transcriptionModels');
    else if (images.length > PROVIDER_IMAGE_MODELS_MAX)
      errors.imageModels = t('provider.form.error.imageLimit', {
        count: PROVIDER_IMAGE_MODELS_MAX,
      });
  } else if (!deepseekModelChoices(form).includes(form.defaultModelId)) {
    errors.defaultModelId = t('provider.form.error.required');
  }
  return errors;
}

function baseURLProblem(value: string): string | undefined {
  if (hasProviderPlaceholder(value)) return t('provider.form.error.placeholder');
  if (!HttpUrlSchema.safeParse(value).success) return t('provider.form.error.url');
  const url = new URL(value);
  // 地址会原样写进配置文件（providers.md §2.2），凭据要单独填在 Key 里。
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return t('provider.form.error.urlExtras');
  }
  return undefined;
}

/**
 * 模型没填上下文长度时 Codex 引擎按这个大小处理（adapter-codex 的 `DEFAULT_CONTEXT_WINDOW`，桌面端不能依赖适配器包，
 * 这里抄一份；那边改了一起改）。表单在没填的模型下面提示它。
 */
export const ASSUMED_CONTEXT_WINDOW = 128_000;

/** 模型行的上下文长度空着：表单提示按 `ASSUMED_CONTEXT_WINDOW` 估算。 */
export function contextWindowMissing(row: Pick<ModelRow, 'contextWindow'>): boolean {
  return row.contextWindow.trim() === '';
}

function parseContextWindow(text: string): number | undefined {
  const value = Number(text.trim());
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

/**
 * 保存后要不要重测连接：新建的，或者改了影响连接的字段（Key、地址、协议、默认模型；provider.test 只用
 * 默认模型）。只改显示名称、增删其他模型时不再发请求，沿用上一次的结果。
 */
export function connectionChanged(initial: ProviderForm, form: ProviderForm): boolean {
  if (!initial.editing) return true;
  return (
    form.apiKey.trim() !== '' ||
    (form.serviceAccountJson?.trim() ?? '') !== '' ||
    form.vertex?.project.trim() !== initial.vertex?.project.trim() ||
    (form.vertex?.location?.trim() || 'global') !==
      (initial.vertex?.location?.trim() || 'global') ||
    form.baseURL.trim() !== initial.baseURL.trim() ||
    (form.kind !== 'deepseek-official' && form.api !== initial.api) ||
    form.compat?.thinkingFormat !== initial.compat?.thinkingFormat ||
    defaultModelOf(form) !== defaultModelOf(initial)
  );
}

function defaultModelOf(form: ProviderForm): string {
  return form.kind !== 'deepseek-official'
    ? (form.models[form.defaultIndex]?.id.trim() ?? '')
    : form.defaultModelId;
}

/** 表单 → provider.upsert 的参数（先过 validateForm）。Key 留空时不带 `apiKey`，Host 保留已存的 Key。 */
export function toUpsertParams(
  form: ProviderForm,
): Exclude<MethodParams<'provider.upsert'>, { kind: 'chatgpt' }> {
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
    // 填部署名占位不改变这一行的模型能力；其他模型改 ID 时不再沿用原模型设置。图片输入按勾选。
    const {
      contextWindow: _previous,
      supportsImages: marked,
      reasoningEfforts: _previousEfforts,
      ...rest
    } = row.base && (row.base.id === id || hasProviderPlaceholder(row.base.id)) ? row.base : { id };
    const contextWindow =
      row.contextWindow.trim() === '' ? undefined : parseContextWindow(row.contextWindow);
    // 没勾选时，原模型标过的写 false，没标过的照旧不写。
    const supportsImages = row.images ? true : marked !== undefined ? false : undefined;
    const declaredEfforts = modelReasoningEfforts(row);
    const known = declaredEfforts === undefined ? presetModel(form, id) : undefined;
    const reasoningEfforts =
      declaredEfforts ?? (row.reasoningEfforts === null ? undefined : known?.reasoningEfforts);
    return {
      ...rest,
      id,
      ...(reasoningEfforts !== undefined && { reasoningEfforts }),
      ...(rest.maxTokens === undefined &&
        known?.maxTokens !== undefined && { maxTokens: known.maxTokens }),
      ...(contextWindow !== undefined && { contextWindow }),
      ...(supportsImages !== undefined && { supportsImages }),
    };
  });
  if (form.kind === 'google-vertex')
    return {
      id: form.id.trim(),
      kind: 'google-vertex',
      displayName: common.displayName,
      api: form.api,
      vertex: {
        project: form.vertex?.project.trim() ?? '',
        location: form.vertex?.location?.trim() || 'global',
      },
      models,
      defaultModelId: models[form.defaultIndex]?.id ?? models[0]?.id ?? '',
      ...(form.compat && { compat: form.compat }),
      ...(form.serviceAccountJson?.trim() && {
        serviceAccountJson: form.serviceAccountJson.trim(),
      }),
    };
  return {
    ...common,
    id: form.id.trim(),
    kind: 'openai-compatible',
    api: form.api,
    baseURL,
    models,
    defaultModelId: models[form.defaultIndex]?.id ?? models[0]?.id ?? '',
    ...(form.compat && { compat: form.compat }),
    // 总是带上：空列表清掉已存的。
    transcriptionModels: transcriptionIds(form.transcriptionModels).map(
      (id) => form.savedTranscriptionModels?.find((model) => model.id === id) ?? { id },
    ),
    imageModels: transcriptionIds(form.imageModels).map(
      (id) => form.savedImageModels?.find((model) => model.id === id) ?? { id },
    ),
  };
}

/** 同地址模板里的同名模型；模板地址的尖括号占位匹配任意一段。Vertex 的地址由网关生成，按协议找。 */
function presetModel(form: ProviderForm, id: string): ProviderModel | undefined {
  const presets =
    form.kind === 'google-vertex'
      ? VERTEX_PRESETS.filter((preset) => preset.api === form.api)
      : [DEEPSEEK_OFFICIAL_PRESET, ...OPENAI_PRESETS].filter((preset) =>
          sameAddress(preset.baseURL, form.baseURL),
        );
  for (const preset of presets) {
    const model = preset.models.find((m) => m.id === id);
    if (model) return model;
  }
  return undefined;
}

function sameAddress(template: string, value: string): boolean {
  const normalize = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();
  if (template === '' || value.trim() === '') return false;
  const pattern = normalize(template)
    .split(/<[^<>]+>/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/.]+');
  return new RegExp(`^${pattern}$`).test(normalize(value));
}

/** 只显示账号邮箱；输入与错误中都不回显 JSON 或私钥。 */
export function serviceAccountEmail(json: string): string | undefined {
  try {
    const value = JSON.parse(json);
    if (
      json.length <= 64 * 1024 &&
      value?.type === 'service_account' &&
      typeof value.client_email === 'string' &&
      /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$/.test(value.client_email) &&
      typeof value.private_key === 'string' &&
      value.private_key.includes('-----BEGIN PRIVATE KEY-----')
    )
      return value.client_email;
  } catch {
    /* 表单显示固定的错误文案。 */
  }
  return undefined;
}
