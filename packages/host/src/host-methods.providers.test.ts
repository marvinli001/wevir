// Host 侧的 Provider 桥接（T3.4）：写库前经适配器检查、每次变更后把整套 Provider（含 Key）交给引擎、
// provider.test 带上已存的 Key。引擎侧换成记录调用的假桥接。

import { type MethodParams, MethodSchemas } from '@wevir/protocol';
import type { ProviderConfig, ProviderIssue, ProviderTestResult } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { describe, expect, it, vi } from 'vitest';
import { HostError } from './errors.js';
import { EventStore } from './event-store.js';
import { createHostMethods, type ProviderBridge, syncProviders } from './host-methods.js';
import { adaptResultForClient } from './rpc-connection.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const context = { client: identity, capabilities: {} };

interface FakeBridge extends ProviderBridge {
  applied: ProviderConfig[][];
  tested: Array<{ provider: ProviderConfig; modelId: string }>;
  issues: ProviderIssue[];
  failApply?: Error;
}

function fakeBridge(): FakeBridge {
  const bridge: FakeBridge = {
    applied: [],
    tested: [],
    issues: [],
    validateProvider: () => bridge.issues,
    configureProviders: async (providers) => {
      if (bridge.failApply) throw bridge.failApply;
      bridge.applied.push(structuredClone([...providers]));
    },
    testProvider: async (provider, modelId): Promise<ProviderTestResult> => {
      bridge.tested.push({ provider, modelId });
      return provider.apiKey === undefined
        ? {
            ok: false,
            reason: 'missing_key',
            error: { category: 'missing_credentials', message: 'no key' },
          }
        : { ok: true, latencyMs: 12 };
    },
  };
  return bridge;
}

/** `null`：没有引擎桥接。 */
function setup(bridge: ProviderBridge | null = fakeBridge()) {
  const dataDir = tempDir();
  const storage = storages.open(dataDir);
  const events = new EventStore({ storage, deltaWindowMs: 5 });
  const sessions = new SessionManager({ storage, events, adapter: new EchoAdapter() });
  const secrets = new FileSecretStore(dataDir);
  const methods = createHostMethods({
    storage,
    events,
    sessions,
    secrets,
    ...(bridge !== null && { providers: bridge }),
  });
  return { methods, storage, secrets };
}

const qwen: MethodParams<'provider.upsert'> = {
  id: 'qwen',
  kind: 'openai-compatible',
  displayName: '通义千问',
  api: 'openai-completions',
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  models: [{ id: 'qwen-plus', contextWindow: 131072, maxTokens: 16384, reasoningEfforts: [] }],
  defaultModelId: 'qwen-plus',
};

async function hostError(promise: Promise<unknown>): Promise<HostError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HostError);
  return error as HostError;
}

describe('Provider 桥接（Host 侧）', () => {
  it('discovery snapshots a stored endpoint and key together across a concurrent edit', async () => {
    const { methods, secrets } = setup();
    await methods['provider.upsert'](
      { ...qwen, id: 'ollama', baseURL: 'https://ollama.com/v1', apiKey: 'old-test-key' },
      context,
    );
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = secrets.get.bind(secrets);
    vi.spyOn(secrets, 'get').mockImplementationOnce(async (ref) => {
      entered();
      await gate;
      return original(ref);
    });
    const send = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('https://ollama.com/api/tags');
      expect(init?.headers).toHaveProperty('authorization', 'Bearer old-test-key');
      return new Response('{"models":[]}');
    });
    vi.stubGlobal('fetch', send);
    try {
      const discovery = methods['provider.discoverModels']({ providerId: 'ollama' }, context);
      await reading;
      let edited = false;
      const edit = Promise.resolve(
        methods['provider.upsert'](
          { ...qwen, id: 'ollama', baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'new-test-key' },
          context,
        ),
      ).then(() => {
        edited = true;
      });
      await Promise.resolve();
      expect(edited).toBe(false);
      release();
      expect(await discovery).toMatchObject({ ok: true });
      await edit;
      expect(await secrets.get('ollama')).toBe('new-test-key');
    } finally {
      release();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
  it('discovery binds the stored key to its saved origin, and never persists an unsaved key', async () => {
    const { methods, storage, secrets } = setup();
    const send = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url).startsWith('https://ollama.com/api/')).toBe(true);
      expect(init?.headers).toHaveProperty('authorization', 'Bearer stored-cloud-test');
      return new Response(JSON.stringify({ models: [] }));
    });
    vi.stubGlobal('fetch', send);
    try {
      await methods['provider.upsert'](
        { ...qwen, id: 'ollama', baseURL: 'https://ollama.com/v1', apiKey: 'stored-cloud-test' },
        context,
      );
      const result = await methods['provider.discoverModels']({ providerId: 'ollama' }, context);
      expect(result).toEqual({ ok: true, models: [] });
      expect(JSON.stringify(result)).not.toContain('stored-cloud-test');
      expect(storage.providers.get('ollama')).not.toHaveProperty('apiKey');
      expect(await secrets.get('ollama')).toBe('stored-cloud-test');
      await expect(
        methods['provider.discoverModels'](
          { providerId: 'ollama', baseURL: 'http://localhost:11434/v1' },
          context,
        ),
      ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      await expect(
        methods['provider.discoverModels']({ providerId: 'ollama', apiKey: 'override' }, context),
      ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      await expect(methods['provider.discoverModels']({}, context)).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
      });
      send.mockImplementation(async () => new Response(JSON.stringify({ models: [] })));
      expect(
        await methods['provider.discoverModels'](
          { baseURL: 'https://ollama.com/v1', apiKey: 'unsaved-cloud-test' },
          context,
        ),
      ).toEqual({ ok: true, models: [] });
      expect(storage.providers.list()).toHaveLength(1);
      expect(await secrets.get('unsaved-cloud-test')).toBeUndefined();
      await methods['provider.upsert'](
        { ...qwen, id: 'other', apiKey: 'must-not-forward' },
        context,
      );
      send.mockClear();
      await expect(
        methods['provider.discoverModels']({ providerId: 'other' }, context),
      ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      expect(send).not.toHaveBeenCalled();
      await expect(
        methods['provider.discoverModels']({ providerId: 'gone' }, context),
      ).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('Vertex 的 project/location 持久化，整份 JSON 只进 SecretStore；旧客户端看不到新 kind', async () => {
    const bridge = { ...fakeBridge(), googleVertex: true };
    const { methods, storage, secrets } = setup(bridge);
    const vertex: MethodParams<'provider.upsert'> = {
      id: 'vertex',
      kind: 'google-vertex',
      displayName: 'Vertex',
      api: 'openai-completions',
      vertex: { project: 'vertex-example', location: 'global' },
      models: [{ id: 'google/gemini-3.8-flash' }],
      defaultModelId: 'google/gemini-3.8-flash',
    };
    const json = '{"type":"service_account","private_key":"fake-private-key"}';
    const created = await methods['provider.upsert'](
      { ...vertex, serviceAccountJson: json },
      context,
    );
    expect(created.provider).toMatchObject({
      kind: 'google-vertex',
      vertex: vertex.vertex,
      hasSecret: true,
    });
    expect(JSON.stringify(created)).not.toContain('private_key');
    expect(JSON.stringify(storage.providers.get('vertex'))).not.toContain('fake-private-key');
    expect(await secrets.get('vertex')).toBe(json);
    expect(bridge.applied.at(-1)?.[0]).toMatchObject({
      serviceAccountJson: json,
      vertex: vertex.vertex,
    });
    expect(bridge.applied.at(-1)?.[0]).not.toHaveProperty('apiKey');
    const listed = await methods['provider.list']({}, context);
    expect(adaptResultForClient('provider.list', listed, {})).toEqual({ providers: [] });
    expect(
      adaptResultForClient('provider.list', listed, { provider_kind_google_vertex: true }),
    ).toEqual(listed);
    await methods['provider.upsert']({ ...vertex, displayName: 'Renamed' }, context);
    expect(await secrets.get('vertex')).toBe(json);
    await methods['provider.test']({ providerId: 'vertex' }, context);
    expect(bridge.tested[0]?.provider).toMatchObject({ serviceAccountJson: json });
    await methods['provider.upsert']({ ...vertex, serviceAccountJson: null }, context);
    expect(await secrets.get('vertex')).toBeUndefined();
    expect((await methods['provider.list']({}, context)).providers[0]?.hasSecret).toBe(false);
  });

  it('没有 Vertex 功能的引擎拒绝新 kind，不写记录与密钥', async () => {
    const { methods, storage, secrets } = setup();
    await expect(
      methods['provider.upsert'](
        {
          id: 'vertex',
          kind: 'google-vertex',
          displayName: 'Vertex',
          api: 'openai-completions',
          vertex: { project: 'vertex-example' },
          models: [{ id: 'google/gemini-3.8-flash' }],
          defaultModelId: 'google/gemini-3.8-flash',
          serviceAccountJson: 'fake-json',
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(storage.providers.get('vertex')).toBeUndefined();
    expect(await secrets.get('vertex')).toBeUndefined();
  });

  it('转写模型（0.92.0）：保存并列出；旧客户端省略时保留，空数组清空，ID 不能重复', async () => {
    const { methods, storage } = setup();
    const withWhisper = { ...qwen, transcriptionModels: [{ id: 'whisper-1' }] };
    const created = await methods['provider.upsert'](withWhisper, context);
    expect(created.provider.transcriptionModels).toEqual([{ id: 'whisper-1' }]);
    // 旧客户端不带这个字段：保留。
    await methods['provider.upsert']({ ...qwen, displayName: '改名' }, context);
    expect(storage.providers.get('qwen')?.transcriptionModels).toEqual([{ id: 'whisper-1' }]);
    const listed = await methods['provider.list']({}, context);
    expect(listed.providers[0]?.transcriptionModels).toEqual([{ id: 'whisper-1' }]);
    await methods['provider.upsert']({ ...qwen, transcriptionModels: [] }, context);
    expect(storage.providers.get('qwen')?.transcriptionModels).toBeUndefined();
    const duplicate = await hostError(
      Promise.resolve(
        methods['provider.upsert'](
          { ...qwen, transcriptionModels: [{ id: 'whisper-1' }, { id: 'whisper-1' }] },
          context,
        ),
      ),
    );
    expect(duplicate.code).toBe('INVALID_PARAMS');
  });

  it('P0a 的 compat 经协议解析、保存、list 与引擎桥接后仍保留', async () => {
    const bridge = fakeBridge();
    const { methods, storage } = setup(bridge);
    const compat = {
      supportsNamespaceTools: false,
      toolChoice: 'auto_only',
      geminiToolSchema: true,
    } as const;
    const params = MethodSchemas['provider.upsert'].params.parse({ ...qwen, compat });
    const result = await methods['provider.upsert'](params, context);
    expect(result.provider.compat).toEqual(compat);
    expect(storage.providers.get('qwen')?.compat).toEqual(compat);
    expect(bridge.applied.at(-1)?.[0]?.compat).toEqual(compat);
    const listed = await methods['provider.list']({}, context);
    expect(listed.providers[0]?.compat).toEqual(compat);
  });
  it('upsert / remove 之后把全部 Provider（含 Key）交给引擎；没存 Key 的不带 apiKey', async () => {
    const bridge = fakeBridge();
    const { methods } = setup(bridge);
    await methods['provider.upsert']({ ...qwen, apiKey: 'sk-qwen' }, context);
    await methods['provider.upsert'](
      {
        id: 'deepseek-official',
        kind: 'deepseek-official',
        displayName: 'DeepSeek',
        models: [],
        defaultModelId: 'deepseek-flash',
      },
      context,
    );
    // 存储按创建时间、再按 ID 排序；同一毫秒建的两个顺序不定，这里按 ID 比。
    const applied = [...(bridge.applied.at(-1) ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    expect(applied).toEqual([
      {
        id: 'deepseek-official',
        kind: 'deepseek-official',
        displayName: 'DeepSeek',
        models: [],
        defaultModelId: 'deepseek-flash',
      },
      {
        id: 'qwen',
        kind: 'openai-compatible',
        displayName: '通义千问',
        api: 'openai-completions',
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        models: qwen.models,
        defaultModelId: 'qwen-plus',
        apiKey: 'sk-qwen',
      },
    ]);
    await methods['provider.remove']({ providerId: 'qwen' }, context);
    expect(bridge.applied.at(-1)?.map((p) => p.id)).toEqual(['deepseek-official']);
    expect(bridge.applied).toHaveLength(3);
  });

  it('DeepSeek 官方只保留 compat 的 toolSearch：存储、交给引擎、列表里都是它；别的开关丢掉', async () => {
    const bridge = fakeBridge();
    const { methods, storage } = setup(bridge);
    const params = {
      id: 'deepseek-official',
      kind: 'deepseek-official',
      displayName: 'DeepSeek',
      models: [],
      defaultModelId: 'deepseek-flash',
      // 协议的 schema 已经去掉别的字段；这里直接调方法，确认 Host 自己也只取 toolSearch。
      compat: { toolSearch: 'off', toolChoice: 'auto_only' },
    } as unknown as MethodParams<'provider.upsert'>;
    expect(MethodSchemas['provider.upsert'].params.parse(params)).toMatchObject({
      compat: { toolSearch: 'off' },
    });
    expect(MethodSchemas['provider.upsert'].params.parse(params)).not.toHaveProperty(
      'compat.toolChoice',
    );
    const result = await methods['provider.upsert'](params, context);
    expect(result.provider.compat).toEqual({ toolSearch: 'off' });
    expect(storage.providers.get('deepseek-official')?.compat).toEqual({ toolSearch: 'off' });
    expect(bridge.applied.at(-1)?.[0]?.compat).toEqual({ toolSearch: 'off' });
    expect((await methods['provider.list']({}, context)).providers[0]?.compat).toEqual({
      toolSearch: 'off',
    });
    // 不带 compat 再存一次：整体替换，开关清掉。
    const { compat: _compat, ...plain } = params as unknown as Record<string, unknown>;
    await methods['provider.upsert'](plain as typeof params, context);
    expect(storage.providers.get('deepseek-official')?.compat).toBeUndefined();
  });

  it('删除 Provider 时一并删除它的用量记录', async () => {
    const { methods, storage } = setup();
    await methods['provider.upsert'](qwen, context);
    const usage = (providerId: string, requestId: string) => ({
      sessionId: 'ses_01',
      requestId,
      at: 1_000,
      source: 'openai-compatible',
      providerId,
      providerName: providerId,
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
    storage.usage.insert(usage('qwen', 'r1'));
    storage.usage.insert(usage('other', 'r2'));
    await methods['provider.remove']({ providerId: 'qwen' }, context);
    expect(storage.usage.range(0, 10_000).map((row) => row.providerId)).toEqual(['other']);
  });

  it('compat 原样保存并交给引擎，含只有模型网关用的开关（0.4.0）', async () => {
    const bridge = fakeBridge();
    const { methods } = setup(bridge);
    const compat = {
      supportsDeveloperRole: false,
      supportsCustomTools: false,
      systemMessageMode: 'merge' as const,
    };
    await methods['provider.upsert']({ ...qwen, compat }, context);
    expect(bridge.applied.at(-1)?.[0]?.compat).toEqual(compat);
    const { providers } = await methods['provider.list']({}, context);
    expect(providers[0]?.compat).toEqual(compat);
  });

  it('引擎不接受的配置：INVALID_PARAMS（issues 原样），不写库、不动 Key', async () => {
    const bridge = fakeBridge();
    bridge.issues = [{ path: ['api'], message: 'anthropic-messages 协议只预留了类型，暂不支持' }];
    const { methods, storage, secrets } = setup(bridge);
    const error = await hostError(
      Promise.resolve(
        methods['provider.upsert'](
          { ...qwen, api: 'anthropic-messages', apiKey: 'sk-qwen' },
          context,
        ),
      ),
    );
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.data).toEqual({ issues: bridge.issues });
    expect(storage.providers.list()).toEqual([]);
    expect(await secrets.get('qwen')).toBeUndefined();
    expect(bridge.applied).toEqual([]);
  });

  it('引擎没能用上新配置：ENGINE_ERROR，但 Profile 已保存', async () => {
    const bridge = fakeBridge();
    bridge.failApply = new Error('引擎启动失败：配置不合法');
    const { methods, storage } = setup(bridge);
    const error = await hostError(Promise.resolve(methods['provider.upsert'](qwen, context)));
    expect(error.code).toBe('ENGINE_ERROR');
    expect(error.message).toContain('引擎启动失败');
    expect(storage.providers.get('qwen')).toBeDefined();
  });

  it('provider.test：带上已存的 Key 交给引擎；省略 modelId 时用 defaultModelId', async () => {
    const bridge = fakeBridge();
    const { methods } = setup(bridge);
    await methods['provider.upsert']({ ...qwen, apiKey: 'sk-qwen' }, context);
    expect(await methods['provider.test']({ providerId: 'qwen' }, context)).toEqual({
      ok: true,
      latencyMs: 12,
    });
    expect(bridge.tested[0]?.modelId).toBe('qwen-plus');
    expect(bridge.tested[0]?.provider.apiKey).toBe('sk-qwen');

    await methods['provider.upsert']({ ...qwen, apiKey: null }, context);
    expect(
      await methods['provider.test']({ providerId: 'qwen', modelId: 'other' }, context),
    ).toMatchObject({
      ok: false,
      reason: 'missing_key',
    });
    expect(bridge.tested[1]).toMatchObject({ modelId: 'other', provider: { id: 'qwen' } });
    expect(bridge.tested[1]?.provider.apiKey).toBeUndefined();
  });

  it('没有引擎桥接：provider.test 回不可用，upsert 照常', async () => {
    const { methods } = setup(null);
    await methods['provider.upsert'](qwen, context);
    expect(await methods['provider.test']({ providerId: 'qwen' }, context)).toMatchObject({
      ok: false,
      reason: 'unknown',
      error: { category: 'unknown' },
    });
  });

  it('syncProviders：Host 启动时把存储里的 Provider 交给引擎', async () => {
    const { methods, storage, secrets } = setup(null);
    await methods['provider.upsert']({ ...qwen, apiKey: 'sk-qwen' }, context);
    const bridge = fakeBridge();
    await syncProviders(storage, secrets, bridge);
    expect(bridge.applied).toEqual([[expect.objectContaining({ id: 'qwen', apiKey: 'sk-qwen' })]]);
  });
});
