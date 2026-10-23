import { describe, expect, it } from 'vitest';
import { RELAY_PATHS, RelayCloseCode, relayEndpoint, relayRegistrationMessage } from './index.js';

describe('relayEndpoint', () => {
  it('路径接在中继地址的路径之后，查询参数保留并追加', () => {
    expect(relayEndpoint('wss://relay.example.com', RELAY_PATHS.host)).toBe(
      'wss://relay.example.com/v1/host',
    );
    expect(relayEndpoint('wss://example.com/relay/', '/v1/connect', { route: 'abc' })).toBe(
      'wss://example.com/relay/v1/connect?route=abc',
    );
    expect(relayEndpoint('ws://10.0.0.2:8080/r?k=1', RELAY_PATHS.accept, { id: 'x_y-z' })).toBe(
      'ws://10.0.0.2:8080/r/v1/accept?k=1&id=x_y-z',
    );
  });
});

describe('relayRegistrationMessage', () => {
  it('带用途前缀', () => {
    expect(new TextDecoder().decode(relayRegistrationMessage('n0nce'))).toBe(
      'wevir-relay/1 register\nn0nce',
    );
  });
});

describe('RelayCloseCode', () => {
  it('在 4100–4199，与 Host 的关闭码不重叠', () => {
    for (const code of Object.values(RelayCloseCode)) {
      expect(code).toBeGreaterThanOrEqual(4100);
      expect(code).toBeLessThan(4200);
    }
  });
});
