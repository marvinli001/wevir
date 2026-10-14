// 首次引导与“更多”对话框里列出的模型服务（U6）：每一项对应一个新建 Provider 的方式（DeepSeek 官方、某个 OpenAI 兼容
// 模板或空白的自定义表单），带标志、去哪里取 Key。还没接上的服务（Google Vertex AI）列出来、标“即将支持”，不能选。

import type { ProviderLogoId } from '@/components/provider-logo';
import type { PlainMessageKey } from '@/i18n';
import { OPENAI_PRESETS, type OpenAIPreset } from './provider-presets';

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
    keyURL: 'https://platform.claude.com/settings/keys',
  },
  {
    id: 'google-ai-studio',
    name: 'provider.catalog.googleAiStudio',
    logo: 'gemini',
    group: 'global',
    source: preset('gemini'),
    keyURL: 'https://aistudio.google.com/apikey',
  },
  { id: 'google-vertex', name: 'provider.catalog.googleVertex', logo: 'vertex', group: 'global' },
  {
    id: 'xai',
    name: 'provider.catalog.xai',
    logo: 'xai',
    group: 'global',
    source: preset('xai'),
    keyURL: 'https://console.x.ai/',
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
    id: 'dashscope',
    name: 'provider.catalog.dashscope',
    logo: 'qwen',
    group: 'cn',
    source: preset('dashscope'),
    keyURL: 'https://bailian.console.aliyun.com/',
  },
  {
    id: 'kimi',
    name: 'provider.catalog.kimi',
    logo: 'kimi',
    group: 'cn',
    source: preset('kimi'),
    keyURL: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'zhipu',
    name: 'provider.catalog.zhipu',
    logo: 'zhipu',
    group: 'cn',
    source: preset('zhipu'),
    keyURL: 'https://open.bigmodel.cn/usercenter/apikeys',
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
