// 助理测试用的频道、帖子与假的频道接口（一台电脑上的 Host，内存里）。

import type { ChannelPosted, ChannelsChange, ChannelUpdate } from '@wevir/client-sdk';
import type { ApprovalRequest, Channel, ChannelPost, ChannelThread } from '@wevir/protocol';
import type { ChannelClient } from './bot-store';

export const CHANNEL_A = 'chn_01JA2B3C4D5E6F7G8H9JKMNPQA' as Channel['id'];
export const CHANNEL_B = 'chn_01JA2B3C4D5E6F7G8H9JKMNPQB' as Channel['id'];
export const SESSION = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as ChannelThread['sessionId'];

export function at(minute: number): string {
  return new Date(Date.UTC(2026, 9, 23, 0, minute)).toISOString();
}

export function channel(id: Channel['id'], patch: Partial<Channel> = {}): Channel {
  return {
    id,
    kind: 'assistant',
    workspaceId: 'wsp_01JA2B3C4D5E6F7G8H9JKMNPQR' as Channel['workspaceId'],
    title: id === CHANNEL_A ? '小管家' : '读书笔记',
    assistant: {
      description: '邮件与日程',
      avatar: { type: 'cloud', color: 2, seed: 0.4 },
      rules: {},
      folders: [],
    },
    coordinator: {
      providerId: 'prov_1' as Channel['coordinator']['providerId'],
      mode: 'act',
      generation: 1,
    },
    budget: { dailyWakes: 20, dailyTokens: 200_000 },
    state: 'idle',
    lastPostSeq: 0,
    createdAt: at(0),
    updatedAt: at(0),
    ...patch,
  };
}

export function post(
  channelId: Channel['id'],
  seq: number,
  patch: Partial<ChannelPost> = {},
): ChannelPost {
  return {
    id: `cpo_01JA2B3C4D5E6F7G8H9JK${String(seq).padStart(5, '0')}` as ChannelPost['id'],
    channelId,
    seq,
    author: { kind: 'coordinator', sessionId: SESSION, generation: 1 },
    content: [{ type: 'text', text: `#${seq}` }],
    createdAt: at(seq),
    ...patch,
  };
}

export function thread(
  rootPostId: ChannelPost['id'],
  patch: Partial<ChannelThread> = {},
): ChannelThread {
  return {
    sessionId: SESSION,
    channelId: CHANNEL_A,
    rootPostId,
    title: '修登录页',
    status: 'working',
    doing: '跑测试',
    replyCount: 0,
    openedBy: 'coordinator',
    createdAt: at(10),
    ...patch,
  };
}

export function approval(patch: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'apr_01JA2B3C4D5E6F7G8H9JKMNPQR' as ApprovalRequest['id'],
    sessionId: SESSION,
    turnId: 'trn_01JA2B3C4D5E6F7G8H9JKMNPQR' as ApprovalRequest['turnId'],
    toolCallId: 'call_1',
    options: [
      { optionId: 'always', label: 'Always', kind: 'allow_always', category: 'allow' },
      { optionId: 'once', label: 'Allow', kind: 'allow_once', category: 'allow' },
      { optionId: 'no', label: 'Reject', kind: 'reject_once', category: 'reject' },
    ],
    detail: {
      toolName: 'mcp__gmail__send_email',
      display: { kind: 'unknown', mcpServer: 'gmail' },
      input: { to: ['lin@example.com'], subject: '周五的会', body: '改到下午三点，可以吗？' },
    },
    status: 'pending',
    createdAt: at(50),
    ...patch,
  };
}

type Params = Record<string, unknown>;

/** 一台电脑的假 Host：频道与帖子在内存里，记下每次请求，通知手动发。 */
export class FakeChannels {
  channels: Channel[] = [];
  posts = new Map<string, ChannelPost[]>();
  threads: ChannelThread[] = [];
  approvals: ApprovalRequest[] = [];
  listVersion = 1;
  requests: Array<{ method: string; params: Params }> = [];
  /** `channel.subscribe` 返回之前先发出的补发帖子（模拟补发先于结果的登记到达）。 */
  replay = true;
  #subs = 0;
  readonly #changed = new Set<(change: ChannelsChange | undefined) => void>();
  readonly #posted = new Set<(posted: ChannelPosted) => void>();
  readonly #updated = new Set<(update: ChannelUpdate) => void>();

  readonly client: ChannelClient = {
    canCreate: false,
    request: ((method: string, params: Params) =>
      this.#handle(method, params)) as ChannelClient['request'],
    onChannelsChanged: (listener) => {
      this.#changed.add(listener);
      return () => this.#changed.delete(listener);
    },
    onChannelPosted: (listener) => {
      this.#posted.add(listener);
      return () => this.#posted.delete(listener);
    },
    onChannelUpdated: (listener) => {
      this.#updated.add(listener);
      return () => this.#updated.delete(listener);
    },
  };

  constructor(options: { canCreate?: boolean } = {}) {
    if (options.canCreate === true) this.client = { ...this.client, canCreate: true };
  }

  get listenerCount(): number {
    return this.#changed.size + this.#posted.size + this.#updated.size;
  }

  calls(method: string): Params[] {
    return this.requests.filter((r) => r.method === method).map((r) => r.params);
  }

  changed(change: ChannelsChange | undefined): void {
    for (const listener of [...this.#changed]) listener(change);
  }

  posted(subscriptionId: string, item: ChannelPost): void {
    for (const listener of [...this.#posted])
      listener({ subscriptionId: subscriptionId as ChannelPosted['subscriptionId'], post: item });
  }

  updated(update: Omit<ChannelUpdate, 'subscriptionId'>, subscriptionId = this.lastSub()): void {
    for (const listener of [...this.#updated])
      listener({ ...update, subscriptionId: subscriptionId as ChannelUpdate['subscriptionId'] });
  }

  lastSub(): string {
    return `sub_01JA2B3C4D5E6F7G8H9JK${String(this.#subs).padStart(5, '0')}`;
  }

  add(item: ChannelPost): void {
    const list = this.posts.get(item.channelId) ?? [];
    list.push(item);
    this.posts.set(item.channelId, list);
  }

  async #handle(method: string, params: Params): Promise<unknown> {
    this.requests.push({ method, params });
    const channelId = params.channelId as string;
    const posts = this.posts.get(channelId) ?? [];
    const find = () => this.channels.find((c) => c.id === channelId) as Channel;
    switch (method) {
      case 'channel.list':
        return { channels: this.channels, listVersion: this.listVersion };
      case 'channel.get':
        return { channel: find(), threads: this.threads, approvals: this.approvals, tasks: [] };
      case 'channel.posts': {
        const before = params.beforeSeq as number | undefined;
        const limit = params.limit as number;
        const list = posts.filter((p) => before === undefined || p.seq < before);
        return { posts: list.slice(-limit), lastSeq: posts.at(-1)?.seq ?? 0 };
      }
      case 'channel.subscribe': {
        this.#subs += 1;
        const subscriptionId = this.lastSub();
        const after = params.afterSeq as number | undefined;
        if (this.replay && after !== undefined) {
          const missed = posts.filter((p) => p.seq > after);
          queueMicrotask(() => {
            for (const item of missed) this.posted(subscriptionId, item);
          });
        }
        return { subscriptionId, lastSeq: posts.at(-1)?.seq ?? 0 };
      }
      case 'channel.post': {
        const item = post(channelId as Channel['id'], (posts.at(-1)?.seq ?? 0) + 1, {
          author: { kind: 'user' },
          content: params.content as ChannelPost['content'],
        });
        this.add(item);
        return { post: item };
      }
      case 'channel.respondSuggestion': {
        const item = posts.find((p) => p.id === params.postId) as ChannelPost;
        const card = item.card as Extract<ChannelPost['card'], { kind: 'suggestion' }>;
        return {
          post: {
            ...item,
            card: { ...card, status: params.accept === true ? 'accepted' : 'dismissed' },
          },
        };
      }
      case 'channel.create': {
        const created = channel('chn_01JA2B3C4D5E6F7G8H9JKMNPQC' as Channel['id'], {
          title: params.name as string,
          coordinator: {
            ...(params.coordinator as Channel['coordinator']),
            mode: 'act',
            generation: 1,
          },
        });
        this.channels.push(created);
        return { channel: created };
      }
      case 'provider.list':
        return { providers: [{ id: 'prov_off', enabled: false }, { id: 'prov_on' }] };
      default:
        return {};
    }
  }
}
