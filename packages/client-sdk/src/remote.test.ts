// 远程隧道的路怎么排：直连先、中继在直连的先手之后，同一个 key 只试一次。用假的路，不握手、不联网。

import { generateKeyPair } from '@wevir/noise';
import { describe, expect, it } from 'vitest';
import { RemoteUnreachableError } from './errors.js';
import {
  base64urlToBytes,
  bytesToBase64url,
  type RemoteLinkHandlers,
  type RemoteRoute,
  remoteTransport,
} from './remote.js';
import type { TransportCloseInfo } from './transport.js';

const HOST = {
  hostPublicKey: bytesToBase64url(generateKeyPair().publicKey),
  routeId: bytesToBase64url(generateKeyPair().publicKey),
};

/** 一条假的路：`open` 时记下时刻，`failAfterMs` 后连不上（不给就一直挂着）。 */
function fakeRoute(
  kind: RemoteRoute['kind'],
  key: string,
  opened: { key: string; at: number }[],
  failAfterMs?: number,
): RemoteRoute {
  return {
    kind,
    key,
    open: (_path, handlers: RemoteLinkHandlers) => {
      opened.push({ key, at: performance.now() });
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        handlers.onClose({ code: 1006, reason: 'refused' });
      };
      if (failAfterMs !== undefined) setTimeout(close, failAfterMs);
      return { send: () => {}, close };
    },
  };
}

function connectOnce(routes: RemoteRoute[], fallbackDelayMs: number): Promise<TransportCloseInfo> {
  const factory = remoteTransport({
    host: HOST,
    device: generateKeyPair(),
    routes: () => routes,
    fallbackDelayMs,
  });
  return new Promise((resolve) => {
    factory('wevir-remote:', {
      onOpen: () => {},
      onMessage: () => {},
      onClose: resolve,
    });
  });
}

describe('远程隧道的路', () => {
  it('直连都连不上时中继立刻开始；同一个 key 只试一次；全部失败报 RemoteUnreachableError', async () => {
    const opened: { key: string; at: number }[] = [];
    const start = performance.now();
    const info = await connectOnce(
      [
        fakeRoute('relay', 'relay', opened, 5),
        fakeRoute('direct', 'a', opened, 5),
        fakeRoute('direct', 'a', opened, 5),
        fakeRoute('direct', 'b', opened, 10),
      ],
      10_000,
    );
    expect(opened.map((o) => o.key)).toEqual(['a', 'b', 'relay']);
    expect(performance.now() - start).toBeLessThan(1_000);
    expect(info.cause).toBeInstanceOf(RemoteUnreachableError);
    expect((info.cause as RemoteUnreachableError).tried).toEqual(['a', 'b', 'relay']);
  });

  it('直连还挂着时，中继等到先手用完才开始', async () => {
    const opened: { key: string; at: number }[] = [];
    const start = performance.now();
    const info = connectOnce(
      [fakeRoute('direct', 'slow', opened, 300), fakeRoute('relay', 'relay', opened, 5)],
      100,
    );
    await info;
    const relay = opened.find((o) => o.key === 'relay');
    expect(opened[0]?.key).toBe('slow');
    expect((relay?.at ?? 0) - start).toBeGreaterThanOrEqual(90);
    expect((relay?.at ?? 0) - start).toBeLessThan(300);
  });

  it('base64url 编解码往返', () => {
    for (const length of [0, 1, 2, 3, 31, 32, 33]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff);
      const text = bytesToBase64url(bytes);
      expect(text).toBe(Buffer.from(bytes).toString('base64url'));
      expect(base64urlToBytes(text)).toEqual(bytes);
    }
    expect(() => base64urlToBytes('a+b')).toThrow();
  });
});
