import { describe, expect, it } from 'vitest';
import {
  isComputerRecord,
  knownCandidates,
  nextRelayUrl,
  recordAfterConnect,
  slugifyHostName,
  uniqueName,
  usableAddress,
} from './records';
import { record } from './test-utils';

describe('computer records', () => {
  it('validates the stored shape (the CLI record without the device key)', () => {
    const r = record({ relayUrl: 'wss://relay.example.com', lastRoute: 'relay' });
    expect(isComputerRecord(JSON.parse(JSON.stringify(r)))).toBe(true);
    expect(isComputerRecord({ ...r, version: 2 })).toBe(false);
    expect(isComputerRecord({ ...r, name: 'Bad Name' })).toBe(false);
    expect(isComputerRecord({ ...r, routeId: 'short' })).toBe(false);
    expect(isComputerRecord({ ...r, relayUrl: 'http://relay' })).toBe(false);
    expect(isComputerRecord({ ...r, candidates: [{ host: '', port: 1 }] })).toBe(false);
    expect(isComputerRecord({ ...r, lastRoute: 'carrier-pigeon' })).toBe(false);
  });

  it('names records like the CLI', () => {
    expect(slugifyHostName("Marvin's MacBook Pro")).toBe('marvins-macbook-pro');
    expect(slugifyHostName('电脑')).toBe('computer');
    expect(uniqueName('studio', new Set(['studio', 'studio-2']))).toBe('studio-3');
    expect(uniqueName('a'.repeat(32), new Set(['a'.repeat(32)]))).toHaveLength(32);
  });

  it('drops loopback and link-local addresses from discovery', () => {
    expect(usableAddress('192.168.1.5')).toBe('192.168.1.5');
    expect(usableAddress('fd7a:115c:a1e0::1')).toBe('fd7a:115c:a1e0::1');
    expect(usableAddress('[fe80::1%en0]')).toBeUndefined();
    expect(usableAddress('127.0.0.1')).toBeUndefined();
    expect(usableAddress('::1')).toBeUndefined();
    expect(usableAddress('169.254.3.4')).toBeUndefined();
  });

  it('tries the last winning address first, without duplicates', () => {
    const r = record({
      lastAddress: { host: '100.64.0.2', port: 47830 },
      candidates: [
        { kind: 'lan', host: '192.168.1.5', port: 47830 },
        { kind: 'tailscale', host: '100.64.0.2', port: 47830 },
      ],
    });
    expect(knownCandidates(r).map((c) => c.host)).toEqual(['100.64.0.2', '192.168.1.5']);
  });

  it('keeps the relay unless a direct connection says it is gone', () => {
    expect(nextRelayUrl({ relayUrl: 'wss://a' }, 'relay', undefined)).toBe('wss://a');
    expect(nextRelayUrl({ relayUrl: 'wss://a' }, 'direct', undefined)).toBeUndefined();
    expect(nextRelayUrl({}, 'direct', 'wss://b')).toBe('wss://b');
  });

  it('records what a handshake told us and clears the removed mark', () => {
    const before = record({ removedAt: '2026-10-23T09:00:00.000Z', relayUrl: 'wss://a' });
    const after = recordAfterConnect(
      before,
      {
        route: 'direct',
        address: { host: '192.168.1.9', port: 47830 },
        host: {
          protocolVersion: '0.110.0',
          hostName: 'Studio 2',
          candidates: [{ kind: 'lan', host: '192.168.1.9', port: 47830 }],
        },
      },
      new Date('2026-10-23T12:00:00.000Z'),
    );
    expect(after).toMatchObject({
      hostName: 'Studio 2',
      lastAddress: { host: '192.168.1.9', port: 47830 },
      lastRoute: 'direct',
      lastConnectedAt: '2026-10-23T12:00:00.000Z',
      candidates: [{ kind: 'lan', host: '192.168.1.9', port: 47830 }],
    });
    expect(after.removedAt).toBeUndefined();
    expect(after.relayUrl).toBeUndefined();
    expect(isComputerRecord(after)).toBe(true);
  });
});
