import type { SessionState } from '@wevir/protocol';
import { cn } from 'cn';
import { ArrowUp, Square } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/i18n';

/** 有回合在进行（含正在取消）：不能再发送，发送键变为“停止”。 */
export function isBusy(state: SessionState | undefined): boolean {
  return state === 'running' || state === 'awaiting_approval' || state === 'cancelling';
}

/** 未发送的草稿按会话留在内存里，切走再切回来还在（不持久化）。 */
const drafts = new Map<string, string>();

/**
 * 输入框：Enter 发送、Shift+Enter 换行、输入法合成期间不发送（openwork-notes §3.7）；运行中不允许再发送
 * （Host 会回 SESSION_BUSY，ADR-0002 §4），发送键变为“停止”，Esc 也可以停止。`onSend` 返回 true 表示已
 * 发出，清空输入框；失败时保留文字。
 */
export function Composer({
  draftKey,
  state,
  disabled = false,
  disabledReason,
  status,
  toolbar,
  onSend,
  onStop,
  autoFocus = false,
}: {
  /** 草稿归属（会话 ID，或新会话草稿的工作区）。 */
  draftKey: string;
  state: SessionState | undefined;
  /** 不能发送也不能停止（只读、还没连上 Host、正在建会话）。 */
  disabled?: boolean;
  disabledReason?: string;
  /** 底栏左侧：会话状态。 */
  status?: ReactNode;
  /** 输入框上方一行：新会话的工作区与模型选择。 */
  toolbar?: ReactNode;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const busy = isBusy(state);
  const canSend = !busy && !disabled && !sending && text.trim() !== '';

  useEffect(() => {
    if (text) drafts.set(draftKey, text);
    else drafts.delete(draftKey);
  }, [draftKey, text]);

  // Esc 停止：焦点不在输入框里也算（弹层打开时让弹层先处理 Esc）。
  useEffect(() => {
    if (!busy || disabled) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      onStop();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, disabled, onStop]);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      if (await onSend(text.trim())) setText('');
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // 输入法合成中按的回车是选词，不发送（Safari 等合成结束时 keyCode 为 229）。
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void send();
  };

  return (
    <div
      className={cn(
        'rounded-xl border border-input bg-card shadow-xs transition-colors focus-within:border-ring',
        disabled && 'opacity-70',
      )}
    >
      {toolbar && <div className="flex flex-wrap items-center gap-2 px-3 pt-2.5">{toolbar}</div>}
      <Textarea
        ref={textareaRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-label={t('session.composerPlaceholder')}
        placeholder={disabledReason ?? t('session.composerPlaceholder')}
        className="max-h-60 min-h-16 resize-none border-0 bg-transparent px-3 pt-3 text-base shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
      />
      <div className="flex items-center justify-between gap-3 px-3 pb-2.5">
        <div className="min-w-0 flex-1 text-xs">{status}</div>
        <span className="hidden shrink-0 text-xs text-faint-foreground sm:inline">
          {busy ? t('session.stopHint') : t('session.composerHint')}
        </span>
        {busy ? (
          <Button size="sm" variant="outline" disabled={disabled} onClick={onStop}>
            <Square data-icon="inline-start" className="fill-current" />
            {t('session.stop')}
          </Button>
        ) : (
          <Button size="sm" disabled={!canSend} onClick={() => void send()}>
            <ArrowUp data-icon="inline-start" />
            {t('session.send')}
          </Button>
        )}
      </div>
    </div>
  );
}
