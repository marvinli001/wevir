// 助理（私人 bot）在手机上的数据形状。助理是电脑上的一个频道（`kind: 'assistant'`）：一条时间线、一个协调者、开出的线程。
// 这里把频道、帖子、线程与审批换成手机要画的部分；多台电脑的助理合并成一个列表，`key` 带电脑名区分。纯逻辑。

import type {
  ApprovalRequest,
  Channel,
  ChannelPost,
  ChannelThread,
  ChannelThreadStatus,
} from '@wevir/protocol';
import { type Avatar, normalizeAvatar } from './bot-avatar';

/** 列表与详情里的状态：空闲、工作中、等用户决定、已暂停（用户暂停或预算用完）。 */
export type BotState = Channel['state'];

export interface Bot {
  /** `电脑名/频道 ID`，全 App 唯一。 */
  key: string;
  id: string;
  /** 所在电脑的配对记录名。 */
  computer: string;
  /** 所在电脑的显示名。 */
  computerName: string;
  name: string;
  /** 一句话：它负责什么。 */
  description: string;
  avatar: Avatar;
  state: BotState;
  unreadCount: number;
  lastPost?: { text: string; at: string };
  createdAt: string;
}

export type ThreadStatus = ChannelThreadStatus;

export type NeedKind = 'connector' | 'folder' | 'login' | 'other';

export type Decision = 'pending' | 'approved' | 'rejected';

export type NoticeReason = 'budget' | 'resumed' | 'failed';

/** 时间线上的一条：用户的话、助理的回答，或者一张卡片。 */
export type BotCard =
  | { kind: 'text'; text: string }
  | {
      kind: 'brief';
      /** 今日待办、昨晚完成、待决定。 */
      todo: readonly string[];
      done: readonly string[];
      decide: readonly string[];
    }
  | {
      kind: 'approval';
      /** 要用的工具：MCP 工具是 `服务 · 工具`。 */
      tool: string;
      /** 收件人、频道或地址。 */
      target?: string;
      subject?: string;
      /** 将要发出的原文（或命令、参数），原样展示。 */
      text: string;
      decision: Decision;
    }
  | {
      kind: 'thread';
      sessionId: string;
      title: string;
      status: ThreadStatus;
      /** 工作中时正在做的那项；回复后是最后一条回答的第一行。 */
      line?: string;
    }
  | { kind: 'file'; name: string; size: number }
  | {
      /** 建好后的第一条：要用的连接器、文件夹、浏览器登录，`ready` 已经有了。 */
      kind: 'needs';
      items: readonly { kind: NeedKind; label: string; ready: boolean; detail?: string }[];
    }
  | { kind: 'suggestion'; text: string; decision: Decision }
  | { kind: 'notice'; reason: NoticeReason };

export interface BotPost {
  /** 列表里的键：帖子是帖子 ID（带文字又带卡片的拆成两条），线程是会话 ID，审批是审批 ID。 */
  id: string;
  author: 'user' | 'bot' | 'host';
  createdAt: string;
  card: BotCard;
}

export function botKey(computer: string, id: string): string {
  return `${computer}/${id}`;
}

export function botFromChannel(computer: string, computerName: string, channel: Channel): Bot {
  return {
    key: botKey(computer, channel.id),
    id: channel.id,
    computer,
    computerName,
    name: channel.title,
    description: channel.assistant?.description ?? '',
    avatar: normalizeAvatar(channel.assistant?.avatar),
    state: channel.state,
    unreadCount: channel.unreadCount ?? 0,
    ...(channel.lastPost !== undefined && {
      lastPost: { text: channel.lastPost.preview, at: channel.lastPost.at },
    }),
    createdAt: channel.createdAt,
  };
}

/** 列表按最后动静排：等用户决定的在前，其余按最后一条的时间。 */
export function sortBots(bots: readonly Bot[]): Bot[] {
  const at = (bot: Bot) => Date.parse(bot.lastPost?.at ?? bot.createdAt) || 0;
  return [...bots].sort((a, b) => {
    const waiting = Number(b.state === 'waiting') - Number(a.state === 'waiting');
    return waiting !== 0 ? waiting : at(b) - at(a);
  });
}

function author(post: ChannelPost): BotPost['author'] {
  return post.author.kind === 'coordinator' ? 'bot' : post.author.kind;
}

const DECISIONS = { open: 'pending', accepted: 'approved', dismissed: 'rejected' } as const;

/** 一条帖子画成几条：文字一条，卡片一条，交给用户的文件各一条。只有图片时文字是 `imageLabel`。 */
export function postViews(post: ChannelPost, imageLabel: string): BotPost[] {
  const base = { author: author(post), createdAt: post.createdAt };
  const out: BotPost[] = [];
  const text = post.content
    .map((part) => (part.type === 'text' ? part.text : `[${imageLabel}]`))
    .join('\n\n')
    .trim();
  const card = post.card;
  // 提议的正文就是卡片上那句，不再单独画一遍。
  const repeated = card?.kind === 'suggestion' && card.text.trim() === text;
  if (text !== '' && !repeated) out.push({ ...base, id: post.id, card: { kind: 'text', text } });
  if (card !== undefined) {
    const id = `${post.id}:card`;
    switch (card.kind) {
      case 'needs':
        out.push({ ...base, id, card: { kind: 'needs', items: card.items } });
        break;
      case 'suggestion':
        out.push({
          ...base,
          id,
          card: { kind: 'suggestion', text: card.text, decision: DECISIONS[card.status] },
        });
        break;
      case 'brief':
        out.push({
          ...base,
          id,
          card: {
            kind: 'brief',
            todo: card.todo.map((i) => i.title),
            done: card.done.map((i) => i.title),
            decide: card.decisions.map((i) => i.title),
          },
        });
        break;
      case 'notice':
        out.push({ ...base, author: 'host', id, card: { kind: 'notice', reason: card.reason } });
        break;
    }
  }
  for (const [index, file] of (post.files ?? []).entries()) {
    out.push({
      ...base,
      id: `${post.id}:file:${index}`,
      card: { kind: 'file', name: file.name, size: file.size },
    });
  }
  return out;
}

export function threadView(thread: ChannelThread): BotPost {
  const line = thread.status === 'working' ? thread.doing : thread.lastReply?.firstLine;
  return {
    id: thread.sessionId,
    author: 'bot',
    createdAt: thread.createdAt,
    card: {
      kind: 'thread',
      sessionId: thread.sessionId,
      title: thread.title,
      status: thread.status,
      ...(line !== undefined && line !== '' && { line }),
    },
  };
}

const TEXT_KEYS = ['body', 'text', 'message', 'content', 'markdown', 'command', 'query'];
const TARGET_KEYS = ['to', 'recipient', 'recipients', 'channel', 'email', 'url'];
const SUBJECT_KEYS = ['subject', 'title'];
const QUOTE_MAX = 4_000;

function pick(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string'))
      return value.join(', ');
  }
  return undefined;
}

/** 审批画成什么：对外动作取将要发出的原文与收件人、主题；认不出的参数原样列出。 */
export function approvalView(request: ApprovalRequest, decision: Decision): BotPost {
  const detail = request.detail;
  const input =
    typeof detail?.input === 'object' && detail.input !== null && !Array.isArray(detail.input)
      ? (detail.input as Record<string, unknown>)
      : {};
  const server = detail?.display.mcpServer;
  const toolName = detail?.toolName ?? '';
  const tool =
    server !== undefined ? `${server} · ${toolName.split('__').at(-1) ?? toolName}` : toolName;
  const target = pick(input, TARGET_KEYS) ?? detail?.display.url;
  const subject = pick(input, SUBJECT_KEYS);
  const raw =
    pick(input, TEXT_KEYS) ??
    detail?.display.command ??
    (detail?.input !== undefined
      ? JSON.stringify(detail.input, null, 2)
      : (detail?.display.summary ?? ''));
  const text = raw.length > QUOTE_MAX ? `${raw.slice(0, QUOTE_MAX)}…` : raw;
  return {
    id: request.id,
    author: 'bot',
    createdAt: request.createdAt,
    card: {
      kind: 'approval',
      tool,
      ...(target !== undefined && { target }),
      ...(subject !== undefined && { subject }),
      text,
      decision,
    },
  };
}

export interface TimelineParts {
  posts: readonly ChannelPost[];
  threads: readonly ChannelThread[];
  approvals: readonly ApprovalRequest[];
  decided: readonly { request: ApprovalRequest; decision: 'approved' | 'rejected' }[];
  hasMore: boolean;
}

/**
 * 整条时间线：帖子按 `seq`，线程卡片挂在开它的那条帖子后面；根帖还没加载的线程与审批按时间插进去（比已加载的最早一条还早的线程不画）。
 */
export function timelineViews(timeline: TimelineParts, imageLabel: string): BotPost[] {
  const byRoot = new Map<string, ChannelThread[]>();
  const loose: BotPost[] = [];
  const ids = new Set(timeline.posts.map((p) => p.id));
  const first = timeline.posts[0]?.createdAt;
  for (const thread of timeline.threads) {
    if (ids.has(thread.rootPostId)) {
      const list = byRoot.get(thread.rootPostId) ?? [];
      list.push(thread);
      byRoot.set(thread.rootPostId, list);
    } else if (!timeline.hasMore || first === undefined || thread.createdAt >= first) {
      loose.push(threadView(thread));
    }
  }
  const decided = new Set(timeline.decided.map((d) => d.request.id));
  for (const { request, decision } of timeline.decided) loose.push(approvalView(request, decision));
  for (const request of timeline.approvals) {
    if (!decided.has(request.id)) loose.push(approvalView(request, 'pending'));
  }
  loose.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const out: BotPost[] = [];
  for (const post of timeline.posts) {
    while (loose[0] !== undefined && loose[0].createdAt < post.createdAt) {
      out.push(loose.shift() as BotPost);
    }
    out.push(...postViews(post, imageLabel));
    const threads = (byRoot.get(post.id) ?? []).sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
    for (const thread of threads) out.push(threadView(thread));
  }
  out.push(...loose);
  return out;
}
