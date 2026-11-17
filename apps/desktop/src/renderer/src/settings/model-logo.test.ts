import { describe, expect, it } from 'vitest';
import { modelLogo } from './model-logo';

describe('ZUV model brands', () => {
  it.each([
    ['anthropic/claude-opus-5-5', 'anthropic'],
    ['openai/gpt-6.1-sol', 'openai'],
    ['google/gemini-4-carbon', 'gemini'],
    ['deepseek/deepseek-v4.1-flash', 'deepseek'],
    ['xai/grok-4.7', 'xai'],
  ])('%s uses the model vendor logo', (id, logo) => {
    expect(modelLogo({ id })).toBe(logo);
  });

  it('prefers the declared vendor for aliases and leaves unknown brands unset', () => {
    expect(modelLogo({ id: 'relay/alias', vendor: 'Anthropic' })).toBe('anthropic');
    expect(modelLogo({ id: 'xai/grok-4.7', vendor: 'custom' })).toBe('xai');
    expect(modelLogo({ id: 'new-vendor/model', vendor: 'new-vendor' })).toBeUndefined();
  });
});
