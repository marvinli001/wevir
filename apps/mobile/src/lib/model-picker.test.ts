import type { ProviderProfile, SessionId } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  configureParams,
  effectiveEffort,
  effectiveFast,
  effortLabel,
  modelOf,
  sessionChoice,
  stepAt,
  withModel,
} from './model-picker';
import { resolveChoice } from './new-session';

const provider = {
  id: 'codex',
  kind: 'chatgpt',
  displayName: 'Codex',
  defaultModelId: 'astra',
  hasSecret: false,
  models: [
    {
      id: 'astra',
      displayName: '6.2 Astra',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      defaultReasoningEffort: 'medium',
      supportsFast: true,
    },
    { id: 'sol', reasoningEfforts: ['low', 'high'], supportsFast: true, fastByDefault: true },
    { id: 'plain', reasoningEfforts: [] },
  ],
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
} as unknown as ProviderProfile;

const SESSION = 'ses_1' as SessionId;

describe('model picker', () => {
  it('names efforts and falls back to the raw level', () => {
    expect(effortLabel('high')).not.toBe('high');
    expect(effortLabel('turbo')).toBe('turbo');
  });

  it('shows the model default effort and speed when none is chosen', () => {
    const choice = { providerId: 'codex', modelId: 'astra' };
    expect(effectiveEffort(choice, modelOf(provider, choice))).toBe('medium');
    expect(effectiveFast(choice, modelOf(provider, choice))).toBe(false);
    const sol = { providerId: 'codex', modelId: 'sol' };
    expect(effectiveFast(sol, modelOf(provider, sol))).toBe(true);
    const plain = { providerId: 'codex', modelId: 'plain', fast: true };
    expect(effectiveFast(plain, modelOf(provider, plain))).toBe(false);
  });

  it('maps a finger position to a step, clamped to the ends', () => {
    expect(stepAt(-10, 200, 4)).toBe(0);
    expect(stepAt(10, 200, 4)).toBe(0);
    expect(stepAt(60, 200, 4)).toBe(1);
    expect(stepAt(199, 200, 4)).toBe(3);
    expect(stepAt(400, 200, 4)).toBe(3);
    expect(stepAt(10, 0, 4)).toBe(0);
  });

  it('keeps effort and fast mode across models only where the new model has them', () => {
    const choice = { providerId: 'codex', modelId: 'astra', reasoningEffort: 'high', fast: true };
    expect(withModel(provider, choice, 'sol')).toEqual({
      providerId: 'codex',
      modelId: 'sol',
      reasoningEffort: 'high',
      fast: true,
    });
    expect(withModel(provider, { ...choice, reasoningEffort: 'xhigh' }, 'sol')).toEqual({
      providerId: 'codex',
      modelId: 'sol',
      fast: true,
    });
    expect(withModel(provider, choice, 'plain')).toEqual({ providerId: 'codex', modelId: 'plain' });
  });

  it('remembers fast mode only for models that support it', () => {
    expect(
      resolveChoice([provider], { providerId: 'codex', modelId: 'astra', fast: true }),
    ).toEqual({ providerId: 'codex', modelId: 'astra', fast: true });
    expect(
      resolveChoice([provider], { providerId: 'codex', modelId: 'plain', fast: true }),
    ).toEqual({ providerId: 'codex', modelId: 'plain' });
  });

  it('sends only what changed to session.configure', () => {
    const current = sessionChoice({
      providerId: 'codex',
      modelId: 'astra',
      reasoningEffort: 'low',
    });
    expect(configureParams(SESSION, current, current)).toBeUndefined();
    expect(configureParams(SESSION, current, { ...current, reasoningEffort: 'high' })).toEqual({
      sessionId: SESSION,
      reasoningEffort: 'high',
    });
    expect(configureParams(SESSION, current, { providerId: 'codex', modelId: 'sol' })).toEqual({
      sessionId: SESSION,
      modelId: 'sol',
      reasoningEffort: null,
    });
    expect(configureParams(SESSION, current, { ...current, fast: true })).toEqual({
      sessionId: SESSION,
      fast: true,
    });
    expect(
      configureParams(SESSION, { ...current, fast: true }, { ...current, fast: false }),
    ).toEqual({ sessionId: SESSION, fast: false });
  });
});
