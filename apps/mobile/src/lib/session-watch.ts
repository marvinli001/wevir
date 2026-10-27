// 手机上看一个会话（多是助理开出的线程）：`session.get` 取快照，再从头订阅事件、用 client-sdk 的消息投影算出消息流与待批准的审批。
// 连接与时钟由调用方注入，测试用假的。
//
// 本地缓存（cache.ts）：给了 `cache` 时先拿上次存下的事件投影一遍立刻显示（`cachedAt`），连上之后照常从头回放，回放完再换成最新的；
// 之后有新事件就隔一会儿存一次，离开时再存一次。没有连接（`client` 是 `undefined`）时只显示缓存，`offline` 为 true：不能作答，
// 缓存里的待批准与待回答也不显示（它们在电脑上可能早已处理）。

import type {
  EventSubscription,
  SubscribeOptions,
  Transcript,
  WevirClient,
} from '@wevir/client-sdk';
import { TranscriptProjection } from '@wevir/client-sdk';
import type { ApprovalId, ApprovalRequest, Session, SessionId, WevirEvent } from '@wevir/protocol';
import { verifyApproval } from './approval-gate';
import type { SessionCache } from './cache';

/** 一台电脑上按 ID 看会话的接口（`WevirClient` 的一部分）。 */
export interface SessionClient {
  /** 这台设备能批准（`session.write`）。 */
  readonly canWrite: boolean;
  request: WevirClient['request'];
  subscribe(sessionId: SessionId, options?: SubscribeOptions): EventSubscription;
}

export interface SessionView {
  session?: Session;
  transcript?: Transcript;
  /** 历史已回放完（只有缓存时：缓存读完）。 */
  caughtUp: boolean;
  error?: unknown;
  /** 没有连接：只能看缓存，不能发消息、作答。 */
  offline?: boolean;
  /** 显示的是本地缓存（存下的时刻）；连上并回放完之后没有。 */
  cachedAt?: string;
}

/** 攒一批事件再出一次快照：回放历史时不必每条都重画。 */
const FLUSH_MS = 50;
/** 回放完之后有新事件时，隔多久存一次缓存。 */
export const CACHE_SAVE_MS = 3_000;

export class SessionWatch {
  readonly #client: SessionClient | undefined;
  readonly #sessionId: SessionId;
  readonly #onChange: (view: SessionView) => void;
  readonly #cache: SessionCache | undefined;
  readonly #projection = new TranscriptProjection();
  /** 从头收到的全部事件（存缓存用）。 */
  #events: WevirEvent[] = [];
  #view: SessionView = { caughtUp: false };
  #subscription: EventSubscription | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #live = false;
  #dirty = false;
  #stopped = false;

  constructor(
    client: SessionClient | undefined,
    sessionId: SessionId,
    onChange: (view: SessionView) => void,
    cache?: SessionCache,
  ) {
    this.#client = client;
    this.#sessionId = sessionId;
    this.#onChange = onChange;
    this.#cache = cache;
  }

  get view(): SessionView {
    return this.#view;
  }

  async start(): Promise<void> {
    const client = this.#client;
    const cached = await this.#cache?.loadConversation(this.#sessionId);
    if (this.#stopped) return;
    if (cached !== undefined) {
      const projection = new TranscriptProjection();
      for (const event of cached.events) projection.apply(event);
      const transcript = projection.snapshot();
      this.#set({
        session: cached.session,
        transcript: { ...transcript, pendingApprovals: [], pendingQuestions: [] },
        caughtUp: true,
        cachedAt: cached.savedAt,
      });
    }
    if (client === undefined) {
      this.#set({ offline: true, caughtUp: true });
      return;
    }
    try {
      const { session } = await client.request('session.get', { sessionId: this.#sessionId });
      if (this.#stopped) return;
      this.#set({ session });
      // 只投影最后的样子：经中继时字节就是等待时间，工具的中间输出与被替换的增量不回放（0.127.0）。
      const subscription = client.subscribe(this.#sessionId, { elideSuperseded: true });
      this.#subscription = subscription;
      for await (const item of subscription) {
        if (this.#stopped) break;
        if (item.type === 'event') {
          this.#projection.apply(item.event);
          this.#events.push(item.event);
          // 有缓存在显示时，回放完再一次换掉，不闪。
          if (this.#live || cached === undefined) this.#schedule();
          if (this.#live) this.#scheduleSave();
        } else if (item.type === 'reset') {
          this.#projection.reset();
          this.#events = [];
        } else {
          this.#live = true;
          this.#flush({ caughtUp: true, cachedAt: undefined });
          this.#dirty = true;
          this.#save();
        }
      }
    } catch (error) {
      if (!this.#stopped) this.#set({ error });
    }
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#subscription?.close();
    this.#save();
  }

  /** 批准或拒绝：选这一类里的“仅这一次”。高风险的批准先验证本人（approval-gate.ts）。 */
  async respond(approvalId: ApprovalId, decision: 'approved' | 'rejected'): Promise<void> {
    const client = this.#client;
    const request = this.#view.transcript?.approvals.get(approvalId);
    if (request === undefined || client === undefined) return;
    await verifyApproval(request, decision === 'approved' ? 'allow' : 'reject');
    await client.request('approval.respond', {
      approvalId,
      optionId: pickOption(request, decision),
    });
  }

  #schedule(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => this.#flush(), FLUSH_MS);
  }

  #flush(patch: Partial<SessionView> = {}): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#stopped) return;
    this.#set({ ...patch, transcript: this.#projection.snapshot() });
  }

  #scheduleSave(): void {
    this.#dirty = true;
    if (this.#saveTimer !== undefined) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      this.#save();
    }, CACHE_SAVE_MS);
  }

  /** 回放完之后才存：半截的历史不覆盖完整的缓存。 */
  #save(): void {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    const session = this.#view.session;
    if (!this.#live || !this.#dirty || session === undefined) return;
    this.#dirty = false;
    void this.#cache?.saveConversation(this.#sessionId, { session, events: this.#events });
  }

  #set(patch: Partial<SessionView>): void {
    const next = { ...this.#view, ...patch };
    if (patch.cachedAt === undefined && 'cachedAt' in patch) delete next.cachedAt;
    this.#view = next;
    this.#onChange(this.#view);
  }
}

/** 审批里这一类（允许 / 拒绝）的“仅这一次”，没有时取这一类的第一个。 */
export function pickOption(request: ApprovalRequest, decision: 'approved' | 'rejected'): string {
  const category = decision === 'approved' ? 'allow' : 'reject';
  const options = request.options.filter((o) => o.category === category);
  const option = options.find((o) => o.kind.endsWith('_once')) ?? options[0];
  if (option === undefined) throw new Error(`no ${category} option`);
  return option.optionId;
}
