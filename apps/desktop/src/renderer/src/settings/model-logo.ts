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
  xiaomimimo: 'mimo',
  tencent: 'tencent',
  bytedance: 'volcengine',
  volcengine: 'volcengine',
  cursor: 'cursor',
  meta: 'meta',
  'meta-llama': 'meta',
  mistral: 'mistral',
  mistralai: 'mistral',
  cohere: 'cohere',
  cohereforai: 'cohere',
};

const FAMILIES: readonly [RegExp, ProviderLogoId][] = [
  [/^(?:gpt|chatgpt|codex|o[1-9])(?:[ ._:\d-]|$)/, 'openai'],
  [/^(?:claude|opus|sonnet|haiku)(?:[ ._:-]|$)/, 'anthropic'],
  [/^(?:gemini|gemma)(?:[ ._:-]|$)/, 'gemini'],
  [/^grok(?:[ ._:-]|$)/, 'xai'],
  [/^deepseek/, 'deepseek'],
  [/^(?:qwen|qwq|qvq)/, 'qwen'],
  [/^(?:kimi|moonshot)/, 'kimi'],
  [/^(?:glm|chatglm)/, 'zhipu'],
  [/^minimax/, 'minimax'],
  [/^mimo/, 'mimo'],
  [/^step(?:[ ._:-]|$)/, 'stepfun'],
  [/^(?:hunyuan|hy3)/, 'tencent'],
  [/^(?:doubao|seedance|seedream|seed-)/, 'volcengine'],
  [/^(?:composer|cursor)(?:[ ._:-]|$)/, 'cursor'],
  [/^swe(?:[ ._:-]|$)/, 'devin'],
  [/^(?:meta-)?llama(?:[ ._:\d-]|$)/, 'meta'],
  [/^(?:mistral|mixtral|ministral|codestral|devstral|magistral|pixtral|voxtral)/, 'mistral'],
  [/^(?:command-[ar](?:[ ._:+-]|$)|c4ai-aya|aya-expanse|aya-vision)/, 'cohere'],
  [/^nova(?:[ ._:-]|$)/, 'nova'],
];

export function modelLogo(
  model: Pick<ProviderModel, 'id' | 'vendor' | 'displayName'>,
): ProviderLogoId | undefined {
  const parts = model.id.trim().toLowerCase().split('/');
  const id = parts.at(-1) ?? '';
  // Bedrock 的地区前缀和路由别名，如 us.anthropic.claude-…、copilot:gpt-…。
  const names = id.split(/[.:]/);
  const family = (value: string) => FAMILIES.find(([pattern]) => pattern.test(value))?.[1];
  const vendor = (key: string) => (Object.hasOwn(VENDORS, key) ? VENDORS[key] : undefined);
  return (
    family(id) ??
    names.map(family).find(Boolean) ??
    vendor(model.vendor?.trim().toLowerCase() ?? '') ??
    family(model.displayName?.trim().toLowerCase() ?? '') ??
    [...parts, ...names].reverse().map(vendor).find(Boolean)
  );
}
