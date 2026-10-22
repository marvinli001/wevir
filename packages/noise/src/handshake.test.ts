import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CipherState, MAX_NONCE } from './cipher-state.js';
import {
  createHandshake,
  type HandshakeState,
  PAIRING_PROTOCOL,
  RECONNECT_PROTOCOL,
} from './handshake.js';
import {
  generateKeyPair,
  type NoisePrimitives,
  noblePrimitives,
  randomBytes,
} from './primitives.js';
import { derivePairingPsk } from './remote.js';
import {
  expectNoiseError,
  fromHex,
  fromUtf8,
  newPeers,
  PROLOGUE,
  pairingPair,
  reconnectPair,
  runHandshake,
  toHex,
  utf8,
} from './test-utils.js';

const LOW_ORDER_POINTS = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
  '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
];

function transportPair(device: HandshakeState, host: HandshakeState) {
  return { device: device.split(), host: host.split() };
}

describe('pairing and reconnect', () => {
  it('pairs with XXpsk2, then reconnects with IK using the learned keys', () => {
    const peers = newPeers();
    const pairing = pairingPair(peers);
    const message1 = pairing.device.writeMessage();
    expect(pairing.host.readMessage(message1)).toEqual(new Uint8Array(0));
    const message2 = pairing.host.writeMessage(utf8('{"host":"studio"}'));
    expect(fromUtf8(pairing.device.readMessage(message2))).toBe('{"host":"studio"}');
    expect(toHex(pairing.device.remoteStaticKey ?? new Uint8Array())).toBe(
      toHex(peers.host.publicKey),
    );
    const message3 = pairing.device.writeMessage(utf8('{"name":"Pixel","platform":"android"}'));
    expect(fromUtf8(pairing.host.readMessage(message3))).toBe(
      '{"name":"Pixel","platform":"android"}',
    );
    expect(toHex(pairing.host.remoteStaticKey ?? new Uint8Array())).toBe(
      toHex(peers.device.publicKey),
    );
    expect(pairing.device.isComplete && pairing.host.isComplete).toBe(true);
    expect(toHex(pairing.device.handshakeHash)).toBe(toHex(pairing.host.handshakeHash));

    const paired = transportPair(pairing.device, pairing.host);
    const ciphertext = paired.device.send.encryptWithAd(new Uint8Array(0), utf8('ping'));
    expect(fromUtf8(paired.host.receive.decryptWithAd(new Uint8Array(0), ciphertext))).toBe('ping');

    const reconnect = reconnectPair(peers);
    runHandshake(reconnect.device, reconnect.host);
    const session = transportPair(reconnect.device, reconnect.host);
    const reply = session.host.send.encryptWithAd(new Uint8Array(0), utf8('pong'));
    expect(fromUtf8(session.device.receive.decryptWithAd(new Uint8Array(0), reply))).toBe('pong');
    // 每次连接都是新的临时密钥：同样的明文得到不同的密文。
    expect(toHex(session.device.send.encryptWithAd(new Uint8Array(0), utf8('ping')))).not.toBe(
      toHex(ciphertext),
    );
  });

  it('interoperates with replaced primitives (no native HMAC)', () => {
    const peers = newPeers();
    const withoutHmac: NoisePrimitives = { ...noblePrimitives, hmac: undefined };
    const device = createHandshake({
      protocol: RECONNECT_PROTOCOL,
      initiator: true,
      prologue: PROLOGUE,
      staticKeyPair: peers.device,
      remoteStaticKey: peers.host.publicKey,
      primitives: withoutHmac,
    });
    const { host } = reconnectPair(peers);
    runHandshake(device, host);
    expect(toHex(device.handshakeHash)).toBe(toHex(host.handshakeHash));
  });
});

describe('handshake failures', () => {
  it('rejects a wrong pairing code when reading the second message and stays failed', () => {
    const pairing = pairingPair(newPeers(), { deviceCode: 'K7Q2M9XF', hostCode: 'K7Q2M9XG' });
    pairing.host.readMessage(pairing.device.writeMessage());
    const message2 = pairing.host.writeMessage();
    expectNoiseError(() => pairing.device.readMessage(message2), 'decrypt_failed');
    expectNoiseError(() => pairing.device.writeMessage(), 'invalid_state');
  });

  it('disconnects when the host presents a static key other than the one in the QR code', () => {
    const peers = newPeers();
    const pairing = pairingPair(peers, { expectedHostKey: generateKeyPair().publicKey });
    pairing.host.readMessage(pairing.device.writeMessage());
    expectNoiseError(
      () => pairing.device.readMessage(pairing.host.writeMessage()),
      'remote_key_rejected',
    );
  });

  it('rejects an unknown device static key in IK before reading the payload', () => {
    const peers = newPeers();
    const reconnect = reconnectPair(peers, [generateKeyPair().publicKey]);
    expectNoiseError(
      () => reconnect.host.readMessage(reconnect.device.writeMessage(utf8('hello'))),
      'remote_key_rejected',
    );
    expectNoiseError(() => reconnect.host.writeMessage(), 'invalid_state');
  });

  it('fails on a mismatched prologue (changed route ids)', () => {
    const peers = newPeers();
    const device = createHandshake({
      protocol: RECONNECT_PROTOCOL,
      initiator: true,
      prologue: utf8('wevir-remote/1 other route'),
      staticKeyPair: peers.device,
      remoteStaticKey: peers.host.publicKey,
    });
    const { host } = reconnectPair(peers);
    expectNoiseError(() => host.readMessage(device.writeMessage()), 'decrypt_failed');
  });

  it('fails on a tampered handshake message', () => {
    const pairing = pairingPair(newPeers());
    pairing.host.readMessage(pairing.device.writeMessage());
    const message2 = pairing.host.writeMessage();
    message2[40] = (message2[40] ?? 0) ^ 1;
    expectNoiseError(() => pairing.device.readMessage(message2), 'decrypt_failed');
  });

  it('fails on a truncated or oversized handshake message', () => {
    const peers = newPeers();
    const first = reconnectPair(peers);
    expectNoiseError(
      () => first.host.readMessage(first.device.writeMessage().subarray(0, 40)),
      'bad_message',
    );
    const second = reconnectPair(peers);
    expectNoiseError(() => second.host.readMessage(new Uint8Array(65536)), 'bad_message');
  });

  it.each(LOW_ORDER_POINTS)('rejects the low-order point %s as a remote ephemeral key', (point) => {
    const peers = newPeers();
    const { host } = reconnectPair(peers);
    const message = new Uint8Array(32 + 48 + 16);
    message.set(fromHex(point));
    expectNoiseError(() => host.readMessage(message), 'invalid_key');
  });

  it.each(LOW_ORDER_POINTS)(
    'rejects the low-order point %s as the known responder static key',
    (point) => {
      const device = createHandshake({
        protocol: RECONNECT_PROTOCOL,
        initiator: true,
        prologue: PROLOGUE,
        staticKeyPair: generateKeyPair(),
        remoteStaticKey: fromHex(point),
      });
      expectNoiseError(() => device.writeMessage(), 'invalid_key');
    },
  );

  it('checks for an all-zero DH result itself when the primitives do not', () => {
    const peers = newPeers();
    const lenient: NoisePrimitives = { ...noblePrimitives, dh: () => new Uint8Array(32) };
    const device = createHandshake({
      protocol: RECONNECT_PROTOCOL,
      initiator: true,
      prologue: PROLOGUE,
      staticKeyPair: peers.device,
      remoteStaticKey: peers.host.publicKey,
      primitives: lenient,
    });
    expectNoiseError(() => device.writeMessage(), 'invalid_key');
  });

  it('enforces turns and a single split', () => {
    const reconnect = reconnectPair(newPeers());
    expectNoiseError(() => reconnect.host.writeMessage(), 'invalid_state');
    expectNoiseError(() => reconnect.device.split(), 'invalid_state');
    runHandshake(reconnect.device, reconnect.host);
    expectNoiseError(() => reconnect.device.writeMessage(), 'invalid_state');
    expectNoiseError(() => reconnect.device.readMessage(new Uint8Array(48)), 'invalid_state');
    reconnect.device.split();
    expectNoiseError(() => reconnect.device.split(), 'invalid_state');
  });

  it('validates the options of the two exported protocols', () => {
    const peers = newPeers();
    const base = { prologue: PROLOGUE, staticKeyPair: peers.device };
    expectNoiseError(
      () => createHandshake({ ...base, protocol: PAIRING_PROTOCOL, initiator: true }),
      'invalid_key',
    );
    expectNoiseError(
      () =>
        createHandshake({
          ...base,
          protocol: PAIRING_PROTOCOL,
          initiator: true,
          psk: new Uint8Array(16),
        }),
      'invalid_key',
    );
    expectNoiseError(
      () => createHandshake({ ...base, protocol: RECONNECT_PROTOCOL, initiator: true }),
      'invalid_key',
    );
    expectNoiseError(
      () =>
        createHandshake({
          ...base,
          protocol: RECONNECT_PROTOCOL,
          initiator: false,
          psk: derivePairingPsk(utf8('code'), peers.host.publicKey),
        }),
      'invalid_key',
    );
    expectNoiseError(
      () =>
        createHandshake({
          ...base,
          protocol: 'Noise_NN_25519_ChaChaPoly_SHA256' as typeof PAIRING_PROTOCOL,
          initiator: true,
        }),
      'invalid_state',
    );
  });
});

describe('transport', () => {
  function connected() {
    const reconnect = reconnectPair(newPeers());
    runHandshake(reconnect.device, reconnect.host);
    return transportPair(reconnect.device, reconnect.host);
  }

  it('rejects a replayed message and stays failed', () => {
    const { device, host } = connected();
    const message = device.send.encryptWithAd(new Uint8Array(0), utf8('a'));
    host.receive.decryptWithAd(new Uint8Array(0), message);
    expectNoiseError(
      () => host.receive.decryptWithAd(new Uint8Array(0), message),
      'decrypt_failed',
    );
    const next = device.send.encryptWithAd(new Uint8Array(0), utf8('b'));
    expectNoiseError(() => host.receive.decryptWithAd(new Uint8Array(0), next), 'invalid_state');
  });

  it('rejects a tampered message', () => {
    const { device, host } = connected();
    const message = device.send.encryptWithAd(new Uint8Array(0), utf8('approve'));
    message[0] = (message[0] ?? 0) ^ 0x80;
    expectNoiseError(
      () => host.receive.decryptWithAd(new Uint8Array(0), message),
      'decrypt_failed',
    );
  });

  it('rejects messages delivered out of order', () => {
    const { device, host } = connected();
    device.send.encryptWithAd(new Uint8Array(0), utf8('first'));
    const second = device.send.encryptWithAd(new Uint8Array(0), utf8('second'));
    expectNoiseError(() => host.receive.decryptWithAd(new Uint8Array(0), second), 'decrypt_failed');
  });

  it('does not accept a message sealed for the other direction', () => {
    const { device } = connected();
    const message = device.send.encryptWithAd(new Uint8Array(0), utf8('loop'));
    expectNoiseError(
      () => device.receive.decryptWithAd(new Uint8Array(0), message),
      'decrypt_failed',
    );
  });
});

describe('CipherState', () => {
  const key = fromHex('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');

  it('encodes the counter as 4 zero bytes and 8 little-endian bytes', () => {
    const nonce = 2 ** 32 + 5;
    const cipher = new CipherState(noblePrimitives, key, nonce);
    const expected = chacha20poly1305(
      key,
      fromHex('000000000500000001000000'),
      new Uint8Array(0),
    ).encrypt(utf8('x'));
    expect(toHex(cipher.encryptWithAd(new Uint8Array(0), utf8('x')))).toBe(toHex(expected));
    expect(cipher.nonce).toBe(nonce + 1);
  });

  it('stops before the nonce reaches 2^53', () => {
    const cipher = new CipherState(noblePrimitives, key, MAX_NONCE - 1);
    cipher.encryptWithAd(new Uint8Array(0), utf8('last'));
    expectNoiseError(
      () => cipher.encryptWithAd(new Uint8Array(0), utf8('one more')),
      'nonce_exhausted',
    );
    const receiver = new CipherState(noblePrimitives, key, MAX_NONCE);
    expectNoiseError(
      () => receiver.decryptWithAd(new Uint8Array(0), new Uint8Array(17)),
      'nonce_exhausted',
    );
  });

  it('refuses plaintext that does not fit one Noise message', () => {
    const cipher = new CipherState(noblePrimitives, key);
    expect(cipher.encryptWithAd(new Uint8Array(0), new Uint8Array(65519))).toHaveLength(65535);
    expectNoiseError(
      () => cipher.encryptWithAd(new Uint8Array(0), new Uint8Array(65520)),
      'bad_message',
    );
  });
});

describe('randomness', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails clearly without globalThis.crypto.getRandomValues', () => {
    vi.stubGlobal('crypto', undefined);
    expectNoiseError(() => generateKeyPair(), 'no_random');
    expectNoiseError(() => randomBytes(32), 'no_random');
  });
});
