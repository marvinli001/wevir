// 记下的远程电脑生成哪些路，握手负载里的中继地址怎么记回去。

import type { RemoteRoute } from '@wevir/client-sdk';
import { describe, expect, it } from 'vitest';
import { knownRoutes, nextRelayUrl } from './connect.js';
import type { RemoteHostRecord } from './store.js';

const KEY = 'A'.repeat(43);
const record: RemoteHostRecord = {
  version: 1,
  name: 'office',
  hostPublicKey: KEY,
  routeId: KEY,
  deviceSecretKey: KEY,
  candidates: [{ kind: 'lan', host: '192.168.1.5', port: 47830 }],
  lastAddress: { host: '100.64.0.2', port: 47830 },
  pairedAt: '2026-10-23T00:00:00.000Z',
};
const route = (kind: RemoteRoute['kind']): RemoteRoute => ({
  kind,
  key: kind,
  open: () => ({ send: () => {}, close: () => {} }),
});

describe('knownRoutes', () => {
  it('上次胜出的、候选地址在前，中继（那台电脑给的地址）最后；没有中继地址时没有中继的路', () => {
    expect(knownRoutes(record).map((r) => [r.kind, r.key])).toEqual([
      ['direct', '100.64.0.2:47830'],
      ['direct', '192.168.1.5:47830'],
    ]);
    const relayed = knownRoutes({ ...record, relayUrl: 'wss://relay.example.com/wevir/' });
    expect(relayed.map((r) => [r.kind, r.key]).at(-1)).toEqual([
      'relay',
      'relay.example.com/wevir',
    ]);
  });
});

describe('nextRelayUrl', () => {
  const withRelay = { ...record, relayUrl: 'wss://old.example.com' };

  it('负载里有就用它', () => {
    expect(nextRelayUrl(withRelay, route('direct'), 'wss://new.example.com')).toBe(
      'wss://new.example.com',
    );
    expect(nextRelayUrl(record, route('relay'), 'wss://new.example.com')).toBe(
      'wss://new.example.com',
    );
  });

  it('负载里没有：直连连上时删掉（那台电脑关了中继），经中继连上时留着', () => {
    expect(nextRelayUrl(withRelay, route('direct'), undefined)).toBeUndefined();
    expect(nextRelayUrl(withRelay, route('relay'), undefined)).toBe('wss://old.example.com');
  });
});
