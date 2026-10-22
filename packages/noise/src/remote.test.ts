import { describe, expect, it } from 'vitest';
import { createHandshake, PAIRING_PROTOCOL } from './handshake.js';
import { generateKeyPair } from './primitives.js';
import { derivePairingPsk, REMOTE_PROTOCOL_VERSION, remotePrologue } from './remote.js';
import { expectNoiseError, fromHex, runHandshake, toHex, utf8 } from './test-utils.js';

describe('remotePrologue', () => {
  it('writes the version, a zero byte and length-prefixed route ids', () => {
    expect(REMOTE_PROTOCOL_VERSION).toBe('wevir-remote/1');
    expect(toHex(remotePrologue({ host: 'ab', device: 'c' }))).toBe(
      `${toHex(utf8('wevir-remote/1'))}00` + `0002${toHex(utf8('ab'))}` + `0001${toHex(utf8('c'))}`,
    );
    expect(toHex(remotePrologue({ host: 'ab' }))).toBe(
      `${toHex(utf8('wevir-remote/1'))}00` + `0002${toHex(utf8('ab'))}0000`,
    );
  });

  it('keeps different route splits apart', () => {
    expect(toHex(remotePrologue({ host: 'ab', device: 'c' }))).not.toBe(
      toHex(remotePrologue({ host: 'a', device: 'bc' })),
    );
    expect(toHex(remotePrologue({ host: 'ab', device: '' }))).toBe(
      toHex(remotePrologue({ host: 'ab' })),
    );
  });

  it('rejects a route id longer than 65535 bytes', () => {
    expectNoiseError(() => remotePrologue({ host: 'x'.repeat(65536) }), 'bad_message');
  });
});

describe('derivePairingPsk', () => {
  const hostKey = fromHex('9a3e4d1c2b6f7a8e0d5c4b3a29181706f5e4d3c2b1a09f8e7d6c5b4a39281716');

  it('matches HKDF-SHA256 from Web Crypto', async () => {
    const secret = utf8('K7Q2M9XF');
    const material = await globalThis.crypto.subtle.importKey('raw', secret, 'HKDF', false, [
      'deriveBits',
    ]);
    const bits = await globalThis.crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: hostKey, info: utf8('wevir-remote/1 pairing psk') },
      material,
      256,
    );
    expect(toHex(derivePairingPsk(secret, hostKey))).toBe(toHex(new Uint8Array(bits)));
  });

  it('depends on both the secret and the host key', () => {
    const psk = toHex(derivePairingPsk(utf8('K7Q2M9XF'), hostKey));
    expect(derivePairingPsk(utf8('K7Q2M9XF'), hostKey)).toHaveLength(32);
    expect(toHex(derivePairingPsk(utf8('K7Q2M9XG'), hostKey))).not.toBe(psk);
    expect(toHex(derivePairingPsk(utf8('K7Q2M9XF'), generateKeyPair().publicKey))).not.toBe(psk);
  });

  it('rejects an empty secret or a malformed host key', () => {
    expectNoiseError(() => derivePairingPsk(new Uint8Array(0), hostKey), 'invalid_key');
    expectNoiseError(() => derivePairingPsk(utf8('code'), new Uint8Array(31)), 'invalid_key');
  });

  it('pairs with a 128-bit QR secret, prologue and psk from these helpers', () => {
    const host = generateKeyPair();
    const device = generateKeyPair();
    const secret = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const prologue = remotePrologue({ host: 'host-route' });
    const initiator = createHandshake({
      protocol: PAIRING_PROTOCOL,
      initiator: true,
      prologue,
      staticKeyPair: device,
      remoteStaticKey: host.publicKey,
      psk: derivePairingPsk(secret, host.publicKey),
    });
    const responder = createHandshake({
      protocol: PAIRING_PROTOCOL,
      initiator: false,
      prologue,
      staticKeyPair: host,
      psk: derivePairingPsk(secret, host.publicKey),
    });
    runHandshake(initiator, responder);
    expect(toHex(initiator.handshakeHash)).toBe(toHex(responder.handshakeHash));
  });
});
