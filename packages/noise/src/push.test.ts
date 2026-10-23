// 推送载荷的加密：test-vectors/push.json（pushgen.mjs 用 node:crypto 独立生成）逐条比对派生的密钥、信封与收起键，再加负面用例与重放窗口。
import { describe, expect, it } from 'vitest';
import vectors from '../test-vectors/push.json' with { type: 'json' };
import { generateKeyPair, publicKeyFromSecretKey } from './primitives.js';
import {
  derivePushKey,
  fromBase64Url,
  openPushMessage,
  openPushPayload,
  PUSH_MAX_PLAINTEXT_LENGTH,
  PushReplayGuard,
  pushCollapseKey,
  sealPushMessage,
  sealPushPayload,
  toBase64Url,
} from './push.js';
import { expectNoiseError, fromHex, fromUtf8, toHex, utf8 } from './test-utils.js';

const hostSecret = fromHex(vectors.host_secret);
const deviceSecret = fromHex(vectors.device_secret);
const hostPublic = fromHex(vectors.host_public);
const devicePublic = fromHex(vectors.device_public);

const hostKey = () =>
  derivePushKey({
    secretKey: hostSecret,
    publicKey: devicePublic,
    hostPublicKey: hostPublic,
    devicePublicKey: devicePublic,
  });
const deviceKey = () =>
  derivePushKey({
    secretKey: deviceSecret,
    publicKey: hostPublic,
    hostPublicKey: hostPublic,
    devicePublicKey: devicePublic,
  });

describe('推送密钥', () => {
  it('公钥与向量一致，Host 与设备派生出同一把密钥', () => {
    expect(toHex(publicKeyFromSecretKey(hostSecret))).toBe(vectors.host_public);
    expect(toHex(publicKeyFromSecretKey(deviceSecret))).toBe(vectors.device_public);
    expect(toHex(hostKey())).toBe(vectors.push_key);
    expect(toHex(deviceKey())).toBe(vectors.push_key);
  });

  it('换了一方的公钥就是另一把密钥', () => {
    const other = generateKeyPair();
    const key = derivePushKey({
      secretKey: hostSecret,
      publicKey: other.publicKey,
      hostPublicKey: hostPublic,
      devicePublicKey: other.publicKey,
    });
    expect(toHex(key)).not.toBe(vectors.push_key);
  });

  it('低阶点与长度不对的密钥报错', () => {
    expectNoiseError(
      () =>
        derivePushKey({
          secretKey: hostSecret,
          publicKey: new Uint8Array(32),
          hostPublicKey: hostPublic,
          devicePublicKey: new Uint8Array(32),
        }),
      'invalid_key',
    );
    expectNoiseError(
      () =>
        derivePushKey({
          secretKey: hostSecret.subarray(1),
          publicKey: devicePublic,
          hostPublicKey: hostPublic,
          devicePublicKey: devicePublic,
        }),
      'invalid_key',
    );
  });
});

describe.each(vectors.vectors)('向量：$name', (vector) => {
  it('加密出同样的信封，设备解得开', () => {
    expect(sealPushMessage(hostKey(), vector.counter, utf8(vector.plaintext))).toBe(
      vector.envelope,
    );
    const opened = openPushMessage(deviceKey(), vector.envelope);
    expect(opened.counter).toBe(vector.counter);
    expect(fromUtf8(opened.plaintext)).toBe(vector.plaintext);
  });

  it('收起键', () => {
    expect(pushCollapseKey(hostKey(), vector.collapse_key)).toBe(vector.collapse_key_mac);
  });
});

describe('信封的负面用例', () => {
  const key = hostKey();
  const envelope = sealPushPayload(key, 42, utf8('hello'));

  it('改了任何一个字节都解不开', () => {
    for (let index = 0; index < envelope.length; index++) {
      const tampered = envelope.slice();
      tampered[index] = (tampered[index] ?? 0) ^ 1;
      let failed = false;
      try {
        openPushPayload(key, tampered);
      } catch {
        failed = true;
      }
      expect(failed, `byte ${index}`).toBe(true);
    }
  });

  it('别的密钥解不开；太短、版本不认识的信封是 bad_message', () => {
    const other = new Uint8Array(32).fill(7);
    expectNoiseError(() => openPushPayload(other, envelope), 'decrypt_failed');
    expectNoiseError(() => openPushPayload(key, envelope.subarray(0, 24)), 'bad_message');
    const v2 = envelope.slice();
    v2[0] = 2;
    expectNoiseError(() => openPushPayload(key, v2), 'bad_message');
  });

  it('计数要是 1 到 2^53 - 1 的整数，明文有上限', () => {
    expectNoiseError(() => sealPushPayload(key, 0, utf8('x')), 'nonce_exhausted');
    expectNoiseError(() => sealPushPayload(key, 1.5, utf8('x')), 'nonce_exhausted');
    expectNoiseError(() => sealPushPayload(key, 2 ** 53, utf8('x')), 'nonce_exhausted');
    expectNoiseError(
      () => sealPushPayload(key, 1, new Uint8Array(PUSH_MAX_PLAINTEXT_LENGTH + 1)),
      'frame_too_large',
    );
  });

  it('信封头里超过 2^53 - 1 的计数不接受', () => {
    const forged = envelope.slice();
    forged.set([0xff, 0xff, 0xff, 0xff], 1);
    expectNoiseError(() => openPushPayload(key, forged), 'bad_message');
  });

  it('base64url 往返，坏字符报错', () => {
    for (const length of [0, 1, 2, 3, 4, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff);
      expect(toHex(fromBase64Url(toBase64Url(bytes)))).toBe(toHex(bytes));
    }
    expectNoiseError(() => fromBase64Url('AB+C'), 'bad_message');
    expectNoiseError(() => fromBase64Url('ABCDE'), 'bad_message');
  });
});

describe('PushReplayGuard', () => {
  it('同一个计数只收一次，乱序在窗口里照收', () => {
    const guard = new PushReplayGuard({ window: 100 });
    expect(guard.accept(50)).toBe(true);
    expect(guard.accept(50)).toBe(false);
    expect(guard.accept(40)).toBe(true);
    expect(guard.accept(120)).toBe(true);
    expect(guard.accept(40)).toBe(false);
    // 120 - 100 = 20：不大于它的不收。
    expect(guard.accept(20)).toBe(false);
    expect(guard.accept(21)).toBe(true);
    expect(guard.accept(0)).toBe(false);
  });

  it('状态存起来再读回来，接着拦重放', () => {
    const guard = new PushReplayGuard();
    expect(guard.accept(1_792_368_000_000)).toBe(true);
    const restored = new PushReplayGuard({ state: guard.state() });
    expect(restored.accept(1_792_368_000_000)).toBe(false);
    expect(restored.accept(1_792_368_000_001)).toBe(true);
  });

  it('记满时丢最小的，被丢掉的之后也不收', () => {
    const guard = new PushReplayGuard({ window: 1_000_000 });
    for (let counter = 1; counter <= 1025; counter++) expect(guard.accept(counter)).toBe(true);
    expect(guard.state().seen).toHaveLength(1024);
    expect(guard.state().floor).toBe(2);
    expect(guard.accept(1)).toBe(false);
    expect(guard.accept(2)).toBe(false);
    expect(guard.accept(2000)).toBe(true);
  });
});
