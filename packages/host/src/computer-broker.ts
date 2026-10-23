// 电脑操作（0.112.0，domain-model §3.15.8）：截图、辅助功能与输入由桌面端主进程拉起的原生 helper 执行（系统权限归在 Wevir.app
// 上），Host 是另一个进程。照 browser-broker.ts：提供方是用 `computer.register` 登记过的 RPC 连接，请求经 `computer.request`
// 通知发出、`computer.respond` 回来；有几个提供方时交给最近登记的那个（授权、截图与元素引用都记在提供方那边，所以同一个会话
// 换了提供方要重新请求授权）。

import type {
  ComputerCommand,
  ComputerCommandName,
  ComputerContent,
  ComputerErrorCode,
  ComputerRequest,
  ComputerRequestId,
  ComputerResponse,
  ComputerResult,
  SessionId,
} from '@wevir/protocol';
import { COMPUTER_COMMANDS, COMPUTER_DEFAULT_TIMEOUT_MS } from '@wevir/protocol';
import { newId } from './ids.js';

/** 一个电脑操作的提供方（登记过的连接）。 */
export interface ComputerProvider {
  /** 连接的标识，同一条连接重新登记时替换旧的。 */
  readonly id: string;
  /** 它会的命令。 */
  readonly commands: readonly string[];
  /** 发出 `computer.request`；发不出去（连接在关）时返回 false。 */
  send(request: ComputerRequest): boolean;
}

export interface ComputerExecuteInput {
  sessionId: SessionId;
  command: ComputerCommand;
  /** 默认 `COMPUTER_DEFAULT_TIMEOUT_MS`。 */
  timeoutMs?: number;
  /** 工具调用被取消时中止。 */
  signal?: AbortSignal;
}

/** 回答去掉 `requestId`。 */
export type ComputerPayload =
  | { ok: true; result: ComputerResult }
  | {
      ok: false;
      error: { code: ComputerErrorCode | (string & {}); message: string };
      content?: ComputerContent[];
    };

interface Pending {
  providerId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (payload: ComputerPayload) => void;
}

interface Registered {
  provider: ComputerProvider;
  registeredAt: number;
  commands: ReadonlySet<string>;
}

const KNOWN_COMMANDS = new Set<string>(COMPUTER_COMMANDS);

export function computerFailure(code: ComputerErrorCode, message: string): ComputerPayload {
  return { ok: false, error: { code, message } };
}

export class ComputerBroker {
  readonly #defaultTimeoutMs: number;
  readonly #providers = new Map<string, Registered>();
  readonly #pending = new Map<ComputerRequestId, Pending>();
  #sequence = 0;

  constructor(options: { defaultTimeoutMs?: number } = {}) {
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? COMPUTER_DEFAULT_TIMEOUT_MS;
  }

  get available(): boolean {
    return this.#providers.size > 0;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  /** 登记；返回注销的函数（只注销这一次登记）。 */
  register(provider: ComputerProvider): () => void {
    this.unregister(provider.id);
    const registeredAt = ++this.#sequence;
    this.#providers.set(provider.id, {
      provider,
      registeredAt,
      commands: new Set(provider.commands.filter((command) => KNOWN_COMMANDS.has(command))),
    });
    return () => this.unregister(provider.id, registeredAt);
  }

  unregister(providerId: string, registeredAt?: number): void {
    const current = this.#providers.get(providerId);
    if (!current || (registeredAt !== undefined && current.registeredAt !== registeredAt)) return;
    this.#providers.delete(providerId);
    for (const [requestId, pending] of this.#pending) {
      if (pending.providerId !== providerId) continue;
      this.#settle(
        requestId,
        computerFailure(
          'computer_no_host',
          'The Wevir window doing computer use disconnected before it answered; it usually reconnects within a few seconds. Check the screen with computer_screenshot before repeating the action.',
        ),
      );
    }
  }

  /** 执行一个命令。永远 resolve：失败也是一个结果，交给模型看。 */
  async execute(input: ComputerExecuteInput): Promise<ComputerPayload> {
    if (input.signal?.aborted) return computerFailure('computer_unknown_error', 'cancelled');
    let latest: Registered | undefined;
    for (const provider of this.#providers.values()) {
      if (!latest || provider.registeredAt > latest.registeredAt) latest = provider;
    }
    if (latest === undefined) {
      return computerFailure(
        'computer_no_host',
        'Computer use is not available right now: no Wevir window is connected to provide it (the app may be closed, starting or reconnecting). Try again in a few seconds; if it keeps failing, ask the user to open Wevir.',
      );
    }
    const name: ComputerCommandName = input.command.command;
    if (!latest.commands.has(name)) {
      return computerFailure(
        'computer_unsupported',
        `This Wevir window does not support the computer command "${name}". Update Wevir.`,
      );
    }
    return this.#send(latest, input, input.timeoutMs ?? this.#defaultTimeoutMs);
  }

  /** 提供方的回答；不是这条连接的、已经超时或取消的返回 false。 */
  respond(providerId: string, response: ComputerResponse): boolean {
    const pending = this.#pending.get(response.requestId);
    if (!pending || pending.providerId !== providerId) return false;
    this.#settle(
      response.requestId,
      response.ok
        ? { ok: true, result: response.result }
        : {
            ok: false,
            error: response.error,
            ...(response.content !== undefined && { content: response.content }),
          },
    );
    return true;
  }

  /** Host 退出：在途的请求都以失败结束。 */
  close(): void {
    for (const requestId of [...this.#pending.keys()]) {
      this.#settle(requestId, computerFailure('computer_no_host', 'Wevir Host is shutting down.'));
    }
  }

  #send(provider: Registered, input: ComputerExecuteInput, timeoutMs: number) {
    const requestId = newId('crq');
    return new Promise<ComputerPayload>((resolve) => {
      const timer = setTimeout(
        () =>
          this.#settle(
            requestId,
            computerFailure(
              'computer_timeout',
              `Computer use did not answer within ${Math.round(timeoutMs / 1000)} s. Take a screenshot to see what happened before trying again.`,
            ),
          ),
        timeoutMs,
      );
      timer.unref?.();
      const onAbort = () =>
        this.#settle(requestId, computerFailure('computer_unknown_error', 'cancelled'));
      this.#pending.set(requestId, {
        providerId: provider.provider.id,
        timer,
        resolve: (payload) => {
          input.signal?.removeEventListener('abort', onAbort);
          resolve(payload);
        },
      });
      input.signal?.addEventListener('abort', onAbort, { once: true });
      let sent = false;
      try {
        sent = provider.provider.send({
          requestId,
          sessionId: input.sessionId,
          command: input.command,
        });
      } catch {
        sent = false;
      }
      if (!sent) {
        this.#settle(
          requestId,
          computerFailure('computer_no_host', 'Could not reach the Wevir desktop app.'),
        );
      }
    });
  }

  #settle(requestId: ComputerRequestId, payload: ComputerPayload): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(payload);
  }
}
