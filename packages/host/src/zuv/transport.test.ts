import { createPublicKey, verify } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '../sync/crypto.js';
import {
  deviceProof,
  newZuvDeviceKey,
  ZuvRequestError,
  ZuvTransport,
  zuvOrigin,
} from './transport.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function server(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
) {
  const instance = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        instance.close((error) => (error ? reject(error) : resolve()));
        instance.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
}

describe('ZUV device transport', () => {
  it('anchors server time to the Date header and a monotonic clock', async () => {
    const serverTime = Date.parse('2026-11-13T00:00:00.000Z');
    let wall = serverTime + 120000;
    const transport = new ZuvTransport({
      origin: 'https://synthetic.invalid',
      now: () => wall,
      fetch: async () =>
        Response.json({}, { headers: { date: new Date(serverTime).toUTCString() } }),
    });
    await transport.request({ method: 'GET', path: '/api/wevir/entitlements' });
    expect(Math.abs(transport.serverNow() - serverTime)).toBeLessThan(1000);
    wall += 3600000;
    expect(Math.abs(transport.serverNow() - serverTime)).toBeLessThan(1000);
  });
  it('paces binary chunks while signing the exact streamed bytes and honoring the transfer deadline', async () => {
    const body = Buffer.alloc(8192, 42);
    const key = newZuvDeviceKey();
    const origin = await server(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const actual = Buffer.concat(chunks);
      expect(actual).toEqual(body);
      const proof = JSON.parse(
        Buffer.from(String(req.headers.dpop).split('.')[1] as string, 'base64url').toString(),
      );
      expect(proof.bht).toBe(sha256(actual));
      expect(req.headers['content-length']).toBe(String(actual.length));
      res.end('{}');
    });
    const transport = new ZuvTransport({ origin, allowLoopback: true });
    const started = performance.now();
    await transport.request({
      method: 'PUT',
      path: '/api/wevir/sync/v1/uploads/upload_fixture',
      body,
      contentType: 'application/octet-stream',
      proof: { key, secret: 'synthetic-token' },
      transfer: { bytesPerSecond: 65536, chunkBytes: 4096, timeoutMs: 1000 },
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(40);
    const blocked = await server((req) => {
      req.resume();
    });
    await expect(
      new ZuvTransport({ origin: blocked, allowLoopback: true }).request({
        method: 'GET',
        path: '/api/wevir/sync/v1/downloads/download_fixture',
        transfer: { bytesPerSecond: 65536, chunkBytes: 4096, timeoutMs: 20 },
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
  it('signs and sends the identical final bytes, a query-free htu and a fresh proof per attempt', async () => {
    const key = newZuvDeviceKey();
    const claims: Array<Record<string, unknown>> = [];
    const token = 'synthetic-access-token';
    const finalBody = Buffer.from('{ "prompt": "合成内容", "after_translation": true }\n');
    const origin = await server(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      expect(bytes).toEqual(finalBody);
      expect(req.headers['content-length']).toBe(String(finalBody.length));
      expect(req.headers.authorization).toBe(`DPoP ${token}`);
      const [head, payload, signature] = String(req.headers.dpop).split('.') as [
        string,
        string,
        string,
      ];
      expect(
        verify(
          null,
          Buffer.from(`${head}.${payload}`),
          createPublicKey({ key: key.publicKey, format: 'jwk' }),
          Buffer.from(signature, 'base64url'),
        ),
      ).toBe(true);
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString());
      expect(value).toMatchObject({
        htm: 'POST',
        htu: `${origin}/api/wevir/v1/responses`,
        bht: sha256(finalBody),
        ath: sha256(token),
        iat: 1234,
      });
      claims.push(value);
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    const transport = new ZuvTransport({ origin, allowLoopback: true, now: () => 1234000 });
    const input = {
      method: 'POST' as const,
      path: '/api/wevir/v1/responses?diagnostic=1',
      body: finalBody,
      proof: { key, secret: token },
    };
    await transport.request(input);
    await transport.request(input);
    expect(claims[0]?.jti).not.toBe(claims[1]?.jti);
    const proof = deviceProof({
      key,
      secret: token,
      method: 'POST',
      url: `${origin}/api/wevir/v1/responses`,
      body: finalBody,
    });
    const bodyClaims = JSON.parse(
      Buffer.from(proof.split('.')[1] as string, 'base64url').toString(),
    );
    expect(bodyClaims.bht).not.toBe(sha256(finalBody.subarray(0, finalBody.length - 1)));
  });

  it('never follows redirects or sends credentials to another origin or route', async () => {
    let sinkCalls = 0;
    const sink = await server((_req, res) => {
      sinkCalls++;
      res.end('{}');
    });
    const origin = await server((_req, res) => {
      res.writeHead(307, { location: `${sink}/api/wevir/stolen` });
      res.end();
    });
    const transport = new ZuvTransport({ origin, allowLoopback: true });
    const proof = { key: newZuvDeviceKey(), secret: 'synthetic-device-token' };
    await expect(
      transport.request({ method: 'GET', path: '/api/wevir/entitlements', proof }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(
      transport.request({ method: 'GET', path: `${sink}/api/wevir/entitlements`, proof }),
    ).rejects.toThrow('invalid ZUV route');
    await expect(
      transport.request({ method: 'GET', path: '/other-provider', proof }),
    ).rejects.toThrow('invalid ZUV route');
    expect(sinkCalls).toBe(0);
    expect(() => zuvOrigin('http://example.com', true)).toThrow();
    expect(() => zuvOrigin('https://name:password@example.com')).toThrow();
    expect(() => zuvOrigin('https://example.com/path')).toThrow();
  });

  it('bounds streamed responses and does not retry a paid attempt', async () => {
    const request = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(33));
              controller.close();
            },
          }),
        ),
    );
    const transport = new ZuvTransport({ origin: 'https://zuv.test', fetch: request });
    await expect(
      transport.request({
        method: 'GET',
        path: '/api/wevir/sync/v1/downloads/download_fixture',
        maxBytes: 32,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('preserves bounded error codes and Retry-After without exposing response content', async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'BUDGET_PAUSED',
              message: 'synthetic server diagnostic',
              retryAfterMs: 3000,
            },
          }),
          { status: 429, headers: { 'retry-after': '10' } },
        ),
    );
    const transport = new ZuvTransport({ origin: 'https://zuv.test', fetch: request });
    await expect(
      transport.request({ method: 'GET', path: '/api/wevir/entitlements' }),
    ).rejects.toMatchObject({
      code: 'BUDGET_PAUSED',
      retryAfterMs: 10000,
      message: 'BUDGET_PAUSED',
    });
    expect(request).toHaveBeenCalledTimes(1);
    const broken = new ZuvTransport({
      origin: 'https://zuv.test',
      fetch: async () => {
        throw new Error('synthetic-secret-token');
      },
    });
    await expect(
      broken.request({ method: 'GET', path: '/api/wevir/entitlements' }),
    ).rejects.toEqual(new ZuvRequestError('NETWORK_ERROR'));
  });
});
