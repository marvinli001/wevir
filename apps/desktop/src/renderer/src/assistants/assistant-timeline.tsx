// 助理的对话页签（0.120.0）：时间线（用户的帖子在右，助理的在左，Host 的说明居中），帖子带的卡片（我需要什么、建议、晨间简报、说明），
// 挂在帖子下面的线程卡片，等用户批准的审批（展示要发出的原文），底部的输入框。看到的帖子标已读（`channel.markRead`）。
// 0.133.0：别的助理写的帖子（群里的成员、发来消息的助理）带它的头像与名字；发给别的助理的帖子标“发给 …”。输入框在
// assistant-composer.tsx；0.135.0 起用户的帖子带图片。

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
  Circle,
  CircleCheck,
  GitBranch,
  Lightbulb,
  LoaderCircle,
  Reply,
  RotateCcw,
  SmilePlus,
  Sun,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useWorkbenchSelector } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { currentLocale, type PlainMessageKey, t } from '@/i18n';
import { OtherApprovalDecisions } from '@/session/approval-decisions';
import { approvalLayout, optionLabel, presentApproval } from '@/session/approval-model';
import { imagesOf } from '@/session/composer-images';
import { formatMessageTime } from '@/session/format';
import { MessageImages } from '@/session/image-attachments';
import { MarkdownView } from '@/session/markdown/markdown-view';
import { MessageFiles } from '@/session/message-files';
import { AssistantAvatar } from './assistant-avatar';
import { AssistantComposer } from './assistant-composer';
import {
  ACTIVITY_LABEL,
  type AssistantView,
  CATEGORY_LABEL,
  chatSupported,
  groupMembers,
  outgoingText,
  panelSupported,
  postFirstLine,
  postText,
  showsReplyQuote,
  threadsByRoot,
  timelineRows,
  timelineTimeLabel,
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
  const connection = useHostConnection();
  const chat = chatSupported(
    connection.view.status === 'connected' ? connection.view.hello.features : undefined,
  );
  const [reply, setReply] = useState<ChannelPost>();
  const [jump, setJump] = useState<string>();
  const [highlighted, setHighlighted] = useState<string>();
  const requestedBefore = useRef<number | undefined>(undefined);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastSeq = posts.at(-1)?.seq ?? 0;
  const threads = useMemo(() => threadsByRoot(view.threads), [view.threads]);
  const rows = useMemo(() => timelineRows(posts), [posts]);
  const jumpTo = (id: string) => {
    stick.current = false;
    requestedBefore.current = undefined;
    setJump(id);
  };
  useEffect(() => () => clearTimeout(highlightTimer.current), []);
  useEffect(() => {
    if (jump === undefined) return;
    const target = document.getElementById(jump);
    if (target !== null && scrollRef.current?.contains(target)) {
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
      setHighlighted(jump);
      clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setHighlighted(undefined), 1400);
      setJump(undefined);
    } else if (view.hasOlder && !loadingOlder && requestedBefore.current !== posts[0]?.seq) {
      requestedBefore.current = posts[0]?.seq;
      onLoadOlder();
    } else if (!view.hasOlder) setJump(undefined);
  }, [jump, posts, view.hasOlder, loadingOlder, onLoadOlder]);

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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className="@container min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX;
          if (element.scrollTop < 40 && view.hasOlder && !loadingOlder) onLoadOlder();
        }}
        data-testid="assistant-timeline"
      >
        <div className="mx-auto flex max-w-180 flex-col px-5 py-5">
          {view.hasOlder && (
            <div className="flex justify-center">
              <Button variant="ghost" size="sm" disabled={loadingOlder} onClick={onLoadOlder}>
                {loadingOlder && <LoaderCircle className="animate-spin" />}
                {t('assistants.timeline.older')}
              </Button>
            </div>
          )}
          {rows.map(({ post, first, last, separator }) => (
            <div key={post.id} className={chat && !first ? 'mt-1' : 'mt-4'}>
              {chat && separator && (
                <p className="mb-4 text-center text-xs text-muted-foreground" data-time-separator>
                  {timelineTimeLabel(post.createdAt, new Date(), currentLocale(), {
                    today: t('assistants.timeline.today'),
                    yesterday: t('assistants.timeline.yesterday'),
                  })}
                </p>
              )}
              <PostRow
                post={post}
                chat={chat}
                panel={channel.kind === 'assistant' && panelSupported(client.hello.features)}
                first={first}
                last={last}
                highlighted={highlighted === post.id}
                quoted={
                  post.replyTo === undefined
                    ? undefined
                    : posts.find((candidate) => candidate.id === post.replyTo)
                }
                showQuote={chat && showsReplyQuote(post, posts)}
                onReply={() => setReply(post)}
                onJump={jumpTo}
                onReplies={() => {
                  const firstReply = posts.find((candidate) => candidate.replyTo === post.id);
                  if (firstReply !== undefined) jumpTo(firstReply.id);
                }}
                onReact={(emoji) =>
                  run(
                    client
                      .request('channel.react', { channelId: channel.id, postId: post.id, emoji })
                      .then(({ post }) => onPosted(post)),
                  )
                }
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
              />
            </div>
          ))}
          {channel.answering === true && (
            <div className="mt-4 flex items-end gap-3" data-testid="assistant-typing">
              {channel.assistant && (
                <AssistantAvatar
                  avatar={channel.assistant.avatar}
                  size={24}
                  className="mt-4 self-start"
                />
              )}
              <div className="flex flex-col gap-1.5">
                <div
                  className="flex h-10 w-16 items-center justify-center gap-1 rounded-xl bg-card"
                  role="status"
                  aria-label={t('assistants.activity.thinking')}
                >
                  {[0, 1, 2].map((dot) => (
                    <span
                      key={dot}
                      aria-hidden
                      className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-pulse"
                      style={{ animationDelay: `${dot * 160}ms` }}
                    />
                  ))}
                </div>
                {chat && (
                  <span
                    className="text-xs text-muted-foreground"
                    data-channel-activity={channel.activity?.kind ?? 'thinking'}
                  >
                    {t(ACTIVITY_LABEL[channel.activity?.kind ?? 'thinking'])}
                  </span>
                )}
              </div>
            </div>
          )}
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
        <AssistantComposer
          key={channel.id}
          client={client}
          channel={channel}
          reply={reply}
          onCancelReply={() => setReply(undefined)}
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
  chat,
  panel,
  first,
  last,
  highlighted,
  quoted,
  showQuote,
  onRespond,
  onRetry,
  onOpenThread,
  onReply,
  onJump,
  onReplies,
  onReact,
}: {
  post: ChannelPost;
  channel: Channel;
  assistants: ReadonlyMap<string, Channel>;
  threads: ChannelThread[];
  chat: boolean;
  panel: boolean;
  first: boolean;
  last: boolean;
  highlighted: boolean;
  quoted: ChannelPost | undefined;
  showQuote: boolean;
  onRespond: (accept: boolean) => void;
  onRetry: () => void;
  onOpenThread: (thread: ChannelThread) => void;
  onReply: () => void;
  onJump: (id: string) => void;
  onReplies: () => void;
  onReact: (emoji: string | null) => void;
}) {
  const text = postText(post);
  const author = post.author.kind;
  const time = new Date(post.createdAt).toLocaleString(currentLocale());
  if (author === 'host') {
    const about =
      post.card?.kind === 'notice' && post.card.assistantId !== undefined
        ? assistants.get(post.card.assistantId)?.title
        : undefined;
    return (
      <div
        id={post.id}
        className="flex justify-center"
        data-post-author="host"
        data-post-seq={post.seq}
      >
        <HostNotice
          card={post.card}
          text={text}
          {...(about !== undefined && { about })}
          {...(channel.kind !== 'group' && { onRetry })}
        />
      </div>
    );
  }
  const user = author === 'user';
  const other = post.author.kind === 'assistant' ? post.author : undefined;
  const speaker = other === undefined ? channel : assistants.get(other.channelId);
  const avatar = speaker?.assistant?.avatar;
  const images = imagesOf(post.content);
  const files = post.content.filter((part) => part.type === 'file');
  return (
    <div
      id={post.id}
      className={cn('flex items-end gap-3', user && 'justify-end')}
      data-post-author={author}
      data-post-seq={post.seq}
      {...(other !== undefined && { 'data-post-assistant': other.channelId })}
    >
      {!user && (
        <div className="w-6 shrink-0 self-end pb-0.5">
          {(!chat || last) &&
            (avatar ? (
              <AssistantAvatar avatar={avatar} size={24} />
            ) : (
              <span aria-hidden className="block size-6 rounded-full bg-muted" />
            ))}
        </div>
      )}
      <div
        className={cn(
          'flex min-w-0 flex-col gap-1.5',
          chat
            ? user
              ? 'max-w-[85%] @min-[28rem]:max-w-[min(85%,calc(100%_-_4rem))]'
              : 'max-w-[min(85%,calc(100%_-_2.25rem))] @min-[28rem]:max-w-[min(85%,calc(100%_-_6rem))]'
            : user
              ? 'max-w-[85%]'
              : 'flex-1',
          user ? 'items-end' : 'items-start',
        )}
      >
        {other !== undefined && (!chat || first) && (
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
        <div className="group/post relative min-w-0 max-w-full">
          {showQuote && post.replyTo !== undefined && (
            <button
              type="button"
              className="mb-1 flex max-w-full items-center gap-1 rounded-md px-2 py-1 text-left text-xs text-muted-foreground outline-none hover:bg-muted focus-visible:focus-ring"
              onClick={() => onJump(post.replyTo as string)}
              data-action="quote"
            >
              <Reply aria-hidden className="size-3 shrink-0" />
              <span className="truncate">
                {quoted === undefined
                  ? t('assistants.timeline.original')
                  : postFirstLine(quoted) || t('assistants.timeline.original')}
              </span>
            </button>
          )}
          <div
            title={time}
            className={cn(
              'min-w-0 break-words',
              (chat || user) && 'rounded-xl px-3.5 py-2',
              user ? 'bg-muted whitespace-pre-wrap' : chat && 'bg-card',
              highlighted && 'ring-2 ring-ring/40',
            )}
            data-post-bubble={post.id}
            data-highlighted={highlighted || undefined}
          >
            {images.length > 0 && <MessageImages images={images} />}
            {files.length > 0 && <MessageFiles files={files} />}
            {post.card?.kind === 'brief' && <BriefCard card={post.card} />}
            {text !== '' &&
              !(post.card?.kind === 'suggestion' && text === post.card.text) &&
              (user ? (
                text
              ) : (
                <MarkdownView className="text-content" text={text} streaming={false} quotable />
              ))}
            {post.card?.kind === 'needs' && <NeedsCard card={post.card} />}
            {post.card?.kind === 'suggestion' && (
              <SuggestionCard card={post.card} onRespond={onRespond} />
            )}
            {post.files !== undefined && post.files.length > 0 && (
              <ul className="mt-1.5 flex flex-wrap gap-1.5 text-sm">
                {post.files.map((file) => (
                  <li key={file.path} className="rounded-md bg-muted px-2 py-0.5 text-xs">
                    {file.name}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {chat && (
            <div
              className={cn(
                'absolute right-0 bottom-full mb-1 flex items-center gap-0.5 rounded-lg bg-background p-0.5 opacity-0 group-hover/post:opacity-100 group-focus-within/post:opacity-100 has-[[data-popup-open]]:opacity-100 @min-[28rem]:top-0 @min-[28rem]:bottom-auto @min-[28rem]:mb-0',
                user
                  ? '@min-[28rem]:right-full @min-[28rem]:mr-1'
                  : '@min-[28rem]:right-auto @min-[28rem]:left-full @min-[28rem]:ml-1',
              )}
            >
              <IconButton
                size="icon-xs"
                label={t('assistants.timeline.reply')}
                onClick={onReply}
                data-action="reply"
              >
                <Reply />
              </IconButton>
              <ReactionPicker post={post} onReact={onReact} />
            </div>
          )}
          {chat && post.reactions !== undefined && post.reactions.length > 0 && (
            <div
              className={cn('relative -mt-1.5 flex gap-0.5 px-2', user && 'justify-end')}
              data-reactions
            >
              {post.reactions.map((reaction) =>
                reaction.by === 'user' ? (
                  <Button
                    variant="outline"
                    size="xs"
                    key={reaction.by}
                    type="button"
                    className="h-auto px-1.5 py-0.5"
                    onClick={() => onReact(null)}
                    aria-label={t('assistants.timeline.reaction')}
                    data-reaction-by="user"
                  >
                    {reaction.emoji}
                  </Button>
                ) : (
                  <span
                    key={reaction.by}
                    title={channel.title}
                    className="rounded-full border border-border bg-card px-1.5 py-0.5 text-xs"
                    data-reaction-by="assistant"
                  >
                    {reaction.emoji}
                  </span>
                ),
              )}
            </div>
          )}
        </div>
        {chat && post.replyCount !== undefined && (
          <button
            type="button"
            className="rounded px-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring"
            onClick={onReplies}
            data-action="replies"
          >
            {t('assistants.timeline.replies', { count: post.replyCount })}
          </button>
        )}
        {!chat && (
          <span className="text-xs text-muted-foreground">
            {user && post.routedTo !== undefined && post.routedTo.length > 0
              ? t('assistants.timeline.routed', {
                  count: post.routedTo.length,
                  time: formatMessageTime(post.createdAt, currentLocale()),
                })
              : formatMessageTime(post.createdAt, currentLocale())}
          </span>
        )}
        {threads.map((thread) => (
          <ThreadCard
            key={thread.sessionId}
            thread={thread}
            onOpen={onOpenThread}
            compact={panel}
          />
        ))}
      </div>
    </div>
  );
}

const REACTIONS = ['\u{1f44d}', '\u2764\ufe0f', '\u{1f602}', '\u{1f389}', '\u{1f440}', '\u2705'];

function ReactionPicker({
  post,
  onReact,
}: {
  post: ChannelPost;
  onReact: (emoji: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = post.reactions?.find((reaction) => reaction.by === 'user')?.emoji;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <IconButton
            size="icon-xs"
            label={t('assistants.timeline.reaction')}
            data-action="reaction"
          >
            <SmilePlus />
          </IconButton>
        }
      />
      <PopoverContent
        className="w-auto flex-row gap-0.5 p-1"
        aria-label={t('assistants.timeline.reaction')}
      >
        {REACTIONS.map((emoji) => (
          <Button
            key={emoji}
            variant="ghost"
            size="icon-sm"
            aria-label={emoji}
            aria-pressed={current === emoji}
            onClick={() => {
              onReact(current === emoji ? null : emoji);
              setOpen(false);
            }}
            data-emoji={emoji}
          >
            {emoji}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
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
        'flex max-w-[85%] items-center gap-2 rounded-lg bg-muted px-3 py-1.5 text-sm',
        reason === 'failed' || reason === 'budget' || reason === 'blocked'
          ? 'text-foreground'
          : 'text-muted-foreground',
      )}
      data-notice={reason}
    >
      {(reason === 'failed' || reason === 'budget' || reason === 'blocked') && (
        <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-icon-warning" />
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
        <Sun aria-hidden className="size-4 text-icon-warning" />
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
              <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-icon-success" />
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
        <Lightbulb aria-hidden className="mt-0.5 size-4 shrink-0 text-icon-warning" />
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
  compact,
}: {
  thread: ChannelThread;
  onOpen: (thread: ChannelThread) => void;
  compact: boolean;
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
  if (compact)
    return (
      <button
        type="button"
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:focus-ring',
          resolved && 'text-muted-foreground',
        )}
        onClick={() => onOpen(thread)}
        data-card="thread"
        data-thread-status={thread.status}
        data-action="open-thread"
      >
        {thread.status === 'working' ? (
          <LoaderCircle
            aria-hidden
            className="size-4 shrink-0 animate-spin text-running motion-reduce:animate-none"
          />
        ) : resolved ? (
          <CircleCheck aria-hidden className="size-4 shrink-0" />
        ) : (
          <GitBranch
            aria-hidden
            className={cn('size-4 shrink-0', thread.status === 'waiting' && 'text-icon-warning')}
          />
        )}
        <span className="min-w-0 truncate">
          {resolved ? `${t('assistants.thread.completed')} · ${thread.title}` : thread.title}
        </span>
        {!resolved && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {[project, line || t(THREAD_STATUS_LABEL[thread.status])].filter(Boolean).join(' · ')}
          </span>
        )}
      </button>
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
              thread.status === 'waiting' ? 'text-icon-warning' : 'text-muted-foreground',
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
      {outgoing === '' && presentation.target && (
        <pre
          data-approval-target
          className="mt-2 max-h-36 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all"
        >
          {presentation.target}
        </pre>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
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
        <OtherApprovalDecisions
          layout={layout}
          busy={busy}
          onChoose={(option) => void respond(option.optionId)}
        />
      </div>
    </section>
  );
}
