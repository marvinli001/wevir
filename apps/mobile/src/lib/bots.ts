// 助理（私人 bot）在手机上的数据形状。助理是电脑上的一个频道（`kind: 'assistant'`）：一条时间线、一个协调者、开出的线程。
// 这里把频道、帖子、线程与审批换成手机要画的部分；多台电脑的助理合并成一个列表，`key` 带电脑名区分。纯逻辑。
// 助理群（0.133.0，`kind: 'group'`）也在列表里：成员是同一台电脑上的几个助理；群里与别的助理发来的帖子带说话的那个助理。
// 帖子里的图片（0.135.0 起用户的帖子能带）画成一排缩略图；开在用户项目里的线程（0.134.0）带项目名。

import {
  type ApprovalRequest,
  ASSISTANT_PROACTIVITY,
  ASSISTANT_RULE_CATEGORIES,
  type AssistantRuleCategory,
  type AssistantRules,
  type AssistantRuleTier,
  type Automation,
  type Channel,
  type ChannelPost,
  type ChannelThread,
  type ChannelThreadStatus,
  DEFAULT_ASSISTANT_RULES,
  type EngineFeatures,
  GROUP_MEMBERS_MAX,
  GROUP_MEMBERS_MIN,
  type SessionId,
  type SharedFile,
  type UserImagePart,
  type WorkspaceId,
} from '@wevir/protocol';
import { locale, t } from '../i18n';
import { type Avatar, normalizeAvatar } from './bot-avatar';

/** 列表与详情里的状态：空闲、工作中、等用户决定、已暂停（用户暂停）。 */
export type BotState = Channel['state'];

/** 群的成员，或时间线上说话的另一个助理。 */
export interface BotMember {
  id: string;
  name: string;
  avatar: Avatar;
}

export interface Bot {
  /** `电脑名/频道 ID`，全 App 唯一。 */
  key: string;
  id: string;
  kind: 'assistant' | 'group';
  /** 群的成员（同一台电脑上还在的助理，按成员顺序）；助理是空的。 */
  members: readonly BotMember[];
  /** 所在电脑的配对记录名。 */
  computer: string;
  /** 所在电脑的显示名。 */
  computerName: string;
  name: string;
  /** 一句话：它负责什么。 */
  description: string;
  avatar: Avatar;
  state: BotState;
  /** 协调者（群里是成员）正在回这条时间线（0.135.0）：输入框空着时显示停止。 */
  answering: boolean;
  activity?: NonNullable<Channel['activity']>['kind'];
  lastActiveAt?: string;
  unreadCount: number;
  lastPost?: { text: string; at: string };
  createdAt: string;
}

export type ThreadStatus = ChannelThreadStatus;

export type NeedKind = 'connector' | 'folder' | 'login' | 'other';

export type Decision = 'pending' | 'approved' | 'rejected';

export type NoticeReason = 'budget' | 'resumed' | 'failed' | 'acted' | 'handed_off' | 'blocked';

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
      options: ApprovalRequest['options'];
      /** 要用的工具：MCP 工具是 `服务 · 工具`。 */
      tool: string;
      /** 收件人、频道或地址。 */
      target?: string;
      subject?: string;
      /** 将要发出的原文（或命令、参数），原样展示。 */
      text: string;
      fullText?: string;
      location?: { project: string; cwd: string; directory: string };
      /** Host 判为高风险：允许前要本人验证（同收件箱）。 */
      risky?: true;
      decision: Decision;
    }
  | {
      kind: 'thread';
      sessionId: string;
      title: string;
      status: ThreadStatus;
      /** 工作中时正在做的那项；回复后是最后一条回答的第一行。 */
      line?: string;
      /** 开在用户项目里时：项目名。 */
      project?: string;
    }
  | ({ kind: 'file'; sessionId?: SessionId; workspaceId?: WorkspaceId } & SharedFile)
  | { kind: 'images'; images: readonly UserImagePart[] }
  | {
      /** 建好后的第一条：要用的连接器、文件夹、浏览器登录，`ready` 已经有了。 */
      kind: 'needs';
      items: readonly { kind: NeedKind; label: string; ready: boolean; detail?: string }[];
    }
  | { kind: 'suggestion'; text: string; decision: Decision }
  | {
      kind: 'notice';
      reason: NoticeReason;
      about?: string;
      /** 规矩里的动作种类（`acted`、`handed_off`）；认不出的种类不带。 */
      category?: AssistantRuleCategory;
      /** 帖子的文字：做了或拦下的动作，每行一个。 */
      text?: string;
    };

export interface BotPost {
  /** 列表里的键：帖子是帖子 ID（带文字又带卡片的拆成两条），线程是会话 ID，审批是审批 ID。 */
  id: string;
  sourceId?: string;
  seq?: number;
  replyTo?: string;
  replyCount?: number;
  reactions?: ChannelPost['reactions'];
  author: 'user' | 'bot' | 'host';
  createdAt: string;
  card: BotCard;
  /** 别的助理说的（群里的成员、发来消息的助理）：它的名字与头像。 */
  speaker?: BotMember;
  /** 发给了哪个助理（`wevir_channel_message`）。 */
  to?: string;
}

export function botKey(computer: string, id: string): string {
  return `${computer}/${id}`;
}

/** 同一台电脑上的助理，按 ID 找（群的成员、帖子里说话的助理）。 */
export type BotDirectory = ReadonlyMap<string, Channel>;

/** 同一台电脑上的项目名，按工作区 ID 找（线程卡片）。 */
export type ProjectNames = ReadonlyMap<string, string>;

function memberOf(channel: Channel): BotMember {
  return {
    id: channel.id,
    name: channel.title,
    avatar: normalizeAvatar(channel.assistant?.avatar),
  };
}

export function botFromChannel(
  computer: string,
  computerName: string,
  channel: Channel,
  directory: BotDirectory = new Map(),
): Bot {
  const members = (channel.group?.members ?? []).flatMap((id) => {
    const member = directory.get(id);
    return member === undefined || member.kind !== 'assistant' ? [] : [memberOf(member)];
  });
  const last = channel.lastPost;
  const speaker =
    last?.author === 'assistant' && last.assistantId !== undefined
      ? directory.get(last.assistantId)?.title
      : undefined;
  return {
    key: botKey(computer, channel.id),
    id: channel.id,
    kind: channel.kind === 'group' ? 'group' : 'assistant',
    members,
    computer,
    computerName,
    name: channel.title,
    description: channel.assistant?.description ?? '',
    avatar: normalizeAvatar(channel.assistant?.avatar ?? members[0]?.avatar),
    state: channel.state,
    answering: channel.answering === true,
    ...(channel.activity && { activity: channel.activity.kind }),
    ...(channel.lastActiveAt && { lastActiveAt: channel.lastActiveAt }),
    unreadCount: channel.unreadCount ?? 0,
    ...(last !== undefined && {
      lastPost: {
        text: speaker === undefined ? last.preview : `${speaker}: ${last.preview}`,
        at: last.at,
      },
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
  return post.author.kind === 'coordinator' || post.author.kind === 'assistant'
    ? 'bot'
    : post.author.kind;
}

const DECISIONS = { open: 'pending', accepted: 'approved', dismissed: 'rejected' } as const;

/** 一条帖子画成几条：图片一排，文字一条，卡片一条，交给用户的文件各一条。 */
export function postViews(post: ChannelPost, directory: BotDirectory = new Map()): BotPost[] {
  const other = post.author.kind === 'assistant' ? post.author : undefined;
  const known = other === undefined ? undefined : directory.get(other.channelId);
  const speaker: BotMember | undefined =
    other === undefined
      ? undefined
      : known !== undefined
        ? memberOf(known)
        : { id: other.channelId, name: other.name, avatar: normalizeAvatar(undefined) };
  const to =
    post.to === undefined ? undefined : (directory.get(post.to.channelId)?.title ?? post.to.name);
  const base = {
    sourceId: post.id,
    seq: post.seq,
    author: author(post),
    createdAt: post.createdAt,
    ...(speaker !== undefined && { speaker }),
  };
  const out: BotPost[] = [];
  const images = post.content.flatMap((part) => (part.type === 'image' ? [part] : []));
  if (images.length > 0)
    out.push({ ...base, id: `${post.id}:images`, card: { kind: 'images', images } });
  const text = post.content
    .flatMap((part) =>
      part.type === 'text' ? [part.text] : part.type === 'file' ? [part.name] : [],
    )
    .join('\n\n')
    .trim();
  const card = post.card;
  // 提议的正文就是卡片上那句，不再单独画一遍。
  // 说明的文字（做了或拦下的动作）画在说明那一行里。
  const repeated =
    (card?.kind === 'suggestion' && card.text.trim() === text) || card?.kind === 'notice';
  if (text !== '' && !repeated)
    out.push({
      ...base,
      id: post.id,
      card: { kind: 'text', text },
      ...(to !== undefined && { to }),
    });
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
      case 'notice': {
        const about =
          card.assistantId === undefined ? undefined : directory.get(card.assistantId)?.title;
        const category = ASSISTANT_RULE_CATEGORIES.find((c) => c === card.category);
        out.push({
          ...base,
          author: 'host',
          id,
          card: {
            kind: 'notice',
            reason: card.reason,
            ...(about !== undefined && { about }),
            ...(category !== undefined && { category }),
            ...(text !== '' && { text }),
          },
        });
        break;
      }
    }
  }
  for (const [index, file] of (post.files ?? []).entries()) {
    out.push({
      ...base,
      id: `${post.id}:file:${index}`,
      card: {
        kind: 'file',
        ...file,
        ...(post.author.kind === 'coordinator'
          ? { sessionId: post.author.sessionId }
          : post.author.kind === 'assistant'
            ? { workspaceId: directory.get(post.author.channelId)?.workspaceId }
            : {}),
      },
    });
  }
  const primary = out.find((view) => view.card.kind === 'text') ?? out[0];
  if (primary !== undefined) {
    if (post.replyTo !== undefined) primary.replyTo = post.replyTo;
    if (post.replyCount !== undefined) primary.replyCount = post.replyCount;
    if (post.reactions !== undefined) primary.reactions = post.reactions;
  }
  return out;
}

export function threadView(thread: ChannelThread, projects: ProjectNames = new Map()): BotPost {
  const line = thread.status === 'working' ? thread.doing : thread.lastReply?.firstLine;
  const project = thread.workspaceId === undefined ? undefined : projects.get(thread.workspaceId);
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
      ...(project !== undefined && { project }),
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

export interface ApprovalContext {
  cwd: string;
  projectName?: string;
}

/** 审批画成什么：对外动作取将要发出的原文与收件人、主题；认不出的参数原样列出。 */
export function approvalView(
  request: ApprovalRequest,
  decision: Decision,
  context?: ApprovalContext,
): BotPost {
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
  const cwd = detail?.display.cwd ?? context?.cwd;
  const location =
    context !== undefined && cwd !== undefined
      ? {
          project: context.projectName || folderParts(cwd).name,
          cwd,
          directory: cwd.replace(
            /^(?:\/(?:Users|home)\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=$|[/\\])/,
            '~',
          ),
        }
      : undefined;
  return {
    id: request.id,
    author: 'bot',
    createdAt: request.createdAt,
    card: {
      kind: 'approval',
      options: request.options,
      tool,
      ...(target !== undefined && { target }),
      ...(subject !== undefined && { subject }),
      text,
      ...(raw.length > QUOTE_MAX && { fullText: raw }),
      ...(location !== undefined && { location }),
      ...(request.risk?.level === 'high' && { risky: true as const }),
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
export function timelineViews(
  timeline: TimelineParts,
  directory: BotDirectory = new Map(),
  projects: ProjectNames = new Map(),
): BotPost[] {
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
      loose.push(threadView(thread, projects));
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
    out.push(...postViews(post, directory));
    const threads = (byRoot.get(post.id) ?? []).sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
    for (const thread of threads) out.push(threadView(thread, projects));
  }
  out.push(...loose);
  return out;
}

export const BOT_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅'] as const;

export function botReplyCount(n: number): string {
  const plural =
    locale() === 'ru'
      ? n % 10 === 1 && n % 100 !== 11
        ? 'one'
        : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
          ? 'few'
          : 'other'
      : n === 1
        ? 'one'
        : 'other';
  return t(
    plural === 'one' ? 'bot.replies.one' : plural === 'few' ? 'bot.replies.few' : 'bot.replies',
    { n },
  );
}

export interface BotTimelineRow {
  post: BotPost;
  first: boolean;
  last: boolean;
  separator: boolean;
}

export function botTimelineRows(posts: readonly BotPost[]): BotTimelineRow[] {
  const grouped = (a: BotPost | undefined, b: BotPost | undefined) =>
    a !== undefined &&
    b !== undefined &&
    a.author !== 'host' &&
    a.author === b.author &&
    a.speaker?.id === b.speaker?.id &&
    ['text', 'images'].includes(a.card.kind) &&
    ['text', 'images'].includes(b.card.kind) &&
    new Date(a.createdAt).toDateString() === new Date(b.createdAt).toDateString() &&
    Date.parse(b.createdAt) - Date.parse(a.createdAt) < 5 * 60_000;
  return posts.map((post, index) => {
    const previous = posts[index - 1];
    return {
      post,
      first: !grouped(previous, post),
      last: !grouped(post, posts[index + 1]),
      separator:
        previous === undefined ||
        new Date(previous.createdAt).toDateString() !== new Date(post.createdAt).toDateString() ||
        Date.parse(post.createdAt) - Date.parse(previous.createdAt) >= 30 * 60_000,
    };
  });
}

export function botTimeLabel(at: string, now: Date): string {
  const date = new Date(at);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const day =
    date.toDateString() === now.toDateString()
      ? t('bot.today')
      : date.toDateString() === yesterday.toDateString()
        ? t('bot.yesterday')
        : new Intl.DateTimeFormat(locale(), {
            month: 'short',
            day: 'numeric',
            ...(date.getFullYear() !== now.getFullYear() && { year: 'numeric' }),
          }).format(date);
  return `${day} ${new Intl.DateTimeFormat(locale(), {
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date)}`;
}

export function botPostQuote(post: Pick<ChannelPost, 'content'>): string {
  return Array.from(
    post.content
      .flatMap((part) =>
        part.type === 'text' ? [part.text] : part.type === 'file' ? [part.name] : [],
      )
      .join('\n')
      .split('\n')
      .find((line) => line.trim() !== '') ?? '',
  )
    .slice(0, 200)
    .join('');
}

export function showsBotQuote(post: BotPost, posts: readonly ChannelPost[]): boolean {
  if (post.replyTo === undefined) return false;
  const source = posts.find((p) => p.id === post.sourceId);
  const latestUser = posts.findLast((p) => p.seq < (post.seq ?? 0) && p.author.kind === 'user');
  return source?.author.kind !== 'coordinator' || latestUser?.id !== post.replyTo;
}

export function botProactivity(budget: NonNullable<Channel['budget']>) {
  return (Object.keys(ASSISTANT_PROACTIVITY) as (keyof typeof ASSISTANT_PROACTIVITY)[]).find(
    (key) =>
      ASSISTANT_PROACTIVITY[key].dailyWakes === budget.dailyWakes &&
      ASSISTANT_PROACTIVITY[key].dailyTokens === budget.dailyTokens,
  );
}

export function botRoutineStatus(
  automation: Pick<Automation, 'schedule' | 'timezone' | 'enabled' | 'autoPausedAt'>,
  now: Date,
): string {
  if (!automation.enabled || automation.autoPausedAt !== undefined) return t('bots.state.paused');
  const schedule = automation.schedule;
  if (schedule.kind === 'interval') return t('bot.monitoring');
  if (schedule.kind === 'manual') return t('bot.manual');
  if (schedule.kind === 'once') {
    const format = new Intl.DateTimeFormat('en-CA', {
      timeZone: automation.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const date = new Date(schedule.at);
    const today = format.format(now);
    const parts = format.formatToParts(now);
    const part = (key: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === key)?.value;
    const tomorrow = new Date(
      Date.UTC(Number(part('year')), Number(part('month')) - 1, Number(part('day')) + 1),
    );
    const nextDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(tomorrow);
    const clock = new Intl.DateTimeFormat(locale(), {
      timeZone: automation.timezone,
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .format(date)
      .replace(/^0/, '');
    if (format.format(date) === today) return t('bot.schedule.today', { time: clock });
    if (format.format(date) === nextDay) return t('bot.schedule.tomorrow', { time: clock });
    return `${new Intl.DateTimeFormat(locale(), {
      timeZone: automation.timezone,
      month: 'short',
      day: 'numeric',
      ...(format.formatToParts(date).find((p) => p.type === 'year')?.value !== part('year') && {
        year: 'numeric',
      }),
    }).format(date)} ${clock}`;
  }
  const time = schedule.time.replace(/^0/, '');
  if (schedule.kind === 'monthly') return t('bot.schedule.monthly', { day: schedule.day, time });
  if (schedule.weekdays === undefined || schedule.weekdays.length === 7)
    return t('bot.schedule.daily', { time });
  if (
    schedule.weekdays.length === 5 &&
    [1, 2, 3, 4, 5].every((d) => schedule.weekdays?.includes(d))
  )
    return t('bot.schedule.weekdays', { time });
  const days = [1, 2, 3, 4, 5, 6, 0]
    .filter((d) => schedule.weekdays?.includes(d))
    .map((d) =>
      new Intl.DateTimeFormat(locale(), { weekday: 'short', timeZone: 'UTC' }).format(
        new Date(Date.UTC(2026, 9, 18 + d)),
      ),
    )
    .join(t('common.listSeparator'));
  return t('bot.schedule.weekly', { days, time });
}

/** 编辑页里的值；`model` 只在换过模型时有。 */
export interface BotEdit {
  name: string;
  description: string;
  avatar: Avatar;
  folders: readonly string[];
  /** 改过的规矩；没改过的种类沿用原来的档。 */
  rules?: Readonly<Partial<Record<AssistantRuleCategory, AssistantRuleTier>>>;
  model?: { providerId: string; modelId: string };
}

/** 一类动作现在的档：没设过的取新助理的默认。 */
export function ruleTier(
  rules: AssistantRules,
  category: AssistantRuleCategory,
): AssistantRuleTier {
  return rules[category] ?? DEFAULT_ASSISTANT_RULES[category];
}

/**
 * 大脑的引擎缺什么（`engineFeatures`，按大脑 Provider 的种类），同桌面端：Host 有引擎挂得上 Wevir 工具时，挂不上的不能当大脑；不注入
 * 连接器或 skills 的用不了它们。旧 Host 没有 `engineFeatures` 时不提示。
 */
export function brainLimit(
  engineFeatures: Readonly<Record<string, EngineFeatures>> | undefined,
  kind: string | undefined,
): 'tools' | 'plugins' | undefined {
  const features = kind === undefined ? undefined : engineFeatures?.[kind];
  if (features === undefined) return undefined;
  const anyTools = Object.values(engineFeatures ?? {}).some((value) => value.appTools === true);
  if (anyTools && features.appTools !== true) return 'tools';
  return features.mcpServers === true && features.skills === true ? undefined : 'plugins';
}

/**
 * 改助理时交给 `channel.update` 的字段：只带变了的，空名字不改名；什么都没变时 undefined。换模型时清掉原来的推理强度。规矩变了时交整份。
 */
export function botPatch(
  channel: Channel,
  edit: BotEdit,
):
  | {
      name?: string;
      description?: string;
      avatar?: Avatar;
      folders?: string[];
      rules?: AssistantRules;
      coordinator?: { providerId: string; modelId: string; reasoningEffort: null };
    }
  | undefined {
  const patch: NonNullable<ReturnType<typeof botPatch>> = {};
  const name = edit.name.trim();
  if (name !== '' && name !== channel.title) patch.name = name;
  const assistant = channel.assistant;
  if (assistant !== undefined) {
    const description = edit.description.trim();
    if (description !== assistant.description) patch.description = description;
    const current = assistant.avatar;
    if (
      current.type !== edit.avatar.type ||
      current.color !== edit.avatar.color ||
      current.seed !== edit.avatar.seed
    )
      patch.avatar = edit.avatar;
    if (
      edit.folders.length !== assistant.folders.length ||
      edit.folders.some((folder, index) => folder !== assistant.folders[index])
    )
      patch.folders = [...edit.folders];
    // 整份交上去（同桌面）：认不出的种类原样留着。
    const rules = edit.rules ?? {};
    if (
      ASSISTANT_RULE_CATEGORIES.some(
        (c) => rules[c] !== undefined && rules[c] !== ruleTier(assistant.rules, c),
      )
    )
      patch.rules = { ...assistant.rules, ...rules };
  }
  const model = edit.model;
  const coordinator = channel.coordinator;
  if (
    model !== undefined &&
    coordinator !== undefined &&
    (model.providerId !== coordinator.providerId || model.modelId !== coordinator.modelId)
  )
    patch.coordinator = {
      providerId: model.providerId,
      modelId: model.modelId,
      reasoningEffort: null,
    };
  return Object.keys(patch).length === 0 ? undefined : patch;
}

/**
 * 建群或改群时交上去的名字与成员（成员按勾选的先后）：名字为空、成员不在 `GROUP_MEMBERS_MIN`–`GROUP_MEMBERS_MAX` 之间时 undefined；
 * 改群时只带变了的名字，成员整份替换，什么都没变时 undefined。
 */
export function groupPatch(
  group: Channel | undefined,
  name: string,
  members: readonly string[],
): { name?: string; members: string[] } | undefined {
  const trimmed = name.trim();
  if (trimmed === '' || members.length < GROUP_MEMBERS_MIN || members.length > GROUP_MEMBERS_MAX)
    return undefined;
  if (group === undefined) return { name: trimmed, members: [...members] };
  const before = group.group?.members ?? [];
  const renamed = trimmed !== group.title;
  if (!renamed && members.length === before.length && members.every((id, i) => id === before[i]))
    return undefined;
  return { ...(renamed && { name: trimmed }), members: [...members] };
}

/** 文件夹的最后一段与上一级目录（家目录写成 `~`）。 */
export function folderParts(path: string): { name: string; parent: string } {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const name = cut < 0 ? trimmed : trimmed.slice(cut + 1);
  const parent = cut <= 0 ? '' : trimmed.slice(0, cut);
  return { name: name || path, parent: parent.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~') };
}
