// 自动化页（0.66.0，Host 功能 `automations`）：照 Claude 的 Scheduled tasks——大标题、“我的 / 模板”分段、搜索与“新建”；没有
// 自动化时是秒表插图、波浪分隔线与模板卡片。列表取 Codex 的长处：按“即将执行 / 手动 / 已暂停 / 已完成”分组，每行写计划、
// 状态与下一次运行的时刻，右边是启用开关与 ⋯ 菜单。点行进详情页。纯逻辑在 automations-model.ts。

import type { WevirClient } from '@wevir/client-sdk';
import type { Automation } from '@wevir/protocol';
import { cn } from 'cn';
import {
  CalendarClock,
  CircleCheck,
  Clock,
  Hand,
  LoaderCircle,
  Pause,
  Plus,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { IconButton } from '@/components/icon-button';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { describe } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import { paths } from '@/routes/paths';
import { type Notice, NoticeBanner, Segmented } from '@/settings/settings-ui';
import { AutomationMenu } from './automation-actions';
import { openAutomationDialog } from './automation-dialog';
import {
  type AutomationGroup,
  type AutomationState,
  formatMoment,
  groupAutomations,
  matchesQuery,
  scheduleText,
  stateOf,
} from './automations-model';
import { TEMPLATES, templateText } from './templates';
import { useAutomations } from './use-automations';

type Tab = 'mine' | 'templates';

const GROUP_LABEL: Record<AutomationGroup, PlainMessageKey> = {
  upcoming: 'automations.group.upcoming',
  manual: 'automations.group.manual',
  paused: 'automations.group.paused',
  finished: 'automations.group.finished',
};

export const STATE_META: Record<
  AutomationState,
  { label: PlainMessageKey; icon: typeof Clock; tone?: string }
> = {
  running: { label: 'automations.state.running', icon: LoaderCircle, tone: 'text-running' },
  waiting: { label: 'automations.state.waiting', icon: Hand, tone: 'text-warning' },
  scheduled: { label: 'automations.state.scheduled', icon: CalendarClock },
  manual: { label: 'automations.state.manual', icon: Hand },
  paused: { label: 'automations.state.paused', icon: Pause },
  finished: { label: 'automations.state.finished', icon: CircleCheck },
};

export function AutomationsPage({ client }: { client: WevirClient }) {
  const data = useAutomations(client);
  const [tab, setTab] = useState<Tab>('mine');
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<Notice>();
  const onError = (text: string) => setNotice({ tone: 'error', text });
  // 发给助理的（0.121.0）在助理页的“日程与规矩”里，不进这里的列表。
  const automations = useMemo(
    () => data.data?.filter((item) => item.channelId === undefined),
    [data.data],
  );
  const groups = useMemo(
    () => groupAutomations((automations ?? []).filter((item) => matchesQuery(item, query))),
    [automations, query],
  );
  const empty = automations !== undefined && automations.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="automations-page">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-200 px-5 pt-8 pb-16 sm:px-10">
          <h1 className="mb-6 text-2xl font-semibold tracking-tight">{t('automations.title')}</h1>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <Segmented
              label={t('automations.title')}
              value={tab}
              options={[
                { value: 'mine', label: t('automations.tab.mine') },
                { value: 'templates', label: t('automations.tab.templates') },
              ]}
              onChange={setTab}
            />
            <div className="flex min-w-0 items-center gap-2">
              {tab === 'mine' && !empty && (
                <SearchBox
                  open={searching}
                  query={query}
                  onOpen={setSearching}
                  onQuery={setQuery}
                />
              )}
              <Button onClick={() => openAutomationDialog({ kind: 'create' })} data-action="create">
                <Plus data-icon="inline-start" />
                {t('automations.create')}
              </Button>
            </div>
          </div>

          {notice && (
            <div className="mb-4">
              <NoticeBanner notice={notice} />
            </div>
          )}
          {data.error !== undefined && (
            <div className="mb-4">
              <NoticeBanner
                notice={{
                  tone: 'error',
                  text: t('automations.loadFailed', { error: describe(data.error) }),
                }}
              />
            </div>
          )}

          {tab === 'templates' ? (
            <TemplateGrid />
          ) : empty ? (
            <>
              <EmptyIllustration />
              <WavyDivider />
              <h2 className="mb-3 text-sm font-medium text-soft-foreground">
                {t('automations.startFromTemplate')}
              </h2>
              <TemplateGrid />
            </>
          ) : automations === undefined ? null : groups.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              {t('automations.noMatches')}
            </p>
          ) : (
            <div className="space-y-7">
              {groups.map(({ group, automations: list }) => (
                <section key={group} data-group={group}>
                  <h2 className="mb-2 flex items-baseline gap-1.5 px-1 text-sm font-medium text-soft-foreground">
                    {t(GROUP_LABEL[group])}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {list.length}
                    </span>
                  </h2>
                  <ul className="divide-y divide-border rounded-xl border border-border bg-card">
                    {list.map((automation) => (
                      <AutomationRow
                        key={automation.id}
                        client={client}
                        automation={automation}
                        onError={onError}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function SearchBox({
  open,
  query,
  onOpen,
  onQuery,
}: {
  open: boolean;
  query: string;
  onOpen: (open: boolean) => void;
  onQuery: (query: string) => void;
}) {
  if (!open) {
    return (
      <IconButton label={t('automations.search')} onClick={() => onOpen(true)} data-action="search">
        <Search />
      </IconButton>
    );
  }
  return (
    <div className="relative w-56 min-w-0">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        autoFocus
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onQuery('');
            onOpen(false);
          }
        }}
        placeholder={t('automations.search')}
        aria-label={t('automations.search')}
        className="h-8 pr-8 pl-8"
      />
      <IconButton
        label={t('common.close')}
        size="icon-xs"
        className="absolute top-1/2 right-1 -translate-y-1/2"
        onClick={() => {
          onQuery('');
          onOpen(false);
        }}
      >
        <X />
      </IconButton>
    </div>
  );
}

export function StateIcon({ state, className }: { state: AutomationState; className?: string }) {
  const { icon: Icon, tone } = STATE_META[state];
  return (
    <Icon
      aria-hidden
      className={cn('size-4', tone, state === 'running' && 'animate-spin', className)}
    />
  );
}

function AutomationRow({
  client,
  automation,
  onError,
}: {
  client: WevirClient;
  automation: Automation;
  onError: (text: string) => void;
}) {
  const navigate = useNavigate();
  const state = stateOf(automation);
  const failed = automation.lastRun?.status === 'failed';
  const toggle = (enabled: boolean) => {
    client
      .request('automation.update', { automationId: automation.id, enabled })
      .catch((reason: unknown) =>
        onError(t('automations.saveFailed', { error: describe(reason) })),
      );
  };
  const open = () => navigate(paths.automation(automation.id));
  return (
    <li
      className="group/row flex min-h-16 cursor-default items-center gap-3 px-3.5 py-3 transition-colors duration-150 first:rounded-t-xl last:rounded-b-xl hover:bg-muted/40"
      data-automation={automation.id}
      data-state={state}
    >
      <button
        type="button"
        onClick={open}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:focus-ring"
      >
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-soft-foreground',
            !automation.enabled && 'opacity-60',
          )}
        >
          <StateIcon state={state} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'block truncate font-medium',
              !automation.enabled && 'text-muted-foreground',
            )}
          >
            {automation.title}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">
              {scheduleText(automation.schedule, automation.timezone)}
            </span>
            <span aria-hidden>·</span>
            <span className={cn('shrink-0', STATE_META[state].tone)}>
              {t(STATE_META[state].label)}
            </span>
            {failed && state !== 'running' && (
              <>
                <span aria-hidden>·</span>
                <span className="flex shrink-0 items-center gap-1 text-destructive">
                  <TriangleAlert aria-hidden className="size-3" />
                  {t('automations.lastFailed')}
                </span>
              </>
            )}
          </span>
        </span>
        {automation.nextRunAt !== undefined && (
          <span className="hidden shrink-0 text-xs text-soft-foreground tabular-nums sm:block">
            {formatMoment(Date.parse(automation.nextRunAt), automation.timezone)}
          </span>
        )}
      </button>
      <Switch
        checked={automation.enabled}
        label={t('automations.enabled')}
        onChange={toggle}
        data-action="toggle"
      />
      <AutomationMenu client={client} automation={automation} onError={onError} />
    </li>
  );
}

function TemplateGrid() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="automation-templates">
      {TEMPLATES.map((template) => {
        const text = templateText(template);
        const Icon = template.icon;
        return (
          <button
            key={template.id}
            type="button"
            onClick={() => openAutomationDialog({ kind: 'create', template })}
            className="flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-4 text-left outline-none transition-[background-color,border-color] duration-150 hover:border-border-strong hover:bg-muted/40 focus-visible:focus-field"
            data-template={template.id}
          >
            <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-soft-foreground">
              <Icon aria-hidden className="size-4.5" />
            </span>
            <span className="min-w-0">
              <span className="block font-medium">{text.title}</span>
              <span className="mt-1 line-clamp-2 block text-sm text-muted-foreground">
                {text.summary}
              </span>
            </span>
            <span className="mt-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock aria-hidden className="size-3.5" />
              {scheduleText(template.schedule, 'UTC')}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function EmptyIllustration(): ReactNode {
  return (
    <div
      className="flex flex-col items-center gap-4 pt-6 pb-2 text-center"
      data-testid="automations-empty"
    >
      <svg
        aria-hidden
        viewBox="0 0 96 96"
        className="size-24 text-muted-foreground"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="48" cy="54" r="30" strokeWidth="2.5" className="text-border-strong" />
        <circle
          cx="48"
          cy="54"
          r="30"
          strokeWidth="2.5"
          strokeDasharray="47 142"
          transform="rotate(-90 48 54)"
        />
        <path d="M42 16h12M48 16v8" strokeWidth="2.5" />
        <path d="M72 28l4-4" strokeWidth="2.5" />
        <path d="M48 54V38" strokeWidth="2.5" />
        <circle cx="48" cy="54" r="2.5" fill="currentColor" stroke="none" />
      </svg>
      <p className="text-base font-medium">{t('automations.empty')}</p>
    </div>
  );
}

function WavyDivider() {
  return (
    <svg aria-hidden className="my-8 h-3 w-full text-border-strong">
      <defs>
        <pattern id="automations-wave" width="24" height="12" patternUnits="userSpaceOnUse">
          <path d="M0 6 Q6 0 12 6 T24 6" fill="none" stroke="currentColor" strokeWidth="1.25" />
        </pattern>
      </defs>
      <rect width="100%" height="12" fill="url(#automations-wave)" />
    </svg>
  );
}
