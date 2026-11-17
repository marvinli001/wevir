import type { ProviderModel } from '@wevir/protocol';
import type { ProviderLogoId } from '@/components/provider-logo';

const VENDORS: Record<string, ProviderLogoId> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'gemini',
  gemini: 'gemini',
  deepseek: 'deepseek',
  xai: 'xai',
  'x-ai': 'xai',
  alibaba: 'qwen',
  qwen: 'qwen',
  moonshot: 'kimi',
  moonshotai: 'kimi',
  minimax: 'minimax',
  zhipu: 'zhipu',
  zhipuai: 'zhipu',
  zai: 'zai',
  'z-ai': 'zai',
  stepfun: 'stepfun',
  xiaomi: 'mimo',
};

export function modelLogo(model: Pick<ProviderModel, 'id' | 'vendor'>): ProviderLogoId | undefined {
  return (
    VENDORS[model.vendor?.toLowerCase() ?? ''] ??
    VENDORS[model.id.split('/')[0]?.toLowerCase() ?? '']
  );
}
