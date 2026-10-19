// “浏览器”窗格（0.33.0，desktop-layout.md §21）：当前会话的标签页、前进后退刷新与地址栏；网页本身是主进程放在窗口上的原生
// 视图（WebContentsView，main/browser/browser-host.ts），这里只占位并把位置告诉主进程。agent 操作的标签页带标记，agent 的命令
// 正在执行时显示“Agent 操作中”；用户在 agent 的标签页里点过敲过就接手了，agent 之后只读，“交给 Agent”再交回去。
// 弹出菜单与对话框盖住窗格时先把原生视图收起来（它总在页面之上）。

import { cn } from 'cn';
import { ArrowLeft, ArrowRight, Bot, ExternalLink, Globe, Plus, RotateCw, X } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { sessionTabs, tabLabel, useBrowserState } from '@/browser/browser-store';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import type { BrowserBounds, BrowserTabState } from '../../../../shared/desktop-api.js';
import type { PaneContext } from '../pane-registry';
import { Note } from './files-pane';

export function BrowserPane({ context }: { context: PaneContext }) {
  const { sessionId } = context;
  if (sessionId === undefined || !window.wevir?.browser) {
    return <Note icon={Globe}>{t('browser.noSession')}</Note>;
  }
  return <SessionBrowser sessionId={sessionId} />;
}

function SessionBrowser({ sessionId }: { sessionId: string }) {
  const browser = window.wevir.browser;
  const state = useBrowserState();
  const { tabs, active } = sessionTabs(state, sessionId);
  const [error, setError] = useState<string>();
  const run = (action: Promise<unknown>) => {
    setError(undefined);
    action.catch(() => setError(t('browser.invalidAddress')));
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="browser-pane">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist">
          {tabs.map((tab) => (
            <TabButton
              key={tab.id}
              tab={tab}
              selected={tab.id === active?.id}
              onSelect={() => run(browser.select(tab.id))}
              onClose={() => run(browser.close(tab.id))}
            />
          ))}
        </div>
        <IconButton
          label={t('browser.newTab')}
          size="icon-xs"
          onClick={() => run(browser.open(sessionId))}
          data-testid="browser-new-tab"
        >
          <Plus />
        </IconButton>
      </div>
      <Toolbar sessionId={sessionId} tab={active} run={run} error={error} />
      <Viewport sessionId={sessionId} tab={active} />
    </div>
  );
}

function TabButton({
  tab,
  selected,
  onSelect,
  onClose,
}: {
  tab: BrowserTabState;
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const label = tabLabel(tab, t('browser.untitled'));
  return (
    <div
      className={cn(
        'group flex h-7 max-w-44 min-w-24 shrink-0 items-center gap-1.5 rounded-md pr-1 pl-2 text-xs',
        selected
          ? 'bg-selected ring-1 ring-selected-border ring-inset text-foreground'
          : 'text-muted-foreground hover:bg-muted/60',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        onClick={onSelect}
        title={tab.url}
        className="flex min-w-0 flex-1 items-center gap-1.5 outline-none"
        data-testid="browser-tab"
        data-controller={tab.controller}
      >
        {tab.controller === 'agent' ? (
          <Bot
            aria-label={t('browser.agentTab')}
            className={cn('size-3.5 shrink-0', tab.agentBusy && 'text-primary')}
          />
        ) : (
          <Globe aria-hidden className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{label}</span>
      </button>
      <button
        type="button"
        aria-label={t('browser.closeTab')}
        onClick={onClose}
        className="flex size-4 shrink-0 items-center justify-center rounded opacity-0 outline-none group-hover:opacity-100 hover:bg-background focus-visible:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

function Toolbar({
  sessionId,
  tab,
  run,
  error,
}: {
  sessionId: string;
  tab: BrowserTabState | undefined;
  run: (action: Promise<unknown>) => void;
  error: string | undefined;
}) {
  const browser = window.wevir.browser;
  const shownUrl = tab && tab.url !== 'about:blank' ? tab.url : '';
  const [draft, setDraft] = useState(shownUrl);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(shownUrl);
  }, [shownUrl, editing]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const address = draft.trim();
    if (address === '') return;
    setEditing(false);
    run(tab ? browser.navigate(tab.id, address) : browser.open(sessionId, address));
  };

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-1.5">
      <IconButton
        label={t('browser.back')}
        size="icon-xs"
        disabled={!tab?.canGoBack}
        onClick={() => tab && run(browser.history(tab.id, 'back'))}
      >
        <ArrowLeft />
      </IconButton>
      <IconButton
        label={t('browser.forward')}
        size="icon-xs"
        disabled={!tab?.canGoForward}
        onClick={() => tab && run(browser.history(tab.id, 'forward'))}
      >
        <ArrowRight />
      </IconButton>
      {tab?.isLoading ? (
        <IconButton
          label={t('browser.stop')}
          size="icon-xs"
          onClick={() => run(browser.history(tab.id, 'stop'))}
        >
          <X />
        </IconButton>
      ) : (
        <IconButton
          label={t('browser.reload')}
          size="icon-xs"
          disabled={!tab}
          onClick={() => tab && run(browser.history(tab.id, 'reload'))}
        >
          <RotateCw />
        </IconButton>
      )}
      <form onSubmit={submit} className="flex min-w-0 flex-1">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => {
            setEditing(true);
            event.target.select();
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setDraft(shownUrl);
              event.currentTarget.blur();
            }
          }}
          placeholder={t('browser.address')}
          aria-label={t('browser.address')}
          aria-invalid={error !== undefined}
          spellCheck={false}
          data-testid="browser-address"
          className={cn(
            'h-7 min-w-0 flex-1 rounded-lg bg-muted/60 px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:bg-muted focus:ring-2 focus:ring-ring/40',
            error !== undefined && 'ring-2 ring-destructive/50',
          )}
        />
      </form>
      {tab?.agentBusy && (
        <span
          className="flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-xs text-primary"
          data-testid="browser-agent-working"
        >
          <Bot className="size-3.5" />
          {t('browser.agentWorking')}
        </span>
      )}
      {tab &&
        (tab.controller === 'agent' ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => run(browser.setController(tab.id, 'user'))}
            data-testid="browser-take-over"
          >
            {t('browser.takeOver')}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => run(browser.setController(tab.id, 'agent'))}
            data-testid="browser-hand-to-agent"
          >
            {t('browser.handToAgent')}
          </Button>
        ))}
      {shownUrl !== '' && (
        <IconButton
          label={t('browser.openExternal')}
          size="icon-xs"
          onClick={() => void window.wevir.openExternal(shownUrl).catch(() => {})}
        >
          <ExternalLink />
        </IconButton>
      )}
    </div>
  );
}

/** 盖住窗格时要先收起原生视图的弹层。 */
const OVERLAYS = '[role="menu"],[role="dialog"],[role="alertdialog"],[role="listbox"]';

function overlapsOverlay(rect: DOMRect): boolean {
  for (const element of document.querySelectorAll(OVERLAYS)) {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    if (
      box.right > rect.left &&
      box.left < rect.right &&
      box.bottom > rect.top &&
      box.top < rect.bottom
    ) {
      return true;
    }
  }
  return false;
}

/** 网页的位置：每一帧量一次占位的位置，变了就告诉主进程；看不见（标签页被切走、窗格收起、被弹层盖住）时收起。 */
function Viewport({ sessionId, tab }: { sessionId: string; tab: BrowserTabState | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  const tabId = tab?.id;
  useEffect(() => {
    const browser = window.wevir.browser;
    let frame = 0;
    let last: string | undefined;
    const measure = () => {
      const element = ref.current;
      const rect = element?.getBoundingClientRect();
      const visible =
        tabId !== undefined &&
        rect !== undefined &&
        rect.width > 0 &&
        rect.height > 0 &&
        element?.checkVisibility() === true &&
        !overlapsOverlay(rect);
      const bounds: BrowserBounds | undefined = visible
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : undefined;
      const key = bounds
        ? `${tabId}:${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
        : 'hidden';
      if (key === last) return;
      last = key;
      if (bounds) void browser.show(bounds, sessionId).catch(() => {});
      else void browser.hide().catch(() => {});
    };
    // 每一帧量一次（拖分隔条时跟得上）；窗口被挡住时浏览器不出帧，另有一个慢一些的定时器兜底。
    const tick = () => {
      frame = requestAnimationFrame(tick);
      measure();
    };
    tick();
    const timer = setInterval(measure, 250);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
      void browser.hide().catch(() => {});
    };
  }, [sessionId, tabId]);

  const blank = !tab || tab.url === '' || tab.url === 'about:blank';
  return (
    <div ref={ref} className="relative min-h-0 flex-1 bg-background" data-testid="browser-viewport">
      {tab?.loadError ? (
        <Note icon={Globe}>
          {t('browser.loadFailed')}
          <span className="mt-1 block font-mono text-xs">{tab.loadError.description}</span>
        </Note>
      ) : blank ? (
        <Note icon={Globe}>{t('browser.empty')}</Note>
      ) : null}
    </div>
  );
}
