import type { ProviderModel, ProviderProfile, ProviderReasoningLevel } from './entities.js';

const FIVE: ProviderReasoningLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const FOUR: ProviderReasoningLevel[] = ['low', 'medium', 'high', 'max'];
const BUDGET: ProviderReasoningLevel[] = ['off', 'low', 'medium', 'high'];

/** Only verified model IDs and dated snapshots; relay effort suffixes may override request parameters. */
export function inferredReasoningEfforts(id: string): ProviderReasoningLevel[] | undefined {
  const model = id
    .toLowerCase()
    .replace(/^(?:anthropic[/.]|openai\/)/, '')
    .replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, '');
  if (
    /^claude-(?:opus-(?:5-5|5|4-8|4-7)|sonnet-(?:5-5|5)|haiku-5-5|fable-5-1)$/.test(model) ||
    /^(?:gpt-6(?:\.1)?-sol|gpt-6-astra)$/.test(model)
  )
    return [...FIVE];
  if (/^claude-(?:opus|sonnet)-4-6$/.test(model)) return [...FOUR];
  if (/^claude-(?:opus|sonnet|haiku)-4-5$/.test(model)) return [...BUDGET];
  if (/^(?:gpt-6\.1-terra|gpt-6-luna)$/.test(model)) return ['off', ...FIVE];
  if (/^gpt-5\.(?:2|4|5)$/.test(model)) return ['off', 'low', 'medium', 'high', 'xhigh'];
  if (model === 'gpt-5') return ['minimal', 'low', 'medium', 'high'];
  return undefined;
}

/** Resolve at use time so existing custom providers benefit without persisting inferred metadata. */
export function resolveProviderModels(
  provider: Pick<ProviderProfile, 'kind' | 'models'>,
): ProviderModel[] {
  if (provider.kind !== 'openai-compatible' && provider.kind !== 'google-vertex')
    return provider.models;
  return provider.models.map((model) => {
    if (model.reasoningEfforts !== undefined) return model;
    const reasoningEfforts = inferredReasoningEfforts(model.id);
    return reasoningEfforts === undefined ? model : { ...model, reasoningEfforts };
  });
}
