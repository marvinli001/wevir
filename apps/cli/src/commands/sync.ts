import { type MethodName, MethodSchemas } from '@wevir/protocol';
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
  const value = stdin ? JSON.parse(await readStdin(ctx.io)) : params;
  const parsed = MethodSchemas[method].params.safeParse(value);
  if (!parsed.success) throw new UsageError(t('sync.invalidParams'));
  return withClient(ctx, async (client) => {
    requireFeature(
      client,
      method === 'sync.status' ||
        method === 'sync.configure' ||
        method === 'sync.retry' ||
        method === 'sync.devices' ||
        method === 'sync.approveDevice'
        ? 'cloud_sync'
        : 'sync_recovery',
    );
    const result = await client.request(method, parsed.data);
    ctx.print(JSON.stringify(result, null, 2));
    return EXIT.ok;
  });
}
