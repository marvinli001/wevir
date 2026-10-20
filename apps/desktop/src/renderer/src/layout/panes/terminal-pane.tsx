import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalOutput, WevirClient } from '@wevir/client-sdk';
import type { SessionId, Terminal, TerminalId, WorkspaceId } from '@wevir/protocol';
import { RotateCcw, Square, SquareTerminal } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { resolvedTheme, subscribeTheme } from '@/theme/theme';
import { usePanes } from '../pane-controller';
import { onPanesClosed } from '../pane-events';
import type { PaneContext } from '../pane-registry';
import type { PaneTab } from '../pane-state';
import {
  chunkInput,
  endTarget,
  placeOutput,
  terminalLabel,
  terminalPalette,
} from '../terminal-model';

const FONT_SIZE = 12;

/**
 * “终端”窗格（0.68.0，ADR-0010）：Host 上的用户交互终端，xterm.js 渲染。标签的参数记着终端 ID（`id`）与标签名（`label`）；
 * 没有 ID 时开一个新的（在会话的目录，没有会话时在项目根目录）。关掉标签结束终端；断线重连后带上读到的位置重新 attach。
 */
export function TerminalPane({ tab, context }: { tab: PaneTab; context: PaneContext }) {
  const { client } = useHostConnection();
  const { entry, sessionId } = context;
  if (!entry) return <Note>{t('terminal.noProject')}</Note>;
  if (!client?.supports('user_terminal')) return <Note>{t('terminal.unsupported')}</Note>;
  return (
    <TerminalView
      client={client}
      tab={tab}
      workspaceId={entry.workspace.id as WorkspaceId}
      sessionId={sessionId as SessionId | undefined}
    />
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <SquareTerminal aria-hidden className="size-6 stroke-[1.5] text-muted-foreground" />
      <p className="max-w-64 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

/** 开好的终端按标签记下：开发模式下 effect 跑两次、或参数还没写回时重新挂载，都不会再开一个。 */
const created = new Map<string, Promise<Terminal>>();

type State =
  | { kind: 'starting' }
  | { kind: 'live'; terminal: Terminal }
  | { kind: 'gone' }
  | { kind: 'failed'; error: string };

function TerminalView({
  client,
  tab,
  workspaceId,
  sessionId,
}: {
  client: WevirClient;
  tab: PaneTab;
  workspaceId: WorkspaceId;
  sessionId: SessionId | undefined;
}) {
  const panes = usePanes();
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>({ kind: 'starting' });
  const [generation, setGeneration] = useState(0);
  const [ending, setEnding] = useState<Terminal>();
  const initialId = useRef(tab.params?.id as TerminalId | undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 每个标签、每次“新建终端”挂一次；参数变了（写回 ID 与标签名）不重挂。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let terminalId = initialId.current;
    let current: Terminal | undefined;
    /** 读到哪儿了；attach 的结果回来之前到的输出先存着。 */
    let next = 0;
    let attaching = false;
    let pending: TerminalOutput[] = [];
    let sent: { cols: number; rows: number } | undefined;

    const term = new XTerm({
      fontFamily: cssVar('--font-code') || 'monospace',
      fontSize: FONT_SIZE,
      cursorBlink: true,
      scrollback: 5000,
      theme: palette(),
      // OSC 8 的链接：只开 http(s)，经主进程用系统浏览器打开。
      linkHandler: {
        activate: (_event, uri) => {
          if (/^https?:\/\//i.test(uri)) void window.wevir.openExternal(uri).catch(() => undefined);
        },
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    safeFit(fit);
    const offTheme = subscribeTheme(() => {
      term.options.theme = palette();
    });

    const show = (terminal: Terminal) => {
      current = terminal;
      if (disposed) return;
      setState({ kind: 'live', terminal });
      const label = terminalLabel(terminal);
      const params = tabRef.current.params;
      if (params?.id !== terminal.id || params?.label !== label) {
        panesRef.current?.setParams(tab.id, { id: terminal.id, label });
      }
      // 别的客户端改了尺寸：按 Host 的尺寸显示，自己有输入或聚焦时再按窗格的大小改回去。
      if (
        terminal.status === 'running' &&
        (term.cols !== terminal.cols || term.rows !== terminal.rows)
      ) {
        term.resize(terminal.cols, terminal.rows);
      }
    };

    /** 按窗格的大小排版，与 Host 的尺寸不同就告诉它。 */
    const fitAndSend = () => {
      if (disposed) return;
      safeFit(fit);
      if (terminalId === undefined || current?.status !== 'running') return;
      const size = { cols: term.cols, rows: term.rows };
      if (size.cols === current.cols && size.rows === current.rows) return;
      if (sent?.cols === size.cols && sent.rows === size.rows) return;
      sent = size;
      void client
        .request('terminal.resize', { terminalId, ...size })
        .catch(() => undefined)
        .finally(() => {
          if (sent === size) sent = undefined;
        });
    };

    const handle = (output: TerminalOutput) => {
      if (output.terminalId !== terminalId || disposed) return;
      if (attaching) {
        pending.push(output);
        return;
      }
      const placed = placeOutput(next, output);
      if (placed.kind === 'skip') return;
      if (placed.kind === 'gap') {
        void attach(next);
        return;
      }
      term.write(placed.data);
      next = placed.next;
    };

    const attach = async (since?: number) => {
      if (terminalId === undefined || attaching) return;
      attaching = true;
      pending = [];
      try {
        const result = await client.request('terminal.attach', {
          terminalId,
          ...(since !== undefined && { since }),
        });
        if (disposed) return;
        if (result.reset) term.reset();
        term.write(result.data);
        next = result.next;
        attaching = false;
        show(result.terminal);
        const queued = pending;
        pending = [];
        for (const output of queued) handle(output);
        fitAndSend();
      } catch {
        attaching = false;
        // Host 重启过或终端已经关掉：ID 不认识了。
        if (!disposed) setState({ kind: 'gone' });
      }
    };

    const offOutput = client.onTerminalOutput(handle);
    const offChanged = client.onTerminalsChanged((change) => {
      if (disposed) return;
      if (change === undefined) {
        // 重连上了：Host 已经不再给断开的连接发输出，从读到的位置接着。
        if (terminalId !== undefined && current !== undefined) void attach(next);
        return;
      }
      if ('removed' in change) {
        if (change.removed.id === terminalId) setState({ kind: 'gone' });
        return;
      }
      if (change.terminal.id === terminalId) show(change.terminal);
    });
    // 关掉标签：结束终端。
    const offClosed = onPanesClosed((tabs) => {
      if (terminalId === undefined || !tabs.some((closed) => closed.id === tab.id)) return;
      created.delete(tab.id);
      void client.request('terminal.close', { terminalId }).catch(() => undefined);
    });

    const onData = term.onData((data) => {
      if (terminalId === undefined || current?.status !== 'running') return;
      fitAndSend();
      for (const chunk of chunkInput(data)) {
        void client.request('terminal.input', { terminalId, data: chunk }).catch(() => undefined);
      }
    });
    // 终端里的按键不交给应用的快捷键（Esc 停止回合、Ctrl-Tab 切标签……），Cmd 组合键照旧给应用。
    const stopKeys = (event: KeyboardEvent) => {
      if (!event.metaKey) event.stopPropagation();
    };
    container.addEventListener('keydown', stopKeys);
    const onFocus = () => fitAndSend();
    term.textarea?.addEventListener('focus', onFocus);
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fitAndSend, 30);
    });
    observer.observe(container);

    const start = async () => {
      if (terminalId === undefined) {
        let promise = created.get(tab.id);
        if (promise === undefined) {
          promise = client
            .request('terminal.create', {
              workspaceId,
              ...(sessionId !== undefined && { sessionId }),
              cols: Math.max(2, term.cols),
              rows: Math.max(1, term.rows),
            })
            .then((result) => result.terminal);
          created.set(tab.id, promise);
        }
        try {
          const terminal = await promise;
          terminalId = terminal.id;
          initialId.current = terminal.id;
          if (disposed) return;
          show(terminal);
        } catch (reason) {
          created.delete(tab.id);
          if (!disposed) setState({ kind: 'failed', error: describe(reason) });
          return;
        }
      }
      await attach();
      if (!disposed) term.focus();
    };
    void start();

    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      observer.disconnect();
      container.removeEventListener('keydown', stopKeys);
      term.textarea?.removeEventListener('focus', onFocus);
      onData.dispose();
      offOutput();
      offChanged();
      offClosed();
      offTheme();
      if (terminalId !== undefined) {
        void client.request('terminal.detach', { terminalId }).catch(() => undefined);
      }
      term.dispose();
    };
  }, [tab.id, generation]);

  const restart = () => {
    // 已退出的那个不再留在 Host 上（Host 重启后不认识它了，关闭失败也无妨）。
    const previous = initialId.current;
    if (previous !== undefined) {
      void client.request('terminal.close', { terminalId: previous }).catch(() => undefined);
    }
    created.delete(tab.id);
    initialId.current = undefined;
    setState({ kind: 'starting' });
    setGeneration((value) => value + 1);
  };

  const terminal = state.kind === 'live' ? state.terminal : undefined;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="terminal-pane">
      <div className="flex h-7 shrink-0 items-center gap-2 px-3 text-xs text-muted-foreground">
        <span className="min-w-0 truncate" data-testid="terminal-status">
          {statusText(state)}
        </span>
        <span className="flex-1" />
        {terminal !== undefined && terminal.clients > 1 && (
          <span className="shrink-0">{t('terminal.clients', { count: terminal.clients })}</span>
        )}
        {terminal?.status === 'running' && (
          <IconButton
            label={t('terminal.end')}
            size="icon-xs"
            onClick={() => setEnding(terminal)}
            data-testid="terminal-end"
          >
            <Square aria-hidden className="size-3" />
          </IconButton>
        )}
        {(state.kind === 'gone' || state.kind === 'failed' || terminal?.status === 'exited') && (
          <Button size="xs" variant="ghost" onClick={restart} data-testid="terminal-restart">
            <RotateCcw aria-hidden className="size-3" />
            {t('terminal.restart')}
          </Button>
        )}
      </div>
      <div className="relative min-h-0 flex-1 px-2 pb-1">
        <div
          ref={containerRef}
          className="h-full w-full overflow-hidden"
          data-testid="terminal-screen"
        />
      </div>
      {ending !== undefined && (
        <EndDialog client={client} terminal={ending} onClose={() => setEnding(undefined)} />
      )}
    </div>
  );
}

function statusText(state: State): string {
  switch (state.kind) {
    case 'starting':
      return t('terminal.starting');
    case 'gone':
      return t('terminal.gone');
    case 'failed':
      return t('terminal.startFailed', { error: state.error });
    case 'live': {
      const { terminal } = state;
      if (terminal.error !== undefined) return t('terminal.startFailed', { error: terminal.error });
      if (terminal.status === 'exited') {
        return terminal.signal !== null
          ? t('terminal.exitedSignal', { signal: terminal.signal })
          : t('terminal.exited', { code: terminal.exitCode ?? '?' });
      }
      const name = terminal.foreground ?? terminalLabel(terminal);
      return terminal.pid === undefined ? name : `${name} · ${terminal.pid}`;
    }
  }
}

function EndDialog({
  client,
  terminal,
  onClose,
}: {
  client: WevirClient;
  terminal: Terminal;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const end = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.request('terminal.close', { terminalId: terminal.id });
      onClose();
    } catch (reason) {
      setError(t('terminal.endFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };
  const target = endTarget(terminal.shell);
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton={false}
        data-testid="terminal-end-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('terminal.endTitle')}</DialogTitle>
          <DialogDescription render={<div />}>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t('terminal.field.target')}</dt>
              <dd className="min-w-0 break-words text-foreground">
                {t(target === 'tree' ? 'terminal.target.tree' : 'terminal.target.session', {
                  pid: terminal.pid ?? '?',
                })}
              </dd>
              <dt className="text-muted-foreground">{t('terminal.field.foreground')}</dt>
              <dd className="min-w-0 font-mono text-xs break-all text-foreground">
                {terminal.foreground ?? terminalLabel(terminal)}
              </dd>
              <dt className="text-muted-foreground">{t('terminal.field.shell')}</dt>
              <dd className="min-w-0 font-mono text-xs break-all text-foreground">
                {terminal.shell}
              </dd>
              <dt className="text-muted-foreground">{t('terminal.field.cwd')}</dt>
              <dd className="min-w-0 font-mono text-xs break-all text-foreground">
                {terminal.cwd}
              </dd>
            </dl>
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void end()}>
            {t('terminal.end')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function safeFit(fit: FitAddon): void {
  try {
    fit.fit();
  } catch {
    // 窗格还没有尺寸（刚挂上、被收起）。
  }
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function palette() {
  return terminalPalette(resolvedTheme(), {
    background: cssVar('--background') || '#fcfbfa',
    foreground: cssVar('--foreground') || '#1a1a17',
    selection: cssVar('--selection') || cssVar('--accent') || 'rgba(128,128,128,0.35)',
  });
}
