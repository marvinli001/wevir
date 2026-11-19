import { describe, expect, it } from 'vitest';
import { modelLogo } from './model-logo';

const api = { kind: 'openai-compatible' } as const;

describe('model logos', () => {
  it('uses the subscription software even for recognizable models from other vendors', () => {
    const model = { id: 'gpt-6.2-sol', vendor: 'openai' };
    expect(modelLogo({ kind: 'chatgpt' }, model)).toBe('codex');
    expect(modelLogo({ kind: 'copilot' }, model)).toBe('copilot');
    expect(modelLogo({ kind: 'zuv' }, model)).toBe('zuv');
    expect(modelLogo(api, model)).toBe('openai');
    expect(modelLogo(undefined, model)).toBeUndefined();
  });

  it('falls back to the API service when the model brand is unknown', () => {
    expect(modelLogo({ ...api, baseURL: 'https://zuv.wevir.si/v1' }, { id: 'alias' })).toBe('zuv');
  });

  it.each([
    ['anthropic/claude-opus-5-5', 'anthropic'],
    ['openai/gpt-6.1-sol', 'openai'],
    ['google/gemini-4-carbon', 'gemini'],
    ['GPT-6.2-Sol', 'openai'],
    ['copilot/claude-opus-5.5', 'anthropic'],
    ['gateway/openai/gpt-6', 'openai'],
    ['Composer-2', 'cursor'],
    ['proxy/swe-1-6-fast', 'devin'],
    ['llama-3.3-70b-versatile', 'meta'],
    ['ollama/llama3:70b', 'meta'],
    ['codestral-latest', 'mistral'],
    ['command-r-plus-08-2024', 'cohere'],
    ['us.amazon.nova-pro-v1:0', 'nova'],
    ['glm-5', 'zhipu'],
    ['o3-pro', 'openai'],
    ['us.anthropic.claude-sonnet-4-6-v1:0', 'anthropic'],
    ['copilot:gpt-6.2-sol', 'openai'],
    ['openai/claude-sonnet-4', 'anthropic'],
    ['deepseek/deepseek-v4.1-flash', 'deepseek'],
    ['xai/grok-4.7', 'xai'],
  ])('%s uses the model vendor logo', (id, logo) => {
    expect(modelLogo(api, { id })).toBe(logo);
  });

  it('prefers the declared vendor for aliases and leaves unknown brands unset', () => {
    expect(modelLogo(api, { id: 'relay/alias', vendor: 'Anthropic' })).toBe('anthropic');
    expect(modelLogo(api, { id: 'deployment-prod', displayName: 'GPT 6.2-Sol' })).toBe('openai');
    expect(modelLogo(api, { id: 'constructor' })).toBeUndefined();
    expect(modelLogo(api, { id: 'xai/grok-4.7', vendor: 'custom' })).toBe('xai');
    expect(modelLogo(api, { id: 'new-vendor/model', vendor: 'new-vendor' })).toBeUndefined();
  });
});
