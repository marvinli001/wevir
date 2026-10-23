// 助理列表与各助理时间线的内存状态：界面从这里读、经这里写，背后是一个 `BotSource`（各台电脑的连接；电脑上的助理接口合入之前
// 是 state/bot-fixtures.ts 的样例数据）。时间线按 seq 存，往上翻时取更早的一页。

import type { Avatar } from './bot-avatar';
import { type Bot, type BotPost, type Decision, postPreview, sortBots } from './bots';

export const PAGE_SIZE = 20;

export type BotEvent =
  | { kind: 'bot'; bot: Bot }
  | { kind: 'post'; key: string; post: BotPost }
  | { kind: 'updated'; key: string; post: BotPost };

export interface NewBot {
  computer: string;
  name: string;
  description: string;
  avatar: Avatar;
}

export interface BotSource {
  list(): Promise<Bot[]>;
  /** 某条之前（不含）的最多 `limit` 条，按 seq 升序；不给 `beforeSeq` 时取最新的一页。 */
  posts(
    key: string,
    beforeSeq: number | undefined,
    limit: number,
  ): Promise<{ posts: BotPost[]; hasMore: boolean }>;
  post(key: string, text: string): Promise<BotPost>;
  /** 审批卡或提议卡的决定。 */
  decide(key: string, postId: string, decision: Exclude<Decision, 'pending'>): Promise<BotPost>;
  markRead(key: string): Promise<void>;
  create(input: NewBot): Promise<Bot>;
  subscribe(listener: (event: BotEvent) => void): () => void;
}

export interface Timeline {
  posts: readonly BotPost[];
  hasMore: boolean;
  loading: boolean;
  loadingOlder: boolean;
}

const EMPTY: Timeline = { posts: [], hasMore: false, loading: true, loadingOlder: false };

export class BotStore {
  private bots: Bot[] = [];
  private timelines = new Map<string, Timeline>();
  private listeners = new Set<() => void>();
  private loadedBots = false;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly source: BotSource) {}

  get loaded(): boolean {
    return this.loadedBots;
  }

  get list(): readonly Bot[] {
    return this.bots;
  }

  bot(key: string): Bot | undefined {
    return this.bots.find((b) => b.key === key);
  }

  timeline(key: string): Timeline {
    return this.timelines.get(key) ?? EMPTY;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    this.unsubscribe ??= this.source.subscribe((event) => this.apply(event));
    this.bots = sortBots(await this.source.list());
    this.loadedBots = true;
    this.emit();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** 打开一个助理：取最新一页，标为已读。 */
  async open(key: string): Promise<void> {
    if (!this.timelines.has(key)) {
      this.timelines.set(key, EMPTY);
      const page = await this.source.posts(key, undefined, PAGE_SIZE);
      this.timelines.set(key, {
        ...EMPTY,
        posts: page.posts,
        hasMore: page.hasMore,
        loading: false,
      });
      this.emit();
    }
    await this.markRead(key);
  }

  async markRead(key: string): Promise<void> {
    const bot = this.bot(key);
    if (bot === undefined || bot.unreadCount === 0) return;
    this.upsertBot({ ...bot, unreadCount: 0 });
    await this.source.markRead(key);
  }

  async loadOlder(key: string): Promise<void> {
    const timeline = this.timeline(key);
    if (timeline.loading || timeline.loadingOlder || !timeline.hasMore) return;
    this.setTimeline(key, { ...timeline, loadingOlder: true });
    try {
      const page = await this.source.posts(key, timeline.posts[0]?.seq, PAGE_SIZE);
      const current = this.timeline(key);
      this.setTimeline(key, {
        ...current,
        posts: merge(page.posts, current.posts),
        hasMore: page.hasMore,
        loadingOlder: false,
      });
    } catch (error) {
      this.setTimeline(key, { ...this.timeline(key), loadingOlder: false });
      throw error;
    }
  }

  async send(key: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === '') return;
    const post = await this.source.post(key, trimmed);
    this.apply({ kind: 'post', key, post });
  }

  async decide(key: string, postId: string, decision: Exclude<Decision, 'pending'>): Promise<void> {
    const post = await this.source.decide(key, postId, decision);
    this.apply({ kind: 'updated', key, post });
  }

  async create(input: NewBot): Promise<Bot> {
    const bot = await this.source.create(input);
    this.upsertBot(bot);
    return bot;
  }

  private apply(event: BotEvent): void {
    switch (event.kind) {
      case 'bot':
        this.upsertBot(event.bot);
        return;
      case 'post': {
        const timeline = this.timelines.get(event.key);
        if (timeline !== undefined) {
          this.timelines.set(event.key, {
            ...timeline,
            posts: merge(timeline.posts, [event.post]),
          });
        }
        const bot = this.bot(event.key);
        if (bot !== undefined) {
          this.upsertBot({
            ...bot,
            lastPost: { text: postPreview(event.post.card), at: event.post.createdAt },
          });
        } else {
          this.emit();
        }
        return;
      }
      case 'updated': {
        const timeline = this.timelines.get(event.key);
        if (timeline === undefined) return;
        this.setTimeline(event.key, {
          ...timeline,
          posts: timeline.posts.map((p) => (p.id === event.post.id ? event.post : p)),
        });
        return;
      }
    }
  }

  private upsertBot(bot: Bot): void {
    this.bots = sortBots([...this.bots.filter((b) => b.key !== bot.key), bot]);
    this.emit();
  }

  private setTimeline(key: string, timeline: Timeline): void {
    this.timelines.set(key, timeline);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** 按 seq 合并去重（新帖可能先由订阅推来，再由发帖的返回值到）。 */
function merge(a: readonly BotPost[], b: readonly BotPost[]): BotPost[] {
  const bySeq = new Map<number, BotPost>();
  for (const post of [...a, ...b]) bySeq.set(post.seq, post);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}
