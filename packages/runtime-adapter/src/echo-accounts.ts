// 开发用的假订阅账号（0.19.0）：没有真实订阅时，让 Host、设置页与模型选择器能把订阅来源的各种状态走一遍。只给 echo 引擎用
// （Host 的 `--adapter echo` 在环境变量 WEVIR_ECHO_SUBSCRIPTIONS 设了时挂上），不碰任何真实凭据、不联网。

import type { EngineAccounts } from './adapter.js';
import { AdapterError } from './errors.js';
import type {
  AccountKind,
  AccountLoginMethod,
  AccountLoginOptions,
  AccountModels,
  AccountState,
  AccountUpstream,
  SubscriptionKind,
} from './types.js';

/** 一种订阅的初始情形：已登录、未登录、没装（有安装命令），或没装但 Wevir 能下载。 */
export type EchoAccountScenario = 'signed_in' | 'signed_out' | 'missing' | 'installable';

export const ECHO_SUBSCRIPTION_KINDS: readonly SubscriptionKind[] = [
  'claude',
  'cursor',
  'opencode',
  'grok',
  'antigravity',
  'workbuddy',
];

const DEFAULT_SCENARIOS: Readonly<Record<SubscriptionKind, EchoAccountScenario>> = {
  claude: 'signed_in',
  cursor: 'signed_out',
  opencode: 'installable',
  grok: 'signed_in',
  antigravity: 'installable',
  workbuddy: 'signed_out',
};

/** 每种订阅的登录方式与安装说明，照各自 CLI 的真实做法（T3 Code 的调研）。 */
const PROFILES: Readonly<
  Record<
    SubscriptionKind,
    Pick<AccountState, 'signIn' | 'loginMethods' | 'loginCommand' | 'installCommand' | 'installUrl'>
  >
> = {
  claude: {
    signIn: 'command',
    loginCommand: 'claude auth login',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
  },
  cursor: { signIn: 'in_app', loginMethods: ['browser'] },
  opencode: {
    signIn: 'in_app',
    loginMethods: ['browser', 'device_code'],
    loginCommand: 'opencode auth login',
    installCommand: 'npm install -g opencode-ai',
  },
  grok: {
    signIn: 'command',
    loginCommand: 'grok login',
    installCommand: 'npm install -g @xai-official/grok',
  },
  antigravity: { signIn: 'in_app', loginMethods: ['browser'] },
  workbuddy: {
    signIn: 'command',
    loginCommand: 'codebuddy',
    installCommand: 'npm install -g @tencent-ai/codebuddy-code',
  },
};

const MODELS: Readonly<Record<SubscriptionKind, AccountModels>> = {
  claude: {
    models: [
      {
        id: 'claude-opus-5-5',
        displayName: 'Claude Opus 5.5',
        reasoningEfforts: ['low', 'medium', 'high', 'max'],
      },
      {
        id: 'claude-sonnet-5-5',
        displayName: 'Claude Sonnet 5.5',
        reasoningEfforts: ['low', 'medium', 'high'],
      },
      { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5' },
    ],
    defaultModelId: 'claude-opus-5-5',
  },
  cursor: {
    models: [
      { id: 'auto', displayName: 'Auto' },
      { id: 'composer', displayName: 'Composer' },
    ],
    defaultModelId: 'auto',
  },
  opencode: {
    models: [{ id: 'anthropic/claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5 · Anthropic' }],
    defaultModelId: 'anthropic/claude-sonnet-5-5',
  },
  grok: {
    models: [
      { id: 'grok-code', displayName: 'Grok Code', reasoningEfforts: ['low', 'high'] },
      { id: 'grok', displayName: 'Grok' },
    ],
    defaultModelId: 'grok-code',
  },
  workbuddy: {
    models: [{ id: 'workbuddy-auto', displayName: 'Auto' }],
    defaultModelId: 'workbuddy-auto',
  },
  antigravity: {
    models: [
      { id: 'gemini-pro', displayName: 'Gemini Pro' },
      { id: 'gemini-flash', displayName: 'Gemini Flash' },
    ],
    defaultModelId: 'gemini-pro',
  },
};

const API_KEY = { type: 'api_key', label: 'API key', option: 'default' } as const;

/** 假的 OpenCode 上游（`account.upstreams`）：常用的几家，各种登录方式都有，另有几家不常用的。 */
const ECHO_UPSTREAMS: readonly AccountUpstream[] = [
  { id: 'opencode', name: 'OpenCode Zen', connected: true, featured: true, methods: [API_KEY] },
  { id: 'anthropic', name: 'Anthropic', connected: false, featured: true, methods: [API_KEY] },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    connected: false,
    featured: true,
    methods: [{ type: 'oauth', label: 'Login with GitHub Copilot', option: '0' }],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    connected: false,
    featured: true,
    methods: [
      { type: 'oauth', label: 'ChatGPT Pro/Plus (browser)', option: '0' },
      { type: 'oauth', label: 'ChatGPT Pro/Plus (headless)', option: '1' },
      { type: 'api_key', label: 'Manually enter API Key', option: '2' },
    ],
  },
  { id: 'groq', name: 'Groq', connected: false, featured: false, methods: [API_KEY] },
  { id: 'mistral', name: 'Mistral', connected: false, featured: false, methods: [API_KEY] },
  { id: 'xai', name: 'xAI', connected: false, featured: false, methods: [API_KEY] },
];

const PLANS: Readonly<Partial<Record<SubscriptionKind, { plan: string; planLabel: string }>>> = {
  claude: { plan: 'max', planLabel: 'Max 20x' },
  cursor: { plan: 'pro', planLabel: 'Pro' },
  opencode: { plan: 'zen', planLabel: 'Zen' },
  grok: { plan: 'supergrok', planLabel: 'SuperGrok' },
  antigravity: { plan: 'ai-pro', planLabel: 'Google AI Pro' },
};

/**
 * 已登录时报的用量（会话侧栏的“用量”卡片、设置里订阅详情的用量条）：只有 Claude 报，照它的 5 小时与 7 天两个窗口；重置时间
 * 从现在算起，5 小时窗口约 4.5 小时后、每周窗口 4 天后。
 */
function echoRateLimits(
  kind: SubscriptionKind,
  now = Date.now(),
): Pick<AccountState, 'rateLimits'> {
  if (kind !== 'claude') return {};
  const at = (ms: number) => new Date(now + ms).toISOString();
  return {
    rateLimits: {
      primary: { usedPercent: 37, windowMinutes: 300, resetsAt: at((4 * 60 + 29.5) * 60_000) },
      secondary: { usedPercent: 90, windowMinutes: 10080, resetsAt: at(4 * 24 * 3_600_000) },
    },
  };
}

/**
 * 解析 `WEVIR_ECHO_SUBSCRIPTIONS`：`1` 用默认情形；也可以逐项写 `claude=signed_out,antigravity=signed_in`，没写的用默认。
 * 认不出的项忽略。
 */
export function parseEchoScenarios(
  value: string | undefined,
): Record<SubscriptionKind, EchoAccountScenario> {
  const scenarios = { ...DEFAULT_SCENARIOS };
  for (const part of (value ?? '').split(',')) {
    const [kind, scenario] = part.split('=').map((item) => item.trim());
    if (
      kind !== undefined &&
      scenario !== undefined &&
      (ECHO_SUBSCRIPTION_KINDS as readonly string[]).includes(kind) &&
      ['signed_in', 'signed_out', 'missing', 'installable'].includes(scenario)
    ) {
      scenarios[kind as SubscriptionKind] = scenario as EchoAccountScenario;
    }
  }
  return scenarios;
}

export interface EchoAccountsOptions {
  scenarios?: Partial<Record<SubscriptionKind, EchoAccountScenario>>;
  /** 应用内登录、下载安装多久完成，默认 1500 ms。 */
  delayMs?: number;
}

/** 假的订阅账号：状态在内存里，登录与安装过一会儿自己完成。 */
export class EchoAccounts implements EngineAccounts {
  readonly kinds: readonly AccountKind[] = ECHO_SUBSCRIPTION_KINDS;
  readonly #states = new Map<SubscriptionKind, AccountState>();
  readonly #listeners = new Set<(state: AccountState) => void>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  readonly #delayMs: number;
  /** 假的 OpenCode 里接上的上游。 */
  readonly #connected = new Set<string>(['opencode']);

  constructor(options: EchoAccountsOptions = {}) {
    this.#delayMs = options.delayMs ?? 1500;
    for (const kind of ECHO_SUBSCRIPTION_KINDS) {
      const scenario = options.scenarios?.[kind] ?? DEFAULT_SCENARIOS[kind];
      this.#states.set(kind, initialState(kind, scenario));
    }
  }

  async read(kind: AccountKind): Promise<AccountState> {
    return this.#get(kind);
  }

  async upstreams(kind: AccountKind): Promise<AccountUpstream[]> {
    if (kind !== 'opencode') throw new Error(`the ${kind} account has no upstreams`);
    return ECHO_UPSTREAMS.map((upstream) => ({
      ...upstream,
      connected: this.#connected.has(upstream.id),
    }));
  }

  async login(
    kind: AccountKind,
    method: AccountLoginMethod,
    options?: AccountLoginOptions,
  ): Promise<AccountState> {
    const state = this.#get(kind);
    if (state.signIn !== 'in_app') throw new Error(`run \`${state.loginCommand}\` in a terminal`);
    if (state.installed === false) throw new Error(`${kind} is not installed`);
    if (options?.upstream !== undefined) return this.#connect(state, options.upstream, options);
    const loginId = `echo-${kind}-${Date.now()}`;
    const next = this.#set({
      ...withoutLogin(state),
      status: 'signing_in',
      login: {
        loginId,
        method,
        authUrl: `https://example.com/echo-login/${kind}`,
        startedAt: new Date().toISOString(),
      },
    });
    this.#later(() => {
      const current = this.#get(kind);
      if (current.login?.loginId !== loginId) return;
      this.#set({
        ...withoutLogin(current),
        status: 'signed_in',
        email: 'me@example.com',
        ...PLANS[kind as SubscriptionKind],
        ...echoRateLimits(kind as SubscriptionKind),
      });
    });
    return next;
  }

  async cancelLogin(kind: AccountKind, loginId?: string): Promise<AccountState> {
    const state = this.#get(kind);
    if (state.login === undefined || (loginId !== undefined && state.login.loginId !== loginId)) {
      return state;
    }
    return this.#set({ ...withoutLogin(state), status: 'signed_out' });
  }

  async logout(kind: AccountKind, options?: { upstream?: string }): Promise<AccountState> {
    if (options?.upstream !== undefined) {
      if (!this.#connected.has(options.upstream) || options.upstream === 'opencode') {
        throw new AdapterError('invalid_input', `${options.upstream} cannot be disconnected here`);
      }
      this.#connected.delete(options.upstream);
      return this.#set(this.#withUpstreams(this.#get(kind)));
    }
    const {
      email: _email,
      plan: _plan,
      planLabel: _label,
      rateLimits: _limits,
      ...rest
    } = withoutLogin(this.#get(kind));
    return this.#set({ ...rest, status: 'signed_out' });
  }

  async models(kind: AccountKind): Promise<AccountModels> {
    return MODELS[kind as SubscriptionKind] ?? { models: [] };
  }

  async setExecutablePath(kind: AccountKind, path: string | null): Promise<AccountState> {
    const state = this.#get(kind);
    if (path === null) {
      const { customPath: _custom, ...rest } = state;
      return this.#set(rest);
    }
    return this.#set({
      ...state,
      installed: true,
      customPath: path,
      executablePath: path,
      version: '0.0.0-echo',
    });
  }

  async install(kind: AccountKind): Promise<AccountState> {
    const state = this.#get(kind);
    if (state.canInstall !== true) throw new Error(`${kind} cannot be installed by Wevir`);
    if (state.installing !== undefined) return state;
    const total = 293_601_280;
    const next = this.#set({ ...state, installing: { completedBytes: 0, totalBytes: total } });
    const steps = 5;
    for (let step = 1; step <= steps; step++) {
      this.#later(
        () => {
          const current = this.#get(kind);
          if (step < steps) {
            this.#set({
              ...current,
              installing: { completedBytes: (total * step) / steps, totalBytes: total },
            });
            return;
          }
          const { installing: _done, canInstall: _can, ...rest } = current;
          const installed: AccountState = {
            ...rest,
            installed: true,
            version: '1.3.0',
            executablePath: `/echo/${kind}`,
          };
          // 真的 opencode 一装好就接着 OpenCode Zen 的免登录模型，是已登录。
          this.#set(kind === 'opencode' ? this.#withUpstreams(installed) : installed);
        },
        (this.#delayMs * step) / steps,
      );
    }
    return next;
  }

  onChange(listener: (state: AccountState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#listeners.clear();
  }

  /** 接上假的上游：Key 立即接上；OAuth 给授权网址（headless 给设备码），过一会儿自己完成。 */
  #connect(state: AccountState, id: string, options: AccountLoginOptions): AccountState {
    const upstream = ECHO_UPSTREAMS.find((entry) => entry.id === id);
    if (upstream === undefined) throw new AdapterError('invalid_input', `no upstream "${id}"`);
    const method =
      upstream.methods.find((entry) => entry.option === options.option) ??
      (upstream.methods.length === 1 ? upstream.methods[0] : undefined);
    if (method === undefined)
      throw new AdapterError('invalid_input', `${upstream.name}: pick a method`);
    if (method.type === 'api_key') {
      if ((options.apiKey ?? '').trim() === '') {
        throw new AdapterError('invalid_input', `An API key is required for ${upstream.name}`);
      }
      this.#connected.add(id);
      return this.#set(this.#withUpstreams(state));
    }
    const loginId = `echo-opencode-${id}-${Date.now()}`;
    const headless = method.label.includes('headless');
    const next = this.#set({
      ...withoutLogin(state),
      status: state.status === 'signed_in' ? 'signed_in' : 'signing_in',
      login: {
        loginId,
        method: headless ? 'device_code' : 'browser',
        ...(headless
          ? { verificationUrl: 'https://example.com/echo-device', userCode: 'ECHO-1234' }
          : { authUrl: `https://example.com/echo-login/${id}` }),
        startedAt: new Date().toISOString(),
      },
    });
    this.#later(() => {
      const current = this.#get(state.kind);
      if (current.login?.loginId !== loginId) return;
      this.#connected.add(id);
      this.#set(this.#withUpstreams(withoutLogin(current)));
    });
    return next;
  }

  /** 接上的上游变了：套餐写上游的名字，有一家就算已登录。 */
  #withUpstreams(state: AccountState): AccountState {
    const names = ECHO_UPSTREAMS.filter((entry) => this.#connected.has(entry.id)).map(
      (entry) => entry.name,
    );
    return {
      ...state,
      status: 'signed_in',
      plan: [...this.#connected].join(','),
      planLabel: names.join(', '),
    };
  }

  #get(kind: AccountKind): AccountState {
    const state = this.#states.get(kind as SubscriptionKind);
    if (state === undefined) throw new Error(`no ${kind} account in the echo engine`);
    return state;
  }

  #set(state: AccountState): AccountState {
    this.#states.set(state.kind as SubscriptionKind, state);
    for (const listener of [...this.#listeners]) {
      try {
        listener(state);
      } catch {
        // 监听器里的错误不影响别的监听器。
      }
    }
    return state;
  }

  #later(run: () => void, delayMs = this.#delayMs): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      run();
    }, delayMs);
    this.#timers.add(timer);
  }
}

function initialState(kind: SubscriptionKind, scenario: EchoAccountScenario): AccountState {
  const profile = PROFILES[kind];
  const base: AccountState = { kind, status: 'signed_out', ...profile };
  switch (scenario) {
    case 'signed_in':
      return {
        ...base,
        status: 'signed_in',
        email: 'me@example.com',
        ...PLANS[kind],
        ...echoRateLimits(kind),
        installed: true,
        version: '0.0.0-echo',
        executablePath: `/echo/bin/${kind}`,
      };
    case 'signed_out':
      return {
        ...base,
        installed: true,
        version: '0.0.0-echo',
        executablePath: `/echo/bin/${kind}`,
      };
    case 'missing':
      return { ...base, installed: false };
    case 'installable':
      return { ...base, installed: false, canInstall: true };
  }
}

function withoutLogin(state: AccountState): AccountState {
  const { login: _login, lastError: _error, ...rest } = state;
  return rest;
}
