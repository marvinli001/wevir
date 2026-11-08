import { hostSupports, isRpcError } from '@wevir/client-sdk';
import type { ImportScanResult, ProviderId } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { Radio, RadioGroup } from '@/components/ui/radio-group';
import { Select } from '@/components/ui/select';
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
import { reasonLabel } from '@/settings/import-model';
import { ImportSessionIssues } from '@/settings/import-session-issues';
import { Segmented } from '@/settings/settings-ui';
import {
  historiesForProject,
  historyProjects,
  importHistory,
  latestProject,
} from './welcome-model';

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
  const [existing, setExisting] = useState(false);
  const [app, setApp] = useState<'claude' | 'codex'>('claude');
  const [scan, setScan] = useState<ImportScanResult>();
  const [scanning, setScanning] = useState(false);
  const scanGeneration = useRef(0);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState<string>();
  const workspaces = data.status === 'ready' ? data.workspaces : [];
  const projects = projectsOf(workspaces);
  const root = project ?? projects[0]?.workspace.rootPath;
  const entry = projects.find((item) => item.workspace.rootPath === root);
  const candidates = scan?.app === app ? (scan.sessions ?? []) : [];
  const external = historiesForProject(candidates, root, entry);
  const sessions =
    entry?.sessions.filter(
      (session) => !session.parentSessionId && !session.side && !session.archivedAt,
    ) ?? [];
  const source = sessions.find((session) => `session:${session.id}` === selected);
  const candidate = external.find((item) => `external:${item.key}` === selected);
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'external_session_import');
  const fromHistory =
    view.status === 'connected' && hostSupports(view.hello.features, 'session_from_history');

  const read = async () => {
    if (!client || scanning) return;
    const generation = ++scanGeneration.current;
    setScanning(true);
    setError(undefined);
    try {
      const result = await client.request('import.scan', { app });
      if (generation !== scanGeneration.current) return;
      setScan(result);
      // 还没选项目时落到最近一条历史所在的项目，列表直接出现。
      if (root === undefined) {
        const latest = latestProject(result.sessions ?? []);
        if (latest !== undefined) setProject(latest);
      }
    } catch (reason) {
      if (generation === scanGeneration.current)
        setError(t('settings.import.scanFailed', { error: describe(reason) }));
    } finally {
      if (generation === scanGeneration.current) setScanning(false);
    }
  };
  const open = async (continueWork: boolean) => {
    if (!client || working.current) return;
    working.current = true;
    setBusy(true);
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
      setBusy(false);
    }
  };
  const start = async () => {
    if (!client || !root || working.current) return;
    working.current = true;
    setBusy(true);
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
      setBusy(false);
    }
  };
  const changeProject = (value: string) => {
    setProject(value);
    setSelected('');
    setError(undefined);
  };

  return (
    <section className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap gap-2">
        <Select
          aria-label={t('welcome.project')}
          value={root ?? ''}
          options={[
            { value: '', label: t('welcome.project') },
            ...historyProjects(workspaces, candidates),
          ]}
          onValueChange={changeProject}
          disabled={busy}
          className="h-9 flex-1"
          data-action="welcome-project"
        />
        {manage.create && (
          <Button
            variant="outline"
            size="lg"
            disabled={busy}
            onClick={() =>
              openCreateProject({ onCreated: (workspace) => changeProject(workspace.rootPath) })
            }
          >
            {t('project.create.title')}
          </Button>
        )}
      </div>
      <div className="shrink-0">
        <Segmented
          label={t('welcome.ready.title')}
          value={existing ? 'existing' : 'new'}
          options={[
            { value: 'new', label: t('welcome.newTask') },
            { value: 'existing', label: t('welcome.existingTask') },
          ]}
          disabled={busy}
          onChange={(value) => {
            setExisting(value === 'existing');
            setError(undefined);
          }}
        />
      </div>
      {existing && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {supported ? (
            <div className="flex shrink-0 flex-wrap gap-2">
              <Select
                aria-label={t('settings.import.app')}
                value={app}
                options={[
                  { value: 'claude', label: 'Claude Code' },
                  { value: 'codex', label: 'Codex' },
                ]}
                disabled={busy}
                onValueChange={(value) => {
                  scanGeneration.current++;
                  setScanning(false);
                  setApp(value);
                  setScan(undefined);
                  setSelected('');
                  setError(undefined);
                }}
                className="w-40"
              />
              <Button variant="outline" disabled={scanning || busy} onClick={() => void read()}>
                {t(scanning ? 'settings.import.scanning' : 'welcome.readHistory')}
              </Button>
              {scanning && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    scanGeneration.current++;
                    setScanning(false);
                  }}
                >
                  {t('common.cancel')}
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('settings.import.unsupported')}</p>
          )}
          {scan && <ImportSessionIssues issues={scan.sessionIssues} app={scan.app} compact />}
          {scan?.unsupported.includes('session') ? (
            <p className="text-sm text-muted-foreground">{t('settings.import.unsupportedKind')}</p>
          ) : scan && !scan.found ? (
            <p className="text-sm text-muted-foreground">
              {t('settings.import.notFound', { app: app === 'claude' ? 'Claude Code' : 'Codex' })}
            </p>
          ) : (
            sessions.length === 0 &&
            external.length === 0 &&
            root !== undefined &&
            scan && (
              <p className="text-sm text-muted-foreground">{t('settings.import.empty.session')}</p>
            )
          )}
          {(sessions.length > 0 || external.length > 0) && (
            <HistoryChoices
              key={`${root}:${app}`}
              selected={selected}
              onSelect={setSelected}
              disabled={busy}
              items={[
                ...sessions.map((session) => ({
                  value: `session:${session.id}`,
                  title: session.title || t('session.untitled'),
                  detail: t(session.readOnly ? 'recovery.readOnlyTitle' : 'welcome.existingTask'),
                })),
                ...external.map((item) => ({
                  value: `external:${item.key}`,
                  title: item.title || item.externalId,
                  detail: `${item.app === 'claude' ? 'Claude Code' : 'Codex'} · ${t('settings.import.turns', { count: item.turns })}${item.skipped > 0 ? ` · ${t('settings.import.skippedLines', { count: item.skipped })}` : ''}`,
                  disabled: item.problem !== undefined,
                })),
              ]}
            />
          )}
        </div>
      )}
      {error && (
        <p
          role="alert"
          title={error}
          className="shrink-0 line-clamp-2 text-sm break-words text-destructive"
        >
          {error}
        </p>
      )}
      <div className="mt-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
        {choice && (candidate || source?.readOnly) && fromHistory && (
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
        {existing ? (
          <>
            <Button
              variant="outline"
              disabled={busy || (!source && !candidate)}
              onClick={() => void open(false)}
            >
              {t('welcome.viewHistory')}
            </Button>
            <Button
              disabled={
                busy ||
                (!source && !candidate) ||
                ((candidate !== undefined || source?.readOnly !== undefined) &&
                  (!choice || !fromHistory))
              }
              onClick={() => void open(true)}
              data-action="welcome-start"
            >
              {t('recovery.continue')}
            </Button>
          </>
        ) : (
          <Button
            disabled={!client || !root || busy}
            onClick={() => void start()}
            data-action="welcome-start"
          >
            {t('welcome.start')}
          </Button>
        )}
      </div>
    </section>
  );
}

interface HistoryChoice {
  value: string;
  title: string;
  detail: string;
  disabled?: boolean;
}

function HistoryChoices({
  items,
  selected,
  onSelect,
  disabled,
}: {
  items: HistoryChoice[];
  selected: string;
  onSelect: (value: string) => void;
  disabled: boolean;
}) {
  const [ref, size] = useElementSize();
  const [page, setPage] = useState(0);
  const count = Math.max(1, Math.floor((size.height - 36) / 56));
  const selectedIndex = items.findIndex((item) => item.value === selected);
  useEffect(() => {
    if (selectedIndex >= 0) setPage(Math.floor(selectedIndex / count));
  }, [count, selectedIndex]);
  const pages = Math.ceil(items.length / count);
  const current = Math.min(page, pages - 1);
  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col gap-2" data-history-list>
      <RadioGroup
        value={selected}
        onValueChange={(value) => onSelect(String(value))}
        aria-label={t('welcome.existingTask')}
      >
        <ul className="space-y-1">
          {items.slice(current * count, (current + 1) * count).map((item) => (
            <HistoryRow
              key={item.value}
              {...item}
              selected={selected}
              disabled={disabled || item.disabled === true}
            />
          ))}
        </ul>
      </RadioGroup>
      {pages > 1 && (
        <div className="mt-auto flex shrink-0 items-center justify-end gap-2 text-xs text-muted-foreground">
          <IconButton
            label={t('usage.page.prev')}
            variant="outline"
            disabled={current === 0 || disabled}
            onClick={() => {
              onSelect('');
              setPage(current - 1);
            }}
          >
            <ChevronLeft />
          </IconButton>
          <span className="tabular-nums">{t('usage.page', { page: current + 1, pages })}</span>
          <IconButton
            label={t('usage.page.next')}
            variant="outline"
            disabled={current + 1 === pages || disabled}
            onClick={() => {
              onSelect('');
              setPage(current + 1);
            }}
          >
            <ChevronRight />
          </IconButton>
        </div>
      )}
    </div>
  );
}

function HistoryRow({
  value,
  selected,
  title,
  detail,
  disabled,
}: {
  value: string;
  selected: string;
  title: string;
  detail: string;
  disabled: boolean;
}) {
  return (
    <li>
      <label
        className={cn(
          'flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2 focus-within:focus-field',
          selected === value && 'border-selected-border bg-selected',
          disabled && 'opacity-50',
        )}
      >
        <Radio value={value} disabled={disabled} aria-label={title} className="mt-0.5" />
        <span className="min-w-0">
          <span className="block truncate text-sm">{title}</span>
          <span className="block text-xs text-muted-foreground">{detail}</span>
        </span>
      </label>
    </li>
  );
}
