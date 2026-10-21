import type { ChatPartOf } from '@wevir/client-sdk';
import type { ReviewComment, ReviewCommentId, SessionId } from '@wevir/protocol';
import { cn } from 'cn';
import { ScanSearch, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { openChanges } from '@/changes/changes-store';
import { useReviewSupported } from '@/changes/review-data';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { openFile } from '@/files/files-store';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { usePanes } from '@/layout/pane-controller';
import { type FindingRow, findingRows, fixable } from './findings-model';
import { useTranscriptSessionId } from './fold-state';
import { MarkdownView } from './markdown/markdown-view';
import { useSessions } from './suggested-tasks';

/**
 * 审查发现（0.83.0，`review.findings`，desktop-tokens §67）：报出时所在的位置一张卡片。标题行是“审查发现 · N”，不止一条可修时
 * 右边“全部修复”；有总体说明时在下面。每条一行：严重度、标题（点开看说明）、位置（点了在“变更”窗格里滚到那几行，没存成批注
 * 的在文件窗格里打开），右边“修复”把它作为审阅意见发给会话（会话忙时排在后面）、× 忽略（删掉批注）。状态以 Host 现读的批注
 * 为准：发过的写“已发送”，删掉的写“已忽略”。
 */
export function FindingsCard({ part }: { part: ChatPartOf<'findings'> }) {
  const sessionId = useTranscriptSessionId() as SessionId;
  const session = useSessions().get(sessionId);
  const panes = usePanes();
  const { client } = useHostConnection();
  const supported = useReviewSupported();
  const pinned = part.findings.some((finding) => finding.commentId !== undefined);
  const workspaceId = session?.workspaceId;
  const [comments, setComments] = useState<readonly ReviewComment[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

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
    else openChanges(panes, sessionId, { kind: row.scope }, row.path, row.line);
  };

  return (
    <section
      aria-label={t('findings.title')}
      data-testid="review-findings"
      className="my-3 rounded-xl border border-border bg-background"
    >
      <header className="flex h-9 items-center gap-1.5 px-3 text-xs text-muted-foreground">
        <ScanSearch aria-hidden className="size-3.5 shrink-0" />
        <span className="font-medium">{t('findings.title')}</span>
        <span aria-hidden>·</span>
        <span className="tabular-nums">{part.findings.length}</span>
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
      <ul className="divide-y divide-border border-t border-border">
        {rows.length === 0 && (
          <li className="px-3 py-2 text-sm text-muted-foreground">{t('findings.none')}</li>
        )}
        {rows.map((row, index) => (
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
      {error !== undefined && (
        <p
          className="truncate border-t border-border px-3 py-1.5 text-xs text-destructive"
          title={error}
        >
          {error}
        </p>
      )}
    </section>
  );
}

const PRIORITY_CLASS = [
  'bg-destructive/10 text-destructive',
  'bg-warning/15 text-warning',
  'bg-muted text-muted-foreground',
  'bg-muted text-muted-foreground',
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
  return (
    <li className="group/finding flex items-start gap-2 px-3 py-2" data-finding-state={state}>
      <span
        className={cn(
          'mt-0.5 inline-flex h-4.5 min-w-6 shrink-0 items-center justify-center rounded px-1 font-mono text-[11px] font-medium',
          finding.priority === undefined
            ? 'bg-muted text-muted-foreground'
            : PRIORITY_CLASS[finding.priority],
          done && 'opacity-60',
        )}
      >
        {finding.priority === undefined ? '–' : `P${finding.priority}`}
      </span>
      <div className={cn('min-w-0 flex-1', done && 'text-muted-foreground')}>
        <button
          type="button"
          aria-expanded={finding.body === '' ? undefined : expanded}
          disabled={finding.body === ''}
          onClick={() => setExpanded((value) => !value)}
          className="block max-w-full rounded-sm text-left text-sm font-medium outline-none focus-visible:focus-ring disabled:cursor-default"
        >
          {finding.title}
        </button>
        {row.location !== '' && (
          <button
            type="button"
            disabled={row.path === undefined}
            onClick={onJump}
            title={row.location}
            className="block max-w-full truncate rounded-sm font-mono text-xs text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:focus-ring disabled:hover:text-muted-foreground"
          >
            {row.location}
            {state === 'outdated' && (
              <span className="ml-1.5 font-sans text-warning">{t('comments.state.outdated')}</span>
            )}
          </button>
        )}
        {finding.body !== '' &&
          (expanded ? (
            <div className="mt-1 text-sm">
              <MarkdownView text={finding.body} streaming={false} />
            </div>
          ) : (
            <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{finding.body}</p>
          ))}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {label !== undefined ? (
          <span className="text-xs text-muted-foreground">{t(label)}</span>
        ) : (
          fixable(row) && (
            <>
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
            </>
          )
        )}
      </div>
    </li>
  );
}
