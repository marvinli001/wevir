// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-opencode/src/server/status.ts（`checkOpenCodeProviderStatus`、`formatOpenCodeProbeError`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写成不依赖 `effect` 的普通 TS，输出 Wevir 的 `AccountState`（`EngineAccounts`）；“已登录”与套餐显示接上了哪些上游；
// 不读 skills、slash 命令与 agent 列表；不支持外部服务器的网址与密码（只用本机起的服务器）。
//
// OpenCode 的账号（opencode-event-mapping.md §2）：Wevir 自己不登录，用户在终端里 `opencode auth login` 接上游（Anthropic、
// OpenAI、OpenCode Zen、GitHub Copilot…，凭据在 opencode 自己的数据目录里，Wevir 不读）。照 T3：先找 `opencode` 跑 `--version`，
// 再起本机服务器读 `provider.list`——`connected` 里有上游就算已登录，套餐写接上了哪些。结果缓存 5 分钟，`read` 带 `refresh` 时
// 重新检测。

import { mkdirSync } from 'node:fs';
import {
  type AccountKind,
  type AccountLoginMethod,
  type AccountModels,
  type AccountState,
  AdapterError,
  type EngineAccounts,
} from '@wevir/runtime-adapter';
import { OPENCODE_INSTALL_COMMAND, OPENCODE_LOGIN_COMMAND } from './executable.js';
import { accountModels, contextWindowOf, planLabel } from './models.js';
import type { OpenCodeRuntime } from './runtime.js';
import { errorMessage, type ProviderListResponse } from './sdk.js';

/** 检测结果的有效期（同 adapter-claude 的 PROBE_TTL_MS）。 */
export const PROBE_TTL_MS = 5 * 60_000;

export interface OpenCodeAccountsOptions {
  runtime: OpenCodeRuntime;
  now?: () => number;
}

/** OpenCode 的 `EngineAccounts`：只有一种 `opencode`。 */
export class OpenCodeAccounts implements EngineAccounts {
  readonly kinds: readonly AccountKind[] = Object.freeze(['opencode' as const]);
  readonly #options: OpenCodeAccountsOptions;
  readonly #listeners = new Set<(state: AccountState) => void>();
  #state: AccountState | undefined;
  #providers: ProviderListResponse | undefined;
  #checkedAt = 0;
  #probing: Promise<AccountState> | undefined;
  #disposed = false;

  constructor(options: OpenCodeAccountsOptions) {
    this.#options = options;
  }

  async read(kind: AccountKind, options?: { refresh?: boolean }): Promise<AccountState> {
    this.#check(kind);
    const fresh =
      this.#state !== undefined &&
      this.#now() - this.#checkedAt < PROBE_TTL_MS &&
      this.#probing === undefined;
    if (fresh && options?.refresh !== true) return this.#state as AccountState;
    return this.#probe(options?.refresh === true);
  }

  async login(kind: AccountKind, _method?: AccountLoginMethod): Promise<AccountState> {
    this.#check(kind);
    throw new AdapterError(
      'invalid_input',
      `OpenCode uses your own opencode login: run \`${OPENCODE_LOGIN_COMMAND}\` in a terminal, then check again`,
    );
  }

  async cancelLogin(kind: AccountKind): Promise<AccountState> {
    return this.read(kind);
  }

  async logout(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    throw new AdapterError(
      'invalid_input',
      'OpenCode uses your own opencode login: run `opencode auth logout` in a terminal',
    );
  }

  async models(kind: AccountKind): Promise<AccountModels> {
    this.#check(kind);
    if (this.#providers === undefined) await this.read(kind);
    return this.#providers === undefined ? { models: [] } : accountModels(this.#providers);
  }

  async setExecutablePath(kind: AccountKind, path: string | null): Promise<AccountState> {
    this.#check(kind);
    const trimmed = path?.trim();
    await this.#options.runtime.setCustomPath(
      trimmed === undefined || trimmed === '' ? null : trimmed,
    );
    return this.#probe(true);
  }

  onChange(listener: (state: AccountState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * 会话要用之前：最近一次检测的结果，没检测过或已过期时先检测。没装或版本不能用时报 `engine_unavailable`，没接上游时报
   * `missing_credentials`（同 ChatGPT 会话，ADR-0005 补记 10）。
   */
  async requireReady(): Promise<void> {
    const state = await this.read('opencode');
    if (this.#options.runtime.installation === undefined) {
      throw new AdapterError(
        'engine_unavailable',
        state.lastError ??
          `opencode was not found; install it with \`${OPENCODE_INSTALL_COMMAND}\``,
      );
    }
    if (state.status !== 'signed_in') {
      throw new AdapterError(
        'missing_credentials',
        `OpenCode has no connected provider: run \`${OPENCODE_LOGIN_COMMAND}\` in a terminal, then check again`,
      );
    }
  }

  /** 模型的上下文窗口（来自最近一次的 `provider.list`）。 */
  contextWindow(modelId: string): number | undefined {
    return contextWindowOf(this.#providers, modelId);
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }

  #check(kind: AccountKind): void {
    if (this.#disposed) throw new AdapterError('disposed', 'the OpenCode engine has been disposed');
    if (kind !== 'opencode') {
      throw new AdapterError('invalid_input', `not an OpenCode account kind: ${kind}`);
    }
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #probe(force: boolean): Promise<AccountState> {
    if (this.#probing !== undefined && !force) return this.#probing;
    const run = this.#detect().then(
      (state) => {
        if (this.#probing === run) this.#probing = undefined;
        this.#checkedAt = this.#now();
        this.#publish(state);
        return state;
      },
      (error: unknown) => {
        if (this.#probing === run) this.#probing = undefined;
        throw error;
      },
    );
    this.#probing = run;
    return run;
  }

  async #detect(): Promise<AccountState> {
    const runtime = this.#options.runtime;
    const base: AccountState = {
      kind: 'opencode',
      status: 'signed_out',
      signIn: 'command',
      loginCommand: OPENCODE_LOGIN_COMMAND,
      ...(runtime.customPath !== null && { customPath: runtime.customPath }),
    };
    const detection = await runtime.detect();
    if (!detection.ok) {
      this.#providers = undefined;
      return {
        ...base,
        installed: detection.reason !== 'missing',
        installCommand: OPENCODE_INSTALL_COMMAND,
        ...(detection.executablePath !== undefined && {
          executablePath: detection.executablePath,
        }),
        ...(detection.version !== undefined && { version: detection.version }),
        ...(detection.message !== undefined && { lastError: detection.message }),
      };
    }
    const { installation } = detection;
    const installed: AccountState = {
      ...base,
      installed: true,
      executablePath: installation.executablePath,
      ...(installation.version !== undefined && { version: installation.version }),
    };
    let providers: ProviderListResponse;
    try {
      mkdirSync(runtime.engineDir, { recursive: true });
      const lease = await runtime.acquire();
      try {
        providers = await lease.client(runtime.engineDir).providers(runtime.signal);
      } finally {
        lease.release();
      }
    } catch (error) {
      this.#providers = undefined;
      return {
        ...installed,
        lastError: `Failed to load the OpenCode provider list: ${errorMessage(error)}`,
      };
    }
    this.#providers = providers;
    const label = planLabel(providers);
    if (label === undefined) return installed;
    return {
      ...installed,
      status: 'signed_in',
      plan: providers.connected.join(','),
      planLabel: label,
    };
  }

  #publish(state: AccountState): void {
    this.#state = state;
    for (const listener of [...this.#listeners]) {
      try {
        listener(state);
      } catch {
        // 监听器里抛错不影响别的监听器（EngineAccounts.onChange 的约定）。
      }
    }
  }
}
