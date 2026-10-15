// 假的 opencode 服务器（适配器与契约测试用）：按提示词回放 events/ 里录下的真实事件（record-events.test.ts），不起进程。
//
// - 每次回放把录音里的 ID 换成这次的：录下的会话 ID → createSession 给的，录下的用户消息 ID → 适配器发来的 messageID，其余的
//   加上回放序号，几个会话同时回放也不撞；
// - 录音里的 `action` 行（录的时候回复审批、提问或 abort 的地方）停下，等适配器做同样的事；审批按回复选分支（允许 / 拒绝并继续 /
//   拒绝并停止各有一份录音），换分支时按“同一类 ID 第几次出现”对齐前后两份录音的 ID；
// - 不在 abort 点上的 abort：停下回放，发 opencode 取消时的那两条事件（录音 slow-cancel 里的 MessageAbortedError 与 idle）。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Event,
  OpenCodeClient,
  OpenCodeConnectInput,
  OpenCodeSdk,
  PermissionRuleset,
  PromptInput,
  ProviderListResponse,
  QuestionAnswer,
  Session,
  SessionStatus,
} from '../sdk.js';
import type { OpenCodeServerHandle, ServerExit, StartServerOptions } from '../server.js';

const EVENTS_DIR = join(import.meta.dirname, 'events');

/** 录音里回复审批与提问、或 abort 的地方（record-events.test.ts 写下）。 */
export type RecordedAction =
  | { type: 'permission'; reply: 'once' | 'always' | 'reject'; message?: string }
  | { type: 'question'; answers: string[][] }
  | { type: 'abort' };

export const FAKE_OPENCODE_VERSION = '1.18.34';

interface RecordingLine {
  event?: Event;
  action?: RecordedAction;
}

export interface Recording {
  name: string;
  prompt: string;
  sessionID: string;
  messageID: string;
  lines: RecordingLine[];
}

/** 读全部录音。 */
export function loadRecordings(): Recording[] {
  return readdirSync(EVENTS_DIR)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((file) => {
      const [head, ...rest] = readFileSync(join(EVENTS_DIR, file), 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '');
      const meta = (JSON.parse(head as string) as { _meta: Record<string, string> })._meta;
      return {
        name: meta.scenario as string,
        prompt: meta.prompt as string,
        sessionID: meta.sessionID as string,
        messageID: meta.messageID as string,
        lines: rest.map((line) => JSON.parse(line) as RecordingLine),
      };
    });
}

/** 读一份录音。 */
export function loadRecording(name: string): Recording {
  const found = loadRecordings().find((recording) => recording.name === name);
  if (found === undefined) throw new Error(`no recording ${name}`);
  return found;
}

const ID_PATTERN = /\b(?:ses|msg|prt|per|que|evt)_[0-9A-Za-z]+|\bcall_\d+\b/g;

function idKind(id: string): string {
  return id.slice(0, id.indexOf('_'));
}

/** 一段录音里各类 ID 按第一次出现的顺序。 */
function idsInOrder(lines: readonly RecordingLine[]): Map<string, string[]> {
  const seen = new Set<string>();
  const byKind = new Map<string, string[]>();
  for (const line of lines) {
    for (const match of JSON.stringify(line).matchAll(ID_PATTERN)) {
      const id = match[0];
      if (seen.has(id)) continue;
      seen.add(id);
      const kind = idKind(id);
      byKind.set(kind, [...(byKind.get(kind) ?? []), id]);
    }
  }
  return byKind;
}

function rewrite<T>(value: T, ids: Map<string, string>, fresh: (id: string) => string): T {
  const text = JSON.stringify(value).replaceAll(ID_PATTERN, (id) => {
    let mapped = ids.get(id);
    if (mapped === undefined) {
      mapped = fresh(id);
      ids.set(id, mapped);
    }
    return mapped;
  });
  return JSON.parse(text) as T;
}

function notFound(what: string): Error {
  return new Error(`${what} not found`, {
    cause: { status: 404, body: { name: 'NotFoundError' } },
  });
}

interface Waiter {
  kind: RecordedAction['type'];
  requestId?: string;
  resolve: (action: RecordedAction) => void;
}

interface Replay {
  readonly sessionID: string;
  readonly candidates: Recording[];
  recording: Recording;
  /** 录音 ID → 这次回放的 ID。 */
  ids: Map<string, string>;
  index: number;
  stopped: boolean;
  waiter: Waiter | undefined;
}

interface FakeSessionState {
  info: Session;
  status: SessionStatus['type'];
}

/** 假的 opencode：同时是 SDK（connect）与起服务器的函数（start）。 */
export class FakeOpenCode implements OpenCodeSdk {
  readonly sessions = new Map<string, FakeSessionState>();
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  /** 每个回合用哪份录音（按提示词选第一份；测试可以换）。 */
  readonly recordings = loadRecordings();
  /** 回放两条事件之间的间隔（毫秒）。 */
  delayMs = 0;
  providerList: ProviderListResponse = fakeProviderList();
  #counter = 0;
  #replays = new Map<string, Replay>();
  #subscribers = new Set<{ push: (event: Event) => void; end: (error?: Error) => void }>();
  #exit: ((exit: ServerExit) => void) | undefined;
  /** 回放还没走到 action 行时就到的回复（按请求 ID；abort 按会话 ID）。 */
  #early = new Map<string, RecordedAction>();
  #running = false;
  starts = 0;

  connect(input: OpenCodeConnectInput): OpenCodeClient {
    const record = (method: string, ...args: unknown[]) => this.calls.push({ method, args });
    return {
      health: async () => {
        record('health');
        return { healthy: true, version: FAKE_OPENCODE_VERSION };
      },
      providers: async () => {
        record('providers');
        return this.providerList;
      },
      createSession: async (body) => {
        record('createSession', body);
        return this.#createSession(input.directory, body.permission).info;
      },
      getSession: async (sessionID) => {
        record('getSession', sessionID);
        const state = this.sessions.get(sessionID);
        if (state === undefined) throw notFound(`session ${sessionID}`);
        return state.info;
      },
      updateSession: async (sessionID, body) => {
        record('updateSession', sessionID, body);
        const state = this.sessions.get(sessionID);
        if (state === undefined) throw notFound(`session ${sessionID}`);
        state.info = { ...state.info, permission: body.permission };
        return state.info;
      },
      children: async (sessionID) => {
        record('children', sessionID);
        return [...this.sessions.values()]
          .filter((state) => state.info.parentID === sessionID)
          .map((state) => state.info);
      },
      messages: async () => [],
      status: async () => {
        record('status');
        return Object.fromEntries(
          [...this.sessions.entries()].map(([id, state]): [string, SessionStatus] => [
            id,
            { type: state.status === 'busy' ? 'busy' : 'idle' } as SessionStatus,
          ]),
        );
      },
      promptAsync: async (body) => {
        record('promptAsync', body);
        this.#prompt(body);
      },
      abort: async (sessionID) => {
        record('abort', sessionID);
        this.#abort(sessionID);
      },
      replyPermission: async (requestID, reply, message) => {
        record('replyPermission', requestID, reply, message);
        this.#answer(
          { type: 'permission', reply, ...(message !== undefined && { message }) },
          requestID,
        );
      },
      replyQuestion: async (requestID, answers: QuestionAnswer[]) => {
        record('replyQuestion', requestID, answers);
        this.#answer({ type: 'question', answers }, requestID);
      },
      rejectQuestion: async (requestID) => {
        record('rejectQuestion', requestID);
      },
      subscribe: async (signal) => this.#subscribe(signal),
    };
  }

  /** 给适配器的 startServer。 */
  start = async (options: StartServerOptions): Promise<OpenCodeServerHandle> => {
    this.starts += 1;
    this.#running = true;
    const exited = new Promise<ServerExit>((resolve) => {
      this.#exit = resolve;
    });
    const version = await options.verify('http://127.0.0.1:0', 'fake-password');
    return {
      url: 'http://127.0.0.1:0',
      password: 'fake-password',
      version,
      pid: undefined,
      exited,
      stop: async () => {
        this.#running = false;
        this.#exit?.({ code: null, signal: 'SIGTERM', stderrTail: '' });
      },
    };
  };

  get running(): boolean {
    return this.#running;
  }

  /** 服务器意外退出：事件流断开，适配器收到退出通知。 */
  crash(exit: ServerExit = { code: 1, signal: null, stderrTail: 'fake crash' }): void {
    this.#running = false;
    for (const subscriber of this.#subscribers) subscriber.end(new Error('socket hang up'));
    this.#subscribers.clear();
    for (const replay of this.#replays.values()) replay.stopped = true;
    this.#exit?.(exit);
  }

  /** 直接发一条事件给所有订阅者（测试用）。 */
  emit(event: Event): void {
    for (const subscriber of this.#subscribers) subscriber.push(event);
  }

  #createSession(
    directory: string,
    permission: PermissionRuleset,
    parentID?: string,
  ): FakeSessionState {
    const id = `ses_fake${String(++this.#counter).padStart(4, '0')}`;
    const now = Date.now();
    const state: FakeSessionState = {
      info: {
        id,
        slug: id,
        projectID: 'global',
        directory,
        title: 'New session',
        version: FAKE_OPENCODE_VERSION,
        time: { created: now, updated: now },
        permission,
        ...(parentID !== undefined && { parentID }),
      },
      status: 'idle',
    };
    this.sessions.set(id, state);
    return state;
  }

  #subscribe(signal: AbortSignal): AsyncIterable<Event> {
    const queue: Event[] = [
      { id: 'evt_connected', type: 'server.connected', properties: {} } as Event,
    ];
    let wake: (() => void) | undefined;
    let ended = false;
    let failure: Error | undefined;
    const subscriber = {
      push: (event: Event) => {
        queue.push(event);
        wake?.();
      },
      end: (error?: Error) => {
        ended = true;
        failure = error;
        wake?.();
      },
    };
    this.#subscribers.add(subscriber);
    signal.addEventListener('abort', () => {
      this.#subscribers.delete(subscriber);
      subscriber.end();
    });
    const subscribers = this.#subscribers;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            if (queue.length > 0) {
              yield queue.shift() as Event;
              continue;
            }
            if (ended) {
              if (failure !== undefined && !signal.aborted) throw failure;
              return;
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
          }
        } finally {
          subscribers.delete(subscriber);
        }
      },
    };
  }

  #prompt(body: PromptInput): void {
    const text = body.parts.map((part) => part.text).join('\n');
    let candidates = this.recordings.filter((recording) => recording.prompt === text);
    if (candidates.length === 0) {
      candidates = this.recordings.filter((recording) => recording.name === 'plain');
    }
    // 审批默认走“允许”那份，回复时再换。
    const first =
      candidates.find((recording) => recording.name.endsWith('-accept')) ?? candidates[0];
    if (first === undefined) throw new Error('no recordings');
    const replayId = ++this.#counter;
    const ids = new Map<string, string>([
      [first.sessionID, body.sessionID],
      [first.messageID, body.messageID],
    ]);
    const replay: Replay = {
      sessionID: body.sessionID,
      candidates,
      recording: first,
      ids,
      index: 0,
      stopped: false,
      waiter: undefined,
    };
    const fresh = (id: string) => `${id}r${replayId}`;
    this.#replays.set(body.sessionID, replay);
    void this.#run(replay, fresh);
  }

  async #run(replay: Replay, fresh: (id: string) => string): Promise<void> {
    const sleep = () =>
      new Promise((resolve) =>
        this.delayMs > 0 ? setTimeout(resolve, this.delayMs) : setImmediate(resolve),
      );
    await sleep();
    while (!replay.stopped && replay.index < replay.recording.lines.length) {
      const line = replay.recording.lines[replay.index] as RecordingLine;
      replay.index += 1;
      if (line.action !== undefined) {
        const recorded = line.action;
        const lastRequest = this.#lastRequestId(replay, recorded.type);
        const earlyKey = recorded.type === 'abort' ? replay.sessionID : lastRequest;
        const early = earlyKey === undefined ? undefined : this.#early.get(earlyKey);
        if (earlyKey !== undefined) this.#early.delete(earlyKey);
        const answer =
          early ??
          (await new Promise<RecordedAction>((resolve) => {
            replay.waiter = {
              kind: recorded.type,
              ...(lastRequest !== undefined && { requestId: lastRequest }),
              resolve,
            };
          }));
        replay.waiter = undefined;
        if (replay.stopped) return;
        this.#switchBranch(replay, answer);
        continue;
      }
      const event = rewrite(line.event as Event, replay.ids, fresh);
      this.#track(event);
      this.emit(event);
      await sleep();
    }
    if (this.#replays.get(replay.sessionID) === replay) this.#replays.delete(replay.sessionID);
  }

  /** 录音里最近一个审批或提问请求（回放后的 ID）。 */
  #lastRequestId(replay: Replay, kind: RecordedAction['type']): string | undefined {
    for (let index = replay.index - 1; index >= 0; index -= 1) {
      const event = replay.recording.lines[index]?.event;
      if (kind === 'permission' && event?.type === 'permission.asked') {
        return replay.ids.get(event.properties.id);
      }
      if (kind === 'question' && event?.type === 'question.asked') {
        return replay.ids.get(event.properties.id);
      }
    }
    return undefined;
  }

  /** 回复与录音不同时换到对应的那份录音，接在它的 action 之后。 */
  #switchBranch(replay: Replay, answer: RecordedAction): void {
    const matches = (action: RecordedAction | undefined) =>
      action !== undefined &&
      action.type === answer.type &&
      (answer.type !== 'permission' ||
        (action.type === 'permission' &&
          (action.reply === 'reject') === (answer.reply === 'reject') &&
          (action.message !== undefined) === (answer.message !== undefined)));
    if (matches(replay.recording.lines[replay.index - 1]?.action)) return;
    const target = replay.candidates.find((recording) =>
      recording.lines.some((line) => matches(line.action)),
    );
    if (target === undefined) return;
    const actionIndex = target.lines.findIndex((line) => matches(line.action));
    const before = idsInOrder(replay.recording.lines.slice(0, replay.index));
    const after = idsInOrder(target.lines.slice(0, actionIndex));
    const ids = new Map<string, string>([
      [target.sessionID, replay.ids.get(replay.recording.sessionID) as string],
      [target.messageID, replay.ids.get(replay.recording.messageID) as string],
    ]);
    for (const [kind, targetIds] of after) {
      const sourceIds = before.get(kind) ?? [];
      targetIds.forEach((id, index) => {
        const source = sourceIds[index];
        const mapped = source === undefined ? undefined : replay.ids.get(source);
        if (mapped !== undefined && !ids.has(id)) ids.set(id, mapped);
      });
    }
    replay.recording = target;
    replay.ids = ids;
    replay.index = actionIndex + 1;
  }

  #answer(action: RecordedAction, requestId: string): void {
    for (const replay of this.#replays.values()) {
      const waiter = replay.waiter;
      if (waiter === undefined || waiter.kind !== action.type) continue;
      if (waiter.requestId !== undefined && waiter.requestId !== requestId) continue;
      waiter.resolve(action);
      return;
    }
    this.#early.set(requestId, action);
  }

  #abort(sessionID: string): void {
    const replay = this.#replays.get(sessionID);
    if (replay?.waiter?.kind === 'abort') {
      replay.waiter.resolve({ type: 'abort' });
      return;
    }
    const state = this.sessions.get(sessionID);
    if (state === undefined) throw notFound(`session ${sessionID}`);
    if (replay === undefined || replay.stopped || state.status !== 'busy') return;
    replay.stopped = true;
    replay.waiter?.resolve({ type: 'abort' });
    this.#replays.delete(sessionID);
    const now = Date.now();
    setImmediate(() => {
      state.status = 'idle';
      this.emit({
        id: `evt_abort${now}`,
        type: 'session.error',
        properties: {
          sessionID,
          error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
        },
      } as Event);
      this.emit({
        id: `evt_idle${now}`,
        type: 'session.status',
        properties: { sessionID, status: { type: 'idle' } },
      } as Event);
    });
  }

  /** 回放出的事件更新假服务器的状态（会话的忙闲、子会话）。 */
  #track(event: Event): void {
    if (event.type === 'session.created') {
      const info = event.properties.info;
      if (!this.sessions.has(info.id)) this.sessions.set(info.id, { info, status: 'idle' });
      return;
    }
    if (event.type === 'session.status') {
      const state = this.sessions.get(event.properties.sessionID);
      if (state !== undefined)
        state.status = event.properties.status.type === 'idle' ? 'idle' : 'busy';
    }
  }
}

/** 假的 `provider.list`：一个接上的上游 mock（模型 echo，带两个变体），一个没接上的。 */
export function fakeProviderList(): ProviderListResponse {
  const model = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    providerID: 'mock',
    name,
    api: { id, url: 'http://127.0.0.1:0/v1', npm: '@ai-sdk/openai-compatible' },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 8_192 },
    status: 'active',
    options: {},
    headers: {},
    release_date: '2026-01-01',
    ...extra,
  });
  return {
    all: [
      {
        id: 'mock',
        name: 'Mock',
        source: 'config',
        env: [],
        options: {},
        models: {
          echo: model('echo', 'Mock Echo', { variants: { low: {}, high: {} } }),
          plain: model('plain', 'Mock Plain', {
            capabilities: {
              ...model('plain', 'x').capabilities,
              reasoning: false,
              input: { text: true, audio: false, image: true, video: false, pdf: false },
            },
          }),
        },
      },
      { id: 'other', name: 'Other', source: 'api', env: ['OTHER_KEY'], options: {}, models: {} },
    ],
    default: { mock: 'echo' },
    connected: ['mock'],
  } as unknown as ProviderListResponse;
}
