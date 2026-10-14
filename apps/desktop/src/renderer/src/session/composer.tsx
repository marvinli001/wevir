import type { PendingDelivery, SessionState } from '@wevir/protocol';
import { cn } from 'cn';
import { ArrowUp, CornerDownRight, ListPlus, Square } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/i18n';
import { composerKeyAction, otherDelivery } from './pending-model';

/** 有回合在进行（含正在取消）：旁边多一个“停止”；Host 不支持待发消息时不能再发送。 */
export function isBusy(state: SessionState | undefined): boolean {
  return state === 'running' || state === 'awaiting_approval' || state === 'cancelling';
}

/** 未发送的草稿按会话留在内存里，切走再切回来还在（不持久化）。 */
const drafts = new Map<string, string>();

/** 预先放一份草稿（基于历史新建会话，T5.5）：下次打开这个输入框时显示。 */
export function setDraft(draftKey: string, text: string): void {
  if (text) drafts.set(draftKey, text);
  else drafts.delete(draftKey);
}

/**
 * 输入框：Enter 发送、Shift+Enter 换行、输入法合成期间不发送（openwork-notes §3.7）。回合进行中（R11）：给了
 * `busyDelivery`（Host 支持待发消息）时照常可以发，Enter 与发送键按 `busyDelivery`（“回合进行中按回车”的设置），Tab 与
 * 旁边的小按钮用另一种；没给时不允许再发送（旧 Host 会回 SESSION_BUSY）。回合进行中多一个“停止”，Esc 也可以停止。
 * `onSend` 返回 true 表示已发出，清空输入框；失败时保留文字。
 */
export function Composer({
  draftKey,
  state,
  disabled = false,
  disabledReason,
  status,
  toolbar,
  busyDelivery,
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
  /** 回合进行中按发送的方式（R11）；省略表示回合进行中不能发送。 */
  busyDelivery?: PendingDelivery;
  /** 回合进行中发出时带上方式；空闲时不带。 */
  onSend: (text: string, delivery?: PendingDelivery) => Promise<boolean>;
  onStop: () => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const busy = isBusy(state);
  const pendingEnabled = busyDelivery !== undefined;
  const canSend = (!busy || pendingEnabled) && !disabled && !sending && text.trim() !== '';

  useEffect(() => setDraft(draftKey, text), [draftKey, text]);

  // 带着草稿打开时光标放到末尾、滚到底（基于历史新建的长草稿，接着写“接下来”）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时。
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!autoFocus || !textarea || textarea.value === '') return;
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.scrollTop = textarea.scrollHeight;
  }, []);

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

  /** 发送；回合进行中带上方式，默认按设置。 */
  const send = async (delivery = busyDelivery) => {
    if (!canSend) return;
    setSending(true);
    const sent = text.trim();
    try {
      // 等待期间可能已经输入了下一条（回合进行中接着发是常事）：只清掉发出去的那条。
      if (await onSend(sent, busy ? delivery : undefined)) {
        setText((current) => (current.trim() === sent ? '' : current));
      }
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = composerKeyAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        // 输入法合成中按的回车是选词，不发送（Safari 等合成结束时 keyCode 为 229）。
        composing: event.nativeEvent.isComposing || event.keyCode === 229,
      },
      { busy, pendingEnabled, hasText: text.trim() !== '' },
    );
    if (action === 'none') return;
    event.preventDefault();
    if (action === 'send') void send();
    else if (busyDelivery !== undefined) void send(otherDelivery(busyDelivery));
  };

  const other = busyDelivery === undefined ? undefined : otherDelivery(busyDelivery);

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
          {!busy
            ? t('session.composerHint')
            : busyDelivery === undefined
              ? t('session.stopHint')
              : t(`session.busyHint.${busyDelivery}`)}
        </span>
        {busy && (
          <Button size="sm" variant="outline" disabled={disabled} onClick={onStop}>
            <Square data-icon="inline-start" className="fill-current" />
            {t('session.stop')}
          </Button>
        )}
        {busy && busyDelivery !== undefined && other !== undefined && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canSend}
                  data-delivery={other}
                  onClick={() => void send(other)}
                />
              }
            >
              <DeliveryIcon delivery={other} />
              {t(other === 'steer' ? 'session.sendSteer' : 'session.sendQueue')}
            </TooltipTrigger>
            <TooltipContent>
              {t(other === 'steer' ? 'session.sendOtherSteer' : 'session.sendOtherQueue')}
            </TooltipContent>
          </Tooltip>
        )}
        {(!busy || busyDelivery !== undefined) && (
          <Button
            size="sm"
            disabled={!canSend}
            data-delivery={busy ? busyDelivery : undefined}
            onClick={() => void send()}
          >
            {busy && busyDelivery !== undefined ? (
              <>
                <DeliveryIcon delivery={busyDelivery} />
                {t(busyDelivery === 'steer' ? 'session.sendSteer' : 'session.sendQueue')}
              </>
            ) : (
              <>
                <ArrowUp data-icon="inline-start" />
                {t('session.send')}
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

function DeliveryIcon({ delivery }: { delivery: PendingDelivery }) {
  return delivery === 'steer' ? (
    <CornerDownRight data-icon="inline-start" />
  ) : (
    <ListPlus data-icon="inline-start" />
  );
}
