import type { WevirClient } from '@wevir/client-sdk';
import { hostSupports } from '@wevir/client-sdk';
import { type Channel, type ChannelPost, MESSAGE_TEXT_MAX_LENGTH } from '@wevir/protocol';
import { cn } from 'cn';
import { Reply, X } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { IconButton } from '@/components/icon-button';
import { Textarea } from '@/components/ui/textarea';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { getShortcut, matchesShortcut } from '@/lib/shortcuts';
import { paths } from '@/routes/paths';
import { ComposerButton } from '@/session/composer-button';
import { draftIssue, finishComposerSend, hasDraft, textLength } from '@/session/composer-drafts';
import { messageContent } from '@/session/composer-images';
import { useComposerInput } from '@/session/composer-input';
import { uploadDraft } from '@/session/composer-media';
import { withDraftPastes } from '@/session/composer-pastes';
import { ComposerPlusMenu } from '@/session/composer-plus-menu';
import { composerPrefs } from '@/session/composer-prefs';
import { mentionText } from '@/session/composer-trigger';
import { DictationBar, DictationButton } from '@/session/dictation-button';
import { insertDictation } from '@/session/dictation-model';
import { composerKeyAction } from '@/session/pending-model';
import { useDictation } from '@/session/use-dictation';
import { AssistantAvatar } from './assistant-avatar';
import {
  composerAction,
  composerSupported,
  mentionedIn,
  mentionQuery,
  postFirstLine,
} from './assistants-model';

export function AssistantComposer({
  client,
  channel,
  members,
  reply,
  onCancelReply,
  onPosted,
  onError,
}: {
  client: WevirClient;
  channel: Channel;
  /** 群的成员（打 @ 时可选）；助理的时间线是空的。 */
  members: readonly Channel[];
  reply: ChannelPost | undefined;
  onCancelReply: () => void;
  onPosted: (post: ChannelPost) => void;
  onError: (text: string) => void;
}) {
  const { view } = useHostConnection();
  const features = view.status === 'connected' ? view.hello.features : undefined;
  const supported = composerSupported(features);
  /** 帖子能带图片：Host 收下帖子里的图片（0.135.0）。协调者的模型看不了时 Host 换成说明，这里不再按模型挡。 */
  const imagesEnabled =
    supported && features !== undefined && hostSupports(features, 'user_images');
  const [busy, setBusy] = useState(false);
  const sendInFlight = useRef(false);
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState(0);
  const [stopping, setStopping] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const draftKey = `channel/${channel.id}`;
  const pathsRef = useRef<(paths: readonly string[]) => void>(() => {});
  const input = useComposerInput(
    draftKey,
    client,
    imagesEnabled,
    !supported,
    (paths) => pathsRef.current(paths),
    () => inputRef.current?.focus(),
  );
  const { draft, setText, onHistoryKey, dragging, onDrop, onDragOver, onDragLeave, onPaste } =
    input;
  const text = draft.text;
  const query = members.length > 0 ? mentionQuery(text, caret) : undefined;
  const choices =
    query === undefined
      ? []
      : members.filter((member) =>
          member.title.toLowerCase().startsWith(query.query.toLowerCase()),
        );
  const group = channel.kind === 'group';
  const hasContent = hasDraft(draft);
  const action = composerAction({ channel, supported, hasContent });
  useEffect(() => {
    if (reply !== undefined) inputRef.current?.focus();
  }, [reply]);

  const send = async () => {
    const body = text.trim();
    if (
      !supported ||
      !hasContent ||
      sendInFlight.current ||
      input.adding ||
      input.failedAttachment ||
      draftIssue(draft)
    )
      return;
    sendInFlight.current = true;
    setBusy(true);
    try {
      const mentions = mentionedIn(body, members);
      const parts = await uploadDraft(client, draft.attachments);
      const { post } = await client.request('channel.post', {
        channelId: channel.id,
        content: messageContent(withDraftPastes(draft.pastes, body), parts),
        clientPostId: crypto.randomUUID(),
        ...(reply !== undefined && { replyTo: reply.id }),
        ...(mentions.length > 0 && { mentions }),
      });
      await finishComposerSend(draftKey, draft);
      input.setError(undefined);
      input.resetHistory();
      onPosted(post);
      onCancelReply();
    } catch (reason) {
      onError(t('assistants.postFailed', { error: describe(reason) }));
    } finally {
      sendInFlight.current = false;
      setBusy(false);
    }
  };

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await client.request('channel.stop', { channelId: channel.id });
    } catch (reason) {
      onError(t('assistants.actionFailed', { error: describe(reason) }));
    } finally {
      setStopping(false);
    }
  };

  // ── 图片与文件 ──────────────────────────────────────────────────────

  /** 在光标处插入（前面不是空白时先补一个空格）。 */
  const insertAtCaret = (snippet: string) => {
    const at = Math.min(caret, text.length);
    const before = text.slice(0, at);
    const glue = before !== '' && !/\s$/.test(before) ? ' ' : '';
    const next = `${before}${glue}${snippet}${text.slice(at)}`;
    const cursor = at + glue.length + snippet.length;
    setText(next);
    setCaret(cursor);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(cursor, cursor);
    });
  };

  const insertPaths = (chosen: readonly string[]) =>
    insertAtCaret(`${chosen.map(mentionText).join(' ')} `);

  pathsRef.current = insertPaths;

  // ── 听写 ────────────────────────────────────────────────────────────
  const navigate = useNavigate();
  const dictation = useDictation({
    sessionId: channel.coordinator?.sessionId,
    onText: (transcript) => {
      const next = insertDictation(text, caret, transcript);
      setText(next.text);
      setCaret(next.cursor);
      requestAnimationFrame(() => inputRef.current?.setSelectionRange(next.cursor, next.cursor));
    },
  });
  const canDictate = supported && dictation.available;
  const dictating = dictation.phase === 'starting' || dictation.phase === 'recording';
  const dictationBar = dictation.phase !== 'idle';
  /** 录音时按了发送：转写完、文字放进输入框之后再发。 */
  const sendAfterDictation = useRef(false);
  const [sendQueued, setSendQueued] = useState(false);
  useEffect(() => {
    if (dictation.phase !== 'idle' || !sendAfterDictation.current) return;
    sendAfterDictation.current = false;
    if (dictation.errorKey === undefined) setSendQueued(true);
  }, [dictation.phase, dictation.errorKey]);
  // 转写的文字已经在这一次渲染的 `text` 里。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只跟着排队的发送。
  useEffect(() => {
    if (!sendQueued) return;
    setSendQueued(false);
    void send();
  }, [sendQueued]);

  // 录音时 Esc 丢掉这段录音（先于下面的停止）；在回时 Esc 停止（弹层打开时让弹层先处理）。
  useEffect(() => {
    if (!dictating) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      dictation.cancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [dictating, dictation.cancel]);
  const answering = supported && channel.answering === true;
  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => {
    if (!answering) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      void stopRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [answering]);

  useEffect(() => {
    if (reply === undefined) return;
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        event.isComposing ||
        document.querySelector('[role="dialog"]')
      )
        return;
      event.preventDefault();
      onCancelReply();
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [reply, onCancelReply]);

  // ── 按键 ────────────────────────────────────────────────────────────

  const mention = (member: Channel) => {
    if (query === undefined) return;
    const next = `${text.slice(0, query.start)}@${member.title} ${text.slice(caret)}`;
    const at = query.start + member.title.length + 2;
    setText(next);
    setCaret(at);
    setPicked(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(at, at);
    });
  };
  const { sendShortcut } = composerPrefs.use();
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (canDictate && matchesShortcut(event, getShortcut('dictation'))) {
      event.preventDefault();
      if (!event.repeat) dictation.press();
      return;
    }
    if (choices.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setPicked((current) => (current + step + choices.length) % choices.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const member = choices[Math.min(picked, choices.length - 1)];
        if (member !== undefined) mention(member);
        return;
      }
    }
    if (onHistoryKey(event)) {
      event.preventDefault();
      return;
    }
    const key = composerKeyAction(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        composing: false,
      },
      { busy: false, pendingEnabled: false, hasText: hasContent, sendShortcut },
    );
    if (key === 'send') {
      event.preventDefault();
      void send();
    }
  };
  /** ⌘⇧D 松开（D 或任一修饰键，macOS 按着 ⌘ 时 D 的 keyup 不一定来）结束。 */
  const onKeyUp = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.code === getShortcut('dictation').code ||
      /^(?:Meta|Control|Shift|Alt)(?:Left|Right)$/.test(event.code)
    ) {
      dictation.release();
    }
  };

  const placeholder = t(
    group ? 'assistants.group.placeholder' : 'assistants.composer.placeholder',
    { name: channel.title },
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 拖放只是“+”菜单的快捷方式。
    <div
      className="@container relative"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {choices.length > 0 && (
        <ul
          className="absolute bottom-full left-0 mb-1.5 flex w-56 flex-col rounded-xl border border-border bg-popover p-1 shadow-md"
          aria-label={t('assistants.group.mention')}
          data-testid="mention-menu"
        >
          {choices.map((member, index) => (
            <li key={member.id}>
              <button
                type="button"
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-none hover:bg-muted',
                  index === picked && 'bg-muted',
                )}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => mention(member)}
                aria-current={index === picked}
                data-mention={member.id}
              >
                {member.assistant && <AssistantAvatar avatar={member.assistant.avatar} size={20} />}
                <span className="min-w-0 truncate">{member.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div
        className={cn(
          'flex flex-col gap-2 rounded-2xl border border-input bg-card p-2 focus-within:focus-field',
          dragging && 'border-ring ring-2 ring-ring/30',
        )}
        data-testid="assistant-composer"
      >
        {reply !== undefined && (
          <div
            className="flex min-w-0 items-center gap-1.5 border-b border-border px-2 pb-1.5 text-xs text-muted-foreground"
            data-testid="assistant-reply"
          >
            <Reply aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {postFirstLine(reply) || t('assistants.timeline.original')}
            </span>
            <IconButton
              size="icon-xs"
              label={t('assistants.timeline.cancelReply')}
              onClick={onCancelReply}
            >
              <X />
            </IconButton>
          </div>
        )}
        {dictation.errorKey && (
          <div className="flex items-center gap-2 px-2 pt-1 text-xs" role="alert">
            <p className="min-w-0 text-destructive" data-testid="composer-dictation-error">
              {dictation.error}
            </p>
            {dictation.errorKey === 'dictation.error.modelMissing' && (
              <button
                type="button"
                className="shrink-0 font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:focus-ring"
                onClick={() => void navigate(paths.settings('dictation'))}
              >
                {t('dictation.openSettings')}
              </button>
            )}
          </div>
        )}
        {input.strip}
        {input.error && (
          <p
            role="alert"
            className="px-2 text-xs text-destructive"
            data-testid="composer-image-error"
          >
            {input.error}
          </p>
        )}
        {/* 单行时输入框与两边的按钮同高（32px），文字和按钮在同一条中线上。 */}
        <div className="flex flex-wrap items-end gap-1 @min-[15rem]:flex-nowrap">
          {dictationBar ? (
            <DictationBar dictation={dictation} />
          ) : (
            <>
              {supported && (
                <div className="flex h-8 shrink-0 items-center">
                  <ComposerPlusMenu
                    commands={[]}
                    disabled={false}
                    canMention={false}
                    canAttachFiles={input.canAttach}
                    onHistory={input.onHistory}
                    onPaths={input.onPaths}
                    canAttachImages={imagesEnabled}
                    canCommand={false}
                    onAttach={input.onAttach}
                    onAttachImages={input.onImages}
                    onMention={() => {}}
                    onCommand={() => {}}
                    onRun={() => {}}
                    onClosed={() => window.setTimeout(() => inputRef.current?.focus(), 0)}
                  />
                </div>
              )}
              <Textarea
                ref={inputRef}
                value={text}
                maxLength={Math.max(0, MESSAGE_TEXT_MAX_LENGTH - (textLength(draft) - text.length))}
                onChange={(event) => {
                  setText(event.target.value);
                  input.resetHistory();
                  setCaret(event.target.selectionStart);
                  setPicked(0);
                  dictation.clearError();
                }}
                onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
                onKeyDown={onKeyDown}
                onKeyUp={onKeyUp}
                onPaste={onPaste}
                placeholder={placeholder}
                aria-label={placeholder}
                className="order-first max-h-48 min-h-8 min-w-0 flex-1 basis-full resize-none rounded-none border-0 bg-transparent px-2 py-1.5 text-sm leading-5 focus-visible:ring-0 @min-[15rem]:order-none @min-[15rem]:basis-0"
                rows={1}
                data-field="post"
              />
              {canDictate && (
                <div className="ml-auto shrink-0 @min-[15rem]:ml-0">
                  <DictationButton dictation={dictation} disabled={false} />
                </div>
              )}
            </>
          )}
          <div className={cn('shrink-0 @min-[15rem]:ml-0', !canDictate && 'ml-auto')}>
            {dictationBar ? (
              <ComposerButton
                action="send"
                loading={dictation.phase === 'transcribing'}
                disabled={false}
                onClick={() => {
                  sendAfterDictation.current = true;
                  dictation.stop();
                }}
              />
            ) : (
              <ComposerButton
                action={action}
                loading={busy}
                disabled={
                  action === 'stop'
                    ? stopping
                    : !hasContent || input.adding || !!input.failedAttachment || !!draftIssue(draft)
                }
                onClick={() => void (action === 'stop' ? stop() : send())}
              />
            )}
          </div>
        </div>
      </div>
      {input.picker}
    </div>
  );
}
