import { describe, expect, it } from 'vitest';
import type { DeviceRecord } from './devices.js';
import { T0, T1, useTempStorage } from './test-utils.js';

const KEY = 'q0XrYwM1Xk1vH2C6uWqG5yQyq9b0mW0n8Sx3cG1fYQE';

function device(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: 'dev_1',
    name: 'iPhone',
    platform: 'ios',
    publicKey: KEY,
    permissions: ['session.read', 'session.write', 'workspace.read'],
    createdAt: T0,
    lastSeenAt: T0,
    status: 'active',
    ...overrides,
  };
}

describe('devices', () => {
  const { storage } = useTempStorage();

  it('写入、读回、按公钥找 active 的', () => {
    const db = storage();
    db.devices.insert(device({ pushTokenRef: 'device.dev_1.push' }));
    expect(db.devices.get('dev_1')).toEqual(device({ pushTokenRef: 'device.dev_1.push' }));
    expect(db.devices.findActive(KEY)?.id).toBe('dev_1');
    expect(db.devices.findActive('other')).toBeUndefined();
    expect(db.devices.get('dev_none')).toBeUndefined();
  });

  it('改名称、权限、最近在线；没给的字段不变', () => {
    const db = storage();
    db.devices.insert(device());
    expect(db.devices.update('dev_1', { name: 'Pixel', permissions: ['session.read'] })).toBe(true);
    expect(db.devices.update('dev_1', { lastSeenAt: T1 })).toBe(true);
    expect(db.devices.get('dev_1')).toEqual(
      device({ name: 'Pixel', permissions: ['session.read'], lastSeenAt: T1 }),
    );
    expect(db.devices.update('dev_1', {})).toBe(true);
    expect(db.devices.update('dev_none', { name: 'x' })).toBe(false);
  });

  it('移除：状态改 revoked、清掉推送令牌条目，只做一次', () => {
    const db = storage();
    db.devices.insert(device({ pushTokenRef: 'device.dev_1.push' }));
    expect(db.devices.revoke('dev_1')).toBe(true);
    expect(db.devices.revoke('dev_1')).toBe(false);
    expect(db.devices.get('dev_1')).toEqual(device({ status: 'revoked' }));
    expect(db.devices.findActive(KEY)).toBeUndefined();
  });

  it('同一个公钥只能有一条 active；移除后可以再写一条', () => {
    const db = storage();
    db.devices.insert(device());
    expect(() => db.devices.insert(device({ id: 'dev_2' }))).toThrow(/UNIQUE/);
    db.devices.revoke('dev_1');
    db.devices.insert(device({ id: 'dev_2', createdAt: T1, lastSeenAt: T1 }));
    expect(db.devices.list().map((d) => [d.id, d.status])).toEqual([
      ['dev_1', 'revoked'],
      ['dev_2', 'active'],
    ]);
  });

  it('状态只能是 active 或 revoked', () => {
    const db = storage();
    expect(() => db.devices.insert(device({ status: 'paused' }))).toThrow(/CHECK/);
  });
});
