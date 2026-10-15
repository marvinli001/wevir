// 自动更新测试用的密钥、清单与假线路（updates/*.test.ts）。

import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { type Fetcher, PROBE_BYTES } from '../updates/feed.js';

/** 测试用的一对密钥：私钥 PEM 与公钥（keys.ts 的写法）。 */
export function testKeyPair(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: Buffer.from(pair.publicKey.export({ format: 'der', type: 'spki' })).toString(
      'base64',
    ),
  };
}

export function signText(text: string, privateKey: string): string {
  return sign(null, Buffer.from(text), createPrivateKey(privateKey)).toString('base64');
}

export function manifestText(version: string, file = `Wevir-${version}-mac-arm64.zip`): string {
  return [
    `version: ${version}`,
    'files:',
    `  - url: ${file}`,
    '    sha512: AAAA',
    '    size: 1000',
    `path: ${file}`,
    'sha512: AAAA',
    "releaseDate: '2026-10-16T00:00:00.000Z'",
    '',
  ].join('\n');
}

/** 假的线路：路径 → 内容，可加延迟；记下请求。 */
export function fakeServer(
  routes: Record<string, string | Uint8Array>,
  options: { delayMs?: Record<string, number>; rangeless?: boolean } = {},
): { fetcher: Fetcher; requests: { url: string; range?: string }[] } {
  const requests: { url: string; range?: string }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    requests.push({
      url,
      ...(init?.headers?.range !== undefined && { range: init.headers.range }),
    });
    const host = new URL(url).origin;
    const delay = options.delayMs?.[host] ?? 0;
    if (delay > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal?.reason ?? new Error('aborted'));
        });
      });
    }
    const body = routes[url];
    if (body === undefined)
      return {
        ok: false,
        status: 404,
        arrayBuffer: async () => new ArrayBuffer(0),
        body: { cancel: async () => {} },
      };
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    const ranged = init?.headers?.range !== undefined && options.rangeless !== true;
    const slice = ranged ? bytes.slice(0, PROBE_BYTES) : bytes;
    return {
      ok: true,
      status: ranged ? 206 : 200,
      arrayBuffer: async () =>
        slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer,
      body: { cancel: async () => {} },
    };
  };
  return { fetcher, requests };
}
