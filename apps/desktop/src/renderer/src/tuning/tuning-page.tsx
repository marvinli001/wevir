// 调优页（0.85.0，docs/architecture/desktop-layout.md §34，版式照插件页；0.108.0 改为自动调优）：主窗格里的一列。第一次进来
// （设置里还没有 `autoTuning`）整页是引导；之后顶上是范围选择、“自动调优”开关与每月上限，项目范围下面是试用卡（进度、指标与走势）、
// 版本时间线（展开看与前一版的变化和用它的会话），最后是默认折叠的“配置明细”：八层（展开看条目与打开、管理入口）与两版对比。全局
// 范围只有配置明细与版本列表。数据是 `tuning.*`（use-tuning.ts）与 `tuning.overview`（use-overview.ts）。

import { hostSupports, type WevirClient } from '@wevir/client-sdk';
import type {
  HostFeatures,
  MethodResult,
  ProfileLayer,
  ProfileVersionId,
  ProfileVersionSummary,
  SessionId,
  TuningProposal,
} from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { Collapse } from '@/components/collapse';
import { PageSpinner } from '@/components/spinner';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select } from '@/components/ui/select';
import { useHostSettings } from '@/data/host-settings';
import { useWorkbenchData } from '@/data/workbench-data';
import { projectsOf } from '@/data/workbench-model';
import { describe } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import { capabilities, platformApi } from '@/platform/platform';
import { DetailSection, ExpandableRow } from '@/plugins/plugin-rows';
import { paths } from '@/routes/paths';
import { EmptyList, LIST_CARD, NoticeBanner } from '@/settings/settings-ui';
import { canOpenExternally } from '../../../shared/open-path.js';
import {
  AutoControls,
  TrialCard,
  TuningOnboarding,
  undoProposals,
  VersionTimeline,
} from './auto-section';
import { GuardrailsLayerRow } from './guardrails-layer';
import { ProfileDiffList } from './profile-diff';
import {
  changesSummary,
  itemDetail,
  itemLabel,
  knownLayers,
  layerManage,
  layerName,
  layerScopes,
  layerSummary,
  pickScope,
  scopeName,
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
  const overview = useOverview(client, auto ? workspaceId : undefined);
  const { update } = useHostSettings();
  const [expandedLayer, setExpandedLayer] = useState<string>();
  const requestedVersion = params.get('version') ?? undefined;
  const [expandedVersion, setExpandedVersion] = useState(requestedVersion);
  // 地址里的版本（会话侧栏的“档案 vN”）：页面开着时再跳来也展开它，列表到了把它滚到眼前。
  const [revealVersion, setRevealVersion] = useState(requestedVersion);
  useEffect(() => {
    if (requestedVersion === undefined) return;
    setExpandedVersion(requestedVersion);
    setRevealVersion(requestedVersion);
  }, [requestedVersion]);
  const revealListed = data.data?.versions.some((version) => version.id === revealVersion) === true;
  useEffect(() => {
    if (!revealListed || revealVersion === undefined) return;
    document
      .querySelector(`[data-plugin-row="${CSS.escape(revealVersion)}"]`)
      ?.scrollIntoView({ block: 'start' });
    setRevealVersion(undefined);
  }, [revealListed, revealVersion]);
  const [comparison, setComparison] = useState<Comparison>();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [undoError, setUndoError] = useState<string>();

  const changeScope = (next: string) => {
    tuningScope.set(next);
    setExpandedLayer(undefined);
    setExpandedVersion(undefined);
    setComparison(undefined);
    setUndoError(undefined);
    // 地址里的范围与版本只管第一次进来。
    if (params.has('workspace') || params.has('version')) setParams({}, { replace: true });
  };

  const current = data.data?.current;
  const versions = data.data?.versions ?? [];
  const summary = overview.data?.overview;
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
  // 项目范围有试用卡与时间线；全局范围（与没有自动调优的 Host）只有配置明细，默认展开，版本列表也在里面。
  const timelineShown = auto && workspaceId !== undefined;
  const undo = (proposals: TuningProposal[]) => {
    setUndoError(undefined);
    void undoProposals(client, proposals).then((error) => {
      if (error !== undefined) setUndoError(error);
    });
  };
  const loadError = data.error ?? overview.error;
  const versionDetail = (version: ProfileVersionSummary) => (
    <VersionDetail
      client={client}
      version={version}
      previous={versions[versions.findIndex((v) => v.id === version.id) + 1]}
    />
  );
  const toggleVersion = (id: string) => setExpandedVersion(expandedVersion === id ? undefined : id);

  return (
    <div className="relative flex h-full min-h-0 flex-col" data-testid="tuning-page">
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-180 px-5 pt-6 pb-16 sm:px-10">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <Select
              aria-label={t('tuning.scope')}
              value={scope}
              onValueChange={changeScope}
              className="w-52"
              data-field="scope"
              options={[
                { value: 'global', label: t('tuning.global') },
                ...projects.map((project) => ({ value: project.id, label: project.label })),
              ]}
            />
            {auto && summary !== undefined && (
              <AutoControls
                settings={{
                  autoTuning: summary.auto.enabled,
                  autoTuningMonthlyTokens: summary.budget.limitTokens,
                }}
                update={update}
              />
            )}
          </div>
          {loadError !== undefined && (
            <div className="mb-4">
              <NoticeBanner
                notice={{
                  tone: 'error',
                  text: t('tuning.loadFailed', { error: describe(loadError) }),
                }}
              />
            </div>
          )}
          {undoError !== undefined && (
            <div className="mb-4">
              <NoticeBanner notice={{ tone: 'error', text: undoError }} />
            </div>
          )}
          {current === undefined || (auto && summary === undefined) ? (
            loadError === undefined && <PageSpinner />
          ) : (
            <>
              {timelineShown && summary !== undefined && (
                <>
                  <TrialCard
                    overview={summary}
                    proposals={overview.data?.proposals ?? []}
                    versions={versions}
                    latestSeq={current.latest?.seq}
                    onUndo={undo}
                  />
                  <h2 className="mb-2 text-sm font-medium">{t('tuning.versions')}</h2>
                  {versions.length === 0 && (overview.data?.proposals ?? []).length === 0 ? (
                    <EmptyList>{t('tuning.noVersions')}</EmptyList>
                  ) : (
                    <VersionTimeline
                      versions={versions}
                      proposals={overview.data?.proposals ?? []}
                      expanded={expandedVersion}
                      onToggle={toggleVersion}
                      detail={versionDetail}
                      onUndo={undo}
                    />
                  )}
                  <MoreVersions data={data} />
                </>
              )}
              <ConfigDetails
                open={!timelineShown || detailsOpen}
                collapsible={timelineShown}
                onToggle={() => setDetailsOpen(!detailsOpen)}
                current={current}
              >
                <ul className={LIST_CARD} data-testid="tuning-profile">
                  <CurrentRow current={current} />
                  {knownLayers(current.profile.layers).map((layer) =>
                    layer.key === 'guardrails' && hostSupports(features, 'tuning_guardrails') ? (
                      <GuardrailsLayerRow
                        key={layer.key}
                        client={client}
                        layer={layer}
                        workspaceId={workspaceId}
                        expanded={expandedLayer === layer.key}
                        onToggle={() =>
                          setExpandedLayer(expandedLayer === layer.key ? undefined : layer.key)
                        }
                        onExpand={() => setExpandedLayer(layer.key)}
                      />
                    ) : (
                      <LayerRow
                        key={layer.key}
                        layer={layer}
                        expanded={expandedLayer === layer.key}
                        onToggle={() =>
                          setExpandedLayer(expandedLayer === layer.key ? undefined : layer.key)
                        }
                      />
                    ),
                  )}
                </ul>
                {versions.length > 0 && (
                  <div className="mt-3 flex justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      data-action="compare"
                      onClick={() =>
                        setComparison(
                          comparison !== undefined
                            ? undefined
                            : {
                                from: (versions[0] as ProfileVersionSummary).id,
                                to: 'current',
                              },
                        )
                      }
                    >
                      {t('tuning.compare')}
                    </Button>
                  </div>
                )}
                {comparison !== undefined && (
                  <ComparePanel
                    client={client}
                    versions={versions}
                    value={comparison}
                    onChange={setComparison}
                  />
                )}
                {!timelineShown && (
                  <>
                    <h2 className="mt-6 mb-2 text-sm font-medium">{t('tuning.versions')}</h2>
                    {versions.length === 0 ? (
                      <EmptyList>{t('tuning.noVersions')}</EmptyList>
                    ) : (
                      <ul className={LIST_CARD} data-testid="tuning-versions">
                        {versions.map((version) => (
                          <VersionRow
                            key={version.id}
                            version={version}
                            expanded={expandedVersion === version.id}
                            onToggle={() => toggleVersion(version.id)}
                          >
                            {versionDetail(version)}
                          </VersionRow>
                        ))}
                      </ul>
                    )}
                    <MoreVersions data={data} />
                  </>
                )}
              </ConfigDetails>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
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

/** 配置明细：项目范围默认折叠（标题行写层数与指纹），全局范围一直展开。 */
function ConfigDetails({
  open,
  collapsible,
  onToggle,
  current,
  children,
}: {
  open: boolean;
  collapsible: boolean;
  onToggle: () => void;
  current: MethodResult<'tuning.get'>;
  children: ReactNode;
}) {
  const fingerprint = current.latest?.fingerprint ?? current.profile.fingerprint;
  const head = (
    <>
      <span className="font-medium text-foreground">{t('tuning.details')}</span>
      <span>{t('tuning.layerCount', { count: knownLayers(current.profile.layers).length })}</span>
      <span className="font-mono" title={fingerprint}>
        {shortHash(fingerprint)}
      </span>
    </>
  );
  return (
    <section className={collapsible ? 'mt-8' : undefined} data-testid="tuning-details">
      {collapsible ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          data-action="toggle-details"
          className="mb-2 flex w-full items-center gap-2 rounded-md text-left text-sm text-muted-foreground outline-none focus-visible:focus-ring"
        >
          {head}
          <ChevronDown
            aria-hidden
            className={cn(
              'ml-auto size-3.5 transition-transform duration-150 ease-smooth',
              open && 'rotate-180',
            )}
          />
        </button>
      ) : (
        <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">{head}</div>
      )}
      <Collapse open={open}>{children}</Collapse>
    </section>
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

/** 档案卡片的第一行：最新版本（或“暂无版本”）与当前指纹、会话数与时刻。 */
function CurrentRow({ current }: { current: MethodResult<'tuning.get'> }) {
  const latest = current.latest;
  return (
    <li className="px-4 py-3" data-testid="tuning-current">
      <div className="flex min-w-0 items-center gap-3 text-sm">
        <span className="font-medium">
          {latest === undefined ? t('tuning.noVersions') : versionLabel(latest.seq)}
        </span>
        <span
          className="font-mono text-xs text-muted-foreground"
          title={current.profile.fingerprint}
        >
          {shortHash(latest?.fingerprint ?? current.profile.fingerprint)}
        </span>
        {latest !== undefined && (
          <span className="ml-auto truncate text-xs text-muted-foreground tabular-nums">
            {t('tuning.sessionCount', { count: latest.sessions })} · {formatTime(latest.createdAt)}
          </span>
        )}
      </div>
    </li>
  );
}

/** 一层：名称、范围、条目数与层散列；展开是条目列表，有管理入口的层右边是“管理”。 */
function LayerRow({
  layer,
  expanded,
  onToggle,
}: {
  layer: ProfileLayer;
  expanded: boolean;
  onToggle: () => void;
}) {
  const location = useLocation();
  const manage = layerManage(layer.key);
  const scopes = layerScopes(layer);
  return (
    <ExpandableRow
      id={`layer:${layer.key}`}
      expanded={expanded}
      onToggle={onToggle}
      title={layerName(layer.key)}
      {...(scopes !== '' && { meta: scopes })}
      summary={
        <>
          {layerSummary(layer)}
          <span className="ml-3 font-mono" title={layer.hash}>
            {shortHash(layer.hash)}
          </span>
        </>
      }
      {...(manage !== undefined && {
        control: (
          <Button
            variant="ghost"
            size="xs"
            render={
              <Link
                to={
                  manage.kind === 'settings'
                    ? paths.settings(manage.tab)
                    : paths.plugins(manage.tab)
                }
                state={{ from: location }}
              />
            }
            data-action="manage"
          >
            {t('tuning.manage')}
          </Button>
        ),
      })}
    >
      {layer.items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('tuning.noItems')}</p>
      ) : (
        <ul className="space-y-px" data-testid="tuning-items">
          {layer.items.map((item) => {
            const detail = itemDetail(layer.key, item);
            const path = item.path;
            return (
              <li
                key={item.id}
                className="flex h-7 min-w-0 items-center gap-2 text-xs"
                title={path ?? item.id}
              >
                <span className="min-w-0 flex-1 truncate font-mono">
                  {itemLabel(layer.key, item)}
                </span>
                {detail !== undefined && (
                  <span className="max-w-48 shrink truncate text-muted-foreground">{detail}</span>
                )}
                <span className="shrink-0 text-muted-foreground">{scopeName(item.scope)}</span>
                <span className="w-16 shrink-0 font-mono text-muted-foreground" title={item.hash}>
                  {shortHash(item.hash)}
                </span>
                {path !== undefined && capabilities().localFiles ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="w-12 shrink-0"
                    data-action="open"
                    onClick={() => {
                      const open = canOpenExternally(path)
                        ? platformApi().openPath(path)
                        : platformApi().revealPath(path);
                      void open.catch(() => undefined);
                    }}
                  >
                    {t('tuning.open')}
                    <ExternalLink aria-hidden />
                  </Button>
                ) : (
                  <span className="w-12 shrink-0" />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </ExpandableRow>
  );
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
            <p className="text-xs text-destructive">{diff.error}</p>
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
      className="mb-3 scroll-mt-4 rounded-xl border border-border bg-card px-4 py-3"
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
        <p className="text-xs text-destructive">{result.error}</p>
      ) : (
        <ProfileDiffList client={client} layers={result.layers} />
      )}
    </div>
  );
}
