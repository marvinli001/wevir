// 新增 Provider 时的预设模板（T5.4），取自 docs/architecture/providers.md §7（2026-10 核对）。选了模板，地址、
// 协议、模型的初始值已填好；尖括号中的占位必须替换。地址与模型 ID 以官方文档为准，改了文档这里一起改。

import type { ProviderApi, ProviderCompat, ProviderModel } from '@wevir/protocol';
import type { PlainMessageKey } from '@/i18n';

/** `deepseek-official` 的路由名与 Profile ID 固定（providers.md §2.1）。 */
export const DEEPSEEK_OFFICIAL_ID = 'deepseek-official';

/** DeepSeek 官方 Provider 不列模型时的默认模型（providers.md §2.2）；DeepSeek 换了模型名时一起改。 */
export const DEEPSEEK_DEFAULT_MODELS: readonly string[] = ['deepseek-flash', 'deepseek-v4-pro'];

/** `openai-compatible` 不能用的 ID：已被 DeepSeek 官方 Provider 占用（providers.md §2.1）。 */
export const RESERVED_PROVIDER_IDS: readonly string[] = [DEEPSEEK_OFFICIAL_ID, 'deepseek-account'];

/**
 * 界面上能选的协议。`anthropic-messages` 只有 Codex 引擎（经模型网关，R10）支持（providers.md §4）；
 * U6 起 Codex 是默认引擎，表单里也能选。
 */
export const FORM_APIS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
] as const satisfies ProviderApi[];
export type FormApi = (typeof FORM_APIS)[number];

export interface OpenAIPreset {
  /** 模板名，也是新建时建议的 Provider ID。 */
  id: string;
  kind?: 'google-vertex';
  name: PlainMessageKey;
  /** 选模板时必须知道的事（地址的地域、套餐差别、能否直连等）；没有就不写。 */
  note?: PlainMessageKey;
  api: FormApi;
  baseURL: string;
  models: ProviderModel[];
  defaultModelId: string;
  /** 本机服务不校验 Key（providers.md §3），预先填一个任意值。 */
  placeholderKey?: string;
  /** 协议 ProviderCompat 的方言开关（含 namespace / toolChoice，model-gateway.md §3.2），新建时原样带进 Provider。 */
  compat?: ProviderCompat;
  /** 官方文档（providers.md §7 的来源），经系统浏览器打开。 */
  docsURL?: string;
}

/** OpenAI 与 Anthropic 模板共用的五档推理；支持关闭的模型另加 off。 */
const FIVE_EFFORTS: ProviderModel['reasoningEfforts'] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** 两站标准 API 共用的 GLM 目录（2026-10-17 核对，providers.md §7.4）；maxTokens 不改变透传预算。 */
const GLM_MODELS: ProviderModel[] = [
  {
    id: 'glm-5.3',
    contextWindow: 1048576,
    maxTokens: 131072,
    reasoningEfforts: ['low', 'high', 'max'],
  },
  {
    id: 'glm-5.3-flash',
    contextWindow: 1048576,
    maxTokens: 131072,
    supportsImages: true,
    reasoningEfforts: ['low', 'high', 'max'],
  },
];

/** Codex 官方接入指南的目录（2026-10-16）；新建时显式保存，已有 Profile 不套用。 */
export const DEEPSEEK_OFFICIAL_PRESET: OpenAIPreset = {
  id: DEEPSEEK_OFFICIAL_ID,
  name: 'provider.catalog.deepseek',
  api: 'openai-responses',
  baseURL: 'https://api.deepseek.com',
  models: [
    {
      id: 'deepseek-flash',
      contextWindow: 1048576,
      supportsImages: true,
      reasoningEfforts: ['off', 'low', 'high', 'max'],
    },
    {
      id: 'deepseek-v4-pro',
      contextWindow: 1048576,
      reasoningEfforts: ['off', 'low', 'high', 'max'],
    },
  ],
  defaultModelId: 'deepseek-flash',
  docsURL: 'https://api-docs.deepseek.com/quick_start/agent_integrations/codex',
};

export const OPENAI_PRESETS: readonly OpenAIPreset[] = [
  {
    // Sol / Astra 调工具要求 Responses，Luna 在 Chat 上只有 none 支持函数调用，统一由网关透传 Responses
    // （2026-10-15 核对，providers.md §7.8）。
    id: 'openai',
    name: 'provider.preset.openai',
    api: 'openai-responses',
    baseURL: 'https://api.openai.com/v1',
    models: [
      {
        id: 'gpt-6.1-sol',
        contextWindow: 1050000,
        maxTokens: 128000,
        supportsImages: true,
        reasoningEfforts: FIVE_EFFORTS,
      },
      {
        id: 'gpt-6-astra',
        contextWindow: 1050000,
        maxTokens: 128000,
        supportsImages: true,
        reasoningEfforts: FIVE_EFFORTS,
      },
      {
        id: 'gpt-6-luna',
        contextWindow: 1050000,
        maxTokens: 128000,
        supportsImages: true,
        reasoningEfforts: ['off', ...FIVE_EFFORTS],
      },
    ],
    defaultModelId: 'gpt-6.1-sol',
    docsURL: 'https://developers.openai.com/api/docs/models',
  },
  {
    // 官方按量 Messages API（2026-10-15 核对，providers.md §7.9）。显式声明格式与中途 system 的模式，代理同样生效。
    id: 'anthropic',
    name: 'provider.preset.anthropic',
    api: 'anthropic-messages',
    baseURL: 'https://api.anthropic.com',
    compat: { thinkingFormat: 'adaptive', systemMessageMode: 'inline' },
    models: [
      {
        id: 'claude-opus-5-5',
        contextWindow: 1000000,
        maxTokens: 128000,
        supportsImages: true,
        reasoningEfforts: FIVE_EFFORTS,
      },
      {
        id: 'claude-sonnet-5-5',
        contextWindow: 1000000,
        maxTokens: 128000,
        supportsImages: true,
        reasoningEfforts: FIVE_EFFORTS,
      },
      {
        id: 'claude-haiku-5-5',
        contextWindow: 1000000,
        maxTokens: 128000,
        supportsImages: true,
        reasoningEfforts: FIVE_EFFORTS,
      },
      {
        id: 'claude-fable-5-1',
        contextWindow: 1000000,
        maxTokens: 128000,
        supportsImages: true,
        reasoningEfforts: FIVE_EFFORTS,
      },
    ],
    defaultModelId: 'claude-opus-5-5',
    docsURL: 'https://platform.claude.com/docs/en/models/overview',
  },
  {
    // Azure 的 model 是部署名；占位替换后仍保留这一行的能力声明（providers.md §7.12）。
    id: 'azure-openai',
    name: 'provider.catalog.azureOpenai',
    note: 'provider.preset.azureOpenai.note',
    api: 'openai-responses',
    baseURL: 'https://<resource>.openai.azure.com/openai/v1',
    models: [
      {
        id: '<gpt-6.1-sol-deployment>',
        displayName: 'GPT-6.1 Sol',
        contextWindow: 1050000,
        maxTokens: 128000,
        supportsImages: true,
        reasoningEfforts: FIVE_EFFORTS,
      },
      {
        id: '<gpt-6-astra-deployment>',
        displayName: 'GPT-6 Astra',
        contextWindow: 1050000,
        maxTokens: 128000,
        supportsImages: true,
        reasoningEfforts: FIVE_EFFORTS,
      },
      {
        id: '<gpt-6-luna-deployment>',
        displayName: 'GPT-6 Luna',
        contextWindow: 1050000,
        maxTokens: 128000,
        supportsImages: true,
        reasoningEfforts: ['off', ...FIVE_EFFORTS],
      },
    ],
    defaultModelId: '<gpt-6.1-sol-deployment>',
    docsURL: 'https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/codex',
  },
  {
    id: 'azure-claude',
    name: 'provider.catalog.azureClaude',
    note: 'provider.preset.azureClaude.note',
    api: 'anthropic-messages',
    baseURL: 'https://<resource>.services.ai.azure.com/anthropic',
    compat: { thinkingFormat: 'adaptive', systemMessageMode: 'inline' },
    models: ['sonnet', 'opus', 'haiku'].map((family) => ({
      id: `<claude-${family}-5-5-deployment>`,
      displayName: `Claude ${family[0]?.toUpperCase()}${family.slice(1)} 5.5`,
      contextWindow: 1000000,
      maxTokens: 128000,
      supportsImages: true,
      reasoningEfforts: FIVE_EFFORTS,
    })),
    defaultModelId: '<claude-sonnet-5-5-deployment>',
    docsURL:
      'https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude',
  },
  {
    // 百炼按量 Responses（2026-10-15 核对，providers.md §7.2）；工具支持待真实 Key 验证，显式保留保守默认供代理使用。
    id: 'dashscope',
    name: 'provider.preset.dashscope',
    api: 'openai-responses',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    compat: {
      supportsCustomTools: false,
      supportsNamespaceTools: false,
      toolChoice: 'auto_only',
    },
    models: [
      {
        id: 'qwen3.8-max',
        contextWindow: 1000000,
        supportsImages: true,
        reasoningEfforts: ['off', 'low', 'medium', 'xhigh'],
      },
      {
        id: 'qwen3.8-flash',
        contextWindow: 1000000,
        reasoningEfforts: ['off', 'low', 'medium', 'xhigh'],
      },
      {
        id: 'qwen3.7-plus',
        contextWindow: 1000000,
        supportsImages: true,
        reasoningEfforts: ['off', 'low', 'medium', 'high', 'xhigh'],
      },
    ],
    defaultModelId: 'qwen3.8-max',
    docsURL: 'https://help.aliyun.com/zh/model-studio/codex',
  },
  {
    // 官方 Responses 当前只支持 K3（2026-10-17 核对，providers.md §7.3）。
    id: 'kimi',
    name: 'provider.preset.kimi',
    note: 'provider.preset.kimi.note',
    api: 'openai-responses',
    baseURL: 'https://api.moonshot.cn/v1',
    compat: { toolChoice: 'auto_only' },
    models: [
      {
        id: 'kimi-k3',
        contextWindow: 1048576,
        maxTokens: 1048576,
        supportsImages: true,
        reasoningEfforts: ['low', 'high', 'max'],
      },
    ],
    defaultModelId: 'kimi-k3',
    docsURL: 'https://platform.kimi.com/docs/guide/codex-kimi.md',
  },
  {
    // Codex 指南确认 freeform apply_patch；namespace 未实测，先保守摊平（providers.md §7.4）。
    id: 'zai',
    name: 'provider.preset.zai',
    note: 'provider.preset.zai.note',
    api: 'openai-responses',
    baseURL: 'https://api.z.ai/api/v1',
    compat: { supportsCustomTools: true, supportsNamespaceTools: false, toolChoice: 'auto_only' },
    models: GLM_MODELS,
    defaultModelId: 'glm-5.3',
    docsURL: 'https://docs.z.ai/devpack/tool/codex',
  },
  {
    id: 'zhipu',
    name: 'provider.preset.zhipu',
    note: 'provider.preset.zhipu.note',
    api: 'openai-responses',
    baseURL: 'https://open.bigmodel.cn/api/v1',
    compat: { supportsCustomTools: true, supportsNamespaceTools: false, toolChoice: 'auto_only' },
    models: GLM_MODELS,
    defaultModelId: 'glm-5.3',
    docsURL: 'https://docs.bigmodel.cn/cn/coding-plan/tool/codex',
  },
  {
    // 普通 Responses 不支持 custom；不启用厂商目录的 Lite，namespace 待实测（providers.md §7.14）。
    id: 'mimo',
    name: 'provider.catalog.mimo',
    note: 'provider.preset.mimo.note',
    api: 'openai-responses',
    baseURL: 'https://api.xiaomimimo.com/v1',
    compat: { supportsCustomTools: false, supportsNamespaceTools: false, toolChoice: 'auto_only' },
    models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'].map((id) => ({
      id,
      contextWindow: 1048576,
      maxTokens: 131072,
      supportsImages: true,
      reasoningEfforts: ['off', 'high'],
    })),
    defaultModelId: 'mimo-v2.6-pro',
    docsURL: 'https://mimo.mi.com/docs/en-US/tokenplan/integration/codex-configuration',
  },
  {
    // Responses 只认函数工具与 auto；namespace 待实测，保守摊平。M3.1 窗口照官方 Codex 指南，M3 的 effort 只开关思考（providers.md §7.15）。
    id: 'minimax',
    name: 'provider.catalog.minimax',
    note: 'provider.preset.minimax.note',
    api: 'openai-responses',
    baseURL: 'https://api.minimax.cn/v1',
    compat: { supportsCustomTools: false, supportsNamespaceTools: false, toolChoice: 'auto_only' },
    models: [
      {
        id: 'MiniMax-M3.1-Flash',
        contextWindow: 524288,
        supportsImages: true,
        reasoningEfforts: FIVE_EFFORTS,
      },
      {
        id: 'MiniMax-M3',
        contextWindow: 1000000,
        supportsImages: true,
        reasoningEfforts: ['off', 'high'],
      },
    ],
    defaultModelId: 'MiniMax-M3.1-Flash',
    docsURL: 'https://platform.minimax.cn/docs/api-reference/responses-create',
  },
  {
    // TokenHub 广州按量 Responses；namespace 待实测，保守摊平（providers.md §7.16）。
    id: 'tencent',
    name: 'provider.catalog.tencent',
    note: 'provider.preset.tencent.note',
    api: 'openai-responses',
    baseURL: 'https://tokenhub.tencentcloudmaas.com/v1',
    compat: { supportsCustomTools: false, supportsNamespaceTools: false, toolChoice: 'auto_only' },
    models: [
      {
        id: 'hy3',
        contextWindow: 262144,
        maxTokens: 131072,
        reasoningEfforts: ['off', 'low', 'high'],
      },
      {
        id: 'hy4-preview',
        contextWindow: 1000000,
        maxTokens: 64000,
        reasoningEfforts: ['off', 'high'],
      },
      {
        id: 'deepseek-v4-pro',
        contextWindow: 1000000,
        maxTokens: 384000,
        reasoningEfforts: ['off', 'low', 'high', 'max'],
      },
      {
        id: 'glm-5.3',
        contextWindow: 1000000,
        maxTokens: 128000,
        reasoningEfforts: ['low', 'high', 'max'],
      },
      {
        id: 'kimi-k3',
        contextWindow: 1000000,
        maxTokens: 1048576,
        supportsImages: true,
        reasoningEfforts: ['low', 'high', 'max'],
      },
    ],
    defaultModelId: 'hy3',
    docsURL: 'https://intl.cloud.tencent.com/zh/document/product/1300/82454',
  },
  {
    // 按量 Responses；custom 按厂商 Codex 指南暂保留，namespace 保守摊平（providers.md §7.17）。
    id: 'stepfun',
    name: 'provider.catalog.stepfun',
    note: 'provider.preset.stepfun.note',
    api: 'openai-responses',
    baseURL: 'https://api.stepfun.com/v1',
    compat: { supportsCustomTools: true, supportsNamespaceTools: false, toolChoice: 'auto_only' },
    models: [
      {
        id: 'step-5-preview',
        contextWindow: 1000000,
        maxTokens: 64000,
        supportsImages: true,
        reasoningEfforts: ['low', 'medium', 'high'],
      },
      {
        id: 'step-3.7-flash',
        contextWindow: 256000,
        supportsImages: true,
        reasoningEfforts: ['low', 'medium', 'high'],
      },
    ],
    defaultModelId: 'step-5-preview',
    docsURL: 'https://platform.stepfun.com/docs/zh/api-reference/responses/responses-create.md',
  },
  {
    id: 'deepseek-openai',
    name: 'provider.preset.deepseekOpenai',
    api: 'openai-completions',
    baseURL: 'https://api.deepseek.com',
    models: DEEPSEEK_OFFICIAL_PRESET.models,
    defaultModelId: DEEPSEEK_OFFICIAL_PRESET.defaultModelId,
    compat: {
      thinkingFormat: 'deepseek',
      requiresReasoningContentOnAssistantMessages: true,
      toolChoice: 'auto_only',
    },
    docsURL: 'https://api-docs.deepseek.com/guides/thinking_mode',
  },
  {
    // SpaceXAI（原 xAI）的按量 Responses；工具兼容值显式保存，改成代理地址后也保留（providers.md §7.6）。
    id: 'xai',
    name: 'provider.preset.xai',
    note: 'provider.preset.xai.note',
    api: 'openai-responses',
    baseURL: 'https://api.x.ai/v1',
    models: [
      {
        id: 'grok-4.7',
        contextWindow: 500000,
        supportsImages: true,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      },
      { id: 'grok-build-0.1', contextWindow: 256000 },
    ],
    defaultModelId: 'grok-4.7',
    compat: { supportsCustomTools: false, supportsNamespaceTools: false },
    docsURL: 'https://docs.x.ai/developers/models',
  },
  {
    // Google 国际按量 API（2026-10-15 核对）：Responses 转 Chat，thought signature 按地址带回（§4.5）。
    // Schema 限制未实测，geminiToolSchema 保持默认关闭；API Key 不按前缀校验。
    id: 'gemini',
    name: 'provider.preset.gemini',
    api: 'openai-completions',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    models: [
      {
        id: 'gemini-3.8-flash',
        contextWindow: 1048576,
        maxTokens: 65536,
        supportsImages: true,
        reasoningEfforts: ['low', 'medium', 'high'],
      },
      {
        id: 'gemini-3.1-pro-preview',
        contextWindow: 1048576,
        maxTokens: 65536,
        supportsImages: true,
        reasoningEfforts: ['low', 'medium', 'high'],
      },
      {
        id: 'gemini-4-argon',
        contextWindow: 1048576,
        maxTokens: 65536,
        supportsImages: true,
        reasoningEfforts: ['low', 'medium', 'high'],
      },
    ],
    defaultModelId: 'gemini-3.8-flash',
    docsURL: 'https://ai.google.dev/gemini-api/docs/openai',
  },
  {
    id: 'local-ollama',
    name: 'provider.preset.ollama',
    note: 'provider.preset.ollama.note',
    api: 'openai-responses',
    baseURL: 'http://127.0.0.1:11434/v1',
    models: [],
    defaultModelId: '',
    placeholderKey: 'ollama',
    compat: { supportsCustomTools: false, toolChoice: 'auto_only' },
    docsURL: 'https://docs.ollama.com/integrations/codex',
  },
  {
    // 公开 /v1/models（2026-10-17）：只列声明 tools 的主力编码模型；未给逐模型推理枚举，暂不列力度。
    id: 'redpill',
    name: 'provider.catalog.redpill',
    api: 'openai-responses',
    baseURL: 'https://api.redpill.ai/v1',
    models: [
      { id: 'openai/gpt-5.5', contextWindow: 1050000, maxTokens: 128000, supportsImages: true },
      {
        id: 'anthropic/claude-opus-4.8',
        contextWindow: 1000000,
        maxTokens: 128000,
        supportsImages: true,
      },
      { id: 'z-ai/glm-5.3', contextWindow: 1048576, maxTokens: 1048576 },
    ],
    defaultModelId: 'openai/gpt-5.5',
    compat: { supportsCustomTools: false, supportsNamespaceTools: false, toolChoice: 'auto_only' },
    docsURL: 'https://docs.redpill.ai/guides/integrations/coding-tools/codex-cli',
  },
  {
    id: 'ollama-cloud',
    name: 'provider.preset.ollamaCloud',
    api: 'openai-responses',
    baseURL: 'https://ollama.com/v1',
    models: [],
    defaultModelId: '',
    compat: { supportsCustomTools: false, supportsNamespaceTools: false, toolChoice: 'auto_only' },
    docsURL: 'https://docs.ollama.com/cloud',
  },
];

/** Vertex 的两种模型分别建 Provider；地址由网关根据 project / location 生成。 */
export const VERTEX_PRESETS: readonly OpenAIPreset[] = [
  {
    id: 'google-vertex',
    kind: 'google-vertex',
    name: 'provider.catalog.googleVertex',
    api: 'openai-completions',
    baseURL: '',
    models: [
      {
        id: 'google/gemini-3.8-flash',
        contextWindow: 1048576,
        maxTokens: 65536,
        supportsImages: true,
        reasoningEfforts: ['low', 'medium', 'high'],
      },
    ],
    defaultModelId: 'google/gemini-3.8-flash',
    docsURL: 'https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/openai',
  },
  {
    id: 'google-vertex-claude',
    kind: 'google-vertex',
    name: 'provider.catalog.googleVertex',
    api: 'anthropic-messages',
    baseURL: '',
    compat: { thinkingFormat: 'adaptive', systemMessageMode: 'inline' },
    models: ['claude-sonnet-5-5', 'claude-opus-5-5'].map((id) => ({
      id,
      contextWindow: 1000000,
      maxTokens: 128000,
      supportsImages: true,
      reasoningEfforts: FIVE_EFFORTS,
    })),
    defaultModelId: 'claude-sonnet-5-5',
    docsURL: 'https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai',
  },
];
