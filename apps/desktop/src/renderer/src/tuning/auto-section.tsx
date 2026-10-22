// 自动调优的界面（0.108.0，desktop-layout.md §34/§35）：第一次进来的引导页、页头的开关与每月上限、试用卡（进度环、状态、指标块与
// 走势）和版本时间线。用户能做的只有开关、上限与撤销。数据见 use-overview.ts，纯逻辑见 auto-model.ts。

import { isRpcError, type WevirClient } from '@wevir/client-sdk';
import {
  AUTO_TUNING_MONTHLY_TOKENS_DEFAULT,
  type HostSettings,
  type ProfileVersionSummary,
  type SessionId,
  TUNING_TRIAL_SESSIONS,
  type TuningOverview,
  type TuningProposal,
} from '@wevir/protocol';
import { cn } from 'cn';
import { Ellipsis, SlidersHorizontal, Undo2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';
import { IconButton } from '@/components/icon-button';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select } from '@/components/ui/select';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { ExpandableRow } from '@/plugins/plugin-rows';
import { paths } from '@/routes/paths';
import { LIST_CARD, NoticeBanner } from '@/settings/settings-ui';
import {
  autoStatus,
  budgetText,
  canUndo,
  failedRate,
  limitOptions,
  type MetricDelta,
  metricDelta,
  originName,
  outcomeText,
  passRate,
  type SeriesPoint,
  seriesPoints,
  sparklinePath,
  statusName,
  timeline,
  trialTitle,
  unversionedTrial,
  usageText,
} from './auto-model';
import { kindName } from './proposals-model';
import { versionLabel } from './tuning-model';

type UpdateSettings = (patch: Partial<HostSettings>) => Promise<void>;

/** 引导页：`autoTuning` 还没选过时整页显示。两个按钮都写设置。 */
export function TuningOnboarding({ update }: { update: UpdateSettings }) {
  const [limit, setLimit] = useState(AUTO_TUNING_MONTHLY_TOKENS_DEFAULT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const choose = async (autoTuning: boolean) => {
    setSaving(true);
    setError(undefined);
    try {
      await update({ autoTuning, autoTuningMonthlyTokens: limit });
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div
      className="mx-auto flex w-full max-w-120 flex-col px-5 pt-20 pb-16"
      data-testid="tuning-onboarding"
    >
      <SlidersHorizontal aria-hidden className="mb-4 size-6 text-muted-foreground" />
      <h1 className="mb-4 text-lg font-medium">{t('tuning.title')}</h1>
      <ul className="mb-6 space-y-2 text-sm text-muted-foreground">
        <li>{t('tuning.onboarding.summary')}</li>
        <li>{t('tuning.onboarding.trial', { count: TUNING_TRIAL_SESSIONS })}</li>
        <li>{t('tuning.onboarding.cost')}</li>
      </ul>
      <div className="mb-6 flex items-center justify-between gap-3 text-sm">
        <span>{t('tuning.monthlyLimit')}</span>
        <Select
          aria-label={t('tuning.monthlyLimit')}
          value={String(limit)}
          onValueChange={(value) => setLimit(Number(value))}
          className="w-28"
          data-field="monthly-limit"
          options={limitOptions(AUTO_TUNING_MONTHLY_TOKENS_DEFAULT)}
        />
      </div>
      {error !== undefined && (
        <div className="mb-4">
          <NoticeBanner notice={{ tone: 'error', text: t('tuning.saveFailed', { error }) }} />
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          disabled={saving}
          onClick={() => void choose(false)}
          data-action="onboarding-skip"
        >
          {t('tuning.onboarding.skip')}
        </Button>
        <Button disabled={saving} onClick={() => void choose(true)} data-action="onboarding-enable">
          {t('tuning.onboarding.enable')}
        </Button>
      </div>
    </div>
  );
}

/** 页头右边：“自动调优”开关与“每月上限”。 */
export function AutoControls({
  settings,
  update,
}: {
  settings: Pick<HostSettings, 'autoTuning' | 'autoTuningMonthlyTokens'>;
  update: UpdateSettings;
}) {
  const [saving, setSaving] = useState(false);
  const save = (patch: Partial<HostSettings>) => {
    setSaving(true);
    update(patch)
      .catch(() => undefined)
      .finally(() => setSaving(false));
  };
  const limit = settings.autoTuningMonthlyTokens ?? AUTO_TUNING_MONTHLY_TOKENS_DEFAULT;
  return (
    <div className="flex items-center gap-4 text-sm" data-testid="tuning-auto-controls">
      <span className="flex items-center gap-2">
        <span className="text-muted-foreground">{t('tuning.auto')}</span>
        <Switch
          label={t('tuning.auto')}
          checked={settings.autoTuning === true}
          disabled={saving}
          onChange={(autoTuning) => save({ autoTuning })}
          data-action="auto-tuning"
        />
      </span>
      <span className="flex items-center gap-2">
        <span className="hidden text-muted-foreground sm:inline">{t('tuning.monthlyLimit')}</span>
        <Select
          aria-label={t('tuning.monthlyLimit')}
          value={String(limit)}
          onValueChange={(value) => save({ autoTuningMonthlyTokens: Number(value) })}
          className="w-24"
          data-field="monthly-limit"
          options={limitOptions(limit)}
        />
      </span>
    </div>
  );
}

/** 试用卡：进度环与状态、试用中的改动、四个指标块与走势。 */
export function TrialCard({
  overview,
  proposals,
  versions,
  latestSeq,
  onUndo,
}: {
  overview: TuningOverview;
  proposals: readonly TuningProposal[];
  versions: readonly ProfileVersionSummary[];
  latestSeq: number | undefined;
  onUndo: (proposals: TuningProposal[]) => void;
}) {
  const trial = overview.trial;
  const inTrial = proposals.filter((p) => trial?.proposalIds.includes(p.id) === true);
  const status = autoStatus(overview);
  const [open, setOpen] = useState(false);
  const pass = metricDelta(overview.series, passRate, true);
  const failed = metricDelta(overview.series, failedRate, false);
  const totals = overview.totals ?? { adopted: 0, kept: 0, reverted: 0 };
  const points = seriesPoints(overview.series, versions, proposals);
  return (
    <section
      className="mb-6 rounded-xl border border-border bg-card px-4 py-4"
      data-testid="tuning-trial"
    >
      <div className="flex min-w-0 items-center gap-3">
        <ProgressRing
          value={trial?.sessions ?? 0}
          total={trial?.needed ?? TUNING_TRIAL_SESSIONS}
          active={trial !== undefined}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <span className="truncate" data-testid="tuning-trial-title">
              {trialTitle(overview, latestSeq)}
            </span>
            {status !== undefined && (
              <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">
                {status}
              </span>
            )}
          </div>
          {inTrial.length > 0 && (
            <button
              type="button"
              className="mt-0.5 block max-w-full truncate rounded-sm text-left text-xs text-muted-foreground outline-none focus-visible:focus-ring"
              aria-expanded={inTrial.length > 1 ? open : undefined}
              onClick={() => setOpen(!open)}
              disabled={inTrial.length === 1}
            >
              {inTrial.length === 1
                ? changeLine(inTrial[0] as TuningProposal)
                : t('tuning.trial.changes', { count: inTrial.length })}
            </button>
          )}
        </div>
        {inTrial.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onUndo(inTrial)}
            data-action="trial-undo"
          >
            <Undo2 aria-hidden />
            {t('tuning.undo')}
          </Button>
        )}
      </div>
      {open && inTrial.length > 1 && (
        <ul className="mt-2 space-y-1 pl-13 text-xs text-muted-foreground">
          {inTrial.map((proposal) => (
            <li key={proposal.id} className="truncate">
              {changeLine(proposal)}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="tuning-metrics">
        <MetricBlock label={t('tuning.metric.passRate')} metric={pass} />
        <MetricBlock label={t('tuning.metric.failedTurns')} metric={failed} />
        <MetricBlock
          label={t('tuning.metric.improved')}
          metric={{ value: String(totals.adopted) }}
          detail={`${t('tuning.metric.kept', { count: totals.kept })} · ${t('tuning.metric.reverted', { count: totals.reverted })}`}
        />
        <MetricBlock
          label={t('tuning.metric.budget')}
          metric={{ value: budgetText(overview.budget) }}
        />
      </div>
      {points.some((point) => point.rate !== undefined) && <Sparkline points={points} />}
    </section>
  );
}

function changeLine(proposal: TuningProposal): string {
  return `${kindName(proposal.kind)} ${proposal.title} · ${proposal.target}`;
}

function MetricBlock({
  label,
  metric,
  detail,
}: {
  label: string;
  metric: MetricDelta;
  detail?: ReactNode;
}) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 flex items-baseline gap-1.5 tabular-nums">
        <span className="text-base font-medium">{metric.value ?? '—'}</span>
        {metric.delta !== undefined && (
          <span
            className={cn(
              'text-xs',
              metric.trend === 'better' && 'text-success',
              metric.trend === 'worse' && 'text-destructive',
              metric.trend === 'same' && 'text-muted-foreground',
            )}
          >
            {metric.delta}
          </span>
        )}
      </div>
      {detail !== undefined && (
        <div className="truncate text-xs text-muted-foreground tabular-nums">{detail}</div>
      )}
    </div>
  );
}

/** 进度环：试用会话数 / 需要数。 */
function ProgressRing({ value, total, active }: { value: number; total: number; active: boolean }) {
  const radius = 15;
  const length = 2 * Math.PI * radius;
  const ratio = active ? Math.min(1, value / Math.max(1, total)) : 1;
  return (
    <span
      className="relative grid size-10 shrink-0 place-items-center"
      role="img"
      aria-label={
        active
          ? t('tuning.trial.progress', { sessions: value, needed: total })
          : t('tuning.trial.stable')
      }
    >
      <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx="18" cy="18" r={radius} className="fill-none stroke-muted" strokeWidth="3" />
        <circle
          cx="18"
          cy="18"
          r={radius}
          className={cn('fill-none', active ? 'stroke-primary' : 'stroke-success')}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={length}
          strokeDashoffset={length * (1 - ratio)}
        />
      </svg>
      {active && (
        <span aria-hidden className="text-[10px] font-medium tabular-nums">
          {value}/{total}
        </span>
      )}
    </span>
  );
}

/** 各版本通过率的走势：不画坐标轴，版本号写在下面；试用中的点用强调色，含回退改动的标红。 */
function Sparkline({ points }: { points: readonly SeriesPoint[] }) {
  const width = 300;
  const height = 36;
  const { path, coords } = sparklinePath(points, width, height);
  return (
    <div className="mt-4" data-testid="tuning-sparkline">
      <svg
        viewBox={`-4 -4 ${width + 8} ${height + 8}`}
        className="h-11 w-full overflow-visible"
        preserveAspectRatio="none"
        aria-hidden
      >
        {path !== '' && (
          <path
            d={path}
            className="fill-none stroke-muted-foreground/50"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {coords.map(({ point, x, y }) =>
          y === undefined ? null : (
            <circle
              key={point.seq}
              cx={x}
              cy={y}
              r="3"
              vectorEffect="non-scaling-stroke"
              className={cn(
                point.reverted
                  ? 'fill-destructive'
                  : point.trial
                    ? 'fill-primary'
                    : 'fill-muted-foreground',
              )}
            />
          ),
        )}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground tabular-nums">
        {points.map((point) => (
          <span key={point.seq}>{versionLabel(point.seq)}</span>
        ))}
      </div>
    </div>
  );
}

/** 版本时间线：有改动的版本列出改动（来源、结论、状态），没有的写层变化摘要。展开是 `detail`。 */
export function VersionTimeline({
  versions,
  proposals,
  expanded,
  onToggle,
  detail,
  onUndo,
}: {
  versions: readonly ProfileVersionSummary[];
  proposals: readonly TuningProposal[];
  expanded: string | undefined;
  onToggle: (id: string) => void;
  detail: (version: ProfileVersionSummary) => ReactNode;
  onUndo: (proposals: TuningProposal[]) => void;
}) {
  const entries = timeline(versions, proposals);
  const pending = unversionedTrial(proposals);
  return (
    <ul className={LIST_CARD} data-testid="tuning-timeline">
      {pending.length > 0 && (
        <li className="flex min-h-14 items-center gap-3 px-4 py-3" data-plugin-row="pending">
          <Dot filled />
          <ChangeSummary title={t('tuning.trial.running')} proposals={pending} />
          <ChangeMenu proposals={pending} onUndo={onUndo} />
        </li>
      )}
      {entries.map((entry) => {
        const label = versionLabel(entry.version.seq);
        const status = entry.proposals.map((p) => statusName(p.status)).find(Boolean);
        return (
          <ExpandableRow
            key={entry.version.id}
            id={entry.version.id}
            expanded={expanded === entry.version.id}
            onToggle={() => onToggle(entry.version.id)}
            leading={<Dot filled={entry.proposals.length > 0} />}
            title={
              entry.proposals.length === 0 ? (
                <span>
                  {label}
                  {entry.summary !== '' && (
                    <span className="font-normal text-muted-foreground"> · {entry.summary}</span>
                  )}
                </span>
              ) : (
                `${label} · ${proposalsTitle(entry.proposals)}`
              )
            }
            {...(entry.proposals.length > 0 && { meta: proposalsMeta(entry.proposals) })}
            summary={
              <span className="flex items-center gap-3">
                {status !== undefined && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-foreground">
                    {status}
                  </span>
                )}
                {t('tuning.sessionCount', { count: entry.version.sessions })}
              </span>
            }
            {...(entry.proposals.length > 0 && {
              control: <ChangeMenu proposals={entry.proposals} onUndo={onUndo} />,
            })}
          >
            {expanded === entry.version.id && detail(entry.version)}
          </ExpandableRow>
        );
      })}
    </ul>
  );
}

function Dot({ filled }: { filled: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-2 shrink-0 rounded-full',
        filled ? 'bg-foreground' : 'border border-muted-foreground',
      )}
    />
  );
}

function proposalsTitle(proposals: readonly TuningProposal[]): string {
  if (proposals.length === 1) {
    const [only] = proposals as [TuningProposal];
    return `${kindName(only.kind)} ${only.title}`;
  }
  return t('tuning.trial.changes', { count: proposals.length });
}

/** 改动下面的一行：来源 · 来自「会话」· 用量 · 结论。 */
function proposalsMeta(proposals: readonly TuningProposal[]): string {
  const [first] = proposals as [TuningProposal];
  const outcome = proposals.map(outcomeText).find((text) => text !== undefined);
  return [
    originName(first.origin),
    first.sessionTitle === undefined
      ? undefined
      : t('tuning.proposal.from', { title: first.sessionTitle }),
    usageText(first),
    outcome,
  ]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');
}

function ChangeSummary({ title, proposals }: { title: string; proposals: TuningProposal[] }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm font-medium">
        {title} · {proposalsTitle(proposals)}
      </span>
      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
        {proposalsMeta(proposals)}
      </span>
    </span>
  );
}

/** ⋯ 菜单：撤销（试用中与已保留的）与打开提出它的会话。 */
function ChangeMenu({
  proposals,
  onUndo,
}: {
  proposals: TuningProposal[];
  onUndo: (proposals: TuningProposal[]) => void;
}) {
  const navigate = useNavigate();
  const undoable = proposals.filter(canUndo);
  const first = proposals[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <IconButton label={t('tuning.change.actions')} size="icon-xs" data-action="change-menu">
            <Ellipsis />
          </IconButton>
        }
      />
      <DropdownMenuContent align="end" className="w-36">
        {undoable.length > 0 && (
          <DropdownMenuItem onClick={() => onUndo(undoable)} data-action="undo">
            <Undo2 />
            {t('tuning.undo')}
          </DropdownMenuItem>
        )}
        {first !== undefined && (
          <DropdownMenuItem
            onClick={() =>
              void navigate(paths.session(first.workspaceId, first.sessionId as SessionId))
            }
            data-action="open-session"
          >
            {t('tuning.change.openSession')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 撤销一组改动：逐条 `tuning.proposal.revert`，失败的原因交给页面显示。 */
export async function undoProposals(
  client: WevirClient,
  proposals: readonly TuningProposal[],
): Promise<string | undefined> {
  for (const proposal of proposals) {
    try {
      await client.request('tuning.proposal.revert', { proposalId: proposal.id });
    } catch (reason) {
      return isRpcError(reason, 'PROPOSAL_STALE')
        ? t('tuning.undo.stale')
        : t('tuning.undo.failed', { error: describe(reason) });
    }
  }
  return undefined;
}
