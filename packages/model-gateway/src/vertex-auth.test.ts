import { verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { vertexAccount, vertexKeys } from './test-fixtures/vertex.js';
import { GOOGLE_TOKEN_URL, VertexAuthError, VertexTokenCache } from './vertex-auth.js';

function deferredResponse() {
  let resolve: (response: Response) => void = () => {};
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const signal = () => new AbortController().signal;
const token = (value = 'test-access-token', expires = 3600) =>
  Response.json({ access_token: value, token_type: 'Bearer', expires_in: expires });
afterEach(() => vi.useRealTimers());

describe('Vertex 服务账号 JWT bearer', () => {
  it('RS256 签名、scope 与 aud 正确，并发等待共用一个交换', async () => {
    const deferred = deferredResponse();
    const send = vi.fn<typeof fetch>().mockReturnValue(deferred.promise);
    const now = 1_800_000_000_000;
    const auth = new VertexTokenCache({ fetch: send, now: () => now });
    try {
      const first = auth.get(vertexAccount(), signal());
      const second = auth.get(vertexAccount(), signal());
      expect(send).toHaveBeenCalledTimes(1);
      const [url, init] = send.mock.calls[0] ?? [];
      expect(url).toBe(GOOGLE_TOKEN_URL);
      expect(init?.redirect).toBe('error');
      const params = init?.body as URLSearchParams;
      expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      const parts = (params.get('assertion') ?? '').split('.');
      const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString());
      expect(decode(parts[0] ?? '')).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'test-key' });
      expect(decode(parts[1] ?? '')).toEqual({
        iss: 'agent@vertex-example.iam.gserviceaccount.com',
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: GOOGLE_TOKEN_URL,
        iat: now / 1000,
        exp: now / 1000 + 3600,
      });
      expect(
        verify(
          'RSA-SHA256',
          Buffer.from(parts.slice(0, 2).join('.')),
          vertexKeys.publicKey,
          Buffer.from(parts[2] ?? '', 'base64url'),
        ),
      ).toBe(true);
      deferred.resolve(token());
      expect(await Promise.all([first, second])).toEqual([
        'test-access-token',
        'test-access-token',
      ]);
      expect(await auth.get(vertexAccount(), signal())).toBe('test-access-token');
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      auth.close();
    }
  });

  it('到期前五分钟刷新、并发共用刷新，换凭据与删除后不复用旧令牌', async () => {
    let now = 1_800_000_000_000;
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => token(`token-${send.mock.calls.length}`));
    const auth = new VertexTokenCache({ fetch: send, now: () => now });
    try {
      expect(await auth.get(vertexAccount(), signal())).toBe('token-1');
      now += 3300_000;
      expect(
        await Promise.all([
          auth.get(vertexAccount(), signal()),
          auth.get(vertexAccount(), signal()),
        ]),
      ).toEqual(['token-2', 'token-2']);
      expect(await auth.get(vertexAccount('rotated'), signal())).toBe('token-3');
      auth.retain([]);
      expect(await auth.get(vertexAccount(), signal())).toBe('token-4');
    } finally {
      auth.close();
    }
  });

  it('取消一个等待者不取消另一请求的令牌交换', async () => {
    const pending = deferredResponse();
    const send = vi.fn<typeof fetch>().mockReturnValue(pending.promise);
    const auth = new VertexTokenCache({ fetch: send });
    const cancelled = new AbortController();
    const a = auth.get(vertexAccount(), cancelled.signal);
    const b = auth.get(vertexAccount(), signal());
    const rejected = expect(a).rejects.toThrow('cancelled');
    cancelled.abort(new Error('cancelled'));
    await rejected;
    expect(send.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    pending.resolve(token());
    expect(await b).toBe('test-access-token');
    auth.close();
  });

  it('提前刷新失败时不回退旧令牌，下一次可以重新交换', async () => {
    let now = 1_800_000_000_000;
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(token('old-token'))
      .mockRejectedValueOnce(new Error('mock failure'))
      .mockResolvedValueOnce(token('new-token'));
    const auth = new VertexTokenCache({ fetch: send, now: () => now });
    try {
      expect(await auth.get(vertexAccount(), signal())).toBe('old-token');
      now += 3300_000;
      await expect(auth.get(vertexAccount(), signal())).rejects.toThrow(VertexAuthError);
      expect(await auth.get(vertexAccount(), signal())).toBe('new-token');
    } finally {
      auth.close();
    }
  });

  it.each([
    'not json',
    '{}',
    JSON.stringify({ type: 'service_account', client_email: 'a@b', private_key: 'not a key' }),
    JSON.stringify({
      type: 'service_account',
      client_email: 'a@b',
      private_key: 'secret',
      token_uri: 'https://untrusted.example/token',
    }),
  ])('无效凭据不联网、不把 JSON 片段带进错误', async (json) => {
    const send = vi.fn<typeof fetch>();
    const auth = new VertexTokenCache({ fetch: send });
    await expect(auth.get(json, signal())).rejects.toThrow(VertexAuthError);
    expect(send).not.toHaveBeenCalled();
    auth.close();
  });

  it('认证失败不缓存，也不回显服务端的私钥或令牌', async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(vertexAccount(), { status: 400 }))
      .mockResolvedValueOnce(token());
    const auth = new VertexTokenCache({ fetch: send });
    const error = await auth.get(vertexAccount(), signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VertexAuthError);
    expect(String(error)).not.toContain('PRIVATE KEY');
    expect(await auth.get(vertexAccount(), signal())).toBe('test-access-token');
    auth.close();
  });

  it.each(['timeout', 'close'])('%s 中断交换，请求以 auth 失败且不泄露底层原文', async (mode) => {
    vi.useFakeTimers();
    const send: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error(vertexAccount())), {
          once: true,
        }),
      );
    const auth = new VertexTokenCache({ fetch: send, timeoutMs: 50 });
    const pending = expect(auth.get(vertexAccount(), signal())).rejects.toThrow(VertexAuthError);
    if (mode === 'close') auth.close();
    else await vi.advanceTimersByTimeAsync(50);
    await pending;
    auth.close();
  });

  it('超限令牌响应在解码前取消，后续 chunk 不再读取', async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream(
        {
          pull(controller) {
            pulls++;
            controller.enqueue(new Uint8Array(65_537));
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
    );
    const auth = new VertexTokenCache({ fetch: vi.fn<typeof fetch>().mockResolvedValue(response) });
    await expect(auth.get(vertexAccount(), signal())).rejects.toThrow(VertexAuthError);
    expect(pulls).toBe(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    auth.close();
  });
});
