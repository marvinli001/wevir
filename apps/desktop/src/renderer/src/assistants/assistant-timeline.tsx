// 助理的对话页签（0.120.0）：时间线（用户的帖子在右，助理的在左，Host 的说明居中），帖子带的卡片（我需要什么、建议、晨间简报、说明），
// 挂在帖子下面的线程卡片，等用户批准的审批（展示要发出的原文），底部的输入框。看到的帖子标已读（`channel.markRead`）。

import type { WevirClient } from '@wevir/client-sdk';
import { isRpcError } from '@wevir/client-sdk';
import type {
  ApprovalRequest,
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
import { describe } from '@/host/host-connection';
import { currentLocale, type PlainMessageKey, t } from '@/i18n';
import { approvalLayout, optionLabel, presentApproval } from '@/session/approval-model';
import { formatMessageTime } from '@/session/format';
import { MarkdownView } from '@/session/markdown/markdown-view';
import { AssistantAvatar } from './assistant-avatar';
import { type AssistantView, outgoingText, postText, threadsByRoot } from './assistants-model';

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
  loadingOlder,
  onLoadOlder,
  onPosted,
  onOpenThread,
  onError,
}: {
  client: WevirClient;
  view: AssistantView;
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
  threads,
  onRespond,
  onRetry,
  onOpenThread,
  onResolve,
}: {
  post: ChannelPost;
  channel: Channel;
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
    return (
      <div className="flex justify-center" data-post-author="host" data-post-seq={post.seq}>
        <HostNotice card={post.card} text={text} onRetry={onRetry} />
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
  return (
    <div className="flex gap-3" data-post-author="coordinator" data-post-seq={post.seq}>
      {channel.assistant && (
        <AssistantAvatar avatar={channel.assistant.avatar} size={24} className="mt-0.5 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
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

function HostNotice({
  card,
  text,
  onRetry,
}: {
  card: ChannelCard | undefined;
  text: string;
  onRetry: () => void;
}) {
  const reason = card?.kind === 'notice' ? card.reason : undefined;
  const label =
    reason === 'budget'
      ? t('assistants.notice.budget')
      : reason === 'resumed'
        ? t('assistants.notice.resumed')
        : reason === 'failed'
          ? t('assistants.notice.failed')
          : undefined;
  return (
    <div
      className={cn(
        'flex max-w-[85%] items-center gap-2 rounded-lg px-3 py-1.5 text-sm',
        reason === 'failed' || reason === 'budget'
          ? 'bg-warning/10 text-warning'
          : 'bg-muted text-muted-foreground',
      )}
      data-notice={reason}
    >
      {(reason === 'failed' || reason === 'budget') && (
        <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 break-words">
        {[label, text].filter((part) => part !== undefined && part !== '').join(' · ')}
      </span>
      {reason === 'failed' && (
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
            {[t(THREAD_STATUS_LABEL[thread.status]), line]
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
  onPosted,
  onError,
}: {
  client: WevirClient;
  channel: Channel;
  onPosted: (post: ChannelPost) => void;
  onError: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const body = text.trim();
    if (body === '' || busy) return;
    setBusy(true);
    try {
      const { post } = await client.request('channel.post', {
        channelId: channel.id,
        content: [{ type: 'text', text: body }],
        clientPostId: crypto.randomUUID(),
      });
      setText('');
      onPosted(post);
    } catch (reason) {
      onError(t('assistants.postFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };
  // 单行时输入框与发送按钮同高（32px），文字和按钮在同一条中线上；四周留白相同。
  return (
    <div className="flex items-end gap-2 rounded-2xl border border-input bg-card p-2 focus-within:focus-field">
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('assistants.composer.placeholder', { name: channel.title })}
        aria-label={t('assistants.composer.placeholder', { name: channel.title })}
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
  );
}
