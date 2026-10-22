import type { WevirClient } from '@wevir/client-sdk';
import type { InboxItem, InboxItemKind } from '@wevir/protocol';
import { type Context, withClient } from '../context.js';
import { CliError, EXIT } from '../errors.js';
import { formatTime, table, truncate } from '../format.js';
import { t } from '../i18n/index.js';

export interface InboxOutputOptions {
  json?: boolean;
}

/** Host 没有 `inbox` 功能（0.103.0 之前）时给出明确的说明。 */
export function requireInbox(client: Pick<WevirClient, 'supports' | 'hello'>): void {
  if (!client.supports('inbox')) {
    throw new CliError(
      t('inbox.unsupported', { version: client.hello.hostVersion }),
      t('inbox.unsupported.hint'),
    );
  }
}

function withInbox<T>(ctx: Context, fn: (client: WevirClient) => Promise<T>): Promise<T> {
  return withClient(ctx, async (client) => {
    requireInbox(client);
    return fn(client);
  });
}

export const inboxKindLabel = (kind: InboxItemKind): string => t(`inbox.kind.${kind}`);

/** 表格的一行：ID、种类、标题、说明、时间（有过期时间的加上）。 */
export function inboxRow(item: InboxItem): string[] {
  const time =
    item.expiresAt === undefined
      ? formatTime(item.createdAt)
      : t('inbox.expiresAt', {
          created: formatTime(item.createdAt),
          expires: formatTime(item.expiresAt),
        });
  return [
    item.id,
    inboxKindLabel(item.kind),
    truncate(item.title === '' ? '-' : item.title, 24),
    truncate(item.summary === '' ? '-' : item.summary, 48),
    time,
  ];
}

/** `wevir inbox [list] [--json]`：跨所有会话等处理的事，新的在前。 */
export async function inboxList(ctx: Context, options: InboxOutputOptions): Promise<number> {
  const { items } = await withInbox(ctx, (client) => client.request('inbox.list', {}));
  if (options.json) {
    ctx.print(JSON.stringify(items, null, 2));
    return EXIT.ok;
  }
  if (items.length === 0) {
    ctx.print(t('inbox.none'));
    return EXIT.ok;
  }
  ctx.print(
    table(
      [
        'ID',
        t('inbox.col.kind'),
        t('inbox.col.title'),
        t('inbox.col.summary'),
        t('inbox.col.time'),
      ],
      items.map(inboxRow),
    ),
  );
  return EXIT.ok;
}

/** `wevir inbox dismiss <ID>`：收起一个失败回合或自动化项。 */
export async function inboxDismiss(ctx: Context, itemId: string): Promise<number> {
  return withInbox(ctx, async (client) => {
    await client.request('inbox.dismiss', { itemId });
    ctx.print(t('inbox.dismissed', { id: itemId }));
    return EXIT.ok;
  });
}
