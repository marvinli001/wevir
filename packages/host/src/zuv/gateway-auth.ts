import type { GatewayAuthSource } from '@wevir/runtime-adapter';
import type { ZuvClient } from './client.js';
import { ZuvRequestError } from './transport.js';

export function zuvGatewayAuth(client: ZuvClient): GatewayAuthSource {
  return {
    baseURL: (id) => (id === 'zuv' ? `${client.transport.origin}/api/wevir/v1` : undefined),
    async onDenied(request) {
      if (request.providerId === 'zuv')
        await client.inferenceDenied(request.authorization, request.status);
    },
    async authorize(request) {
      if (request.providerId !== 'zuv') return { ok: false, status: 403, code: 'SCOPE_DISABLED' };
      try {
        const authorization = await client.authorizeInference(request.url, request.body);
        return { ok: true, ...authorization };
      } catch (error) {
        if (!(error instanceof ZuvRequestError))
          return { ok: false, status: 503, code: 'SERVICE_UNAVAILABLE' };
        const status =
          error.code === 'AUTH_REQUIRED' || error.code === 'DEVICE_REVOKED'
            ? 401
            : error.code === 'SUBSCRIPTION_REQUIRED' || error.code === 'SCOPE_DISABLED'
              ? 403
              : error.status === 429
                ? 429
                : 503;
        return { ok: false, status, code: error.code };
      }
    },
  };
}
