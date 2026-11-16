import { setTimeout as delay } from 'node:timers/promises';
import type { ZuvApiState } from '@wevir/protocol';
import { type Context, requireFeature, withClient } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { t } from '../i18n/index.js';

function print(ctx: Context, state: ZuvApiState): void {
  if (state.status === 'connected')
    ctx.print(
      t('zuvApi.connected', {
        account: state.account?.email ?? 'ZUV',
        prefix: state.keyPrefix ?? '',
      }),
    );
  else ctx.print(t(state.status === 'authorizing' ? 'zuvApi.waiting' : 'zuvApi.disconnected'));
  if (state.error) ctx.print(t('zuvApi.failed', { reason: state.error }));
  if (state.modelsError) ctx.print(t('zuvApi.modelsFailed', { reason: state.modelsError }));
}

export function zuvApiStatus(ctx: Context): Promise<number> {
  return withClient(ctx, async (client) => {
    requireFeature(client, 'zuv_api_connection');
    const { connection } = await client.request('zuvApi.get');
    print(ctx, connection);
    return connection.error || connection.modelsError ? EXIT.failure : EXIT.ok;
  });
}

export function zuvApiDisconnect(ctx: Context): Promise<number> {
  return withClient(ctx, async (client) => {
    requireFeature(client, 'zuv_api_connection');
    const { connection } = await client.request('zuvApi.disconnect');
    print(ctx, connection);
    return EXIT.ok;
  });
}

export function zuvApiLogin(ctx: Context): Promise<number> {
  return withClient(ctx, async (client) => {
    requireFeature(client, 'zuv_api_connection');
    const interrupted = new AbortController();
    const stop = ctx.io.onInterrupt(() => interrupted.abort());
    let requestId: string | undefined;
    try {
      const { connection: current } = await client.request('zuvApi.get');
      if (current.status === 'connected' && !current.error) {
        const state = current.modelsError
          ? (await client.request('zuvApi.refreshModels')).connection
          : current;
        print(ctx, state);
        return state.error || state.modelsError ? EXIT.failure : EXIT.ok;
      }
      const { connection } = await client.request('zuvApi.login', {}, { timeoutMs: 60_000 });
      requestId = connection.login?.requestId;
      if (!connection.login)
        throw new CliError(t('zuvApi.failed', { reason: connection.error ?? 'invalid_response' }));
      ctx.print(connection.login.authorizationUrl);
      ctx.print(t('zuvApi.waiting'));
      while (!interrupted.signal.aborted) {
        await delay(1000, undefined, { signal: interrupted.signal }).catch(() => {});
        if (interrupted.signal.aborted) break;
        const { connection: next } = await client.request('zuvApi.get');
        if (next.status === 'connected') {
          print(ctx, next);
          return next.error || next.modelsError ? EXIT.failure : EXIT.ok;
        }
        if (next.status !== 'authorizing')
          throw new CliError(
            t('zuvApi.failed', { reason: next.error ?? 'authorization_cancelled' }),
          );
        if (next.login?.requestId !== requestId)
          throw new CliError(t('zuvApi.failed', { reason: 'authorization_cancelled' }));
      }
      await client.request('zuvApi.cancel', { requestId });
      ctx.print(t('zuvApi.cancelled'));
      return EXIT.interrupted;
    } finally {
      stop();
    }
  });
}
