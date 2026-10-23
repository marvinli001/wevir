import { join } from 'node:path';
import type { Device } from '@wevir/protocol';
import { FileSecretStore } from '@wevir/storage';
import { describe, expect, it, vi } from 'vitest';
import { isHostError } from '../errors.js';
import { useStorages, useTempDir } from '../test-utils.js';
import { DeviceService } from './devices.js';

const tempDir = useTempDir();
const storages = useStorages();
const KEY = 'q0XrYwM1Xk1vH2C6uWqG5yQyq9b0mW0n8Sx3cG1fYQE';
const KEY2 = 'Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg';

function setup(options: { webIdleDays?: () => number } = {}) {
  const dir = tempDir();
  const storage = storages.open(join(dir, 'data'));
  const secrets = new FileSecretStore(dir);
  let clock = Date.parse('2026-10-22T08:00:00.000Z');
  const devices = new DeviceService({
    storage,
    secrets,
    now: () => new Date(clock),
    ...(options.webIdleDays !== undefined && { webIdleDays: options.webIdleDays }),
  });
  const changes: Device[][] = [];
  const revoked: string[] = [];
  devices.watch((list) => changes.push(list));
  devices.onRevoked((id) => revoked.push(id));
  return {
    storage,
    secrets,
    devices,
    changes,
    revoked,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

function code(error: unknown): string | undefined {
  return isHostError(error) ? error.code : undefined;
}

describe('DeviceService', () => {
  it('配对允许后写入：默认权限（手机多 workspace.write 与 provider.read），通知全部设备', () => {
    const { devices, changes } = setup();
    const phone = devices.add({ name: 'iPhone', platform: 'ios', publicKey: KEY });
    expect(phone).toMatchObject({
      id: expect.stringMatching(/^dev_/),
      name: 'iPhone',
      platform: 'ios',
      publicKey: KEY,
      permissions: [
        'session.read',
        'session.write',
        'workspace.read',
        'workspace.write',
        'provider.read',
      ],
      createdAt: '2026-10-22T08:00:00.000Z',
      lastSeenAt: '2026-10-22T08:00:00.000Z',
      status: 'active',
    });
    expect(changes).toEqual([[phone]]);
    expect(devices.findActive(KEY)).toEqual(phone);
  });

  it('同一个公钥重新配对：更新名称与平台，保留 ID 与权限', () => {
    const { devices, tick } = setup();
    const phone = devices.add({ name: 'iPhone', platform: 'ios', publicKey: KEY });
    devices.update({ id: phone.id, permissions: ['session.read'] });
    tick(60_000);
    const again = devices.add({ name: 'iPad', platform: 'ios', publicKey: KEY });
    expect(again).toMatchObject({
      id: phone.id,
      name: 'iPad',
      permissions: ['session.read'],
      createdAt: phone.createdAt,
      lastSeenAt: '2026-10-22T08:01:00.000Z',
    });
    expect(devices.list()).toHaveLength(1);
  });

  it('改名称与权限：权限去重、按词表顺序；host.manage 与不认识的权限拒绝', () => {
    const { devices } = setup();
    const phone = devices.add({ name: 'iPhone', platform: 'ios', publicKey: KEY });
    const updated = devices.update({
      id: phone.id,
      name: 'Pixel',
      permissions: ['terminal.write', 'session.read', 'session.read'],
    });
    expect(updated).toMatchObject({
      name: 'Pixel',
      permissions: ['session.read', 'terminal.write'],
    });
    for (const permission of ['host.manage', 'files.everything']) {
      const error = catchSync(() =>
        devices.update({ id: phone.id, permissions: ['session.read', permission] }),
      );
      expect(code(error), permission).toBe('INVALID_PARAMS');
    }
    expect(devices.get(phone.id)?.permissions).toEqual(['session.read', 'terminal.write']);
    expect(code(catchSync(() => devices.update({ id: 'dev_NONE', name: 'x' })))).toBe(
      'DEVICE_NOT_FOUND',
    );
  });

  it('移除：状态 revoked、删推送令牌、通知断开；之后不能改、重复移除原样返回', async () => {
    const { devices, storage, secrets, revoked, changes } = setup();
    const phone = devices.add({ name: 'iPhone', platform: 'ios', publicKey: KEY });
    await secrets.set(`device.${phone.id}.push`, 'apns-token');
    storage.devices.update(phone.id, { pushTokenRef: `device.${phone.id}.push` });

    const removed = await devices.revoke(phone.id);
    expect(removed.status).toBe('revoked');
    expect(await secrets.get(`device.${phone.id}.push`)).toBeUndefined();
    expect(storage.devices.get(phone.id)?.pushTokenRef).toBeUndefined();
    expect(revoked).toEqual([phone.id]);
    expect(changes.at(-1)).toEqual([removed]);
    expect(devices.findActive(KEY)).toBeUndefined();

    expect(await devices.revoke(phone.id)).toEqual(removed);
    expect(revoked).toEqual([phone.id]);
    expect(code(catchSync(() => devices.update({ id: phone.id, name: 'x' })))).toBe(
      'INVALID_PARAMS',
    );
    await expect(devices.revoke('dev_NONE')).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' });

    // 移除后同一个公钥重新配对是新的一条。
    const again = devices.add({ name: 'iPhone', platform: 'ios', publicKey: KEY });
    expect(again.id).not.toBe(phone.id);
    devices.add({ name: 'Android', platform: 'android', publicKey: KEY2 });
    expect(devices.list().map((d) => d.status)).toEqual(['revoked', 'active', 'active']);
  });
});

function catchSync(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('网页设备闲置自动移除（0.117.0）', () => {
  const DAY = 86_400_000;

  it('网页设备只有基本的三项权限；超过天数没在线的网页设备被移除，手机不受影响', async () => {
    let days = 30;
    const { devices, tick, revoked } = setup({ webIdleDays: () => days });
    const web = devices.add({ name: 'Chrome', platform: 'web', publicKey: KEY });
    const phone = devices.add({ name: 'iPhone', platform: 'ios', publicKey: KEY2 });
    expect(web.permissions).toEqual(['session.read', 'session.write', 'workspace.read']);
    expect(phone.permissions).toContain('workspace.write');
    tick(30 * DAY - 1);
    expect(await devices.expireIdle()).toEqual([]);
    tick(1);
    expect(await devices.expireIdle()).toEqual([web.id]);
    expect(revoked).toEqual([web.id]);
    expect(devices.get(web.id)?.status).toBe('revoked');
    expect(devices.get(phone.id)?.status).toBe('active');
    // 已移除的不再算。
    expect(await devices.expireIdle()).toEqual([]);
    days = 0;
    expect(await devices.expireIdle()).toEqual([]);
  });

  it('在线时间会续期；0 是从不', async () => {
    let days = 0;
    const { devices, tick } = setup({ webIdleDays: () => days });
    const web = devices.add({ name: 'Chrome', platform: 'web', publicKey: KEY });
    tick(400 * DAY);
    expect(await devices.expireIdle()).toEqual([]);
    devices.touch(web.id);
    days = 7;
    tick(6 * DAY);
    expect(await devices.expireIdle()).toEqual([]);
    tick(DAY);
    expect(await devices.expireIdle()).toEqual([web.id]);
  });

  it('握手时认出已过期的网页设备：不认它，并移除', async () => {
    const { devices, tick, revoked } = setup({ webIdleDays: () => 1 });
    const web = devices.add({ name: 'Chrome', platform: 'web', publicKey: KEY });
    tick(DAY);
    expect(devices.findActive(KEY)).toBeUndefined();
    await vi.waitFor(() => expect(revoked).toEqual([web.id]));
    expect(devices.get(web.id)?.status).toBe('revoked');
  });

  it('startIdleExpiry 先跑一次，之后按间隔跑', async () => {
    const { devices, tick, revoked } = setup({ webIdleDays: () => 1 });
    const first = devices.add({ name: 'Chrome', platform: 'web', publicKey: KEY });
    tick(DAY);
    const stop = devices.startIdleExpiry(() => {}, 20);
    try {
      await vi.waitFor(() => expect(revoked).toEqual([first.id]));
      const second = devices.add({ name: 'Safari', platform: 'web', publicKey: KEY2 });
      tick(DAY);
      await vi.waitFor(() => expect(revoked).toEqual([first.id, second.id]));
    } finally {
      stop();
    }
  });
});
