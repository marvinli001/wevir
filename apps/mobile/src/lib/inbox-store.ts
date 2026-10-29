// 收件箱的状态：每台连着的电脑读一次 `inbox.list`，之后跟着 `inbox.changed`（版本接不上或重连后整张重读），合成一个列表给收件箱页。
// 作答（批准、回答）与收起也经这里：撞上别处先处理了或过期时，那一项留在“已在别处处理”里，写明谁、何时，直到用户点掉。
// 电脑的连接来自电脑列表（`ComputerRegistry`），测试用假的。离线的电脑不列它的项（在电脑上可能已经处理），只记下哪几台离线。

import type { WevirClient } from '@wevir/client-sdk';
import type { ClientIdentity, InboxItem } from '@wevir/protocol';
import { verifyApproval } from './approval-gate';
import type { LinkStatus } from './computer-link';
import {
  type AnswerOutcome,
  applyInboxChange,
  approvalConflict,
  type InboxChange,
  type InboxEntry,
  type InboxList,
  mergeInboxes,
  questionOutcome,
} from './inbox';
import { type ComputerRecord, displayName } from './records';

/** 一台电脑上的收件箱接口（`WevirClient` 的一部分）。Host 没有 `inbox` 功能或这台设备不能读会话时没有。 */
export interface InboxClient {
  /** 能作答与收起（`session.write`）。 */
  readonly canWrite: boolean;
  /** 本机的身份：判断“是不是本机答的”。 */
  readonly identity: Pick<ClientIdentity, 'clientId'>;
  listInbox(): Promise<InboxList>;
  onInboxChanged(listener: (change: InboxChange | undefined) => void): () => void;
  request: WevirClient['request'];
}

/** 电脑列表里用到的部分（`ComputerRegistry`）。 */
export interface InboxSource {
  readonly snapshots: readonly { record: ComputerRecord; status: LinkStatus }[];
  link(name: string): { readonly inbox?: InboxClient; readonly connection?: object } | undefined;
  subscribe(listener: () => void): () => void;
}

/** 撞上别处已处理的一项：留着给用户看。 */
export interface SettledEntry {
  entry: InboxEntry;
  outcome: Extract<AnswerOutcome, { kind: 'elsewhere' }>;
}

export interface InboxSnapshot {
  entries: readonly InboxEntry[];
  settled: readonly SettledEntry[];
  /** 读过收件箱的电脑数（含读不到的）；0 时还没有一台连上。 */
  computers: number;
  /** 离线或读不到收件箱的电脑（显示名）。 */
  unavailable: readonly string[];
  /** 还在读。 */
  loading: boolean;
}

/** 最多留几条“已在别处处理”。 */
export const SETTLED_MAX = 10;

interface ComputerState {
  name: string;
  computerName: string;
  connection: object | undefined;
  client: InboxClient | undefined;
  list: InboxList | undefined;
  status: 'loading' | 'ready' | 'failed' | 'unavailable';
  stop: (() => void) | undefined;
  /** 正在读的那一次（读完是 `undefined`）。 */
  reading: Promise<void> | undefined;
  rereadQueued: boolean;
}

export class InboxStore {
  readonly #source: InboxSource;
  readonly #computers = new Map<string, ComputerState>();
  readonly #listeners = new Set<() => void>();
  #settled: SettledEntry[] = [];
  #snapshot: InboxSnapshot = {
    entries: [],
    settled: [],
    computers: 0,
    unavailable: [],
    loading: true,
  };
  #off: (() => void) | undefined;

  constructor(source: InboxSource) {
    this.#source = source;
  }

  get snapshot(): InboxSnapshot {
    return this.#snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 开始跟着电脑列表；返回停止的函数。 */
  start(): () => void {
    this.#sync();
    this.#off = this.#source.subscribe(() => this.#sync());
    return () => this.stop();
  }

  stop(): void {
    this.#off?.();
    this.#off = undefined;
    for (const state of this.#computers.values()) state.stop?.();
    this.#computers.clear();
  }

  /** 批准或拒绝：`optionId` 来自项的选项。高风险的批准先验证本人。 */
  async respondApproval(entry: InboxEntry, optionId: string): Promise<AnswerOutcome> {
    const { item } = entry;
    if (item.kind !== 'approval') throw new Error('not an approval');
    const option = item.ref.options.find((o) => o.optionId === optionId);
    if (option === undefined) throw new Error(`unknown option ${optionId}`);
    const client = this.#client(entry.computer);
    await verifyApproval(item.ref, option.category);
    try {
      await client.request('approval.respond', { approvalId: item.ref.approvalId, optionId });
      this.#removeLocally(entry);
      return { kind: 'done' };
    } catch (error) {
      const outcome = approvalConflict(error, client.identity);
      if (outcome === undefined) throw error;
      this.#settle(entry, outcome);
      return outcome;
    }
  }

  /** 回答一题（单选的提问，`quickQuestion`）。 */
  async answerQuestion(
    entry: InboxEntry,
    answers: Record<string, { answers: string[] }>,
  ): Promise<AnswerOutcome> {
    const { item } = entry;
    if (item.kind !== 'question') throw new Error('not a question');
    const client = this.#client(entry.computer);
    const result = await client.request('question.respond', {
      questionId: item.ref.questionId,
      answers,
    });
    const outcome = questionOutcome(result, client.identity);
    if (outcome.kind === 'elsewhere') this.#settle(entry, outcome);
    else this.#removeLocally(entry);
    return outcome;
  }

  /** 收起失败回合或自动化项。 */
  async dismiss(entry: InboxEntry): Promise<void> {
    const client = this.#client(entry.computer);
    await client.request('inbox.dismiss', { itemId: entry.item.id });
    this.#removeLocally(entry);
  }

  /** 用户看过“已在别处处理”的一项。 */
  /** 下拉刷新：连着的电脑重读收件箱，读完时完成（没连着的由电脑列表去重连）。 */
  async refresh(): Promise<void> {
    await Promise.all(
      [...this.#computers.values()].flatMap((state) =>
        state.client !== undefined ? [this.#read(state, state.client)] : [],
      ),
    );
  }

  acknowledge(key: string): void {
    this.#settled = this.#settled.filter((s) => s.entry.key !== key);
    this.#publish();
  }

  #client(computer: string): InboxClient {
    const client = this.#computers.get(computer)?.client;
    if (client === undefined) throw new Error(`${computer} is not connected`);
    return client;
  }

  #settle(entry: InboxEntry, outcome: SettledEntry['outcome']): void {
    this.#settled = [
      { entry, outcome },
      ...this.#settled.filter((s) => s.entry.key !== entry.key),
    ].slice(0, SETTLED_MAX);
    this.#removeLocally(entry);
  }

  /** 作答成功或已处理：不等 `inbox.changed` 就先拿掉（版本不动，之后的变化照常接上）。 */
  #removeLocally(entry: InboxEntry): void {
    const state = this.#computers.get(entry.computer);
    if (state?.list !== undefined) {
      state.list = {
        ...state.list,
        items: state.list.items.filter((item) => item.id !== entry.item.id),
      };
    }
    this.#publish();
  }

  #sync(): void {
    const names = new Set<string>();
    for (const { record } of this.#source.snapshots) {
      names.add(record.name);
      const link = this.#source.link(record.name);
      const connection = link?.connection;
      let state = this.#computers.get(record.name);
      if (state === undefined) {
        state = {
          name: record.name,
          computerName: displayName(record),
          connection: undefined,
          client: undefined,
          list: undefined,
          status: 'unavailable',
          stop: undefined,
          reading: undefined,
          rereadQueued: false,
        };
        this.#computers.set(record.name, state);
      }
      state.computerName = displayName(record);
      if (state.connection === connection && connection !== undefined) continue;
      // 连接换了（重连、回到前台）或断了：旧的退订，列表作废。
      state.stop?.();
      state.stop = undefined;
      state.connection = connection;
      state.list = undefined;
      state.client = connection !== undefined ? link?.inbox : undefined;
      state.status = state.client !== undefined ? 'loading' : 'unavailable';
      const client = state.client;
      if (client !== undefined) {
        const current = state;
        current.stop = client.onInboxChanged((change) => this.#changed(current, client, change));
        void this.#read(current, client);
      }
    }
    for (const [name, state] of this.#computers) {
      if (names.has(name)) continue;
      state.stop?.();
      this.#computers.delete(name);
      this.#settled = this.#settled.filter((s) => s.entry.computer !== name);
    }
    this.#publish();
  }

  #changed(state: ComputerState, client: InboxClient, change: InboxChange | undefined): void {
    if (state.client !== client) return;
    const next =
      change === undefined || state.list === undefined
        ? undefined
        : applyInboxChange(state.list, change);
    if (next === undefined) {
      void this.#read(state, client);
      return;
    }
    state.list = next;
    this.#publish();
  }

  #read(state: ComputerState, client: InboxClient): Promise<void> {
    if (state.reading !== undefined) {
      state.rereadQueued = true;
      return state.reading;
    }
    state.reading = client
      .listInbox()
      .then(
        (list) => {
          if (state.client !== client) return;
          state.list = list;
          state.status = 'ready';
        },
        () => {
          if (state.client !== client) return;
          state.status = 'failed';
        },
      )
      .finally(() => {
        state.reading = undefined;
        if (state.client === client && state.rereadQueued) {
          state.rereadQueued = false;
          void this.#read(state, client);
        }
        this.#publish();
      });
    return state.reading;
  }

  #publish(): void {
    const states = [...this.#computers.values()];
    const ready = states.filter((s) => s.status === 'ready' && s.list !== undefined);
    this.#snapshot = {
      entries: mergeInboxes(
        ready.map((s) => ({
          computer: s.name,
          computerName: s.computerName,
          items: (s.list as InboxList).items as InboxItem[],
        })),
      ),
      settled: this.#settled,
      computers: states.length,
      unavailable: states
        .filter((s) => s.status === 'unavailable' || s.status === 'failed')
        .map((s) => s.computerName),
      loading: states.some((s) => s.status === 'loading'),
    };
    for (const listener of [...this.#listeners]) listener();
  }
}
