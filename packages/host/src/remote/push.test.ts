// 推送的判定（0.112.0）：PushService 在电脑前没人、开关都开着时把意图加密后交给网关；在场、两路开关、合并与限频、令牌的绑定与解绑、
// 移除设备。网关是这里的假客户端；HttpPushGateway 的签名另测。真网关的端到端在 push.e2e.test.ts。

import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  derivePushKey,
  fromBase64Url,
  generateKeyPair,
  openPushMessage,
  pushCollapseKey,
  toBase64Url,
} from '@wevir/noise';
import {
  DEFAULT_REMOTE_SETTINGS,
  type DeviceId,
  type NotificationIntent,
  PUSH_SIGNATURE_HEADER,
  PushMessageSchema,
  pushSignatureMessage,
  type RemoteSettings,
} from '@wevir/protocol';
import { FileSecretStore } from '@wevir/storage';
import { describe, expect, it } from 'vitest';
import { isHostError } from '../errors.js';
import { useStorages, useTempDir } from '../test-utils.js';
import { DeviceService } from './devices.js';
import { RemoteIdentity } from './identity.js';
import {
  HttpPushGateway,
  type PushGatewayClient,
  type PushGatewayResult,
  PushService,
  pushCategory,
} from './push.js';

const tempDir = useTempDir();
const storages = useStorages();
const TOKEN = 'a1b2c3d4'.repeat(8);
const CODE = 'AAAAAAAAAAAAAAAAAAAAAA';
const SES = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR';
const SES2 = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQS';

type GatewayCall =
  | { kind: 'bind'; platform: string; token: string; code: string }
  | { kind: 'unbind'; platform: string; token: string }
  | {
      kind: 'send';
      platform: string;
      token: string;
      payload: string;
      collapseKey: string;
      expiresAt: number;
    };

function fakeGateway() {
  const calls: GatewayCall[] = [];
  const next: Partial<Record<GatewayCall['kind'], PushGatewayResult>> = {};
  const gateway: PushGatewayClient = {
    url: 'https://push.example.com',
    bind: async (request) => {
      calls.push({ kind: 'bind', ...request });
      return next.bind ?? { ok: true };
    },
    unbind: async (request) => {
      calls.push({ kind: 'unbind', ...request });
      return next.unbind ?? { ok: true };
    },
    send: async (request) => {
      calls.push({ kind: 'send', ...request });
      return next.send ?? { ok: true };
    },
  };
  return { gateway, calls, next, sends: () => calls.filter((call) => call.kind === 'send') };
}

function intent(overrides: Partial<NotificationIntent> = {}): NotificationIntent {
  return {
    id: `approval:apr_${Math.random().toString(36).slice(2, 10)}`,
    kind: 'approval',
    sessionId: SES as NotificationIntent['sessionId'],
    title: 'Fix the build',
    body: 'npm test',
    createdAt: new Date().toISOString(),
    collapseKey: `session:${SES}`,
    ...overrides,
  };
}

async function until(check: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

async function setup(options: { coalesceMs?: number; maxPerHour?: number } = {}) {
  const dir = tempDir();
  const storage = storages.open(join(dir, 'data'));
  const secrets = new FileSecretStore(dir);
  const devices = new DeviceService({ storage, secrets });
  const identity = new RemoteIdentity({ secrets });
  const keys = await identity.ensure();
  let remote: RemoteSettings = {
    ...DEFAULT_REMOTE_SETTINGS,
    enabled: true,
    push: { enabled: true },
  };
  const listeners = new Set<(intent: NotificationIntent) => void>();
  let atComputer = false;
  const { gateway, calls, next, sends } = fakeGateway();
  const changed: DeviceId[] = [];
  const push = new PushService({
    settings: () => remote,
    devices,
    identity,
    notifications: {
      watch: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    presence: { atComputer: () => atComputer },
    gateway,
    hostName: 'Studio Mac',
    coalesceMs: options.coalesceMs ?? 100,
    ...(options.maxPerHour !== undefined && { maxPerHour: options.maxPerHour }),
  });
  push.onDeviceChange((id) => changed.push(id));

  /** 配对一台手机，打开推送并报上令牌。 */
  async function phone(name = 'iPhone', token = TOKEN) {
    const pair = generateKeyPair();
    const device = devices.add({ name, platform: 'ios', publicKey: toBase64Url(pair.publicKey) });
    await push.setDeviceEnabled(device.id, true);
    await push.register(device.id, { platform: 'apns', token, code: CODE });
    return { device, pair };
  }

  /** 设备用自己的私钥解开一次 send。 */
  function open(pair: { secretKey: Uint8Array; publicKey: Uint8Array }, payload: string) {
    const key = derivePushKey({
      secretKey: pair.secretKey,
      publicKey: keys.noise.publicKey,
      hostPublicKey: keys.noise.publicKey,
      devicePublicKey: pair.publicKey,
    });
    const opened = openPushMessage(key, payload);
    return {
      key,
      counter: opened.counter,
      message: PushMessageSchema.parse(JSON.parse(new TextDecoder().decode(opened.plaintext))),
    };
  }

  return {
    storage,
    devices,
    keys,
    push,
    calls,
    next,
    sends,
    changed,
    phone,
    open,
    emit: (value: NotificationIntent) => {
      for (const listener of listeners) listener(value);
    },
    setRemote: (value: RemoteSettings) => {
      remote = value;
      push.refresh();
    },
    remote: () => remote,
    present: (value: boolean) => {
      atComputer = value;
    },
  };
}

describe('pushCategory', () => {
  it('两路开关的归类', () => {
    expect(pushCategory(intent({ kind: 'approval' }))).toBe('action');
    expect(pushCategory(intent({ kind: 'question' }))).toBe('action');
    expect(pushCategory(intent({ kind: 'failed' }))).toBe('action');
    expect(pushCategory(intent({ kind: 'completed' }))).toBe('completion');
    expect(pushCategory(intent({ kind: 'automation', automationStatus: 'waiting' }))).toBe(
      'action',
    );
    expect(pushCategory(intent({ kind: 'automation', automationStatus: 'failed' }))).toBe('action');
    expect(pushCategory(intent({ kind: 'automation', automationStatus: 'completed' }))).toBe(
      'completion',
    );
  });
});

describe('PushService：发不发', () => {
  it('电脑前没人：加密后交给网关，设备解得开，内容只有显示要的字段', async () => {
    const t = await setup();
    const { pair } = await t.phone();
    expect(t.calls[0]).toEqual({ kind: 'bind', platform: 'apns', token: TOKEN, code: CODE });
    const event = intent({ workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR' as never });
    const before = Date.now();
    t.emit(event);
    await until(() => t.sends().length === 1, 'send');
    const send = t.sends()[0] as Extract<GatewayCall, { kind: 'send' }>;
    expect(send.token).toBe(TOKEN);
    expect(send.expiresAt).toBeGreaterThan(Date.now() + 50 * 60_000);
    const { key, counter, message } = t.open(pair, send.payload);
    expect(counter).toBeGreaterThanOrEqual(before);
    expect(message).toEqual({
      v: 1,
      id: event.id,
      kind: 'approval',
      category: 'action',
      title: 'Fix the build',
      host: 'Studio Mac',
      sessionId: SES,
      workspaceId: 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR',
      createdAt: event.createdAt,
    });
    // 收起键是推送密钥下的 HMAC：网关看不出会话；正文（body）不进载荷。
    expect(send.collapseKey).toBe(pushCollapseKey(key, event.collapseKey));
    expect(send.collapseKey).not.toContain(SES);
    expect(JSON.stringify(message)).not.toContain('npm test');
  });

  it('计数只增不减，写在库里', async () => {
    const t = await setup({ coalesceMs: 0 });
    const { device, pair } = await t.phone();
    t.emit(intent({ collapseKey: 'session:a' }));
    t.emit(intent({ collapseKey: 'session:b' }));
    await until(() => t.sends().length === 2, 'two sends');
    const counters = t
      .sends()
      .map(
        (send) => t.open(pair, (send as Extract<GatewayCall, { kind: 'send' }>).payload).counter,
      );
    expect(counters[1]).toBeGreaterThan(counters[0] as number);
    expect(t.storage.devices.get(device.id)?.pushCounter).toBe(Math.max(...counters));
  });

  it('有人在电脑前不推', async () => {
    const t = await setup();
    await t.phone();
    t.present(true);
    t.emit(intent());
    await settle();
    expect(t.sends()).toEqual([]);
  });

  it('总开关、远程、设备开关关着，或没有 session.read、没报令牌时不推', async () => {
    const t = await setup();
    const { device } = await t.phone();
    const other = t.devices.add({
      name: 'Pixel',
      platform: 'android',
      publicKey: toBase64Url(generateKeyPair().publicKey),
    });
    await t.push.setDeviceEnabled(other.id, true);

    t.setRemote({ ...t.remote(), enabled: false });
    t.emit(intent());
    t.setRemote({ ...t.remote(), enabled: true });
    t.devices.update({ id: device.id, permissions: ['workspace.read'] });
    t.emit(intent({ collapseKey: 'session:x' }));
    await settle();
    expect(t.sends()).toEqual([]);

    t.devices.update({ id: device.id, permissions: ['session.read'] });
    t.emit(intent({ collapseKey: 'session:y' }));
    await until(() => t.sends().length === 1, 'send after granting session.read');
    // Pixel 开了推送但没报令牌：一直没发给它。
    expect(t.sends().every((send) => send.token === TOKEN)).toBe(true);

    await t.push.setDeviceEnabled(device.id, false);
    t.emit(intent({ collapseKey: 'session:z' }));
    await settle();
    expect(t.sends()).toHaveLength(1);
  });

  it('两路开关：needsAction 关掉只挡需要操作的，completion 关掉只挡完成的', async () => {
    const t = await setup({ coalesceMs: 0 });
    await t.phone();
    t.setRemote({ ...t.remote(), push: { enabled: true, needsAction: false } });
    t.emit(intent({ kind: 'approval', collapseKey: 'session:1' }));
    t.emit(intent({ kind: 'automation', automationStatus: 'waiting', collapseKey: 'a:1' }));
    t.emit(intent({ kind: 'completed', collapseKey: 'session:2' }));
    await until(() => t.sends().length === 1, 'completed only');
    t.setRemote({ ...t.remote(), push: { enabled: true, completion: false } });
    t.emit(intent({ kind: 'completed', collapseKey: 'session:3' }));
    t.emit(intent({ kind: 'automation', automationStatus: 'completed', collapseKey: 'a:2' }));
    t.emit(intent({ kind: 'question', collapseKey: 'session:4' }));
    await until(() => t.sends().length === 2, 'question only');
    await settle();
    expect(t.sends()).toHaveLength(2);
  });
});

describe('PushService：合并与限频', () => {
  it('同一会话在间隔里的只留最新一条，到时再发；别的会话不受影响', async () => {
    const t = await setup({ coalesceMs: 150 });
    const { pair } = await t.phone();
    t.emit(intent({ id: 'approval:apr_1' }));
    t.emit(intent({ id: 'approval:apr_2' }));
    t.emit(intent({ id: 'question:qst_3', kind: 'question' }));
    t.emit(
      intent({ id: 'approval:apr_9', collapseKey: `session:${SES2}`, sessionId: SES2 as never }),
    );
    await until(() => t.sends().length === 2, 'first two');
    await until(() => t.sends().length === 3, 'coalesced one', 1000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const ids = t
      .sends()
      .map(
        (send) => t.open(pair, (send as Extract<GatewayCall, { kind: 'send' }>).payload).message.id,
      );
    expect(ids).toEqual(['approval:apr_1', 'approval:apr_9', 'question:qst_3']);
  });

  it('等着的那条到时有人在电脑前了就不发', async () => {
    const t = await setup({ coalesceMs: 100 });
    await t.phone();
    t.emit(intent());
    t.emit(intent());
    await until(() => t.sends().length === 1, 'first');
    t.present(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(t.sends()).toHaveLength(1);
  });

  it('每台设备每小时有上限', async () => {
    const t = await setup({ coalesceMs: 0, maxPerHour: 2 });
    await t.phone();
    for (const n of [1, 2, 3]) t.emit(intent({ collapseKey: `session:${n}` }));
    await until(() => t.sends().length === 2, 'two sends');
    await settle();
    expect(t.sends()).toHaveLength(2);
  });
});

describe('PushService：令牌', () => {
  it('推送关着时 register 不连网关，状态说没开', async () => {
    const t = await setup();
    const device = t.devices.add({
      name: 'iPhone',
      platform: 'ios',
      publicKey: toBase64Url(generateKeyPair().publicKey),
    });
    const state = await t.push.register(device.id, { platform: 'apns', token: TOKEN, code: CODE });
    expect(state).toEqual({
      enabled: false,
      registered: false,
      gatewayUrl: 'https://push.example.com',
      routeId: t.keys.routeId,
    });
    expect(t.calls).toEqual([]);
  });

  it('网关拒绝验证码时不存令牌，回 PUSH_GATEWAY_ERROR', async () => {
    const t = await setup();
    const device = t.devices.add({
      name: 'iPhone',
      platform: 'ios',
      publicKey: toBase64Url(generateKeyPair().publicKey),
    });
    await t.push.setDeviceEnabled(device.id, true);
    t.next.bind = { ok: false, error: 'bad_code', message: 'verification code is wrong' };
    const error = await t.push
      .register(device.id, { platform: 'apns', token: TOKEN, code: CODE })
      .catch((e: unknown) => e);
    expect(isHostError(error, 'PUSH_GATEWAY_ERROR') && error.data).toEqual({ reason: 'bad_code' });
    expect(await t.devices.pushToken(device.id)).toBeUndefined();
    expect(t.push.status()?.state).toBe('idle');

    t.next.bind = { ok: false, error: 'unreachable', message: 'fetch failed' };
    const down = await t.push
      .register(device.id, { platform: 'apns', token: TOKEN, code: CODE })
      .catch((e: unknown) => e);
    expect(isHostError(down, 'PUSH_GATEWAY_ERROR') && down.data).toEqual({ reason: 'unreachable' });
    expect(t.push.status()).toMatchObject({
      state: 'unavailable',
      error: { reason: 'unreachable', message: 'fetch failed' },
    });
  });

  it('换了令牌：存新的、解绑旧的；设备撤回时删掉并解绑', async () => {
    const t = await setup();
    const { device } = await t.phone();
    expect(t.devices.get(device.id)?.push).toEqual({ enabled: true, registered: true });
    await t.push.register(device.id, { platform: 'apns', token: `${TOKEN}ff`, code: CODE });
    await settle();
    expect(t.calls.filter((call) => call.kind === 'unbind')).toEqual([
      { kind: 'unbind', platform: 'apns', token: TOKEN },
    ]);
    expect((await t.devices.pushToken(device.id))?.token).toBe(`${TOKEN}ff`);
    const state = await t.push.unregister(device.id);
    expect(state.registered).toBe(false);
    await settle();
    expect(t.calls.at(-1)).toEqual({ kind: 'unbind', platform: 'apns', token: `${TOKEN}ff` });
  });

  it('移除设备：令牌删掉、向网关解绑、不再推', async () => {
    const t = await setup();
    const { device } = await t.phone();
    await t.devices.revoke(device.id);
    await settle();
    expect(t.calls.at(-1)).toEqual({ kind: 'unbind', platform: 'apns', token: TOKEN });
    expect(await t.devices.pushToken(device.id)).toBeUndefined();
    t.emit(intent());
    await settle();
    expect(t.sends()).toEqual([]);
  });

  it('关掉总开关：全部令牌删掉并解绑，设备收到变化', async () => {
    const t = await setup();
    const { device } = await t.phone();
    t.changed.length = 0;
    t.setRemote({ ...t.remote(), push: { enabled: false } });
    await until(() => t.calls.some((call) => call.kind === 'unbind'), 'unbind');
    expect(await t.devices.pushToken(device.id)).toBeUndefined();
    expect(t.push.status()).toBeUndefined();
    expect(t.changed).toContain(device.id);
    expect((await t.push.stateFor(device.id)).enabled).toBe(false);
  });

  it('网关说令牌失效：删掉，设备看到没报过', async () => {
    const t = await setup();
    const { device } = await t.phone();
    t.next.send = { ok: false, error: 'unregistered', message: 'gone' };
    t.emit(intent());
    await until(() => t.devices.get(device.id)?.push?.registered === false, 'token removed');
    // 令牌层面的拒绝不算网关出问题。
    expect(t.push.status()?.state).toBe('ok');
    expect(t.changed).toContain(device.id);
  });

  it('网关连不上只记在状态里，下一次成功就恢复', async () => {
    const t = await setup({ coalesceMs: 0 });
    await t.phone();
    t.next.send = { ok: false, error: 'unreachable', message: 'connect ECONNREFUSED' };
    t.emit(intent({ collapseKey: 'session:1' }));
    await until(() => t.push.status()?.state === 'unavailable', 'unavailable');
    expect(t.push.status()).toMatchObject({ devices: 1, error: { reason: 'unreachable' } });
    t.next.send = { ok: true };
    t.emit(intent({ collapseKey: 'session:2' }));
    await until(() => t.push.status()?.state === 'ok', 'ok again');
    expect(t.push.status()?.lastSentAt).toEqual(expect.any(String));
  });
});

describe('HttpPushGateway', () => {
  it('请求体带路由 ID、时间戳与随机数，签名对得上；错误码按网关的', async () => {
    const dir = tempDir();
    const identity = new RemoteIdentity({ secrets: new FileSecretStore(dir) });
    const keys = await identity.ensure();
    const seen: { url: string; body: Uint8Array; signature: string }[] = [];
    let reply = new Response('{}', { status: 200 });
    const gateway = new HttpPushGateway({
      url: 'https://push.example.com/',
      identity,
      fetch: async (url, init) => {
        seen.push({
          url: String(url),
          body: init?.body as Uint8Array,
          signature:
            (init?.headers as Record<string, string> | undefined)?.[PUSH_SIGNATURE_HEADER] ?? '',
        });
        return reply;
      },
    });
    expect(await gateway.unbind({ platform: 'fcm', token: TOKEN })).toEqual({ ok: true });
    const request = seen[0];
    expect(request?.url).toBe('https://push.example.com/v1/unbind');
    const body = JSON.parse(new TextDecoder().decode(request?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ routeId: keys.routeId, platform: 'fcm', token: TOKEN });
    expect(Math.abs(Date.now() - (body.timestamp as number))).toBeLessThan(5000);
    expect(body.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(
      ed25519.verify(
        fromBase64Url(request?.signature ?? ''),
        pushSignatureMessage('/v1/unbind', request?.body as Uint8Array),
        keys.route.publicKey,
      ),
    ).toBe(true);

    reply = new Response(JSON.stringify({ error: { code: 'not_bound', message: 'no' } }), {
      status: 404,
    });
    expect(
      await gateway.send({
        platform: 'apns',
        token: TOKEN,
        payload: 'AQ',
        collapseKey: 'k',
        expiresAt: 1,
      }),
    ).toEqual({ ok: false, error: 'not_bound', message: 'no' });
    reply = new Response('<html>bad gateway</html>', { status: 502 });
    expect(await gateway.bind({ platform: 'apns', token: TOKEN, code: CODE })).toEqual({
      ok: false,
      error: 'unreachable',
      message: 'HTTP 502',
    });
    const offline = new HttpPushGateway({
      url: 'http://127.0.0.1:1',
      identity,
    });
    expect(await offline.unbind({ platform: 'apns', token: TOKEN })).toMatchObject({
      ok: false,
      error: 'unreachable',
    });
  });
});
