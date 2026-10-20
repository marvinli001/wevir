// 首次引导与“更多”对话框里列出的模型服务（U6）：每一项对应一个新建 Provider 的方式（DeepSeek 官方、某个 OpenAI 兼容
// 模板或空白的自定义表单），带标志、去哪里取 Key。Vertex 使用服务账号，入口受 Host 的 google_vertex 功能控制。

import type { ProviderLogoId } from '@/components/provider-logo';
import type { PlainMessageKey } from '@/i18n';
import { OPENAI_PRESETS, type OpenAIPreset, VERTEX_PRESETS } from './provider-presets';

export type CatalogGroup = 'global' | 'cn' | 'local';

export interface CatalogEntry {
  id: string;
  name: PlainMessageKey;
  logo?: ProviderLogoId;
  group: CatalogGroup;
  /** 建 Provider 的方式；没有的是还没接上的服务。 */
  source?:
    | { kind: 'deepseek-official' }
    | { kind: 'preset'; preset: OpenAIPreset }
    | { kind: 'custom' };
  /** 申请 API Key 的页面，经系统浏览器打开。 */
  keyURL?: string;
}

function preset(id: string): CatalogEntry['source'] {
  const found = OPENAI_PRESETS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`unknown preset ${id}`);
  return { kind: 'preset', preset: found };
}

export const PROVIDER_CATALOG: readonly CatalogEntry[] = [
  {
    id: 'openai',
    name: 'provider.catalog.openai',
    logo: 'openai',
    group: 'global',
    source: preset('openai'),
    keyURL: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    name: 'provider.catalog.anthropic',
    logo: 'anthropic',
    group: 'global',
    source: preset('anthropic'),
    // 按量 API Key；当前只接收绑定单个 workspace 的 Key（providers.md §7.9）。
    keyURL: 'https://platform.claude.com/settings/keys',
  },
  {
    id: 'google-ai-studio',
    name: 'provider.catalog.googleAiStudio',
    logo: 'gemini',
    group: 'global',
    source: preset('gemini'),
    // 国际按量 Gemini API Key（2026-10-15 核对），地域说明与模板共用。
    keyURL: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'google-vertex',
    name: 'provider.catalog.googleVertex',
    logo: 'vertex',
    group: 'global',
    source: { kind: 'preset', preset: VERTEX_PRESETS[0] as OpenAIPreset },
    keyURL: 'https://console.cloud.google.com/vertex-ai',
  },
  {
    id: 'azure-openai',
    name: 'provider.catalog.azureOpenai',
    logo: 'azure',
    group: 'global',
    source: preset('azure-openai'),
    keyURL: 'https://ai.azure.com',
  },
  {
    id: 'azure-claude',
    name: 'provider.catalog.azureClaude',
    logo: 'azure',
    group: 'global',
    source: preset('azure-claude'),
    keyURL: 'https://ai.azure.com',
  },
  {
    id: 'xai',
    name: 'provider.catalog.xai',
    logo: 'xai',
    group: 'global',
    source: preset('xai'),
    keyURL: 'https://console.x.ai/team/default/api-keys',
  },
  {
    id: 'zai',
    name: 'provider.catalog.zai',
    logo: 'zai',
    group: 'global',
    source: preset('zai'),
    keyURL: 'https://z.ai/manage-apikey/apikey-list',
  },
  {
    id: 'deepseek',
    name: 'provider.catalog.deepseek',
    logo: 'deepseek',
    group: 'cn',
    source: { kind: 'deepseek-official' },
    keyURL: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'deepseek-openai',
    name: 'provider.preset.deepseekOpenai',
    logo: 'deepseek',
    group: 'cn',
    source: preset('deepseek-openai'),
    keyURL: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'dashscope',
    name: 'provider.catalog.dashscope',
    logo: 'qwen',
    group: 'cn',
    source: preset('dashscope'),
    // 官方获取 API Key 指南的北京入口；其他地域需在控制台切换（2026-10-15 核对）。
    keyURL: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key',
  },
  {
    id: 'kimi',
    name: 'provider.catalog.kimi',
    logo: 'kimi',
    group: 'cn',
    source: preset('kimi'),
    keyURL: 'https://platform.kimi.com/console/api-keys',
  },
  {
    id: 'zhipu',
    name: 'provider.catalog.zhipu',
    logo: 'zhipu',
    group: 'cn',
    source: preset('zhipu'),
    keyURL: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  },
  {
    id: 'mimo',
    name: 'provider.catalog.mimo',
    logo: 'mimo',
    group: 'cn',
    source: preset('mimo'),
    keyURL: 'https://platform.xiaomimimo.com/#/console/api-keys',
  },
  {
    id: 'minimax',
    name: 'provider.catalog.minimax',
    logo: 'minimax',
    group: 'cn',
    source: preset('minimax'),
    keyURL: 'https://platform.minimax.cn/user-center/basic-information/interface-key',
  },
  {
    id: 'tencent',
    name: 'provider.catalog.tencent',
    logo: 'tencent',
    group: 'cn',
    source: preset('tencent'),
    keyURL: 'https://console.cloud.tencent.com/tokenhub/apikey',
  },
  {
    id: 'ollama-cloud',
    name: 'provider.catalog.ollamaCloud',
    logo: 'ollama',
    group: 'global',
    source: preset('ollama-cloud'),
    keyURL: 'https://ollama.com/settings/keys',
  },
  {
    id: 'redpill',
    name: 'provider.catalog.redpill',
    group: 'global',
    source: preset('redpill'),
    keyURL: 'https://www.redpill.ai/dashboard',
  },
  {
    id: 'ollama',
    name: 'provider.catalog.ollama',
    logo: 'ollama',
    group: 'local',
    source: preset('local-ollama'),
  },
  { id: 'custom', name: 'provider.catalog.custom', group: 'local', source: { kind: 'custom' } },
];

/** 首次引导第一行的四个（照维护者 2026-10-14 定的顺序），其余在“更多”里。 */
export const FEATURED_PROVIDERS = ['openai', 'anthropic', 'google-ai-studio', 'google-vertex'];

export const CATALOG_GROUPS: readonly { id: CatalogGroup; label: PlainMessageKey }[] = [
  { id: 'global', label: 'provider.catalog.group.global' },
  { id: 'cn', label: 'provider.catalog.group.cn' },
  { id: 'local', label: 'provider.catalog.group.local' },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.id === id);
}

const HOST_LOGOS: [RegExp, ProviderLogoId][] = [
  [/^ollama\.com$/, 'ollama'],
  [
    /^[a-z0-9-]+\.(openai\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com)$/,
    'azure',
  ],
  [/(^|\.)openai\.com$/, 'openai'],
  [/(^|\.)anthropic\.com$/, 'anthropic'],
  [/^generativelanguage\.googleapis\.com$/, 'gemini'],
  [/(^|\.|-)aiplatform\.googleapis\.com$/, 'vertex'],
  [/(^|\.)x\.ai$/, 'xai'],
  [/(^|\.)deepseek\.com$/, 'deepseek'],
  [/^(dashscope|dashscope-intl)\.aliyuncs\.com$/, 'qwen'],
  [/(^|\.)maas\.aliyuncs\.com$/, 'qwen'],
  [/(^|\.)moonshot\.(cn|ai)$/, 'kimi'],
  [/(^|\.)z\.ai$/, 'zai'],
  [/(^|\.)bigmodel\.cn$/, 'zhipu'],
  [/(^|\.)xiaomimimo\.com$/, 'mimo'],
  [/(^|\.)(minimax\.cn|minimaxi\.com|minimax\.io)$/, 'minimax'],
  [/(^|\.)(tencentcloudmaas\.com|tencentmaas\.com|tencentcloudmaas\.tech)$/, 'tencent'],
];

/** 已有 Provider 的标志：DeepSeek 官方与 ChatGPT 按种类，其余按地址的主机名，本机 11434 端口当作 Ollama。 */
export function providerLogo(provider: {
  kind: string;
  baseURL?: string | undefined;
}): ProviderLogoId | undefined {
  if (provider.kind === 'deepseek-official') return 'deepseek';
  if (provider.kind === 'chatgpt') return 'openai';
  if (provider.kind === 'google-vertex') return 'vertex';
  if (!provider.baseURL) return undefined;
  let url: URL;
  try {
    url = new URL(provider.baseURL);
  } catch {
    return undefined;
  }
  if (url.port === '11434') return 'ollama';
  return HOST_LOGOS.find(([pattern]) => pattern.test(url.hostname))?.[1];
}

/** 新 kind 只在 Host 明确支持时开放；旧 Host 不会收到无法解析的请求。 */
export function catalogAvailable(
  entry: CatalogEntry | undefined,
  vertexAvailable: boolean,
): boolean {
  return entry?.source !== undefined && (entry.id !== 'google-vertex' || vertexAvailable);
}
