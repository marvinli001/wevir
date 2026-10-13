// Host 侧的 Provider 桥接（T3.4）：写库前经适配器检查、每次变更后把整套 Provider（含 Key）交给引擎、
// provider.test 带上已存的 Key。引擎侧换成记录调用的假桥接；dsh 的实现见 packages/adapter-dsh。

import type { MethodParams } from '@wevir/protocol';
import type { ProviderConfig, ProviderIssue, ProviderTestResult } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { describe, expect, it } from 'vitest';
import { HostError } from './errors.js';
import { EventStore } from './event-store.js';
import { createHostMethods, type ProviderBridge, syncProviders } from './host-methods.js';
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
    bridge.failApply = new Error('dsh 启动失败：配置不合法');
    const { methods, storage } = setup(bridge);
    const error = await hostError(Promise.resolve(methods['provider.upsert'](qwen, context)));
    expect(error.code).toBe('ENGINE_ERROR');
    expect(error.message).toContain('dsh 启动失败');
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
