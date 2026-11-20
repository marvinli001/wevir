// 自动调优的界面（0.108.0，desktop-layout.md §34/§35）：第一次进来的引导页、主卡（开关、试用状态、范围、每月上限与撤销）、
// 项目范围的指标与走势，和版本对话框里的时间线。用户能做的只有开关、上限与撤销。数据见 use-overview.ts，纯逻辑见 auto-model.ts。

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
  budgetText,
  canUndo,
  failedRate,
  heroStatus,
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
  unversionedTrial,
  usageText,
} from './auto-model';
import { kindName } from './proposals-model';
import { TuningHero } from './tuning-hero';
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

/** 主卡：“自动调优”开关、试用状态与试用中的改动，下面一排是范围（`scope`）、每月上限与撤销。 */
export function AutoHero({
  overview,
  proposals,
  latestSeq,
  update,
  onUndo,
  scope,
}: {
  overview: TuningOverview;
  proposals: readonly TuningProposal[];
  latestSeq: number | undefined;
  update: UpdateSettings;
  onUndo: (proposals: TuningProposal[]) => void;
  scope: ReactNode;
}) {
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const save = (patch: Partial<HostSettings>) => {
    setSaving(true);
    update(patch)
      .catch(() => undefined)
      .finally(() => setSaving(false));
  };
  const enabled = overview.auto.enabled;
  const limit = overview.budget.limitTokens ?? AUTO_TUNING_MONTHLY_TOKENS_DEFAULT;
  const trial = overview.trial;
  const inTrial = proposals.filter((p) => trial?.proposalIds.includes(p.id) === true);
  return (
    <TuningHero
      title={t('tuning.auto')}
      control={
        <Switch
          label={t('tuning.auto')}
          checked={enabled}
          disabled={saving}
          onChange={(autoTuning) => save({ autoTuning })}
          data-action="auto-tuning"
        />
      }
      status={heroStatus(overview, latestSeq)}
      tone={!enabled ? 'idle' : trial !== undefined ? 'trial' : 'stable'}
      detail={
        inTrial.length > 0 && (
          <>
            <button
              type="button"
              className="mt-1 block max-w-full truncate rounded-sm text-left text-xs text-muted-foreground outline-none focus-visible:focus-ring"
              aria-expanded={inTrial.length > 1 ? open : undefined}
              onClick={() => setOpen(!open)}
              disabled={inTrial.length === 1}
            >
              {inTrial.length === 1
                ? changeLine(inTrial[0] as TuningProposal)
                : t('tuning.trial.changes', { count: inTrial.length })}
            </button>
            {open && inTrial.length > 1 && (
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                {inTrial.map((proposal) => (
                  <li key={proposal.id} className="truncate">
                    {changeLine(proposal)}
                  </li>
                ))}
              </ul>
            )}
          </>
        )
      }
    >
      {scope}
      <span className="flex items-center gap-2 pl-1 text-sm">
        <span className="text-muted-foreground">{t('tuning.monthlyLimit')}</span>
        <Select
          aria-label={t('tuning.monthlyLimit')}
          value={String(limit)}
          onValueChange={(value) => save({ autoTuningMonthlyTokens: Number(value) })}
          disabled={saving}
          className="w-24"
          data-field="monthly-limit"
          options={limitOptions(limit)}
        />
      </span>
      {inTrial.length > 0 && (
        <Button variant="outline" onClick={() => onUndo(inTrial)} data-action="trial-undo">
          <Undo2 data-icon="inline-start" />
          {t('tuning.undo')}
        </Button>
      )}
    </TuningHero>
  );
}

/** 项目范围的效果：四个指标与各版本通过率的走势。 */
export function TrialMetrics({
  overview,
  proposals,
  versions,
}: {
  overview: TuningOverview;
  proposals: readonly TuningProposal[];
  versions: readonly ProfileVersionSummary[];
}) {
  const pass = metricDelta(overview.series, passRate, true);
  const failed = metricDelta(overview.series, failedRate, false);
  const totals = overview.totals ?? { adopted: 0, kept: 0, reverted: 0 };
  const points = seriesPoints(overview.series, versions, proposals);
  return (
    <section
      className="mb-7 overflow-hidden rounded-xl border border-border bg-card"
      data-testid="tuning-metrics"
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 sm:divide-x sm:divide-border">
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
    <div className="min-w-0 px-5 py-4">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-1.5 tabular-nums">
        <span className="text-xl font-semibold tracking-tight">{metric.value ?? '—'}</span>
        {metric.delta !== undefined && (
          <span className="text-xs text-muted-foreground">{metric.delta}</span>
        )}
      </div>
      {detail !== undefined && (
        <div className="mt-0.5 truncate text-xs text-muted-foreground tabular-nums">{detail}</div>
      )}
    </div>
  );
}

/** 各版本通过率的走势：不画坐标轴，版本号写在下面；试用中的点用品牌色，含回退改动的标红。 */
function Sparkline({ points }: { points: readonly SeriesPoint[] }) {
  const width = 300;
  const height = 36;
  const { path, coords } = sparklinePath(points, width, height);
  return (
    <div className="border-t border-border px-5 pt-4 pb-3" data-testid="tuning-sparkline">
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
        {/* 点画成零长度的圆头线段：非等比拉伸的 viewBox 里也是正圆。 */}
        {coords.map(({ point, x, y }) =>
          y === undefined ? null : (
            <line
              key={point.seq}
              x1={x}
              y1={y}
              x2={x}
              y2={y}
              strokeWidth="6"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              className={cn(
                point.reverted
                  ? 'stroke-destructive'
                  : point.trial
                    ? 'stroke-brand'
                    : 'stroke-muted-foreground',
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
