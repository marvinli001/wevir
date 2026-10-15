// 测试用的假 Cursor SDK（sdk.ts 的 CursorSdk）：agent 在内存里，每次 send 按脚本回放一串 InteractionUpdate 再结束 run。不联网、
// 不碰 ~/.cursor。脚本按消息内容选（默认的 `scriptFor` 认契约测试的提示词，runtime-adapter 的 DEFAULT_CONTRACT_PROMPTS）。

import type {
  AgentOptions,
  InteractionUpdate,
  RunResult,
  SDKModel,
  SDKUser,
  SDKUserMessage,
  SdkLoginOptions,
  SdkLoginResult,
  SendOptions,
} from '@cursor/sdk';
import type { CursorAgentHandle, CursorRun, CursorSdk } from '../sdk.js';
import { PLAIN_UPDATES, TOOL_UPDATES } from './updates.js';

export interface RunScript {
  updates: InteractionUpdate[];
  result?: Partial<RunResult>;
  /** 每条更新之间等多久（ms）。 */
  stepMs?: number;
  /** 不自己结束，等 cancel。 */
  hang?: boolean;
  /** cancel 了也不结束（取消确认不了）。 */
  ignoreCancel?: boolean;
}

export function sdkError(
  name: string,
  message: string,
  extra: Record<string, unknown> = {},
): Error {
  return Object.assign(new Error(message), { name, ...extra });
}

/** 契约测试的提示词 → 脚本。 */
export function scriptFor(message: string): RunScript {
  if (/tool/i.test(message)) return { updates: TOOL_UPDATES.slice(0, 3), stepMs: 1 };
  if (/slowly/i.test(message)) {
    return {
      updates: Array.from({ length: 40 }, (_, index) => ({
        type: 'text-delta' as const,
        text: `word${index} `,
      })),
      stepMs: 50,
    };
  }
  return { updates: PLAIN_UPDATES, stepMs: 1 };
}

export const FAKE_MODELS: SDKModel[] = [
  {
    id: 'composer-2',
    displayName: 'Composer 2',
    parameters: [
      {
        id: 'effort',
        displayName: 'Effort',
        values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'turbo' }],
      },
      { id: 'fast', values: [{ value: 'true' }, { value: 'false' }] },
    ],
    variants: [
      {
        displayName: 'Composer 2',
        isDefault: true,
        params: [{ id: 'effort', value: 'medium' }],
      },
    ],
  },
  { id: 'gpt-6', displayName: 'GPT-6' },
];

export const FAKE_USER: SDKUser = {
  apiKeyName: 'Wevir',
  userEmail: 'me@example.com',
  createdAt: '2026-10-01T00:00:00Z',
};

class FakeRun implements CursorRun {
  readonly id: string;
  readonly agentId: string;
  readonly #script: RunScript;
  readonly #onDelta: SendOptions['onDelta'];
  #cancelled = false;
  #finish: ((result: RunResult) => void) | undefined;
  readonly #result: Promise<RunResult>;
  cancelCalls = 0;

  constructor(id: string, agentId: string, script: RunScript, onDelta: SendOptions['onDelta']) {
    this.id = id;
    this.agentId = agentId;
    this.#script = script;
    this.#onDelta = onDelta;
    this.#result = new Promise((resolve) => {
      this.#finish = resolve;
    });
  }

  /** 开始回放（send 返回之后，像 SDK 那样在后台跑）。 */
  async play(): Promise<void> {
    for (const update of this.#script.updates) {
      if (this.#cancelled) return;
      if (this.#script.stepMs !== undefined) await sleep(this.#script.stepMs);
      if (this.#cancelled) return;
      await this.#onDelta?.({ update });
    }
    if (this.#script.hang || this.#cancelled) return;
    this.#finish?.({ id: this.id, status: 'finished', ...this.#script.result });
  }

  wait(): Promise<RunResult> {
    return this.#result;
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
    if (this.#script.ignoreCancel) return;
    this.#cancelled = true;
    this.#finish?.({ id: this.id, status: 'cancelled' });
  }
}

export class FakeAgent implements CursorAgentHandle {
  readonly agentId: string;
  readonly options: AgentOptions;
  readonly #sdk: FakeCursorSdk;
  readonly sent: Array<{ message: string | SDKUserMessage; options: SendOptions | undefined }> = [];
  readonly runs: FakeRun[] = [];
  closed = false;

  constructor(sdk: FakeCursorSdk, agentId: string, options: AgentOptions) {
    this.#sdk = sdk;
    this.agentId = agentId;
    this.options = options;
  }

  async send(message: string | SDKUserMessage, options?: SendOptions): Promise<CursorRun> {
    if (this.closed) throw new Error('agent is closed');
    const conflict = this.#sdk.activeRunConflicts.get(this.agentId);
    if (conflict !== undefined) {
      throw sdkError(
        'ConfigurationError',
        `Agent ${this.agentId} already has active run ${conflict}`,
      );
    }
    this.sent.push({ message, options });
    const text = typeof message === 'string' ? message : message.text;
    const script = this.#sdk.script(text);
    const run = new FakeRun(`run-${++this.#sdk.runCount}`, this.agentId, script, options?.onDelta);
    this.runs.push(run);
    // SDK 在 send 返回之前就可能调 onDelta（adapter 要先存着）：第一条更新同步送出。
    if (this.#sdk.deltaBeforeSend && script.updates[0] !== undefined) {
      await options?.onDelta?.({ update: script.updates[0] });
      script.updates = script.updates.slice(1);
    }
    queueMicrotask(() => void run.play());
    return run;
  }

  close(): void {
    this.closed = true;
  }
}

export class FakeCursorSdk implements CursorSdk {
  /** 已有的 agent（`resumeAgent` 认它们）。 */
  readonly known = new Set<string>();
  readonly agents: FakeAgent[] = [];
  /** agentId → 遗留 run 的 ID：下一次 send 报“already has active run”，cancelRun 之后消失。 */
  readonly activeRunConflicts = new Map<string, string>();
  readonly cancelledRuns: string[] = [];
  script: (message: string) => RunScript = scriptFor;
  deltaBeforeSend = false;
  runCount = 0;
  agentCount = 0;
  /** `me` 的结果；是 Error 时抛它。 */
  user: SDKUser | Error = FAKE_USER;
  models: SDKModel[] | Error = FAKE_MODELS;
  meCalls = 0;
  modelCalls = 0;
  /** `login` 的替身；默认立即给网址，等测试调 `completeLogin`。 */
  pendingLogin: { options: SdkLoginOptions; resolve: (key: string) => void } | undefined;

  async createAgent(options: AgentOptions): Promise<CursorAgentHandle> {
    const agent = new FakeAgent(this, `agent-${++this.agentCount}`, options);
    this.known.add(agent.agentId);
    this.agents.push(agent);
    return agent;
  }

  async resumeAgent(agentId: string, options: AgentOptions): Promise<CursorAgentHandle> {
    if (!this.known.has(agentId)) {
      throw sdkError('AgentNotFoundError', `Agent ${agentId} not found`, {
        code: 'agent_not_found',
      });
    }
    const agent = new FakeAgent(this, agentId, options);
    this.agents.push(agent);
    return agent;
  }

  async listRuns(agentId: string) {
    const conflict = this.activeRunConflicts.get(agentId);
    return {
      items: conflict === undefined ? [] : [{ id: conflict, status: 'running' }],
    };
  }

  async cancelRun(runId: string): Promise<void> {
    this.cancelledRuns.push(runId);
    for (const [agentId, conflict] of this.activeRunConflicts) {
      if (conflict === runId) this.activeRunConflicts.delete(agentId);
    }
  }

  async me(apiKey: string): Promise<SDKUser> {
    this.meCalls += 1;
    if (apiKey === 'revoked') throw sdkError('AuthenticationError', 'invalid api key');
    if (this.user instanceof Error) throw this.user;
    return this.user;
  }

  async listModels(apiKey: string): Promise<SDKModel[]> {
    this.modelCalls += 1;
    if (apiKey === 'revoked') throw sdkError('AuthenticationError', 'invalid api key');
    if (this.models instanceof Error) throw this.models;
    return this.models;
  }

  login(options: SdkLoginOptions): Promise<SdkLoginResult> {
    return new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () =>
        reject(sdkError('AuthenticationError', 'Login was cancelled.')),
      );
      this.pendingLogin = {
        options,
        resolve: (apiKey) => {
          const credentials = {
            version: 1 as const,
            backendUrl: 'https://api2.cursor.sh',
            apiKey,
            apiKeyExpiresAtMs: Date.now() + 90 * 86_400_000,
            email: 'me@example.com',
            createdAtMs: Date.now(),
          };
          void options.store?.save(credentials).then(() =>
            resolve({
              apiKey,
              email: 'me@example.com',
              apiKeyExpiresAtMs: credentials.apiKeyExpiresAtMs,
            }),
          );
        },
      };
      options.onLoginUrl?.(
        'https://cursor.com/loginDeepControl?challenge=x&uuid=y&mode=login&redirectTarget=sdk',
      );
    });
  }

  /** 浏览器那边登录完成。 */
  completeLogin(apiKey = 'key-from-login'): void {
    const pending = this.pendingLogin;
    this.pendingLogin = undefined;
    pending?.resolve(apiKey);
  }

  /** 当前（最近一个）挂着的这个 agent。 */
  agent(agentId: string): FakeAgent {
    const agent = this.agents.filter((candidate) => candidate.agentId === agentId).at(-1);
    if (agent === undefined) throw new Error(`no fake agent ${agentId}`);
    return agent;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
