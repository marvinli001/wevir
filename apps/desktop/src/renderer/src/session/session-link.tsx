import { PreviewCard } from '@base-ui/react/preview-card';
import type { SessionId } from '@wevir/protocol';
import { cn } from 'cn';
import {
  type ReactElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Link, useNavigate } from 'react-router';
import { StatusDot } from '@/components/status-dot';
import { useWorkbenchData, useWorkbenchStore } from '@/data/workbench-data';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { findSession, type SessionEntry, sessionPlace, sessionStatus } from './session-link-model';
import { formatRelativeTime } from './subagent-model';

// 会话链接（照 Claude Code 桌面端 2026-10-27）：行内胶囊（styles/session.css 的 .session-pill），悬停弹出小卡片，第一行状态、
// 项目与相对时间，第二行会话标题；点它打开那个会话。会话不在列表里时只是文字。消息里的 Markdown 链接由 markdown.ts 渲染成
// `a.session-pill[data-session-link]`，悬停与点击经 MarkdownSessionLinks 委托；其余地方（别的会话发来的消息、回报、建议的任务）
// 用 SessionLink。

const OPEN_DELAY_MS = 300;
const CLOSE_DELAY_MS = 150;

const CARD =
  'z-50 w-72 origin-(--transform-origin) rounded-xl bg-popover p-3 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden transition-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-90 blur-in-xs data-open:duration-(--spring-reveal-duration) data-open:ease-spring-reveal data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-90 blur-out-xs data-closed:duration-110 data-closed:ease-smooth';

/** 工作台里的一个会话（订阅工作台，会话的状态与标题变了跟着变）。 */
export function useSessionEntry(id: SessionId | undefined): SessionEntry | undefined {
  return findSession(useWorkbenchData(), id);
}

/** 卡片的内容：状态胶囊、项目、相对时间；下一行标题。 */
function SessionCardBody({ entry }: { entry: SessionEntry }) {
  const { session, workspace } = entry;
  const status = sessionStatus(session);
  return (
    <div data-session-card={session.id}>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full bg-muted px-2 text-foreground">
          <StatusDot tone={status.tone} />
          {status.label}
        </span>
        <span className="min-w-0 truncate">{sessionPlace(workspace)}</span>
        <span className="ml-auto shrink-0 tabular-nums">
          {formatRelativeTime(session.updatedAt, Date.now())}
        </span>
      </div>
      <p className="mt-2 line-clamp-2 text-sm font-medium break-words text-foreground">
        {session.title || t('session.untitled')}
      </p>
    </div>
  );
}

/** 悬停 300 ms 弹出会话卡片的触发元素（`trigger`，一般是打开会话的 Link）。 */
export function SessionPreview({
  entry,
  trigger,
  children,
}: {
  entry: SessionEntry;
  trigger: ReactElement<Record<string, unknown>>;
  children: ReactNode;
}) {
  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger delay={OPEN_DELAY_MS} closeDelay={CLOSE_DELAY_MS} render={trigger}>
        {children}
      </PreviewCard.Trigger>
      <PreviewCard.Portal>
        <PreviewCard.Positioner side="bottom" align="start" sideOffset={6} className="isolate z-50">
          <PreviewCard.Popup className={CARD}>
            <SessionCardBody entry={entry} />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

/** 会话胶囊：`children` 省略时写会话标题。会话不在列表里时退成普通文字。 */
export function SessionLink({
  sessionId,
  children,
  className,
}: {
  sessionId: SessionId;
  children?: ReactNode;
  className?: string;
}) {
  const entry = useSessionEntry(sessionId);
  const label = children ?? (entry?.session.title || t('session.untitled'));
  if (!entry) return <span className={className}>{label}</span>;
  return (
    <SessionPreview
      entry={entry}
      trigger={
        <Link
          to={paths.session(entry.workspace.id, sessionId)}
          className={cn('session-pill outline-none focus-visible:focus-ring', className)}
          data-session-link={sessionId}
        />
      }
    >
      {label}
    </SessionPreview>
  );
}

/** 悬停中的那个 Markdown 会话链接的卡片：挂在链接元素上，只在打开时订阅工作台。 */
function AnchoredSessionCard({
  anchor,
  sessionId,
  onPointerEnter,
  onPointerLeave,
}: {
  anchor: HTMLElement;
  sessionId: SessionId;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const entry = useSessionEntry(sessionId);
  if (!entry) return null;
  return (
    <PreviewCard.Root open>
      <PreviewCard.Portal>
        <PreviewCard.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={6}
          className="isolate z-50"
        >
          <PreviewCard.Popup
            className={CARD}
            onPointerEnter={onPointerEnter}
            onPointerLeave={onPointerLeave}
          >
            <SessionCardBody entry={entry} />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

const LINK_SELECTOR = 'a[data-session-link]';

/**
 * Markdown 里的会话链接（markdown-view.tsx）：链接的会话不在列表里时标上 `data-session-missing`（样式退成普通文字），工作台变了
 * 重新标；悬停 300 ms 弹出卡片，移到卡片上不收；点击打开会话。`version` 换了（内容重新渲染）时重新标。
 */
export function MarkdownSessionLinks({
  root,
  version,
}: {
  root: RefObject<HTMLElement | null>;
  version: unknown;
}) {
  const store = useWorkbenchStore();
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const [hover, setHover] = useState<{ anchor: HTMLElement; sessionId: SessionId }>();
  const timers = useRef<{ open?: number; close?: number }>({});
  const cancelClose = () => window.clearTimeout(timers.current.close);
  const scheduleClose = () => {
    window.clearTimeout(timers.current.close);
    timers.current.close = window.setTimeout(() => setHover(undefined), CLOSE_DELAY_MS);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: 内容（version）换了要对新的 DOM 重新标。
  useEffect(() => {
    const element = root.current;
    if (!element || !store) return;
    const mark = () => {
      const links = element.querySelectorAll<HTMLElement>(LINK_SELECTOR);
      if (links.length === 0) return;
      const data = store.get();
      for (const link of links) {
        link.toggleAttribute('data-session-missing', !findSession(data, link.dataset.sessionLink));
      }
    };
    mark();
    return store.subscribe(mark);
  }, [root, store, version]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 计时器与关闭只经 ref 与 setState，事件只注册一次。
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const linkOf = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLElement>(LINK_SELECTOR) : null;
    const onOver = (event: PointerEvent) => {
      const link = linkOf(event.target);
      if (!link || link.hasAttribute('data-session-missing')) return;
      cancelClose();
      window.clearTimeout(timers.current.open);
      const sessionId = link.dataset.sessionLink as SessionId;
      timers.current.open = window.setTimeout(
        () => setHover({ anchor: link, sessionId }),
        OPEN_DELAY_MS,
      );
    };
    const onOut = (event: PointerEvent) => {
      const link = linkOf(event.target);
      if (!link || (event.relatedTarget instanceof Node && link.contains(event.relatedTarget))) {
        return;
      }
      window.clearTimeout(timers.current.open);
      scheduleClose();
    };
    const onClick = (event: MouseEvent) => {
      const link = linkOf(event.target);
      if (!link) return;
      // href 是 `#`：不能让哈希路由跳回首页。
      event.preventDefault();
      const found = store && findSession(store.get(), link.dataset.sessionLink);
      if (!found) return;
      setHover(undefined);
      void navigateRef.current(paths.session(found.workspace.id, found.session.id));
    };
    element.addEventListener('pointerover', onOver);
    element.addEventListener('pointerout', onOut);
    element.addEventListener('click', onClick);
    return () => {
      element.removeEventListener('pointerover', onOver);
      element.removeEventListener('pointerout', onOut);
      element.removeEventListener('click', onClick);
      window.clearTimeout(timers.current.open);
      window.clearTimeout(timers.current.close);
    };
  }, [root, store]);

  if (!hover?.anchor.isConnected) return null;
  return (
    <AnchoredSessionCard
      anchor={hover.anchor}
      sessionId={hover.sessionId}
      onPointerEnter={cancelClose}
      onPointerLeave={scheduleClose}
    />
  );
}
