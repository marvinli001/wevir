// 助理列表与各助理时间线的内存状态：界面从这里读、经这里写。背后是各台电脑的连接（`ChannelClient`，Host 0.120.0 的 `channel.*`）：
// 每台连上就读 `channel.list` 并跟着 `channels.changed` 改；打开一个助理时订阅它（`channel.subscribe`），取最新一页帖子与线程、审批，
// 之后收 `channel.posted` / `channel.updated`。连接断了助理留在列表里，重连上之后重读列表、按最后一条的 seq 重订打开过的。

import type { ChannelPosted, ChannelsChange, ChannelUpdate, WevirClient } from '@wevir/client-sdk';
import type { Channel, ChannelPost } from '@wevir/protocol';
import type { Avatar } from './bot-avatar';
import { type Bot, botFromChannel, botKey, sortBots, type TimelineParts } from './bots';

export const PAGE_SIZE = 30;
/** 订阅结果回来之前先到的推送最多留几条。 */
const EARLY_MAX = 500;

/** 一台电脑上的频道接口（`WevirClient` 的一部分）。Host 没有 `channels` 功能或这台设备不能读会话时没有。 */
export interface ChannelClient {
  /** 能在这台电脑上建助理（`workspace.write` 与 `provider.read`；手机默认没有）。 */
  readonly canCreate: boolean;
  request: WevirClient['request'];
  onChannelsChanged(listener: (change: ChannelsChange | undefined) => void): () => void;
  onChannelPosted(listener: (posted: ChannelPosted) => void): () => void;
  onChannelUpdated(listener: (update: ChannelUpdate) => void): () => void;
}

/** 一台配对过的电脑；离线时没有 `client`。 */
export interface BotHost {
  computer: string;
  computerName: string;
  client: ChannelClient | undefined;
}

export interface NewBot {
  computer: string;
  name: string;
  description: string;
  avatar: Avatar;
}

export interface Timeline extends TimelineParts {
  loading: boolean;
  loadingOlder: boolean;
}

const EMPTY: Timeline = {
  posts: [],
  threads: [],
  approvals: [],
  decided: [],
  hasMore: false,
  loading: true,
  loadingOlder: false,
};

interface HostState {
  computer: string;
  computerName: string;
  client: ChannelClient | undefined;
  channels: Map<string, Channel>;
  listVersion: number | undefined;
  stops: Array<() => void>;
  /** subscriptionId → 频道 ID。 */
  subs: Map<string, string>;
  early: Array<ChannelPosted | ChannelUpdate>;
  /** 换连接时加一，旧连接的结果据此作废。 */
  generation: number;
}

export class BotStore {
  private hosts = new Map<string, HostState>();
  private bots: Bot[] = [];
  private timelines = new Map<string, Timeline>();
  private opened = new Set<string>();
  private readSeq = new Map<string, number>();
  private listeners = new Set<() => void>();
  private loadedHosts = new Set<string>();

  /** 至少一台在线的电脑读过列表（或者一台都没有）。 */
  get loaded(): boolean {
    const online = [...this.hosts.values()].filter((h) => h.client !== undefined);
    return online.length === 0 || online.some((h) => this.loadedHosts.has(h.computer));
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

  /** 能建助理的电脑。 */
  creators(): { computer: string; name: string }[] {
    return [...this.hosts.values()]
      .filter((h) => h.client?.canCreate === true)
      .map((h) => ({ computer: h.computer, name: h.computerName }));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 配对的电脑或它们的连接变了。不在里面的电脑连同它的助理一起去掉。 */
  setHosts(hosts: readonly BotHost[]): void {
    const names = new Set(hosts.map((h) => h.computer));
    let changed = false;
    for (const [computer, state] of this.hosts) {
      if (names.has(computer)) continue;
      this.detach(state);
      this.hosts.delete(computer);
      this.loadedHosts.delete(computer);
      for (const key of [...this.timelines.keys()]) {
        if (key.startsWith(`${computer}/`)) {
          this.timelines.delete(key);
          this.opened.delete(key);
        }
      }
      changed = true;
    }
    for (const host of hosts) {
      let state = this.hosts.get(host.computer);
      if (state === undefined) {
        state = {
          computer: host.computer,
          computerName: host.computerName,
          client: undefined,
          channels: new Map(),
          listVersion: undefined,
          stops: [],
          subs: new Map(),
          early: [],
          generation: 0,
        };
        this.hosts.set(host.computer, state);
        changed = true;
      }
      if (state.computerName !== host.computerName) {
        state.computerName = host.computerName;
        changed = true;
      }
      if (state.client !== host.client) {
        this.detach(state);
        if (host.client !== undefined) this.attach(state, host.client);
        changed = true;
      }
    }
    if (changed) this.rebuild();
  }

  /** 打开一个助理：订阅，取最新一页、线程与审批。 */
  async open(key: string): Promise<void> {
    if (this.opened.has(key)) return;
    this.opened.add(key);
    if (!this.timelines.has(key)) this.timelines.set(key, EMPTY);
    const target = this.target(key);
    if (target !== undefined) await this.follow(target.state, target.channelId);
  }

  /** 读到时间线上的最后一条。 */
  async markRead(key: string): Promise<void> {
    const target = this.target(key);
    const client = target?.state.client;
    if (target === undefined || client === undefined) return;
    const channel = target.state.channels.get(target.channelId);
    const seq = this.timeline(key).posts.at(-1)?.seq ?? channel?.lastPostSeq ?? 0;
    if (seq <= (this.readSeq.get(key) ?? 0)) return;
    this.readSeq.set(key, seq);
    if (channel?.unreadCount !== undefined) {
      const { unreadCount: _unread, ...rest } = channel;
      target.state.channels.set(target.channelId, rest);
      this.rebuild();
    }
    await client.request('channel.markRead', {
      channelId: target.channelId as Channel['id'],
      seq,
    });
  }

  async loadOlder(key: string): Promise<void> {
    const timeline = this.timeline(key);
    const first = timeline.posts[0]?.seq;
    if (timeline.loading || timeline.loadingOlder || !timeline.hasMore || first === undefined)
      return;
    const { channelId, client } = this.connected(key);
    this.setTimeline(key, { ...timeline, loadingOlder: true });
    try {
      const page = await client.request('channel.posts', {
        channelId,
        beforeSeq: first,
        limit: PAGE_SIZE,
      });
      const current = this.timeline(key);
      this.setTimeline(key, {
        ...current,
        posts: merge(page.posts, current.posts),
        hasMore: hasEarlier(page.posts, page.posts.length < PAGE_SIZE),
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
    const { channelId, client } = this.connected(key);
    const { post } = await client.request('channel.post', {
      channelId,
      content: [{ type: 'text', text: trimmed }],
      clientPostId: `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    });
    this.addPosts(key, [post]);
  }

  /** 采纳或忽略助理的提议。 */
  async respondSuggestion(key: string, postId: string, accept: boolean): Promise<void> {
    const { channelId, client } = this.connected(key);
    const { post } = await client.request('channel.respondSuggestion', {
      channelId,
      postId: postId as ChannelPost['id'],
      accept,
    });
    this.addPosts(key, [post]);
  }

  /** 批准或拒绝协调者的审批：选这一类里的“仅这一次”。 */
  async respondApproval(
    key: string,
    approvalId: string,
    decision: 'approved' | 'rejected',
  ): Promise<void> {
    const { client } = this.connected(key);
    const timeline = this.timeline(key);
    const request = timeline.approvals.find((a) => a.id === approvalId);
    if (request === undefined) return;
    const category = decision === 'approved' ? 'allow' : 'reject';
    const options = request.options.filter((o) => o.category === category);
    const option = options.find((o) => o.kind.endsWith('_once')) ?? options[0];
    if (option === undefined) throw new Error(`no ${category} option`);
    await client.request('approval.respond', {
      approvalId: request.id,
      optionId: option.optionId,
    });
    const current = this.timeline(key);
    this.setTimeline(key, {
      ...current,
      decided: [
        ...current.decided.filter((d) => d.request.id !== approvalId),
        { request, decision },
      ],
    });
  }

  /** 协调者出错后重试。 */
  async wake(key: string): Promise<void> {
    const { channelId, client } = this.connected(key);
    await client.request('channel.wake', { channelId });
  }

  /** 在一台电脑上建助理：协调者沿用那台电脑上已有助理的 Provider，没有时用第一个启用的。 */
  async create(input: NewBot): Promise<Bot> {
    const state = this.hosts.get(input.computer);
    const client = state?.client;
    if (state === undefined || client === undefined || !client.canCreate)
      throw new Error('this computer cannot create assistants');
    let providerId = [...state.channels.values()][0]?.coordinator.providerId;
    if (providerId === undefined) {
      const { providers } = await client.request('provider.list', {});
      providerId = providers.find((p) => p.enabled !== false)?.id;
    }
    if (providerId === undefined) throw new Error('no provider');
    const { channel } = await client.request('channel.create', {
      kind: 'assistant',
      name: input.name,
      description: input.description,
      avatar: input.avatar,
      coordinator: { providerId },
    });
    state.channels.set(channel.id, channel);
    this.rebuild();
    return botFromChannel(state.computer, state.computerName, channel);
  }

  private attach(state: HostState, client: ChannelClient): void {
    state.client = client;
    const generation = ++state.generation;
    const current = () => state.generation === generation;
    state.stops = [
      client.onChannelsChanged((change) => {
        if (!current()) return;
        if (change === undefined) this.reconnected(state);
        else this.listChanged(state, change);
      }),
      client.onChannelPosted((posted) => {
        if (current()) this.routed(state, posted);
      }),
      client.onChannelUpdated((update) => {
        if (current()) this.routed(state, update);
      }),
    ];
    this.reconnected(state);
  }

  private detach(state: HostState): void {
    state.generation += 1;
    for (const stop of state.stops.splice(0)) stop();
    state.client = undefined;
    state.subs.clear();
    state.early = [];
    state.listVersion = undefined;
  }

  /** 新连接（或同一连接重连上）：订阅都没了，重读列表，重订打开过的。 */
  private reconnected(state: HostState): void {
    state.subs.clear();
    state.early = [];
    void this.readList(state);
    for (const key of this.opened) {
      const target = this.target(key);
      if (target?.state === state) void this.follow(state, target.channelId);
    }
  }

  private async readList(state: HostState): Promise<void> {
    const { client, generation } = state;
    if (client === undefined) return;
    try {
      const result = await client.request('channel.list', { kind: 'assistant' });
      if (state.generation !== generation) return;
      state.channels = new Map(result.channels.map((c) => [c.id, c]));
      state.listVersion = result.listVersion;
      this.loadedHosts.add(state.computer);
      this.rebuild();
    } catch (error) {
      console.warn('[wevir] could not list assistants', error);
    }
  }

  private listChanged(state: HostState, change: ChannelsChange): void {
    if (state.listVersion === undefined || change.listVersion !== state.listVersion + 1) {
      void this.readList(state);
      return;
    }
    state.listVersion = change.listVersion;
    for (const id of change.removed) state.channels.delete(id);
    for (const channel of change.upserted) {
      if (channel.kind === 'assistant') state.channels.set(channel.id, channel);
    }
    this.rebuild();
  }

  /** 订阅一个频道并补齐时间线：第一次取最新一页，之后按最后一条的 seq 补发。 */
  private async follow(state: HostState, channelId: string): Promise<void> {
    const { client, generation } = state;
    if (client === undefined) return;
    const key = botKey(state.computer, channelId);
    const afterSeq = this.timeline(key).posts.at(-1)?.seq;
    const id = channelId as Channel['id'];
    try {
      const sub = await client.request('channel.subscribe', {
        channelId: id,
        ...(afterSeq !== undefined && { afterSeq }),
      });
      if (state.generation !== generation) return;
      state.subs.set(sub.subscriptionId, channelId);
      const early = state.early.filter((m) => m.subscriptionId === sub.subscriptionId);
      state.early = state.early.filter((m) => m.subscriptionId !== sub.subscriptionId);
      for (const message of early) this.routed(state, message);
      const [page, view] = await Promise.all([
        afterSeq === undefined
          ? client.request('channel.posts', { channelId: id, limit: PAGE_SIZE })
          : undefined,
        client.request('channel.get', { channelId: id }),
      ]);
      if (state.generation !== generation) return;
      state.channels.set(channelId, view.channel);
      const current = this.timeline(key);
      this.timelines.set(key, {
        ...current,
        posts: page !== undefined ? merge(page.posts, current.posts) : current.posts,
        hasMore:
          page !== undefined
            ? hasEarlier(page.posts, page.posts.length < PAGE_SIZE)
            : current.hasMore,
        threads: view.threads,
        approvals: view.approvals,
        loading: false,
      });
      this.rebuild();
    } catch (error) {
      if (state.generation !== generation) return;
      console.warn('[wevir] could not open assistant', error);
      this.setTimeline(key, { ...this.timeline(key), loading: false });
    }
  }

  private routed(state: HostState, message: ChannelPosted | ChannelUpdate): void {
    const channelId = state.subs.get(message.subscriptionId);
    if (channelId === undefined) {
      // 订阅的补发紧跟在结果后面，可能先于 `await` 之后的登记到。
      state.early.push(message);
      if (state.early.length > EARLY_MAX) state.early.shift();
      return;
    }
    const key = botKey(state.computer, channelId);
    if ('post' in message) {
      this.addPosts(key, [message.post]);
      return;
    }
    if (message.channel !== undefined) state.channels.set(channelId, message.channel);
    const timeline = this.timelines.get(key);
    if (timeline !== undefined) {
      this.timelines.set(key, {
        ...timeline,
        ...(message.posts !== undefined && { posts: merge(timeline.posts, message.posts) }),
        ...(message.threads !== undefined && { threads: message.threads }),
        ...(message.approvals !== undefined && { approvals: message.approvals }),
      });
    }
    this.rebuild();
  }

  private addPosts(key: string, posts: readonly ChannelPost[]): void {
    const timeline = this.timelines.get(key);
    if (timeline === undefined) return;
    this.setTimeline(key, { ...timeline, posts: merge(timeline.posts, posts) });
  }

  private target(key: string): { state: HostState; channelId: string } | undefined {
    const slash = key.indexOf('/');
    const state = this.hosts.get(key.slice(0, slash));
    return state === undefined ? undefined : { state, channelId: key.slice(slash + 1) };
  }

  private connected(key: string): {
    state: HostState;
    channelId: Channel['id'];
    client: ChannelClient;
  } {
    const target = this.target(key);
    const client = target?.state.client;
    if (target === undefined || client === undefined) throw new Error('computer offline');
    return { state: target.state, channelId: target.channelId as Channel['id'], client };
  }

  private rebuild(): void {
    const bots: Bot[] = [];
    for (const state of this.hosts.values()) {
      for (const channel of state.channels.values()) {
        bots.push(botFromChannel(state.computer, state.computerName, channel));
      }
    }
    this.bots = sortBots(bots);
    this.emit();
  }

  private setTimeline(key: string, timeline: Timeline): void {
    this.timelines.set(key, timeline);
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** 按 ID 合并（后来的替换先来的：卡片状态会变），按 seq 排。 */
function merge(a: readonly ChannelPost[], b: readonly ChannelPost[]): ChannelPost[] {
  const byId = new Map<string, ChannelPost>();
  for (const post of [...a, ...b]) byId.set(post.id, post);
  return [...byId.values()].sort((x, y) => x.seq - y.seq);
}

/** 这一页之前还有没有：一页没取满就是到头了，否则看最早一条是不是第 1 条。 */
function hasEarlier(page: readonly ChannelPost[], short: boolean): boolean {
  if (short) return false;
  return (page[0]?.seq ?? 1) > 1;
}
