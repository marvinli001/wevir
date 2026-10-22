// 测试共用：十六进制、握手搭建与错误断言。不进构建产物（tsdown 只从 index.ts 出发）。
import { expect } from 'vitest';
import { NoiseError, type NoiseErrorCode } from './errors.js';
import {
  createHandshake,
  type HandshakeState,
  PAIRING_PROTOCOL,
  RECONNECT_PROTOCOL,
} from './handshake.js';
import { generateKeyPair, type KeyPair } from './primitives.js';
import { derivePairingPsk, remotePrologue } from './remote.js';

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`odd hex length: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export const fromUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export interface Peers {
  readonly host: KeyPair;
  readonly device: KeyPair;
}

export function newPeers(): Peers {
  return { host: generateKeyPair(), device: generateKeyPair() };
}

export const PROLOGUE = remotePrologue({ host: 'host-route', device: 'device-route' });

/** 设备（发起方）与 Host（响应方）的配对握手。`code` 不同即模拟输错码。 */
export function pairingPair(
  peers: Peers,
  options: { deviceCode?: string; hostCode?: string; expectedHostKey?: Uint8Array } = {},
): { device: HandshakeState; host: HandshakeState } {
  const deviceCode = options.deviceCode ?? 'K7Q2M9XF';
  const hostCode = options.hostCode ?? deviceCode;
  const expectedHostKey = options.expectedHostKey ?? peers.host.publicKey;
  return {
    device: createHandshake({
      protocol: PAIRING_PROTOCOL,
      initiator: true,
      prologue: PROLOGUE,
      staticKeyPair: peers.device,
      remoteStaticKey: expectedHostKey,
      psk: derivePairingPsk(utf8(deviceCode), expectedHostKey),
    }),
    host: createHandshake({
      protocol: PAIRING_PROTOCOL,
      initiator: false,
      prologue: PROLOGUE,
      staticKeyPair: peers.host,
      psk: derivePairingPsk(utf8(hostCode), peers.host.publicKey),
    }),
  };
}

/** 配对之后的 `IK` 重连，Host 只接受 `known` 里的设备公钥。 */
export function reconnectPair(
  peers: Peers,
  known: readonly Uint8Array[] = [peers.device.publicKey],
): { device: HandshakeState; host: HandshakeState } {
  return {
    device: createHandshake({
      protocol: RECONNECT_PROTOCOL,
      initiator: true,
      prologue: PROLOGUE,
      staticKeyPair: peers.device,
      remoteStaticKey: peers.host.publicKey,
    }),
    host: createHandshake({
      protocol: RECONNECT_PROTOCOL,
      initiator: false,
      prologue: PROLOGUE,
      staticKeyPair: peers.host,
      acceptRemoteStaticKey: (key) => known.some((entry) => toHex(entry) === toHex(key)),
    }),
  };
}

/** 双方交替收发，直到握手结束。 */
export function runHandshake(initiator: HandshakeState, responder: HandshakeState): void {
  let [writer, reader] = [initiator, responder];
  while (!initiator.isComplete || !responder.isComplete) {
    reader.readMessage(writer.writeMessage());
    [writer, reader] = [reader, writer];
  }
}

/** 断言抛出的是指定错误码的 NoiseError。 */
export function expectNoiseError(action: () => unknown, code: NoiseErrorCode): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(NoiseError);
  expect((caught as NoiseError).code).toBe(code);
}
