// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/web/src/components/diffs/DiffCommentAnnotation.tsx、commentSubmitShortcut.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：文案走 Wevir 的 i18n；去掉 secondaryAction 与外部受控的草稿；保存中禁用按钮；已存的批注加位置状态（已移动、已过期）的
// 角标；组件与颜色换成 Wevir 的。
//
// diff 里的一条批注（0.67.0）：草稿是输入框加取消 / 保存（⌘/Ctrl+Enter 保存、Esc 取消）；保存后是一行正文，悬停时出删除。

import { cn } from 'cn';
import { MessageSquare, Trash2 } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';

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
    <div
      data-diff-comment-draft
      className="px-3 py-2 font-sans text-foreground"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Textarea
        ref={ref}
        value={text}
        aria-label={t('comments.inputLabel', { range: rangeLabel })}
        className="min-h-14 text-sm"
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
      <div className="mt-1.5 flex items-center gap-1">
        {error !== undefined && (
          <span className="mr-auto truncate text-xs text-destructive" role="alert">
            {error}
          </span>
        )}
        <Button variant="ghost" size="xs" className="ml-auto" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          size="xs"
          disabled={pending || trimmed === ''}
          onClick={save}
          data-action="review-save"
        >
          {t('comments.save')}
        </Button>
      </div>
    </div>
  );
}

export function DiffCommentNote({
  text,
  state,
  onDelete,
}: {
  text: string;
  /** `relocated`：原文挪了位置，画在新位置。 */
  state: 'current' | 'relocated' | 'outdated';
  onDelete: () => void;
}) {
  return (
    <div
      data-diff-comment
      className="group/comment flex min-w-0 items-start gap-2.5 border-s-2 border-primary/55 bg-primary/[0.045] px-3 py-2 font-sans text-foreground"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <MessageSquare aria-hidden className="mt-0.5 size-3.5 shrink-0 text-primary/70" />
      <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-5">{text}</p>
      {state === 'relocated' && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {t('comments.state.relocated')}
        </span>
      )}
      <span
        className={cn(
          '-my-1 -mr-1 flex shrink-0 opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100',
        )}
      >
        <IconButton label={t('comments.delete')} size="icon-xs" onClick={onDelete}>
          <Trash2 />
        </IconButton>
      </span>
    </div>
  );
}
