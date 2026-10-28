// 助理的对话页签（0.120.0）：时间线（用户的帖子在右，助理的在左，Host 的说明居中），帖子带的卡片（我需要什么、建议、晨间简报、说明），
// 挂在帖子下面的线程卡片，等用户批准的审批（展示要发出的原文），底部的输入框。看到的帖子标已读（`channel.markRead`）。
// 0.133.0：别的助理写的帖子（群里的成员、发来消息的助理）带它的头像与名字；发给别的助理的帖子标“发给 …”；群的输入框打 @ 选成员。

import type { WevirClient } from '@wevir/client-sdk';
import { isRpcError } from '@wevir/client-sdk';
import type {
  ApprovalRequest,
  AssistantRuleCategory,
  Channel,
  ChannelCard,
  ChannelPost,
  ChannelThread,
  ChannelThreadStatus,
} from '@wevir/protocol';
import { cn } from 'cn';
import {
  ArrowUp,
  Check,
  Circle,
  CircleCheck,
  GitBranch,
  Lightbulb,
  LoaderCircle,
  RotateCcw,
  Sun,
  TriangleAlert,
} from 'lucide-react';
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useWorkbenchSelector } from '@/data/workbench-data';
import { describe } from '@/host/host-connection';
import { currentLocale, type PlainMessageKey, t } from '@/i18n';
import { approvalLayout, optionLabel, presentApproval } from '@/session/approval-model';
import { formatMessageTime } from '@/session/format';
import { MarkdownView } from '@/session/markdown/markdown-view';
import { AssistantAvatar } from './assistant-avatar';
import {
  type AssistantView,
  CATEGORY_LABEL,
  groupMembers,
  mentionedIn,
  mentionQuery,
  outgoingText,
  postText,
  threadsByRoot,
} from './assistants-model';

/** 离底部这么近时，新帖来了跟着滚到底。 */
const STICK_PX = 120;

const THREAD_STATUS_LABEL: Record<ChannelThreadStatus, PlainMessageKey> = {
  resolved: 'assistants.thread.resolved',
  waiting: 'assistants.thread.waiting',
  working: 'assistants.thread.working',
  failed: 'assistants.thread.failed',
  replied: 'assistants.thread.replied',
  idle: 'assistants.thread.idle',
};

export function AssistantTimeline({
  client,
  view,
  assistants,
  loadingOlder,
  onLoadOlder,
  onPosted,
  onOpenThread,
  onError,
}: {
  client: WevirClient;
  view: AssistantView;
  /** 按 ID 找助理：别的助理写的帖子的头像与名字、群的成员。 */
  assistants: ReadonlyMap<string, Channel>;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onPosted: (post: ChannelPost) => void;
  /** 点线程卡片：在时间线旁边的窗格里打开那个会话。 */
  onOpenThread: (thread: ChannelThread) => void;
  onError: (text: string) => void;
}) {
  const { channel, posts } = view;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastSeq = posts.at(-1)?.seq ?? 0;
  const threads = useMemo(() => threadsByRoot(view.threads), [view.threads]);

  // 新帖来了：原来在底部就跟着滚到底。往前翻页时保持当前看到的位置。
  const firstSeq = posts[0]?.seq;
  const prevHeight = useRef(0);
  const prevFirst = useRef(firstSeq);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (prevFirst.current !== undefined && firstSeq !== undefined && firstSeq < prevFirst.current) {
      element.scrollTop += element.scrollHeight - prevHeight.current;
    } else if (stick.current) {
      element.scrollTop = element.scrollHeight;
    }
    prevFirst.current = firstSeq;
    prevHeight.current = element.scrollHeight;
  });

  // 标已读：窗口在前台时，看到的最后一条。
  const marked = useRef(0);
  useEffect(() => {
    const mark = () => {
      if (lastSeq <= marked.current || !document.hasFocus()) return;
      marked.current = lastSeq;
      client.request('channel.markRead', { channelId: channel.id, seq: lastSeq }).catch(() => {
        marked.current = 0;
      });
    };
    mark();
    window.addEventListener('focus', mark);
    return () => window.removeEventListener('focus', mark);
  }, [client, channel.id, lastSeq]);

  const run = (action: Promise<unknown>) =>
    action.catch((reason: unknown) =>
      onError(t('assistants.actionFailed', { error: describe(reason) })),
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX;
          if (element.scrollTop < 40 && view.hasOlder && !loadingOlder) onLoadOlder();
        }}
        data-testid="assistant-timeline"
      >
        <div className="mx-auto flex max-w-180 flex-col gap-4 px-5 py-5">
          {view.hasOlder && (
            <div className="flex justify-center">
              <Button variant="ghost" size="sm" disabled={loadingOlder} onClick={onLoadOlder}>
                {loadingOlder && <LoaderCircle className="animate-spin" />}
                {t('assistants.timeline.older')}
              </Button>
            </div>
          )}
          {posts.map((post) => (
            <PostRow
              key={post.id}
              post={post}
              channel={channel}
              assistants={assistants}
              threads={threads.get(post.id) ?? []}
              onRespond={(accept) =>
                run(
                  client.request('channel.respondSuggestion', {
                    channelId: channel.id,
                    postId: post.id,
                    accept,
                  }),
                )
              }
              onRetry={() => run(client.request('channel.wake', { channelId: channel.id }))}
              onOpenThread={onOpenThread}
              onResolve={(thread, resolved) =>
                run(
                  client.request('channel.resolveThread', {
                    channelId: channel.id,
                    sessionId: thread.sessionId,
                    resolved,
                  }),
                )
              }
            />
          ))}
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-180 flex-col gap-2 px-5 pb-4">
        {view.approvals.map((approval) => (
          <AssistantApproval
            key={approval.id}
            client={client}
            approval={approval}
            onError={onError}
          />
        ))}
        <Composer
          client={client}
          channel={channel}
          members={channel.kind === 'group' ? groupMembers(channel, assistants) : []}
          onPosted={(post) => {
            stick.current = true;
            onPosted(post);
          }}
          onError={onError}
        />
      </div>
    </div>
  );
}

function PostRow({
  post,
  channel,
  assistants,
  threads,
  onRespond,
  onRetry,
  onOpenThread,
  onResolve,
}: {
  post: ChannelPost;
  channel: Channel;
  assistants: ReadonlyMap<string, Channel>;
  threads: ChannelThread[];
  onRespond: (accept: boolean) => void;
  onRetry: () => void;
  onOpenThread: (thread: ChannelThread) => void;
  onResolve: (thread: ChannelThread, resolved: boolean) => void;
}) {
  const text = postText(post);
  const time = formatMessageTime(post.createdAt, currentLocale());
  const author = post.author.kind;
  if (author === 'host') {
    const about =
      post.card?.kind === 'notice' && post.card.assistantId !== undefined
        ? assistants.get(post.card.assistantId)?.title
        : undefined;
    return (
      <div className="flex justify-center" data-post-author="host" data-post-seq={post.seq}>
        <HostNotice
          card={post.card}
          text={text}
          {...(about !== undefined && { about })}
          {...(channel.kind !== 'group' && { onRetry })}
        />
      </div>
    );
  }
  if (author === 'user') {
    return (
      <div
        className="flex flex-col items-end gap-1.5"
        data-post-author="user"
        data-post-seq={post.seq}
      >
        {text !== '' && (
          <div className="max-w-[85%] min-w-0 rounded-xl bg-muted px-3.5 py-2 text-base whitespace-pre-wrap break-words">
            {text}
          </div>
        )}
        <span className="text-xs text-muted-foreground">
          {post.routedTo !== undefined && post.routedTo.length > 0
            ? t('assistants.timeline.routed', { count: post.routedTo.length, time })
            : time}
        </span>
        {threads.map((thread) => (
          <ThreadCard
            key={thread.sessionId}
            thread={thread}
            onOpen={onOpenThread}
            onResolve={onResolve}
          />
        ))}
      </div>
    );
  }
  // 别的助理写的：它的头像与名字（列表里没有了就用帖子上的名字）。
  const other = post.author.kind === 'assistant' ? post.author : undefined;
  const speaker = other === undefined ? channel : assistants.get(other.channelId);
  const avatar = speaker?.assistant?.avatar;
  return (
    <div
      className="flex gap-3"
      data-post-author={author}
      data-post-seq={post.seq}
      {...(other !== undefined && { 'data-post-assistant': other.channelId })}
    >
      {avatar ? (
        <AssistantAvatar avatar={avatar} size={24} className="mt-0.5 shrink-0" />
      ) : (
        <span aria-hidden className="mt-0.5 size-6 shrink-0 rounded-full bg-muted" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {other !== undefined && (
          <span className="text-xs font-medium text-soft-foreground" data-post-name>
            {speaker?.title ?? other.name}
          </span>
        )}
        {post.to !== undefined && (
          <span className="text-xs text-muted-foreground" data-post-to={post.to.channelId}>
            {t('assistants.timeline.to', {
              name: assistants.get(post.to.channelId)?.title ?? post.to.name,
            })}
          </span>
        )}
        {post.card?.kind === 'brief' && <BriefCard card={post.card} />}
        {/* 建议的帖子文字就是建议本身，卡片里已有。 */}
        {text !== '' && !(post.card?.kind === 'suggestion' && text === post.card.text) && (
          <MarkdownView text={text} streaming={false} quotable />
        )}
        {post.card?.kind === 'needs' && <NeedsCard card={post.card} />}
        {post.card?.kind === 'suggestion' && (
          <SuggestionCard card={post.card} onRespond={onRespond} />
        )}
        {post.files !== undefined && post.files.length > 0 && (
          <ul className="flex flex-wrap gap-1.5 text-sm">
            {post.files.map((file) => (
              <li key={file.path} className="rounded-md bg-muted px-2 py-0.5 text-xs">
                {file.name}
              </li>
            ))}
          </ul>
        )}
        <span className="text-xs text-muted-foreground">{time}</span>
        {threads.map((thread) => (
          <ThreadCard
            key={thread.sessionId}
            thread={thread}
            onOpen={onOpenThread}
            onResolve={onResolve}
          />
        ))}
      </div>
    </div>
  );
}

const CARD = 'rounded-xl border border-border bg-card px-3.5 py-3';

const NOTICE_LABEL: Record<Extract<ChannelCard, { kind: 'notice' }>['reason'], PlainMessageKey> = {
  budget: 'assistants.notice.budget',
  resumed: 'assistants.notice.resumed',
  failed: 'assistants.notice.failed',
  acted: 'assistants.notice.acted',
  handed_off: 'assistants.notice.handed_off',
  blocked: 'assistants.notice.blocked',
};

function HostNotice({
  card,
  text,
  about,
  onRetry,
}: {
  card: ChannelCard | undefined;
  text: string;
  /** 群里：说的是哪个成员。 */
  about?: string;
  /** 群没有协调者可以重试。 */
  onRetry?: () => void;
}) {
  const reason = card?.kind === 'notice' ? card.reason : undefined;
  const category =
    card?.kind === 'notice' && card.category !== undefined && card.category in CATEGORY_LABEL
      ? t(CATEGORY_LABEL[card.category as AssistantRuleCategory])
      : undefined;
  const label = reason === undefined ? undefined : t(NOTICE_LABEL[reason]);
  return (
    <div
      className={cn(
        'flex max-w-[85%] items-center gap-2 rounded-lg px-3 py-1.5 text-sm',
        reason === 'failed' || reason === 'budget' || reason === 'blocked'
          ? 'bg-warning/10 text-warning'
          : 'bg-muted text-muted-foreground',
      )}
      data-notice={reason}
    >
      {(reason === 'failed' || reason === 'budget' || reason === 'blocked') && (
        <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 whitespace-pre-line break-words">
        {[about, category, label, text]
          .filter((part) => part !== undefined && part !== '')
          .join(' · ')}
      </span>
      {reason === 'failed' && onRetry !== undefined && (
        <Button variant="ghost" size="xs" onClick={onRetry} data-action="retry">
          <RotateCcw />
          {t('assistants.notice.retry')}
        </Button>
      )}
    </div>
  );
}

function BriefCard({ card }: { card: Extract<ChannelCard, { kind: 'brief' }> }) {
  const sections: { key: string; label: string; items: typeof card.todo }[] = [
    { key: 'todo', label: t('assistants.brief.todo'), items: card.todo },
    { key: 'done', label: t('assistants.brief.done'), items: card.done },
    { key: 'decisions', label: t('assistants.brief.decisions'), items: card.decisions },
  ];
  const day = new Intl.DateTimeFormat(currentLocale(), {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(new Date(`${card.day}T12:00:00`));
  return (
    <section className={cn(CARD, 'flex flex-col gap-3')} data-card="brief">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <Sun aria-hidden className="size-4 text-warning" />
        {t('assistants.brief.title', { day })}
      </h3>
      {sections.map((section) => (
        <div key={section.key} data-brief-section={section.key}>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {section.label} · {section.items.length}
          </p>
          {section.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('assistants.brief.none')}</p>
          ) : (
            <ul className="flex flex-col gap-0.5 text-sm">
              {section.items.map((item, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 简报里的条目不会重排
                <li key={index} className="flex items-start gap-1.5">
                  <span
                    aria-hidden
                    className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground"
                  />
                  <span className="min-w-0 break-words">{item.title}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}

function NeedsCard({ card }: { card: Extract<ChannelCard, { kind: 'needs' }> }) {
  return (
    <section className={cn(CARD, 'flex flex-col gap-2')} data-card="needs">
      <h3 className="text-sm font-semibold">{t('assistants.needs.title')}</h3>
      <ul className="flex flex-col gap-1.5 text-sm">
        {card.items.map((item) => (
          <li key={`${item.kind}:${item.label}`} className="flex items-start gap-2">
            {item.ready ? (
              <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
            ) : (
              <Circle aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0">
              <span className="break-words">{item.label}</span>
              {item.detail && (
                <span className="block text-xs break-words text-muted-foreground">
                  {item.detail}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SuggestionCard({
  card,
  onRespond,
}: {
  card: Extract<ChannelCard, { kind: 'suggestion' }>;
  onRespond: (accept: boolean) => void;
}) {
  return (
    <section className={cn(CARD, 'flex flex-col gap-2')} data-card="suggestion">
      <p className="flex items-start gap-2 text-sm">
        <Lightbulb aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <span className="min-w-0 break-words">{card.text}</span>
      </p>
      {card.status === 'open' ? (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => onRespond(false)} data-action="dismiss">
            {t('assistants.suggestion.dismiss')}
          </Button>
          <Button size="sm" onClick={() => onRespond(true)} data-action="accept">
            {t('assistants.suggestion.accept')}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t(
            card.status === 'accepted'
              ? 'assistants.suggestion.accepted'
              : 'assistants.suggestion.dismissed',
          )}
        </p>
      )}
    </section>
  );
}

function ThreadCard({
  thread,
  onOpen,
  onResolve,
}: {
  thread: ChannelThread;
  onOpen: (thread: ChannelThread) => void;
  onResolve: (thread: ChannelThread, resolved: boolean) => void;
}) {
  const resolved = thread.status === 'resolved';
  const line = thread.status === 'working' ? thread.doing : thread.lastReply?.firstLine;
  // 开在用户项目里的线程（0.134.0）写上项目名。
  const project = useWorkbenchSelector((data) =>
    thread.workspaceId === undefined || data.status !== 'ready'
      ? undefined
      : data.workspaces.find((entry) => entry.workspace.id === thread.workspaceId)?.workspace
          .displayName,
  );
  return (
    <section
      className={cn(
        CARD,
        'flex w-full max-w-120 items-start gap-2.5 self-stretch py-2.5 text-left',
      )}
      data-card="thread"
      data-thread-status={thread.status}
    >
      <button
        type="button"
        className="-m-1 flex min-w-0 flex-1 items-start gap-2.5 rounded-md p-1 text-left outline-none hover:bg-muted focus-visible:focus-ring"
        onClick={() => onOpen(thread)}
        data-action="open-thread"
      >
        {thread.status === 'working' ? (
          <LoaderCircle aria-hidden className="mt-0.5 size-4 shrink-0 animate-spin text-running" />
        ) : (
          <GitBranch
            aria-hidden
            className={cn(
              'mt-0.5 size-4 shrink-0',
              thread.status === 'waiting' ? 'text-warning' : 'text-muted-foreground',
            )}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className={cn('truncate text-sm font-medium', resolved && 'text-muted-foreground')}>
            {thread.title}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {[t(THREAD_STATUS_LABEL[thread.status]), project, line]
              .filter((part) => part !== undefined && part !== '')
              .join(' · ')}
          </p>
        </div>
      </button>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => onResolve(thread, !resolved)}
        data-action={resolved ? 'reopen' : 'resolve'}
      >
        {resolved ? <RotateCcw /> : <Check />}
        {t(resolved ? 'assistants.thread.reopen' : 'assistants.thread.resolve')}
      </Button>
    </section>
  );
}

/** 等用户批准的事：标题、要发出的原文（一字不改），拒绝与允许。 */
function AssistantApproval({
  client,
  approval,
  onError,
}: {
  client: WevirClient;
  approval: ApprovalRequest;
  onError: (text: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const presentation = presentApproval(approval);
  const layout = approvalLayout(approval.options);
  const outgoing = outgoingText(approval);
  const respond = async (optionId: string) => {
    setBusy(true);
    try {
      await client.request('approval.respond', { approvalId: approval.id, optionId });
    } catch (reason) {
      if (!isRpcError(reason, 'ALREADY_DECIDED')) {
        onError(t('approval.respondFailed', { error: describe(reason) }));
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="rounded-2xl border border-border bg-card px-4 py-3.5 shadow-sm"
      data-testid="assistant-approval"
    >
      <h3 className="text-base leading-snug font-semibold">{presentation.title}</h3>
      {presentation.justification && (
        <p className="mt-1.5 text-soft-foreground">{presentation.justification}</p>
      )}
      {outgoing !== '' && (
        <>
          <p className="mt-3 mb-1 text-xs text-muted-foreground">
            {t('assistants.approval.outgoing')}
          </p>
          <pre
            data-approval-outgoing
            className="max-h-[min(14rem,28vh)] overflow-auto rounded-lg bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-soft-foreground"
          >
            {outgoing}
          </pre>
        </>
      )}
      <div className="mt-3 flex justify-end gap-2">
        {layout.reject && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => layout.reject && respond(layout.reject.optionId)}
            data-action="reject"
          >
            {optionLabel(layout.reject)}
          </Button>
        )}
        {layout.allow && (
          <Button
            disabled={busy}
            onClick={() => layout.allow && respond(layout.allow.optionId)}
            data-action="allow"
          >
            {optionLabel(layout.allow)}
          </Button>
        )}
      </div>
    </section>
  );
}

function Composer({
  client,
  channel,
  members,
  onPosted,
  onError,
}: {
  client: WevirClient;
  channel: Channel;
  /** 群的成员（打 @ 时可选）；助理的时间线是空的。 */
  members: readonly Channel[];
  onPosted: (post: ChannelPost) => void;
  onError: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const query = members.length > 0 ? mentionQuery(text, caret) : undefined;
  const choices =
    query === undefined
      ? []
      : members.filter((member) =>
          member.title.toLowerCase().startsWith(query.query.toLowerCase()),
        );
  const group = channel.kind === 'group';
  const send = async () => {
    const body = text.trim();
    if (body === '' || busy) return;
    setBusy(true);
    try {
      const mentions = mentionedIn(body, members);
      const { post } = await client.request('channel.post', {
        channelId: channel.id,
        content: [{ type: 'text', text: body }],
        clientPostId: crypto.randomUUID(),
        ...(mentions.length > 0 && { mentions }),
      });
      setText('');
      onPosted(post);
    } catch (reason) {
      onError(t('assistants.postFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };
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
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
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
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };
  const placeholder = t(
    group ? 'assistants.group.placeholder' : 'assistants.composer.placeholder',
    {
      name: channel.title,
    },
  );
  return (
    <div className="relative">
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
      {/* 单行时输入框与发送按钮同高（32px），文字和按钮在同一条中线上；四周留白相同。 */}
      <div className="flex items-end gap-2 rounded-2xl border border-input bg-card p-2 focus-within:focus-field">
        <Textarea
          ref={inputRef}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            setPicked(0);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={placeholder}
          className="max-h-48 min-h-8 flex-1 resize-none rounded-none border-0 bg-transparent px-2 py-1.5 text-sm leading-5 focus-visible:ring-0"
          rows={1}
          data-field="post"
        />
        <Button
          size="icon"
          className="rounded-full"
          disabled={text.trim() === '' || busy}
          onClick={() => void send()}
          aria-label={t('assistants.composer.send')}
          data-action="send"
        >
          <ArrowUp />
        </Button>
      </div>
    </div>
  );
}
