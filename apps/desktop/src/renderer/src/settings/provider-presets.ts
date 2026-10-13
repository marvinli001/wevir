// 新增 Provider 时的预设模板（T5.4），取自 docs/architecture/providers.md §7（2026-10 核对）。选了模板，地址、
// 协议、模型都已填好，用户只需填 Key；地址与模型 ID 以各服务当前的官方文档为准，改了文档这里一起改。

import type { ProviderApi, ProviderModel } from '@wevir/protocol';
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

/** 界面上能选的协议；`anthropic-messages` 只预留了类型，适配器拒绝（providers.md §4）。 */
export const FORM_APIS = [
  'openai-completions',
  'openai-responses',
] as const satisfies ProviderApi[];
export type FormApi = (typeof FORM_APIS)[number];

export interface OpenAIPreset {
  /** 模板名，也是新建时建议的 Provider ID。 */
  id: string;
  name: PlainMessageKey;
  /** 选模板时的一句说明（地址的地域、套餐差别等）。 */
  note: PlainMessageKey;
  api: FormApi;
  baseURL: string;
  models: ProviderModel[];
  defaultModelId: string;
  /** 本机服务不校验 Key（providers.md §3），预先填一个任意值。 */
  placeholderKey?: string;
  /** 官方文档（providers.md §7 的来源），经系统浏览器打开。 */
  docsURL?: string;
}

export const OPENAI_PRESETS: readonly OpenAIPreset[] = [
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
    note: 'provider.preset.deepseekOpenai.note',
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
