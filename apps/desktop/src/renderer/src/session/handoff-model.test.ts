import type { EngineFeatures, ProviderProfile, Session } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { canHandoffTo, engineFeaturesOf, modelLabel } from './handoff-model';

function provider(id: string, kind: ProviderProfile['kind'], extra: Partial<ProviderProfile> = {}) {
  return {
    id,
    kind,
    displayName: id,
    models: [{ id: 'm', displayName: 'Model M' }],
    defaultModelId: 'm',
    hasSecret: false,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    ...extra,
  } satisfies ProviderProfile;
}

const api = provider('mock', 'openai-compatible', { displayName: 'Mock API' });
const claude = provider('claude', 'claude', { displayName: 'Claude' });
const features: Record<string, EngineFeatures> = {
  'openai-compatible': { engine: 'codex', additionalRoots: true, fork: true },
  claude: { engine: 'claude', additionalRoots: true },
  cursor: { engine: 'cursor' },
};
const session: Pick<
  Session,
  'providerId' | 'extraRoots' | 'state' | 'side' | 'parentSessionId' | 'readOnly'
> = { providerId: 'mock', state: 'idle' };

describe('接力的纯逻辑（0.25.0）', () => {
  it('engineFeaturesOf：按会话当前 Provider 的种类查；旧 Host 或认不出的 Provider 没有', () => {
    expect(engineFeaturesOf(features, [api, claude], 'claude')).toEqual(features.claude);
    expect(engineFeaturesOf(undefined, [api], 'mock')).toBeUndefined();
    expect(engineFeaturesOf(features, [api], 'gone')).toBeUndefined();
  });

  it('canHandoffTo：顶层、可写、空闲的会话能换到别的来源；同一个 Provider 不算', () => {
    expect(canHandoffTo(claude, session, features)).toBe(true);
    expect(canHandoffTo(api, session, features)).toBe(false);
    expect(canHandoffTo(claude, { ...session, state: 'running' }, features)).toBe(false);
    expect(canHandoffTo(claude, { ...session, state: 'error' }, features)).toBe(true);
    expect(canHandoffTo(claude, { ...session, side: true }, features)).toBe(false);
    expect(
      canHandoffTo(
        claude,
        { ...session, parentSessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' },
        features,
      ),
    ).toBe(false);
    expect(
      canHandoffTo(
        claude,
        { ...session, readOnly: { reason: 'engine_session_not_found', message: '', since: '' } },
        features,
      ),
    ).toBe(false);
  });

  it('canHandoffTo：有额外目录的会话只能换到支持额外目录的引擎', () => {
    const cursor = provider('cursor', 'cursor');
    const multi = { ...session, extraRoots: ['/repo/api'] };
    expect(canHandoffTo(claude, multi, features)).toBe(true);
    expect(canHandoffTo(cursor, multi, features)).toBe(false);
    expect(canHandoffTo(cursor, multi, undefined)).toBe(false);
    expect(canHandoffTo(cursor, session, features)).toBe(true);
  });

  it('modelLabel：订阅写软件名，API 写服务名，后面是模型名', () => {
    expect(modelLabel([api, claude], 'claude', 'm')).toBe('Claude · Model M');
    expect(modelLabel([api, claude], 'mock', 'm')).toBe('Mock API · Model M');
    expect(modelLabel([api], 'mock', 'other')).toBe('Mock API · other');
    expect(modelLabel([], 'gone', 'x')).toBe('x');
  });
});
