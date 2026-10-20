// “变更”窗格顶栏的“批注”（0.67.0，ADR-0009）：这个目录里还没发的批注，点一条滚到那个文件；选一个会话把全部批注作为一条消息发出。

import type { ReviewComment, Session, SessionId } from '@wevir/protocol';
import { MessageSquare, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select } from '@/components/ui/select';
import { t } from '@/i18n';
import type { ReviewState } from './review-data';
import { currentLines } from './review-model';

export function lineLabel(start: number, end: number): string {
  return start === end ? t('comments.line', { line: start }) : t('comments.lines', { start, end });
}

export function ReviewPanel({
  review,
  sessions,
  sessionId,
  onReveal,
}: {
  review: ReviewState;
  /** 同一工作区的会话（可选的发送对象），按最近活动。 */
  sessions: readonly Session[];
  sessionId: SessionId;
  onReveal: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<SessionId>(sessionId);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const { comments } = review;
  const targets = sessions.filter((session) => session.parentSessionId === undefined);
  const chosen = targets.some((session) => session.id === target) ? target : sessionId;

  const send = () => {
    if (sending || comments.length === 0) return;
    setSending(true);
    setError(undefined);
    review
      .send(
        comments.map((comment) => comment.id),
        chosen,
      )
      .then(() => setOpen(false))
      .catch((cause: unknown) => {
        setError(
          t('comments.sendFailed', {
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      })
      .finally(() => setSending(false));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 gap-1 px-2"
            aria-label={t('comments.title')}
            data-testid="review-trigger"
          />
        }
      >
        <MessageSquare className="size-3.5" />
        {comments.length > 0 && <span className="tabular-nums">{comments.length}</span>}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-2 p-2" data-review-panel>
        <p className="px-1 text-xs font-medium text-muted-foreground">{t('comments.title')}</p>
        {comments.length === 0 ? (
          <p className="px-1 py-3 text-center text-sm text-muted-foreground">
            {t('comments.empty')}
          </p>
        ) : (
          <ul className="flex max-h-72 flex-col overflow-y-auto">
            {comments.map((comment) => (
              <CommentRow
                key={comment.id}
                comment={comment}
                onReveal={() => {
                  onReveal(comment.path);
                  setOpen(false);
                }}
                onDelete={() => {
                  review.remove([comment.id]).catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  });
                }}
              />
            ))}
          </ul>
        )}
        {error !== undefined && (
          <p className="px-1 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-center gap-1.5 border-t border-border pt-2">
          <Select
            value={chosen}
            options={targets.map((session) => ({
              value: session.id,
              label:
                session.id === sessionId
                  ? t('comments.currentSession', { title: session.title || t('session.untitled') })
                  : session.title || t('session.untitled'),
            }))}
            onValueChange={(value) => setTarget(value)}
            aria-label={t('comments.target')}
            className="h-7 min-w-0 flex-1 text-xs"
            data-testid="review-target"
          />
          <Button
            size="sm"
            disabled={sending || comments.length === 0}
            onClick={send}
            data-action="review-send"
          >
            {t('comments.send')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CommentRow({
  comment,
  onReveal,
  onDelete,
}: {
  comment: ReviewComment;
  onReveal: () => void;
  onDelete: () => void;
}) {
  const lines = currentLines(comment);
  const state =
    comment.anchor.state === 'outdated'
      ? t('comments.state.outdated')
      : comment.side === 'old'
        ? t('comments.side.old')
        : comment.anchor.state === 'relocated'
          ? t('comments.state.relocated')
          : undefined;
  return (
    <li className="group/row flex min-w-0 items-start gap-1 rounded-lg hover:bg-muted/60">
      <button
        type="button"
        onClick={onReveal}
        className="flex min-w-0 flex-1 flex-col gap-0.5 px-1.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        data-review-comment={comment.id}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs">
          <span dir="rtl" className="min-w-0 truncate text-left font-mono">
            <bdi dir="ltr">{comment.path}</bdi>
          </span>
          <span className="shrink-0 text-muted-foreground">
            {lineLabel(lines.start, lines.end)}
          </span>
          {state !== undefined && (
            <span
              className={
                comment.anchor.state === 'outdated'
                  ? 'shrink-0 text-warning'
                  : 'shrink-0 text-muted-foreground'
              }
            >
              · {state}
            </span>
          )}
        </span>
        <span className="line-clamp-2 text-sm">{comment.body}</span>
      </button>
      <span className="pt-1 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
        <IconButton label={t('comments.delete')} size="icon-xs" onClick={onDelete}>
          <Trash2 />
        </IconButton>
      </span>
    </li>
  );
}
