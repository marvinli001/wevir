import { describe, expect, it, vi } from 'vitest';
import { startModelGateway } from './gateway.js';
import { testProvider } from './provider-test.js';

describe('ZUV access token refresh', () => {
  it.each(['AUTH_REQUIRED', 'SUBSCRIPTION_REQUIRED', 'SCOPE_DISABLED', 'DEVICE_REVOKED'])(
    'exposes a ZUV-specific %s cause for localization',
    async (code) => {
      const result = await testProvider(
        {
          id: 'zuv',
          kind: 'zuv',
          displayName: 'ZUV',
          models: [{ id: 'synthetic-model' }],
          defaultModelId: 'synthetic-model',
        },
        'synthetic-model',
        {
          auth: {
            baseURL: () => 'https://zuv.test/api/wevir/v1',
            authorize: async () => ({
              ok: false,
              status: code === 'AUTH_REQUIRED' || code === 'DEVICE_REVOKED' ? 401 : 403,
              code,
            }),
          },
          fetch: vi.fn(),
        },
      );
      expect(result).toMatchObject({
        ok: false,
        reason: 'auth',
        error: { code: `zuv_${code.toLowerCase()}` },
      });
    },
  );
  it.each(['request', 'probe'] as const)(
    're-signs a %s once after a rejected token',
    async (action) => {
      let token = 'synthetic-old-token';
      const denied = vi.fn(async () => {
        token = 'synthetic-new-token';
        return true;
      });
      const post = vi.fn<typeof fetch>(async (_url, init) => {
        const headers = new Headers(init?.headers);
        if (post.mock.calls.length === 1) {
          expect(headers.get('authorization')).toBe('DPoP synthetic-old-token');
          return Response.json(
            { error: { code: 'AUTH_REQUIRED', message: 'AUTH_REQUIRED' } },
            { status: 401 },
          );
        }
        expect(headers.get('authorization')).toBe('DPoP synthetic-new-token');
        return new Response(
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"response_fixture","status":"completed","output":[]}}\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      });
      const gateway = await startModelGateway({
        fetch: post,
        auth: {
          baseURL: () => 'https://zuv.test/api/wevir/v1',
          onDenied: denied,
          authorize: async () => ({
            ok: true,
            headers: { authorization: `DPoP ${token}` },
            secrets: [token],
          }),
        },
      });
      const provider = {
        id: 'zuv',
        kind: 'zuv' as const,
        displayName: 'ZUV',
        models: [{ id: 'synthetic-model' }],
        defaultModelId: 'synthetic-model',
      };
      gateway.setProviders([provider]);
      try {
        if (action === 'probe')
          expect(await gateway.testProvider(provider, 'synthetic-model')).toMatchObject({
            ok: true,
          });
        else {
          const response = await fetch(`${gateway.baseURL('zuv')}/responses`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${gateway.token}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ model: 'synthetic-model', input: 'Synthetic', stream: true }),
          });
          expect(response.status).toBe(200);
          await response.text();
        }
        expect(denied).toHaveBeenCalledOnce();
        expect(post).toHaveBeenCalledTimes(2);
        expect(post.mock.calls[1]?.[1]?.body).toEqual(post.mock.calls[0]?.[1]?.body);
      } finally {
        await gateway.close();
      }
    },
  );
});
