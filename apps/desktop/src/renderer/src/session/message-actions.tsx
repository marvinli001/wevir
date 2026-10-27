// 消息下方的操作（0.38.0，照 Codex 桌面端与 T3 Code 的 MessagesTimeline）：回答的“分支到新会话”，最后一条用户消息的“编辑”
// （撤回最后一个回合，改过的消息照常发出）。会话视图按 Host 与会话当前引擎的能力提供，子智能体详情与支线窗格里没有。

import type { UserChatMessage } from '@wevir/client-sdk';
import type { SessionAutoContinue, TurnId } from '@wevir/protocol';
import { cn } from 'cn';
import { Pencil, Split } from 'lucide-react';
import {
  createContext,
  type KeyboardEvent,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { composerPrefs } from './composer-prefs';

export interface MessageActions {
  /** 从这个回合分支到新会话；会话不能分支时没有。 */
  branch?: (turnId: TurnId) => void;
  /** 能编辑的用户消息所在的回合：会话最后一个完成的回合，会话空闲、能撤回时才有。 */
  editTurnId?: TurnId;
  /** 撤回那个回合、发出改过的消息；成功时 `true`（失败的提示由会话视图显示）。 */
  submitEdit?: (message: UserChatMessage, text: string) => Promise<boolean>;
  /**
   * 额度恢复后自动继续（0.119.0，Host 功能 `usage_auto_continue`）：`lastTurnId` 是会话空闲时的最后一个回合（只有它的额度卡片能勾），
   * `armed` 是排着的自动继续，`set` 打开或关掉（失败的提示由会话视图显示）。Host 不支持、会话不可写时没有。
   */
  autoContinue?: {
    lastTurnId?: TurnId;
    armed?: SessionAutoContinue;
    set(turnId: TurnId, enabled: boolean): Promise<void>;
  };
  /**
   * 回合末的下一步卡片（0.128.0）：`lastTurnId` 是会话空闲时的最后一个回合（只有它的卡片能点），`send` 以用户身份发出按钮的消息，
   * 成功时 `true`（失败的提示由会话视图显示）。会话不可写时没有。
   */
  wrapUp?: {
    lastTurnId?: TurnId;
    send(message: string): Promise<boolean>;
  };
}

const NO_ACTIONS: MessageActions = {};

export const MessageActionsContext = createContext<MessageActions>(NO_ACTIONS);

export function useMessageActions(): MessageActions {
  return useContext(MessageActionsContext);
}

/** 回答下面的“分支到新会话”。 */
export function BranchButton({ turnId, className }: { turnId: TurnId; className?: string }) {
  const { branch } = useMessageActions();
  if (branch === undefined) return null;
  return (
    <IconButton
      label={t('message.branch')}
      size="icon-xs"
      className={className}
      onClick={() => branch(turnId)}
      data-action="branch-message"
    >
      <Split />
    </IconButton>
  );
}

/** 用户消息下面的“编辑”。 */
export function EditButton({ onClick, className }: { onClick(): void; className?: string }) {
  return (
    <IconButton
      label={t('message.edit')}
      size="icon-xs"
      className={className}
      onClick={onClick}
      data-action="edit-message"
    >
      <Pencil />
    </IconButton>
  );
}

/**
 * 编辑中的用户消息：气泡换成输入框，Esc 取消，发送键（设置 → 常规，同输入框）发出。发出时撤回这个回合、把改过的文字连同原来的
 * 图片发出；没有改动时同样重发。
 */
export function UserMessageEditor({
  message,
  initialText,
  onDone,
}: {
  message: UserChatMessage;
  initialText: string;
  onDone(): void;
}) {
  const { submitEdit } = useMessageActions();
  const [text, setText] = useState(initialText);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const hasImages = message.parts.some((part) => part.type === 'image');
  const canSend = !sending && submitEdit !== undefined && (text.trim() !== '' || hasImages);

  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);
  // 高度随内容（最多约 12 行，之后滚动）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 文字变了重新量。
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [text]);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    const ok = await submitEdit(message, text.trim());
    setSending(false);
    if (ok) onDone();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onDone();
      return;
    }
    if (event.key !== 'Enter') return;
    const mod = event.metaKey || event.ctrlKey;
    const sendKey = composerPrefs.get().sendShortcut === 'enter' ? !event.shiftKey && !mod : mod;
    if (!sendKey) return;
    event.preventDefault();
    void send();
  };

  return (
    <div className="w-full max-w-[85%] rounded-xl border border-border bg-card p-2" data-editing>
      <textarea
        ref={ref}
        value={text}
        aria-label={t('message.edit')}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        className={cn(
          'block max-h-72 w-full resize-none bg-transparent px-1.5 py-1 text-base break-words outline-none',
          'placeholder:text-muted-foreground',
        )}
      />
      <div className="mt-1 flex justify-end gap-1.5">
        <Button variant="ghost" size="xs" onClick={onDone} disabled={sending}>
          {t('message.editCancel')}
        </Button>
        <Button size="xs" onClick={() => void send()} disabled={!canSend}>
          {t('message.editSend')}
        </Button>
      </div>
    </div>
  );
}
