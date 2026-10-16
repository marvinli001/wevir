// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/server/src/server/browser-tools/broker.ts 与 errors.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0
// 由 Wevir 修改：提供方是登记过的 RPC 连接（`browser.register`），请求经 `browser.request` 通知发出、`browser.respond` 回来；请求带
// 调用的会话与它的目录，不再带 Paseo 的 agent / workspace；调用方中止（引擎取消了工具调用）时立即以失败结束；校验交给协议
// 的 schema 与 RPC 层，不用 zod 再解析一遍。
//
// 内置浏览器（0.33.0，domain-model §3.15）：Host 与浏览器不在一个进程里，应用级工具的 `browser_*` 经这里交给桌面端。

import type {
  BrowserCommand,
  BrowserCommandName,
  BrowserErrorCode,
  BrowserRequest,
  BrowserRequestId,
  BrowserResponse,
  BrowserResult,
  SessionId,
} from '@wevir/protocol';
import { BROWSER_COMMANDS } from '@wevir/protocol';
import { newId } from './ids.js';

/** 一个浏览器提供方（登记过的连接）。 */
export interface BrowserProvider {
  /** 连接的标识，同一条连接重新登记时替换旧的。 */
  readonly id: string;
  /** 它会的命令。 */
  readonly commands: readonly string[];
  /** 发出 `browser.request`；发不出去（连接在关）时返回 false。 */
  send(request: BrowserRequest): boolean;
}

export interface BrowserExecuteInput {
  sessionId: SessionId;
  cwd: string;
  command: BrowserCommand;
  /** 默认 `BROWSER_DEFAULT_TIMEOUT_MS`。 */
  timeoutMs?: number;
  /** 工具调用被取消时中止。 */
  signal?: AbortSignal;
}

/** 回答去掉 `requestId`：调用方不关心。 */
export type BrowserPayload =
  | { ok: true; result: BrowserResult; dialogs?: BrowserResponse['dialogs'] }
  | {
      ok: false;
      error: { code: BrowserErrorCode | (string & {}); message: string; retryable?: boolean };
      dialogs?: BrowserResponse['dialogs'];
    };

/** 一个请求的默认时限：新开的标签页要等页面载入。 */
export const BROWSER_DEFAULT_TIMEOUT_MS = 30_000;

interface Pending {
  providerId: string;
  rememberAffinity: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve: (payload: BrowserPayload) => void;
}

interface Registered {
  provider: BrowserProvider;
  registeredAt: number;
  commands: ReadonlySet<string>;
}

const KNOWN_COMMANDS = new Set<string>(BROWSER_COMMANDS);

export function browserFailure(
  code: BrowserErrorCode,
  message: string,
  retryable = false,
): BrowserPayload {
  return { ok: false, error: { code, message, retryable } };
}

/**
 * 把浏览器命令交给提供方。照 Paseo：新开标签页交给最近登记的提供方；带 `browserId` 的交给开出这个标签页的提供方（记在
 * 结果里，`list_tabs` 也会记下）；提供方断开时它的标签页记成“搁浅”，同一条连接重新登记后接着用；`list_tabs` 问所有提供方再
 * 合起来。
 */
export class BrowserBroker {
  readonly #defaultTimeoutMs: number;
  readonly #providers = new Map<string, Registered>();
  readonly #pending = new Map<BrowserRequestId, Pending>();
  readonly #ownerByTab = new Map<string, string>();
  readonly #strandedByTab = new Map<string, string>();
  #sequence = 0;

  constructor(options: { defaultTimeoutMs?: number } = {}) {
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? BROWSER_DEFAULT_TIMEOUT_MS;
  }

  /** 有没有提供方。 */
  get available(): boolean {
    return this.#providers.size > 0;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  /** 登记；返回注销的函数（只注销这一次登记，之后同一条连接重新登记的不受影响）。 */
  register(provider: BrowserProvider): () => void {
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
    for (const [browserId, owner] of this.#ownerByTab) {
      if (owner !== providerId) continue;
      this.#ownerByTab.delete(browserId);
      this.#strandedByTab.set(browserId, providerId);
    }
    for (const [requestId, pending] of this.#pending) {
      if (pending.providerId !== providerId) continue;
      this.#settle(
        requestId,
        browserFailure(
          'browser_no_host',
          'The Wevir desktop app disconnected before the browser answered.',
          true,
        ),
      );
    }
  }

  /** 执行一个命令。永远 resolve：失败也是一个结果，交给模型看。 */
  async execute(input: BrowserExecuteInput): Promise<BrowserPayload> {
    if (input.signal?.aborted) return browserFailure('browser_unknown_error', 'cancelled');
    const timeoutMs = input.timeoutMs ?? this.#defaultTimeoutMs;
    if (input.command.command === 'list_tabs') return this.#listTabs(input, timeoutMs);
    const selected = this.#select(input.command);
    if ('ok' in selected) return selected;
    const unsupported = this.#unsupported(selected, input.command.command);
    if (unsupported) return unsupported;
    return this.#send(selected, input, timeoutMs, true);
  }

  /** 提供方的回答；不是这条连接的、已经超时或取消的返回 false。 */
  respond(providerId: string, response: BrowserResponse): boolean {
    const pending = this.#pending.get(response.requestId);
    if (!pending || pending.providerId !== providerId) return false;
    const payload: BrowserPayload = response.ok
      ? {
          ok: true,
          result: response.result,
          ...(response.dialogs && { dialogs: response.dialogs }),
        }
      : {
          ok: false,
          error: response.error,
          ...(response.dialogs && { dialogs: response.dialogs }),
        };
    if (pending.rememberAffinity) this.#remember(providerId, payload);
    this.#settle(response.requestId, payload);
    return true;
  }

  /** Host 退出：在途的请求都以失败结束。 */
  close(): void {
    for (const requestId of [...this.#pending.keys()]) {
      this.#settle(requestId, browserFailure('browser_no_host', 'Wevir Host is shutting down.'));
    }
  }

  async #listTabs(input: BrowserExecuteInput, timeoutMs: number): Promise<BrowserPayload> {
    const providers = [...this.#providers.values()];
    if (providers.length === 0) return noProvider();
    for (const provider of providers) {
      const unsupported = this.#unsupported(provider, 'list_tabs');
      if (unsupported) return unsupported;
    }
    if (providers.length === 1) {
      return this.#send(providers[0] as Registered, input, timeoutMs, true);
    }
    const answers = await Promise.all(
      providers.map(async (provider) => ({
        provider,
        payload: await this.#send(provider, input, timeoutMs, false),
      })),
    );
    const failed = answers.find(({ payload }) => !payload.ok);
    if (failed) return failed.payload;
    for (const { provider, payload } of answers) this.#remember(provider.provider.id, payload);
    return {
      ok: true,
      result: {
        command: 'list_tabs',
        tabs: answers.flatMap(({ payload }) =>
          payload.ok && payload.result.command === 'list_tabs' ? payload.result.tabs : [],
        ),
      },
    };
  }

  #select(command: BrowserCommand): Registered | BrowserPayload {
    const browserId = browserIdOf(command);
    if (browserId === undefined) return this.#latest() ?? noProvider();
    const owner = this.#ownerByTab.get(browserId);
    if (owner !== undefined) {
      return this.#providers.get(owner) ?? stranded(browserId);
    }
    const strandedOwner = this.#strandedByTab.get(browserId);
    if (strandedOwner !== undefined) {
      const back = this.#providers.get(strandedOwner);
      if (!back) return stranded(browserId);
      this.#strandedByTab.delete(browserId);
      this.#ownerByTab.set(browserId, strandedOwner);
      return back;
    }
    if (this.#providers.size === 0) return noProvider();
    if (this.#providers.size === 1) return this.#latest() ?? noProvider();
    return browserFailure(
      'browser_tab_not_found',
      `Browser tab ${browserId} is not open in a connected Wevir window. Call browser_list_tabs and use one of the returned browserId values.`,
    );
  }

  #latest(): Registered | undefined {
    let latest: Registered | undefined;
    for (const provider of this.#providers.values()) {
      if (!latest || provider.registeredAt > latest.registeredAt) latest = provider;
    }
    return latest;
  }

  #unsupported(provider: Registered, command: BrowserCommandName): BrowserPayload | undefined {
    if (provider.commands.has(command)) return undefined;
    return browserFailure(
      'browser_unsupported',
      `This Wevir window does not support the browser command "${command}". Update Wevir.`,
    );
  }

  #remember(providerId: string, payload: BrowserPayload): void {
    if (!payload.ok) return;
    const { result } = payload;
    if (result.command === 'list_tabs') {
      for (const tab of result.tabs) {
        this.#ownerByTab.set(tab.browserId, providerId);
        this.#strandedByTab.delete(tab.browserId);
      }
      return;
    }
    if (result.command === 'close_tab') {
      this.#ownerByTab.delete(result.browserId);
      this.#strandedByTab.delete(result.browserId);
      return;
    }
    this.#ownerByTab.set(result.browserId, providerId);
    this.#strandedByTab.delete(result.browserId);
  }

  #send(
    provider: Registered,
    input: BrowserExecuteInput,
    timeoutMs: number,
    rememberAffinity: boolean,
  ): Promise<BrowserPayload> {
    const requestId = newId('brq');
    return new Promise<BrowserPayload>((resolve) => {
      const timer = setTimeout(
        () =>
          this.#settle(
            requestId,
            browserFailure(
              'browser_timeout',
              `The browser did not answer within ${Math.round(timeoutMs / 1000)} s.`,
              true,
            ),
          ),
        timeoutMs,
      );
      timer.unref?.();
      const onAbort = () =>
        this.#settle(requestId, browserFailure('browser_unknown_error', 'cancelled'));
      this.#pending.set(requestId, {
        providerId: provider.provider.id,
        rememberAffinity,
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
          cwd: input.cwd,
          command: input.command,
        });
      } catch {
        sent = false;
      }
      if (!sent) {
        this.#settle(
          requestId,
          browserFailure('browser_no_host', 'Could not reach the Wevir desktop app.', true),
        );
      }
    });
  }

  #settle(requestId: BrowserRequestId, payload: BrowserPayload): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(payload);
  }
}

function browserIdOf(command: BrowserCommand): string | undefined {
  if (command.command === 'list_tabs' || command.command === 'new_tab') return undefined;
  return command.args.browserId;
}

function noProvider(): BrowserPayload {
  return browserFailure(
    'browser_no_host',
    'The Wevir browser is not available: the Wevir desktop app is not open (or is too old to provide a browser).',
    true,
  );
}

function stranded(browserId: string): BrowserPayload {
  return browserFailure(
    'browser_no_host',
    `The Wevir window that holds browser tab ${browserId} disconnected.`,
    true,
  );
}
