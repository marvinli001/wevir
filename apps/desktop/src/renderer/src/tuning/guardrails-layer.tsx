// 档案里的护栏层（0.86.0，desktop-layout.md §34、design/tuning.md §3.3）：层行右边“新建”，展开是三组：护栏规则（种类、参数摘要、
// 拦截次数、开关、⋯ 菜单编辑与删除；只有 Codex 会话挂得上，组标题旁写“仅 Codex”）、仓库 hooks（只在项目范围：文件 · 事件 · 命令、
// 开关，不支持的与内容变了的写状态）与审批规则（档案里的条目，只读，“管理”跳设置）。数据是 `guardrail.*` 与 `repoHook.*`
// （use-guardrails.ts），审批规则取档案层的条目。

import type { WevirClient } from '@wevir/client-sdk';
import type { Guardrail, ProfileLayer, WorkspaceId } from '@wevir/protocol';
import { cn } from 'cn';
import { Ellipsis, Pencil, Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IconButton } from '@/components/icon-button';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { ExpandableRow } from '@/plugins/plugin-rows';
import { paths } from '@/routes/paths';
import { NoticeBanner } from '@/settings/settings-ui';
import { GuardrailDialog } from './guardrails-dialog';
import {
  approvalItems,
  draftOf,
  type GuardrailDraft,
  guardrailKindName,
  guardrailLabel,
  repoHookLabel,
  repoHookStatus,
  ruleSummary,
} from './guardrails-model';
import { layerName, layerScopes, layerSummary, scopeName, shortHash } from './tuning-model';
import { type ListedHook, useGuardrails } from './use-guardrails';

export function GuardrailsLayerRow({
  client,
  layer,
  workspaceId,
  expanded,
  onToggle,
  onExpand,
  lifecycleHooks = false,
}: {
  client: WevirClient;
  layer: ProfileLayer;
  /** Host 有生命周期钩子（0.137.0）：列 `hook.list` 的全部来源，启停经 `hook.setEnabled`。 */
  lifecycleHooks?: boolean;
  /** 选中的项目；全局范围时省略。 */
  workspaceId: string | undefined;
  expanded: boolean;
  onToggle: () => void;
  /** 新建后展开这一层，看得到新规则。 */
  onExpand: () => void;
}) {
  const data = useGuardrails(client, workspaceId, lifecycleHooks);
  const [editing, setEditing] = useState<GuardrailDraft>();
  const [deleting, setDeleting] = useState<Guardrail>();
  const [failure, setFailure] = useState<string>();
  const scopes = layerScopes(layer);

  const act = (run: () => Promise<unknown>) => {
    setFailure(undefined);
    run().catch((reason: unknown) =>
      setFailure(t('tuning.guardrails.failed', { error: describe(reason) })),
    );
  };

  return (
    <>
      <ExpandableRow
        id={`layer:${layer.key}`}
        expanded={expanded}
        onToggle={onToggle}
        title={layerName(layer.key)}
        {...(scopes !== '' && { meta: scopes })}
        summary={
          <>
            {layerSummary(layer)}
            <span className="ml-3 font-mono" title={layer.hash}>
              {shortHash(layer.hash)}
            </span>
          </>
        }
        control={
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              setEditing(draftOf(undefined, workspaceId === undefined ? 'global' : 'project'))
            }
            data-action="new-guardrail"
          >
            <Plus data-icon="inline-start" />
            {t('tuning.guardrails.new')}
          </Button>
        }
      >
        {failure !== undefined && <NoticeBanner notice={{ tone: 'error', text: failure }} />}
        {data.error !== undefined && (
          <NoticeBanner
            notice={{
              tone: 'error',
              text: t('tuning.guardrails.failed', { error: describe(data.error) }),
            }}
          />
        )}
        <Group
          title={t('tuning.guardrails.rules')}
          aside={
            <span className="text-xs text-muted-foreground">
              {t('tuning.guardrails.codexOnly')}
            </span>
          }
        >
          {data.data === undefined ? (
            data.error === undefined && (
              <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
            )
          ) : data.data.guardrails.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('tuning.guardrails.empty')}</p>
          ) : (
            <ul className="space-y-px" data-testid="guardrail-rules">
              {data.data.guardrails.map((guardrail) => (
                <RuleRow
                  key={guardrail.id}
                  guardrail={guardrail}
                  onToggle={(enabled) =>
                    act(() =>
                      client.request('guardrail.setEnabled', {
                        guardrailId: guardrail.id,
                        enabled,
                      }),
                    )
                  }
                  onEdit={() => setEditing(draftOf(guardrail))}
                  onDelete={() => setDeleting(guardrail)}
                />
              ))}
            </ul>
          )}
        </Group>
        {(workspaceId !== undefined || lifecycleHooks) &&
          data.data !== undefined &&
          (data.data.hooks.length > 0 || data.data.warnings.length > 0) && (
            <Group
              title={t(lifecycleHooks ? 'tuning.guardrails.hooks' : 'tuning.guardrails.repoHooks')}
            >
              <ul className="space-y-px" data-testid="guardrail-repo-hooks">
                {data.data.hooks.map((hook) => (
                  <HookRow
                    key={hook.id}
                    hook={hook}
                    onToggle={(enabled) =>
                      act(() =>
                        lifecycleHooks
                          ? client.request('hook.setEnabled', {
                              ...(workspaceId !== undefined && {
                                workspaceId: workspaceId as WorkspaceId,
                              }),
                              hookId: hook.id,
                              enabled,
                            })
                          : client.request('repoHook.setEnabled', {
                              workspaceId: workspaceId as WorkspaceId,
                              hookId: hook.id,
                              enabled,
                            }),
                      )
                    }
                  />
                ))}
              </ul>
              {data.data.warnings.map((warning) => (
                <p key={warning} className="mt-1 truncate text-xs text-destructive" title={warning}>
                  {warning}
                </p>
              ))}
            </Group>
          )}
        <ApprovalGroup layer={layer} />
      </ExpandableRow>
      {editing !== undefined && (
        <GuardrailDialog
          client={client}
          workspaceId={workspaceId}
          initial={editing}
          onClose={(saved) => {
            if (saved && editing.id === undefined) onExpand();
            setEditing(undefined);
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => !open && setDeleting(undefined)}
        title={t('tuning.guardrails.deleteTitle')}
        confirmLabel={t('tuning.guardrails.delete')}
        failure={(error) => t('tuning.guardrails.failed', { error })}
        onConfirm={async () => {
          if (deleting === undefined) return;
          await client.request('guardrail.delete', { guardrailId: deleting.id });
        }}
      >
        <p className="font-mono text-xs break-all">
          {deleting === undefined ? '' : ruleSummary(deleting.rule)}
        </p>
      </ConfirmDialog>
    </>
  );
}

/** 展开里的一组：小标题（右边可带一段小字或操作）加内容。 */
function Group({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex h-6 items-center gap-2">
        <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
        {aside !== undefined && <div className="ml-auto flex items-center">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

function RuleRow({
  guardrail,
  onToggle,
  onEdit,
  onDelete,
}: {
  guardrail: Guardrail;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const label = guardrailLabel(guardrail);
  return (
    <li
      className="flex h-8 min-w-0 items-center gap-2 text-xs"
      data-guardrail={guardrail.id}
      title={ruleSummary(guardrail.rule)}
    >
      <span className="w-20 shrink-0 truncate text-muted-foreground">
        {guardrailKindName(guardrail.rule.kind)}
      </span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate font-mono',
          !guardrail.enabled && 'text-muted-foreground',
        )}
      >
        {label}
      </span>
      <span className="shrink-0 text-muted-foreground">
        {scopeName(guardrail.workspaceId === undefined ? 'global' : 'project')}
      </span>
      <span className="w-16 shrink-0 text-right text-muted-foreground tabular-nums">
        {t('tuning.guardrails.hits', { count: guardrail.hits })}
      </span>
      <Switch
        checked={guardrail.enabled}
        label={t('tuning.guardrails.enabled', { name: label })}
        onChange={onToggle}
        className="ml-1"
        data-action="toggle-guardrail"
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <IconButton
              label={t('tuning.guardrails.actions')}
              size="icon-xs"
              data-action="guardrail-menu"
            >
              <Ellipsis />
            </IconButton>
          }
        />
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem onClick={onEdit} data-action="edit">
            <Pencil />
            {t('tuning.guardrails.edit')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete} data-action="delete">
            <Trash2 />
            {t('tuning.guardrails.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function HookRow({ hook, onToggle }: { hook: ListedHook; onToggle: (enabled: boolean) => void }) {
  const label = repoHookLabel(hook);
  const status = repoHookStatus(hook);
  // 只在某些引擎上跑的（`.claude/`、`.codex/`、Claude / Codex 插件）在提示里写出引擎。
  const engines = 'engines' in hook && !hook.engines.includes('*') ? hook.engines : [];
  const title = [label, hook.matcher, engines.join(', ')]
    .filter((part) => part !== undefined && part !== '')
    .join(' · ');
  return (
    <li
      className="flex h-8 min-w-0 items-center gap-2 text-xs"
      data-repo-hook={hook.id}
      data-status={hook.status}
      title={title}
    >
      <span className="min-w-0 flex-1 truncate font-mono">{label}</span>
      {status !== undefined && (
        <span
          className={cn(
            'shrink-0',
            hook.status === 'changed' ? 'text-warning' : 'text-muted-foreground',
          )}
        >
          {status}
        </span>
      )}
      <Switch
        checked={hook.status === 'enabled'}
        disabled={hook.status === 'unsupported'}
        label={t('tuning.guardrails.enabled', { name: label })}
        onChange={onToggle}
        data-action="toggle-repo-hook"
      />
      {/* 与规则行的 ⋯ 对齐。 */}
      <span className="size-6 shrink-0" />
    </li>
  );
}

function ApprovalGroup({ layer }: { layer: ProfileLayer }) {
  const location = useLocation();
  const items = approvalItems(layer);
  return (
    <Group
      title={t('tuning.guardrails.approvalRules')}
      aside={
        <Button
          variant="ghost"
          size="xs"
          render={<Link to={paths.settings('approvalRules')} state={{ from: location }} />}
          data-action="manage"
        >
          {t('tuning.manage')}
        </Button>
      }
    >
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('tuning.noItems')}</p>
      ) : (
        <ul className="space-y-px" data-testid="guardrail-approval-rules">
          {items.map((item) => (
            <li key={item.id} className="flex h-7 min-w-0 items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate font-mono">{item.label}</span>
              <span className="shrink-0 text-muted-foreground">{scopeName(item.scope)}</span>
            </li>
          ))}
        </ul>
      )}
    </Group>
  );
}
