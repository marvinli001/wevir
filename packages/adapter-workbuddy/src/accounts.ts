import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AcpProcess } from '@wevir/adapter-acp';
import {
  type AccountKind,
  type AccountModels,
  type AccountState,
  AdapterError,
  type EngineAccounts,
} from '@wevir/runtime-adapter';
import { isWorkBuddyAuthRequired, WORKBUDDY_ENGINE } from './engine.js';
import {
  findWorkBuddy,
  parseWorkBuddyVersion,
  runWorkBuddy,
  WORKBUDDY_BIN_ENV,
  WORKBUDDY_INSTALL_COMMAND,
  WORKBUDDY_LOGIN_COMMAND,
  type WorkBuddyExecutable,
  WorkBuddyLauncher,
  workbuddyEnv,
} from './launch.js';
import { WORKBUDDY_DEFAULT_MODELS, workBuddyModels } from './models.js';

export const PROBE_TTL_MS = 5 * 60_000;
export const PROBE_TIMEOUT_MS = 15_000;
export const WORKBUDDY_SIGN_IN_HINT =
  'Run codebuddy in a terminal and sign in; use the same China/international environment, then check again';

export interface WorkBuddyAccountsOptions {
  workDir: string;
  env?: NodeJS.ProcessEnv;
  findExecutable?: (customPath: string | null) => string;
  probeSession?: (
    executable: WorkBuddyExecutable,
    signal: AbortSignal,
    workDir: string,
  ) => Promise<unknown>;
  now?: () => number;
}

interface Detection {
  state: AccountState;
  executable?: WorkBuddyExecutable;
  models?: AccountModels;
}

/** 只检测官方 CLI；不认证、不读取凭据、不请求 HTTP 接口。 */
export class WorkBuddyAccounts implements EngineAccounts {
  readonly kinds: readonly AccountKind[] = ['workbuddy'];
  readonly #options: WorkBuddyAccountsOptions;
  readonly #listeners = new Set<(state: AccountState) => void>();
  #customPath: string | null = null;
  #state: AccountState | undefined;
  #models: AccountModels = WORKBUDDY_DEFAULT_MODELS;
  #executable: WorkBuddyExecutable | undefined;
  #checkedAt = 0;
  #probing: Promise<AccountState> | undefined;
  readonly #probes = new Set<Promise<AccountState>>();
  #abort: AbortController | undefined;
  #revision = 0;
  #disposed = false;

  constructor(options: WorkBuddyAccountsOptions) {
    this.#options = options;
  }

  read(kind: AccountKind, options?: { refresh?: boolean }): Promise<AccountState> {
    this.#check(kind);
    if (options?.refresh !== true && this.#probing !== undefined) return this.#probing;
    if (
      options?.refresh !== true &&
      this.#state !== undefined &&
      this.#now() - this.#checkedAt < PROBE_TTL_MS
    ) {
      return Promise.resolve(this.#state);
    }
    return this.#probe(options?.refresh === true);
  }

  async models(kind: AccountKind): Promise<AccountModels> {
    this.#check(kind);
    if (this.#state === undefined) await this.read(kind);
    return this.#models;
  }

  async login(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    throw new AdapterError('invalid_input', WORKBUDDY_SIGN_IN_HINT);
  }

  cancelLogin(kind: AccountKind): Promise<AccountState> {
    return this.read(kind);
  }

  async logout(kind: AccountKind): Promise<AccountState> {
    this.#check(kind);
    throw new AdapterError('invalid_input', 'Sign out in the official codebuddy CLI');
  }

  setExecutablePath(kind: AccountKind, path: string | null): Promise<AccountState> {
    this.#check(kind);
    this.#customPath = path?.trim() || null;
    return this.#probe(true);
  }

  onChange(listener: (state: AccountState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get version(): string | undefined {
    return this.#state?.version;
  }

  async executable(): Promise<WorkBuddyExecutable> {
    const state = await this.read('workbuddy');
    if (this.#executable === undefined) {
      throw new AdapterError(
        'engine_unavailable',
        state.lastError ?? `Install CodeBuddy: ${WORKBUDDY_INSTALL_COMMAND}`,
      );
    }
    if (state.status !== 'signed_in')
      throw new AdapterError('missing_credentials', state.lastError ?? WORKBUDDY_SIGN_IN_HINT);
    return this.#executable;
  }

  markSignedOut(): void {
    if (this.#state === undefined || this.#disposed) return;
    this.#models = WORKBUDDY_DEFAULT_MODELS;
    this.#checkedAt = this.#now();
    this.#publish({ ...this.#state, status: 'signed_out', lastError: WORKBUDDY_SIGN_IN_HINT });
  }

  /** 仅当前模型的 thought_level 已知；保留此前同一目录里实际见过的其他模型档位。 */
  noteSessionModels(configOptions: unknown): void {
    const next = workBuddyModels(configOptions);
    if (next === undefined || this.#disposed) return;
    this.#models = {
      ...next,
      models: next.models.map((model) => {
        const previous = this.#models.models.find((old) => old.id === model.id);
        return model.reasoningEfforts === undefined && previous?.reasoningEfforts !== undefined
          ? { ...model, reasoningEfforts: previous.reasoningEfforts }
          : model;
      }),
    };
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#revision += 1;
    this.#abort?.abort();
    this.#listeners.clear();
    await Promise.all([...this.#probes].map((run) => run.catch(() => {})));
  }

  #check(kind: AccountKind): void {
    if (this.#disposed) throw new AdapterError('disposed', 'WorkBuddy adapter disposed');
    if (kind !== 'workbuddy')
      throw new AdapterError('invalid_input', `Not a WorkBuddy account: ${kind}`);
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #probe(force: boolean): Promise<AccountState> {
    if (this.#probing !== undefined && !force) return this.#probing;
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    const revision = ++this.#revision;
    const run = this.#detect(this.#customPath, abort.signal)
      .then((detected) => {
        if (revision === this.#revision && !this.#disposed) {
          this.#checkedAt = this.#now();
          this.#executable = detected.executable;
          this.#models = detected.models ?? WORKBUDDY_DEFAULT_MODELS;
          this.#publish(detected.state);
        }
        return detected.state;
      })
      .finally(() => {
        this.#probes.delete(run);
        if (this.#probing === run) this.#probing = undefined;
      });
    this.#probing = run;
    this.#probes.add(run);
    return run;
  }

  async #detect(customPath: string | null, signal: AbortSignal): Promise<Detection> {
    const base: AccountState = {
      kind: 'workbuddy',
      status: 'signed_out',
      signIn: 'command',
      loginCommand: WORKBUDDY_LOGIN_COMMAND,
      ...(customPath !== null && { customPath }),
    };
    const parent = this.#options.env ?? process.env;
    let executablePath: string;
    try {
      executablePath =
        this.#options.findExecutable?.(customPath) ??
        findWorkBuddy({ customPath, env: parent }).path;
    } catch {
      return {
        state: {
          ...base,
          installed: false,
          installCommand: WORKBUDDY_INSTALL_COMMAND,
          ...((customPath !== null || parent[WORKBUDDY_BIN_ENV] !== undefined) && {
            lastError: 'CodeBuddy executable path is unavailable',
          }),
        },
      };
    }
    const executable = { path: executablePath, env: workbuddyEnv(parent, executablePath) };
    const versionRun = await runWorkBuddy(
      executablePath,
      ['--version'],
      executable.env,
      10_000,
      signal,
    );
    const installed = { ...base, installed: true, executablePath };
    if (!versionRun.ok || versionRun.code !== 0) {
      return {
        state: {
          ...installed,
          lastError: 'CodeBuddy version check failed; Node 18.20.8+ required',
        },
      };
    }
    const version = parseWorkBuddyVersion(`${versionRun.stdout}\n${versionRun.stderr}`);
    const versioned = { ...installed, ...(version !== undefined && { version }) };
    try {
      const setup = await (this.#options.probeSession ?? probeWorkBuddySession)(
        executable,
        signal,
        this.#options.workDir,
      );
      return {
        executable,
        models: workBuddyModels(setup) ?? WORKBUDDY_DEFAULT_MODELS,
        state: {
          ...versioned,
          status: 'signed_in',
          ...(version === undefined && {
            lastError: 'Unrecognized CodeBuddy CLI version; ACP detection succeeded',
          }),
        },
      };
    } catch (error) {
      return {
        executable,
        state: {
          ...versioned,
          lastError: isWorkBuddyAuthRequired(error)
            ? WORKBUDDY_SIGN_IN_HINT
            : 'CodeBuddy ACP detection failed; update the CLI, check the account environment and refresh',
        },
      };
    }
  }

  #publish(state: AccountState): void {
    this.#state = state;
    for (const listener of [...this.#listeners]) {
      try {
        listener(state);
      } catch {
        /* 一个监听器不影响其他监听器。 */
      }
    }
  }
}

/** 空目录建会话只读取 configOptions；绝不 authenticate / prompt / getUserInfo。 */
export async function probeWorkBuddySession(
  executable: WorkBuddyExecutable,
  signal: AbortSignal,
  workDir: string,
): Promise<unknown> {
  const cwd = join(workDir, 'probe');
  mkdirSync(cwd, { recursive: true });
  const probe = new AcpProcess({
    engine: WORKBUDDY_ENGINE,
    launcher: new WorkBuddyLauncher(workDir, async () => executable),
    clientInfo: { name: 'wevir-workbuddy-probe', version: '0.0.0' },
    restart: { maxRestarts: 0 },
    onExtRequest: async () => ({ outcome: 'cancelled' }),
  });
  const onAbort = () => {
    void probe.dispose();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    if (signal.aborted) throw new AdapterError('disposed', 'WorkBuddy probe aborted');
    return await Promise.race([
      (async () => {
        await probe.start();
        const result = await probe.connection.agent.request<{ configOptions?: unknown }>(
          'session/new',
          { cwd, mcpServers: [] },
        );
        return result.configOptions;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('ACP probe timeout')), PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    await probe.dispose();
  }
}
