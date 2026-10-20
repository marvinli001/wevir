// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/web/src/components/diffs/DiffCommentAnnotation.tsx、commentSubmitShortcut.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：文案走 Wevir 的 i18n；去掉 secondaryAction 与外部受控的草稿；保存中禁用按钮；已存的批注加位置状态（已移动、已过期）的
// 角标；外形是 Wevir 的卡片（行号、状态、正文），组件与颜色换成 Wevir 的。
//
// diff 里的一条批注（0.67.0）：草稿是一张卡片，输入框加取消 / 保存（⌘/Ctrl+Enter 保存、Esc 取消）；保存后是同样的卡片，
// 顶上一行是行号与状态，悬停时出删除。

import { cn } from 'cn';
import { MessageSquare, Trash2 } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';
import { IS_MAC } from '@/lib/shortcuts';

/** ⌘/Ctrl+Enter 提交（T3 isCommentSubmitShortcut）。 */
export function isCommentSubmitShortcut(
  event: { key: string; metaKey: boolean; ctrlKey: boolean },
  value: string,
  pending: boolean,
): boolean {
  return (
    !pending && (event.metaKey || event.ctrlKey) && event.key === 'Enter' && value.trim().length > 0
  );
}

/** 批注卡片的外框：diff 行下面缩进一点、圆角描边、表面色底。 */
function CommentCard({
  children,
  className,
  ...props
}: { children: ReactNode; className?: string } & Record<`data-${string}`, boolean>) {
  return (
    <div
      className="px-3 py-1.5 font-sans text-foreground"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        className={cn('max-w-2xl rounded-xl border border-border bg-card shadow-xs', className)}
        {...props}
      >
        {children}
      </div>
    </div>
  );
}

function CardHead({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="flex h-7 min-w-0 items-center gap-1.5 pr-1 pl-2.5 text-xs text-muted-foreground">
      <MessageSquare aria-hidden className="size-3.5 shrink-0" />
      <span className="shrink-0 tabular-nums">{label}</span>
      {children}
    </div>
  );
}

export function DiffCommentDraft({
  rangeLabel,
  onCancel,
  onSave,
}: {
  rangeLabel: string;
  onCancel: () => void;
  onSave: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const trimmed = text.trim();

  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const save = () => {
    if (pending || trimmed === '') return;
    setPending(true);
    setError(undefined);
    onSave(trimmed)
      .catch((cause: unknown) => {
        setError(
          t('comments.saveFailed', {
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
      })
      .finally(() => setPending(false));
  };

  return (
    <CommentCard data-diff-comment-draft>
      <CardHead label={rangeLabel} />
      <Textarea
        ref={ref}
        value={text}
        aria-label={t('comments.inputLabel', { range: rangeLabel })}
        className="min-h-12 resize-none rounded-none border-0 bg-transparent px-2.5 py-0.5 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
          if (isCommentSubmitShortcut(event, trimmed, pending)) {
            event.preventDefault();
            save();
          }
        }}
      />
      <div className="flex items-center gap-1 px-2 pb-2">
        {error !== undefined ? (
          <span className="mr-auto truncate text-xs text-destructive" role="alert">
            {error}
          </span>
        ) : (
          <kbd className="mr-auto pl-0.5 font-sans text-[11px] text-muted-foreground">
            {IS_MAC ? '⌘↩' : 'Ctrl+↩'}
          </kbd>
        )}
        <Button variant="ghost" size="xs" className="rounded-full" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          size="xs"
          className="rounded-full px-2.5"
          disabled={pending || trimmed === ''}
          onClick={save}
          data-action="review-save"
        >
          {t('comments.save')}
        </Button>
      </div>
    </CommentCard>
  );
}

export function DiffCommentNote({
  text,
  rangeLabel,
  stateLabel,
  outdated,
  onDelete,
}: {
  text: string;
  rangeLabel: string;
  /** 位置状态（改动前、已移动），没有时不写。 */
  stateLabel: string | undefined;
  outdated?: boolean;
  onDelete: () => void;
}) {
  return (
    <CommentCard data-diff-comment className="group/comment">
      <CardHead label={rangeLabel}>
        {stateLabel !== undefined && (
          <span className={cn('shrink-0', outdated === true && 'text-warning')}>
            · {stateLabel}
          </span>
        )}
        <span className="ml-auto flex shrink-0 opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100">
          <IconButton label={t('comments.delete')} size="icon-xs" onClick={onDelete}>
            <Trash2 />
          </IconButton>
        </span>
      </CardHead>
      <p className="min-w-0 px-2.5 pb-2.5 text-sm leading-5 whitespace-pre-wrap">{text}</p>
    </CommentCard>
  );
}
