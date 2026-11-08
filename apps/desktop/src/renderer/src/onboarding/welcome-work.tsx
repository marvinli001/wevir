import { hostSupports, isRpcError } from '@wevir/client-sdk';
import type { ImportScanResult, ProviderId } from '@wevir/protocol';
import { cn } from 'cn';
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Folder,
  FolderOpen,
  History,
  LoaderCircle,
  Lock,
  MessageSquare,
  Plus,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Hint } from '@/components/hint';
import { IconButton } from '@/components/icon-button';
import { ProviderLogo, type ProviderLogoId } from '@/components/provider-logo';
import { Button } from '@/components/ui/button';
import { useWorkbenchData, useWorkbenchStore } from '@/data/workbench-data';
import { projectsOf } from '@/data/workbench-model';
import { useWorkspaceManagement } from '@/data/workspace-actions';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { useElementSize } from '@/lib/use-element-size';
import { openCreateProject, workspaceAddError } from '@/projects/create-project';
import { rememberWorkspace } from '@/routes/last-location';
import { paths } from '@/routes/paths';
import { ModelPicker } from '@/session/model-picker';
import { useModelChoice } from '@/session/start-session';
import { formatRelativeTime } from '@/session/subagent-model';
import { reasonLabel } from '@/settings/import-model';
import { ImportSessionIssues } from '@/settings/import-session-issues';
import {
  historiesForProject,
  historyProjects,
  importHistory,
  latestProject,
} from './welcome-model';

type App = 'claude' | 'codex';

const APPS: readonly { app: App; name: string; logo: ProviderLogoId }[] = [
  { app: 'claude', name: 'Claude Code', logo: 'claude' },
  { app: 'codex', name: 'Codex', logo: 'codex' },
];

const NEW_TASK = 'new';

/**
 * 第二步：左列项目、右列这个项目的任务，两列开头各是一行“新建”。选“新任务”进项目草稿；选一条历史可查看或继续。
 * 外部历史在左列底部按应用读取，读到的目录并进项目列表；读取不导入，只有查看或继续才导入那一条。
 */
export function WelcomeWork({
  onBack,
  onFinish,
}: {
  onBack: () => void;
  onFinish: (path: string) => void;
}) {
  const { client, view } = useHostConnection();
  const store = useWorkbenchStore();
  const data = useWorkbenchData();
  const manage = useWorkspaceManagement();
  const { providers, choice, choose } = useModelChoice();
  const [project, setProject] = useState<string>();
  const [scans, setScans] = useState<Partial<Record<App, ImportScanResult>>>({});
  const [scanning, setScanning] = useState<App>();
  const scanGeneration = useRef(0);
  const [selected, setSelected] = useState(NEW_TASK);
  /** 正在做的操作；按钮上的转圈画在点的那一个上。 */
  const [pending, setPending] = useState<'start' | 'view' | 'continue'>();
  const busy = pending !== undefined;
  const working = useRef(false);
  const [error, setError] = useState<string>();
  const workspaces = data.status === 'ready' ? data.workspaces : [];
  const candidates = APPS.flatMap(({ app }) => scans[app]?.sessions ?? []);
  const projects = historyProjects(workspaces, candidates);
  const root = project ?? projects[0]?.value;
  const entry = projectsOf(workspaces).find((item) => item.workspace.rootPath === root);
  const external = historiesForProject(candidates, root, entry);
  const sessions =
    entry?.sessions.filter(
      (session) => !session.parentSessionId && !session.side && !session.archivedAt,
    ) ?? [];
  const source = sessions.find((session) => `session:${session.id}` === selected);
  const candidate = external.find((item) => `external:${item.app}:${item.key}` === selected);
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'external_session_import');
  const fromHistory =
    view.status === 'connected' && hostSupports(view.hello.features, 'session_from_history');
  const needsModel = candidate !== undefined || source?.readOnly !== undefined;

  const now = Date.now();
  const tasks: Row[] = [
    ...sessions.map((session) => ({
      value: `session:${session.id}`,
      title: session.title || t('session.untitled'),
      detail: formatRelativeTime(session.updatedAt, now),
      icon: <MessageSquare className="size-4 text-muted-foreground" />,
      trailing: session.readOnly ? (
        <Lock aria-label={t('recovery.readOnlyTitle')} className="size-3.5 text-muted-foreground" />
      ) : undefined,
      at: session.updatedAt,
    })),
    ...external.map((item) => ({
      value: `external:${item.app}:${item.key}`,
      title: item.title || item.externalId,
      detail: `${formatRelativeTime(item.updatedAt, now)} · ${t('settings.import.turns', { count: item.turns })}`,
      icon: <ProviderLogo logo={item.app === 'claude' ? 'claude' : 'codex'} className="size-4" />,
      disabled: item.problem !== undefined,
      at: item.updatedAt,
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  const read = async (app: App) => {
    if (!client) return;
    const generation = ++scanGeneration.current;
    setScanning(app);
    setError(undefined);
    try {
      const result = await client.request('import.scan', { app });
      if (generation !== scanGeneration.current) return;
      setScans((current) => ({ ...current, [app]: result }));
      // 还没有项目时落到最近一条历史所在的目录，右列直接出现。
      if (project === undefined && projectsOf(workspaces).length === 0) {
        const latest = latestProject(result.sessions ?? []);
        if (latest !== undefined) setProject(latest);
      }
    } catch (reason) {
      if (generation === scanGeneration.current)
        setError(t('settings.import.scanFailed', { error: describe(reason) }));
    } finally {
      if (generation === scanGeneration.current) setScanning(undefined);
    }
  };
  const cancelRead = () => {
    scanGeneration.current++;
    setScanning(undefined);
  };
  const open = async (continueWork: boolean) => {
    if (!client || working.current) return;
    working.current = true;
    setPending(continueWork ? 'continue' : 'view');
    setError(undefined);
    try {
      let session = source;
      if (candidate) {
        session = await importHistory(client, candidate);
        const workspaceId = session.workspaceId;
        setProject(
          workspaces.find((item) => item.workspace.id === workspaceId)?.workspace.rootPath ??
            session.cwd,
        );
        setSelected(`session:${session.id}`);
        store?.upsertSession(session);
        await store?.refresh();
      }
      if (!session) return;
      if (continueWork && session.readOnly) {
        if (!choice || !fromHistory) return;
        const result = await client.request('session.createFromHistory', {
          sessionId: session.id,
          providerId: choice.providerId as ProviderId,
          modelId: choice.modelId,
          ...(choice.reasoningEffort !== undefined && { reasoningEffort: choice.reasoningEffort }),
        });
        session = result.session;
        store?.upsertSession(session);
      }
      rememberWorkspace(session.workspaceId);
      onFinish(paths.session(session.workspaceId, session.id));
    } catch (reason) {
      const key = reason instanceof Error ? reasonLabel(reason.message) : undefined;
      setError(
        isRpcError(reason, 'WORKSPACE_PATH_INVALID')
          ? workspaceAddError(reason)
          : t('session.createFailed', { error: key ? t(key) : describe(reason) }),
      );
    } finally {
      working.current = false;
      setPending(undefined);
    }
  };
  const start = async () => {
    if (!client || !root || working.current) return;
    working.current = true;
    setPending('start');
    setError(undefined);
    try {
      const workspace =
        entry?.workspace ?? (await client.request('workspace.add', { rootPath: root })).workspace;
      await store?.refresh();
      rememberWorkspace(workspace.id);
      onFinish(paths.draft(workspace.id));
    } catch (reason) {
      setError(workspaceAddError(reason));
    } finally {
      working.current = false;
      setPending(undefined);
    }
  };
  const changeProject = (value: string) => {
    setProject(value);
    setSelected(NEW_TASK);
    setError(undefined);
  };
  const canContinue =
    !busy &&
    (source !== undefined || candidate !== undefined) &&
    (!needsModel || (choice !== undefined && fromHistory));
  const primary = () => {
    if (selected === NEW_TASK) {
      if (client && root && !busy) void start();
    } else if (canContinue) void open(true);
  };

  return (
    <section className="flex h-full min-h-0 flex-col gap-3">
      <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-border">
        <Column label={t('sidebar.projects')}>
          {manage.create && (
            <CreateRow
              label={t('project.create.title')}
              disabled={busy}
              onClick={() =>
                openCreateProject({ onCreated: (workspace) => changeProject(workspace.rootPath) })
              }
              data-action="welcome-create-project"
            />
          )}
          {supported && (
            <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
                <History className="size-3.5" />
              </span>
              <span className="shrink-0 text-sm font-medium">{t('welcome.readHistory')}</span>
              <span className="ml-auto flex shrink-0 gap-1.5">
                {APPS.map((item) => (
                  <HistoryReader
                    key={item.app}
                    {...item}
                    scan={scans[item.app]}
                    scanning={scanning === item.app}
                    disabled={busy || (scanning !== undefined && scanning !== item.app)}
                    onRead={() => void read(item.app)}
                    onCancel={cancelRead}
                  />
                ))}
              </span>
            </div>
          )}
          {APPS.map(
            ({ app }) =>
              (scans[app]?.sessionIssues?.length ?? 0) > 0 && (
                <div key={app} className="flex shrink-0 px-3">
                  <ImportSessionIssues issues={scans[app]?.sessionIssues} app={app} compact />
                </div>
              ),
          )}
          {projects.length > 0 && <hr className="mx-3 my-1.5 shrink-0 border-border" />}
          <PagedRows
            label={t('sidebar.projects')}
            rows={projects.map((item) => ({
              value: item.value,
              title: item.label,
              detail: item.path,
              icon:
                item.value === root ? (
                  <FolderOpen className="size-4 text-foreground" />
                ) : (
                  <Folder className="size-4 text-muted-foreground" />
                ),
            }))}
            selected={root ?? ''}
            onSelect={changeProject}
            disabled={busy}
            data-welcome-projects=""
          />
        </Column>
        <Column label={t('welcome.tasks')}>
          <CreateRow
            label={t('welcome.newTask')}
            selected={selected === NEW_TASK && root !== undefined}
            disabled={busy || root === undefined}
            onClick={() => setSelected(NEW_TASK)}
            onDoubleClick={primary}
            data-action="welcome-new-task"
          />
          <PagedRows
            key={root}
            label={t('welcome.tasks')}
            rows={tasks}
            selected={selected}
            onSelect={setSelected}
            onActivate={primary}
            onPage={() => setSelected(NEW_TASK)}
            disabled={busy}
            data-history-list=""
          />
        </Column>
      </div>
      {error && (
        <p
          role="alert"
          title={error}
          className="shrink-0 line-clamp-2 text-sm break-words text-destructive"
        >
          {error}
        </p>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-2 pt-2">
        {choice && needsModel && fromHistory && (
          <ModelPicker
            providers={providers ?? []}
            value={choice}
            onChange={choose}
            readOnly={busy}
          />
        )}
        <span className="flex-1" />
        <Button variant="ghost" onClick={onBack} disabled={busy}>
          {t('welcome.back')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            scanGeneration.current++;
            onFinish(paths.home());
          }}
          disabled={busy}
        >
          {t('welcome.skip')}
        </Button>
        {selected === NEW_TASK ? (
          <Button
            disabled={!client || !root || busy}
            className="min-w-24"
            onClick={() => void start()}
            data-action="welcome-start"
          >
            {t('welcome.start')}
            <ActionIcon pending={pending === 'start'} />
          </Button>
        ) : (
          <>
            {needsModel && (
              <Button
                variant="outline"
                disabled={busy || (!source && !candidate)}
                onClick={() => void open(false)}
              >
                {pending === 'view' && (
                  <LoaderCircle className="animate-spin" data-icon="inline-start" />
                )}
                {t('welcome.viewHistory')}
              </Button>
            )}
            <Button
              disabled={!canContinue}
              className="min-w-24"
              onClick={() => void open(true)}
              data-action="welcome-start"
            >
              {t('recovery.continue')}
              <ActionIcon pending={pending === 'continue'} />
            </Button>
          </>
        )}
      </div>
    </section>
  );
}

function ActionIcon({ pending }: { pending: boolean }) {
  return pending ? (
    <LoaderCircle className="animate-spin" data-icon="inline-end" />
  ) : (
    <ArrowRight data-icon="inline-end" />
  );
}

function Column({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-1 px-3 first:pl-0 last:pr-0">
      <h2 className="shrink-0 px-3 pb-1 text-xs font-medium text-muted-foreground">{label}</h2>
      {children}
    </div>
  );
}

const ROW =
  'flex w-full min-w-0 items-center gap-3 rounded-lg px-3 text-left outline-none ' +
  'transition-[color,background-color,box-shadow] duration-150 ease-smooth hover:bg-muted/60 focus-visible:focus-ring ' +
  'disabled:pointer-events-none disabled:opacity-50';
const ROW_SELECTED = 'bg-selected ring-1 ring-selected-border ring-inset hover:bg-selected';

/** 两列开头的“新建”一行：加号在一块小底板上，和下面的列表行同宽。 */
function CreateRow({
  label,
  selected = false,
  disabled,
  onClick,
  onDoubleClick,
  ...rest
}: {
  label: string;
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  'data-action'?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={onDoubleClick ? selected : undefined}
      disabled={disabled}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(ROW, 'h-11 shrink-0 text-sm font-medium', selected && ROW_SELECTED)}
      {...rest}
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
        <Plus className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

interface Row {
  value: string;
  title: string;
  detail: string;
  icon: ReactNode;
  trailing?: ReactNode;
  disabled?: boolean;
}

const ROW_HEIGHT = 52;
const ROW_GAP = 2;
const PAGER_HEIGHT = 36;

/** 按可用高度分页的行列表（引导页不滚动）：放得下就不画翻页，选中的那一行所在的页随缩放保持可见。 */
function PagedRows({
  label,
  rows,
  selected,
  onSelect,
  onActivate,
  onPage,
  disabled,
  ...rest
}: {
  label: string;
  rows: Row[];
  selected: string;
  onSelect: (value: string) => void;
  onActivate?: () => void;
  onPage?: () => void;
  disabled: boolean;
  'data-history-list'?: string;
  'data-welcome-projects'?: string;
}) {
  const [ref, size] = useElementSize();
  const [page, setPage] = useState(0);
  const fit = (height: number) =>
    Math.max(1, Math.floor((height + ROW_GAP) / (ROW_HEIGHT + ROW_GAP)));
  const count =
    rows.length <= fit(size.height) ? rows.length || 1 : fit(size.height - PAGER_HEIGHT);
  const pages = Math.max(1, Math.ceil(rows.length / count));
  const current = Math.min(page, pages - 1);
  const selectedIndex = rows.findIndex((row) => row.value === selected);
  useEffect(() => {
    if (selectedIndex >= 0) setPage(Math.floor(selectedIndex / count));
  }, [count, selectedIndex]);
  const turn = (next: number) => {
    onPage?.();
    setPage(next);
  };
  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col" {...rest}>
      <ul className="flex flex-col gap-0.5" aria-label={label}>
        {rows.slice(current * count, (current + 1) * count).map((row) => (
          <li key={row.value} className="animate-in fade-in duration-200">
            <button
              type="button"
              aria-pressed={row.value === selected}
              disabled={disabled || row.disabled === true}
              onClick={() => onSelect(row.value)}
              onDoubleClick={onActivate}
              className={cn(ROW, 'h-13', row.value === selected && ROW_SELECTED)}
            >
              <span className="flex size-6 shrink-0 items-center justify-center">{row.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{row.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{row.detail}</span>
              </span>
              {row.trailing}
            </button>
          </li>
        ))}
      </ul>
      {pages > 1 && (
        <div className="mt-auto flex shrink-0 items-center justify-end gap-2 pt-2 text-xs text-muted-foreground">
          <IconButton
            label={t('usage.page.prev')}
            variant="outline"
            disabled={current === 0 || disabled}
            onClick={() => turn(current - 1)}
          >
            <ChevronLeft />
          </IconButton>
          <span className="tabular-nums">{t('usage.page', { page: current + 1, pages })}</span>
          <IconButton
            label={t('usage.page.next')}
            variant="outline"
            disabled={current + 1 === pages || disabled}
            onClick={() => turn(current + 1)}
          >
            <ChevronRight />
          </IconButton>
        </div>
      )}
    </div>
  );
}

/** 读取一个应用的历史：标志加名字；读取中换成转圈，再点取消；读完带一个勾，没找到时变淡。 */
function HistoryReader({
  name,
  logo,
  scan,
  scanning,
  disabled,
  onRead,
  onCancel,
}: {
  name: string;
  logo: ProviderLogoId;
  scan: ImportScanResult | undefined;
  scanning: boolean;
  disabled: boolean;
  onRead: () => void;
  onCancel: () => void;
}) {
  const missing =
    scan !== undefined && (!scan.found || scan.unsupported.includes('session'))
      ? scan.found
        ? t('settings.import.unsupportedKind')
        : t('settings.import.notFound', { app: name })
      : undefined;
  const done = scan !== undefined && missing === undefined;
  return (
    <Hint label={scanning ? t('common.cancel') : missing}>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-busy={scanning || undefined}
        onClick={scanning ? onCancel : onRead}
        className={cn(missing && 'text-muted-foreground')}
        data-history-app={logo}
      >
        {scanning ? (
          <LoaderCircle className="animate-spin" data-icon="inline-start" />
        ) : (
          <ProviderLogo logo={logo} className={cn('size-3.5', missing && 'opacity-40 grayscale')} />
        )}
        {name}
        {done && <Check className="text-muted-foreground" data-icon="inline-end" />}
      </Button>
    </Hint>
  );
}
