// 助理的另外三个页签（0.120.0–0.121.0）：任务（只有用户能标完成，`channel.updateTask`）、日程与规矩（发给它的自动化，规矩的档位、
// 每天的预算，`automation.update` / `channel.update`）、记忆（它的隐藏工作区的项目记忆，停用与删除）。

import type { WevirClient } from '@wevir/client-sdk';
import { hostSupports } from '@wevir/client-sdk';
import {
  ASSISTANT_RULE_CATEGORIES,
  type AssistantRuleTier,
  type Automation,
  type BoardTask,
  type Channel,
  type ChannelBudget,
  DEFAULT_ASSISTANT_BUDGET,
  DEFAULT_ASSISTANT_RULES,
  type MemorySummary,
  type MethodParams,
  type MethodResult,
} from '@wevir/protocol';
import { cn } from 'cn';
import { Circle, CircleCheck, LoaderCircle, Sun, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { scheduleText } from '@/automations/automations-model';
import { useAutomations } from '@/automations/use-automations';
import { IconButton } from '@/components/icon-button';
import { Switch } from '@/components/switch';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { describe } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import { EmptyList, LIST_CARD } from '@/settings/settings-ui';
import { CATEGORY_LABEL, groupTasks } from './assistants-model';

const SECTION_TITLE = 'mb-2 text-sm font-medium text-soft-foreground';
const ROW = 'flex min-h-12 items-center gap-3 px-3.5 py-2.5';

// ---- 任务 ----

export function TasksPanel({
  client,
  channel,
  tasks,
  onError,
}: {
  client: WevirClient;
  channel: Channel;
  tasks: readonly BoardTask[];
  onError: (text: string) => void;
}) {
  const { open, done } = groupTasks(tasks);
  const [busy, setBusy] = useState<string>();
  const set = async (task: BoardTask, status: BoardTask['status']) => {
    setBusy(task.id);
    try {
      await client.request('channel.updateTask', {
        channelId: channel.id,
        taskId: task.id,
        status,
      });
    } catch (reason) {
      onError(t('assistants.actionFailed', { error: describe(reason) }));
    } finally {
      setBusy(undefined);
    }
  };
  if (tasks.length === 0) return <EmptyList>{t('assistants.tasks.empty')}</EmptyList>;
  const row = (task: BoardTask) => {
    const completed = task.status === 'completed' || task.status === 'cancelled';
    return (
      <li key={task.id} className={ROW} data-task-status={task.status}>
        <button
          type="button"
          className="shrink-0 rounded-full outline-none focus-visible:focus-ring disabled:opacity-50"
          disabled={busy === task.id}
          aria-label={t(completed ? 'assistants.tasks.reopen' : 'assistants.tasks.complete')}
          onClick={() => set(task, completed ? 'pending' : 'completed')}
          data-action={completed ? 'reopen' : 'complete'}
        >
          {busy === task.id ? (
            <LoaderCircle aria-hidden className="size-4.5 animate-spin text-muted-foreground" />
          ) : completed ? (
            <CircleCheck aria-hidden className="size-4.5 text-success" />
          ) : (
            <Circle aria-hidden className="size-4.5 text-muted-foreground hover:text-foreground" />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <p
            className={cn('text-sm break-words', completed && 'text-muted-foreground line-through')}
          >
            {task.subject}
          </p>
          {task.status === 'in_progress' && (
            <p className="text-xs text-running">{t('assistants.tasks.inProgress')}</p>
          )}
        </div>
      </li>
    );
  };
  return (
    <div className="flex flex-col gap-6">
      {open.length > 0 && (
        <section>
          <h3 className={SECTION_TITLE}>{t('assistants.tasks.open', { count: open.length })}</h3>
          <ul className={LIST_CARD}>{open.map(row)}</ul>
        </section>
      )}
      {done.length > 0 && (
        <section>
          <h3 className={SECTION_TITLE}>{t('assistants.tasks.done', { count: done.length })}</h3>
          <ul className={LIST_CARD}>{done.map(row)}</ul>
        </section>
      )}
    </div>
  );
}

// ---- 日程与规矩 ----

const TIER_LABEL: Record<AssistantRuleTier, PlainMessageKey> = {
  do: 'assistants.rules.tier.do',
  tell: 'assistants.rules.tier.tell',
  ask: 'assistants.rules.tier.ask',
  hand_off: 'assistants.rules.tier.hand_off',
};
const TIER_ORDER: readonly AssistantRuleTier[] = ['do', 'tell', 'ask', 'hand_off'];
const WAKE_CHOICES = [10, 20, 50, 100, 200] as const;
const TOKEN_CHOICES = [100_000, 200_000, 500_000, 1_000_000, 5_000_000] as const;

export function SchedulePanel({
  client,
  channel,
  schedules,
  onError,
}: {
  client: WevirClient;
  channel: Channel;
  /** Host 有 `channel_schedules`。 */
  schedules: boolean;
  onError: (text: string) => void;
}) {
  const rules = channel.assistant?.rules ?? {};
  const update = (params: Omit<MethodParams<'channel.update'>, 'channelId'>) =>
    client
      .request('channel.update', { channelId: channel.id, ...params })
      .catch((reason: unknown) =>
        onError(t('assistants.actionFailed', { error: describe(reason) })),
      );
  const budget = channel.budget ?? DEFAULT_ASSISTANT_BUDGET;
  const usage = channel.usage;
  const setBudget = (next: Partial<ChannelBudget>) => update({ budget: { ...budget, ...next } });
  const numberFormat = new Intl.NumberFormat();
  return (
    <div className="flex flex-col gap-6">
      {schedules && <Schedules client={client} channel={channel} onError={onError} />}
      <section>
        <h3 className={SECTION_TITLE}>{t('assistants.rules.title')}</h3>
        <ul className={LIST_CARD}>
          {ASSISTANT_RULE_CATEGORIES.map((category) => (
            <li key={category} className={ROW}>
              <span className="min-w-0 flex-1 text-sm">{t(CATEGORY_LABEL[category])}</span>
              <Select
                className="w-36"
                value={rules[category] ?? DEFAULT_ASSISTANT_RULES[category]}
                options={TIER_ORDER.map((tier) => ({ value: tier, label: t(TIER_LABEL[tier]) }))}
                aria-label={t(CATEGORY_LABEL[category])}
                onValueChange={(tier) => update({ rules: { ...rules, [category]: tier } })}
                data-rule={category}
              />
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3 className={SECTION_TITLE}>{t('assistants.budget.title')}</h3>
        <ul className={LIST_CARD}>
          <li className={ROW}>
            <span className="min-w-0 flex-1 text-sm">
              {t('assistants.budget.wakes', { used: usage?.wakes ?? 0 })}
            </span>
            <Select
              className="w-36"
              value={String(budget.dailyWakes)}
              options={choices(WAKE_CHOICES, budget.dailyWakes).map((value) => ({
                value: String(value),
                label: numberFormat.format(value),
              }))}
              aria-label={t('assistants.budget.wakesLimit')}
              onValueChange={(value) => setBudget({ dailyWakes: Number(value) })}
              data-field="dailyWakes"
            />
          </li>
          <li className={ROW}>
            <span className="min-w-0 flex-1 text-sm">
              {t('assistants.budget.tokens', { used: numberFormat.format(usage?.tokens ?? 0) })}
            </span>
            <Select
              className="w-36"
              value={String(budget.dailyTokens)}
              options={choices(TOKEN_CHOICES, budget.dailyTokens).map((value) => ({
                value: String(value),
                label: numberFormat.format(value),
              }))}
              aria-label={t('assistants.budget.tokensLimit')}
              onValueChange={(value) => setBudget({ dailyTokens: Number(value) })}
              data-field="dailyTokens"
            />
          </li>
        </ul>
      </section>
    </div>
  );
}

/** 预设里加上现在的值（别处改成了不在预设里的数）。 */
function choices(preset: readonly number[], current: number): number[] {
  return [...new Set([...preset, current])].sort((a, b) => a - b);
}

function Schedules({
  client,
  channel,
  onError,
}: {
  client: WevirClient;
  channel: Channel;
  onError: (text: string) => void;
}) {
  const data = useAutomations(client);
  const items = (data.data ?? []).filter((item) => item.channelId === channel.id);
  const update = (automation: Automation, params: { enabled?: boolean; time?: string }) => {
    const schedule =
      params.time !== undefined && automation.schedule.kind === 'daily'
        ? { ...automation.schedule, time: params.time }
        : undefined;
    client
      .request('automation.update', {
        automationId: automation.id,
        ...(params.enabled !== undefined && { enabled: params.enabled }),
        ...(schedule !== undefined && { schedule }),
      })
      .catch((reason: unknown) =>
        onError(t('assistants.actionFailed', { error: describe(reason) })),
      );
  };
  return (
    <section>
      <h3 className={SECTION_TITLE}>{t('assistants.schedule.title')}</h3>
      {data.data === undefined ? null : items.length === 0 ? (
        <EmptyList>{t('assistants.schedule.empty')}</EmptyList>
      ) : (
        <ul className={LIST_CARD}>
          {items.map((automation) => (
            <li key={automation.id} className={ROW} data-automation-id={automation.id}>
              {automation.brief && <Sun aria-hidden className="size-4 shrink-0 text-warning" />}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">
                  {automation.brief ? t('assistants.schedule.brief') : automation.title}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {scheduleText(automation.schedule, automation.timezone)}
                </p>
              </div>
              {automation.schedule.kind === 'daily' && (
                <Input
                  type="time"
                  className="w-36"
                  defaultValue={automation.schedule.time}
                  key={automation.schedule.time}
                  aria-label={t('assistants.schedule.time')}
                  onBlur={(event) => {
                    const time = event.currentTarget.value;
                    if (
                      automation.schedule.kind === 'daily' &&
                      time !== '' &&
                      time !== automation.schedule.time
                    ) {
                      update(automation, { time });
                    }
                  }}
                  data-field="time"
                />
              )}
              <Switch
                checked={automation.enabled}
                label={automation.title}
                onChange={(enabled) => update(automation, { enabled })}
                data-action="toggle"
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- 记忆 ----

export function MemoryPanel({ client, channel }: { client: WevirClient; channel: Channel }) {
  const supported = hostSupports(client.hello.features, 'memory');
  const manage = client.can('host.manage');
  const [listing, setListing] = useState<MethodResult<'memory.list'>>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  useEffect(() => {
    if (!supported) return;
    setListing(undefined);
    return client.watchMemory(
      channel.workspaceId,
      (value) => setListing(value),
      (reason) => setError(t('assistants.memory.loadFailed', { error: describe(reason) })),
    );
  }, [client, supported, channel.workspaceId]);
  if (!supported) return <EmptyList>{t('settings.memory.unsupported')}</EmptyList>;
  const notes = (listing?.notes ?? []).filter((note) => note.scope === 'project');
  const act = async (note: MemorySummary, action: () => Promise<unknown>) => {
    setBusy(note.name);
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      setError(t('assistants.actionFailed', { error: describe(reason) }));
    } finally {
      setBusy(undefined);
    }
  };
  const target = (note: MemorySummary) => ({
    scope: 'project' as const,
    name: note.name,
    workspaceId: channel.workspaceId,
  });
  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {listing === undefined ? null : notes.length === 0 ? (
        <EmptyList>{t('assistants.memory.empty')}</EmptyList>
      ) : (
        <ul className={LIST_CARD}>
          {notes.map((note) => (
            <li key={note.name} className={ROW} data-memory={note.name}>
              <div className="min-w-0 flex-1">
                <p className={cn('truncate text-sm', !note.enabled && 'text-muted-foreground')}>
                  {note.name}
                </p>
                <p className="line-clamp-2 text-xs break-words text-muted-foreground">
                  {note.description}
                </p>
              </div>
              {manage && (
                <>
                  <Switch
                    checked={note.enabled}
                    label={note.name}
                    disabled={busy === note.name}
                    onChange={(enabled) =>
                      act(note, () =>
                        client.request('memory.setEnabled', { ...target(note), enabled }),
                      )
                    }
                  />
                  <IconButton
                    label={t('assistants.memory.delete')}
                    disabled={busy === note.name}
                    onClick={() =>
                      act(note, () =>
                        client.request('memory.delete', {
                          ...target(note),
                          revision: note.revision,
                        }),
                      )
                    }
                    data-action="delete-memory"
                  >
                    <Trash2 />
                  </IconButton>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
