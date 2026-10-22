// 远程设备与配对（0.107.0，domain-model §3.49）：真实的 Host 与 WebSocket。测试经 `RunningHost.remote.pairing` 扮演远程监听的
// 配对握手（真实 socket 上的握手见 remote/listener.test.ts）：发起配对 → 握手完成后桌面收到请求 → 允许 → 设备写入；移除；受限连接调不了 `device.*` / `pairing.*`，也收不到它们的通知。

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type ClientIdentity,
  DEFAULT_REMOTE_SETTINGS,
  ErrorCode,
  METHOD_NAMES,
  PERMISSIONS,
  type Permission,
  parsePairingUri,
} from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import type { ConnectionGrant } from './permissions.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PHONE_KEY = 'Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg';
const ON = { ...DEFAULT_REMOTE_SETTINGS, enabled: true };

async function setup() {
  const home = join(realpathSync(tempDir()), 'home');
  const grants = new Map<string, ConnectionGrant>();
  const host = await startHost({
    adapter: new EchoAdapter({ stepDelayMs: 1 }),
    engine: 'echo',
    logger: createLogger({ level: 'error', mirror: () => {} }),
    home,
    testConnectionGrant: (client) => grants.get(client.clientId),
  });
  cleanups.push(() => host.shutdown());
  const { token } = JSON.parse(await readFile(join(home, 'run', 'host.json'), 'utf8')) as {
    token: string;
  };
  let count = 0;
  /** 连一个客户端；给了 `permissions` 时它以设备身份、只有这些权限完成 hello。 */
  const connect = async (permissions?: readonly Permission[]) => {
    count += 1;
    const who: ClientIdentity = { deviceId: 'mac', clientId: `c${count}`, clientKind: 'desktop' };
    if (permissions !== undefined) {
      grants.set(who.clientId, { principal: { kind: 'device', deviceId: 'phone' }, permissions });
    }
    const client = await TestRpcClient.connect(host.url);
    cleanups.push(() => client.ws.terminate());
    expect((await client.hello(token, who)).error).toBeUndefined();
    return client;
  };
  return { host, home, connect };
}

describe('设备与配对', () => {
  it('打开远程 → 发起配对 → 握手请求 → 桌面允许 → 设备写入；移除后是 revoked', async () => {
    const { host, home, connect } = await setup();
    const desktop = await connect();
    expect(await desktop.request('device.list')).toEqual({ devices: [] });
    // 远程访问关着时不能配对。
    expect((await desktop.call('pairing.start')).error?.code).toBe(ErrorCode.INVALID_PARAMS);

    await desktop.request('settings.update', { settings: { remote: ON } });
    const offer = await desktop.request('pairing.start');
    const payload = parsePairingUri(offer.uri);
    expect(payload).toMatchObject({ hostPublicKey: offer.hostPublicKey, routeId: offer.routeId });
    // 密钥只在 secrets.json 里。
    const secretsFile = await readFile(join(home, 'secrets.json'), 'utf8');
    expect(secretsFile).toContain('remote.noise-static');

    // 远程监听的替身：收到第一条消息、握手完成后报上设备。
    const attempt = host.remote.pairing.beginAttempt('code');
    expect(attempt).toBeDefined();
    const decision = host.remote.pairing.requestApproval(attempt as never, {
      name: 'iPhone',
      platform: 'ios',
      publicKey: PHONE_KEY,
    });
    const [request] = await desktop.until(
      () => nonEmpty(desktop.notifications('pairing.request')),
      'pairing.request',
    );
    expect(request).toMatchObject({ pairingId: offer.pairingId, name: 'iPhone', platform: 'ios' });

    const { device } = await desktop.request('pairing.respond', {
      requestId: request.requestId,
      allow: true,
    });
    expect(device).toMatchObject({
      name: 'iPhone',
      platform: 'ios',
      publicKey: PHONE_KEY,
      permissions: ['session.read', 'session.write', 'workspace.read'],
      status: 'active',
    });
    expect(await decision).toEqual(device);
    await desktop.until(() => nonEmpty(desktop.notifications('pairing.ended')), 'pairing.ended');
    expect(desktop.notifications('pairing.ended')).toEqual([
      { pairingId: offer.pairingId, reason: 'paired', deviceId: device.id },
    ]);
    await desktop.until(
      () => nonEmpty(desktop.notifications('devices.changed')),
      'devices.changed',
    );
    expect(desktop.notifications('devices.changed').at(-1)).toEqual({ devices: [device] });
    expect(host.remote.devices.findActive(PHONE_KEY)?.id).toBe(device.id);

    const updated = await desktop.request('device.update', {
      id: device.id,
      permissions: ['session.read', 'terminal.write'],
    });
    expect(updated.device.permissions).toEqual(['session.read', 'terminal.write']);
    expect(
      (await desktop.call('device.update', { id: device.id, permissions: ['host.manage'] })).error
        ?.code,
    ).toBe(ErrorCode.INVALID_PARAMS);

    const { device: removed } = await desktop.request('device.revoke', { id: device.id });
    expect(removed.status).toBe('revoked');
    expect((await desktop.request('device.list')).devices).toEqual([removed]);
    expect(host.remote.devices.findActive(PHONE_KEY)).toBeUndefined();
    expect((await desktop.call('device.revoke', { id: 'dev_NONE' })).error?.code).toBe(
      ErrorCode.DEVICE_NOT_FOUND,
    );
  });

  it('取消与关掉远程访问结束窗口；陈旧的请求回 PAIRING_NOT_FOUND', async () => {
    const { connect } = await setup();
    const desktop = await connect();
    await desktop.request('settings.update', { settings: { remote: ON } });
    const first = await desktop.request('pairing.start');
    await desktop.request('pairing.cancel', { pairingId: first.pairingId });
    const second = await desktop.request('pairing.start');
    await desktop.request('settings.update', {
      settings: { remote: { ...ON, enabled: false } },
    });
    await desktop.until(
      () => (desktop.notifications('pairing.ended').length === 2 ? true : undefined),
      'two pairing.ended',
    );
    expect(desktop.notifications('pairing.ended')).toEqual([
      { pairingId: first.pairingId, reason: 'cancelled' },
      { pairingId: second.pairingId, reason: 'cancelled' },
    ]);
    expect(
      (await desktop.call('pairing.respond', { requestId: 'prq_NONE', allow: true })).error?.code,
    ).toBe(ErrorCode.PAIRING_NOT_FOUND);
  });

  it('远程设备调不了任何 device.* / pairing.* / remote.*，即使有全部权限；也收不到它们的通知', async () => {
    const { host, connect } = await setup();
    const desktop = await connect();
    await desktop.request('settings.update', { settings: { remote: ON } });
    const methods = METHOD_NAMES.filter((m) => /^(device|pairing|remote)\./.test(m));
    expect(methods).toHaveLength(7);
    for (const permissions of [['session.read', 'session.write', 'workspace.read'], PERMISSIONS]) {
      const phone = await connect(permissions as Permission[]);
      for (const method of methods) {
        const frame = await phone.call(method, {});
        expect(frame.error?.code, method).toBe(ErrorCode.DEVICE_FORBIDDEN);
        expect(frame.error?.data, method).toEqual({ missing: ['host.manage'] });
      }
    }
    const phone = await connect(PERMISSIONS);
    await phone.request('settings.get');
    await desktop.request('device.list');
    await desktop.request('remote.status');
    await desktop.request('pairing.start');
    host.remote.devices.add({ name: 'Pixel', platform: 'android', publicKey: PHONE_KEY });
    await desktop.until(
      () => nonEmpty(desktop.notifications('devices.changed')),
      'devices.changed',
    );
    await delay(50);
    expect(phone.notifications('devices.changed')).toEqual([]);
    expect(phone.notifications('pairing.ended')).toEqual([]);
    // 远程监听的状态变了（这里是关掉远程）：只有本机连接收到 remote.changed。
    await desktop.request('settings.update', { settings: { remote: { ...ON, enabled: false } } });
    await desktop.until(() => nonEmpty(desktop.notifications('remote.changed')), 'remote.changed');
    expect(phone.notifications('remote.changed')).toEqual([]);
  });
});

function nonEmpty<T>(list: T[]): T[] | undefined {
  return list.length > 0 ? list : undefined;
}
