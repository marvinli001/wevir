// 会话侧栏的“依赖”卡片（0.70.0，Host 功能 `workspace_readiness`）：项目环境的预检（包管理器、运行时、锁文件、依赖目录、检查命令），
// 按项目约定的安装方案（用户确认后由 Host 执行，可停止、输出可查），仓库与 Agent 网络的诊断。Agent 只能读同一份结果，安装只能从这里
// 发起。设置里打开后才显示（默认不显示）；只在项目里的普通会话里有（子会话、“对话”里没有），旧 Host 没有这张卡片。

import { hostSupports } from '@wevir/client-sdk';
import type {
  InstallPlan,
  InstallRun,
  ReadinessItem,
  ReadinessReport,
  Session,
  SessionId,
  WorkspaceId,
} from '@wevir/protocol';
import { cn } from 'cn';
import { KeyRound, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { StatusDot } from '@/components/status-dot';
import { Button } from '@/components/ui/button';
import { isChats } from '@/data/workbench-model';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { formatDuration } from '@/session/format';
import {
  CredentialDialog,
  EvidenceDialog,
  InstallDialog,
  InstallOutputDialog,
} from './readiness-dialogs';
import {
  AGENT_NETWORK_LABELS,
  adviceLabels,
  INSTALL_LABELS,
  INSTALL_TONES,
  itemDetail,
  itemTone,
  mergeChange,
  planFolder,
  problemCount,
  READINESS_ITEMS_SHOWN,
  REPORT_LABELS,
  REPORT_TONES,
  readinessReasonLabel,
  STATUS_LABELS,
  sortedItems,
} from './readiness-model';
import { type RailContext, registerRailCard } from './session-rail';

/** 预检报告：侧栏看得见时读，会话状态变了（回合结束，文件可能改过）重读；`readiness.changed` 合进来，重连后重读。 */
function useReadiness(workspaceId: WorkspaceId, session: Session, active: boolean) {
  const { client, view } = useHostConnection();
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'workspace_readiness');
  const [report, setReport] = useState<ReadinessReport>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const sessionId = session.id;

  const load = useCallback(
    (refresh = false) => {
      if (!client) return;
      const id = ++seq.current;
      setLoading(true);
      client
        .request('readiness.get', { workspaceId, sessionId, ...(refresh && { refresh }) })
        .then(
          (result) => {
            if (id !== seq.current) return;
            setReport(result.report);
            setError(undefined);
          },
          (reason: unknown) => {
            if (id === seq.current) setError(t('readiness.failed', { error: describe(reason) }));
          },
        )
        .finally(() => {
          if (id === seq.current) setLoading(false);
        });
    },
    [client, workspaceId, sessionId],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: session.state 只用来触发重读。
  useEffect(() => {
    if (supported && active) load();
  }, [supported, active, load, session.state]);

  useEffect(() => {
    if (!client || !supported) return;
    return client.onReadinessChanged((change) => {
      if (change === undefined) {
        if (active) load();
        return;
      }
      setReport((current) => mergeChange(current, change));
    });
  }, [client, supported, active, load]);

  return { supported, report, error, loading, reload: load };
}

function useReadinessCard({ sessionId, session, entry, visible }: RailContext) {
  const { supported, report, error, loading, reload } = useReadiness(
    entry.workspace.id,
    session,
    visible,
  );
  if (!supported || session.parentSessionId !== undefined || isChats(entry.workspace)) return null;
  const running = report?.install?.status === 'running';
  const problems = report ? problemCount(report.items) : 0;
  return {
    summary: report && (
      <>
        <StatusDot tone={running ? 'accent' : REPORT_TONES[report.status]} pulse={running} />
        <span className="truncate">
          {running
            ? t('readiness.install.running')
            : report.status === 'not_ready' && problems > 0
              ? t('readiness.report.problems', { count: problems })
              : t(REPORT_LABELS[report.status])}
        </span>
      </>
    ),
    details: (
      <ReadinessDetails
        sessionId={sessionId}
        report={report}
        error={error}
        loading={loading}
        onReload={reload}
      />
    ),
  };
}

function ReadinessDetails({
  sessionId,
  report,
  error,
  loading,
  onReload,
}: {
  sessionId: SessionId;
  report: ReadinessReport | undefined;
  error: string | undefined;
  loading: boolean;
  onReload: (refresh?: boolean) => void;
}) {
  const { client } = useHostConnection();
  const [evidence, setEvidence] = useState<ReadinessItem>();
  const [installing, setInstalling] = useState<InstallPlan>();
  const [output, setOutput] = useState<string>();
  const [credential, setCredential] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [showAll, setShowAll] = useState(false);

  if (!report) {
    return <p className="text-xs text-muted-foreground">{error ?? t('common.loading')}</p>;
  }
  const items = sortedItems(report.items);
  const shown = showAll ? items : items.slice(0, READINESS_ITEMS_SHOWN);
  const install = report.install;
  const running = install?.status === 'running';
  const missingCredentials = [
    ...new Set(
      report.plans.flatMap((plan) =>
        plan.credentials.filter((item) => item.source === 'missing').map((item) => item.name),
      ),
    ),
  ];
  const agent = report.network.agent;
  const advice = adviceLabels(report.network.advice);
  const viewing = output !== undefined && install?.id === output ? install : undefined;

  const cancel = async (run: InstallRun) => {
    if (!client) return;
    setActionError(undefined);
    try {
      await client.request('readiness.cancel', { runId: run.id });
    } catch (reason) {
      setActionError(t('readiness.failed', { error: describe(reason) }));
    }
  };

  return (
    <div data-testid="rail-readiness" data-readiness-status={report.status}>
      <p className="mb-2 flex min-w-0 items-center gap-2 text-sm">
        <StatusDot tone={REPORT_TONES[report.status]} />
        <span className="min-w-0 flex-1 truncate">{t(REPORT_LABELS[report.status])}</span>
        <IconButton
          label={t('readiness.refresh')}
          size="icon-xs"
          className="-mr-1"
          disabled={loading}
          onClick={() => onReload(true)}
          data-testid="rail-readiness-refresh"
        >
          <RefreshCw className={cn(loading && 'animate-spin')} />
        </IconButton>
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('readiness.empty')}</p>
      ) : (
        <ul className="space-y-0.5">
          {shown.map((item) => (
            <ItemRow key={item.id} item={item} onOpen={() => setEvidence(item)} />
          ))}
        </ul>
      )}
      {items.length > shown.length && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring"
        >
          {t('rail.context.more', { count: items.length - shown.length })}
        </button>
      )}

      {install && (
        <InstallRow
          run={install}
          onOutput={() => setOutput(install.id)}
          onCancel={() => void cancel(install)}
        />
      )}

      {!running && report.plans.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="rail-readiness-plans">
          {report.plans.map((plan) => (
            <li key={plan.id} className="flex min-w-0 items-center gap-2">
              <code
                className="min-w-0 flex-1 truncate font-mono text-xs"
                title={`${planFolder(plan.path)} · ${plan.command}`}
              >
                {plan.path !== '' && <span className="text-muted-foreground">{plan.path} · </span>}
                {plan.command}
              </code>
              <Button
                size="xs"
                variant="outline"
                disabled={!client}
                onClick={() => setInstalling(plan)}
                data-action="install-dependencies"
              >
                {t('readiness.install')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {missingCredentials.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {missingCredentials.map((name) => (
            <li key={name}>
              <button
                type="button"
                onClick={() => setCredential(name)}
                className="-mx-1.5 flex h-7 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2.5 rounded-md px-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:focus-ring"
                data-action="set-credential"
              >
                <KeyRound className="size-4 shrink-0 text-warning" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t('readiness.credential.missing')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {(agent || advice.length > 0 || report.network.registries.length > 0) && (
        <div className="mt-3 space-y-1 text-xs" data-testid="rail-readiness-network">
          {report.network.registries.map((registry) => (
            <p
              key={`${registry.ecosystem}:${registry.url}`}
              className="flex min-w-0 items-center gap-1.5 text-muted-foreground"
              title={registry.source}
            >
              <span className="min-w-0 flex-1 truncate font-mono">{registry.url}</span>
              {registry.auth !== 'none' && (
                <span className={cn('shrink-0', registry.auth === 'missing' && 'text-warning')}>
                  {t(
                    registry.auth === 'missing'
                      ? 'readiness.credential.missing'
                      : 'readiness.registry.auth',
                  )}
                </span>
              )}
            </p>
          ))}
          {agent && (
            <p className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <span className="shrink-0">{t('readiness.agent')}</span>
              <span className="min-w-0 truncate">
                · {t(AGENT_NETWORK_LABELS[agent.network] ?? 'readiness.agent.unknown')} ·{' '}
                {t('readiness.agent.domains')}
              </span>
            </p>
          )}
          {advice.length > 0 && (
            <ul className="space-y-0.5 text-muted-foreground" data-testid="rail-readiness-advice">
              {advice.map((label) => (
                <li key={label}>{t(label)}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(actionError ?? error) && (
        <p className="mt-2 text-xs text-destructive">{actionError ?? error}</p>
      )}

      {evidence && <EvidenceDialog item={evidence} onClose={() => setEvidence(undefined)} />}
      {installing && (
        <InstallDialog
          workspaceId={report.workspaceId}
          sessionId={sessionId}
          root={report.root}
          plan={installing}
          onClose={(started) => {
            setInstalling(undefined);
            if (!started) onReload();
          }}
        />
      )}
      {viewing && <InstallOutputDialog run={viewing} onClose={() => setOutput(undefined)} />}
      {credential !== undefined && (
        <CredentialDialog
          workspaceId={report.workspaceId}
          name={credential}
          onClose={(saved) => {
            setCredential(undefined);
            if (saved) onReload();
          }}
        />
      )}
    </div>
  );
}

function ItemRow({ item, onOpen }: { item: ReadinessItem; onOpen: () => void }) {
  const { reason, version } = itemDetail(item);
  const status = t(STATUS_LABELS[item.status]);
  const detail = reason ? t(reason) : (version ?? (item.status === 'ready' ? undefined : status));
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={reason ? t(reason) : status}
        data-readiness-item={item.id}
        data-item-status={item.status}
        className="-mx-1.5 flex h-7 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2.5 rounded-md px-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:focus-ring"
      >
        <StatusDot tone={itemTone(item)} label={status} />
        <span className="min-w-0 flex-1 truncate">
          {item.name}
          {item.path !== '' && <span className="text-muted-foreground"> · {item.path}</span>}
        </span>
        {detail && (
          <span className="max-w-[50%] shrink-0 truncate text-xs text-muted-foreground tabular-nums">
            {detail}
          </span>
        )}
      </button>
    </li>
  );
}

function InstallRow({
  run,
  onOutput,
  onCancel,
}: {
  run: InstallRun;
  onOutput: () => void;
  onCancel: () => void;
}) {
  const running = run.status === 'running';
  const reason = run.status === 'succeeded' ? undefined : readinessReasonLabel(run.reason);
  return (
    <div
      className="mt-3 space-y-1.5"
      data-testid="rail-readiness-install"
      data-install-status={run.status}
    >
      <p className="flex min-w-0 items-center gap-2 text-xs">
        <StatusDot tone={INSTALL_TONES[run.status]} pulse={running} />
        <span className="shrink-0">{t(INSTALL_LABELS[run.status])}</span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-muted-foreground"
          title={run.command}
        >
          {run.command}
        </span>
        {!running && run.durationMs !== undefined && (
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {formatDuration(run.durationMs)}
          </span>
        )}
      </p>
      {reason && run.status !== 'timed_out' && (
        <p className="text-xs text-muted-foreground">{t(reason)}</p>
      )}
      <div className="flex h-6 items-center gap-2">
        {running && (
          <Button size="xs" variant="outline" onClick={onCancel} data-action="cancel-install">
            {t('readiness.install.cancel')}
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          className={cn(!running && '-ml-2')}
          onClick={onOutput}
          disabled={run.bytes === 0 && !running}
          data-action="install-output"
        >
          {t('readiness.output')}
        </Button>
      </div>
    </div>
  );
}

registerRailCard({
  id: 'readiness',
  order: 31,
  title: () => t('rail.readiness'),
  useCard: useReadinessCard,
});
