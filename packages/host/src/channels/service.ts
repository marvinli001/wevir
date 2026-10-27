// 频道与助理（0.120.0，ADR-0020，domain-model §3.53）：一条时间线 + 一个常驻的协调者会话 + 一组线程。
//
// 时间线存在 SQLite（0026_channels），不进事件库。用户发帖后 Host 等 `wakeDelayMs`（连着发的合成一次），把这期间的帖子装进
// 唤醒信封（envelope.ts）发给当前的协调者会话；协调者忙时后来的帖子留在这个频道的待唤醒缓冲里，空下来后一次交出。协调者回合的
// 最后一段回答就是它的帖子（`replyTo` 指向信封里最后一条用户帖子），以 `NOTHING_TO_REPORT` 结尾时不开口；回合失败时 Host 写一条
// `notice: failed`。协调者会话第一次用到时才建，用到上下文的 60% 或累计 `ROTATE_WAKES` 次唤醒时换班：另开一个会话（`generation`
// 加一），首条消息是交接材料加这次的信封，旧会话关闭。
//
// 预算按本机时区的自然日记协调者的唤醒次数与 token；用完时暂停（`pauseReason: 'budget'`），帖子照收，第二天第一次有事要唤醒时
// 自动恢复。线程是普通的顶层会话（`Session.channel.role: 'thread'`），状态由会话推导。
//
// 列表行（`channels.changed`）与订阅（`channel.posted` / `channel.updated`）的变化在 `FLUSH_MS` 内合成一批，按指纹判断真变了没有。

import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type {
  ApprovalRequest,
  AssistantAvatar,
  AssistantRules,
  BoardTask,
  BoardTaskStatus,
  Channel,
  ChannelCard,
  ChannelCoordinator,
  ChannelId,
  ChannelPost,
  ChannelPostAuthor,
  ChannelPostId,
  ChannelThread,
  ChannelThreadStatus,
  ClientIdentity,
  MessageFrom,
  MethodParams,
  NotificationParams,
  Session,
  SessionChannel,
  SessionId,
  SharedFile,
  TurnId,
  TurnOutcome,
  UserContentPart,
  WevirEvent,
} from '@wevir/protocol';
import {
  ASSISTANT_AVATAR_COLOR_COUNT,
  ASSISTANT_AVATAR_TYPES,
  CHANNEL_POST_PREVIEW_MAX_LENGTH,
  CHANNEL_POST_TEXT_MAX_LENGTH,
  CHANNEL_POSTS_PAGE_MAX,
  CHANNEL_QUIET_MARKER,
  DEFAULT_ASSISTANT_BUDGET,
  DEFAULT_ASSISTANT_RULES,
} from '@wevir/protocol';
import type {
  ChannelPostRecord,
  ChannelRecord,
  ChannelThreadRecord,
  Storage,
} from '@wevir/storage';
import { HostError } from '../errors.js';
import { newId } from '../ids.js';
import { approvalSummary } from '../inbox.js';
import { redactSecrets } from '../secret-patterns.js';
import type { AssistantFolders } from './assistants.js';
import {
  HANDOVER_POSTS,
  handover,
  identityBlock,
  postText,
  relayEnvelope,
  type WakeInput,
  type WakeReason,
  wakeEnvelope,
} from './envelope.js';
import { plainPreviewLine } from './plain-preview.js';

/** 建助理时给它的晨间简报（0.121.0）：每天这个时刻（本机时区）。 */
export const MORNING_BRIEF_TIME = '08:00';

/** 晨间简报交给协调者的指令；卡片上的三张清单由 Host 组装（`<brief>`）。 */
export const MORNING_BRIEF_PROMPT =
  'Morning brief. Say in two or three lines what matters today for your job: anything due, anything new since yesterday, and what you need from the user.';

/** 建助理时 Host 替它建的晨间简报自动化。 */
export function morningBriefAutomation(channelId: ChannelId): MethodParams<'automation.create'> {
  return {
    title: 'Morning brief',
    prompt: MORNING_BRIEF_PROMPT,
    schedule: { kind: 'daily', time: MORNING_BRIEF_TIME },
    channelId,
    brief: true,
  };
}

/** 用户连着发帖时等多久再唤醒（ADR-0020 §9）。 */
export const WAKE_DELAY_MS = 3000;
/** 列表行与订阅的变化合一批的时间窗。 */
const FLUSH_MS = 100;
/** 一班协调者最多唤醒多少次就换班。 */
export const ROTATE_WAKES = 50;
/** 协调者的上下文用到多少就换班。 */
export const ROTATE_CONTEXT = 0.6;
/** 一个回合里 `wevir_channel_post` 等额外的帖子最多几条。 */
export const EXTRA_POSTS_PER_TURN = 5;
/** `channel.get` 带最近多少个已解决的线程。 */
const RESOLVED_THREADS_KEPT = 50;

/** 频道要用的会话操作（SessionManager 的一部分）。 */
export interface ChannelSessions {
  create(
    params: MethodParams<'session.create'>,
    options: { channel: SessionChannel },
  ): Promise<Session>;
  rename(sessionId: SessionId, title: string): Promise<unknown>;
  send(
    params: MethodParams<'session.send'>,
    sentBy: ClientIdentity,
    options?: { from?: MessageFrom },
  ): Promise<{ turnId?: TurnId; seq: number }>;
  close(sessionId: SessionId): Promise<void>;
}

/** 频道要用的事件库（EventStore 的一部分）。 */
export interface ChannelEvents {
  snapshot(sessionId: SessionId): ReturnType<import('../event-store.js').EventStore['snapshot']>;
  readSince(sessionId: SessionId, sinceSeq: number): WevirEvent[];
  listenAll(listener: (event: WevirEvent) => void): () => void;
}

/** 频道的共享任务清单（task-board.ts 的一部分）：根是频道 ID。 */
export interface ChannelTasks {
  list(root: SessionId): Promise<BoardTask[]>;
  update(
    root: SessionId,
    id: string,
    patch: { status: BoardTaskStatus },
    by: SessionId,
  ): Promise<unknown>;
}

export interface ChannelServiceOptions {
  storage: Storage;
  events: ChannelEvents;
  sessions: ChannelSessions;
  assistants: AssistantFolders;
  /** Host 代发消息用的身份。 */
  identity: ClientIdentity;
  tasks?: ChannelTasks;
  /** 建助理后第一步要的：本机有的连接器名字、有没有内置浏览器。 */
  inventory?: () => { connectors: string[]; browser: boolean };
  /** 协调者的 Provider 能不能挂 Wevir 工具；不给时都算能。 */
  canUseAppTools?: (providerId: string) => boolean;
  wakeDelayMs?: number;
  now?: () => number;
  /** 预算的自然日按哪个时区；省略是本机时区。 */
  timezone?: string;
  random?: () => number;
  /** 助理的日程（0.121.0，自动化）：建好后建晨间简报，删了一起删。 */
  schedules?: {
    created(channel: Channel): Promise<void>;
    deleted(channelId: ChannelId): Promise<void>;
  };
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
}

/** 存在 `coordinator` 列里、不出现在协议里的部分。 */
interface StoredCoordinator extends ChannelCoordinator {
  /** 这一班唤醒过几次。 */
  wakes?: number;
}

/** 待唤醒的缓冲。 */
interface PendingWake {
  reasons: Set<WakeReason>;
  posts: ChannelPost[];
  setup?: true;
  schedules: { title: string; prompt: string; brief?: boolean }[];
  /** 改了的设置：下次唤醒时附上新的身份与规矩。 */
  changed?: true;
  timer?: ReturnType<typeof setTimeout>;
}

/** 进行中的唤醒回合。 */
interface ActiveWake {
  sessionId: SessionId;
  turnId: TurnId;
  /** 信封那条 `user.message` 的 seq，摘回答时从这里往后读。 */
  seq: number;
  generation: number;
  replyTo?: ChannelPostId;
  /** 唤醒前会话的用量：引擎报的累计 token，与用量统计里的请求数和 token 合计（不含缓存读取）。 */
  tokensBefore: number;
  recordedBefore: { requests: number; tokens: number };
  extraPosts: number;
  /** 晨间简报：协调者这回合的回答带这张卡片（唤醒时组装）。 */
  brief?: Extract<ChannelCard, { kind: 'brief' }>;
}

/** 订阅者收到的。 */
export type ChannelSubscriptionMessage =
  | { kind: 'posted'; post: ChannelPost }
  | {
      kind: 'updated';
      update: Omit<NotificationParams<'channel.updated'>, 'subscriptionId'>;
    };

export type ChannelsChanged = NotificationParams<'channels.changed'>;

interface ViewParts {
  channel: Channel;
  threads: ChannelThread[];
  approvals: ApprovalRequest[];
  tasks: BoardTask[];
}

type CreateParams = MethodParams<'channel.create'>;
type UpdateParams = MethodParams<'channel.update'>;

function invalid(path: string, message: string): HostError<'INVALID_PARAMS'> {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path: [path], message }] });
}

function notFound(channelId: string): HostError<'CHANNEL_NOT_FOUND'> {
  return new HostError('CHANNEL_NOT_FOUND', `channel ${channelId} not found`);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

function fingerprint(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('base64');
}

/** 回合的回答：最后一行是 `NOTHING_TO_REPORT` 时去掉它，记 `quiet`。 */
export function postOfAnswer(text: string): { text: string; quiet: boolean } {
  const lines = text.trim().split('\n');
  const last = lines
    .at(-1)
    ?.trim()
    .replace(/^[*`]+|[*`.]+$/g, '');
  if (last !== CHANNEL_QUIET_MARKER) return { text: text.trim(), quiet: false };
  return { text: lines.slice(0, -1).join('\n').trim(), quiet: true };
}

/** 第一行文字（去掉 Markdown 记号），打码后截断；只有图片时 `[image]`。 */
function previewOf(post: Pick<ChannelPost, 'content' | 'card'>): string {
  const text = plainPreviewLine(postText(post));
  const shown = text === '' && post.card?.kind === 'suggestion' ? post.card.text : text;
  return clip(redactSecrets(shown.trim()).text, CHANNEL_POST_PREVIEW_MAX_LENGTH);
}

export class ChannelService {
  readonly #options: ChannelServiceOptions;
  readonly #storage: Storage;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #wakeDelayMs: number;
  readonly #pending = new Map<ChannelId, PendingWake>();
  readonly #active = new Map<ChannelId, ActiveWake>();
  /** 会话 → 它所在的频道（协调者各班与线程）。 */
  readonly #sessionChannel = new Map<
    SessionId,
    { channelId: ChannelId; role: SessionChannel['role'] }
  >();
  readonly #listListeners = new Set<(change: ChannelsChanged) => void>();
  readonly #postListeners = new Set<(channel: Channel, post: ChannelPost) => void>();
  readonly #subscribers = new Map<
    ChannelId,
    Set<{ listener: (message: ChannelSubscriptionMessage) => void; seen: Map<string, string> }>
  >();
  readonly #rowPrints = new Map<ChannelId, string>();
  readonly #dirty = new Set<ChannelId>();
  /** 正在建协调者会话的频道：两次唤醒不会各建一个。 */
  readonly #starting = new Map<ChannelId, Promise<void>>();
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #listVersion: number;
  #unlisten: (() => void) | undefined;
  #disposed = false;

  constructor(options: ChannelServiceOptions) {
    this.#options = options;
    this.#storage = options.storage;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#wakeDelayMs = options.wakeDelayMs ?? WAKE_DELAY_MS;
    this.#listVersion = this.#now();
  }

  /** 认出已有频道的会话，开始收事件。 */
  start(): void {
    for (const record of this.#storage.channels.list()) {
      const coordinator = record.coordinator as StoredCoordinator;
      if (coordinator.sessionId !== undefined) {
        this.#sessionChannel.set(coordinator.sessionId, {
          channelId: record.id as ChannelId,
          role: 'coordinator',
        });
      }
      for (const thread of this.#storage.channels.threads(record.id)) {
        this.#sessionChannel.set(thread.sessionId as SessionId, {
          channelId: record.id as ChannelId,
          role: 'thread',
        });
      }
    }
    this.#unlisten = this.#options.events.listenAll((event) => this.#onEvent(event));
  }

  dispose(): void {
    this.#disposed = true;
    this.#unlisten?.();
    for (const pending of this.#pending.values()) clearTimeout(pending.timer);
    clearTimeout(this.#flushTimer);
    this.#listListeners.clear();
    this.#subscribers.clear();
  }

  get listVersion(): number {
    return this.#listVersion;
  }

  /** 列表行的变化（`channels.changed`）。 */
  watch(listener: (change: ChannelsChanged) => void): () => void {
    this.#listListeners.add(listener);
    return () => this.#listListeners.delete(listener);
  }

  /** 所有频道的新帖（通知意图用，0.121.0）。 */
  watchPosts(listener: (channel: Channel, post: ChannelPost) => void): () => void {
    this.#postListeners.add(listener);
    return () => this.#postListeners.delete(listener);
  }

  /** 发给助理的自动化要的：助理的工作区与协调者的模型；助理不在时 `CHANNEL_NOT_FOUND`。 */
  scheduleTarget(channelId: string): {
    workspaceId: Channel['workspaceId'];
    providerId: string;
    modelId?: string;
    reasoningEffort?: string;
  } {
    const record = this.#record(channelId);
    const coordinator = record.coordinator as StoredCoordinator;
    return {
      workspaceId: record.workspaceId as Channel['workspaceId'],
      providerId: coordinator.providerId,
      ...(coordinator.modelId !== undefined && { modelId: coordinator.modelId }),
      ...(coordinator.reasoningEffort !== undefined && {
        reasoningEffort: coordinator.reasoningEffort,
      }),
    };
  }

  /** 订阅一个频道（`channel.subscribe`）：先补发 `afterSeq` 之后的帖子。 */
  subscribe(
    channelId: ChannelId,
    afterSeq: number | undefined,
    listener: (message: ChannelSubscriptionMessage) => void,
  ): { lastSeq: number; unsubscribe: () => void } {
    const record = this.#record(channelId);
    const entry = { listener, seen: new Map<string, string>() };
    const parts = this.#parts(record);
    entry.seen.set('channel', fingerprint(parts.channel));
    entry.seen.set('threads', fingerprint(parts.threads));
    entry.seen.set('approvals', fingerprint(parts.approvals));
    let set = this.#subscribers.get(channelId);
    if (set === undefined) {
      set = new Set();
      this.#subscribers.set(channelId, set);
    }
    set.add(entry);
    if (afterSeq !== undefined) {
      let cursor = afterSeq;
      for (;;) {
        const page = this.#storage.channels.posts(channelId, {
          afterSeq: cursor,
          limit: CHANNEL_POSTS_PAGE_MAX,
        });
        for (const post of page) listener({ kind: 'posted', post: this.#post(post) });
        if (page.length < CHANNEL_POSTS_PAGE_MAX) break;
        cursor = page.at(-1)?.seq ?? cursor;
      }
    }
    void this.#tasksOf(channelId).then((tasks) => entry.seen.set('tasks', fingerprint(tasks)));
    return {
      lastSeq: record.lastPostSeq,
      unsubscribe: () => {
        set.delete(entry);
        if (set.size === 0) this.#subscribers.delete(channelId);
      },
    };
  }

  // ── 读 ────────────────────────────────────────────────────────────────

  list(kind?: Channel['kind']): Channel[] {
    return this.#storage.channels
      .list()
      .filter((record) => kind === undefined || record.kind === kind)
      .map((record) => this.#channel(record));
  }

  async get(channelId: string): Promise<ViewParts> {
    const parts = this.#parts(this.#record(channelId));
    return { ...parts, tasks: await this.#tasksOf(parts.channel.id) };
  }

  posts(params: MethodParams<'channel.posts'>): { posts: ChannelPost[]; lastSeq: number } {
    const record = this.#record(params.channelId);
    const limit = params.limit ?? 50;
    const rows = this.#storage.channels.posts(record.id, {
      ...(params.beforeSeq !== undefined && { beforeSeq: params.beforeSeq }),
      ...(params.afterSeq !== undefined && { afterSeq: params.afterSeq }),
      limit,
    });
    return { posts: rows.map((row) => this.#post(row)), lastSeq: record.lastPostSeq };
  }

  /** 会话所在的频道与角色；不是频道里的会话时 `undefined`。 */
  channelOf(sessionId: SessionId): { channel: Channel; role: SessionChannel['role'] } | undefined {
    const entry = this.#entryOf(sessionId);
    if (entry === undefined) return undefined;
    const record = this.#storage.channels.get(entry.channelId);
    if (record === undefined || record.deletedAt !== undefined) return undefined;
    return { channel: this.#channel(record), role: entry.role };
  }

  /** 频道的线程（工具 `wevir_channel_status` 用）。 */
  threads(channelId: ChannelId): ChannelThread[] {
    return this.#threads(this.#record(channelId));
  }

  /** 任务清单的根是不是助理（只有用户能标完成）。 */
  isAssistantRoot(root: string): boolean {
    const record = this.#storage.channels.get(root);
    return record?.kind === 'assistant' && record.deletedAt === undefined;
  }

  // ── 建、改、删 ────────────────────────────────────────────────────────

  async create(params: CreateParams): Promise<Channel> {
    if (this.#storage.providers.get(params.coordinator.providerId) === undefined) {
      throw new HostError(
        'PROVIDER_NOT_FOUND',
        `provider ${params.coordinator.providerId} not found`,
      );
    }
    if (this.#options.canUseAppTools?.(params.coordinator.providerId) === false) {
      throw invalid('coordinator.providerId', 'this provider cannot use Wevir tools');
    }
    const folders = await this.#folders(params.folders ?? []);
    const id = newId('chn');
    const now = iso(this.#now());
    const name = params.name.trim();
    const { workspace, undo } = await this.#options.assistants.create(
      this.#storage,
      id,
      name,
      folders,
      now,
    );
    const coordinator: StoredCoordinator = {
      providerId: params.coordinator.providerId,
      ...(params.coordinator.modelId !== undefined && { modelId: params.coordinator.modelId }),
      ...(params.coordinator.reasoningEffort !== undefined && {
        reasoningEffort: params.coordinator.reasoningEffort,
      }),
      mode: 'act',
      generation: 1,
    };
    try {
      this.#storage.channels.insert({
        id,
        kind: 'assistant',
        workspaceId: workspace.id,
        title: name,
        assistant: {
          description: params.description.trim(),
          avatar: params.avatar ?? this.randomAvatar(),
          rules: { ...DEFAULT_ASSISTANT_RULES, ...params.rules },
          folders,
        },
        coordinator,
        budget: params.budget ?? DEFAULT_ASSISTANT_BUDGET,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      await undo().catch(() => undefined);
      throw error;
    }
    const record = this.#record(id);
    this.#touch(record.id as ChannelId);
    // 第一步（照 Grok）：按职责看要用的连接器、文件夹与浏览器登录，缺的列成“我需要什么”。
    this.#queueWake(record.id as ChannelId, 'setup', { setup: true, immediate: true });
    const channel = this.#channel(record);
    await this.#options.schedules?.created(channel).catch((error: unknown) =>
      this.#options.onWarning?.('assistant schedule not created', {
        channelId: id,
        error: errorMessage(error),
      }),
    );
    return channel;
  }

  /** 头像：从形状 × 颜色里随机抽一个。 */
  randomAvatar(): AssistantAvatar {
    const pick = (count: number) => Math.min(count - 1, Math.floor(this.#random() * count));
    return {
      type: ASSISTANT_AVATAR_TYPES[pick(ASSISTANT_AVATAR_TYPES.length)] ?? 'pebble',
      color: pick(ASSISTANT_AVATAR_COLOR_COUNT),
      seed: Math.round(this.#random() * 1000) / 1000,
    };
  }

  async update(params: UpdateParams): Promise<Channel> {
    const record = this.#record(params.channelId);
    const now = iso(this.#now());
    const coordinator = { ...(record.coordinator as StoredCoordinator) };
    if (params.coordinator !== undefined) {
      const next = params.coordinator;
      if (next.providerId !== undefined && next.providerId !== coordinator.providerId) {
        if (this.#storage.providers.get(next.providerId) === undefined) {
          throw new HostError('PROVIDER_NOT_FOUND', `provider ${next.providerId} not found`);
        }
        if (this.#options.canUseAppTools?.(next.providerId) === false) {
          throw invalid('coordinator.providerId', 'this provider cannot use Wevir tools');
        }
        // 换 Provider 等同换班：下次唤醒另开一个协调者会话。
        coordinator.providerId = next.providerId;
        delete coordinator.modelId;
        delete coordinator.reasoningEffort;
        coordinator.wakes = Number.MAX_SAFE_INTEGER;
      }
      if (next.modelId === null) delete coordinator.modelId;
      else if (next.modelId !== undefined) coordinator.modelId = next.modelId;
      if (next.reasoningEffort === null) delete coordinator.reasoningEffort;
      else if (next.reasoningEffort !== undefined)
        coordinator.reasoningEffort = next.reasoningEffort;
    }
    let assistant = record.assistant as Channel['assistant'];
    let identityChanged = false;
    if (assistant !== undefined) {
      assistant = structuredClone(assistant);
      if (params.description !== undefined) assistant.description = params.description.trim();
      if (params.avatar !== undefined) assistant.avatar = params.avatar;
      if (params.rules !== undefined) assistant.rules = { ...assistant.rules, ...params.rules };
      if (params.folders !== undefined) {
        assistant.folders = await this.#folders(params.folders);
        this.#storage.workspaces.setExtraFolders(record.workspaceId, assistant.folders, now);
      }
      identityChanged =
        params.description !== undefined ||
        params.rules !== undefined ||
        params.folders !== undefined ||
        (params.name !== undefined && params.name.trim() !== record.title);
    }
    const paused =
      params.paused === undefined
        ? undefined
        : params.paused
          ? { pausedAt: record.pausedAt ?? now, pauseReason: 'user' }
          : { pausedAt: null, pauseReason: null };
    this.#storage.channels.update(record.id, {
      ...(params.name !== undefined && { title: params.name.trim() }),
      ...(assistant !== undefined && { assistant }),
      coordinator,
      ...(params.budget !== undefined && { budget: params.budget }),
      ...(paused !== undefined && paused),
      updatedAt: now,
    });
    if (params.name !== undefined && params.name.trim() !== record.title) {
      this.#storage.workspaces.rename(record.workspaceId, params.name.trim(), now);
    }
    const channelId = record.id as ChannelId;
    if (identityChanged) this.#pendingFor(channelId).changed = true;
    this.#touch(channelId);
    // 恢复后把暂停期间收的帖子交出去。
    if (params.paused === false && record.pausedAt !== undefined) this.#scheduleFlush(channelId, 0);
    return this.#channel(this.#record(channelId));
  }

  async delete(channelId: string): Promise<void> {
    const record = this.#record(channelId);
    const id = record.id as ChannelId;
    this.#storage.channels.softDelete(id, iso(this.#now()));
    const pending = this.#pending.get(id);
    clearTimeout(pending?.timer);
    this.#pending.delete(id);
    this.#active.delete(id);
    const coordinator = (record.coordinator as StoredCoordinator).sessionId;
    if (coordinator !== undefined) {
      await this.#options.sessions.close(coordinator).catch(() => undefined);
    }
    this.#rowPrints.delete(id);
    this.#emitList({ upserted: [], removed: [id] });
    await this.#options.schedules?.deleted(id).catch((error: unknown) =>
      this.#options.onWarning?.('assistant schedules not removed', {
        channelId: id,
        error: errorMessage(error),
      }),
    );
  }

  // ── 时间线 ────────────────────────────────────────────────────────────

  /** 用户发帖（`channel.post`）：写进时间线，稍后唤醒协调者。 */
  post(params: MethodParams<'channel.post'>, client: ClientIdentity): ChannelPost {
    const record = this.#record(params.channelId);
    const author: ChannelPostAuthor =
      client.clientKind === 'mobile'
        ? { kind: 'user', deviceId: client.deviceId }
        : { kind: 'user' };
    const { post, created } = this.#append(record, {
      author,
      content: params.content,
      ...(params.clientPostId !== undefined && { clientPostId: params.clientPostId }),
    });
    if (created) {
      // 自己发的帖子之前的都算读过。
      this.#storage.channels.markRead(record.id, readerOf(client), post.seq);
      this.#queueWake(record.id as ChannelId, 'post', { post });
    }
    return post;
  }

  markRead(channelId: string, seq: number, client: ClientIdentity): void {
    const record = this.#record(channelId);
    this.#storage.channels.markRead(record.id, readerOf(client), Math.min(seq, record.lastPostSeq));
    this.#touch(record.id as ChannelId);
  }

  /** 手动唤醒（`channel.wake`）。 */
  wake(channelId: string): void {
    const record = this.#record(channelId);
    if (record.pausedAt !== undefined && record.pauseReason === 'user') {
      throw new HostError('INVALID_STATE', 'the channel is paused', { state: 'idle' });
    }
    this.#queueWake(record.id as ChannelId, 'manual', { immediate: true });
  }

  /** 定时唤醒（自动化的 `channelId` 目标）：`brief` 时协调者的回答成为晨间简报卡片。 */
  wakeForSchedule(
    channelId: string,
    schedule: { title: string; prompt: string; brief?: boolean },
  ): void {
    const record = this.#record(channelId);
    const pending = this.#pendingFor(record.id as ChannelId);
    pending.schedules.push(schedule);
    this.#queueWake(record.id as ChannelId, 'schedule', { immediate: true });
  }

  /** 立即换班（`channel.rotate`）：下一次唤醒用新的协调者会话。 */
  async rotate(channelId: string): Promise<Channel> {
    const record = this.#record(channelId);
    const id = record.id as ChannelId;
    if (this.#active.has(id)) {
      throw new HostError('INVALID_STATE', 'the coordinator is working', { state: 'running' });
    }
    await this.#startGeneration(record);
    this.#touch(id);
    return this.#channel(this.#record(id));
  }

  /** 采纳或忽略一条建议（`channel.respondSuggestion`）。 */
  respondSuggestion(
    params: MethodParams<'channel.respondSuggestion'>,
    client: ClientIdentity,
  ): ChannelPost {
    const record = this.#record(params.channelId);
    const row = this.#storage.channels.getPost(params.postId);
    const card = row?.card as ChannelCard | undefined;
    if (row === undefined || row.channelId !== record.id || card?.kind !== 'suggestion') {
      throw invalid('postId', 'this post is not a suggestion in this channel');
    }
    if (card.status !== 'open') throw invalid('postId', 'this suggestion was already answered');
    const status = params.accept ? 'accepted' : 'dismissed';
    this.#storage.channels.setCard(row.id, { ...card, status });
    const updated = this.#post({ ...row, card: { ...card, status } });
    this.#emitPostUpdate(record.id as ChannelId, updated);
    if (!params.accept) return updated;
    return this.post(
      {
        channelId: record.id as ChannelId,
        content: [{ type: 'text', text: card.text }],
        clientPostId: `suggestion:${row.id}`,
      },
      client,
    );
  }

  /** 用户改任务的状态（`channel.updateTask`）。 */
  async updateTask(params: MethodParams<'channel.updateTask'>): Promise<BoardTask[]> {
    const record = this.#record(params.channelId);
    const tasks = this.#options.tasks;
    if (tasks === undefined) throw invalid('taskId', 'this host has no task lists');
    const root = record.id as unknown as SessionId;
    try {
      await tasks.update(root, params.taskId, { status: params.status }, root);
    } catch (error) {
      throw invalid('taskId', errorMessage(error));
    }
    this.#touch(record.id as ChannelId);
    return this.#tasksOf(record.id as ChannelId);
  }

  /** 任务清单变了（task-board.ts 的 `onChange`，根是频道时）。 */
  tasksChanged(root: string): void {
    if (this.#storage.channels.get(root) !== undefined) this.#touch(root as ChannelId);
  }

  // ── 线程 ──────────────────────────────────────────────────────────────

  /**
   * 开线程：协调者用 `wevir_channel_start_thread`（`openedBy: 'coordinator'`），或用户在自己的帖子上开（`channel.startThread`）。首条消息是
   * 引用的用户原帖加简报。
   */
  async startThread(input: {
    channelId: string;
    rootPostId: string;
    citePostIds?: readonly string[];
    title?: string;
    brief?: string;
    openedBy: 'coordinator' | 'user';
    providerId?: string;
    modelId?: string;
    reasoningEffort?: string;
  }): Promise<ChannelThread> {
    const record = this.#record(input.channelId);
    const root = this.#storage.channels.getPost(input.rootPostId);
    if (root === undefined || root.channelId !== record.id) {
      throw invalid('rootPostId', 'no such post in this channel');
    }
    const citeIds = input.citePostIds?.length ? input.citePostIds : [root.id];
    const cited = citeIds.map((id) => {
      const post = this.#storage.channels.getPost(id);
      if (post === undefined || post.channelId !== record.id) {
        throw invalid('citePostIds', `no such post in this channel: ${id}`);
      }
      if ((post.author as ChannelPostAuthor).kind !== 'user') {
        throw invalid('citePostIds', `post ${id} is not the user's`);
      }
      return this.#post(post);
    });
    if (input.openedBy === 'user' && (root.author as ChannelPostAuthor).kind !== 'user') {
      throw invalid('rootPostId', "a thread can only start from the user's post");
    }
    const coordinator = record.coordinator as StoredCoordinator;
    const providerId = input.providerId ?? coordinator.providerId;
    if (this.#storage.providers.get(providerId) === undefined) {
      throw new HostError('PROVIDER_NOT_FOUND', `provider ${providerId} not found`);
    }
    const session = await this.#options.sessions.create(
      {
        workspaceId: record.workspaceId as Session['workspaceId'],
        providerId,
        ...((input.modelId ??
          (input.providerId === undefined ? coordinator.modelId : undefined)) !== undefined && {
          modelId: input.modelId ?? (coordinator.modelId as string),
        }),
        ...(input.reasoningEffort !== undefined && { reasoningEffort: input.reasoningEffort }),
      },
      { channel: { channelId: record.id as ChannelId, role: 'thread' } },
    );
    const now = iso(this.#now());
    const thread: ChannelThreadRecord = {
      sessionId: session.id,
      channelId: record.id,
      rootPostId: root.id,
      openedBy: input.openedBy,
      createdAt: now,
    };
    this.#storage.channels.insertThread(thread);
    this.#sessionChannel.set(session.id, { channelId: record.id as ChannelId, role: 'thread' });
    const title = clip(
      (input.title ?? postText(cited[0] ?? this.#post(root)).split('\n')[0] ?? '').trim() ||
        record.title,
      80,
    );
    await this.#options.sessions.rename(session.id, title).catch(() => undefined);
    const content = relayEnvelope(cited, input.brief);
    const sender = coordinator.sessionId ?? session.id;
    await this.#options.sessions.send(
      { sessionId: session.id, content, clientMessageId: `thread:${session.id}` },
      this.#options.identity,
      {
        from: {
          sessionId: sender,
          kind: 'message',
          channel: { channelId: record.id as ChannelId, kind: 'relay' },
        },
      },
    );
    this.#touch(record.id as ChannelId);
    return this.#thread(thread);
  }

  /** 把用户帖子转给本频道的一个线程（`wevir_channel_forward`）；转给已解决的即取消解决。 */
  async forward(input: {
    channelId: string;
    threadSessionId: string;
    citePostIds: readonly string[];
    note?: string;
  }): Promise<ChannelThread> {
    const record = this.#record(input.channelId);
    const thread = this.#storage.channels.getThread(input.threadSessionId);
    if (thread === undefined || thread.channelId !== record.id) {
      throw invalid('threadSessionId', 'not a thread of this channel');
    }
    const cited = input.citePostIds.map((id) => {
      const post = this.#storage.channels.getPost(id);
      if (
        post === undefined ||
        post.channelId !== record.id ||
        (post.author as ChannelPostAuthor).kind !== 'user'
      ) {
        throw invalid('citePostIds', `not a user post in this channel: ${id}`);
      }
      return post;
    });
    if (thread.resolvedAt !== undefined)
      this.#storage.channels.resolveThread(thread.sessionId, null);
    const coordinator =
      (record.coordinator as StoredCoordinator).sessionId ?? (thread.sessionId as SessionId);
    await this.#options.sessions.send(
      {
        sessionId: thread.sessionId as SessionId,
        content: relayEnvelope(
          cited.map((post) => this.#post(post)),
          input.note,
        ),
        delivery: 'queue',
      },
      this.#options.identity,
      {
        from: {
          sessionId: coordinator,
          kind: 'message',
          channel: { channelId: record.id as ChannelId, kind: 'relay' },
        },
      },
    );
    for (const post of cited) {
      const routed = [...new Set([...(post.routedTo ?? []), thread.sessionId])];
      this.#storage.channels.setRoutedTo(post.id, routed);
      this.#emitPostUpdate(record.id as ChannelId, this.#post({ ...post, routedTo: routed }));
    }
    this.#touch(record.id as ChannelId);
    return this.#thread(this.#storage.channels.getThread(thread.sessionId) ?? thread);
  }

  resolveThread(input: {
    channelId: string;
    sessionId: string;
    resolved: boolean;
    by: 'user' | 'coordinator' | 'thread';
  }): ChannelThread {
    const record = this.#record(input.channelId);
    const thread = this.#storage.channels.getThread(input.sessionId);
    if (thread === undefined || thread.channelId !== record.id) {
      throw new HostError(
        'SESSION_NOT_FOUND',
        `session ${input.sessionId} is not a thread of this channel`,
      );
    }
    this.#storage.channels.resolveThread(
      thread.sessionId,
      input.resolved ? { resolvedAt: iso(this.#now()), resolvedBy: input.by } : null,
    );
    this.#touch(record.id as ChannelId);
    return this.#thread(this.#storage.channels.getThread(thread.sessionId) ?? thread);
  }

  // ── 协调者额外的帖子（channel 工具） ────────────────────────────────────

  /** 协调者在回合里额外发一条（`wevir_channel_post` / `needs` / `suggest`）。 */
  postFromCoordinator(
    sessionId: SessionId,
    input: { text: string; card?: ChannelCard; replyTo?: string },
  ): ChannelPost {
    const entry = this.#entryOf(sessionId);
    if (entry?.role !== 'coordinator') throw invalid('sessionId', 'only the coordinator posts');
    const record = this.#record(entry.channelId);
    const active = this.#active.get(entry.channelId);
    if (active !== undefined && active.sessionId === sessionId) {
      if (active.extraPosts >= EXTRA_POSTS_PER_TURN) {
        throw invalid('text', `at most ${EXTRA_POSTS_PER_TURN} extra posts per turn`);
      }
      active.extraPosts += 1;
    }
    const coordinator = record.coordinator as StoredCoordinator;
    const replyTo =
      input.replyTo !== undefined &&
      this.#storage.channels.getPost(input.replyTo)?.channelId === record.id
        ? (input.replyTo as ChannelPostId)
        : undefined;
    return this.#append(record, {
      author: { kind: 'coordinator', sessionId, generation: coordinator.generation },
      content: [{ type: 'text', text: clip(input.text, CHANNEL_POST_TEXT_MAX_LENGTH) }],
      ...(input.card !== undefined && { card: input.card }),
      ...(replyTo !== undefined && { replyTo }),
    }).post;
  }

  // ── SessionManager 的回调 ─────────────────────────────────────────────

  /** SessionManager 的 `onTurnFinished`：协调者的回合 → 帖子；线程的 → 刷新卡片。 */
  onTurnFinished(info: { sessionId: SessionId; turnId: TurnId; outcome: TurnOutcome }): void {
    const entry = this.#entryOf(info.sessionId);
    if (entry === undefined) return;
    this.#touch(entry.channelId);
    if (entry.role !== 'coordinator') return;
    const active = this.#active.get(entry.channelId);
    if (
      active === undefined ||
      active.sessionId !== info.sessionId ||
      active.turnId !== info.turnId
    ) {
      // 用户在原始对话里自己说了一句：空下来后把攒着的交出去。
      if (this.#pending.has(entry.channelId)) this.#scheduleFlush(entry.channelId, 0);
      return;
    }
    this.#active.delete(entry.channelId);
    const record = this.#storage.channels.get(entry.channelId);
    if (record === undefined || record.deletedAt !== undefined) return;
    try {
      this.#finishWake(record, active, info.outcome);
    } catch (error) {
      this.#options.onWarning?.('channel post failed', { channelId: record.id, error });
    }
    if (this.#pending.has(entry.channelId)) this.#scheduleFlush(entry.channelId, 0);
  }

  // ── 内部：唤醒 ────────────────────────────────────────────────────────

  #pendingFor(channelId: ChannelId): PendingWake {
    let pending = this.#pending.get(channelId);
    if (pending === undefined) {
      pending = { reasons: new Set(), posts: [], schedules: [] };
      this.#pending.set(channelId, pending);
    }
    return pending;
  }

  #queueWake(
    channelId: ChannelId,
    reason: WakeReason,
    extra: { post?: ChannelPost; setup?: true; immediate?: true },
  ): void {
    const pending = this.#pendingFor(channelId);
    pending.reasons.add(reason);
    if (extra.post !== undefined) pending.posts.push(extra.post);
    if (extra.setup === true) pending.setup = true;
    this.#scheduleFlush(channelId, extra.immediate === true ? 0 : this.#wakeDelayMs);
    this.#touch(channelId);
  }

  #scheduleFlush(channelId: ChannelId, delayMs: number): void {
    const pending = this.#pending.get(channelId);
    if (pending === undefined || this.#disposed) return;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      void this.#flushWake(channelId).catch((error: unknown) =>
        this.#options.onWarning?.('channel wake failed', { channelId, error }),
      );
    }, delayMs);
    pending.timer.unref?.();
  }

  /**
   * 这次唤醒花了多少 token，算预算用：有用量统计时取请求的输入、缓存写入与输出，缓存读取不算（它占了协调者用量的大头，
   * 计价也只是零头）；引擎不报单次请求时退回引擎的累计 token 之差（含缓存读取）。
   */
  #wakeTokens(active: ActiveWake): number {
    const recorded = this.#storage.usage.sessionTotals(active.sessionId);
    if (recorded.requests > active.recordedBefore.requests) {
      return Math.max(0, recorded.tokens - active.recordedBefore.tokens);
    }
    const tokensAfter =
      this.#options.events.snapshot(active.sessionId)?.usage?.totalTokens ?? active.tokensBefore;
    return Math.max(0, tokensAfter - active.tokensBefore);
  }

  async #flushWake(channelId: ChannelId): Promise<void> {
    const pending = this.#pending.get(channelId);
    if (pending === undefined || pending.reasons.size === 0) return;
    if (this.#active.has(channelId) || this.#starting.has(channelId)) return;
    let record = this.#storage.channels.get(channelId);
    if (record === undefined || record.deletedAt !== undefined) {
      this.#pending.delete(channelId);
      return;
    }
    const day = this.#day();
    const budget = record.budget as Channel['budget'];
    const usage = this.#storage.channels.usage(channelId, day);
    const overBudget =
      (usage?.wakes ?? 0) >= budget.dailyWakes || (usage?.tokens ?? 0) >= budget.dailyTokens;
    if (record.pausedAt !== undefined) {
      if (record.pauseReason !== 'budget' || overBudget) return;
      // 新的一天：预算恢复。
      this.#storage.channels.update(channelId, {
        pausedAt: null,
        pauseReason: null,
        updatedAt: iso(this.#now()),
      });
      record = this.#record(channelId);
      this.#hostPost(record, { kind: 'notice', reason: 'resumed' });
    } else if (overBudget) {
      this.#storage.channels.update(channelId, {
        pausedAt: iso(this.#now()),
        pauseReason: 'budget',
        updatedAt: iso(this.#now()),
      });
      this.#hostPost(this.#record(channelId), { kind: 'notice', reason: 'budget' });
      return;
    }
    // 协调者会话：没有、不能用了、或到了换班的阈值时另开一班。
    let coordinator = record.coordinator as StoredCoordinator;
    let fresh = false;
    const session =
      coordinator.sessionId === undefined
        ? undefined
        : this.#options.events.snapshot(coordinator.sessionId);
    if (session === undefined || this.#needsRotation(coordinator, session)) {
      const starting = this.#startGeneration(record);
      this.#starting.set(channelId, starting);
      try {
        await starting;
      } catch (error) {
        this.#hostPost(
          this.#record(channelId),
          { kind: 'notice', reason: 'failed' },
          errorMessage(error),
        );
        this.#pending.delete(channelId);
        return;
      } finally {
        this.#starting.delete(channelId);
      }
      record = this.#record(channelId);
      coordinator = record.coordinator as StoredCoordinator;
      fresh = true;
    } else if (session.session.activeTurn !== undefined || session.session.state !== 'idle') {
      // 用户在原始对话里正让它做事：等这个回合结束。
      return;
    }
    const sessionId = coordinator.sessionId as SessionId;
    // 交出缓冲：之后到的帖子进新的缓冲。
    this.#pending.delete(channelId);
    clearTimeout(pending.timer);
    const channel = this.#channel(record);
    const input: WakeInput = {
      channel,
      reasons: pending.reasons,
      posts: pending.posts,
      threads: this.#threads(record),
      at: iso(this.#now()),
      ...(pending.setup === true && {
        setup: {
          ...(this.#options.inventory?.() ?? { connectors: [], browser: false }),
          folders: channel.assistant?.folders ?? [],
        },
      }),
      ...(pending.schedules.length > 0 && { schedules: pending.schedules }),
      ...(pending.changed === true && !fresh && { changed: identityBlock(channel) }),
    };
    const brief = pending.schedules.some((schedule) => schedule.brief === true)
      ? await this.#briefCard(record)
      : undefined;
    if (brief !== undefined) input.brief = brief;
    const content = wakeEnvelope(input);
    if (fresh) {
      const first = content[0];
      if (first?.type === 'text') {
        const recent = this.#storage.channels
          .posts(channelId, { limit: HANDOVER_POSTS })
          .map((row) => this.#post(row))
          .filter((post) => !pending.posts.some((p) => p.id === post.id));
        content[0] = {
          type: 'text',
          text: `${handover(channel, recent, coordinator.generation)}\n\n${first.text}`,
        };
      }
    }
    const tokensBefore = this.#options.events.snapshot(sessionId)?.usage?.totalTokens ?? 0;
    const recordedBefore = this.#storage.usage.sessionTotals(sessionId);
    const lastUserPost = pending.posts.findLast((post) => post.author.kind === 'user');
    try {
      const sent = await this.#options.sessions.send(
        { sessionId, content },
        this.#options.identity,
        { from: { sessionId, kind: 'report', channel: { channelId, kind: 'wake' } } },
      );
      if (sent.turnId === undefined) throw new Error('the coordinator did not start a turn');
      this.#active.set(channelId, {
        sessionId,
        turnId: sent.turnId,
        seq: sent.seq,
        generation: coordinator.generation,
        ...(lastUserPost !== undefined && { replyTo: lastUserPost.id }),
        tokensBefore,
        recordedBefore,
        extraPosts: 0,
        ...(brief !== undefined && { brief }),
      });
      this.#storage.channels.addUsage(channelId, day, { wakes: 1 });
      this.#storage.channels.update(channelId, {
        coordinator: { ...coordinator, wakes: (coordinator.wakes ?? 0) + 1 },
        updatedAt: iso(this.#now()),
      });
      this.#touch(channelId);
      // 很快的回合（echo）可能在 send 返回之前就结束了：照事件补上。
      this.#settle(channelId);
    } catch (error) {
      this.#hostPost(
        this.#record(channelId),
        { kind: 'notice', reason: 'failed' },
        errorMessage(error),
      );
    }
  }

  /** 回合在登记之前就已经结束：照事件结掉。 */
  #settle(channelId: ChannelId): void {
    const active = this.#active.get(channelId);
    if (active === undefined) return;
    const snapshot = this.#options.events.snapshot(active.sessionId);
    if (snapshot?.session.activeTurn?.turnId === active.turnId) return;
    const finished = this.#options.events
      .readSince(active.sessionId, active.seq)
      .find(
        (event): event is Extract<WevirEvent, { type: 'turn.finished' }> =>
          event.type === 'turn.finished' && event.payload.turnId === active.turnId,
      );
    if (finished !== undefined) {
      this.onTurnFinished({
        sessionId: active.sessionId,
        turnId: active.turnId,
        outcome: finished.payload.outcome,
      });
    }
  }

  #needsRotation(
    coordinator: StoredCoordinator,
    snapshot: NonNullable<ReturnType<ChannelEvents['snapshot']>>,
  ): boolean {
    const { session, usage } = snapshot;
    if (session.state === 'closed' || session.state === 'error' || session.readOnly !== undefined)
      return true;
    if ((coordinator.wakes ?? 0) >= ROTATE_WAKES) return true;
    return (
      usage !== undefined &&
      usage.contextSize > 0 &&
      usage.contextUsed / usage.contextSize >= ROTATE_CONTEXT
    );
  }

  /** 另开一班协调者：新会话（`generation` 加一，第一班是 1），旧会话关闭。 */
  async #startGeneration(record: ChannelRecord): Promise<void> {
    const current = record.coordinator as StoredCoordinator;
    const generation =
      current.sessionId === undefined ? current.generation : current.generation + 1;
    const session = await this.#options.sessions.create(
      {
        workspaceId: record.workspaceId as Session['workspaceId'],
        providerId: current.providerId,
        ...(current.modelId !== undefined && { modelId: current.modelId }),
        ...(current.reasoningEffort !== undefined && { reasoningEffort: current.reasoningEffort }),
      },
      { channel: { channelId: record.id as ChannelId, role: 'coordinator' } },
    );
    this.#sessionChannel.set(session.id, {
      channelId: record.id as ChannelId,
      role: 'coordinator',
    });
    // 标题由用户定（不再生成），排查时认得出是哪一班。
    await this.#options.sessions
      .rename(session.id, `${record.title} · ${generation}`)
      .catch(() => undefined);
    const latest = this.#record(record.id);
    const next: StoredCoordinator = {
      ...(latest.coordinator as StoredCoordinator),
      sessionId: session.id,
      generation,
      wakes: 0,
    };
    this.#storage.channels.update(record.id, { coordinator: next, updatedAt: iso(this.#now()) });
    if (current.sessionId !== undefined && current.sessionId !== session.id) {
      await this.#options.sessions.close(current.sessionId).catch(() => undefined);
    }
  }

  #finishWake(record: ChannelRecord, active: ActiveWake, outcome: TurnOutcome): void {
    const events = this.#options.events.readSince(active.sessionId, active.seq);
    let answer: string | undefined;
    const files: SharedFile[] = [];
    for (const event of events) {
      if (event.type === 'assistant.message' && event.payload.turnId === active.turnId) {
        answer = event.payload.text;
      }
      if (
        event.type === 'file.shared' &&
        (event.payload.turnId ?? active.turnId) === active.turnId
      ) {
        files.push(...event.payload.files);
      }
    }
    const spent = this.#wakeTokens(active);
    if (spent > 0) this.#storage.channels.addUsage(record.id, this.#day(), { tokens: spent });
    if (outcome === 'failed') {
      const message = this.#options.events.snapshot(active.sessionId)?.session.lastError?.message;
      this.#hostPost(record, { kind: 'notice', reason: 'failed' }, message);
      return;
    }
    if (outcome !== 'completed') return;
    const { text, quiet } = postOfAnswer(answer ?? '');
    if (active.brief === undefined && (quiet || (text === '' && files.length === 0))) return;
    this.#append(record, {
      author: { kind: 'coordinator', sessionId: active.sessionId, generation: active.generation },
      content: [{ type: 'text', text: clip(text, CHANNEL_POST_TEXT_MAX_LENGTH) }],
      ...(active.replyTo !== undefined && { replyTo: active.replyTo }),
      ...(files.length > 0 && { files }),
      ...(active.brief !== undefined && { card: active.brief }),
    });
  }

  /**
   * 晨间简报卡片（0.121.0）：今天的待办（清单里没完成的）、过去 24 小时完成的（任务与解决的线程）、等用户决定的（待处理的审批、
   * 等用户的线程、没回应的建议）。每类至多 20 条。
   */
  async #briefCard(record: ChannelRecord): Promise<Extract<ChannelCard, { kind: 'brief' }>> {
    const channelId = record.id as ChannelId;
    const since = this.#now() - 24 * 60 * 60_000;
    const recent = (at: string | undefined) => at !== undefined && Date.parse(at) >= since;
    const tasks = await this.#tasksOf(channelId);
    const threads = this.#threads(record);
    const item = (title: string, sessionId?: SessionId) => ({
      title: clip(title.trim() || '…', 200),
      ...(sessionId !== undefined && { sessionId }),
    });
    const todo = tasks
      .filter((task) => task.status === 'pending' || task.status === 'in_progress')
      .map((task) => item(task.subject, task.owner));
    const done = [
      ...tasks
        .filter((task) => task.status === 'completed' && recent(task.updatedAt))
        .map((task) => item(task.subject, task.owner)),
      ...threads
        .filter((thread) => thread.status === 'resolved' && recent(thread.resolvedAt))
        .map((thread) => item(thread.title, thread.sessionId)),
    ];
    const suggestions = this.#storage.channels
      .posts(channelId, { limit: 50 })
      .map((row) => row.card as ChannelCard | undefined)
      .filter(
        (card): card is Extract<ChannelCard, { kind: 'suggestion' }> =>
          card?.kind === 'suggestion' && card.status === 'open',
      );
    const decisions = [
      ...this.#approvals(record).map((approval) =>
        item(approvalSummary(approval), approval.sessionId),
      ),
      ...threads
        .filter((thread) => thread.status === 'waiting')
        .map((thread) => item(thread.title, thread.sessionId)),
      ...suggestions.map((card) => item(card.text)),
    ];
    return {
      kind: 'brief',
      day: this.#day(),
      todo: todo.slice(0, 20),
      done: done.slice(0, 20),
      decisions: decisions.slice(0, 20),
    };
  }

  // ── 内部：帖子 ────────────────────────────────────────────────────────

  #append(
    record: ChannelRecord,
    input: {
      author: ChannelPostAuthor;
      content: UserContentPart[];
      card?: ChannelCard | undefined;
      replyTo?: ChannelPostId;
      files?: SharedFile[];
      clientPostId?: string;
    },
  ): { post: ChannelPost; created: boolean } {
    const { post: row, created } = this.#storage.channels.appendPost({
      channelId: record.id,
      id: newId('cpo'),
      author: input.author,
      content: input.content,
      ...(input.replyTo !== undefined && { replyTo: input.replyTo }),
      ...(input.card !== undefined && { card: input.card }),
      ...(input.files !== undefined && { files: input.files }),
      ...(input.clientPostId !== undefined && { clientPostId: input.clientPostId }),
      createdAt: iso(this.#now()),
    });
    const post = this.#post(row);
    if (created) {
      for (const subscriber of this.#subscribers.get(record.id as ChannelId) ?? []) {
        try {
          subscriber.listener({ kind: 'posted', post });
        } catch (error) {
          this.#options.onWarning?.('channel subscriber failed', { error });
        }
      }
      this.#touch(record.id as ChannelId);
      if (this.#postListeners.size > 0) {
        const channel = this.#channel(record);
        for (const listener of this.#postListeners) {
          try {
            listener(channel, post);
          } catch (error) {
            this.#options.onWarning?.('channel post listener failed', { error });
          }
        }
      }
    }
    return { post, created };
  }

  #hostPost(record: ChannelRecord, card: ChannelCard, text?: string): void {
    this.#append(record, {
      author: { kind: 'host' },
      content: [
        { type: 'text', text: text === undefined ? '' : clip(redactSecrets(text).text, 2000) },
      ],
      card,
    });
  }

  #emitPostUpdate(channelId: ChannelId, post: ChannelPost): void {
    for (const subscriber of this.#subscribers.get(channelId) ?? []) {
      try {
        subscriber.listener({ kind: 'updated', update: { posts: [post] } });
      } catch (error) {
        this.#options.onWarning?.('channel subscriber failed', { error });
      }
    }
  }

  #post(row: ChannelPostRecord): ChannelPost {
    return {
      id: row.id as ChannelPostId,
      channelId: row.channelId as ChannelId,
      seq: row.seq,
      author: row.author as ChannelPostAuthor,
      content: row.content as UserContentPart[],
      ...(row.replyTo !== undefined && { replyTo: row.replyTo as ChannelPostId }),
      ...(row.routedTo !== undefined && { routedTo: row.routedTo as SessionId[] }),
      ...(row.card !== undefined && { card: row.card as ChannelCard }),
      ...(row.files !== undefined && { files: row.files as SharedFile[] }),
      ...(row.clientPostId !== undefined && { clientPostId: row.clientPostId }),
      createdAt: row.createdAt,
    };
  }

  // ── 内部：视图 ────────────────────────────────────────────────────────

  #record(channelId: string): ChannelRecord {
    const record = this.#storage.channels.get(channelId);
    if (record === undefined || record.deletedAt !== undefined) throw notFound(channelId);
    return record;
  }

  #entryOf(
    sessionId: SessionId,
  ): { channelId: ChannelId; role: SessionChannel['role'] } | undefined {
    const known = this.#sessionChannel.get(sessionId);
    if (known !== undefined) return known;
    const origin = this.#storage.sessions.get(sessionId)?.origin;
    if (origin?.kind !== 'channel') return undefined;
    const entry = {
      channelId: origin.channelId as ChannelId,
      role: origin.channelRole === 'thread' ? ('thread' as const) : ('coordinator' as const),
    };
    this.#sessionChannel.set(sessionId, entry);
    return entry;
  }

  #parts(record: ChannelRecord): Omit<ViewParts, 'tasks'> {
    const threads = this.#threads(record);
    return {
      channel: this.#channel(record, threads),
      threads,
      approvals: this.#approvals(record),
    };
  }

  /** 协调者与没解决的线程待处理的审批。 */
  #approvals(record: ChannelRecord, threads = this.#threads(record)): ApprovalRequest[] {
    const coordinator = (record.coordinator as StoredCoordinator).sessionId;
    const sessions = [
      ...(coordinator === undefined ? [] : [coordinator]),
      ...threads.filter((thread) => thread.status !== 'resolved').map((thread) => thread.sessionId),
    ];
    return sessions.flatMap((sessionId) => [
      ...(this.#options.events.snapshot(sessionId)?.pendingApprovals ?? []),
    ]);
  }

  async #tasksOf(channelId: ChannelId): Promise<BoardTask[]> {
    try {
      return (await this.#options.tasks?.list(channelId as unknown as SessionId)) ?? [];
    } catch {
      return [];
    }
  }

  #channel(record: ChannelRecord, threads = this.#threads(record)): Channel {
    const { wakes: _wakes, ...coordinator } = record.coordinator as StoredCoordinator;
    const usage = this.#storage.channels.usage(record.id, this.#day());
    const last = this.#storage.channels.posts(record.id, { limit: 1 })[0];
    const unread = this.#storage.channels.countUnread(
      record.id,
      this.#storage.channels.seenSeq(record.id),
    );
    let pending = 0;
    let working =
      this.#active.has(record.id as ChannelId) || this.#starting.has(record.id as ChannelId);
    const sessions = [
      ...(coordinator.sessionId === undefined ? [] : [coordinator.sessionId]),
      ...threads.filter((thread) => thread.status !== 'resolved').map((thread) => thread.sessionId),
    ];
    for (const sessionId of sessions) {
      const snapshot = this.#options.events.snapshot(sessionId);
      if (snapshot === undefined) continue;
      pending += snapshot.pendingApprovals.length + (snapshot.pendingQuestions?.length ?? 0);
      if (snapshot.session.activeTurn !== undefined) working = true;
    }
    const queued = this.#pending.get(record.id as ChannelId);
    if (queued !== undefined && queued.reasons.size > 0 && record.pausedAt === undefined)
      working = true;
    const state: Channel['state'] =
      record.pausedAt !== undefined
        ? 'paused'
        : pending > 0
          ? 'waiting'
          : working
            ? 'working'
            : 'idle';
    const lastPost = last === undefined ? undefined : this.#post(last);
    return {
      id: record.id as ChannelId,
      kind: record.kind as Channel['kind'],
      workspaceId: record.workspaceId as Channel['workspaceId'],
      title: record.title,
      ...(record.assistant !== undefined && {
        assistant: record.assistant as Channel['assistant'],
      }),
      coordinator,
      budget: record.budget as Channel['budget'],
      ...(usage !== undefined && { usage }),
      ...(record.pausedAt !== undefined && { pausedAt: record.pausedAt }),
      ...(record.pauseReason !== undefined && {
        pauseReason: record.pauseReason as NonNullable<Channel['pauseReason']>,
      }),
      state,
      ...(pending > 0 && { pendingCount: pending }),
      lastPostSeq: record.lastPostSeq,
      ...(lastPost !== undefined && {
        lastPost: {
          seq: lastPost.seq,
          author: lastPost.author.kind,
          preview: previewOf(lastPost),
          at: lastPost.createdAt,
        },
      }),
      ...(unread > 0 && { unreadCount: unread }),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  #threads(record: ChannelRecord): ChannelThread[] {
    const rows = this.#storage.channels.threads(record.id);
    const open = rows.filter((row) => row.resolvedAt === undefined);
    const resolved = rows
      .filter((row) => row.resolvedAt !== undefined)
      .slice(0, RESOLVED_THREADS_KEPT);
    return [...open, ...resolved].map((row) => this.#thread(row));
  }

  #thread(row: ChannelThreadRecord): ChannelThread {
    const sessionId = row.sessionId as SessionId;
    const snapshot = this.#options.events.snapshot(sessionId);
    let replyCount = 0;
    let lastReply: ChannelThread['lastReply'];
    let answer: string | undefined;
    for (const event of this.#options.events.readSince(sessionId, 0)) {
      if (event.type === 'assistant.message') answer = event.payload.text;
      if (event.type === 'turn.started') answer = undefined;
      if (event.type === 'turn.finished' && event.payload.outcome === 'completed') {
        replyCount += 1;
        if (answer !== undefined) {
          const line = answer.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
          lastReply = { at: event.ts, firstLine: clip(redactSecrets(line.trim()).text, 200) };
        }
      }
    }
    const session = snapshot?.session;
    let status: ChannelThreadStatus = 'idle';
    if (row.resolvedAt !== undefined) status = 'resolved';
    else if (
      snapshot !== undefined &&
      (snapshot.pendingApprovals.length > 0 || (snapshot.pendingQuestions?.length ?? 0) > 0)
    )
      status = 'waiting';
    else if (session?.activeTurn !== undefined) status = 'working';
    else if (session?.state === 'error' || session?.readOnly !== undefined || session === undefined)
      status = 'failed';
    else if (replyCount > 0) status = 'replied';
    const doing =
      status === 'working'
        ? snapshot?.todos?.find((todo) => todo.status === 'in_progress')?.content
        : undefined;
    return {
      sessionId,
      channelId: row.channelId as ChannelId,
      rootPostId: row.rootPostId as ChannelPostId,
      title: session?.title ?? '',
      status,
      ...(doing !== undefined && { doing: clip(doing, 200) }),
      replyCount,
      ...(lastReply !== undefined && { lastReply }),
      openedBy: row.openedBy === 'user' ? 'user' : 'coordinator',
      ...(row.resolvedAt !== undefined && { resolvedAt: row.resolvedAt }),
      ...(row.resolvedBy !== undefined && {
        resolvedBy: row.resolvedBy as NonNullable<ChannelThread['resolvedBy']>,
      }),
      createdAt: row.createdAt,
    };
  }

  // ── 内部：变化推送 ────────────────────────────────────────────────────

  #onEvent(event: WevirEvent): void {
    if (event.type === 'assistant.delta' || event.type === 'plan.delta') return;
    const entry = this.#entryOf(event.sessionId);
    if (entry === undefined) return;
    switch (event.type) {
      case 'turn.started':
      case 'turn.finished':
      case 'approval.requested':
      case 'approval.resolved':
      case 'question.requested':
      case 'question.resolved':
      case 'session.state_changed':
      case 'session.title_changed':
      case 'todo.updated':
        this.#touch(entry.channelId);
        break;
      default:
    }
  }

  #touch(channelId: ChannelId): void {
    if (this.#disposed) return;
    this.#dirty.add(channelId);
    if (this.#flushTimer !== undefined) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = undefined;
      void this.#flushChanges().catch((error: unknown) =>
        this.#options.onWarning?.('channel change push failed', { error }),
      );
    }, FLUSH_MS);
    this.#flushTimer.unref?.();
  }

  async #flushChanges(): Promise<void> {
    const ids = [...this.#dirty];
    this.#dirty.clear();
    const upserted: Channel[] = [];
    for (const channelId of ids) {
      const record = this.#storage.channels.get(channelId);
      if (record === undefined || record.deletedAt !== undefined) continue;
      const parts = this.#parts(record);
      const { updatedAt: _updatedAt, ...stable } = parts.channel;
      const print = fingerprint(stable);
      if (this.#rowPrints.get(channelId) !== print) {
        this.#rowPrints.set(channelId, print);
        upserted.push(parts.channel);
      }
      const subscribers = this.#subscribers.get(channelId);
      if (subscribers === undefined || subscribers.size === 0) continue;
      const tasks = await this.#tasksOf(channelId);
      const current = {
        channel: parts.channel,
        threads: parts.threads,
        approvals: parts.approvals,
        tasks,
      };
      for (const subscriber of subscribers) {
        const update: Omit<NotificationParams<'channel.updated'>, 'subscriptionId'> = {};
        for (const key of ['channel', 'threads', 'approvals', 'tasks'] as const) {
          const value = key === 'channel' ? stable : current[key];
          const print = fingerprint(value);
          if (subscriber.seen.get(key) === print) continue;
          subscriber.seen.set(key, print);
          (update as Record<string, unknown>)[key] = current[key];
        }
        if (Object.keys(update).length === 0) continue;
        try {
          subscriber.listener({ kind: 'updated', update });
        } catch (error) {
          this.#options.onWarning?.('channel subscriber failed', { error });
        }
      }
    }
    if (upserted.length > 0) this.#emitList({ upserted, removed: [] });
  }

  #emitList(change: { upserted: Channel[]; removed: ChannelId[] }): void {
    this.#listVersion += 1;
    const message: ChannelsChanged = { listVersion: this.#listVersion, ...change };
    for (const listener of [...this.#listListeners]) {
      try {
        listener(message);
      } catch (error) {
        this.#options.onWarning?.('channel list listener failed', { error });
      }
    }
  }

  // ── 内部：杂项 ────────────────────────────────────────────────────────

  /** 本机时区（或 `timezone`）的 `YYYY-MM-DD`。 */
  #day(): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.#options.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(this.#now()));
    return parts;
  }

  /** 授权的文件夹：绝对路径、存在、是目录，返回 realpath（去重）。 */
  async #folders(paths: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const path of paths) {
      let real: string;
      try {
        real = await realpath(path);
        if (!(await stat(real)).isDirectory()) throw new Error('not a directory');
      } catch {
        throw invalid('folders', `not a folder: ${path}`);
      }
      if (this.#options.assistants.owns(real)) throw invalid('folders', `not a folder: ${path}`);
      if (!out.includes(real)) out.push(real);
    }
    return out;
  }
}

/** 读过到哪按读者记：远程设备各一份，本机客户端共用一份。 */
function readerOf(client: ClientIdentity): string {
  return client.clientKind === 'mobile' ? client.deviceId : 'local';
}

export type { AssistantRules };
