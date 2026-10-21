// 调优页（0.85.0，docs/architecture/desktop-layout.md §34，版式照插件页）：主窗格里的一列，顶上是范围选择与分段，下面是“档案”：
// 当前版本一行（有待生效的改动时多一行与“对比”）、八层（展开看条目与打开、管理入口）、版本列表（展开看与前一版的变化和用它的
// 会话）与两版对比。数据是 `tuning.*`（use-tuning.ts）。

import type { WevirClient } from '@wevir/client-sdk';
import type {
  HostFeatures,
  MethodResult,
  ProfileLayer,
  ProfileVersionId,
  ProfileVersionSummary,
  SessionId,
} from '@wevir/protocol';
import { ExternalLink } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select } from '@/components/ui/select';
import { useWorkbenchData } from '@/data/workbench-data';
import { projectsOf } from '@/data/workbench-model';
import { describe } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import { DetailSection, ExpandableRow } from '@/plugins/plugin-rows';
import { paths, type TuningTab } from '@/routes/paths';
import { EmptyList, LIST_CARD, NoticeBanner, Segmented } from '@/settings/settings-ui';
import { canOpenExternally } from '../../../shared/open-path.js';
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
  pendingSummary,
  pickScope,
  scopeName,
  scopeWorkspaceId,
  shortHash,
  versionLabel,
  visibleTuningTabs,
} from './tuning-model';
import { tuningScope, useTuning } from './use-tuning';

/** 对比的两边：一个版本与另一个版本或当前配置。 */
interface Comparison {
  from: ProfileVersionId;
  to: ProfileVersionId | 'current';
}

export function TuningPage({
  tab,
  client,
  features,
}: {
  tab: TuningTab;
  client: WevirClient;
  features: HostFeatures;
}) {
  const navigate = useNavigate();
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
  const data = useTuning(client, scopeWorkspaceId(scope));
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

  const changeScope = (next: string) => {
    tuningScope.set(next);
    setExpandedLayer(undefined);
    setExpandedVersion(undefined);
    setComparison(undefined);
    // 地址里的范围与版本只管第一次进来。
    if (params.has('workspace') || params.has('version')) setParams({}, { replace: true });
  };

  const tabs = visibleTuningTabs(features);
  const current = data.data?.current;
  const versions = data.data?.versions ?? [];

  return (
    <div className="relative flex h-full min-h-0 flex-col" data-testid="tuning-page" data-tab={tab}>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-180 px-5 pt-6 pb-16 sm:px-10">
          <div className="mb-5 flex items-center justify-between gap-3">
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
            <Segmented<TuningTab>
              label={t('tuning.tabs')}
              value={tab}
              onChange={(next) => navigate(paths.tuning(next), { replace: true })}
              options={tabs.map((value) => ({ value, label: t(`tuning.tab.${value}`) }))}
            />
          </div>
          {data.error !== undefined && (
            <div className="mb-4">
              <NoticeBanner
                notice={{
                  tone: 'error',
                  text: t('tuning.loadFailed', { error: describe(data.error) }),
                }}
              />
            </div>
          )}
          {current === undefined ? (
            data.error === undefined && (
              <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
            )
          ) : (
            <>
              <ul className={LIST_CARD} data-testid="tuning-profile">
                <CurrentRow
                  current={current}
                  onCompare={() =>
                    current.latest !== undefined &&
                    setComparison({ from: current.latest.id, to: 'current' })
                  }
                />
                {knownLayers(current.profile.layers).map((layer) => (
                  <LayerRow
                    key={layer.key}
                    layer={layer}
                    expanded={expandedLayer === layer.key}
                    onToggle={() =>
                      setExpandedLayer(expandedLayer === layer.key ? undefined : layer.key)
                    }
                  />
                ))}
              </ul>

              <div className="mt-8 mb-2 flex items-center justify-between gap-3">
                <h2 className="text-sm font-medium">{t('tuning.versions')}</h2>
                {versions.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-action="compare"
                    onClick={() =>
                      setComparison(
                        comparison !== undefined
                          ? undefined
                          : {
                              from: (versions[1] ?? versions[0])?.id as ProfileVersionId,
                              to:
                                versions[1] === undefined
                                  ? 'current'
                                  : (versions[0]?.id as ProfileVersionId),
                            },
                      )
                    }
                  >
                    {t('tuning.compare')}
                  </Button>
                )}
              </div>
              {comparison !== undefined && (
                <ComparePanel
                  client={client}
                  versions={versions}
                  value={comparison}
                  onChange={setComparison}
                />
              )}
              {versions.length === 0 ? (
                <EmptyList>{t('tuning.noVersions')}</EmptyList>
              ) : (
                <ul className={LIST_CARD} data-testid="tuning-versions">
                  {versions.map((version, index) => (
                    <VersionRow
                      key={version.id}
                      client={client}
                      version={version}
                      previous={versions[index + 1]}
                      expanded={expandedVersion === version.id}
                      onToggle={() =>
                        setExpandedVersion(expandedVersion === version.id ? undefined : version.id)
                      }
                    />
                  ))}
                </ul>
              )}
              {data.data?.nextCursor !== undefined && (
                <div className="mt-2 flex justify-center">
                  <Button variant="ghost" size="sm" onClick={data.more}>
                    {t('sidebar.showMore')}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>
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

/** 档案卡片的第一行：最新版本（或“暂无版本”）与当前指纹；当前配置与最新版本不同时下面一行“待生效”与“对比”。 */
function CurrentRow({
  current,
  onCompare,
}: {
  current: MethodResult<'tuning.get'>;
  onCompare: () => void;
}) {
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
      {current.pending && (
        <div className="mt-1.5 flex min-w-0 items-center gap-3" data-testid="tuning-pending">
          <span className="truncate text-xs text-warning">
            {t('tuning.pending')}
            {current.pendingLayers.length > 0 && ` · ${pendingSummary(current.pendingLayers)}`}
          </span>
          <Button
            variant="outline"
            size="xs"
            className="ml-auto"
            onClick={onCompare}
            data-action="compare-current"
          >
            {t('tuning.compare')}
          </Button>
        </div>
      )}
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
                {path !== undefined ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="w-12 shrink-0"
                    data-action="open"
                    onClick={() => {
                      const open = canOpenExternally(path)
                        ? window.wevir.openPath(path)
                        : window.wevir.revealPath(path);
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

/** 一个版本：序号、时间与变化摘要、会话数；展开是与前一版的变化与用它建的会话。 */
function VersionRow({
  client,
  version,
  previous,
  expanded,
  onToggle,
}: {
  client: WevirClient;
  version: ProfileVersionSummary;
  previous: ProfileVersionSummary | undefined;
  expanded: boolean;
  onToggle: () => void;
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
      {expanded && <VersionDetail client={client} version={version} previous={previous} />}
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
  // 从顶上“待生效”那行打开时面板在页面下方，打开时滚到眼前。
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
