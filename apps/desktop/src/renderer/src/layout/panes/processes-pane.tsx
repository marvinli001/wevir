import type { WevirClient } from '@wevir/client-sdk';
import type { HostProcess, ProcessStopSignal, SessionId, WorkspaceId } from '@wevir/protocol';
import { cn } from 'cn';
import { ScrollText, Square } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { StatusDot, type StatusTone } from '@/components/status-dot';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useTranscript } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import { formatDuration } from '@/session/format';
import { useNow } from '@/session/subagent-view';
import type { PaneContext } from '../pane-registry';
import {
  droppedBefore,
  hasEarlier,
  outputLines,
  processKey,
  sortProcesses,
  stopTarget,
  visibleRange,
  wrapRows,
} from '../process-model';
import { useProcessList, useProcessOutput } from '../use-processes';

const ROW_HEIGHT = 18;

const SIGNAL_LABELS: Record<ProcessStopSignal, PlainMessageKey> = {
  SIGINT: 'processes.signal.SIGINT',
  SIGTERM: 'processes.signal.SIGTERM',
  SIGKILL: 'processes.signal.SIGKILL',
};

const TRIGGER_LABELS: Record<string, PlainMessageKey> = {
  manual: 'processes.trigger.manual',
  after_turn: 'processes.trigger.after_turn',
  repair: 'processes.trigger.repair',
};

/**
 * “进程输出”窗格（0.69.0，desktop-layout.md §2.1）：当前会话或项目里 Host 起的后台进程（Agent 起的、回合后检查起的），看输出、
 * 停止。不是终端：不能输入。
 */
export function ProcessesPane({ context }: { context: PaneContext }) {
  const { client } = useHostConnection();
  const { entry, sessionId } = context;
  if (!entry) return <Note>{t('processes.noProject')}</Note>;
  if (!client?.supports('process_output')) return <Note>{t('processes.unsupported')}</Note>;
  return (
    <ProcessesView
      key={entry.workspace.id}
      client={client}
      workspaceId={entry.workspace.id as WorkspaceId}
      sessionId={sessionId as SessionId | undefined}
      titles={new Map(entry.sessions.map((session) => [session.id, session.title]))}
    />
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <ScrollText aria-hidden className="size-6 stroke-[1.5] text-muted-foreground" />
      <p className="max-w-64 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function ProcessesView({
  client,
  workspaceId,
  sessionId,
  titles,
}: {
  client: WevirClient;
  workspaceId: WorkspaceId;
  sessionId: SessionId | undefined;
  titles: ReadonlyMap<string, string>;
}) {
  const [scope, setScope] = useState<'session' | 'workspace'>(
    sessionId === undefined ? 'workspace' : 'session',
  );
  const effective = sessionId === undefined ? 'workspace' : scope;
  const { processes, error } = useProcessList(client, {
    workspaceId,
    ...(effective === 'session' && sessionId !== undefined && { sessionId }),
  });
  const { running, exited } = useMemo(() => sortProcesses(processes ?? []), [processes]);
  const [selectedKey, setSelectedKey] = useState<string>();
  const ordered = useMemo(() => [...running, ...exited], [running, exited]);
  const selected =
    ordered.find((item) => processKey(item) === selectedKey) ??
    (selectedKey === undefined ? ordered[0] : undefined);
  // 默认选中的那个（最近起的在跑的）记下来：它退出后在列表里换了位置也还选着它。
  const fallbackKey = selectedKey === undefined && selected ? processKey(selected) : undefined;
  useEffect(() => {
    if (fallbackKey !== undefined) setSelectedKey(fallbackKey);
  }, [fallbackKey]);
  const now = useNow(running.length > 0 ? 1000 : undefined);
  const [stopping, setStopping] = useState<HostProcess>();

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="processes-pane">
      {sessionId !== undefined && (
        <div className="flex shrink-0 items-center gap-1 px-3 pt-1 pb-2">
          {(['session', 'workspace'] as const).map((value) => (
            <Button
              key={value}
              size="xs"
              variant={effective === value ? 'secondary' : 'ghost'}
              aria-pressed={effective === value}
              onClick={() => setScope(value)}
            >
              {t(value === 'session' ? 'processes.scope.session' : 'processes.scope.workspace')}
            </Button>
          ))}
        </div>
      )}
      {error !== undefined && processes === undefined ? (
        <p
          role="alert"
          className="mx-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {t('processes.loadFailed', { error: describe(error) })}
        </p>
      ) : processes === undefined ? null : ordered.length === 0 ? (
        <Note>{t('processes.empty')}</Note>
      ) : (
        <>
          <ul
            className="max-h-[40%] shrink-0 overflow-y-auto border-b border-border px-2 pb-2"
            aria-label={t('pane.kind.processes')}
          >
            {ordered.map((item) => (
              <ProcessRow
                key={processKey(item)}
                process={item}
                now={now}
                selected={selected !== undefined && processKey(selected) === processKey(item)}
                sessionTitle={
                  effective === 'workspace' ? titles.get(item.source.sessionId) : undefined
                }
                onSelect={() => setSelectedKey(processKey(item))}
                onStop={item.stopSignals.length > 0 ? () => setStopping(item) : undefined}
              />
            ))}
          </ul>
          {selected === undefined ? (
            <Note>{t('processes.gone')}</Note>
          ) : (
            <ProcessDetail
              key={processKey(selected)}
              client={client}
              process={selected}
              sessionTitle={titles.get(selected.source.sessionId)}
            />
          )}
        </>
      )}
      {stopping && (
        <StopDialog
          client={client}
          process={ordered.find((item) => processKey(item) === processKey(stopping)) ?? stopping}
          onClose={() => setStopping(undefined)}
        />
      )}
    </div>
  );
}

function statusOf(process: HostProcess): { tone: StatusTone; label: string } {
  if (process.status === 'running') return { tone: 'accent', label: t('processes.status.running') };
  if (process.error !== undefined) return { tone: 'danger', label: t('processes.status.failed') };
  // 被停的不算失败：退出码是停它的信号带来的。
  const stopped = process.stoppedBy !== undefined;
  if (process.signal !== null) {
    return { tone: 'neutral', label: t('processes.status.signal', { signal: process.signal }) };
  }
  return {
    tone: stopped ? 'neutral' : process.exitCode === 0 ? 'success' : 'danger',
    label: t('processes.status.exit', { code: process.exitCode ?? '?' }),
  };
}

function stopperLabel(process: HostProcess): string | undefined {
  switch (process.stoppedBy) {
    case 'user':
      return t('processes.stoppedBy.user');
    case 'agent':
      return t('processes.stoppedBy.agent');
    case 'host':
      return t('processes.stoppedBy.host');
    default:
      return undefined;
  }
}

function sourceLabel(process: HostProcess): string {
  if (process.source.kind === 'agent') return t('processes.source.agent');
  if (process.source.kind === 'preview') return t('processes.source.preview');
  const trigger = TRIGGER_LABELS[process.source.trigger];
  return `${t('processes.source.check')} · ${trigger ? t(trigger) : process.source.trigger}`;
}

function ProcessRow({
  process,
  now,
  selected,
  sessionTitle,
  onSelect,
  onStop,
}: {
  process: HostProcess;
  now: number;
  selected: boolean;
  sessionTitle: string | undefined;
  onSelect: () => void;
  onStop: (() => void) | undefined;
}) {
  const status = statusOf(process);
  const end = process.endedAt === undefined ? now : Date.parse(process.endedAt);
  const meta = [sourceLabel(process), sessionTitle, status.label, stopperLabel(process)].filter(
    Boolean,
  );
  return (
    <li
      data-testid="process-row"
      data-status={process.status}
      className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5', selected && 'bg-accent')}
    >
      <button
        type="button"
        aria-current={selected || undefined}
        onClick={onSelect}
        className="-mx-1 flex min-w-0 flex-1 items-start gap-2 rounded-md px-1 text-left outline-none focus-visible:focus-ring"
      >
        <StatusDot tone={status.tone} pulse={process.status === 'running'} className="mt-1.5" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{process.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{meta.join(' · ')}</span>
        </span>
      </button>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {formatDuration(end - Date.parse(process.startedAt))}
      </span>
      {onStop && (
        <IconButton
          label={t('processes.stop')}
          size="icon-xs"
          className="text-muted-foreground hover:text-destructive"
          onClick={onStop}
          data-testid="process-stop"
        >
          <Square />
        </IconButton>
      )}
    </li>
  );
}

function ProcessDetail({
  client,
  process,
  sessionTitle,
}: {
  client: WevirClient;
  process: HostProcess;
  sessionTitle: string | undefined;
}) {
  const turn = useTurnNumber(process);
  const facts: [string, string][] = [
    [t('processes.field.command'), process.command],
    [t('processes.field.cwd'), process.cwd],
    ...(process.pid !== undefined
      ? [[t('processes.field.pid'), String(process.pid)] as [string, string]]
      : []),
    [
      t('processes.field.source'),
      [sourceLabel(process), sessionTitle, turn && t('processes.turn', { number: turn })]
        .filter(Boolean)
        .join(' · '),
    ],
    ...(process.error !== undefined
      ? [[t('processes.status.failed'), process.error] as [string, string]]
      : []),
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <dl className="grid shrink-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-3 py-2 text-xs">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 truncate font-mono" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <OutputView client={client} process={process} />
    </div>
  );
}

/** 起它的回合是这个会话的第几个回合（只认得出已经加载了消息的会话）。 */
function useTurnNumber(process: HostProcess): number | undefined {
  const state = useTranscript(process.source.sessionId);
  const turnId = process.source.turnId;
  if (turnId === undefined || state === undefined) return undefined;
  const turns: string[] = [];
  for (const message of state.transcript.messages) {
    if (message.role === 'user' && !turns.includes(message.turnId)) turns.push(message.turnId);
  }
  const index = turns.indexOf(turnId);
  return index < 0 ? undefined : index + 1;
}

function OutputView({ client, process }: { client: WevirClient; process: HostProcess }) {
  const output = useProcessOutput(client, process);
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 0, columns: 80 });
  const stick = useRef(true);
  const buffer = output.buffer;
  const rows = useMemo(
    () => (buffer === undefined ? [] : wrapRows(outputLines(buffer), view.columns)),
    [buffer, view.columns],
  );

  // 宽度变了按等宽字符重新算列数。
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const probe = document.createElement('span');
    probe.className = 'font-mono text-xs';
    probe.style.visibility = 'hidden';
    probe.style.position = 'absolute';
    probe.textContent = 'M'.repeat(50);
    element.appendChild(probe);
    const charWidth = probe.getBoundingClientRect().width / 50 || 7;
    probe.remove();
    const measure = () =>
      setView((current) => ({
        ...current,
        height: element.clientHeight,
        columns: Math.floor((element.clientWidth - 24) / charWidth),
      }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 在底部时跟着新输出滚到底；往前补了一页时停在原来看的那几行。
  const previous = useRef({ rows: 0, from: Number.POSITIVE_INFINITY });
  useLayoutEffect(() => {
    const element = scroller.current;
    const before = previous.current;
    previous.current = { rows: rows.length, from: buffer?.from ?? Number.POSITIVE_INFINITY };
    if (!element) return;
    if (buffer !== undefined && buffer.from < before.from && before.rows > 0) {
      element.scrollTop += (rows.length - before.rows) * ROW_HEIGHT;
    } else if (stick.current) {
      element.scrollTop = element.scrollHeight;
    } else {
      return;
    }
    setView((current) => ({ ...current, top: element.scrollTop }));
  }, [rows.length, buffer]);

  const { first, last } = visibleRange(view.top, view.height, ROW_HEIGHT, rows.length);
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border">
      {buffer !== undefined && (hasEarlier(buffer) || droppedBefore(buffer)) && (
        <div className="shrink-0 px-3 py-1">
          {hasEarlier(buffer) ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={output.loadingEarlier}
              onClick={() => {
                stick.current = false;
                output.loadEarlier();
              }}
            >
              {t('processes.earlier')}
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">{t('processes.dropped')}</span>
          )}
        </div>
      )}
      <div
        ref={scroller}
        data-testid="process-output"
        className="relative min-h-0 flex-1 overflow-y-auto bg-muted/40 font-mono text-xs"
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current =
            element.scrollTop + element.clientHeight >= element.scrollHeight - ROW_HEIGHT;
          setView((current) => ({ ...current, top: element.scrollTop }));
        }}
      >
        {output.error !== undefined && (
          <p role="alert" className="px-3 py-2 font-sans text-destructive">
            {t('processes.loadFailed', { error: describe(output.error) })}
          </p>
        )}
        {buffer !== undefined && rows.length === 0 && (
          <p className="px-3 py-2 font-sans text-muted-foreground">{t('processes.noOutput')}</p>
        )}
        <div style={{ height: rows.length * ROW_HEIGHT }} className="relative">
          {rows.slice(first, last).map((row, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: 显示行没有别的身份，按位置渲染。
              key={first + index}
              className={cn(
                'absolute right-0 left-0 overflow-hidden px-3 whitespace-pre',
                row.continued && 'text-muted-foreground/90',
              )}
              style={{
                top: (first + index) * ROW_HEIGHT,
                height: ROW_HEIGHT,
                lineHeight: `${ROW_HEIGHT}px`,
              }}
            >
              {row.text}
            </div>
          ))}
        </div>
      </div>
      {buffer?.detached && (
        <div className="shrink-0 border-t border-border px-3 py-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              stick.current = true;
              output.jumpToLatest();
            }}
          >
            {t('processes.latest')}
          </Button>
        </div>
      )}
    </div>
  );
}

function StopDialog({
  client,
  process,
  onClose,
}: {
  client: WevirClient;
  process: HostProcess;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const target = stopTarget(process);
  const send = async (signal: ProcessStopSignal) => {
    setBusy(true);
    setError(undefined);
    try {
      await client.request('process.stop', { processId: process.id, signal });
      onClose();
    } catch (reason) {
      setError(t('processes.stopFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };
  const targetText =
    target === 'check'
      ? t('processes.target.check', { name: process.name })
      : t(target === 'group' ? 'processes.target.group' : 'processes.target.tree', {
          pid: process.pid ?? '?',
        });
  const exited = process.status !== 'running';
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton={false}
        data-testid="process-stop-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {t(target === 'check' ? 'processes.cancelTitle' : 'processes.stopTitle')}
          </DialogTitle>
          <DialogDescription render={<div />}>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t('processes.field.target')}</dt>
              <dd className="min-w-0 break-words text-foreground">{targetText}</dd>
              <dt className="text-muted-foreground">{t('processes.field.command')}</dt>
              <dd className="min-w-0 font-mono text-xs break-all text-foreground">
                {process.command}
              </dd>
              <dt className="text-muted-foreground">{t('processes.field.cwd')}</dt>
              <dd className="min-w-0 font-mono text-xs break-all text-foreground">{process.cwd}</dd>
            </dl>
          </DialogDescription>
        </DialogHeader>
        {(error || exited) && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">
            {error ?? t('processes.alreadyExited')}
          </p>
        )}
        <DialogFooter className="sm:flex-wrap">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {!exited &&
            (target === 'check' ? (
              <Button variant="destructive" disabled={busy} onClick={() => void send('SIGTERM')}>
                {t('processes.cancelCheck')}
              </Button>
            ) : (
              process.stopSignals.map((signal) => (
                <Button
                  key={signal}
                  variant={signal === 'SIGKILL' ? 'destructive' : 'outline'}
                  disabled={busy}
                  onClick={() => void send(signal)}
                >
                  {t(SIGNAL_LABELS[signal])}
                </Button>
              ))
            ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
