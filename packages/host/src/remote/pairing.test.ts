import {
  DEFAULT_REMOTE_SETTINGS,
  type Device,
  PAIRING_CODE_ALPHABET,
  type PairingId,
  parsePairingUri,
  type RemoteSettings,
} from '@wevir/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceIdentity } from './devices.js';
import type { RemoteKeys } from './identity.js';
import { type PairingEvent, PairingService } from './pairing.js';

const KEY = 'q0XrYwM1Xk1vH2C6uWqG5yQyq9b0mW0n8Sx3cG1fYQE';
const ROUTE = 'Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg';
const PHONE: DeviceIdentity = { name: 'iPhone', platform: 'ios', publicKey: ROUTE };
const keys: RemoteKeys = {
  noise: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
  route: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
  hostPublicKey: KEY,
  routeId: ROUTE,
};
const ON: RemoteSettings = { ...DEFAULT_REMOTE_SETTINGS, enabled: true };

afterEach(() => {
  vi.useRealTimers();
});

function setup(options: { settings?: RemoteSettings } = {}) {
  vi.useFakeTimers({ now: Date.parse('2026-10-22T08:00:00.000Z') });
  let settings: RemoteSettings | undefined = options.settings ?? ON;
  const added: DeviceIdentity[] = [];
  const pairing = new PairingService({
    identity: { ensure: async () => keys },
    devices: {
      add: (identity) => {
        added.push(identity);
        return { id: 'dev_1', ...identity } as unknown as Device;
      },
    },
    settings: () => settings,
    hostName: 'Mac',
  });
  const events: PairingEvent[] = [];
  pairing.watch((event) => events.push(event));
  const ended = () => events.flatMap((e) => (e.type === 'ended' ? [e.ended] : []));
  return {
    pairing,
    events,
    ended,
    added,
    setSettings: (next: RemoteSettings | undefined) => {
      settings = next;
    },
  };
}

describe('配对窗口', () => {
  it('远程访问关着时不能开窗口', async () => {
    const { pairing } = setup({ settings: DEFAULT_REMOTE_SETTINGS });
    await expect(pairing.start()).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(pairing.pairingId).toBeUndefined();
  });

  it('二维码载荷：Host 公钥、路由 ID、256 位秘密、名称；短码 8 位、32 字符表；5 分钟有效', async () => {
    const { pairing } = setup();
    const offer = await pairing.start();
    expect(offer.expiresAt).toBe('2026-10-22T08:05:00.000Z');
    expect(offer.shortCode).toMatch(new RegExp(`^[${PAIRING_CODE_ALPHABET}]{8}$`));
    expect(offer.candidates).toEqual([]);
    expect(offer.relayUrl).toBeUndefined();
    const payload = parsePairingUri(offer.uri);
    expect(payload).toMatchObject({ hostPublicKey: KEY, routeId: ROUTE, hostName: 'Mac' });
    expect(Buffer.from(payload?.secret ?? '', 'base64url')).toHaveLength(32);
  });

  it('开了中继、填了地址时载荷带上它', async () => {
    const { pairing } = setup({
      settings: { ...ON, relay: { enabled: true, url: 'wss://relay.example.com' } },
    });
    const offer = await pairing.start();
    expect(offer.relayUrl).toBe('wss://relay.example.com');
    expect(parsePairingUri(offer.uri)?.relayUrl).toBe('wss://relay.example.com');
  });

  it('每个窗口的秘密与短码都不同', async () => {
    const { pairing } = setup();
    const offers = [await pairing.start(), await pairing.start(), await pairing.start()];
    expect(new Set(offers.map((o) => parsePairingUri(o.uri)?.secret)).size).toBe(3);
    expect(new Set(offers.map((o) => o.pairingId)).size).toBe(3);
  });

  it('同一时间只有一个窗口：新开的取代旧的', async () => {
    const { pairing, ended } = setup();
    const first = await pairing.start();
    const second = await pairing.start();
    expect(pairing.pairingId).toBe(second.pairingId);
    expect(ended()).toEqual([{ pairingId: first.pairingId, reason: 'replaced' }]);
    // 旧窗口的 ID 取消不了新的。
    pairing.cancel(first.pairingId);
    expect(pairing.pairingId).toBe(second.pairingId);
  });

  it('到期结束，之后不能握手', async () => {
    const { pairing, ended } = setup();
    const offer = await pairing.start();
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(pairing.pairingId).toBe(offer.pairingId);
    vi.advanceTimersByTime(1);
    expect(ended()).toEqual([{ pairingId: offer.pairingId, reason: 'expired' }]);
    expect(pairing.beginAttempt('secret')).toBeUndefined();
  });

  it('取消与关掉远程访问都结束窗口', async () => {
    const { pairing, ended, setSettings } = setup();
    const offer = await pairing.start();
    pairing.cancel();
    expect(ended()).toEqual([{ pairingId: offer.pairingId, reason: 'cancelled' }]);
    pairing.cancel();
    expect(ended()).toHaveLength(1);
    setSettings(undefined);
    await expect(pairing.start()).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });
});

describe('握手与允许', () => {
  it('一个窗口只给一次握手：秘密与短码在第一条消息后都作废', async () => {
    const { pairing } = setup();
    const offer = await pairing.start();
    const attempt = pairing.beginAttempt('code');
    expect(attempt).toMatchObject({ pairingId: offer.pairingId, keys });
    expect(new TextDecoder().decode(attempt?.secret)).toBe(offer.shortCode);
    expect(pairing.beginAttempt('code')).toBeUndefined();
    expect(pairing.beginAttempt('secret')).toBeUndefined();
  });

  it('二维码秘密：给出的是二维码里的那 32 字节', async () => {
    const { pairing } = setup();
    const offer = await pairing.start();
    const attempt = pairing.beginAttempt('secret');
    expect(Buffer.from(attempt?.secret ?? []).toString('base64url')).toBe(
      parsePairingUri(offer.uri)?.secret,
    );
  });

  it('第三条消息 10 秒内没来：窗口以 failed 结束', async () => {
    const { pairing, ended } = setup();
    const offer = await pairing.start();
    const attempt = pairing.beginAttempt('secret');
    vi.advanceTimersByTime(10_000);
    expect(ended()).toEqual([{ pairingId: offer.pairingId, reason: 'failed' }]);
    await expect(pairing.requestApproval(attempt as never, PHONE)).resolves.toBeUndefined();
  });

  it('握手失败：窗口以 failed 结束', async () => {
    const { pairing, ended } = setup();
    const offer = await pairing.start();
    const attempt = pairing.beginAttempt('code');
    pairing.failAttempt(attempt as never);
    expect(ended()).toEqual([{ pairingId: offer.pairingId, reason: 'failed' }]);
  });

  it('请求 → 桌面允许 → 写入设备；请求不再受 10 秒限制', async () => {
    const { pairing, events, added } = setup();
    const offer = await pairing.start();
    const attempt = pairing.beginAttempt('code');
    const decision = pairing.requestApproval(attempt as never, PHONE);
    const request = events.find((e) => e.type === 'request');
    expect(request).toEqual({
      type: 'request',
      request: {
        pairingId: offer.pairingId,
        requestId: expect.stringMatching(/^prq_/),
        name: 'iPhone',
        platform: 'ios',
        requestedAt: '2026-10-22T08:00:00.000Z',
      },
    });
    vi.advanceTimersByTime(60_000);
    const requestId = request?.type === 'request' ? request.request.requestId : 'prq_none';
    const device = pairing.respond(requestId as never, true);
    expect(added).toEqual([PHONE]);
    await expect(decision).resolves.toBe(device);
    expect(events.at(-1)).toEqual({
      type: 'ended',
      ended: { pairingId: offer.pairingId, reason: 'paired', deviceId: 'dev_1' },
    });
    expect(pairing.pairingId).toBeUndefined();
    expect(() => pairing.respond(requestId as never, true)).toThrow(
      expect.objectContaining({ code: 'PAIRING_NOT_FOUND' }),
    );
  });

  it('拒绝或到期：不写设备，等待的握手得到 undefined', async () => {
    const { pairing, events, added, ended } = setup();
    let offer = await pairing.start();
    let decision = pairing.requestApproval(pairing.beginAttempt('code') as never, PHONE);
    const request = events.find((e) => e.type === 'request');
    pairing.respond((request?.type === 'request' && request.request.requestId) as never, false);
    await expect(decision).resolves.toBeUndefined();
    expect(ended().at(-1)).toEqual({ pairingId: offer.pairingId, reason: 'denied' });

    offer = await pairing.start();
    decision = pairing.requestApproval(pairing.beginAttempt('secret') as never, PHONE);
    vi.advanceTimersByTime(5 * 60_000);
    await expect(decision).resolves.toBeUndefined();
    expect(ended().at(-1)).toEqual({ pairingId: offer.pairingId, reason: 'expired' });
    expect(added).toEqual([]);
  });

  it('别的窗口的握手不能请求', async () => {
    const { pairing, events } = setup();
    await pairing.start();
    const stale = pairing.beginAttempt('code');
    await pairing.start();
    await expect(pairing.requestApproval(stale as never, PHONE)).resolves.toBeUndefined();
    expect(events.some((e) => e.type === 'request')).toBe(false);
    expect(() => pairing.respond('prq_NONE' as never, true)).toThrow(
      expect.objectContaining({ code: 'PAIRING_NOT_FOUND' }),
    );
  });

  it('等密钥期间被取消的 start 作废', async () => {
    vi.useFakeTimers();
    let release: (value: RemoteKeys) => void = () => {};
    const pairing = new PairingService({
      identity: { ensure: () => new Promise<RemoteKeys>((resolve) => (release = resolve)) },
      devices: { add: () => ({}) as Device },
      settings: () => ON,
    });
    const started = pairing.start();
    pairing.cancel();
    release(keys);
    await expect(started).rejects.toMatchObject({ code: 'PAIRING_NOT_FOUND' });
    expect(pairing.pairingId as PairingId | undefined).toBeUndefined();
  });
});
