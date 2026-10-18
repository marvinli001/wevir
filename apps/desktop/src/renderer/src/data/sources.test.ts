import type { AccountState, ProviderProfile } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { GIT_FOR_WINDOWS_URL, isPickable, pickerOrder, sourceOf, sourcePhase } from './sources';

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

describe('订阅来源', () => {
  it('sourceOf：ChatGPT 是 Codex，订阅来源各有软件标志，API 类没有', () => {
    expect(sourceOf({ kind: 'chatgpt' })?.logo).toBe('codex');
    expect(sourceOf({ kind: 'claude' })?.logo).toBe('claude');
    expect(sourceOf({ kind: 'workbuddy' })).toMatchObject({
      name: 'source.workbuddy',
      logo: 'codebuddy',
    });
    expect(sourceOf({ kind: 'openai-compatible' })).toBeUndefined();
    expect(sourceOf({ kind: 'deepseek-official' })).toBeUndefined();
  });

  it('isPickable：停用的不列；订阅要已登录，没读到账号时照列', () => {
    const accounts: AccountState[] = [
      { kind: 'claude', status: 'signed_in' },
      { kind: 'grok', status: 'signed_out' },
      { kind: 'workbuddy', status: 'signed_out' },
    ];
    expect(isPickable(provider('local', 'openai-compatible'), accounts)).toBe(true);
    expect(isPickable(provider('local', 'openai-compatible', { enabled: false }), accounts)).toBe(
      false,
    );
    expect(isPickable(provider('claude', 'claude'), accounts)).toBe(true);
    expect(isPickable(provider('grok', 'grok'), accounts)).toBe(false);
    expect(isPickable(provider('workbuddy', 'workbuddy'), accounts)).toBe(false);
    expect(isPickable(provider('cursor', 'cursor'), accounts)).toBe(true);
    expect(isPickable(provider('claude', 'claude', { enabled: false }), accounts)).toBe(false);
  });

  it('pickerOrder：订阅在前按固定顺序，API 在后保持原顺序', () => {
    const order = pickerOrder([
      provider('b-api', 'openai-compatible'),
      provider('grok', 'grok'),
      provider('workbuddy', 'workbuddy'),
      provider('a-api', 'deepseek-official'),
      provider('chatgpt', 'chatgpt'),
      provider('claude', 'claude'),
    ]).map((item) => item.id);
    expect(order).toEqual(['chatgpt', 'claude', 'grok', 'workbuddy', 'b-api', 'a-api']);
  });

  it('sourcePhase：没有账号是即将支持；安装中算百分比；没装、登录中、已登录带套餐', () => {
    expect(sourcePhase(undefined)).toEqual({ kind: 'soon' });
    expect(
      sourcePhase({
        kind: 'antigravity',
        status: 'signed_out',
        installed: false,
        installing: { completedBytes: 25, totalBytes: 100 },
      }),
    ).toEqual({ kind: 'installing', percent: 25 });
    expect(
      sourcePhase({
        kind: 'antigravity',
        status: 'signed_out',
        installed: false,
        canInstall: true,
      }),
    ).toEqual({ kind: 'missing', canInstall: true });
    // Claude 在 Windows 上缺 Git：没装、安装地址是 Git 的下载页。
    expect(
      sourcePhase({
        kind: 'claude',
        status: 'signed_out',
        installed: false,
        installUrl: GIT_FOR_WINDOWS_URL,
        lastError: 'Claude Code on Windows requires Git for Windows (git-bash)',
      }),
    ).toEqual({ kind: 'missing', canInstall: false, requires: 'git' });
    expect(
      sourcePhase({
        kind: 'cursor',
        status: 'signed_out',
        installed: false,
        installUrl: GIT_FOR_WINDOWS_URL,
      }),
    ).toEqual({ kind: 'missing', canInstall: false });
    expect(sourcePhase({ kind: 'cursor', status: 'signing_in' })).toEqual({ kind: 'signing_in' });
    expect(
      sourcePhase({ kind: 'claude', status: 'signed_in', plan: 'max', planLabel: 'Max 20x' }),
    ).toEqual({ kind: 'signed_in', plan: 'Max 20x' });
    expect(sourcePhase({ kind: 'grok', status: 'signed_out', signIn: 'command' })).toEqual({
      kind: 'signed_out',
      signIn: 'command',
    });
  });
});
