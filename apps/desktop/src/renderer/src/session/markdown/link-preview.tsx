import { PreviewCard } from '@base-ui/react/preview-card';
import {
  ArrowUpRight,
  Braces,
  Check,
  Copy,
  File,
  FileCode,
  FileText,
  Folder,
  Globe,
  Image,
  type LucideIcon,
} from 'lucide-react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { parseFileHref } from '@/files/file-path';
import { t } from '@/i18n';
import { platformApi } from '@/platform/platform';
import { fileLinkIcon, type LinkIcon } from './link-icons';

// 消息里链接的悬停卡片（照 Codex 桌面端 2026-11）：悬停 300 ms 弹出，移到卡片上不收。外链是一行网址加“打开”“复制”；引用
// 胶囊（.md-cite）是域名、标题或网址，加同样两个按钮；文件链接是完整路径与行号加“复制路径”。链接本身的点击仍由
// markdown-view.tsx 处理。

const OPEN_DELAY_MS = 300;
const CLOSE_DELAY_MS = 150;
const COPIED_MS = 1500;

const SELECTOR = 'a[data-external-link], a[data-file-link]';

const POPUP =
  'z-50 origin-(--transform-origin) rounded-xl bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden transition-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-open:duration-(--spring-reveal-duration) data-open:ease-spring-reveal data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-closed:duration-110 data-closed:ease-smooth';

const FILE_ICONS: Record<LinkIcon, LucideIcon> = {
  file: File,
  text: FileText,
  code: FileCode,
  data: Braces,
  image: Image,
  folder: Folder,
  globe: Globe,
  arrow: ArrowUpRight,
};

type Target =
  | { kind: 'external'; anchor: HTMLAnchorElement; href: string; cite: boolean; title?: string }
  | { kind: 'file'; anchor: HTMLAnchorElement; path: string; line?: number };

function targetOf(anchor: HTMLAnchorElement): Target | undefined {
  if (anchor.dataset.fileLink !== undefined) {
    const file = parseFileHref(anchor.dataset.fileLink);
    if (!file) return undefined;
    return {
      kind: 'file',
      anchor,
      path: file.path,
      ...(file.line !== undefined && { line: file.line }),
    };
  }
  const title = anchor.getAttribute('title') ?? undefined;
  return {
    kind: 'external',
    anchor,
    href: anchor.href,
    cite: anchor.classList.contains('md-cite'),
    ...(title && { title }),
  };
}

function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return href;
  }
}

/** 网址去掉协议与结尾的 `/`，卡片里读起来短一些。 */
function displayUrl(href: string): string {
  return href.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function CopyAction({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <IconButton
      label={copied ? t('markdown.copied') : label}
      size="icon-xs"
      onClick={() => {
        void platformApi()
          .copyText(value)
          .then(() => {
            setCopied(true);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
          });
      }}
      data-action="link-copy"
    >
      {copied ? <Check /> : <Copy />}
    </IconButton>
  );
}

function OpenAction({ href }: { href: string }) {
  return (
    <IconButton
      label={t('markdown.openLink')}
      size="icon-xs"
      onClick={() => void platformApi().openExternal(href)}
      data-action="link-open"
    >
      <ArrowUpRight />
    </IconButton>
  );
}

function CardBody({ target }: { target: Target }) {
  if (target.kind === 'file') {
    const Icon = FILE_ICONS[fileLinkIcon(target.path)];
    const shown = target.line === undefined ? target.path : `${target.path}:${target.line}`;
    return (
      <div className="flex max-w-xl items-center gap-2 py-1 pr-1 pl-3" data-link-card="file">
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 font-mono text-xs wrap-anywhere text-soft-foreground">
          {shown}
        </span>
        <CopyAction value={target.path} label={t('files.copyPath')} />
      </div>
    );
  }
  const host = hostOf(target.href);
  if (target.cite || target.title) {
    return (
      <div className="w-72 p-3" data-link-card="cite">
        <div className="flex items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted">
            <Globe aria-hidden className="size-3 text-muted-foreground" />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{host}</span>
          <div className="-my-1 -mr-1 flex shrink-0 items-center">
            <OpenAction href={target.href} />
            <CopyAction value={target.href} label={t('markdown.copyLink')} />
          </div>
        </div>
        <p className="mt-2 line-clamp-2 text-sm font-medium break-words">
          {target.title ?? displayUrl(target.href)}
        </p>
        {target.title && (
          <p className="mt-1 truncate text-xs text-muted-foreground">{displayUrl(target.href)}</p>
        )}
      </div>
    );
  }
  return (
    <div className="flex max-w-sm items-center gap-2 py-1 pr-1 pl-3" data-link-card="external">
      <Globe aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-xs text-soft-foreground">
        {displayUrl(target.href)}
      </span>
      <div className="flex shrink-0 items-center">
        <OpenAction href={target.href} />
        <CopyAction value={target.href} label={t('markdown.copyLink')} />
      </div>
    </div>
  );
}

/** 挂在 MarkdownView 的根元素旁边：事件委托，同一时间最多一张卡片。 */
export function MarkdownLinkPreviews({ root }: { root: RefObject<HTMLElement | null> }) {
  const [target, setTarget] = useState<Target>();
  const timers = useRef<{ open?: number; close?: number }>({});
  const cancelClose = () => window.clearTimeout(timers.current.close);
  const scheduleClose = () => {
    window.clearTimeout(timers.current.close);
    timers.current.close = window.setTimeout(() => setTarget(undefined), CLOSE_DELAY_MS);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: 计时器与关闭只经 ref 与 setState，事件只注册一次。
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const linkOf = (node: EventTarget | null) =>
      node instanceof Element ? node.closest<HTMLAnchorElement>(SELECTOR) : null;
    const onOver = (event: PointerEvent) => {
      const link = linkOf(event.target);
      if (!link || !element.contains(link)) return;
      cancelClose();
      window.clearTimeout(timers.current.open);
      timers.current.open = window.setTimeout(() => setTarget(targetOf(link)), OPEN_DELAY_MS);
    };
    const onOut = (event: PointerEvent) => {
      const link = linkOf(event.target);
      if (!link || (event.relatedTarget instanceof Node && link.contains(event.relatedTarget))) {
        return;
      }
      window.clearTimeout(timers.current.open);
      scheduleClose();
    };
    // 点了链接（打开文件或网页）就收起卡片。
    const onClick = (event: MouseEvent) => {
      if (!linkOf(event.target)) return;
      window.clearTimeout(timers.current.open);
      setTarget(undefined);
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
  }, [root]);

  if (!target?.anchor.isConnected) return null;
  return (
    <PreviewCard.Root open onOpenChange={(open) => !open && setTarget(undefined)}>
      <PreviewCard.Portal>
        <PreviewCard.Positioner
          anchor={target.anchor}
          side="bottom"
          align="start"
          sideOffset={6}
          className="isolate z-50"
        >
          <PreviewCard.Popup
            className={POPUP}
            onPointerEnter={cancelClose}
            onPointerLeave={scheduleClose}
          >
            <CardBody target={target} />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}
