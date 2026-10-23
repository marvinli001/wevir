// 手机上看一个会话（多是助理开出的线程）：`session.get` 取快照，再从头订阅事件、用 client-sdk 的消息投影算出消息流与待批准的审批。
// 只读：不发消息，只能批准或拒绝。连接与时钟由调用方注入，测试用假的。

import type {
  EventSubscription,
  SubscribeOptions,
  Transcript,
  WevirClient,
} from '@wevir/client-sdk';
import { TranscriptProjection } from '@wevir/client-sdk';
import type { ApprovalId, ApprovalRequest, Session, SessionId } from '@wevir/protocol';

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
  /** 历史已回放完。 */
  caughtUp: boolean;
  error?: unknown;
}

/** 攒一批事件再出一次快照：回放历史时不必每条都重画。 */
const FLUSH_MS = 50;

export class SessionWatch {
  readonly #client: SessionClient;
  readonly #sessionId: SessionId;
  readonly #onChange: (view: SessionView) => void;
  readonly #projection = new TranscriptProjection();
  #view: SessionView = { caughtUp: false };
  #subscription: EventSubscription | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(client: SessionClient, sessionId: SessionId, onChange: (view: SessionView) => void) {
    this.#client = client;
    this.#sessionId = sessionId;
    this.#onChange = onChange;
  }

  get view(): SessionView {
    return this.#view;
  }

  async start(): Promise<void> {
    try {
      const { session } = await this.#client.request('session.get', { sessionId: this.#sessionId });
      if (this.#stopped) return;
      this.#set({ session });
      const subscription = this.#client.subscribe(this.#sessionId);
      this.#subscription = subscription;
      for await (const item of subscription) {
        if (this.#stopped) break;
        if (item.type === 'event') {
          this.#projection.apply(item.event);
          this.#schedule();
        } else if (item.type === 'reset') {
          this.#projection.reset();
        } else {
          this.#flush({ caughtUp: true });
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
  }

  /** 批准或拒绝：选这一类里的“仅这一次”。 */
  async respond(approvalId: ApprovalId, decision: 'approved' | 'rejected'): Promise<void> {
    const request = this.#view.transcript?.approvals.get(approvalId);
    if (request === undefined) return;
    await this.#client.request('approval.respond', {
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

  #set(patch: Partial<SessionView>): void {
    this.#view = { ...this.#view, ...patch };
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
