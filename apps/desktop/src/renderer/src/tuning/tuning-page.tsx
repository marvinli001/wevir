// 调优页（0.85.0，docs/architecture/desktop-layout.md §34；0.108.0 改为自动调优）：主窗格里的一列。第一次进来（设置里还没有
// `autoTuning`）整页是引导；之后顶上是主卡（版式照设备页：开关、试用状态、范围与每月上限，右边一叠配置层的插画），项目范围下面是
// 指标与走势，然后是八层的卡片网格（点开是条目与管理入口的对话框），最下面一行“版本”打开版本对话框（时间线或版本列表、两版对比）。
// 数据是 `tuning.*`（use-tuning.ts）与 `tuning.overview`（use-overview.ts）。

import { hostSupports, type WevirClient } from '@wevir/client-sdk';
import type {
  HostFeatures,
  MethodResult,
  ProfileVersionId,
  ProfileVersionSummary,
  SessionId,
  TuningProposal,
} from '@wevir/protocol';
import { ChevronRight, GitCompareArrows, History, XIcon } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ErrorNote } from '@/components/error-note';
import { PageSpinner } from '@/components/spinner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select } from '@/components/ui/select';
import { useHostSettings } from '@/data/host-settings';
import { useWorkbenchData } from '@/data/workbench-data';
import { projectsOf } from '@/data/workbench-model';
import { describe } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import { DetailSection, ExpandableRow } from '@/plugins/plugin-rows';
import { paths } from '@/routes/paths';
import { EmptyList, LIST_CARD, NoticeBanner, SettingsSection } from '@/settings/settings-ui';
import {
  AutoHero,
  TrialMetrics,
  TuningOnboarding,
  undoProposals,
  VersionTimeline,
} from './auto-section';
import { GuardrailsLayerDialog } from './guardrails-layer';
import { LayerDialog, LayerGrid } from './layer-grid';
import { ProfileDiffList } from './profile-diff';
import { TuningHero } from './tuning-hero';
import {
  changesSummary,
  knownLayers,
  pickScope,
  scopeWorkspaceId,
  shortHash,
  versionLabel,
} from './tuning-model';
import { useOverview } from './use-overview';
import { tuningScope, useTuning } from './use-tuning';

/** 对比的两边：一个版本与另一个版本或当前配置。 */
interface Comparison {
  from: ProfileVersionId;
  to: ProfileVersionId | 'current';
}

export function TuningPage({ client, features }: { client: WevirClient; features: HostFeatures }) {
  const [params, setParams] = useSearchParams();
  const workbench = useWorkbenchData();
  const projects = useMemo(
    () =>
      workbench.status === 'ready'
        ? projectsOf(workbench.workspaces).map((entry) => ({
            id: entry.workspace.id,
            label: entry.workspace.displayName,
          }))
        : [],
    [workbench],
  );
  const remembered = tuningScope.use();
  const requested = params.get('workspace');
  const scope = pickScope(
    requested,
    remembered,
    projects.map((project) => project.id),
  );
  // 从会话侧栏跳来的范围记下来，之后回到本页还是它。
  useEffect(() => {
    if (requested !== null && requested === scope) tuningScope.set(scope);
  }, [requested, scope]);
  const workspaceId = scopeWorkspaceId(scope);
  const data = useTuning(client, workspaceId);
  const auto = hostSupports(features, 'tuning_auto');
  const overview = useOverview(client, workspaceId, auto);
  const { update } = useHostSettings();
  const [openLayer, setOpenLayer] = useState<string>();
  const requestedVersion = params.get('version') ?? undefined;
  const [expandedVersion, setExpandedVersion] = useState(requestedVersion);
  // 地址里的版本（会话侧栏的“档案 vN”）：打开版本对话框并展开它，页面开着时再跳来也一样。
  const [historyOpen, setHistoryOpen] = useState(requestedVersion !== undefined);
  useEffect(() => {
    if (requestedVersion === undefined) return;
    setExpandedVersion(requestedVersion);
    setHistoryOpen(true);
  }, [requestedVersion]);
  const [undoError, setUndoError] = useState<string>();

  const changeScope = (next: string) => {
    tuningScope.set(next);
    setOpenLayer(undefined);
    setExpandedVersion(undefined);
    setUndoError(undefined);
    // 地址里的范围与版本只管第一次进来。
    if (params.has('workspace') || params.has('version')) setParams({}, { replace: true });
  };

  const current = data.data?.current;
  const versions = data.data?.versions ?? [];
  const summary = overview.data?.overview;
  const proposals = overview.data?.proposals ?? [];
  // 第一次进来（设置里还没有 `autoTuning`）：整页是引导。
  if (auto && summary !== undefined && !summary.auto.decided) {
    return (
      <div className="relative flex h-full min-h-0 flex-col" data-testid="tuning-page">
        <ScrollArea className="min-h-0 flex-1">
          <TuningOnboarding update={update} />
        </ScrollArea>
      </div>
    );
  }
  // 项目范围有指标与改动时间线；全局范围（与没有自动调优的 Host）的版本对话框是普通版本列表。
  const timelineShown = auto && workspaceId !== undefined;
  const undo = (list: TuningProposal[]) => {
    setUndoError(undefined);
    void undoProposals(client, list).then((error) => {
      if (error !== undefined) setUndoError(error);
    });
  };
  const loadError = data.error ?? overview.error;
  const layers = current === undefined ? [] : knownLayers(current.profile.layers);
  const layer = layers.find((entry) => entry.key === openLayer);
  const scopeSelect = (
    <Select
      aria-label={t('tuning.scope')}
      value={scope}
      onValueChange={changeScope}
      className="w-44"
      data-field="scope"
      options={[
        { value: 'global', label: t('tuning.global') },
        ...projects.map((project) => ({ value: project.id, label: project.label })),
      ]}
    />
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col" data-testid="tuning-page">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-180 px-5 pt-6 pb-16 sm:px-10">
          {loadError !== undefined && (
            <NoticeBanner
              className="mb-4"
              notice={{
                tone: 'error',
                text: t('tuning.loadFailed', { error: describe(loadError) }),
              }}
            />
          )}
          {undoError !== undefined && (
            <NoticeBanner className="mb-4" notice={{ tone: 'error', text: undoError }} />
          )}
          {current === undefined || (auto && summary === undefined) ? (
            loadError === undefined && <PageSpinner />
          ) : (
            <>
              {auto && summary !== undefined ? (
                <AutoHero
                  overview={summary}
                  proposals={proposals}
                  latestSeq={current.latest?.seq}
                  update={update}
                  onUndo={undo}
                  scope={scopeSelect}
                />
              ) : (
                <TuningHero
                  title={t('tuning.title')}
                  status={
                    current.latest === undefined
                      ? t('tuning.noVersions')
                      : versionLabel(current.latest.seq)
                  }
                  tone="idle"
                >
                  {scopeSelect}
                </TuningHero>
              )}
              {timelineShown && summary !== undefined && (
                <TrialMetrics overview={summary} proposals={proposals} versions={versions} />
              )}
              <SettingsSection title={t('tuning.details')} data-testid="tuning-details">
                <LayerGrid layers={layers} onOpen={setOpenLayer} />
              </SettingsSection>
              <HistoryRow
                latest={current.latest}
                fingerprint={current.profile.fingerprint}
                onOpen={() => setHistoryOpen(true)}
              />
            </>
          )}
        </div>
      </ScrollArea>
      {layer !== undefined &&
        (layer.key === 'guardrails' &&
        (hostSupports(features, 'tuning_guardrails') ||
          hostSupports(features, 'lifecycle_hooks')) ? (
          <GuardrailsLayerDialog
            client={client}
            lifecycleHooks={hostSupports(features, 'lifecycle_hooks')}
            layer={layer}
            workspaceId={workspaceId}
            onClose={() => setOpenLayer(undefined)}
          />
        ) : (
          <LayerDialog layer={layer} onClose={() => setOpenLayer(undefined)} />
        ))}
      {historyOpen && current !== undefined && (
        <HistoryDialog
          client={client}
          data={data}
          proposals={timelineShown ? proposals : undefined}
          expanded={expandedVersion}
          onToggle={(id) => setExpandedVersion(expandedVersion === id ? undefined : id)}
          onUndo={undo}
          onClose={() => {
            setHistoryOpen(false);
            if (params.has('version')) setParams({}, { replace: true });
          }}
        />
      )}
    </div>
  );
}

/** 页面最下面的一行：当前版本，点开是版本对话框。 */
function HistoryRow({
  latest,
  fingerprint,
  onOpen,
}: {
  latest: MethodResult<'tuning.get'>['latest'];
  fingerprint: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={onOpen}
      data-action="open-history"
      className="mt-9 flex min-h-12 w-full items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5 text-left outline-none transition-colors duration-150 hover:bg-muted/40 focus-visible:focus-field"
    >
      <History aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-sm font-medium">{t('tuning.versions')}</span>
      <span
        className="truncate text-xs text-muted-foreground tabular-nums"
        title={latest?.fingerprint ?? fingerprint}
        data-testid="tuning-current"
      >
        {latest === undefined
          ? t('tuning.noVersions')
          : `${versionLabel(latest.seq)} · ${formatTime(latest.createdAt)}`}
      </span>
      <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** 版本对话框：项目范围是改动时间线，全局范围是版本列表；右上角“对比”。 */
function HistoryDialog({
  client,
  data,
  proposals,
  expanded,
  onToggle,
  onUndo,
  onClose,
}: {
  client: WevirClient;
  data: ReturnType<typeof useTuning>;
  /** 有它时显示时间线。 */
  proposals: readonly TuningProposal[] | undefined;
  expanded: string | undefined;
  onToggle: (id: string) => void;
  onUndo: (proposals: TuningProposal[]) => void;
  onClose: () => void;
}) {
  const versions = data.data?.versions ?? [];
  const [comparison, setComparison] = useState<Comparison>();
  // 打开时把展开的版本滚到眼前（会话侧栏跳来的）。
  const body = useRef<HTMLDivElement>(null);
  const listed = versions.some((version) => version.id === expanded);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (revealed || !listed || expanded === undefined) return;
    const frame = requestAnimationFrame(() => {
      body.current
        ?.querySelector(`[data-plugin-row="${CSS.escape(expanded)}"]`)
        ?.scrollIntoView({ block: 'start' });
      setRevealed(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [revealed, listed, expanded]);
  const detail = (version: ProfileVersionSummary) => (
    <VersionDetail
      client={client}
      version={version}
      previous={versions[versions.findIndex((v) => v.id === version.id) + 1]}
    />
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-2xl"
        data-testid="tuning-history"
      >
        <div className="flex items-center gap-2 border-b border-border py-3 pr-3 pl-4">
          <DialogTitle className="flex-1">{t('tuning.versions')}</DialogTitle>
          {versions.length > 0 && (
            <Button
              variant={comparison === undefined ? 'ghost' : 'secondary'}
              size="sm"
              data-action="compare"
              aria-pressed={comparison !== undefined}
              onClick={() =>
                setComparison(
                  comparison !== undefined
                    ? undefined
                    : { from: (versions[0] as ProfileVersionSummary).id, to: 'current' },
                )
              }
            >
              <GitCompareArrows data-icon="inline-start" />
              {t('tuning.compare')}
            </Button>
          )}
          <DialogClose render={<Button variant="ghost" size="icon-sm" />}>
            <XIcon />
            <span className="sr-only">{t('common.close')}</span>
          </DialogClose>
        </div>
        <div ref={body} className="min-h-0 overflow-y-auto p-4">
          {comparison !== undefined && (
            <ComparePanel
              client={client}
              versions={versions}
              value={comparison}
              onChange={setComparison}
            />
          )}
          {proposals !== undefined ? (
            versions.length === 0 && proposals.length === 0 ? (
              <EmptyList>{t('tuning.noVersions')}</EmptyList>
            ) : (
              <VersionTimeline
                versions={versions}
                proposals={proposals}
                expanded={expanded}
                onToggle={onToggle}
                detail={detail}
                onUndo={onUndo}
              />
            )
          ) : versions.length === 0 ? (
            <EmptyList>{t('tuning.noVersions')}</EmptyList>
          ) : (
            <ul className={LIST_CARD} data-testid="tuning-versions">
              {versions.map((version) => (
                <VersionRow
                  key={version.id}
                  version={version}
                  expanded={expanded === version.id}
                  onToggle={() => onToggle(version.id)}
                >
                  {detail(version)}
                </VersionRow>
              ))}
            </ul>
          )}
          <MoreVersions data={data} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MoreVersions({ data }: { data: ReturnType<typeof useTuning> }) {
  if (data.data?.nextCursor === undefined) return null;
  return (
    <div className="mt-2 flex justify-center">
      <Button variant="ghost" size="sm" onClick={data.more}>
        {t('sidebar.showMore')}
      </Button>
    </div>
  );
}

function formatTime(at: string): string {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return '';
  return new Intl.DateTimeFormat(currentLocale(), {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(time));
}

/** 一个版本（全局范围的列表）：序号、时间与变化摘要、会话数；展开是与前一版的变化与用它建的会话。 */
function VersionRow({
  version,
  expanded,
  onToggle,
  children,
}: {
  version: ProfileVersionSummary;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const changes = changesSummary(version.changes);
  return (
    <ExpandableRow
      id={version.id}
      expanded={expanded}
      onToggle={onToggle}
      title={
        <span className="flex items-center gap-2">
          {versionLabel(version.seq)}
          <span className="font-mono text-xs font-normal text-muted-foreground">
            {shortHash(version.fingerprint)}
          </span>
        </span>
      }
      meta={[formatTime(version.createdAt), changes].filter((part) => part !== '').join(' · ')}
      summary={t('tuning.sessionCount', { count: version.sessions })}
    >
      {expanded && children}
    </ExpandableRow>
  );
}

function VersionDetail({
  client,
  version,
  previous,
}: {
  client: WevirClient;
  version: ProfileVersionSummary;
  previous: ProfileVersionSummary | undefined;
}) {
  const workbench = useWorkbenchData();
  const [diff, setDiff] = useState<MethodResult<'tuning.diff'> | { error: string }>();
  const [sessionIds, setSessionIds] = useState<string[]>();
  useEffect(() => {
    let alive = true;
    client.request('tuning.version', { versionId: version.id }).then(
      (result) => alive && setSessionIds(result.sessionIds),
      () => alive && setSessionIds([]),
    );
    if (previous !== undefined) {
      client.request('tuning.diff', { from: previous.id, to: version.id }).then(
        (result) => alive && setDiff(result),
        (reason: unknown) => alive && setDiff({ error: describe(reason) }),
      );
    }
    return () => {
      alive = false;
    };
  }, [client, version.id, previous]);
  const sessions = useMemo(() => {
    if (sessionIds === undefined || workbench.status !== 'ready') return [];
    const byId = new Map(
      workbench.workspaces.flatMap((entry) =>
        entry.sessions.map((session) => [session.id, session]),
      ),
    );
    return sessionIds.flatMap((id) => {
      const session = byId.get(id as SessionId);
      return session === undefined ? [] : [session];
    });
  }, [sessionIds, workbench]);
  return (
    <>
      {previous !== undefined && (
        <DetailSection title={`${versionLabel(previous.seq)} → ${versionLabel(version.seq)}`}>
          {diff === undefined ? (
            <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
          ) : 'error' in diff ? (
            <ErrorNote className="text-xs">{diff.error}</ErrorNote>
          ) : (
            <ProfileDiffList client={client} layers={diff.layers} />
          )}
        </DetailSection>
      )}
      <DetailSection title={t('tuning.sessions')}>
        {sessionIds === undefined ? (
          <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
        ) : sessions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('tuning.sessionCount', { count: sessionIds.length })}
          </p>
        ) : (
          <ul className="space-y-px" data-testid="tuning-sessions">
            {sessions.map((session) => (
              <li key={session.id}>
                <Link
                  to={paths.session(session.workspaceId, session.id)}
                  className="flex h-7 min-w-0 items-center gap-2 rounded-md px-1.5 text-xs outline-none transition-colors duration-150 hover:bg-muted/50 focus-visible:focus-ring"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {session.title || t('session.untitled')}
                  </span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {formatTime(session.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
    </>
  );
}

/** 两版对比：左边选一个版本，右边选另一个版本或“当前”。 */
function ComparePanel({
  client,
  versions,
  value,
  onChange,
}: {
  client: WevirClient;
  versions: readonly ProfileVersionSummary[];
  value: Comparison;
  onChange: (value: Comparison) => void;
}) {
  const [result, setResult] = useState<MethodResult<'tuning.diff'> | { error: string }>();
  // 打开时滚到眼前。
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.scrollIntoView({ block: 'start' });
  }, []);
  useEffect(() => {
    let alive = true;
    setResult(undefined);
    client.request('tuning.diff', value).then(
      (diff) => alive && setResult(diff),
      (reason: unknown) => alive && setResult({ error: describe(reason) }),
    );
    return () => {
      alive = false;
    };
  }, [client, value]);
  const options = versions.map((version) => ({
    value: version.id,
    label: versionLabel(version.seq),
  }));
  return (
    <div
      ref={panel}
      className="mb-4 scroll-mt-4 rounded-xl border border-border bg-muted/30 px-4 py-3"
      data-testid="tuning-compare"
    >
      <div className="mb-3 flex items-center gap-2 text-xs">
        <Select<ProfileVersionId>
          aria-label={t('tuning.compare')}
          value={value.from}
          onValueChange={(from) => onChange({ ...value, from })}
          className="w-28"
          options={options}
        />
        <span aria-hidden className="text-muted-foreground">
          →
        </span>
        <Select<ProfileVersionId | 'current'>
          aria-label={t('tuning.compare')}
          value={value.to}
          onValueChange={(to) => onChange({ ...value, to })}
          className="w-28"
          options={[{ value: 'current', label: t('tuning.current') }, ...options]}
        />
      </div>
      {result === undefined ? (
        <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
      ) : 'error' in result ? (
        <ErrorNote className="text-xs">{result.error}</ErrorNote>
      ) : (
        <ProfileDiffList client={client} layers={result.layers} />
      )}
    </div>
  );
}
