import {
  ConnectionLostError,
  ConnectTimeoutError,
  RemoteHandshakeError,
  RemoteUnreachableError,
} from '@wevir/client-sdk';
import { generateKeyPair } from '@wevir/noise';
import { describe, expect, it, vi } from 'vitest';
import {
  classifyPairingFailure,
  type DiscoveredHost,
  NoComputerFoundError,
  type PairAttempt,
  type PairingEnvironment,
  type PairingStage,
  pairComputer,
  parsePairingInput,
} from './pairing';
import { key, pairingLink, record } from './test-utils';

function env(overrides: Partial<PairingEnvironment> = {}): PairingEnvironment {
  return {
    browse: async () => [],
    pair: async (attempt) => ({
      route: 'direct',
      address: attempt.target.candidates[0],
      host: {
        protocolVersion: '0.110.0',
        hostName: 'Studio',
        candidates: attempt.target.candidates as never,
      },
    }),
    generateKeyPair,
    now: () => new Date('2026-10-23T12:00:00.000Z'),
    ...overrides,
  };
}

const signal = () => new AbortController().signal;

describe('parsePairingInput', () => {
  it('tells links, codes and garbage apart', () => {
    expect(parsePairingInput(`  ${pairingLink()}\n`).kind).toBe('link');
    expect(parsePairingInput('abcd-efgh')).toEqual({ kind: 'code', code: 'ABCDEFGH' });
    expect(parsePairingInput('wevir://pair?v=9')).toEqual({ kind: 'invalid', reason: 'link' });
    expect(parsePairingInput('hello')).toEqual({ kind: 'invalid', reason: 'input' });
  });
});

describe('pairComputer', () => {
  it('pairs from a link and builds a record named after the computer', async () => {
    const input = parsePairingInput(pairingLink({ relayUrl: 'wss://relay.example.com' }));
    if (input.kind !== 'link') throw new Error('expected a link');
    const stages: PairingStage[] = [];
    const pair = vi.fn(async (attempt: PairAttempt) => {
      attempt.onAwaitingApproval({ protocolVersion: '0.110.0', candidates: [] });
      return {
        route: 'direct' as const,
        address: { host: '192.168.1.5', port: 47830 },
        host: {
          protocolVersion: '0.110.0',
          hostName: "Marvin's Studio",
          candidates: [{ kind: 'lan' as const, host: '192.168.1.5', port: 47830 }],
        },
      };
    });
    const result = await pairComputer(env({ pair }), {
      input,
      existing: [record({ name: 'marvins-studio' })],
      onStage: (s) => stages.push(s),
      signal: signal(),
    });
    expect(pair.mock.calls[0]?.[0]).toMatchObject({
      secret: { kind: 'uri', secret: input.payload.secret },
      rediscover: true,
    });
    expect(stages.map((s) => s.kind)).toEqual(['connecting', 'awaiting_approval']);
    expect(result.record).toMatchObject({
      name: 'marvins-studio-2',
      hostName: "Marvin's Studio",
      hostPublicKey: input.payload.hostPublicKey,
      routeId: input.payload.routeId,
      relayUrl: 'wss://relay.example.com',
      lastRoute: 'direct',
      lastAddress: { host: '192.168.1.5', port: 47830 },
      pairedAt: '2026-10-23T12:00:00.000Z',
    });
    expect(result.previous).toBeUndefined();
  });

  it('keeps the name when the same computer pairs again', async () => {
    const input = parsePairingInput(pairingLink());
    if (input.kind !== 'link') throw new Error('expected a link');
    const previous = record({ name: 'desk', routeId: input.payload.routeId });
    const result = await pairComputer(env(), {
      input,
      existing: [previous],
      onStage: () => {},
      signal: signal(),
    });
    expect(result.record.name).toBe('desk');
    expect(result.previous).toBe(previous);
  });

  it('finds computers by mDNS for a code and moves on from ones that do not answer', async () => {
    const hosts: DiscoveredHost[] = [
      {
        routeId: key(),
        hostPublicKey: key(),
        port: 47830,
        addresses: ['127.0.0.1', '192.168.1.5'],
      },
      { routeId: key(), hostPublicKey: key(), port: 47831, addresses: ['fe80::2', '192.168.1.6'] },
    ];
    const pair = vi.fn(async (attempt: PairAttempt) => {
      if (attempt.target.routeId === hosts[0]?.routeId)
        throw new RemoteUnreachableError(['192.168.1.5:47830']);
      return { route: 'direct' as const, host: { protocolVersion: '0.110.0', candidates: [] } };
    });
    const result = await pairComputer(env({ browse: async () => hosts, pair }), {
      input: { kind: 'code', code: 'ABCDEFGH' },
      existing: [],
      onStage: () => {},
      signal: signal(),
    });
    expect(pair).toHaveBeenCalledTimes(2);
    expect(pair.mock.calls[0]?.[0].target.candidates).toEqual([
      { kind: 'lan', host: '192.168.1.5', port: 47830 },
    ]);
    expect(pair.mock.calls[1]?.[0]).toMatchObject({
      secret: { kind: 'code', code: 'ABCDEFGH' },
      rediscover: false,
    });
    expect(result.record.routeId).toBe(hosts[1]?.routeId);
    expect(result.record.candidates).toEqual([{ kind: 'lan', host: '192.168.1.6', port: 47831 }]);
    expect(result.record.name).toBe('computer');
  });

  it('stops at the first real failure and reports no computer found', async () => {
    const hosts: DiscoveredHost[] = [
      { routeId: key(), hostPublicKey: key(), port: 1, addresses: ['10.0.0.1'] },
      { routeId: key(), hostPublicKey: key(), port: 2, addresses: ['10.0.0.2'] },
    ];
    const pair = vi.fn(async () => {
      throw new RemoteHandshakeError('wrong_secret', '10.0.0.1:1');
    });
    const input = { kind: 'code' as const, code: 'ABCDEFGH' };
    await expect(
      pairComputer(env({ browse: async () => hosts, pair }), {
        input,
        existing: [],
        onStage: () => {},
        signal: signal(),
      }),
    ).rejects.toBeInstanceOf(RemoteHandshakeError);
    expect(pair).toHaveBeenCalledTimes(1);
    await expect(
      pairComputer(env(), { input, existing: [], onStage: () => {}, signal: signal() }),
    ).rejects.toBeInstanceOf(NoComputerFoundError);
  });
});

describe('classifyPairingFailure', () => {
  it('maps client errors to what the screen says', () => {
    expect(classifyPairingFailure(new ConnectionLostError(undefined, 4010))).toEqual({
      kind: 'denied',
    });
    expect(classifyPairingFailure(new RemoteHandshakeError('wrong_secret', 'x'))).toEqual({
      kind: 'wrong_secret',
    });
    expect(classifyPairingFailure(new RemoteHandshakeError('rejected', 'x'))).toEqual({
      kind: 'window_closed',
    });
    expect(classifyPairingFailure(new RemoteHandshakeError('host_mismatch', 'x'))).toEqual({
      kind: 'host_mismatch',
    });
    expect(classifyPairingFailure(new RemoteUnreachableError(['x']))).toEqual({
      kind: 'unreachable',
    });
    expect(classifyPairingFailure(new RemoteUnreachableError(['x'], 'offline'))).toEqual({
      kind: 'relay',
      relay: 'offline',
    });
    expect(classifyPairingFailure(new ConnectTimeoutError(300_000))).toEqual({ kind: 'timeout' });
    expect(classifyPairingFailure(new NoComputerFoundError())).toEqual({ kind: 'none_found' });
    expect(classifyPairingFailure(new Error('boom'))).toEqual({ kind: 'failed' });
  });
});
