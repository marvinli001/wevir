// 新增 Provider 时的预设模板（T5.4），取自 docs/architecture/providers.md §7（2026-10 核对）。选了模板，地址、
// 协议、模型都已填好，用户只需填 Key；地址与模型 ID 以各服务当前的官方文档为准，改了文档这里一起改。

import type { ProviderApi, ProviderCompat, ProviderModel } from '@wevir/protocol';
import type { PlainMessageKey } from '@/i18n';

/** `deepseek-official` 的路由名与 Profile ID 固定（providers.md §2.1）。 */
export const DEEPSEEK_OFFICIAL_ID = 'deepseek-official';

/**
 * 不列模型时 dsh 自带的 DeepSeek 目录（`@wevir/adapter-dsh` 的 `DSH_DEEPSEEK_MODELS`，providers.md §2.2）。
 * 桌面端不能依赖适配器包，这里抄一份；dsh 升级改了目录时一起改。
 */
export const DSH_DEEPSEEK_MODELS: readonly string[] = ['deepseek-flash', 'deepseek-v4-pro'];

/** `openai-compatible` 不能用的 ID：已被 dsh 的其他适配器占用（providers.md §2.1）。 */
export const RESERVED_PROVIDER_IDS: readonly string[] = [DEEPSEEK_OFFICIAL_ID, 'deepseek-account'];

/**
 * 界面上能选的协议。`anthropic-messages` 只有 Codex 引擎（经模型网关，R10）支持，dsh 引擎拒绝（providers.md §4）；
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

export const OPENAI_PRESETS: readonly OpenAIPreset[] = [
  {
    // Sol / Astra 调工具要求 Responses，Luna 在 Chat 上只有 none 支持函数调用，统一由网关透传 Responses
    // （2026-10-15 核对，providers.md §7.8）。
    id: 'openai',
    name: 'provider.preset.openai',
    note: 'provider.preset.openai.note',
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
    // Messages 由网关转换（R10，model-gateway.md §5）；claude- 开头的模型按 adaptive 思考、档位进 output_config.effort。
    id: 'anthropic',
    name: 'provider.preset.anthropic',
    note: 'provider.preset.anthropic.note',
    api: 'anthropic-messages',
    baseURL: 'https://api.anthropic.com',
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
    docsURL: 'https://platform.claude.com/docs/en/about-claude/models/overview',
  },
  {
    id: 'dashscope',
    name: 'provider.preset.dashscope',
    note: 'provider.preset.dashscope.note',
    api: 'openai-completions',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [{ id: 'qwen-plus', contextWindow: 131072 }],
    defaultModelId: 'qwen-plus',
    docsURL: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
  },
  {
    id: 'kimi',
    name: 'provider.preset.kimi',
    note: 'provider.preset.kimi.note',
    api: 'openai-completions',
    baseURL: 'https://api.moonshot.cn/v1',
    models: [{ id: 'kimi-k2.6', contextWindow: 262144, supportsImages: true }],
    defaultModelId: 'kimi-k2.6',
    docsURL: 'https://platform.kimi.ai/docs/api/overview.md',
  },
  {
    id: 'zhipu',
    name: 'provider.preset.zhipu',
    note: 'provider.preset.zhipu.note',
    api: 'openai-completions',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: [{ id: 'glm-4.5', contextWindow: 131072 }],
    defaultModelId: 'glm-4.5',
    docsURL: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
  },
  {
    id: 'deepseek-openai',
    name: 'provider.preset.deepseekOpenai',
    api: 'openai-completions',
    baseURL: 'https://api.deepseek.com',
    models: [
      {
        id: 'deepseek-flash',
        contextWindow: 1000000,
        supportsImages: true,
        reasoningEfforts: ['off', 'low', 'high', 'max'],
      },
      { id: 'deepseek-v4-pro', contextWindow: 1000000, reasoningEfforts: ['off', 'high', 'max'] },
    ],
    defaultModelId: 'deepseek-flash',
  },
  {
    // xAI 的 Responses 是主接口（Chat 已标 Legacy），网关透传；不支持自定义工具，apply_patch 由网关摊平成函数
    // （按地址也会默认摊平，这里写明，经代理改了地址时仍然生效）。大陆不可达，要用户自己的网络环境。
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
    compat: { supportsCustomTools: false },
    docsURL: 'https://docs.x.ai/developers/models',
  },
  {
    // Gemini API 没有 Responses，网关转 Chat，走它的 OpenAI 兼容端点（ADR-0005 决策 2.3）；Gemini 3 起函数调用要带回
    // thought signature，网关按地址处理（model-gateway.md §4.5）。只用 API Key，个人订阅登录已停（codex-notes §4.2）。
    id: 'gemini',
    name: 'provider.preset.gemini',
    note: 'provider.preset.gemini.note',
    api: 'openai-completions',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    models: [
      {
        id: 'gemini-3.8-flash',
        contextWindow: 1048576,
        supportsImages: true,
        reasoningEfforts: ['low', 'medium', 'high'],
      },
      {
        id: 'gemini-4-argon',
        contextWindow: 1048576,
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
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:11434/v1',
    models: [{ id: 'qwen3:8b', contextWindow: 32768 }],
    defaultModelId: 'qwen3:8b',
    placeholderKey: 'ollama',
  },
];
