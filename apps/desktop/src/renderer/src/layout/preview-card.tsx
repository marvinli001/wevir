// 会话侧栏的“预览”卡片（0.84.0，Host 功能 `dev_preview`，ADR-0013）：项目的运行配置（命令、目录、端口），一键启动，就绪后在这个
// 会话的浏览器窗格里打开（同一地址已有标签页时选中它）；停止、看输出、编辑、删除；仓库里读出的候选一键添加。启动前 Host 问环境
// 就绪，没就绪时写出阻塞项。只在项目里的普通会话里有（子会话、“对话”里没有），旧 Host 没有这张卡片。

import type { WevirClient } from '@wevir/client-sdk';
import { hostSupports } from '@wevir/client-sdk';
import type {
  HostProcess,
  PreviewCandidate,
  PreviewConfig,
  SessionId,
  WorkspaceId,
} from '@wevir/protocol';
import { Ellipsis, Plus } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { StatusDot } from '@/components/status-dot';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { isChats } from '@/data/workbench-model';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { sessionTabs } from '../browser/browser-store';
import { type PaneController, usePanes } from './pane-controller';
import {
  candidateInput,
  commandLine,
  formOf,
  inputOf,
  PREVIEW_LABELS,
  PREVIEW_TONES,
  type PreviewForm,
  type PreviewRow,
  previewRows,
  previewSummary,
  sameOrigin,
  startProblem,
  targetLabel,
} from './preview-model';
import { type RailContext, registerRailCard } from './session-rail';
import { useProcessList } from './use-processes';

/** 点了“启动”之后最多等多久就绪再打开网页（同 Host 的判定上限）。 */
const OPEN_WAIT_MS = 120_000;

/** 在这个会话的浏览器窗格里打开：同源的标签页已开着时选中它，否则新开；然后显示浏览器窗格。 */
async function openInBrowser(sessionId: SessionId, url: string, panes: PaneController | undefined) {
  const browser = window.wevir?.browser;
  if (!browser) return;
  const { tabs } = sessionTabs(await browser.state(), sessionId);
  const existing = tabs.find((tab) => sameOrigin(tab.url, url));
  if (existing) await browser.select(existing.id);
  else await browser.open(sessionId, url);
  panes?.open({ kind: 'browser' });
}

/** 等这个预览进程就绪（`process.changed`）；退出或超时时 undefined。 */
function waitReady(client: WevirClient, process: HostProcess): Promise<HostProcess | undefined> {
  if (process.preview?.ready === true) return Promise.resolve(process);
  return new Promise((resolve) => {
    const done = (value: HostProcess | undefined) => {
      clearTimeout(timer);
      off();
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), OPEN_WAIT_MS);
    const off = client.onProcessesChanged((change) => {
      if (change === undefined || !('process' in change)) return;
      const next = change.process;
      if (next.id !== process.id || next.startedAt !== process.startedAt) return;
      if (next.status !== 'running') done(undefined);
      else if (next.preview?.ready === true) done(next);
    });
  });
}

/** 配置与候选：侧栏看得见时读，`preview.changed` 合进来，重连后重读。在跑的预览来自 `process.list`。 */
function usePreviewList(sessionId: SessionId, active: boolean) {
  const { client, view } = useHostConnection();
  const supported = view.status === 'connected' && hostSupports(view.hello.features, 'dev_preview');
  const [list, setList] = useState<{
    root: string;
    configs: PreviewConfig[];
    candidates: PreviewCandidate[];
  }>();
  const [error, setError] = useState<string>();
  const seq = useRef(0);

  const load = useCallback(() => {
    if (!client) return;
    const id = ++seq.current;
    client.request('preview.list', { sessionId }).then(
      (result) => {
        if (id !== seq.current) return;
        setList(result);
        setError(undefined);
      },
      (reason: unknown) => {
        if (id === seq.current) setError(t('preview.failed', { error: describe(reason) }));
      },
    );
  }, [client, sessionId]);

  useEffect(() => {
    if (supported && active) load();
  }, [supported, active, load]);

  useEffect(() => {
    if (!client || !supported) return;
    return client.onPreviewChanged(() => {
      if (active) load();
    });
  }, [client, supported, active, load]);

  return { supported, list, error, reload: load };
}

function usePreviewCard({ sessionId, session, entry, visible }: RailContext) {
  const { supported, list, error, reload } = usePreviewList(sessionId, visible);
  if (!supported || session.parentSessionId !== undefined || isChats(entry.workspace)) return null;
  return {
    summary: list && (
      <PreviewSummary workspaceId={entry.workspace.id} root={list.root} configs={list.configs} />
    ),
    details: (
      <PreviewDetails
        sessionId={sessionId}
        workspaceId={entry.workspace.id as WorkspaceId}
        list={list}
        error={error}
        onReload={reload}
      />
    ),
  };
}

function usePreviewRows(workspaceId: WorkspaceId, root: string, configs: PreviewConfig[]) {
  const { client } = useHostConnection();
  // 没连上时卡片不显示，这里总有 client。
  const { processes } = useProcessList(client as WevirClient, { workspaceId });
  return useMemo(() => previewRows(configs, processes ?? [], root), [configs, processes, root]);
}

function PreviewSummary({
  workspaceId,
  root,
  configs,
}: {
  workspaceId: string;
  root: string;
  configs: PreviewConfig[];
}) {
  const rows = usePreviewRows(workspaceId as WorkspaceId, root, configs);
  const summary = previewSummary(rows);
  if (summary === undefined) return null;
  return (
    <>
      <StatusDot tone={summary.tone} pulse={summary.tone === 'accent'} />
      <span className="truncate">{t(summary.key, { count: summary.count })}</span>
    </>
  );
}

type Notice =
  | { kind: 'error'; text: string }
  | { kind: 'blocked'; text: string }
  | { kind: 'port'; text: string; url: string };

function PreviewDetails({
  sessionId,
  workspaceId,
  list,
  error,
  onReload,
}: {
  sessionId: SessionId;
  workspaceId: WorkspaceId;
  list: { root: string; configs: PreviewConfig[]; candidates: PreviewCandidate[] } | undefined;
  error: string | undefined;
  onReload: () => void;
}) {
  const { client } = useHostConnection();
  const panes = usePanes();
  const rows = usePreviewRows(workspaceId, list?.root ?? '', list?.configs ?? []);
  const [notice, setNotice] = useState<Notice>();
  const [editing, setEditing] = useState<PreviewConfig | 'new'>();
  const [busy, setBusy] = useState<string>();

  if (!list) return <p className="text-xs text-muted-foreground">{error ?? t('common.loading')}</p>;

  const fail = (reason: unknown) =>
    setNotice({ kind: 'error', text: t('preview.failed', { error: describe(reason) }) });

  const start = async (config: PreviewConfig) => {
    if (!client) return;
    setNotice(undefined);
    setBusy(config.name);
    try {
      const result = await client.request('preview.start', { sessionId, name: config.name });
      const problem = startProblem(result);
      if (problem?.key === 'preview.blocked') {
        setNotice({ kind: 'blocked', text: t('preview.blocked', { items: problem.items }) });
        return;
      }
      if (problem?.key === 'preview.portInUse') {
        setNotice({
          kind: 'port',
          text: t('preview.portInUse', { port: problem.port }),
          url: problem.url,
        });
        return;
      }
      if (result.status !== 'started' && result.status !== 'reused') return;
      setBusy(undefined);
      const ready = await waitReady(client, result.process);
      const url = ready?.preview?.url;
      if (url !== undefined) await openInBrowser(sessionId, url, panes);
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(undefined);
    }
  };

  const stop = async (process: HostProcess) => {
    if (!client) return;
    setNotice(undefined);
    try {
      await client.request('process.stop', { processId: process.id });
    } catch (reason) {
      fail(reason);
    }
  };

  const remove = async (config: PreviewConfig) => {
    if (!client) return;
    setNotice(undefined);
    try {
      await client.request('preview.remove', { workspaceId, name: config.name });
      onReload();
    } catch (reason) {
      fail(reason);
    }
  };

  const addCandidate = async (candidate: PreviewCandidate) => {
    if (!client) return;
    setNotice(undefined);
    try {
      const taken = new Set(list.configs.map((config) => config.name));
      let name = candidate.name;
      for (let n = 2; taken.has(name); n++) name = `${candidate.name} ${n}`;
      await client.request('preview.save', {
        workspaceId,
        config: { ...candidateInput(candidate), name },
      });
      onReload();
    } catch (reason) {
      fail(reason);
    }
  };

  return (
    <div data-testid="rail-preview">
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('preview.empty')}</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((row) => (
            <ConfigRow
              key={row.config.name}
              row={row}
              busy={busy === row.config.name}
              disabled={!client}
              onStart={() => void start(row.config)}
              onStop={() => row.process && void stop(row.process)}
              onOpen={() => {
                const url = row.process?.preview?.url;
                if (url !== undefined) void openInBrowser(sessionId, url, panes).catch(fail);
              }}
              onOutput={() => panes?.open({ kind: 'processes' })}
              onEdit={() => setEditing(row.config)}
              onRemove={() => void remove(row.config)}
            />
          ))}
        </ul>
      )}

      {list.candidates.length > 0 && (
        <div className="mt-3" data-testid="rail-preview-candidates">
          <p className="mb-1 text-xs text-muted-foreground">{t('preview.candidates')}</p>
          <ul className="space-y-1">
            {list.candidates.map((candidate) => (
              <li
                key={`${candidate.cwd}\0${candidate.command}`}
                className="flex min-w-0 items-center gap-2"
              >
                <code
                  className="min-w-0 flex-1 truncate font-mono text-xs"
                  title={`${candidate.file} · ${commandLine(candidate)}`}
                >
                  {candidate.cwd !== '' && (
                    <span className="text-muted-foreground">{candidate.cwd} · </span>
                  )}
                  {candidate.command}
                </code>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!client}
                  onClick={() => void addCandidate(candidate)}
                  data-action="add-preview-candidate"
                >
                  {t('preview.candidate.add')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Button
        size="xs"
        variant="ghost"
        className="mt-2 -ml-2"
        disabled={!client}
        onClick={() => setEditing('new')}
        data-action="add-preview"
      >
        <Plus />
        {t('preview.add')}
      </Button>

      {notice && (
        <div className="mt-2 flex min-w-0 items-start gap-2 text-xs">
          <p className={notice.kind === 'error' ? 'text-destructive' : 'text-warning'} role="alert">
            {notice.text}
          </p>
          {notice.kind === 'port' && (
            <Button
              size="xs"
              variant="outline"
              className="shrink-0"
              onClick={() => void openInBrowser(sessionId, notice.url, panes).catch(fail)}
            >
              {t('preview.open')}
            </Button>
          )}
        </div>
      )}
      {error && list && <p className="mt-2 text-xs text-destructive">{error}</p>}

      {editing !== undefined && (
        <PreviewDialog
          workspaceId={workspaceId}
          config={editing === 'new' ? undefined : editing}
          onClose={(saved) => {
            setEditing(undefined);
            if (saved) onReload();
          }}
        />
      )}
    </div>
  );
}

function ConfigRow({
  row,
  busy,
  disabled,
  onStart,
  onStop,
  onOpen,
  onOutput,
  onEdit,
  onRemove,
}: {
  row: PreviewRow;
  busy: boolean;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
  onOpen: () => void;
  onOutput: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { config, process, state } = row;
  const live = state === 'starting' || state === 'ready';
  const target = targetLabel(
    process?.preview?.url !== undefined ? { url: process.preview.url } : config,
  );
  return (
    <li data-preview={config.name} data-preview-state={state}>
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot
          tone={PREVIEW_TONES[state]}
          pulse={state === 'starting'}
          label={t(PREVIEW_LABELS[state])}
        />
        <span className="min-w-0 flex-1 truncate text-sm">
          {config.name}
          {target && <span className="text-muted-foreground"> · {target}</span>}
        </span>
        {state === 'ready' && (
          <Button size="xs" variant="outline" onClick={onOpen} data-action="open-preview">
            {t('preview.open')}
          </Button>
        )}
        {live ? (
          <Button size="xs" variant="ghost" onClick={onStop} data-action="stop-preview">
            {t('preview.stop')}
          </Button>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || busy}
            onClick={onStart}
            data-action="start-preview"
          >
            {t('preview.start')}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <IconButton label={t('preview.more')} size="icon-xs" className="-mr-1">
                <Ellipsis />
              </IconButton>
            }
          />
          <DropdownMenuContent align="end" className="min-w-32">
            {process && (
              <DropdownMenuItem onClick={onOutput}>{t('preview.output')}</DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onEdit}>{t('preview.edit')}</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              {t('preview.remove')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <code
        className="mt-0.5 block truncate pl-4 font-mono text-xs text-muted-foreground"
        title={commandLine(config)}
      >
        {commandLine(config)}
      </code>
    </li>
  );
}

function PreviewDialog({
  workspaceId,
  config,
  onClose,
}: {
  workspaceId: WorkspaceId;
  config: PreviewConfig | undefined;
  onClose: (saved: boolean) => void;
}) {
  const { client } = useHostConnection();
  const id = useId();
  const [form, setForm] = useState<PreviewForm>(() => formOf(config));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const parsed = inputOf(form, config);

  const save = async () => {
    if (!client) return;
    if ('error' in parsed) {
      setError(t(parsed.error));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await client.request('preview.save', {
        workspaceId,
        config: parsed.input,
        ...(config !== undefined && config.name !== parsed.input.name && { previous: config.name }),
      });
      onClose(true);
    } catch (reason) {
      setBusy(false);
      setError(t('preview.failed', { error: describe(reason) }));
    }
  };

  const field = (key: keyof PreviewForm, label: string, mono = false) => (
    <div className="space-y-1 text-sm">
      <label htmlFor={`${id}-${key}`} className="block text-muted-foreground">
        {label}
      </label>
      <Input
        id={`${id}-${key}`}
        value={form[key]}
        onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
        className={mono ? 'font-mono' : undefined}
        spellCheck={false}
        autoComplete="off"
        autoFocus={key === 'name'}
        inputMode={key === 'port' ? 'numeric' : undefined}
      />
    </div>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose(false)}>
      <DialogContent className="sm:max-w-md" data-testid="preview-dialog">
        <DialogHeader>
          <DialogTitle>{t(config ? 'preview.dialog.edit' : 'preview.dialog.add')}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {field('name', t('preview.field.name'))}
          {field('command', t('preview.field.command'), true)}
          {field('cwd', t('preview.field.cwd'), true)}
          <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3">
            {field('port', t('preview.field.port'), true)}
            {field('url', t('preview.field.url'), true)}
          </div>
          {error && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onClose(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!client || busy}>
              {t('preview.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

registerRailCard({
  id: 'preview',
  order: 33,
  title: () => t('rail.preview'),
  useCard: usePreviewCard,
});
