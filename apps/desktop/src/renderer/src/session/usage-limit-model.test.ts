import type { AccountState, ProviderProfile } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { isExhausted, switchTargets } from './usage-limit-model';

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const LATER = '2026-10-30T15:00:00.000Z';
const EARLIER = '2026-10-30T11:00:00.000Z';

function provider(id: string, kind: ProviderProfile['kind'], extra: Partial<ProviderProfile> = {}) {
  return {
    id,
    kind,
    displayName: id,
    models: [{ id: 'm' }],
    defaultModelId: 'm',
    hasSecret: false,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    ...extra,
  } satisfies ProviderProfile;
}

function account(
  kind: AccountState['kind'],
  rateLimits?: AccountState['rateLimits'],
  extra: Partial<AccountState> = {},
): AccountState {
  return { kind, id: kind, status: 'signed_in', ...(rateLimits && { rateLimits }), ...extra };
}

describe('isExhausted', () => {
  it('有一个窗口用到 100% 且还没重置就算用完', () => {
    expect(
      isExhausted(
        account('claude', {
          primary: { usedPercent: 40, windowMinutes: 300, resetsAt: LATER },
          secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: LATER },
        }),
        NOW,
      ),
    ).toBe(true);
    expect(
      isExhausted(account('claude', { primary: { usedPercent: 99, resetsAt: LATER } }), NOW),
    ).toBe(false);
  });

  it('已经重置过的窗口不算；不知道何时重置的照算', () => {
    expect(
      isExhausted(account('claude', { primary: { usedPercent: 100, resetsAt: EARLIER } }), NOW),
    ).toBe(false);
    expect(isExhausted(account('grok', { primary: { usedPercent: 100 } }), NOW)).toBe(true);
  });

  it('窗口都分份时要每一份都用完；`windows` 优先于 primary / secondary', () => {
    const scoped = (a: number, b: number) =>
      account('cursor', {
        windows: [
          { usedPercent: a, scope: 'Auto + Composer', resetsAt: LATER },
          { usedPercent: b, scope: 'API', resetsAt: LATER },
        ],
        primary: { usedPercent: 100, resetsAt: LATER },
      });
    expect(isExhausted(scoped(100, 30), NOW)).toBe(false);
    expect(isExhausted(scoped(100, 100), NOW)).toBe(true);
  });

  it('没有账号、读不到用量时不算', () => {
    expect(isExhausted(undefined, NOW)).toBe(false);
    expect(isExhausted(account('claude'), NOW)).toBe(false);
  });
});

describe('switchTargets', () => {
  const api = provider('mock', 'openai-compatible');
  const claude = provider('claude', 'claude');
  const cursor = provider('cursor', 'cursor');
  const grok = provider('grok', 'grok');
  const off = provider('off', 'openai-compatible', { enabled: false });
  const signedOut = provider('copilot', 'copilot');
  const providers = [api, off, grok, cursor, claude, signedOut];
  const accounts = [
    account('claude', { primary: { usedPercent: 100, windowMinutes: 300, resetsAt: LATER } }),
    account('cursor', { primary: { usedPercent: 20, resetsAt: LATER } }),
    account('grok'),
    account('copilot', undefined, { status: 'signed_out' }),
  ];

  it('额度用完的来源排到最后并标出来，当前来源总算用完；其余照模型菜单的顺序', () => {
    const targets = switchTargets(providers, accounts, 'cursor', NOW);
    expect(targets.providers.map((p) => p.id)).toEqual(['grok', 'mock', 'claude', 'cursor']);
    expect([...targets.exhausted].sort()).toEqual(['claude', 'cursor']);
  });

  it('停用的、订阅没登录的不列；当前来源即使停用也列', () => {
    const targets = switchTargets(providers, accounts, 'off', NOW);
    expect(targets.providers.map((p) => p.id)).toEqual(['cursor', 'grok', 'mock', 'claude', 'off']);
    expect(targets.exhausted.has('off')).toBe(true);
    expect(targets.providers.some((p) => p.id === 'copilot')).toBe(false);
  });
});
