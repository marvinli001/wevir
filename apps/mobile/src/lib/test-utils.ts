// 测试用的假数据。

import { bytesToBase64url } from '@wevir/client-sdk';
import { generateKeyPair } from '@wevir/noise';
import { formatPairingUri, type Session } from '@wevir/protocol';
import type { ComputerRecord } from './records';

export function key(): string {
  return bytesToBase64url(generateKeyPair().publicKey);
}

export function record(overrides: Partial<ComputerRecord> = {}): ComputerRecord {
  return {
    version: 1,
    name: 'studio',
    hostName: 'Studio',
    hostPublicKey: key(),
    routeId: key(),
    candidates: [{ kind: 'lan', host: '192.168.1.5', port: 47830 }],
    pairedAt: '2026-10-23T10:00:00.000Z',
    ...overrides,
  };
}

export function session(id: string, updatedAt: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    workspaceId: 'ws_1',
    cwd: '/tmp',
    engine: { kind: 'echo', sessionId: id },
    providerId: 'prov_1',
    modelId: 'echo',
    title: id,
    titleSource: 'user',
    state: 'idle',
    createdAt: updatedAt,
    updatedAt,
    lastSeq: 1,
    ...overrides,
  } as Session;
}

export function pairingLink(options: { relayUrl?: string } = {}): string {
  return formatPairingUri({
    hostPublicKey: key(),
    routeId: key(),
    secret: bytesToBase64url(generateKeyPair().secretKey),
    hostName: 'Studio',
    candidates: [{ host: '192.168.1.5', port: 47830 }],
    ...(options.relayUrl !== undefined && { relayUrl: options.relayUrl }),
  });
}
