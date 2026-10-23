import { describe, expect, it } from 'vitest';
import { mergeDiscovered, toDiscoveredHost } from './mdns-service';
import type { DiscoveredHost } from './pairing';
import { key } from './test-utils';

describe('mDNS answers', () => {
  const rid = key();
  const pk = key();
  const service = {
    name: rid,
    port: 47830,
    addresses: ['192.168.1.5', 'fe80::1'],
    txt: { v: '1', rid, pk },
  };

  it('reads the route ID and Host key from TXT', () => {
    expect(toDiscoveredHost(service)).toEqual({
      routeId: rid,
      hostPublicKey: pk,
      port: 47830,
      addresses: ['192.168.1.5', 'fe80::1'],
    });
  });

  it('ignores other versions and malformed records', () => {
    expect(toDiscoveredHost({ ...service, txt: { ...service.txt, v: '2' } })).toBeUndefined();
    expect(toDiscoveredHost({ ...service, txt: { v: '1', rid } })).toBeUndefined();
    expect(toDiscoveredHost({ ...service, port: 0 })).toBeUndefined();
  });

  it('merges addresses from repeated answers', () => {
    const first = toDiscoveredHost({ ...service, addresses: ['192.168.1.5'] }) as DiscoveredHost;
    const second = toDiscoveredHost({ ...service, addresses: ['10.0.0.5'] }) as DiscoveredHost;
    expect(mergeDiscovered(first, second)?.addresses).toEqual(['192.168.1.5', '10.0.0.5']);
    expect(mergeDiscovered(first, first)).toBeUndefined();
  });
});
