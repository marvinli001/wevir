import type { WevirClient } from '@wevir/client-sdk';
import {
  ASSISTANT_PROACTIVITY,
  type Automation,
  type ChannelThread,
  DEFAULT_ASSISTANT_BUDGET,
} from '@wevir/protocol';
import { Clock3, LoaderCircle, Pause, Pencil, Play, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { runAutomation } from '@/automations/automation-actions';
import { ScheduleCard } from '@/automations/automation-dialog';
import { draftOfSchedule, isRunActive, scheduleOfDraft } from '@/automations/automations-model';
import { useAutomations } from '@/automations/use-automations';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { Disclosure } from '@/session/disclosure';
import { formatRelativeTime } from '@/session/subagent-model';
import { Segmented } from '@/settings/settings-ui';
import { AssistantAvatar } from './assistant-avatar';
import { editAssistant } from './assistant-dialog';
import { MemoryPanel, RulesPanel, TasksPanel } from './assistant-panels';
import {
  type AssistantView,
  proactivityLabel,
  proactivityOf,
  routineStatus,
} from './assistants-model';

export function AssistantPanel({
  client,
  view,
  onPause,
  onOpenThread,
  onError,
  error,
}: {
  client: WevirClient;
  view: AssistantView;
  onPause: () => void;
  onOpenThread: (thread: ChannelThread) => void;
  onError: (text: string) => void;
  error?: string;
}) {
  const { channel } = view;
  const automations = useAutomations(client);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const routines = (automations.data ?? []).filter((item) => item.channelId === channel.id);
  const threads = view.threads.filter(
    (thread) => thread.status === 'working' || thread.status === 'waiting',
  );
  const openTasks = view.tasks.filter(
    (task) => task.status === 'pending' || task.status === 'in_progress',
  ).length;
  const paused = channel.state === 'paused';
  const proactivity = proactivityOf(channel.budget ?? DEFAULT_ASSISTANT_BUDGET);
  const manage = client.can('workspace.write');
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-6"
      data-assistant-panel={channel.id}
    >
      {error && (
        <p className="sticky top-0 z-10 bg-popover py-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <section className="flex flex-col items-center gap-2 border-b border-border pb-5 pt-4 text-center">
        {channel.assistant && (
          <AssistantAvatar
            avatar={channel.assistant.avatar}
            size={56}
            working={channel.answering === true}
            paused={paused}
          />
        )}
        <h3 className="max-w-full break-words text-base font-semibold">{channel.title}</h3>
        {channel.lastActiveAt !== undefined && (
          <p className="text-xs text-muted-foreground" data-last-active>
            {t('assistants.panel.lastActive', {
              time: formatRelativeTime(channel.lastActiveAt, now),
            })}
          </p>
        )}
        {channel.assistant?.description && (
          <p className="max-w-full whitespace-pre-wrap break-words text-sm text-soft-foreground">
            {channel.assistant.description}
          </p>
        )}
        <div className="mt-2 grid w-full grid-cols-2 gap-2">
          <Button
            variant="outline"
            disabled={!manage}
            onClick={onPause}
            data-action={paused ? 'resume' : 'pause'}
          >
            {paused ? <Play /> : <Pause />}
            {t(paused ? 'assistants.resume' : 'assistants.pause')}
          </Button>
          <Button
            variant="outline"
            disabled={!manage}
            onClick={() => editAssistant(channel)}
            data-action="edit-profile"
          >
            <Pencil />
            {t('assistants.edit')}
          </Button>
        </div>
      </section>
      <section className="border-b border-border py-4" data-recent-activity>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{t('assistants.panel.recent')}</h3>
          {channel.proactiveLimited && (
            <span
              className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
              data-proactive-limited
            >
              {t('assistants.panel.limited')}
            </span>
          )}
        </div>
        {automations.error !== undefined && (
          <p className="text-xs text-destructive" role="alert">
            {describe(automations.error)}
          </p>
        )}
        <div className="flex flex-col gap-1">
          {threads.map((thread) => (
            <button
              key={thread.sessionId}
              type="button"
              className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-left outline-none hover:bg-muted focus-visible:focus-ring"
              onClick={() => onOpenThread(thread)}
              data-background-task={thread.sessionId}
            >
              <LoaderCircle
                aria-hidden
                className="size-4 shrink-0 animate-spin text-running motion-reduce:animate-none"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{thread.title}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {thread.doing ??
                    t(
                      thread.status === 'waiting'
                        ? 'assistants.thread.waiting'
                        : 'assistants.thread.working',
                    )}
                </span>
              </span>
            </button>
          ))}
          {routines.map((automation) => (
            <Routine
              key={automation.id}
              client={client}
              automation={automation}
              now={now}
              onError={onError}
            />
          ))}
          {automations.data !== undefined && routines.length === 0 && threads.length === 0 && (
            <p className="py-2 text-xs text-muted-foreground">{t('assistants.panel.empty')}</p>
          )}
        </div>
      </section>
      <div className="divide-y divide-border">
        <Disclosure
          summary={
            <span className="flex flex-1 items-center justify-between text-sm font-medium">
              {t('assistants.tab.tasks')}
              <span className="text-xs text-muted-foreground">{openTasks}</span>
            </span>
          }
          summaryClassName="py-3"
        >
          <div className="pb-3">
            <TasksPanel client={client} channel={channel} tasks={view.tasks} onError={onError} />
          </div>
        </Disclosure>
        <div className="py-1">
          <MemoryPanel client={client} channel={channel} collapsible />
        </div>
        <Disclosure
          summary={<span className="text-sm font-medium">{t('assistants.rules.title')}</span>}
          summaryClassName="py-3"
        >
          <div className="pb-3">
            <RulesPanel client={client} channel={channel} onError={onError} />
          </div>
        </Disclosure>
      </div>
      <section className="flex flex-col gap-2 border-t border-border pt-4" data-proactivity>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{t('assistants.panel.proactivity')}</h3>
          {proactivity === undefined && (
            <span className="text-xs text-muted-foreground">{t('assistants.panel.custom')}</span>
          )}
        </div>
        <Segmented
          label={t('assistants.panel.proactivity')}
          value={proactivity}
          disabled={!manage}
          options={(
            Object.keys(ASSISTANT_PROACTIVITY) as (keyof typeof ASSISTANT_PROACTIVITY)[]
          ).map((value) => ({ value, label: t(proactivityLabel[value]) }))}
          onChange={(value) => {
            client
              .request('channel.update', {
                channelId: channel.id,
                budget: ASSISTANT_PROACTIVITY[value],
              })
              .catch((reason: unknown) =>
                onError(t('assistants.actionFailed', { error: describe(reason) })),
              );
          }}
        />
      </section>
    </div>
  );
}

function Routine({
  client,
  automation,
  now,
  onError,
}: {
  client: WevirClient;
  automation: Automation;
  now: number;
  onError: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState(() =>
    draftOfSchedule(automation.schedule, automation.timezone, now),
  );
  const update = async (params: { enabled?: boolean; schedule?: Automation['schedule'] }) => {
    setBusy(true);
    setError(undefined);
    try {
      await client.request('automation.update', { automationId: automation.id, ...params });
    } catch (reason) {
      setError(t('assistants.actionFailed', { error: describe(reason) }));
      onError(t('assistants.actionFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };
  const schedule = scheduleOfDraft(draft, automation.timezone);
  const manage = client.can('workspace.write');
  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) setDraft(draftOfSchedule(automation.schedule, automation.timezone, now));
          setOpen(next);
        }}
      >
        <PopoverTrigger
          render={
            <button
              type="button"
              className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left outline-none hover:bg-muted focus-visible:focus-ring"
              data-automation-id={automation.id}
            />
          }
        >
          <Clock3 aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm">{automation.title}</span>
            <span className="block truncate text-xs text-muted-foreground" data-routine-status>
              {routineStatus(automation, now)}
            </span>
          </span>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-96 max-w-[calc(100vw-2rem)]"
          data-routine-editor={automation.id}
        >
          <PopoverTitle className="px-1 font-medium">{automation.title}</PopoverTitle>
          {error && (
            <p className="px-1 text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
          <fieldset disabled={!manage || busy} className="min-w-0 space-y-2">
            <ScheduleCard
              draft={draft}
              timezone={automation.timezone}
              onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
            />
            <div className="flex items-center justify-between px-1 py-1">
              <span>{t('automations.enabled')}</span>
              <Switch
                checked={automation.enabled && automation.autoPausedAt === undefined}
                label={automation.title}
                onChange={(enabled) => void update({ enabled })}
                data-action="toggle-routine"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                disabled={isRunActive(automation.lastRun)}
                onClick={() => runAutomation(client, automation, onError)}
                data-action="run-routine"
              >
                <Play />
                {t('automations.runNow')}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setConfirming(true)}
                data-action="delete-routine"
              >
                <Trash2 />
                {t('automations.delete')}
              </Button>
              <Button
                className="ml-auto"
                disabled={schedule === undefined}
                onClick={async () => {
                  if (schedule !== undefined) await update({ schedule });
                }}
                data-action="save-routine"
              >
                {t('automations.dialog.save')}
              </Button>
            </div>
          </fieldset>
        </PopoverContent>
      </Popover>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('automations.delete.title', { name: automation.title })}
        confirmLabel={t('automations.delete')}
        failure={(error) => t('automations.delete.failed', { error })}
        onConfirm={async () => {
          await client.request('automation.delete', { automationId: automation.id });
          setOpen(false);
        }}
      >
        <p>{t('automations.delete.body')}</p>
      </ConfirmDialog>
    </>
  );
}
