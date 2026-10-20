// “变更”窗格顶栏的“批注”（0.67.0，ADR-0009）：这个目录里还没发的批注按文件分组，点一条滚到那个文件；选一个会话把全部批注
// 作为一条消息发出。

import type { ReviewComment, Session, SessionId } from '@wevir/protocol';
import { cn } from 'cn';
import { MessageSquare, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { ScrollFade } from '@/components/scroll-fade';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select } from '@/components/ui/select';
import { t } from '@/i18n';
import { fileIcon } from '@/layout/panes/files-pane';
import { splitPath } from './changes-model';
import type { ReviewState } from './review-data';
import { currentLines } from './review-model';

export function lineLabel(start: number, end: number): string {
  return start === end ? t('comments.line', { line: start }) : t('comments.lines', { start, end });
}

/** 批注的位置状态（改动前一侧、已移动、已过期），没有特别的状态时不写。 */
export function commentState(comment: ReviewComment): string | undefined {
  if (comment.anchor.state === 'outdated') return t('comments.state.outdated');
  if (comment.side === 'old') return t('comments.side.old');
  if (comment.anchor.state === 'relocated') return t('comments.state.relocated');
  return undefined;
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
  const byFile = useMemo(() => {
    const groups = new Map<string, ReviewComment[]>();
    for (const comment of comments) {
      groups.set(comment.path, [...(groups.get(comment.path) ?? []), comment]);
    }
    return [...groups];
  }, [comments]);

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

  const count = comments.length;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'shrink-0 gap-1 rounded-full px-2.5 font-normal shadow-xs',
              count > 0
                ? 'border-foreground/15 bg-accent text-foreground'
                : 'text-muted-foreground',
            )}
            aria-label={t('comments.title')}
            data-testid="review-trigger"
          />
        }
      >
        <MessageSquare className="size-3.5" />
        {count > 0 && <span className="tabular-nums">{count}</span>}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-0 overflow-hidden p-0" data-review-panel>
        <div className="flex h-10 items-center gap-1.5 border-b border-border px-3">
          <span className="text-sm font-medium">{t('comments.title')}</span>
          {count > 0 && <span className="text-xs text-muted-foreground tabular-nums">{count}</span>}
        </div>
        {count === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
            <MessageSquare aria-hidden className="size-5 stroke-[1.5] text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('comments.empty')}</p>
          </div>
        ) : (
          <ScrollFade className="max-h-80 overflow-y-auto p-1.5 [--scroll-fade-size:16px]">
            {byFile.map(([path, list]) => (
              <FileComments
                key={path}
                path={path}
                comments={list}
                onReveal={() => {
                  onReveal(path);
                  setOpen(false);
                }}
                onDelete={(comment) => {
                  review.remove([comment.id]).catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  });
                }}
              />
            ))}
          </ScrollFade>
        )}
        {error !== undefined && (
          <p className="px-3 pb-1.5 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-center gap-1.5 border-t border-border bg-muted/30 p-2">
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
            className="h-7 min-w-0 flex-1 rounded-full text-xs"
            data-testid="review-target"
          />
          <Button
            size="sm"
            className="rounded-full px-3"
            disabled={sending || count === 0}
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

function FileComments({
  path,
  comments,
  onReveal,
  onDelete,
}: {
  path: string;
  comments: readonly ReviewComment[];
  onReveal: () => void;
  onDelete: (comment: ReviewComment) => void;
}) {
  const { name, dir } = splitPath(path);
  const Icon = fileIcon(path);
  return (
    <div className="flex flex-col pb-1">
      <button
        type="button"
        onClick={onReveal}
        title={path}
        className="flex h-7 min-w-0 items-center gap-1.5 rounded-lg px-1.5 text-left text-xs outline-none hover:bg-muted/60 focus-visible:focus-ring"
      >
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium text-foreground">{name}</span>
        {dir !== '' && (
          <span dir="rtl" className="min-w-0 truncate text-left text-muted-foreground">
            <bdi dir="ltr">{dir}</bdi>
          </span>
        )}
      </button>
      <ul className="flex flex-col">
        {comments.map((comment) => (
          <CommentRow
            key={comment.id}
            comment={comment}
            onReveal={onReveal}
            onDelete={() => onDelete(comment)}
          />
        ))}
      </ul>
    </div>
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
  const state = commentState(comment);
  return (
    <li className="group/row ml-3.5 flex min-w-0 items-start gap-1 rounded-lg border-s border-border hover:bg-muted/60">
      <button
        type="button"
        onClick={onReveal}
        className="flex min-w-0 flex-1 flex-col gap-0.5 py-1.5 pr-1 pl-2.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring-soft focus-visible:ring-inset"
        data-review-comment={comment.id}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="shrink-0 tabular-nums">{lineLabel(lines.start, lines.end)}</span>
          {state !== undefined && (
            <span className={cn('shrink-0', comment.anchor.state === 'outdated' && 'text-warning')}>
              · {state}
            </span>
          )}
        </span>
        <span className="line-clamp-2 text-sm leading-5">{comment.body}</span>
      </button>
      <span className="pt-1 pr-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
        <IconButton label={t('comments.delete')} size="icon-xs" onClick={onDelete}>
          <Trash2 />
        </IconButton>
      </span>
    </li>
  );
}
