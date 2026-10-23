import { generateKeyPair } from '@wevir/noise';
import { describe, expect, it } from 'vitest';
import { ComputerRegistry, type ComputerStorage } from './computers';
import type { ComputerRecord } from './records';
import { record } from './test-utils';

class MemoryStorage implements ComputerStorage {
  records = new Map<string, ComputerRecord>();
  keys = new Map<string, Uint8Array>();
  async list() {
    return [...this.records.values()];
  }
  async save(r: ComputerRecord) {
    this.records.set(r.name, r);
  }
  async remove(name: string) {
    this.records.delete(name);
  }
  async saveKey(routeId: string, secretKey: Uint8Array) {
    this.keys.set(routeId, secretKey);
  }
  async deleteKey(routeId: string) {
    this.keys.delete(routeId);
  }
}

const env = {
  connect: () => new Promise<never>(() => {}),
  now: () => new Date(),
  setTimer: () => undefined,
  clearTimer: () => {},
};

describe('ComputerRegistry', () => {
  it('stores the key and record on pairing and drops both on forget', async () => {
    const storage = new MemoryStorage();
    const registry = new ComputerRegistry(storage, env);
    await registry.load();
    const r = record({ name: 'studio' });
    const device = generateKeyPair();
    await registry.add({ record: r, device, previous: undefined });
    expect(storage.keys.get(r.routeId)).toEqual(device.secretKey);
    expect(registry.snapshots.map((s) => s.record.name)).toEqual(['studio']);
    await registry.forget('studio');
    expect(storage.records.size).toBe(0);
    expect(storage.keys.size).toBe(0);
    expect(registry.snapshots).toEqual([]);
  });

  it('replaces the old record when the same computer pairs again under a new name', async () => {
    const storage = new MemoryStorage();
    const old = record({ name: 'old', pairedAt: '2026-10-20T00:00:00.000Z' });
    storage.records.set('old', old);
    const registry = new ComputerRegistry(storage, env);
    await registry.load();
    const fresh = { ...old, name: 'fresh', pairedAt: '2026-10-23T00:00:00.000Z' };
    await registry.add({ record: fresh, device: generateKeyPair(), previous: old });
    expect([...storage.records.keys()]).toEqual(['fresh']);
    expect(registry.snapshots.map((s) => s.record.name)).toEqual(['fresh']);
  });
});
