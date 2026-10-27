// 助理列表与各助理时间线的内存状态：界面从这里读、经这里写。背后是各台电脑的连接（`ChannelClient`，Host 0.120.0 的 `channel.*`）：
// 每台连上就读 `channel.list` 并跟着 `channels.changed` 改；打开一个助理时取最新一页帖子，从最后一条起 `watchChannel`，再取线程与
// 审批。连接断了助理留在列表里；同一连接重连上之后 client-sdk 自己从最后一条接着补，这里重读列表与打开过的助理的线程、审批。

import type {
  ChannelsChange,
  ChannelUpdate,
  ChannelWatchHandlers,
  WevirClient,
} from '@wevir/client-sdk';
import type { Channel, ChannelPost, MethodParams, ProviderProfile } from '@wevir/protocol';
import { verifyApproval } from './approval-gate';
import type { Avatar } from './bot-avatar';
import { type Bot, botFromChannel, botKey, sortBots, type TimelineParts } from './bots';

export const PAGE_SIZE = 30;

/** 一台电脑上的频道接口（`WevirClient` 的一部分）。Host 没有 `channels` 功能或这台设备不能读会话时没有。 */
export interface ChannelClient {
  /** 能在这台电脑上建助理（`workspace.write` 与 `provider.read`；新配对的手机默认有，旧的配对与网页设备没有）。 */
  readonly canCreate: boolean;
  /** 能改这台电脑上的助理（`workspace.write`）。 */
  readonly canEdit: boolean;
  /** 能读这台电脑的模型服务（`provider.read`），改助理的模型要用。 */
  readonly canReadProviders: boolean;
  request: WevirClient['request'];
  onChannelsChanged(listener: (change: ChannelsChange | undefined) => void): () => void;
  watchChannel(
    channelId: Channel['id'],
    handlers: ChannelWatchHandlers,
    options?: { afterSeq?: number },
  ): () => void;
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

/** 这台设备在助理所在电脑上能做的事。 */
export interface BotAccess {
  online: boolean;
  canEdit: boolean;
  canReadProviders: boolean;
}

/** 改助理时交给 `channel.update` 的字段。 */
export type BotPatch = Omit<MethodParams<'channel.update'>, 'channelId'>;

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
  /** 频道 ID → 取消 `watchChannel`。 */
  watches: Map<string, () => void>;
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

  /** 助理的频道（编辑页读它现在的模型与文件夹）。 */
  channel(key: string): Channel | undefined {
    const target = this.target(key);
    return target?.state.channels.get(target.channelId);
  }

  access(key: string): BotAccess {
    const client = this.target(key)?.state.client;
    return {
      online: client !== undefined,
      canEdit: client?.canEdit === true,
      canReadProviders: client?.canReadProviders === true,
    };
  }

  /** 在线、能看助理的电脑数（有它们而没有 `creators()` 时，“新建”是因为权限不够而不能用）。 */
  onlineCount(): number {
    return [...this.hosts.values()].filter((h) => h.client !== undefined).length;
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
          watches: new Map(),
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
    await verifyApproval(request, category);
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

  /** 改助理：名字、职责、头像、模型、可访问的文件夹。 */
  async update(key: string, patch: BotPatch): Promise<void> {
    const { state, channelId, client } = this.connected(key);
    const { channel } = await client.request('channel.update', { channelId, ...patch });
    state.channels.set(channel.id, channel);
    this.rebuild();
  }

  /** 助理所在电脑上能选的模型服务（启用的）。 */
  async providers(key: string): Promise<ProviderProfile[]> {
    const { client } = this.connected(key);
    const { providers } = await client.request('provider.list', {});
    return providers.filter((p) => p.enabled !== false);
  }

  /** 助理所在电脑上的项目文件夹（主文件夹与其他源文件夹），给“添加文件夹”挑。 */
  async projectFolders(key: string): Promise<string[]> {
    const { client } = this.connected(key);
    const { workspaces } = await client.request('workspace.list', {});
    const folders = workspaces
      .filter((w) => w.kind === undefined)
      .flatMap((w) => [w.rootPath, ...(w.extraFolders ?? [])]);
    return [...new Set(folders)].sort((a, b) => a.localeCompare(b));
  }

  private attach(state: HostState, client: ChannelClient): void {
    state.client = client;
    const generation = ++state.generation;
    state.stops = [
      client.onChannelsChanged((change) => {
        if (state.generation !== generation) return;
        if (change === undefined) this.reconnected(state);
        else this.listChanged(state, change);
      }),
    ];
    void this.readList(state);
    for (const key of this.opened) {
      const target = this.target(key);
      if (target?.state === state) void this.follow(state, target.channelId);
    }
  }

  private detach(state: HostState): void {
    state.generation += 1;
    for (const stop of state.stops.splice(0)) stop();
    for (const stop of state.watches.values()) stop();
    state.watches.clear();
    state.client = undefined;
    state.listVersion = undefined;
  }

  /** 同一连接重连上：期间的列表变化与线程、审批的变化没收到，重读（帖子 client-sdk 自己补）。 */
  private reconnected(state: HostState): void {
    void this.readList(state);
    for (const channelId of state.watches.keys()) void this.readView(state, channelId);
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

  /** 开始看一个频道：没有帖子时先取最新一页，再从最后一条起 `watchChannel`，然后取线程与审批。 */
  private async follow(state: HostState, channelId: string): Promise<void> {
    const { client, generation } = state;
    if (client === undefined || state.watches.has(channelId)) return;
    const key = botKey(state.computer, channelId);
    const id = channelId as Channel['id'];
    try {
      let afterSeq = this.timeline(key).posts.at(-1)?.seq;
      if (afterSeq === undefined) {
        const page = await client.request('channel.posts', { channelId: id, limit: PAGE_SIZE });
        if (state.generation !== generation) return;
        const current = this.timeline(key);
        this.setTimeline(key, {
          ...current,
          posts: merge(page.posts, current.posts),
          hasMore: hasEarlier(page.posts, page.posts.length < PAGE_SIZE),
        });
        afterSeq = page.posts.at(-1)?.seq ?? page.lastSeq;
      }
      if (state.watches.has(channelId)) return;
      state.watches.set(
        channelId,
        client.watchChannel(
          id,
          {
            onPost: (post) => this.addPosts(key, [post]),
            onUpdate: (update) => this.updated(state, channelId, update),
            onError: (error) => console.warn('[wevir] assistant timeline', error),
          },
          { afterSeq },
        ),
      );
      await this.readView(state, channelId);
    } catch (error) {
      if (state.generation !== generation) return;
      console.warn('[wevir] could not open assistant', error);
      this.setTimeline(key, { ...this.timeline(key), loading: false });
    }
  }

  /** 线程与审批（`channel.get`）。 */
  private async readView(state: HostState, channelId: string): Promise<void> {
    const { client, generation } = state;
    if (client === undefined) return;
    const view = await client.request('channel.get', { channelId: channelId as Channel['id'] });
    if (state.generation !== generation) return;
    state.channels.set(channelId, view.channel);
    const key = botKey(state.computer, channelId);
    this.timelines.set(key, {
      ...this.timeline(key),
      threads: view.threads,
      approvals: view.approvals,
      loading: false,
    });
    this.rebuild();
  }

  private updated(state: HostState, channelId: string, update: ChannelUpdate): void {
    if (update.channel !== undefined) state.channels.set(channelId, update.channel);
    const key = botKey(state.computer, channelId);
    const timeline = this.timelines.get(key);
    if (timeline !== undefined) {
      this.timelines.set(key, {
        ...timeline,
        ...(update.posts !== undefined && { posts: merge(timeline.posts, update.posts) }),
        ...(update.threads !== undefined && { threads: update.threads }),
        ...(update.approvals !== undefined && { approvals: update.approvals }),
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
