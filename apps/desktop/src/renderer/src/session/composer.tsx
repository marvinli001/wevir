import type { PendingDelivery, SessionState } from '@wevir/protocol';
import { cn } from 'cn';
import { ArrowUp, Square } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Beam } from '@/fx/beam';
import { MetalCircle } from '@/fx/metal';
import { t } from '@/i18n';
import { DeliverySwitch } from './delivery-switch';
import { composerKeyAction, otherDelivery } from './pending-model';

/** 有回合在进行（含正在取消）：没有字时按钮是“停止”；Host 不支持待发消息时不能再发送。 */
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
 * `busyDelivery`（Host 支持待发消息）时照常可以发，Enter 与发送键按 `busyDelivery`（“回合进行中按回车”的设置），Tab 用
 * 另一种；没给时不允许再发送（旧 Host 会回 SESSION_BUSY）。`onSend` 返回 true 表示已发出，清空输入框；失败时保留文字。
 *
 * U3 起照方向稿 A 静器（维护者 2026-10-14 定）：右下角是圆形的金属按钮，有字时发送，回合进行中没有字（或不能再发）时
 * 变成停止（金属淡到 0.55），Esc 也可以停止；回合进行中按钮左边是“插话 | 排队”切换（改的就是那项 Host 设置）。回合
 * 进行中、没有在等审批时，输入框底边有一道转动的光（border-beam）。
 *
 * `variant="home"` 是首页的大输入框（U4，方向稿的 composer-big）：更高、字更大，获得焦点时底边有同样的光（focus 预设）。
 *
 * U12 起外形照 Codex 桌面端：20 px 圆角（`rounded-3xl`）、细分隔线描边；底栏左边是“插话 | 排队”与 `leading`，右边是模型
 * 与发送键；不再显示会话状态（进行中的状态与用时在消息流末尾）。`tray` 是贴在输入框上方、被它压住下沿的环境栏（新会话的
 * 项目与本地环境，session/environment-bar.tsx）。
 */
export function Composer({
  draftKey,
  state,
  disabled = false,
  disabledReason,
  leading,
  tray,
  model,
  busyDelivery,
  onBusyDeliveryChange,
  onSend,
  onStop,
  autoFocus = false,
  variant = 'session',
  placeholder,
}: {
  /** 草稿归属（会话 ID，或新会话草稿的工作区）。 */
  draftKey: string;
  state: SessionState | undefined;
  /** 不能发送也不能停止（只读、还没连上 Host、正在建会话）。 */
  disabled?: boolean;
  disabledReason?: string;
  /** 底栏左侧（“插话 | 排队”之前）：权限模式（U15）、首页没有模型服务时的“添加模型服务”。 */
  leading?: ReactNode;
  /** 输入框上方的环境栏（U12）：新会话的项目与本地环境。 */
  tray?: ReactNode;
  /** 底栏右侧、发送按钮左边：模型与思考力度（U8，session/model-picker.tsx）。 */
  model?: ReactNode;
  /** 回合进行中按发送的方式（R11）；省略表示回合进行中不能发送。 */
  busyDelivery?: PendingDelivery;
  /** 改“回合进行中按回车”（Host 设置）；给了才显示切换。 */
  onBusyDeliveryChange?: (delivery: PendingDelivery) => void;
  /** 回合进行中发出时带上方式；空闲时不带。 */
  onSend: (text: string, delivery?: PendingDelivery) => Promise<boolean>;
  onStop: () => void;
  autoFocus?: boolean;
  variant?: 'session' | 'home';
  /** 默认是“描述你要完成的任务…”；不能发送时显示 `disabledReason`。 */
  placeholder?: string;
}) {
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '');
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);
  const home = variant === 'home';
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

  /** 右下角按钮现在做什么：回合进行中、没有字或不能再发时是停止。 */
  const action: ComposerAction = !busy
    ? 'send'
    : busyDelivery === undefined || text.trim() === ''
      ? 'stop'
      : busyDelivery;

  return (
    <div>
      {tray && (
        // 环境栏比输入框各窄 12 px，下沿垫在输入框下面（-mb-4 与 pb-5），看上去是从输入框背后伸出来的一条（Codex）。
        <div
          data-testid="composer-tray"
          className="mx-3 -mb-4 flex min-w-0 items-center gap-0.5 rounded-t-2xl border border-b-0 border-border bg-card/55 px-1.5 pt-1 pb-5"
        >
          {tray}
        </div>
      )}
      <Beam
        preset={home ? 'focus' : 'composer'}
        active={home ? focused && !disabled : busy && state !== 'awaiting_approval' && !disabled}
        className="relative block w-full"
      >
        <div
          className={cn(
            'rounded-3xl border border-border bg-card shadow-xs transition-colors',
            // 首页的焦点只用光束表示（方向稿），会话里的输入框聚焦时描边加深一档。
            !home && 'focus-within:border-input',
            disabled && 'opacity-70',
          )}
        >
          <Textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            disabled={disabled}
            autoFocus={autoFocus}
            aria-label={t('session.composerPlaceholder')}
            placeholder={disabledReason ?? placeholder ?? t('session.composerPlaceholder')}
            className={cn(
              'max-h-60 resize-none rounded-none border-0 bg-transparent px-4 pb-1 shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent',
              // 原语在 md 以上是 text-sm；首页大一档（方向稿 composer-big 比会话的输入框大 1px）。
              home ? 'min-h-19 pt-4 text-base md:text-base' : 'min-h-13 pt-3.5 text-base',
            )}
          />
          <div className="flex items-center gap-1.5 px-2.5 pb-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
              {leading}
              {busy && busyDelivery !== undefined && onBusyDeliveryChange && (
                <DeliverySwitch
                  value={busyDelivery}
                  disabled={disabled}
                  onChange={onBusyDeliveryChange}
                />
              )}
            </div>
            {model}
            <ComposerButton
              action={action}
              // 金属只在“能做点什么”时流动：有字可发、或回合进行中（停止）。空着的输入框停在静帧。
              flowing={action === 'stop' ? !disabled : canSend}
              disabled={action === 'stop' ? disabled : !canSend}
              onClick={() => (action === 'stop' ? onStop() : void send())}
            />
          </div>
        </div>
      </Beam>
    </div>
  );
}

type ComposerAction = 'send' | 'stop' | PendingDelivery;

const ACTION_LABELS = {
  send: 'session.send',
  stop: 'session.stop',
  steer: 'session.sendSteer',
  queue: 'session.sendQueue',
} as const;

/**
 * 圆形的金属按钮（metal-fx 的 circle、gold）。metal-fx 把按钮的背景清成透明、内圈是它自己的底色并设好对比色，图标的颜色
 * 继承它，所以按钮不设颜色。库会抹掉子元素的 outline 与阴影（normalizeHostStyles），焦点环由外层的 focus-within 画。
 */
function ComposerButton({
  action,
  flowing,
  disabled,
  onClick,
}: {
  action: ComposerAction;
  flowing: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const label = t(ACTION_LABELS[action]);
  return (
    <span className="shrink-0 rounded-full transition-transform duration-150 ease-smooth has-focus-visible:ring-2 has-focus-visible:ring-ring/50 has-[button:active:not(:disabled)]:scale-95">
      <MetalCircle strength={action === 'stop' ? 0.55 : 1} flowing={flowing}>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={label}
                disabled={disabled}
                data-composer-action={action}
                onClick={onClick}
                className="flex size-8 items-center justify-center rounded-full outline-none disabled:opacity-40"
              />
            }
          >
            {action === 'stop' ? (
              <Square aria-hidden className="size-3 fill-current" />
            ) : (
              <ArrowUp aria-hidden className="size-4" strokeWidth={2.25} />
            )}
          </TooltipTrigger>
          <TooltipContent>
            {label}
            <kbd className="ml-1.5 font-sans opacity-70">{action === 'stop' ? 'Esc' : 'Enter'}</kbd>
          </TooltipContent>
        </Tooltip>
      </MetalCircle>
    </span>
  );
}
