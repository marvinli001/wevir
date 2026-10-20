// 会话侧栏的“检查”卡片（0.65.0，Host 功能 `verification`）：验收状态（与引擎的回合状态分开）、最近一轮的记录；“运行检查”
// 与“停止”；点一条记录看完整输出。只在项目里的普通会话里有（子会话、“对话”里没有），旧 Host 没有这张卡片。

import { hostSupports } from '@wevir/client-sdk';
import type { CheckDefinition, SessionId, VerificationRun, WorkspaceId } from '@wevir/protocol';
import { cn } from 'cn';
import { Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { IconButton } from '@/components/icon-button';
import { StatusDot, type StatusTone } from '@/components/status-dot';
import { Button } from '@/components/ui/button';
import { useTranscript } from '@/data/workbench-data';
import { isChats } from '@/data/workbench-model';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { isBusy } from '@/session/composer';
import { formatDuration } from '@/session/format';
import {
  ACCEPTANCE_LABELS,
  isQueued,
  latestRound,
  RUN_LABELS,
  reasonLabel,
  testCount,
} from '@/session/verification-model';
import { VerificationOutputDialog } from '@/session/verification-output';
import { type RailContext, registerRailCard } from './session-rail';

const ACCEPTANCE_TONES: Record<string, StatusTone> = {
  unverified: 'neutral',
  verifying: 'accent',
  accepted: 'success',
  failed: 'danger',
  environment_unavailable: 'warning',
};

const RUN_TONES: Record<VerificationRun['status'], StatusTone> = {
  not_run: 'neutral',
  running: 'accent',
  passed: 'success',
  failed: 'danger',
  timed_out: 'danger',
  cancelled: 'neutral',
  environment_unavailable: 'warning',
  stale: 'warning',
};

/** 这个项目的检查（侧栏看得见时读；会话状态变了重读，设置里改过就跟上）。 */
function useChecks(workspaceId: WorkspaceId, active: boolean, refreshKey: string) {
  const { client, view } = useHostConnection();
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'verification');
  const [checks, setChecks] = useState<CheckDefinition[]>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey 只用来触发重读。
  useEffect(() => {
    if (!client || !supported || !active) return;
    let stopped = false;
    client
      .request('checks.list', { workspaceId })
      .then((result) => {
        if (!stopped) setChecks(result.checks);
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [client, supported, active, workspaceId, refreshKey]);
  return { supported, checks };
}

function useVerificationCard({ sessionId, session, entry, visible }: RailContext) {
  const state = useTranscript(sessionId);
  const verification = state?.transcript.verification;
  const { supported, checks } = useChecks(entry.workspace.id, visible, session.state);
  if (!supported || session.parentSessionId !== undefined || isChats(entry.workspace)) return null;
  if (verification === undefined && checks !== undefined && checks.length === 0) {
    return {
      details: <NoChecks />,
    };
  }
  const acceptance = verification?.acceptance ?? { status: 'unverified' as const };
  return {
    summary: (
      <>
        <StatusDot
          tone={ACCEPTANCE_TONES[acceptance.status] ?? 'neutral'}
          pulse={acceptance.status === 'verifying'}
        />
        <span>{t(ACCEPTANCE_LABELS[acceptance.status])}</span>
      </>
    ),
    details: (
      <VerificationDetails
        sessionId={sessionId}
        busy={isBusy(session.state)}
        hasChecks={checks === undefined || checks.length > 0}
      />
    ),
  };
}

function NoChecks() {
  const navigate = useNavigate();
  return (
    <div className="flex h-6 items-center gap-2 text-xs text-muted-foreground">
      <span className="flex-1">{t('verification.reason.no_checks')}</span>
      <SettingsButton onClick={() => void navigate(paths.settings('workspaces'))} />
    </div>
  );
}

function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <IconButton
      label={t('verification.settings')}
      size="icon-xs"
      className="-mr-1"
      onClick={onClick}
      data-testid="rail-checks-settings"
    >
      <Settings />
    </IconButton>
  );
}

function VerificationDetails({
  sessionId,
  busy,
  hasChecks,
}: {
  sessionId: SessionId;
  busy: boolean;
  hasChecks: boolean;
}) {
  const { client } = useHostConnection();
  const navigate = useNavigate();
  const state = useTranscript(sessionId);
  const verification = state?.transcript.verification;
  const [viewing, setViewing] = useState<VerificationRun>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const acceptance = verification?.acceptance;
  const runs = latestRound(verification);
  const running = acceptance?.status === 'verifying';
  const status = acceptance?.status ?? 'unverified';
  const reason = status === 'accepted' ? undefined : reasonLabel(acceptance?.reason);

  const act = async (method: 'verification.run' | 'verification.cancel') => {
    if (!client) return;
    setPending(true);
    setError(undefined);
    try {
      await client.request(method, { sessionId });
    } catch (reason) {
      setError(t('verification.failed', { error: describe(reason) }));
    } finally {
      setPending(false);
    }
  };

  return (
    <div data-testid="rail-verification">
      <p className="mb-2 flex min-w-0 items-center gap-2 text-sm" data-testid="rail-acceptance">
        <StatusDot tone={ACCEPTANCE_TONES[status] ?? 'neutral'} pulse={status === 'verifying'} />
        <span className="shrink-0">{t(ACCEPTANCE_LABELS[status])}</span>
        {reason && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">· {t(reason)}</span>
        )}
      </p>
      {runs.length > 0 && (
        <ul className="space-y-0.5">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} onOpen={() => setViewing(run)} />
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <div className="mt-3 flex h-6 items-center gap-2">
        {running ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!client || pending}
            onClick={() => void act('verification.cancel')}
            data-action="cancel-checks"
          >
            {t('verification.cancel')}
          </Button>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={!client || pending || busy || !hasChecks}
            onClick={() => void act('verification.run')}
            data-action="run-checks"
          >
            {t('verification.run')}
          </Button>
        )}
        <span className="flex-1" />
        <SettingsButton onClick={() => void navigate(paths.settings('workspaces'))} />
      </div>
      {viewing && (
        <VerificationOutputDialog
          sessionId={sessionId}
          run={viewing}
          onClose={() => setViewing(undefined)}
        />
      )}
    </div>
  );
}

function RunRow({ run, onOpen }: { run: VerificationRun; onOpen: () => void }) {
  const queued = isQueued(run);
  const count = testCount(run);
  const reason = reasonLabel(run.reason);
  const status = queued ? t('verification.status.queued') : t(RUN_LABELS[run.status]);
  const detail =
    count !== undefined && count.total > 0
      ? t('verification.tests', count)
      : run.durationMs !== undefined
        ? formatDuration(run.durationMs)
        : undefined;
  const hasOutput = run.output !== undefined && run.output.bytes > 0;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        disabled={!hasOutput}
        title={reason ? `${status} · ${t(reason)}` : status}
        data-run-status={run.status}
        className={cn(
          '-mx-1.5 flex h-7 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2.5 rounded-md px-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
          hasOutput && 'hover:bg-muted',
        )}
      >
        <StatusDot
          tone={queued ? 'neutral' : RUN_TONES[run.status]}
          pulse={run.status === 'running' && !queued}
          label={status}
        />
        <span className="min-w-0 flex-1 truncate">{run.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {detail ?? status}
        </span>
      </button>
    </li>
  );
}

registerRailCard({
  id: 'verification',
  order: 32,
  title: () => t('rail.checks'),
  useCard: useVerificationCard,
});
