import type { AccountState, ProviderProfile } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  accountMark,
  accountOfProvider,
  accountSuffix,
  GIT_FOR_WINDOWS_URL,
  hasSiblingAccounts,
  isPickable,
  pickerOrder,
  SOURCE_KINDS,
  SOURCES,
  sourceOf,
  sourcePhase,
  sourceTitle,
  tileFillers,
} from './sources';

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
  it('tileFillers：两列、三列各补满最后一行，排满了不补', () => {
    expect(tileFillers(6)).toEqual([]);
    // 七个来源：两列缺 1 格，三列缺 2 格。
    expect(tileFillers(7)).toEqual([
      { slot: 1, base: true, sm: true },
      { slot: 2, base: false, sm: true },
    ]);
    expect(tileFillers(8)).toEqual([{ slot: 1, base: false, sm: true }]);
    expect(tileFillers(9)).toEqual([{ slot: 1, base: true, sm: false }]);
    // 当前的来源个数加补位格，两列、三列都正好排满，不会露出分隔线色的空位。
    const fillers = tileFillers(SOURCE_KINDS.length);
    expect((SOURCE_KINDS.length + fillers.filter((filler) => filler.base).length) % 2).toBe(0);
    expect((SOURCE_KINDS.length + fillers.filter((filler) => filler.sm).length) % 3).toBe(0);
  });

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

describe('同一来源的多个账号（0.63.0）', () => {
  const first: AccountState = { kind: 'claude', id: 'claude', status: 'signed_in', label: '主号' };
  const second: AccountState = { kind: 'claude', id: 'claude-3f9a', status: 'signed_in' };
  const third: AccountState = { kind: 'claude', id: 'claude-77d0', status: 'signed_out' };
  const accounts = [first, second, third];

  it('按 Provider ID 找账号；旧 Host 的账号没有 ID 时按种类', () => {
    expect(accountOfProvider(provider('claude-3f9a', 'claude'), accounts)).toBe(second);
    expect(
      accountOfProvider(provider('claude', 'claude'), [{ kind: 'claude', status: 'signed_in' }]),
    ).toMatchObject({ kind: 'claude' });
    expect(accountOfProvider(provider('deepseek-official', 'deepseek-official'), accounts)).toBe(
      undefined,
    );
  });

  it('isPickable 看的是这个 Provider 自己的账号', () => {
    expect(isPickable(provider('claude-3f9a', 'claude'), accounts)).toBe(true);
    expect(isPickable(provider('claude-77d0', 'claude'), accounts)).toBe(false);
  });

  it('角标取标签的第一个字，拉丁字母大写；名字带标签或序号', () => {
    expect(accountMark('主号')).toBe('主');
    expect(accountMark('work')).toBe('W');
    expect(accountMark('👩‍💻 dev')).toBe('👩‍💻');
    expect(accountMark(undefined)).toBeUndefined();
    expect(accountSuffix(provider('claude', 'claude'), accounts)).toBe('主号');
    expect(accountSuffix(provider('claude-3f9a', 'claude'), accounts)).toBe('2');
    expect(sourceTitle(provider('claude', 'claude'), accounts, 'Claude')).toBe('Claude · 主号');
    expect(sourceTitle(provider('claude-3f9a', 'claude'), accounts, 'Claude')).toBe('Claude 2');
    expect(sourceTitle(provider('claude', 'claude'), [second], 'Claude')).toBe('Claude');
    expect(hasSiblingAccounts(provider('claude', 'claude'), accounts)).toBe(true);
    expect(hasSiblingAccounts(provider('grok', 'grok'), accounts)).toBe(false);
  });
});
