import { describe, expect, it } from 'vitest';
import type { ProviderModel, ProviderProfile } from './entities.js';
import { inferredReasoningEfforts, resolveProviderModels } from './provider-models.js';

const five = ['low', 'medium', 'high', 'xhigh', 'max'];

describe('Custom provider reasoning', () => {
  it.each([
    ['claude-opus-5-5', five],
    ['claude-sonnet-5-5', five],
    ['anthropic/claude-opus-5-5-20261001', five],
    ['anthropic.claude-sonnet-4-6', ['low', 'medium', 'high', 'max']],
    ['claude-sonnet-4-5', ['off', 'low', 'medium', 'high']],
    ['gpt-6.1-sol', five],
    ['gpt-6.1-terra', ['off', ...five]],
    ['openai/gpt-5.5-2026-04-23', ['off', 'low', 'medium', 'high', 'xhigh']],
    ['gpt-5', ['minimal', 'low', 'medium', 'high']],
  ])('recognizes %s', (id, efforts) => {
    expect(inferredReasoningEfforts(id as string)).toEqual(efforts);
  });

  it.each([
    'relay-alias',
    'gpt-5.5-high',
    'claude-opus-5-5-max',
    'claude-opus-5-5-thinking',
    'claude-opus-99',
  ])('does not guess %s', (id) => {
    expect(inferredReasoningEfforts(id)).toBeUndefined();
  });

  it('preserves explicit capabilities and does not mutate stored metadata or subscription models', () => {
    const models: ProviderModel[] = [
      { id: 'claude-opus-5-5' },
      { id: 'claude-sonnet-5-5', reasoningEfforts: [] },
      { id: 'gpt-6.1-sol', reasoningEfforts: ['low', 'high'] },
    ];
    const provider = { kind: 'openai-compatible', models } as ProviderProfile;
    expect(resolveProviderModels(provider)).toEqual([
      { id: 'claude-opus-5-5', reasoningEfforts: five },
      models[1],
      models[2],
    ]);
    expect(models[0]).not.toHaveProperty('reasoningEfforts');
    expect(resolveProviderModels({ ...provider, kind: 'chatgpt' })).toBe(models);
  });
});
