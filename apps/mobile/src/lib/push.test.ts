// 推送的手机一侧：与 Host 共用 packages/noise/test-vectors/push.json（node:crypto 独立生成）核对推送密钥与解密，再测登记的流程
// （验证码、令牌变了重登、电脑上关了清理、退出时解绑、同一时刻只登记一台）与重放、跳转信息。

import { bytesToBase64url } from '@wevir/client-sdk';
import { generateKeyPair, pushCollapseKey, sealPushMessage } from '@wevir/noise';
import type { PushState } from '@wevir/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vectors from '../../../../packages/noise/test-vectors/push.json' with { type: 'json' };
import {
  computerPushKey,
  type DeviceToken,
  openPush,
  PUSH_CODE_TIMEOUT_MS,
  type PushLinkClient,
  PushRegistrar,
  type PushRegistrationStore,
  type PushStatus,
  parsePushData,
  pushContent,
  pushTarget,
  readPushTarget,
  replayGuards,
  type TokenUnavailable,
  targetIntent,
} from './push';

const hex = (text: string) => Uint8Array.from(Buffer.from(text, 'hex'));
const b64 = (text: string) => bytesToBase64url(hex(text));

describe('与 Host 共用的向量', () => {
  const key = computerPushKey(b64(vectors.host_public), {
    secretKey: hex(vectors.device_secret),
    publicKey: hex(vectors.device_public),
  });
  const entries = [{ name: 'mac', routeId: 'r1', key }];

  it('用设备私钥与电脑公钥派生出同一把推送密钥', () => {
    expect(Buffer.from(key).toString('hex')).toBe(vectors.push_key);
  });

  it('逐条解开信封，收起键也一致', () => {
    for (const vector of vectors.vectors) {
      const replay = replayGuards({});
      const opened = openPush(vector.envelope, entries, replay.guard);
      if (vector.plaintext === '') {
        // 空明文不是合法的提醒：解得开、但内容不对。
        expect(opened.kind, vector.name).toBe('invalid');
      } else {
        expect(opened, vector.name).toEqual({
          kind: 'ok',
          computer: { name: 'mac', routeId: 'r1' },
          message: JSON.parse(vector.plaintext),
        });
      }
      expect(pushCollapseKey(key, vector.collapse_key), vector.name).toBe(vector.collapse_key_mac);
    }
  });

  it('重放的、别的电脑的密钥、被改过的都不收', () => {
    const [first] = vectors.vectors;
    if (first === undefined) throw new Error('no vectors');
    const replay = replayGuards({});
    expect(openPush(first.envelope, entries, replay.guard).kind).toBe('ok');
    expect(openPush(first.envelope, entries, replay.guard).kind).toBe('replayed');
    // 重放状态存下再读回来照样拒。
    expect(openPush(first.envelope, entries, replayGuards(replay.save()).guard).kind).toBe(
      'replayed',
    );
    const other = [{ name: 'other', routeId: 'r2', key: new Uint8Array(32).fill(7) }];
    expect(openPush(first.envelope, other, replayGuards({}).guard).kind).toBe('undecryptable');
    const tampered = `${first.envelope.slice(0, -2)}${first.envelope.endsWith('A') ? 'B' : 'A'}A`;
    expect(openPush(tampered, entries, replayGuards({}).guard).kind).toBe('undecryptable');
  });

  it('多台电脑时找到对的那台', () => {
    const [first] = vectors.vectors;
    if (first === undefined) throw new Error('no vectors');
    const many = [{ name: 'other', routeId: 'r2', key: new Uint8Array(32).fill(7) }, ...entries];
    expect(openPush(first.envelope, many, replayGuards({}).guard)).toMatchObject({
      kind: 'ok',
      computer: { name: 'mac' },
    });
  });
});

describe('推送数据与跳转', () => {
  it('只认验证码与加密载荷', () => {
    const code = 'A'.repeat(22);
    expect(parsePushData({ wevir: 'verify', code, dataString: null })).toEqual({
      kind: 'verify',
      code,
    });
    expect(parsePushData({ wevir: 'push', p: 'AQAB-_' })).toEqual({
      kind: 'push',
      payload: 'AQAB-_',
    });
    expect(parsePushData({ wevir: 'verify', code: 'short' })).toBeUndefined();
    expect(parsePushData({ wevir: 'push', p: 'not base64!' })).toBeUndefined();
    expect(parsePushData({ title: 'hi' })).toBeUndefined();
    expect(parsePushData(null)).toBeUndefined();
  });

  it('显示的内容与点开去哪', () => {
    const message = {
      v: 1 as const,
      id: 'approval:apr_1',
      kind: 'approval' as const,
      category: 'action' as const,
      title: ' Fix the build ',
      host: 'Mac',
      sessionId: 'ses_1' as never,
      createdAt: '2026-10-27T00:00:00.000Z',
    };
    expect(pushContent(message, (kind) => `kind:${kind}`)).toEqual({
      title: 'Fix the build',
      subtitle: 'Mac',
      body: 'kind:approval',
    });
    expect(pushContent({ ...message, title: '' }, String).title).toBe('Mac');
    const target = pushTarget({ name: 'mac', routeId: 'r' }, message);
    expect(target).toEqual({ computer: 'mac', sessionId: 'ses_1' });
    expect(readPushTarget({ wevirTarget: target })).toEqual(target);
    expect(readPushTarget({ wevirTarget: { computer: 3 } })).toBeUndefined();
    expect(readPushTarget(undefined)).toBeUndefined();
    expect(targetIntent({ computer: 'mac', channelId: 'chn_1' })).toEqual({ channelId: 'chn_1' });
  });
});

// ── 登记 ───────────────────────────────────────────────────────────

const ROUTE = 'R'.repeat(43);
const TOKEN: DeviceToken = { platform: 'apns_sandbox', token: 'ab'.repeat(32) };

function state(patch: Partial<PushState> = {}): PushState {
  return {
    enabled: true,
    registered: false,
    gatewayUrl: 'http://127.0.0.1:9000',
    routeId: ROUTE,
    ...patch,
  };
}

class FakeClient implements PushLinkClient {
  current: PushState;
  readonly registered: Array<{ platform: string; token: string; code: string }> = [];
  unregistered = 0;
  registerError: unknown;
  readonly listeners = new Set<(state: PushState | undefined) => void>();

  constructor(initial: PushState) {
    this.current = initial;
  }
  async get() {
    return this.current;
  }
  async register(params: {
    platform: 'apns' | 'apns_sandbox' | 'fcm';
    token: string;
    code: string;
  }) {
    if (this.registerError !== undefined) {
      const error = this.registerError;
      this.registerError = undefined;
      throw error;
    }
    this.registered.push(params);
    this.current = { ...this.current, registered: true };
    return this.current;
  }
  async unregister() {
    this.unregistered += 1;
    this.current = { ...this.current, registered: false };
    return this.current;
  }
  onChanged(listener: (state: PushState | undefined) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function memoryStore(): PushRegistrationStore & {
  registrations: Map<string, string>;
  keys: Map<string, Uint8Array>;
} {
  const registrations = new Map<string, string>();
  const keys = new Map<string, Uint8Array>();
  return {
    registrations,
    keys,
    async registration(routeId) {
      return registrations.get(routeId);
    },
    async setRegistration(routeId, value) {
      if (value === undefined) registrations.delete(routeId);
      else registrations.set(routeId, value);
    },
    async saveKey(routeId, key) {
      keys.set(routeId, key);
    },
    async deleteKey(routeId) {
      keys.delete(routeId);
    },
  };
}

function setup(options: { token?: DeviceToken | TokenUnavailable; verifyStatus?: number } = {}) {
  const store = memoryStore();
  const posts: Array<{ url: string; body: unknown }> = [];
  let token: DeviceToken | TokenUnavailable = options.token ?? TOKEN;
  let autoCode = true;
  let codes = 0;
  const registrar: PushRegistrar = new PushRegistrar({
    deviceToken: async () => token,
    post: async (url, body) => {
      posts.push({ url, body: JSON.parse(body) });
      const status = options.verifyStatus ?? 202;
      // 网关先推验证码、再回 202。
      if (status === 202 && autoCode) {
        codes += 1;
        registrar.deliverCode(String(codes).padStart(22, 'c'));
      }
      return {
        status,
        text: async () =>
          status === 202
            ? '{}'
            : JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }),
      };
    },
    pushKey: async () => new Uint8Array(32).fill(1),
    store,
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  return {
    registrar,
    store,
    posts,
    setToken(next: DeviceToken | TokenUnavailable) {
      token = next;
    },
    stopCodes() {
      autoCode = false;
    },
  };
}

const computer = { name: 'mac', routeId: ROUTE };

describe('PushRegistrar', () => {
  it('开着而没登记：要验证码、交给电脑、记下令牌与推送密钥', async () => {
    const { registrar, store, posts } = setup();
    const client = new FakeClient(state());
    expect(await registrar.sync(computer, client)).toEqual({ kind: 'registered' });
    expect(posts).toEqual([
      {
        url: 'http://127.0.0.1:9000/v1/verify',
        body: { routeId: ROUTE, platform: 'apns_sandbox', token: TOKEN.token },
      },
    ]);
    expect(client.registered).toEqual([{ ...TOKEN, code: '1'.padStart(22, 'c') }]);
    expect(store.registrations.get(ROUTE)).toBe(`apns_sandbox:${TOKEN.token}`);
    expect(store.keys.get(ROUTE)).toEqual(new Uint8Array(32).fill(1));
    expect(registrar.status('mac')).toEqual({ kind: 'registered' });
  });

  it('登记过同一个令牌时不再要验证码；令牌变了重登', async () => {
    const { registrar, posts, setToken, store } = setup();
    const client = new FakeClient(state());
    await registrar.sync(computer, client);
    await registrar.sync(computer, client);
    expect(posts).toHaveLength(1);
    setToken({ platform: 'apns_sandbox', token: 'cd'.repeat(32) });
    expect(await registrar.sync(computer, client)).toEqual({ kind: 'registered' });
    expect(posts).toHaveLength(2);
    expect(store.registrations.get(ROUTE)).toBe(`apns_sandbox:${'cd'.repeat(32)}`);
  });

  it('电脑说没在册（网关说令牌失效）时重登', async () => {
    const { registrar, posts } = setup();
    const client = new FakeClient(state());
    await registrar.sync(computer, client);
    await registrar.sync(computer, client, state({ registered: false }));
    expect(posts).toHaveLength(2);
  });

  it('电脑上关了：不问令牌，清掉本机的登记与密钥', async () => {
    const { registrar, store, posts } = setup();
    const client = new FakeClient(state());
    await registrar.sync(computer, client);
    expect(await registrar.sync(computer, client, state({ enabled: false }))).toEqual({
      kind: 'off',
    });
    expect(store.registrations.size).toBe(0);
    expect(store.keys.size).toBe(0);
    expect(posts).toHaveLength(1);
  });

  it('没有通知权限、收不到推送时不登记', async () => {
    const denied = setup({ token: 'denied' });
    expect(await denied.registrar.sync(computer, new FakeClient(state()))).toEqual({
      kind: 'denied',
    });
    const unavailable = setup({ token: 'unavailable' });
    expect(await unavailable.registrar.sync(computer, new FakeClient(state()))).toEqual({
      kind: 'unavailable',
    });
    expect(denied.posts).toHaveLength(0);
  });

  it('网关拒绝、电脑绑定失败时报原因；验证码不对时再要一次', async () => {
    const limited = setup({ verifyStatus: 429 });
    expect(await limited.registrar.sync(computer, new FakeClient(state()))).toEqual({
      kind: 'failed',
      reason: 'gateway',
    });

    const retry = setup();
    const client = new FakeClient(state());
    client.registerError = { code: -32072, data: { reason: 'bad_code' } };
    expect(await retry.registrar.sync(computer, client)).toEqual({ kind: 'registered' });
    expect(retry.posts).toHaveLength(2);

    const host = setup();
    const broken = new FakeClient(state());
    broken.registerError = new Error('boom');
    expect(await host.registrar.sync(computer, broken)).toEqual({ kind: 'failed', reason: 'host' });
  });

  describe('等验证码', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('一直没收到验证码时报 no_code', async () => {
      const { registrar, stopCodes } = setup();
      stopCodes();
      const result = registrar.sync(computer, new FakeClient(state()));
      await vi.advanceTimersByTimeAsync(PUSH_CODE_TIMEOUT_MS + 1);
      expect(await result).toEqual({ kind: 'failed', reason: 'no_code' });
    });
  });

  it('两台电脑同时要登记时一台一台来，各拿各的验证码', async () => {
    const { registrar, posts } = setup();
    const a = new FakeClient(state());
    const b = new FakeClient(state({ routeId: 'S'.repeat(43) }));
    const [ra, rb] = await Promise.all([
      registrar.sync(computer, a),
      registrar.sync({ name: 'studio', routeId: 'S'.repeat(43) }, b),
    ]);
    expect([ra, rb]).toEqual([{ kind: 'registered' }, { kind: 'registered' }]);
    expect(posts.map((p) => (p.body as { routeId: string }).routeId)).toEqual([
      ROUTE,
      'S'.repeat(43),
    ]);
    expect(a.registered[0]?.code).not.toBe(b.registered[0]?.code);
  });

  it('退出电脑：连着时请它解绑，再删本机的登记与密钥', async () => {
    const { registrar, store } = setup();
    const client = new FakeClient(state());
    await registrar.sync(computer, client);
    await registrar.remove(computer, client);
    expect(client.unregistered).toBe(1);
    expect(store.registrations.size).toBe(0);
    expect(store.keys.size).toBe(0);
    expect(registrar.status('mac')).toBeUndefined();
    // 没登记过、或没连着时只清本机。
    await registrar.remove(computer, undefined);
    expect(client.unregistered).toBe(1);
  });

  it('退出电脑时电脑发来的 push.changed 不会又去登记', async () => {
    const { registrar, posts } = setup();
    const client = new FakeClient(state());
    await registrar.sync(computer, client);
    const unregister = client.unregister.bind(client);
    let resync: Promise<PushStatus> | undefined;
    // 电脑解绑后马上发 `push.changed`（registered: false），连接这时还没断。
    client.unregister = async () => {
      const result = await unregister();
      resync = registrar.sync(computer, client, result);
      return result;
    };
    await registrar.remove(computer, client);
    expect(await resync).toEqual({ kind: 'off' });
    expect(posts).toHaveLength(1);
    expect(client.registered).toHaveLength(1);
  });
});

describe('Host 的封装与手机的解密互通', () => {
  it('Host 用设备公钥封的推送，手机用设备私钥解开', () => {
    const host = generateKeyPair();
    const device = generateKeyPair();
    const hostKey = computerPushKey(bytesToBase64url(host.publicKey), device);
    const message = {
      v: 1,
      id: 'completed:trn_1',
      kind: 'completed',
      category: 'completion',
      title: '整理日志',
      host: 'Studio',
      createdAt: '2026-10-27T00:00:00.000Z',
    };
    const payload = sealPushMessage(
      hostKey,
      Date.now(),
      new TextEncoder().encode(JSON.stringify(message)),
    );
    expect(
      openPush(payload, [{ name: 'studio', routeId: 'r', key: hostKey }], replayGuards({}).guard),
    ).toMatchObject({ kind: 'ok', message });
  });
});
