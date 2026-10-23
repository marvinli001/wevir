import type { WevirClient } from '@wevir/client-sdk';
import {
  type ApprovalRuleScope,
  ApprovalRuleScopeSchema,
  type InboxItem,
  type InboxItemKind,
} from '@wevir/protocol';
import { parseApprovalAnswer } from '../attach.js';
import { type Context, withClient } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { formatTime, optionLabel, table, truncate } from '../format.js';
import { joinList, t } from '../i18n/index.js';

export interface InboxOutputOptions {
  json?: boolean;
}

/** Host 没有 `inbox` 功能（0.105.0 之前）时给出明确的说明。 */
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

/** `--remember project|global`（0.80.0）：选的允许类选项同时加一条审批规则。 */
function parseRuleScope(value: string | undefined): ApprovalRuleScope | undefined {
  if (value === undefined) return undefined;
  const parsed = ApprovalRuleScopeSchema.safeParse(value.trim().toLowerCase());
  if (!parsed.success) {
    throw new UsageError(t('inbox.badRemember', { value }), t('inbox.badRemember.hint'));
  }
  return parsed.data;
}

/**
 * `wevir inbox respond <ID> <回答>`：回答一个等审批的项。回答是选项序号、选项 ID，或 y / n（第一个允许 / 拒绝的选项）。ID 可以
 * 省略 `approval:`。提问在 attach 里回答。
 */
export async function inboxRespond(
  ctx: Context,
  itemId: string,
  answer: string,
  options: { remember?: string } = {},
): Promise<number> {
  const remember = parseRuleScope(options.remember);
  return withInbox(ctx, async (client) => {
    const { items } = await client.request('inbox.list', {});
    const item = items.find((i) => i.id === itemId || i.id === `approval:${itemId}`);
    if (item === undefined) {
      throw new CliError(t('inbox.notFound', { id: itemId }), t('inbox.notFound.hint'));
    }
    if (item.kind !== 'approval') {
      throw new CliError(t('inbox.notApproval', { id: item.id }), t('inbox.notApproval.hint'));
    }
    const option = parseApprovalAnswer(item.ref.options, answer);
    if (option === undefined) {
      throw new UsageError(
        t('inbox.badAnswer', { answer }),
        t('inbox.badAnswer.hint', {
          options: joinList(item.ref.options.map((o, i) => `${i + 1} ${optionLabel(o)}`)),
        }),
      );
    }
    await client.request('approval.respond', {
      approvalId: item.ref.approvalId,
      optionId: option.optionId,
      ...(remember !== undefined && { remember }),
    });
    ctx.print(t('inbox.responded', { id: item.id, option: optionLabel(option) }));
    return EXIT.ok;
  });
}
