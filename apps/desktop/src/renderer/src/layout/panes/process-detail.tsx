// Host 起的后台进程（0.69.0）在“后台任务”窗格里的详情（desktop-layout.md §15）：命令、目录、来源与输出（虚拟滚动，不能输入），以及
// 停止对话框。列表的行在 tasks-pane.tsx。

import type { WevirClient } from '@wevir/client-sdk';
import type { HostProcess, ProcessStopSignal } from '@wevir/protocol';
import { cn } from 'cn';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { StatusTone } from '@/components/status-dot';
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
import { describe } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import {
  droppedBefore,
  hasEarlier,
  outputLines,
  stopTarget,
  visibleRange,
  wrapRows,
} from '../process-model';
import { useProcessOutput } from '../use-processes';

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

export function statusOf(process: HostProcess): { tone: StatusTone; label: string } {
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

export function stopperLabel(process: HostProcess): string | undefined {
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

export function sourceLabel(process: HostProcess): string {
  if (process.source.kind === 'agent') return t('processes.source.agent');
  if (process.source.kind === 'preview') return t('processes.source.preview');
  const trigger = TRIGGER_LABELS[process.source.trigger];
  return `${t('processes.source.check')} · ${trigger ? t(trigger) : process.source.trigger}`;
}

export function ProcessDetail({
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

export function StopDialog({
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
