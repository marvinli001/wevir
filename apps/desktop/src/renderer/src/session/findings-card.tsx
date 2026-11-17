import type { ChatPartOf } from '@wevir/client-sdk';
import type { ReviewComment, ReviewCommentId, SessionId } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronDown, MessageSquareText, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { openChanges } from '@/changes/changes-store';
import { useReviewSupported } from '@/changes/review-data';
import { Collapse } from '@/components/collapse';
import { Hint } from '@/components/hint';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { useSession } from '@/data/workbench-data';
import { openFile } from '@/files/files-store';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { usePanes } from '@/layout/pane-controller';
import { type FindingRow, findingRows, fixable } from './findings-model';
import { useTranscriptSessionId } from './fold-state';
import { MarkdownView } from './markdown/markdown-view';

/**
 * 审查发现（0.83.0，`review.findings`，desktop-tokens §67；2026-11 照 Codex 桌面端的评论卡片改样式）：报出时所在的位置一张卡片。
 * 标题行是图标、“审查发现”与条数，不止一条可修时右边“全部修复”；有总体说明时在下面。先显示前三条，其余在“再显示 N 条”里。每条
 * 一行：严重度、标题（点开看说明）、右边从左截断的位置（点了在“变更”窗格里滚到那几行，没存成批注的在文件窗格里打开）；悬停时
 * 位置换成“查看”“修复”（作为审阅意见发给会话，会话忙时排在后面）与 ×（忽略，删掉批注）。状态以 Host 现读的批注为准：发过的写
 * “已发送”，删掉的写“已忽略”。
 */
export function FindingsCard({ part }: { part: ChatPartOf<'findings'> }) {
  const sessionId = useTranscriptSessionId() as SessionId;
  const session = useSession(sessionId);
  const panes = usePanes();
  const { client } = useHostConnection();
  const supported = useReviewSupported();
  const pinned = part.findings.some((finding) => finding.commentId !== undefined);
  const workspaceId = session?.workspaceId;
  const [comments, setComments] = useState<readonly ReviewComment[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [showAll, setShowAll] = useState(false);

  const refresh = useCallback(() => {
    if (!client || !supported || !pinned || workspaceId === undefined) return;
    client
      .request('review.list', { workspaceId, sessionId })
      .then((result) => setComments(result.comments))
      .catch(() => {});
  }, [client, supported, pinned, workspaceId, sessionId]);
  useEffect(() => {
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  const rows = findingRows(part.findings, comments);
  const open = rows.filter(fixable);
  // 修复发给会话本身；子会话的发现发给它的父会话（做事的那个）。
  const target = session?.parentSessionId ?? sessionId;

  const act = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      setError(t('findings.failed', { error: describe(reason) }));
    } finally {
      setBusy(false);
      refresh();
    }
  };
  const fix = (ids: readonly ReviewCommentId[]) =>
    act(async () => {
      if (!client || workspaceId === undefined || ids.length === 0) return;
      await client.request('review.send', {
        workspaceId,
        sessionId,
        commentIds: [...ids],
        targetSessionId: target,
        delivery: 'queue',
      });
    });
  const dismiss = (id: ReviewCommentId) =>
    act(async () => {
      await client?.request('review.remove', { commentIds: [id] });
    });
  const jump = (row: FindingRow) => {
    if (row.path === undefined) return;
    if (row.state === 'text') openFile(panes, row.path, row.line);
    else openChanges(panes, sessionId, { kind: row.scope }, session?.cwd, row.path, row.line);
  };

  const shown = showAll ? rows : rows.slice(0, PREVIEW_ROWS);
  const hidden = rows.length - PREVIEW_ROWS;

  return (
    <section
      aria-label={t('findings.title')}
      data-testid="review-findings"
      className="my-3 overflow-hidden rounded-xl border border-border bg-card"
    >
      <header className="flex items-center gap-2.5 py-2 pr-2 pl-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted inset-well">
          <MessageSquareText aria-hidden className="size-3.5 text-muted-foreground" />
        </span>
        <span className="text-sm font-medium">{t('findings.title')}</span>
        <span className="text-sm text-muted-foreground tabular-nums">{part.findings.length}</span>
        {open.length > 1 && (
          <Button
            size="xs"
            variant="secondary"
            className="ml-auto"
            disabled={busy || !client}
            onClick={() =>
              void fix(
                open.flatMap((row) => (row.finding.commentId ? [row.finding.commentId] : [])),
              )
            }
            data-action="findings-fix-all"
          >
            {t('findings.fixAll')}
          </Button>
        )}
      </header>
      {part.summary !== undefined && (
        <div className="border-t border-border px-3 py-2 text-sm text-muted-foreground">
          <MarkdownView text={part.summary} streaming={false} />
        </div>
      )}
      <ul className="border-t border-border p-1">
        {rows.length === 0 && (
          <li className="px-2 py-1.5 text-sm text-muted-foreground">{t('findings.none')}</li>
        )}
        {shown.map((row, index) => (
          <FindingItem
            // biome-ignore lint/suspicious/noArrayIndexKey: 发现没有自己的 ID，顺序在事件里固定。
            key={index}
            row={row}
            busy={busy || !client}
            onJump={() => jump(row)}
            onFix={() => row.finding.commentId && void fix([row.finding.commentId])}
            onDismiss={() => row.finding.commentId && void dismiss(row.finding.commentId)}
          />
        ))}
      </ul>
      {hidden > 0 && (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
          className="flex h-9 w-full items-center gap-1 border-t border-border px-3.5 text-xs text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:focus-ring"
          data-action="findings-more"
        >
          {showAll ? t('findings.less') : t('findings.more', { count: hidden })}
          <ChevronDown
            aria-hidden
            className={cn(
              'size-3.5 transition-transform duration-200 ease-smooth',
              showAll && 'rotate-180',
            )}
          />
        </button>
      )}
      {error !== undefined && (
        <Hint label={error} whenClipped>
          <p className="truncate border-t border-border px-3 py-1.5 text-xs text-destructive">
            {error}
          </p>
        </Hint>
      )}
    </section>
  );
}

/** 收起时显示的条数（照 Codex 桌面端的评论卡片），其余在“再显示 N 条”里。 */
const PREVIEW_ROWS = 3;

/** P0 红、P1 黄的淡底；P2、P3 与没有优先级的只描边。 */
const PRIORITY_CLASS = [
  'border-transparent bg-destructive/10 text-destructive',
  'border-transparent bg-warning/15 text-warning',
  'border-border text-muted-foreground',
  'border-border text-muted-foreground',
];

const STATE_LABEL: Partial<Record<FindingRow['state'], 'findings.sent' | 'findings.dismissed'>> = {
  sent: 'findings.sent',
  dismissed: 'findings.dismissed',
};

function FindingItem({
  row,
  busy,
  onJump,
  onFix,
  onDismiss,
}: {
  row: FindingRow;
  busy: boolean;
  onJump: () => void;
  onFix: () => void;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { finding, state } = row;
  const done = state === 'sent' || state === 'dismissed';
  const label = STATE_LABEL[state];
  const actions = label === undefined && fixable(row);
  return (
    <li data-finding-state={state}>
      <div
        className={cn(
          'group/finding relative flex h-8 items-center gap-2.5 rounded-lg px-2 transition-colors duration-150 hover:bg-muted/60 focus-within:bg-muted/60',
          expanded && 'bg-muted/60',
        )}
      >
        <span
          className={cn(
            'inline-flex h-5 min-w-7 shrink-0 items-center justify-center rounded-md border px-1 font-mono text-[11px] font-medium',
            finding.priority === undefined
              ? PRIORITY_CLASS[3]
              : (PRIORITY_CLASS[finding.priority] ?? PRIORITY_CLASS[3]),
            done && 'opacity-60',
          )}
        >
          {finding.priority === undefined ? '–' : `P${finding.priority}`}
        </span>
        <Hint label={finding.title} whenClipped>
          <button
            type="button"
            aria-expanded={finding.body === '' ? undefined : expanded}
            disabled={finding.body === ''}
            onClick={() => setExpanded((value) => !value)}
            className={cn(
              'min-w-0 flex-1 truncate rounded-sm text-left text-sm outline-none focus-visible:focus-ring disabled:cursor-default',
              done && 'text-muted-foreground line-through decoration-muted-foreground/50',
            )}
          >
            {finding.title}
          </button>
        </Hint>
        {label !== undefined && (
          <span className="shrink-0 text-xs text-muted-foreground">{t(label)}</span>
        )}
        {state === 'outdated' && (
          <span className="shrink-0 text-xs text-warning">{t('comments.state.outdated')}</span>
        )}
        {row.location !== '' && (
          <Hint label={row.location} whenClipped>
            <button
              type="button"
              disabled={row.path === undefined}
              onClick={onJump}
              // 从左边截断（“…rc/index.ts:794-796”），文件名与行号总在。
              className={cn(
                'max-w-[34%] shrink-0 truncate rounded-sm text-left font-mono text-xs text-muted-foreground outline-none transition-colors duration-150 [direction:rtl] hover:text-foreground focus-visible:focus-ring disabled:hover:text-muted-foreground',
                actions && 'group-hover/finding:invisible group-focus-within/finding:invisible',
              )}
            >
              <bdi>{row.location}</bdi>
            </button>
          </Hint>
        )}
        {actions && (
          <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/finding:pointer-events-auto group-hover/finding:opacity-100 group-focus-within/finding:pointer-events-auto group-focus-within/finding:opacity-100">
            {row.path !== undefined && (
              <Button size="xs" variant="ghost" disabled={busy} onClick={onJump}>
                {t('findings.open')}
              </Button>
            )}
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={onFix}
              data-action="finding-fix"
            >
              {t('findings.fix')}
            </Button>
            <IconButton
              label={t('findings.dismiss')}
              size="icon-xs"
              disabled={busy}
              onClick={onDismiss}
            >
              <X />
            </IconButton>
          </div>
        )}
      </div>
      {finding.body !== '' && (
        <Collapse open={expanded}>
          <div className="pt-1 pr-2 pb-2.5 pl-11.5 text-sm text-soft-foreground">
            <MarkdownView text={finding.body} streaming={false} />
          </div>
        </Collapse>
      )}
    </li>
  );
}
