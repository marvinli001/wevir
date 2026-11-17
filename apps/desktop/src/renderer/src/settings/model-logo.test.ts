import { describe, expect, it } from 'vitest';
import { modelLogo } from './model-logo';

describe('ZUV model brands', () => {
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
    expect(modelLogo({ id })).toBe(logo);
  });

  it('prefers the declared vendor for aliases and leaves unknown brands unset', () => {
    expect(modelLogo({ id: 'relay/alias', vendor: 'Anthropic' })).toBe('anthropic');
    expect(modelLogo({ id: 'deployment-prod', displayName: 'GPT 6.2-Sol' })).toBe('openai');
    expect(modelLogo({ id: 'constructor' })).toBeUndefined();
    expect(modelLogo({ id: 'xai/grok-4.7', vendor: 'custom' })).toBe('xai');
    expect(modelLogo({ id: 'new-vendor/model', vendor: 'new-vendor' })).toBeUndefined();
  });
});
