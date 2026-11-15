import { resolve } from 'node:path';
import { isMethodName, type MethodName, MethodSchemas } from '@wevir/protocol';
import { type Context, requireFeature, withClient } from '../context.js';
import { EXIT, UsageError } from '../errors.js';
import { t } from '../i18n/index.js';
import { readStdin } from '../prompt.js';

export async function syncCall(
  ctx: Context,
  method: Extract<MethodName, `sync.${string}`>,
  params: unknown,
  stdin: boolean,
) {
  let value = params;
  if (stdin) {
    if (
      params &&
      typeof params === 'object' &&
      Object.values(params).some((value) => value !== undefined && value !== false)
    )
      throw new UsageError(t('sync.stdinConflict'));
    const raw = await readStdin(ctx.io);
    try {
      value = JSON.parse(raw);
    } catch {
      throw new UsageError(t('sync.invalidParams'));
    }
  }
  const parsed = MethodSchemas[method].params.safeParse(value);
  if (!parsed.success) throw new UsageError(t('sync.invalidParams'));
  if (
    ctx.remote === undefined &&
    method === 'sync.exportLocal' &&
    (parsed.data as { directory?: string }).directory
  ) {
    const data = parsed.data as { directory: string };
    data.directory = resolve(ctx.io.cwd, data.directory);
  }
  if (ctx.remote === undefined && method === 'sync.importPrepare') {
    const data = parsed.data as { path: string };
    data.path = resolve(ctx.io.cwd, data.path);
  }
  return withClient(ctx, async (client) => {
    requireFeature(
      client,
      ['recovery', 'unlockKeys', 'deleteCloud', 'detach', 'exportLocal', 'import'].some((prefix) =>
        method.startsWith(`sync.${prefix}`),
      )
        ? 'sync_recovery'
        : 'cloud_sync',
    );
    const result = await client.request(method, parsed.data);
    ctx.print(JSON.stringify(result, null, 2));
    return EXIT.ok;
  });
}
export function syncInvoke(ctx: Context, action: string, stdin: boolean) {
  const method = action.startsWith('sync.') ? action : `sync.${action}`;
  if (!method.startsWith('sync.') || !isMethodName(method))
    throw new UsageError(t('sync.invalidParams'));
  return syncCall(ctx, method as Extract<MethodName, `sync.${string}`>, {}, stdin);
}
