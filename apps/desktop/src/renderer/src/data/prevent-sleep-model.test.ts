import { DEFAULT_HOST_SETTINGS, type HostSettings } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  hasRunningTurn,
  migratePreventSleep,
  PREVENT_SLEEP_STORAGE_KEY,
} from './prevent-sleep-model';

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    removeItem: (key: string) => void items.delete(key),
  };
}

function fakeClient(settings: HostSettings, options: { failUpdate?: boolean } = {}) {
  const calls: Array<[string, unknown]> = [];
  const request = async (method: string, params: unknown) => {
    calls.push([method, params]);
    if (method === 'settings.get') return { settings };
    if (method === 'settings.update') {
      if (options.failUpdate) throw new Error('offline');
      return { settings: { ...settings, ...(params as { settings: object }).settings } };
    }
    throw new Error(`unexpected ${method}`);
  };
  // biome-ignore lint/suspicious/noExplicitAny: 测试替身只实现用到的两个方法。
  return { calls, client: { request } as any };
}

describe('migratePreventSleep', () => {
  it('本机开着、Host 还没有这一项：写进 Host，再删掉本机的值', async () => {
    const storage = memoryStorage({ [PREVENT_SLEEP_STORAGE_KEY]: 'true' });
    const { calls, client } = fakeClient({ ...DEFAULT_HOST_SETTINGS });
    await migratePreventSleep(storage, client);
    expect(calls).toEqual([
      ['settings.get', {}],
      ['settings.update', { settings: { preventSleep: true } }],
    ]);
    expect(storage.items.has(PREVENT_SLEEP_STORAGE_KEY)).toBe(false);
  });

  it('Host 已经有这一项（别的客户端设过）：不覆盖，只删本机的值', async () => {
    const storage = memoryStorage({ [PREVENT_SLEEP_STORAGE_KEY]: 'true' });
    const { calls, client } = fakeClient({ ...DEFAULT_HOST_SETTINGS, preventSleep: false });
    await migratePreventSleep(storage, client);
    expect(calls).toEqual([['settings.get', {}]]);
    expect(storage.items.has(PREVENT_SLEEP_STORAGE_KEY)).toBe(false);
  });

  it('本机关着或格式不对：不碰 Host，删掉本机的值；没有本机的值时什么都不做', async () => {
    for (const raw of ['false', 'not json']) {
      const storage = memoryStorage({ [PREVENT_SLEEP_STORAGE_KEY]: raw });
      const { calls, client } = fakeClient({ ...DEFAULT_HOST_SETTINGS });
      await migratePreventSleep(storage, client);
      expect(calls).toEqual([]);
      expect(storage.items.has(PREVENT_SLEEP_STORAGE_KEY)).toBe(false);
    }
    const { calls, client } = fakeClient({ ...DEFAULT_HOST_SETTINGS });
    await migratePreventSleep(memoryStorage(), client);
    expect(calls).toEqual([]);
  });

  it('写失败时留着本机的值，下次再试', async () => {
    const storage = memoryStorage({ [PREVENT_SLEEP_STORAGE_KEY]: 'true' });
    const { client } = fakeClient({ ...DEFAULT_HOST_SETTINGS }, { failUpdate: true });
    await expect(migratePreventSleep(storage, client)).rejects.toThrow('offline');
    expect(storage.items.get(PREVENT_SLEEP_STORAGE_KEY)).toBe('true');
  });
});

describe('hasRunningTurn', () => {
  it('运行中或取消中算，等审批、等回答不算', () => {
    expect(hasRunningTurn([{ state: 'running' }])).toBe(true);
    expect(hasRunningTurn([{ state: 'cancelling', awaitingInput: true }])).toBe(true);
    expect(hasRunningTurn([{ state: 'running', awaitingInput: true }])).toBe(false);
    expect(hasRunningTurn([{ state: 'awaiting_approval' }, { state: 'idle' }])).toBe(false);
    expect(hasRunningTurn([])).toBe(false);
  });
});
