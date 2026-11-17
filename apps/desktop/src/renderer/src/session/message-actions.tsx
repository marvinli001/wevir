// 消息操作由会话视图按 Host 和当前引擎的能力提供。

import type { UserChatMessage } from '@wevir/client-sdk';
import type {
  ProviderProfile,
  SessionAutoContinue,
  TurnId,
  UserContentPart,
} from '@wevir/protocol';
import { cn } from 'cn';
import { Pencil, Split, Undo2 } from 'lucide-react';
import {
  createContext,
  type KeyboardEvent,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { composerPrefs } from './composer-prefs';
import { EditContent } from './edit-content';
import type { ModelChoice } from './model-picker';

export interface MessageActions {
  authorizeDenied?: (reviewId: string) => Promise<void>;
  routing?: { enabled: boolean };
  retry?: {
    lastTurnId?: TurnId;
    run(turnId: TurnId): Promise<void>;
  };
  /** 从这个回合分支到新会话；会话不能分支时没有。 */
  branch?: (turnId: TurnId) => void;
  /** 最后一个可编辑回合。支持历史编辑时，同一引擎段内更早的消息也可编辑。 */
  editTurnId?: TurnId;
  editFromSeq?: number;
  /** 撤回那个回合、发出改过的消息；成功时 `true`（失败的提示由会话视图显示）。 */
  submitEdit?: (
    message: UserChatMessage,
    content: UserContentPart[],
    latest: TurnId,
  ) => Promise<boolean>;
  /**
   * 插话的“回退”：撤回插话所在的回合（`session.rewind`，引擎只能整回合撤回），回合开头的消息与插话放回输入框。会话能撤回时就有；
   * `turnId` 同 `editTurnId`，`runningTurnId` 是进行中的回合（它的插话按钮置灰）。失败的提示由会话视图显示。
   */
  rewind?: {
    turnId?: TurnId;
    runningTurnId?: TurnId;
    run(turnId: TurnId): Promise<void>;
  };
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
   * 换模型继续（0.143.0，Host 功能 `usage_limit_switch`）：`lastTurnId` 同 `autoContinue`；`providers` 是输入框模型菜单的数据，
   * `value` 是碰到上限的那个回合用的模型（之后在输入框换过来源时不是会话现在的），`switchable` 判断能不能换到这个来源（同一来源要 Host 能换模型，别的来源要能接力），`run` 换模型并继续（失败的提示由会话
   * 视图显示）。Host 不支持、会话不可写或是子会话时没有。
   */
  switchModel?: {
    lastTurnId?: TurnId;
    providers: readonly ProviderProfile[];
    value: ModelChoice;
    switchable(provider: ProviderProfile): boolean;
    run(turnId: TurnId, next: ModelChoice): Promise<void>;
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
 * 插话下面的“回退”：只在会话最后一个回合的插话上出现，回合进行中（还没插进去的插话也是）置灰，提示写明原因。`turnId` 省略表示
 * 还没插进回合的插话。
 */
export function RewindButton({ turnId, className }: { turnId?: TurnId; className?: string }) {
  const { rewind } = useMessageActions();
  if (rewind === undefined) return null;
  const enabled = turnId !== undefined && rewind.turnId === turnId;
  const running =
    turnId === undefined ? rewind.runningTurnId !== undefined : rewind.runningTurnId === turnId;
  if (!enabled && !running) return null;
  // 置灰用 aria-disabled 而不是 disabled：禁用的按钮收不到指针事件，提示出不来。
  return (
    <IconButton
      label={enabled ? t('message.rewind') : t('message.rewindBusy')}
      size="icon-xs"
      className={cn(className, !enabled && 'cursor-default opacity-50 hover:bg-transparent')}
      aria-disabled={!enabled || undefined}
      onClick={enabled && turnId !== undefined ? () => void rewind.run(turnId) : undefined}
      data-action="rewind-message"
    >
      <Undo2 />
    </IconButton>
  );
}

/**
 * 编辑中的用户消息：气泡换成输入框，Esc 取消，发送键（设置 → 常规，同输入框）发出。发出时撤回这个回合、把改过的文字连同原来的
 * 图片发出；没有改动时同样重发。
 */
export function UserMessageEditor({
  message,
  original,
  editable,
  onDone,
}: {
  message: UserChatMessage;
  original: readonly UserContentPart[];
  editable: boolean;
  onDone(): void;
}) {
  const { submitEdit, editTurnId } = useMessageActions();
  const appendText = !original.some((part) => part.type === 'text' && !part.pasted);
  const [content, setContent] = useState<UserContentPart[]>(() =>
    appendText ? [...original, { type: 'text', text: '' }] : [...original],
  );
  const [sending, setSending] = useState(false);
  const [confirmLatest, setConfirmLatest] = useState<TurnId>();
  const ref = useRef<HTMLTextAreaElement>(null);
  const canSend =
    editable &&
    !sending &&
    submitEdit !== undefined &&
    content.some((part) => part.type !== 'text' || part.text.trim() !== '');

  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);
  const send = async (latest: TurnId) => {
    if (!canSend) return;
    setSending(true);
    const tail = content.at(-1);
    const edited =
      appendText && tail?.type === 'text' && tail.text === '' ? content.slice(0, -1) : content;
    const ok = await submitEdit(message, edited, latest);
    setSending(false);
    if (ok) onDone();
  };
  const requestSend = () => {
    if (!editTurnId || !canSend) return;
    if (editTurnId === message.turnId) void send(editTurnId);
    else setConfirmLatest(editTurnId);
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
    requestSend();
  };

  return (
    <div className="w-full max-w-[85%] rounded-xl border border-border bg-card p-2" data-editing>
      <EditContent
        content={content}
        editor={{
          first: ref,
          disabled: sending,
          keyDown: onKeyDown,
          change: (index, text) =>
            setContent((current) =>
              current.map((part, i) => (i === index ? { type: 'text', text } : part)),
            ),
        }}
      />
      <div className="mt-1 flex justify-end gap-1.5">
        <Button variant="ghost" size="xs" onClick={onDone} disabled={sending}>
          {t('message.editCancel')}
        </Button>
        <Button size="xs" onClick={requestSend} disabled={!canSend}>
          {t('message.editSend')}
        </Button>
      </div>
      {confirmLatest !== undefined && (
        <ConfirmDialog
          open
          title={t('message.editHistoryTitle')}
          confirmLabel={t('message.editHistoryConfirm')}
          onOpenChange={(open) => !open && setConfirmLatest(undefined)}
          onConfirm={async () => {
            if (!canSend || editTurnId !== confirmLatest) throw new Error(t('message.editChanged'));
            await send(confirmLatest);
          }}
          failure={(error) => t('message.editFailed', { error })}
        >
          {t('message.editHistoryImpact')}
        </ConfirmDialog>
      )}
    </div>
  );
}
