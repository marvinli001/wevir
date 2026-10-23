import type { WevirClient } from '@wevir/client-sdk';
import type { ApprovalRule, ApprovalRuleId, Workspace, WorkspaceId } from '@wevir/protocol';
import { type Context, findWorkspace, requireFeature, withClient } from '../context.js';
import { EXIT, UsageError } from '../errors.js';
import { formatTime, prefixText, table, truncate } from '../format.js';
import { t } from '../i18n/index.js';

// `wevir rule`（0.80.0，Host 功能 `approval_rules`，domain-model §3.35）：审批规则。规则只替用户回答引擎已经发出的命令审批，
// 不放宽权限模式或沙箱；全局的对所有项目有效，`-w` 的只对这个项目。

export interface RuleOptions {
  workspace?: string;
  json?: boolean;
}

function withRules<T>(
  ctx: Context,
  fn: (client: WevirClient, workspaces: Workspace[]) => Promise<T>,
): Promise<T> {
  return withClient(ctx, async (client) => {
    requireFeature(client, 'approval_rules');
    const { workspaces } = await client.request('workspace.list');
    return fn(client, workspaces);
  });
}

async function scope(
  ctx: Context,
  workspaces: Workspace[],
  path: string | undefined,
): Promise<{ workspaceId?: WorkspaceId }> {
  if (path === undefined) return {};
  return { workspaceId: (await findWorkspace(ctx, workspaces, path)).id };
}

const scopeLabel = (workspaces: Workspace[], id: WorkspaceId | undefined): string =>
  id === undefined ? t('rule.global') : (workspaces.find((w) => w.id === id)?.displayName ?? id);

export function ruleRow(rule: ApprovalRule, workspaces: Workspace[]): string[] {
  return [
    rule.id,
    truncate(prefixText(rule.prefix), 40),
    scopeLabel(workspaces, rule.workspaceId),
    String(rule.useCount),
    rule.lastUsedAt === undefined ? '-' : formatTime(rule.lastUsedAt),
  ];
}

/** `wevir rule list [-w <路径>] [--json]`：`-w` 时只列对这个项目有效的（全局的与这个项目的）。 */
export async function ruleList(ctx: Context, options: RuleOptions): Promise<number> {
  return withRules(ctx, async (client, workspaces) => {
    const { rules } = await client.request(
      'approvalRule.list',
      await scope(ctx, workspaces, options.workspace),
    );
    if (options.json) {
      ctx.print(JSON.stringify(rules, null, 2));
      return EXIT.ok;
    }
    if (rules.length === 0) {
      ctx.print(t('rule.none'));
      return EXIT.ok;
    }
    ctx.print(
      table(
        [
          'ID',
          t('rule.col.prefix'),
          t('rule.col.scope'),
          t('rule.col.uses'),
          t('rule.col.lastUsed'),
        ],
        rules.map((rule) => ruleRow(rule, workspaces)),
      ),
    );
    return EXIT.ok;
  });
}

/** `wevir rule add <命令前缀…> [-w <路径>]`：以后这些词开头的命令由 Host 替用户允许。 */
export async function ruleAdd(
  ctx: Context,
  prefix: string[],
  options: RuleOptions,
): Promise<number> {
  const words = prefix.flatMap((word) => word.split(/\s+/)).filter((word) => word !== '');
  if (words.length === 0) throw new UsageError(t('usage.missingArgs'));
  return withRules(ctx, async (client, workspaces) => {
    const { rule } = await client.request('approvalRule.add', {
      prefix: words,
      ...(await scope(ctx, workspaces, options.workspace)),
    });
    if (options.json) {
      ctx.print(JSON.stringify(rule, null, 2));
      return EXIT.ok;
    }
    ctx.print(
      t('rule.added', {
        prefix: prefixText(rule.prefix),
        scope: scopeLabel(workspaces, rule.workspaceId),
        id: rule.id,
      }),
    );
    return EXIT.ok;
  });
}

/** `wevir rule delete <ID>`：立即生效，之后的审批照常问。 */
export async function ruleDelete(ctx: Context, id: string): Promise<number> {
  return withRules(ctx, async (client) => {
    const { deleted } = await client.request('approvalRule.delete', {
      ruleId: id as ApprovalRuleId,
    });
    ctx.print(deleted ? t('rule.deleted', { id }) : t('rule.notFound', { id }));
    return deleted ? EXIT.ok : EXIT.failure;
  });
}

/** `wevir rule suggest [-w <路径>] [--json]`：多次手动允许过的命令前缀，按次数从多到少。 */
export async function ruleSuggest(ctx: Context, options: RuleOptions): Promise<number> {
  return withRules(ctx, async (client, workspaces) => {
    const { suggestions } = await client.request(
      'approvalRule.suggest',
      await scope(ctx, workspaces, options.workspace),
    );
    if (options.json) {
      ctx.print(JSON.stringify(suggestions, null, 2));
      return EXIT.ok;
    }
    if (suggestions.length === 0) {
      ctx.print(t('rule.noSuggestions'));
      return EXIT.ok;
    }
    ctx.print(
      table(
        [
          t('rule.col.prefix'),
          t('rule.col.project'),
          t('rule.col.approved'),
          t('rule.col.example'),
        ],
        suggestions.map((s) => [
          prefixText(s.prefix),
          scopeLabel(workspaces, s.workspaceId),
          String(s.count),
          truncate(s.example, 48),
        ]),
      ),
    );
    return EXIT.ok;
  });
}
