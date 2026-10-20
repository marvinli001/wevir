// 自动化详情（0.66.0，`/automations/:automationId`）：标题与启用开关、立即运行、编辑、⋯；设置一张卡片（计划、下一次、项目、模型、
// 权限、通知、运行方式、检查脚本、创建者）；连续失败自动暂停时一行说明（0.73.0）；指令；运行记录（新的在前，点开运行所在的会话）。

import type { WevirClient } from '@wevir/client-sdk';
import {
  AUTOMATION_MAX_CONSECUTIVE_FAILURES,
  type Automation,
  type AutomationCheckWake,
  type AutomationId,
  type AutomationNotify,
  type AutomationRun,
  type AutomationRunStatus,
} from '@wevir/protocol';
import { cn } from 'cn';
import {
  Ban,
  CalendarClock,
  ChevronLeft,
  CircleCheck,
  CircleMinus,
  CircleX,
  Hand,
  LoaderCircle,
  Pencil,
  Play,
  SkipForward,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useWorkbenchData } from '@/data/workbench-data';
import type { WorkspaceEntry } from '@/data/workbench-model';
import { describe } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import { paths } from '@/routes/paths';
import { effortLabel } from '@/session/model-picker';
import { PERMISSION_META } from '@/session/permission-picker';
import { type Notice, NoticeBanner } from '@/settings/settings-ui';
import { AutomationMenu, runAutomation } from './automation-actions';
import { openAutomationDialog } from './automation-dialog';
import { formatMoment, isRunActive, scheduleText, stateOf } from './automations-model';
import { STATE_META, StateIcon } from './automations-page';
import { useAutomation } from './use-automations';

const NOTIFY_LABEL: Record<AutomationNotify, PlainMessageKey> = {
  always: 'automations.notify.always',
  important: 'automations.notify.important',
  changes: 'automations.notify.changes',
  failures: 'automations.notify.failures',
  never: 'automations.notify.never',
};

const RUN_META: Record<
  AutomationRunStatus,
  { label: PlainMessageKey; icon: typeof Play; tone: string }
> = {
  checking: { label: 'automations.run.checking', icon: LoaderCircle, tone: 'text-running' },
  running: { label: 'automations.run.running', icon: LoaderCircle, tone: 'text-running' },
  waiting: { label: 'automations.run.waiting', icon: Hand, tone: 'text-warning' },
  completed: { label: 'automations.run.completed', icon: CircleCheck, tone: 'text-success' },
  failed: { label: 'automations.run.failed', icon: CircleX, tone: 'text-destructive' },
  cancelled: { label: 'automations.run.cancelled', icon: Ban, tone: 'text-muted-foreground' },
  skipped: { label: 'automations.run.skipped', icon: SkipForward, tone: 'text-muted-foreground' },
  silent: { label: 'automations.run.silent', icon: CircleMinus, tone: 'text-muted-foreground' },
};

const WAKE_LABEL: Record<AutomationCheckWake, PlainMessageKey> = {
  exit_code: 'automations.wake.exit_code',
  output_changed: 'automations.wake.output_changed',
};

export function AutomationDetail({
  client,
  automationId,
}: {
  client: WevirClient;
  automationId: AutomationId;
}) {
  const data = useAutomation(client, automationId);
  const navigate = useNavigate();
  const [notice, setNotice] = useState<Notice>();
  const onError = (text: string) => setNotice({ tone: 'error', text });
  const loaded = data.data;

  if (loaded === undefined) {
    if (data.error === undefined) return null;
    return (
      <EmptyState icon={<CalendarClock />} title={t('automations.notFound')}>
        <Link to={paths.automations()} className="underline underline-offset-4">
          {t('automations.title')}
        </Link>
      </EmptyState>
    );
  }
  const { automation, runs } = loaded;
  const state = stateOf(automation);
  const toggle = (enabled: boolean) => {
    client
      .request('automation.update', { automationId: automation.id, enabled })
      .catch((reason: unknown) =>
        onError(t('automations.saveFailed', { error: describe(reason) })),
      );
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="automation-detail">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-200 px-5 pt-6 pb-16 sm:px-10">
          <Link
            to={paths.automations()}
            className="mb-4 inline-flex items-center gap-1 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring"
          >
            <ChevronLeft aria-hidden className="size-4" />
            {t('automations.title')}
          </Link>
          <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight break-words">
                {automation.title}
              </h1>
              <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                <StateIcon state={state} className="size-3.5" />
                <span className={STATE_META[state].tone}>{t(STATE_META[state].label)}</span>
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={automation.enabled}
                label={t('automations.enabled')}
                onChange={toggle}
                data-action="toggle"
              />
              <Button
                variant="outline"
                disabled={isRunActive(automation.lastRun)}
                onClick={() => runAutomation(client, automation, onError)}
                data-action="run"
              >
                <Play data-icon="inline-start" />
                {t('automations.runNow')}
              </Button>
              <Button
                variant="outline"
                onClick={() => openAutomationDialog({ kind: 'edit', automation })}
                data-action="edit"
              >
                <Pencil data-icon="inline-start" />
                {t('automations.edit')}
              </Button>
              <AutomationMenu
                client={client}
                automation={automation}
                onError={onError}
                onDeleted={() => navigate(paths.automations())}
              />
            </div>
          </header>

          {notice && (
            <div className="mb-4">
              <NoticeBanner notice={notice} />
            </div>
          )}
          {automation.autoPausedAt !== undefined && !automation.enabled && (
            <div className="mb-4" data-testid="automation-auto-paused">
              <NoticeBanner
                notice={{
                  tone: 'error',
                  text: t('automations.autoPaused', { count: AUTOMATION_MAX_CONSECUTIVE_FAILURES }),
                }}
              />
            </div>
          )}

          <Settings automation={automation} />

          <Section title={t('automations.field.prompt')}>
            <p className="rounded-xl border border-border bg-card px-4 py-3 text-sm whitespace-pre-wrap break-words">
              {automation.prompt}
            </p>
          </Section>

          <Section title={t('automations.runs')}>
            {runs.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border-strong px-4 py-8 text-center text-sm text-muted-foreground">
                {t('automations.noRuns')}
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border bg-card">
                {runs.map((run) => (
                  <RunRow key={run.id} run={run} timezone={automation.timezone} />
                ))}
              </ul>
            )}
          </Section>
        </div>
      </ScrollArea>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-7">
      <h2 className="mb-2 px-1 text-sm font-medium text-soft-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Settings({ automation }: { automation: Automation }) {
  const workbench = useWorkbenchData();
  const ready = workbench.status === 'ready' ? workbench : undefined;
  const project = ready?.workspaces.find(
    (entry) => entry.workspace.id === automation.workspaceId,
  )?.workspace;
  const provider = ready?.providers.find((candidate) => candidate.id === automation.providerId);
  const model = [
    provider?.displayName ?? automation.providerId,
    automation.modelId ?? provider?.defaultModelId,
    automation.reasoningEffort !== undefined && effortLabel(automation.reasoningEffort),
  ]
    .filter(Boolean)
    .join(' · ');
  const creator =
    automation.createdBy.kind === 'agent'
      ? sessionLink(
          ready?.workspaces,
          automation.createdBy.sessionId,
          t('automations.creator.agent'),
        )
      : t('automations.creator.user');
  const rows: [PlainMessageKey, ReactNode][] = [
    ['automations.field.schedule', scheduleText(automation.schedule, automation.timezone)],
    [
      'automations.field.nextRun',
      automation.nextRunAt === undefined
        ? '—'
        : formatMoment(Date.parse(automation.nextRunAt), automation.timezone),
    ],
    ['automations.field.timezone', automation.timezone],
    [
      'automations.field.project',
      automation.workspaceId === undefined
        ? t('automations.field.noProject')
        : (project?.displayName ?? automation.workspaceId),
    ],
    ['automations.field.model', model],
    ['automations.field.permission', t(PERMISSION_META[automation.permissionMode].label)],
    ['automations.field.notify', t(NOTIFY_LABEL[automation.notify])],
    [
      'automations.field.runsIn',
      automation.newSessionEachRun
        ? t('automations.runsIn.new')
        : automation.sessionId !== undefined
          ? sessionLink(ready?.workspaces, automation.sessionId, t('automations.runsIn.same'))
          : t('automations.runsIn.same'),
    ],
    ...(automation.check === undefined
      ? []
      : [
          [
            'automations.field.check',
            <span key="check" className="flex flex-col gap-0.5">
              <code className="font-mono text-xs break-all">{automation.check.command}</code>
              <span className="text-xs text-muted-foreground">
                {t('automations.field.wake')} · {t(WAKE_LABEL[automation.check.wake])}
              </span>
            </span>,
          ] as [PlainMessageKey, ReactNode],
        ]),
    ['automations.field.creator', creator],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 rounded-xl border border-border bg-card px-4 py-3.5 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{t(label)}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

type Entries = readonly WorkspaceEntry[];

function sessionPath(entries: Entries | undefined, sessionId: string): string | undefined {
  const entry = entries?.find((candidate) =>
    candidate.sessions.some((session) => session.id === sessionId),
  );
  return entry && paths.session(entry.workspace.id, sessionId);
}

function sessionLink(entries: Entries | undefined, sessionId: string, label: string): ReactNode {
  const to = sessionPath(entries, sessionId);
  if (to === undefined) return label;
  return (
    <Link
      to={to}
      className="underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
    >
      {label}
    </Link>
  );
}

const TRIGGER_LABEL: Record<AutomationRun['trigger'], PlainMessageKey> = {
  schedule: 'automations.trigger.schedule',
  manual: 'automations.trigger.manual',
  catch_up: 'automations.trigger.catch_up',
};

function RunRow({ run, timezone }: { run: AutomationRun; timezone: string }) {
  const workbench = useWorkbenchData();
  const navigate = useNavigate();
  const meta = RUN_META[run.status];
  const Icon = meta.icon;
  const to =
    run.sessionId !== undefined && workbench.status === 'ready'
      ? sessionPath(workbench.workspaces, run.sessionId)
      : undefined;
  const detail =
    run.error ??
    (run.quiet ? t('automations.run.quiet') : run.summary) ??
    (run.check === undefined ? undefined : checkDetail(run.check));
  const content = (
    <>
      <Icon
        aria-hidden
        className={cn(
          'mt-0.5 size-4 shrink-0',
          meta.tone,
          (run.status === 'running' || run.status === 'checking') && 'animate-spin',
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium">{t(meta.label)}</span>
          <span className="text-xs text-muted-foreground">
            {formatMoment(Date.parse(run.startedAt), timezone)} · {t(TRIGGER_LABEL[run.trigger])}
          </span>
        </span>
        {detail && (
          <span
            className={cn(
              'mt-0.5 line-clamp-2 block text-sm text-muted-foreground',
              run.error !== undefined && 'text-destructive',
            )}
          >
            {detail}
          </span>
        )}
      </span>
    </>
  );
  return (
    <li data-run={run.id} data-status={run.status}>
      {to ? (
        <button
          type="button"
          onClick={() => navigate(to)}
          className="flex w-full items-start gap-3 px-4 py-3 text-left outline-none transition-colors duration-150 first:rounded-t-xl hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring-soft focus-visible:ring-inset"
        >
          {content}
        </button>
      ) : (
        <div className="flex items-start gap-3 px-4 py-3">{content}</div>
      )}
    </li>
  );
}

/** 没有回答的运行（检查脚本没唤醒）显示脚本输出的最后一行，没有输出时显示退出码。 */
function checkDetail(check: NonNullable<AutomationRun['check']>): string {
  const last = check.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  return last ?? t('automations.check.exitCode', { code: check.exitCode ?? '—' });
}
