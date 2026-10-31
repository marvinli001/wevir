import { WevirRpcError } from '@wevir/client-sdk';
import { type AccountState, ErrorCode, type ProviderProfile } from '@wevir/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  createParams,
  effortsOf,
  initialDraft,
  isNewSessionMemory,
  loadOptions,
  type NewSessionClient,
  PHONE_PERMISSION_MODES,
  pickableProviders,
  providerTitle,
  rememberDraft,
  resolveChoice,
  startSession,
} from './new-session';

function provider(id: string, overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id,
    kind: 'openai-compatible',
    displayName: id,
    models: [],
    defaultModelId: `${id}-default`,
    hasSecret: true,
    createdAt: '2026-10-27T10:00:00.000Z',
    updatedAt: '2026-10-27T10:00:00.000Z',
    ...overrides,
  } as ProviderProfile;
}

function account(kind: AccountState['kind'], overrides: Partial<AccountState> = {}): AccountState {
  return { kind, status: 'signed_in', ...overrides } as AccountState;
}

const FEATURES = { chats: true, worktree: true, permissionModes: true };

describe('new session', () => {
  it('lists enabled, signed-in sources with subscriptions first', () => {
    const list = pickableProviders(
      [
        provider('deepseek'),
        provider('claude', { kind: 'claude' }),
        provider('off', { enabled: false }),
        provider('chatgpt', { kind: 'chatgpt' }),
        provider('cursor', { kind: 'cursor' }),
      ],
      [account('claude'), account('chatgpt'), account('cursor', { status: 'signed_out' })],
    );
    expect(list.map((p) => p.id)).toEqual(['chatgpt', 'claude', 'deepseek']);
  });

  it('names sources by software and tells accounts of one kind apart', () => {
    const accounts = [
      account('claude'),
      account('claude', { id: 'claude-2' } as never),
      account('claude', { id: 'claude-3', label: 'Work' } as never),
    ];
    expect(providerTitle(provider('claude', { kind: 'claude' }), accounts)).toBe('Claude');
    expect(providerTitle(provider('claude-2', { kind: 'claude' }), accounts)).toBe('Claude 2');
    expect(providerTitle(provider('claude-3', { kind: 'claude' }), accounts)).toBe('Claude · Work');
    expect(providerTitle(provider('chatgpt', { kind: 'chatgpt' }), [])).toBe('Codex');
    expect(providerTitle(provider('ds', { displayName: 'DeepSeek' }), [])).toBe('DeepSeek');
  });

  it('keeps a usable previous choice and drops efforts the model does not have', () => {
    const p = provider('p', {
      models: [{ id: 'a', reasoningEfforts: ['low', 'high'] }, { id: 'b' }],
      defaultModelId: 'a',
    });
    expect(resolveChoice([p], undefined)).toEqual({ providerId: 'p', modelId: 'a' });
    expect(resolveChoice([p], { providerId: 'p', modelId: 'a', reasoningEffort: 'high' })).toEqual({
      providerId: 'p',
      modelId: 'a',
      reasoningEffort: 'high',
    });
    expect(resolveChoice([p], { providerId: 'p', modelId: 'b', reasoningEffort: 'high' })).toEqual({
      providerId: 'p',
      modelId: 'b',
    });
    expect(resolveChoice([p], { providerId: 'gone', modelId: 'x' })).toEqual({
      providerId: 'p',
      modelId: 'a',
    });
    expect(effortsOf([p], { providerId: 'p', modelId: 'a' })).toEqual(['low', 'high']);
    expect(effortsOf([p], { providerId: 'p', modelId: 'b' })).toEqual([]);
  });

  it('never offers full access on the phone', () => {
    expect(PHONE_PERMISSION_MODES).not.toContain('full_access');
  });

  it('uses inferred relay levels and keeps explicit fixed effort', () => {
    const p = provider('relay', {
      models: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5', reasoningEfforts: [] }],
      defaultModelId: 'claude-opus-5-5',
    });
    const choice = { providerId: p.id, modelId: p.defaultModelId, reasoningEffort: 'max' };
    expect(effortsOf([p], choice)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(resolveChoice([p], choice)).toEqual(choice);
    expect(effortsOf([p], { ...choice, modelId: 'claude-sonnet-5-5' })).toEqual([]);
  });

  it('builds create params: chats without a project, worktree only inside one', () => {
    const choice = { providerId: 'p', modelId: 'a', reasoningEffort: 'high' };
    expect(
      createParams({ newWorktree: true, choice, permissionMode: 'auto_review' }, FEATURES),
    ).toEqual({
      providerId: 'p',
      modelId: 'a',
      reasoningEffort: 'high',
      permissionMode: 'auto_review',
    });
    expect(
      createParams(
        { workspaceId: 'wsp_1' as never, newWorktree: true, choice, permissionMode: 'on_request' },
        FEATURES,
      ),
    ).toMatchObject({ workspaceId: 'wsp_1', worktree: 'new', permissionMode: 'on_request' });
    expect(
      createParams(
        { workspaceId: 'wsp_1' as never, newWorktree: true, choice, permissionMode: 'on_request' },
        { chats: true, worktree: false, permissionModes: false },
      ),
    ).toEqual({ workspaceId: 'wsp_1', providerId: 'p', modelId: 'a', reasoningEffort: 'high' });
  });

  it('says computer-only without the permissions to list sources or send', async () => {
    const request = vi.fn();
    const base = { request, subscribe: vi.fn(), supports: () => true } as never;
    expect(
      await loadOptions({
        ...(base as object),
        canWrite: true,
        canReadProviders: false,
      } as NewSessionClient),
    ).toEqual({ kind: 'forbidden' });
    expect(
      await loadOptions({
        ...(base as object),
        canWrite: false,
        canReadProviders: true,
      } as NewSessionClient),
    ).toEqual({ kind: 'forbidden' });
    expect(request).not.toHaveBeenCalled();
    const denied: NewSessionClient = {
      canWrite: true,
      canReadProviders: true,
      supports: () => true,
      subscribe: vi.fn() as never,
      request: vi.fn(async () => {
        throw new WevirRpcError('provider.list', {
          code: ErrorCode.DEVICE_FORBIDDEN,
          message: 'forbidden',
          data: { missing: ['provider.read'] },
        });
      }) as never,
    };
    expect(await loadOptions(denied)).toEqual({ kind: 'forbidden' });
  });

  it('loads projects (not the chats workspace), sources and features', async () => {
    const client: NewSessionClient = {
      canWrite: true,
      canReadProviders: true,
      supports: (feature) => feature !== 'session_worktree',
      subscribe: vi.fn() as never,
      request: vi.fn(async (method: string) => {
        if (method === 'workspace.list')
          return {
            workspaces: [
              { id: 'wsp_chats', kind: 'chats', rootPath: '/c', displayName: 'Chats' },
              { id: 'wsp_app', rootPath: '/app', displayName: 'app' },
            ],
          };
        if (method === 'provider.list') return { providers: [provider('p')] };
        throw new Error('no accounts');
      }) as never,
    };
    const options = await loadOptions(client);
    expect(options).toMatchObject({
      kind: 'ready',
      workspaces: [{ id: 'wsp_app' }],
      providers: [{ id: 'p' }],
      accounts: undefined,
      features: { chats: true, worktree: false, permissionModes: true },
    });
  });

  it('creates the session and sends the first message', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const client: NewSessionClient = {
      canWrite: true,
      canReadProviders: true,
      supports: () => true,
      subscribe: vi.fn() as never,
      request: vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === 'session.create') return { session: { id: 'ses_new' } };
        return { seq: 1 };
      }) as never,
    };
    const result = await startSession(
      client,
      {
        newWorktree: false,
        choice: { providerId: 'p', modelId: 'a' },
        permissionMode: 'on_request',
      },
      FEATURES,
      [{ type: 'text', text: 'hello' }],
      'm-1',
    );
    expect(result).toEqual({ session: { id: 'ses_new' }, sent: true });
    expect(calls.map((c) => c.method)).toEqual(['session.create', 'session.send']);
    expect(calls[1]?.params).toEqual({
      sessionId: 'ses_new',
      content: [{ type: 'text', text: 'hello' }],
      clientMessageId: 'm-1',
    });
  });

  describe('remembered choices', () => {
    const ready = {
      kind: 'ready' as const,
      workspaces: [
        { id: 'ws_a', rootPath: '/a', displayName: 'a' },
        { id: 'ws_b', rootPath: '/b', displayName: 'b' },
      ] as never,
      providers: [
        provider('p', {
          models: [{ id: 'a', reasoningEfforts: ['low', 'high'] }, { id: 'b' }] as never,
          defaultModelId: 'a',
        }),
        provider('q'),
      ],
      accounts: undefined,
      features: FEATURES,
    };

    it('starts as a chat with the first source when nothing is remembered', () => {
      expect(initialDraft(ready, undefined)).toEqual({
        newWorktree: false,
        choice: { providerId: 'p', modelId: 'a' },
        permissionMode: 'on_request',
      });
      expect(
        initialDraft({ ...ready, features: { ...FEATURES, chats: false } }, undefined).workspaceId,
      ).toBe('ws_a');
    });

    it('reuses the last choices that still exist', () => {
      const saved = rememberDraft({
        workspaceId: 'ws_b' as never,
        newWorktree: true,
        choice: { providerId: 'p', modelId: 'a', reasoningEffort: 'high' },
        permissionMode: 'auto_review',
      });
      expect(initialDraft(ready, saved)).toEqual({
        workspaceId: 'ws_b',
        newWorktree: true,
        choice: { providerId: 'p', modelId: 'a', reasoningEffort: 'high' },
        permissionMode: 'auto_review',
      });
      // 换了项目不沿用新工作树；项目没了回到对话；模型没了用来源的默认模型。
      expect(initialDraft(ready, saved, 'ws_a')).toMatchObject({
        workspaceId: 'ws_a',
        newWorktree: false,
      });
      expect(
        initialDraft(ready, {
          ...saved,
          workspaceId: 'ws_gone',
          choice: { providerId: 'p', modelId: 'x' },
        }),
      ).toEqual({
        newWorktree: false,
        choice: { providerId: 'p', modelId: 'a' },
        permissionMode: 'auto_review',
      });
      expect(initialDraft(ready, { workspaceId: null }).workspaceId).toBeUndefined();
    });

    it('accepts only a well-formed memory file', () => {
      expect(isNewSessionMemory({ computer: 'mac', computers: {} })).toBe(true);
      expect(isNewSessionMemory({ computers: null })).toBe(false);
      expect(isNewSessionMemory('x')).toBe(false);
    });
  });
});
