import { hostSupports } from '@wevir/client-sdk';
import type { ApprovalRule, ApprovalRuleSuggestion, WorkspaceId } from '@wevir/protocol';
import { Plus, Trash2 } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { useWorkbenchData } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { workspaceLabel } from '@/projects/chats';
import { prefixText } from '@/session/approval-model';
import { EmptyList, LIST_CARD, type Notice, NoticeBanner, SettingsSection } from './settings-ui';

/**
 * 设置 → 审批规则（0.78.0，domain-model §3.35）：审批卡片上选“总是允许”加的规则，可删；下面是从历史建议的规则（多次手动允许过的
 * 命令前缀），一键加成这个项目的规则。规则删了立即生效。
 */
export function ApprovalRuleSettings() {
  const { client, view } = useHostConnection();
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'approval_rules');
  const data = useWorkbenchData();
  const [rules, setRules] = useState<ApprovalRule[]>();
  const [suggestions, setSuggestions] = useState<ApprovalRuleSuggestion[]>([]);
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState<string>();

  const projectName = useMemo(() => {
    const names = new Map<string, string>();
    if (data.status === 'ready') {
      for (const entry of data.workspaces)
        names.set(entry.workspace.id, workspaceLabel(entry.workspace));
    }
    return (workspaceId: string) => names.get(workspaceId) ?? workspaceId;
  }, [data]);

  const load = useCallback(async () => {
    if (!client || !supported) return;
    try {
      const [listed, suggested] = await Promise.all([
        client.request('approvalRule.list', {}),
        client.request('approvalRule.suggest', {}),
      ]);
      setRules(listed.rules);
      setSuggestions(suggested.suggestions);
    } catch (reason) {
      setNotice({
        tone: 'error',
        text: t('settings.approvalRules.failed', { error: describe(reason) }),
      });
    }
  }, [client, supported]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!supported) {
    return (
      <NoticeBanner notice={{ tone: 'info', text: t('settings.approvalRules.unsupported') }} />
    );
  }

  const act = async (key: string, run: (c: NonNullable<typeof client>) => Promise<unknown>) => {
    if (!client) return;
    setBusy(key);
    setNotice(undefined);
    try {
      await run(client);
      await load();
    } catch (reason) {
      setNotice({
        tone: 'error',
        text: t('settings.approvalRules.failed', { error: describe(reason) }),
      });
    } finally {
      setBusy(undefined);
    }
  };

  const scopeText = (workspaceId: string | undefined) =>
    workspaceId === undefined ? t('settings.approvalRules.global') : projectName(workspaceId);

  return (
    <>
      {notice && (
        <div className="mb-3">
          <NoticeBanner notice={notice} />
        </div>
      )}
      <SettingsSection title={t('settings.approvalRules.rules')} data-approval-rules>
        {rules === undefined ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : rules.length === 0 ? (
          <EmptyList>{t('settings.approvalRules.empty')}</EmptyList>
        ) : (
          <ul className={LIST_CARD}>
            {rules.map((rule) => (
              <RuleRow
                key={rule.id}
                prefix={rule.prefix}
                scope={scopeText(rule.workspaceId)}
                count={rule.useCount}
                data-approval-rule={rule.id}
                action={
                  <IconButton
                    label={t('settings.approvalRules.delete')}
                    disabled={busy !== undefined || !client}
                    onClick={() =>
                      void act(rule.id, (c) =>
                        c.request('approvalRule.delete', { ruleId: rule.id }),
                      )
                    }
                    data-action="delete-approval-rule"
                  >
                    <Trash2 />
                  </IconButton>
                }
              />
            ))}
          </ul>
        )}
      </SettingsSection>
      {suggestions.length > 0 && (
        <SettingsSection title={t('settings.approvalRules.suggested')} data-approval-suggestions>
          <ul className={LIST_CARD}>
            {suggestions.map((suggestion) => {
              const key = `${suggestion.workspaceId}/${suggestion.prefix.join(' ')}`;
              return (
                <RuleRow
                  key={key}
                  prefix={suggestion.prefix}
                  scope={scopeText(suggestion.workspaceId)}
                  count={suggestion.count}
                  data-approval-suggestion={key}
                  action={
                    <IconButton
                      label={t('settings.approvalRules.add')}
                      disabled={busy !== undefined || !client}
                      onClick={() =>
                        void act(key, (c) =>
                          c.request('approvalRule.add', {
                            prefix: suggestion.prefix,
                            workspaceId: suggestion.workspaceId as WorkspaceId,
                          }),
                        )
                      }
                      data-action="add-approval-rule"
                    >
                      <Plus />
                    </IconButton>
                  }
                />
              );
            })}
          </ul>
        </SettingsSection>
      )}
    </>
  );
}

function RuleRow({
  prefix,
  scope,
  count,
  action,
  ...rest
}: {
  prefix: readonly string[];
  scope: string;
  count: number;
  action: ReactNode;
} & Record<`data-${string}`, string>) {
  return (
    <li className="flex min-h-12 items-center gap-3 px-4 py-2" {...rest}>
      <code className="min-w-0 flex-1 truncate font-mono text-sm">{prefixText(prefix)}</code>
      <span className="shrink-0 truncate text-xs text-muted-foreground">
        {scope} · {t('settings.approvalRules.count', { count })}
      </span>
      {action}
    </li>
  );
}
