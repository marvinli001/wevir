import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountState } from '@wevir/runtime-adapter';
import {
  type ManagedExecutable,
  NpmInstallCancelled,
  NpmInstallError,
  type NpmInstallProgress,
  type NpmPackageInstaller,
} from '@wevir/runtime-adapter/npm-package';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  applyRateLimitEvent,
  ClaudeAccounts,
  claudePlan,
  claudeSignedIn,
  claudeSubscriptionLabel,
  usageRateLimits,
} from './account.js';
import {
  CLAUDE_INSTALL_COMMAND,
  GIT_BASH_ENV,
  GIT_BASH_MISSING_MESSAGE,
  GIT_FOR_WINDOWS_URL,
} from './executable.js';
import type { ClaudeLoginFlow, ClaudeLoginResult } from './login.js';
import { FakeClaudeSdk, recordedMessages } from './test-fixtures/fake-sdk.js';

// 探测会话的工作目录（检测时会建它）。
const WORK_DIR = join(mkdtempSync(join(tmpdir(), 'wevir-claude-account-')), 'engines', 'claude');
afterAll(() => rmSync(join(WORK_DIR, '..', '..'), { recursive: true, force: true }));

describe('套餐与登录状态（T3 的 claudeSubscriptionLabel / claudeAuthStatus）', () => {
  it('subscriptionType → 显示名', () => {
    expect(claudeSubscriptionLabel('max20')).toBe('Max 20x');
    expect(claudeSubscriptionLabel('claude_max_5x_subscription')).toBe('Max 5x');
    expect(claudeSubscriptionLabel('pro')).toBe('Pro');
    expect(claudeSubscriptionLabel('team_premium')).toBe('Team Premium');
    expect(claudeSubscriptionLabel(undefined)).toBeUndefined();
  });

  it('只有 tokenSource: none 且没有 Key、邮箱、套餐才算没登录；第三方后端算已登录', () => {
    expect(claudeSignedIn({ tokenSource: 'none', apiKeySource: 'none' })).toBe(false);
    expect(claudeSignedIn({ tokenSource: 'none', email: 'me@example.com' })).toBe(true);
    expect(claudeSignedIn({ tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY' })).toBe(true);
    expect(claudeSignedIn({ apiProvider: 'bedrock', tokenSource: 'none' })).toBe(true);
    expect(claudeSignedIn({})).toBe(true);
    expect(claudeSignedIn(undefined)).toBe(true);
  });

  it('套餐：API Key、订阅、Bedrock', () => {
    expect(claudePlan({ tokenSource: 'apiKey' })).toEqual({ plan: 'apiKey', planLabel: 'API Key' });
    expect(claudePlan({ subscriptionType: 'max20' })).toEqual({
      plan: 'max20',
      planLabel: 'Max 20x',
    });
    expect(claudePlan({ apiProvider: 'bedrock' })).toEqual({
      plan: 'bedrock',
      planLabel: 'Amazon Bedrock',
    });
    expect(claudePlan({})).toBeUndefined();
  });
});

describe('用量', () => {
  it('get_usage：5 小时是 primary，7 天是 secondary；没有套餐用量时 undefined', () => {
    expect(
      usageRateLimits({
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 3, resets_at: '2026-10-15T18:00:00Z' },
          seven_day: { utilization: 56, resets_at: null },
        },
      } as never),
    ).toEqual({
      primary: { usedPercent: 3, windowMinutes: 300, resetsAt: '2026-10-15T18:00:00.000Z' },
      secondary: { usedPercent: 56, windowMinutes: 10080 },
    });
    expect(
      usageRateLimits({ rate_limits_available: false, rate_limits: null } as never),
    ).toBeUndefined();
  });

  it('rate_limit_event（录音里的真实消息）：unifiedWindows 两个窗口一起更新，用量是 0–1 的小数', () => {
    const event = recordedMessages('plain').find((message) => message.type === 'rate_limit_event');
    if (event?.type !== 'rate_limit_event') throw new Error('录音里没有 rate_limit_event');
    const next = applyRateLimitEvent(undefined, event.rate_limit_info);
    expect(next?.primary).toMatchObject({ windowMinutes: 300, usedPercent: expect.any(Number) });
    expect(next?.secondary).toMatchObject({ windowMinutes: 10080, resetsAt: expect.any(String) });
    expect(
      applyRateLimitEvent(undefined, {
        status: 'allowed',
        rateLimitType: 'five_hour',
        utilization: 0.25,
      }),
    ).toEqual({ primary: { usedPercent: 25, windowMinutes: 300 } });
    expect(
      applyRateLimitEvent(undefined, { status: 'allowed', rateLimitType: 'overage' }),
    ).toBeUndefined();
  });
});

describe('ClaudeAccounts', () => {
  function accounts(options: Partial<ConstructorParameters<typeof ClaudeAccounts>[0]> = {}) {
    let now = 0;
    const sdk = new FakeClaudeSdk();
    const created = new ClaudeAccounts({
      sdk,
      workDir: WORK_DIR,
      findExecutable: () => '/opt/claude',
      probeVersion: async () => ({ ok: true, version: '2.1.287' }),
      inAppLogin: false,
      now: () => now,
      ...options,
    });
    return { sdk, created, advance: (ms: number) => (now += ms) };
  }

  it('已登录：版本、路径、套餐、邮箱与用量；结果缓存 5 分钟，refresh 重新检测', async () => {
    const { created, sdk, advance } = accounts();
    const state = await created.read('claude');
    expect(state).toMatchObject({
      kind: 'claude',
      status: 'signed_in',
      signIn: 'command',
      loginCommand: 'claude auth login',
      installed: true,
      version: '2.1.287',
      executablePath: '/opt/claude',
      email: 'me@example.com',
      plan: 'max20',
      planLabel: 'Max 20x',
      rateLimits: { primary: { usedPercent: 3 }, secondary: { usedPercent: 56 } },
    });
    // 探测会话：不写记录、不跑 hooks、不连 MCP，prompt 永远不产出。
    expect(sdk.queries[0]?.options).toMatchObject({
      persistSession: false,
      settings: { disableAllHooks: true },
      mcpServers: {},
      strictMcpConfig: true,
      allowedTools: [],
      pathToClaudeCodeExecutable: '/opt/claude',
    });
    await created.read('claude');
    expect(sdk.queries).toHaveLength(1);
    advance(5 * 60_000);
    await created.read('claude');
    expect(sdk.queries).toHaveLength(2);
    await created.read('claude', { refresh: true });
    expect(sdk.queries).toHaveLength(3);
    const models = await created.models('claude');
    expect(models.defaultModelId).toBe('claude-fable-5-1');
    // 2.1.287 用不了要 2.1.293 的 Haiku 5.5。
    expect(models.models.map((model) => model.id)).not.toContain('claude-haiku-5-5');
  });

  it('没装：installed false 带安装命令；指定的路径不存在时报出来', async () => {
    const { created } = accounts({ findExecutable: () => undefined });
    expect(await created.read('claude')).toMatchObject({
      status: 'signed_out',
      installed: false,
      installCommand: CLAUDE_INSTALL_COMMAND,
    });
    const custom = await created.setExecutablePath('claude', '/nowhere/claude');
    expect(custom).toMatchObject({
      customPath: '/nowhere/claude',
      lastError: '/nowhere/claude does not exist',
    });
  });

  it('跑不起来：installed 但未登录，带原因', async () => {
    const { created } = accounts({
      probeVersion: async () => ({
        ok: false,
        reason: 'failed',
        message: '`claude --version` failed: boom',
      }),
    });
    expect(await created.read('claude')).toMatchObject({
      status: 'signed_out',
      installed: true,
      lastError: '`claude --version` failed: boom',
    });
  });

  describe('Windows 上的 Git Bash', () => {
    const GIT_ERROR =
      '`claude --version` failed: Claude Code on Windows requires git-bash (https://git-scm.com/downloads/win). If installed but not in PATH, set environment variable pointing to your bash.exe, similar to: CLAUDE_CODE_GIT_BASH_PATH=C:\\Program Files\\Git\\bin\\bash.exe';
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const windows = (installed: string[]) => ({
      env: { Path: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
      findExecutable: () => 'C:\\Users\\me\\.local\\bin\\claude.exe',
      system: {
        platform: 'win32' as const,
        home: 'C:\\Users\\me',
        exists: (file: string) => installed.includes(file),
        isDir: () => false,
      },
    });

    it('找到：版本探测与 SDK 探测会话的环境都带 CLAUDE_CODE_GIT_BASH_PATH', async () => {
      const seen: Array<string | undefined> = [];
      const { created, sdk } = accounts({
        ...windows([bash]),
        probeVersion: async (_executable, env) => {
          seen.push(env[GIT_BASH_ENV]);
          return { ok: true, version: '2.1.287' };
        },
      });
      expect(await created.read('claude')).toMatchObject({ status: 'signed_in', installed: true });
      expect(seen).toEqual([bash]);
      expect(sdk.queries[0]?.options.env?.[GIT_BASH_ENV]).toBe(bash);
      expect((await created.installation()).executablePath).toBe(
        'C:\\Users\\me\\.local\\bin\\claude.exe',
      );
    });

    it('找不到、claude 因此报错：说成要装 Git for Windows，不给原始报错；会话起不来', async () => {
      const { created } = accounts({
        ...windows([]),
        probeVersion: async () => ({ ok: false, reason: 'failed', message: GIT_ERROR }),
      });
      const state = await created.read('claude');
      expect(state).toMatchObject({
        status: 'signed_out',
        installed: false,
        executablePath: 'C:\\Users\\me\\.local\\bin\\claude.exe',
        installUrl: GIT_FOR_WINDOWS_URL,
        lastError: GIT_BASH_MISSING_MESSAGE,
      });
      expect(state.installCommand).toBeUndefined();
      expect(state.lastError).not.toContain('CLAUDE_CODE_GIT_BASH_PATH');
      await expect(created.installation()).rejects.toMatchObject({
        code: 'engine_unavailable',
        message: GIT_BASH_MISSING_MESSAGE,
      });
    });

    it('SDK 探测会话因缺 Git Bash 失败：同样报要装 Git', async () => {
      const { created } = accounts({
        ...windows([]),
        sdk: new FakeClaudeSdk({ initError: new Error(GIT_ERROR) }),
      });
      expect(await created.read('claude')).toMatchObject({
        installed: false,
        installUrl: GIT_FOR_WINDOWS_URL,
        lastError: GIT_BASH_MISSING_MESSAGE,
      });
    });

    it('找不到但 claude 照样跑得起来：不拦（以后 Claude Code 不再要 Git 时不误报）', async () => {
      const { created } = accounts({ ...windows([]) });
      expect(await created.read('claude')).toMatchObject({
        status: 'signed_in',
        installed: true,
      });
    });

    it('找到了 claude 还是报缺 Git Bash（变量指到坏文件）：原文照给，不改说法', async () => {
      const { created } = accounts({
        ...windows([bash]),
        probeVersion: async () => ({ ok: false, reason: 'failed', message: GIT_ERROR }),
      });
      expect(await created.read('claude')).toMatchObject({
        installed: true,
        lastError: GIT_ERROR,
      });
    });

    it('装好 Git 后重新检测：恢复正常', async () => {
      const installed: string[] = [];
      const { created } = accounts({
        env: { Path: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
        findExecutable: () => 'C:\\Users\\me\\.local\\bin\\claude.exe',
        system: {
          platform: 'win32',
          home: 'C:\\Users\\me',
          exists: (file) => installed.includes(file),
          isDir: () => false,
        },
        probeVersion: async (_executable, env) =>
          env[GIT_BASH_ENV] === undefined
            ? { ok: false, reason: 'failed', message: GIT_ERROR }
            : { ok: true, version: '2.1.287' },
      });
      expect(await created.read('claude')).toMatchObject({ installed: false });
      installed.push(bash);
      expect(await created.read('claude', { refresh: true })).toMatchObject({
        status: 'signed_in',
        installed: true,
      });
    });

    it('非 Windows：同样的报错不当作缺 Git', async () => {
      const { created } = accounts({
        probeVersion: async () => ({ ok: false, reason: 'failed', message: GIT_ERROR }),
      });
      expect(await created.read('claude')).toMatchObject({ installed: true, lastError: GIT_ERROR });
    });
  });

  it('没登录：signed_out，登录与登出交给终端', async () => {
    const sdk = new FakeClaudeSdk({ account: { tokenSource: 'none', apiKeySource: 'none' } });
    const created = new ClaudeAccounts({
      sdk,
      workDir: WORK_DIR,
      findExecutable: () => '/opt/claude',
      probeVersion: async () => ({ ok: true, version: '2.1.287' }),
      inAppLogin: false,
    });
    expect(await created.read('claude')).toMatchObject({ status: 'signed_out', installed: true });
    await expect(created.login('claude')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(created.logout('claude')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(created.read('chatgpt')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('onChange：检测与回合里的用量都通知', async () => {
    const { created } = accounts();
    const seen: string[] = [];
    created.onChange((state) =>
      seen.push(`${state.status}:${state.rateLimits?.primary?.usedPercent}`),
    );
    await created.read('claude');
    created.applyRateLimit({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.5 });
    expect(seen).toEqual(['signed_in:3', 'signed_in:50']);
  });
});

// Wevir 替用户装的 claude 与设置里的应用内登录（假的安装器与登录流程，不碰网络和浏览器）。
describe('ClaudeAccounts：下载安装与应用内登录', () => {
  const MANAGED: ManagedExecutable = {
    path: '/data/engines/claude/runtime/versions/2.1.302/claude',
    version: '2.1.302',
  };

  /** 受控的安装器：测试决定什么时候给进度、什么时候结束。 */
  function controlledInstaller(initial?: ManagedExecutable) {
    let active = initial;
    let onProgress: (progress: NpmInstallProgress) => void = () => {};
    let settle: (result: 'ok' | Error) => void = () => {};
    const state = { installing: false, started: 0, cancelled: 0 };
    const installer = {
      get installing() {
        return state.installing;
      },
      active: async () => active,
      install(callback: (progress: NpmInstallProgress) => void) {
        state.installing = true;
        state.started += 1;
        onProgress = callback;
        return new Promise<ManagedExecutable>((resolve, reject) => {
          settle = (result) => {
            state.installing = false;
            if (result instanceof Error) {
              reject(result);
              return;
            }
            active = MANAGED;
            resolve(MANAGED);
          };
        });
      },
      cancel() {
        state.cancelled += 1;
      },
    };
    return {
      installer: installer as unknown as NpmPackageInstaller,
      state,
      progress: (progress: NpmInstallProgress) => onProgress(progress),
      finish: (result: 'ok' | Error) => settle(result),
    };
  }

  function make(options: Partial<ConstructorParameters<typeof ClaudeAccounts>[0]> = {}) {
    const account: Record<string, unknown> = { tokenSource: 'none', apiKeySource: 'none' };
    const sdk = new FakeClaudeSdk({ account });
    const created = new ClaudeAccounts({
      sdk,
      workDir: WORK_DIR,
      probeVersion: async () => ({ ok: true, version: '2.1.302' }),
      findExecutable: (_custom, managed) => managed,
      inAppLogin: true,
      ...options,
    });
    const seen: AccountState[] = [];
    created.onChange((state) => seen.push(state));
    const signIn = () => {
      account.tokenSource = 'claude.ai';
      account.email = 'me@example.com';
      account.subscriptionType = 'max20';
    };
    const signOut = () => {
      account.tokenSource = 'none';
      delete account.email;
      delete account.subscriptionType;
    };
    return { created, seen, sdk, signIn, signOut };
  }

  /** 假的 `claude auth login`：测试决定什么时候退出。 */
  /** `null`：没有授权地址（Windows 上 claude 自己开浏览器）。 */
  function loginFlow(authUrl: string | null = 'http://localhost:51274/callback-auth') {
    let finish: (result: ClaudeLoginResult) => void = () => {};
    const done = new Promise<ClaudeLoginResult>((resolve) => {
      finish = resolve;
    });
    const flow: ClaudeLoginFlow = {
      ...(authUrl !== null && { authUrl }),
      done,
      cancel: vi.fn(() => finish({ ok: false, cancelled: true, message: 'cancelled' })),
    };
    return { flow, finish };
  }

  it('没装：带下载（canInstall）和自己安装的命令；没有本平台的包时不给下载', async () => {
    const { installer } = controlledInstaller();
    const { created } = make({ installer });
    expect(await created.read('claude')).toMatchObject({
      installed: false,
      canInstall: true,
      installCommand: CLAUDE_INSTALL_COMMAND,
      signIn: 'in_app',
      loginMethods: ['browser'],
    });
    const { created: unsupported } = make({ installer: null });
    expect((await unsupported.read('claude')).canInstall).toBeUndefined();
    await expect(unsupported.install('claude')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('下载安装：先报 installing 和进度，装好后重新检测，找到装好的那份', async () => {
    const control = controlledInstaller();
    const { created, seen } = make({ installer: control.installer });
    const started = await created.install('claude');
    expect(started).toMatchObject({ installed: false, installing: { completedBytes: 0 } });
    // 安装中再点一次：不再开始新的。
    expect(await created.install('claude')).toMatchObject({ installing: expect.anything() });
    expect(control.state.started).toBe(1);
    control.progress({ phase: 'downloading', completedBytes: 50, totalBytes: 100 });
    expect(seen.at(-1)?.installing).toEqual({ completedBytes: 50, totalBytes: 100 });
    control.finish('ok');
    await vi.waitFor(() =>
      expect(seen.at(-1)).toMatchObject({
        installed: true,
        executablePath: MANAGED.path,
        version: '2.1.302',
        status: 'signed_out',
      }),
    );
    expect(seen.at(-1)?.installing).toBeUndefined();
    expect(seen.at(-1)?.canInstall).toBeUndefined();
    expect((await created.read('claude')).executablePath).toBe(MANAGED.path);
  });

  it('下载失败：原因进 lastError，仍可再下；重新检测后清掉；取消不算失败', async () => {
    const control = controlledInstaller();
    const { created, seen } = make({ installer: control.installer });
    await created.install('claude');
    control.finish(new NpmInstallError('download', 'Could not download claude: boom'));
    await vi.waitFor(() =>
      expect(seen.at(-1)).toMatchObject({
        installed: false,
        canInstall: true,
        lastError: 'Could not download claude: boom',
      }),
    );
    expect(seen.at(-1)?.installing).toBeUndefined();
    expect(await created.read('claude')).toMatchObject({
      lastError: 'Could not download claude: boom',
    });
    expect((await created.read('claude', { refresh: true })).lastError).toBeUndefined();

    await created.install('claude');
    control.finish(new NpmInstallCancelled('Installation cancelled.'));
    await vi.waitFor(() => expect(seen.at(-1)?.installing).toBeUndefined());
    expect(seen.at(-1)?.lastError).toBeUndefined();
  });

  it('Wevir 装的那份跑不起来：当作没装，可以重新下载；用户自己的跑不起来照旧是 installed', async () => {
    const control = controlledInstaller(MANAGED);
    const failing = async () => ({
      ok: false as const,
      reason: 'failed' as const,
      message: 'exec format error',
    });
    const { created } = make({ installer: control.installer, probeVersion: failing });
    expect(await created.read('claude')).toMatchObject({
      installed: false,
      canInstall: true,
      executablePath: MANAGED.path,
      lastError: 'exec format error',
    });
    const { created: own } = make({
      installer: control.installer,
      findExecutable: () => '/opt/claude',
      probeVersion: failing,
    });
    expect(await own.read('claude')).toMatchObject({
      installed: true,
      lastError: 'exec format error',
    });
  });

  it('命令登录的平台：Wevir 装的写全路径，用户自己的写 claude', async () => {
    const control = controlledInstaller(MANAGED);
    const { created } = make({ installer: control.installer, inAppLogin: false });
    expect(await created.read('claude')).toMatchObject({
      signIn: 'command',
      loginCommand: `"${MANAGED.path}" auth login`,
    });
    const { created: own } = make({
      installer: control.installer,
      inAppLogin: false,
      findExecutable: () => '/opt/claude',
    });
    expect((await own.read('claude')).loginCommand).toBe('claude auth login');
  });

  it('命令登录的 Windows 写法：PowerShell 的调用运算符，添加的账号先设 CLAUDE_CONFIG_DIR', async () => {
    const managed = {
      path: 'C:\\Users\\me\\AppData\\Roaming\\Wevir\\engines\\claude\\runtime\\versions\\2.1.310\\claude.exe',
      version: '2.1.310',
    };
    const { created } = make({
      installer: controlledInstaller(managed).installer,
      inAppLogin: false,
      system: { platform: 'win32', exists: () => false },
    });
    expect((await created.read('claude')).loginCommand).toBe(`& '${managed.path}' auth login`);
    const { created: added } = make({
      installer: controlledInstaller(managed).installer,
      inAppLogin: false,
      configDir: 'C:\\W\\accounts\\a1\\claude',
      system: { platform: 'win32', exists: () => false },
    });
    expect((await added.read('claude')).loginCommand).toBe(
      `$env:CLAUDE_CONFIG_DIR='C:\\W\\accounts\\a1\\claude'; & '${managed.path}' auth login`,
    );
  });

  it('Windows 的添加的账号：应用内登录，带 CLAUDE_CONFIG_DIR；claude 自己开浏览器时 signing_in 不带地址', async () => {
    const { flow, finish } = loginFlow(null);
    const startLogin = vi.fn(async () => flow);
    const { installer } = controlledInstaller(MANAGED);
    const { created, seen, signIn } = make({
      installer,
      startLogin,
      inAppLogin: undefined,
      configDir: 'C:\\W\\accounts\\a1\\claude',
      env: { CLAUDE_CONFIG_DIR: 'C:\\W\\accounts\\a1\\claude' },
      system: { platform: 'win32', exists: () => false },
    });
    expect(await created.read('claude')).toMatchObject({
      signIn: 'in_app',
      loginMethods: ['browser'],
    });
    const state = await created.login('claude');
    expect(state).toMatchObject({ status: 'signing_in', login: { method: 'browser' } });
    expect(state.login?.authUrl).toBeUndefined();
    expect(startLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({ CLAUDE_CONFIG_DIR: 'C:\\W\\accounts\\a1\\claude' }),
      }),
    );
    signIn();
    finish({ ok: true });
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ status: 'signed_in' }));
  });

  it('应用内登录：signing_in 带授权地址，登录完成后重新检测成 signed_in', async () => {
    const { flow, finish } = loginFlow();
    const startLogin = vi.fn(async () => flow);
    const { installer } = controlledInstaller(MANAGED);
    const { created, seen, signIn } = make({ installer, startLogin });
    expect(await created.read('claude')).toMatchObject({ status: 'signed_out', installed: true });

    const state = await created.login('claude');
    expect(state).toMatchObject({
      status: 'signing_in',
      login: { method: 'browser', authUrl: 'http://localhost:51274/callback-auth' },
    });
    expect(startLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath: MANAGED.path,
        directory: expect.stringContaining('login'),
      }),
    );
    expect(await created.read('claude')).toMatchObject({ status: 'signing_in' });

    signIn();
    finish({ ok: true });
    await vi.waitFor(() =>
      expect(seen.at(-1)).toMatchObject({
        status: 'signed_in',
        email: 'me@example.com',
        planLabel: 'Max 20x',
      }),
    );
    expect(seen.at(-1)?.login).toBeUndefined();
  });

  it('登录失败：回到 signed_out，带 claude 的输出', async () => {
    const { flow, finish } = loginFlow();
    const { installer } = controlledInstaller(MANAGED);
    const { created, seen } = make({ installer, startLogin: async () => flow });
    await created.login('claude');
    finish({ ok: false, cancelled: false, message: 'OAuth error: access_denied' });
    await vi.waitFor(() =>
      expect(seen.at(-1)).toMatchObject({
        status: 'signed_out',
        lastError: 'OAuth error: access_denied',
      }),
    );
    expect(seen.at(-1)?.login).toBeUndefined();
  });

  it('取消登录：停掉 claude，回到 signed_out，没有错误；新的登录替换旧的', async () => {
    const first = loginFlow('http://localhost:1/first');
    const second = loginFlow('http://localhost:2/second');
    const third = loginFlow('http://localhost:3/third');
    const flows = [first.flow, second.flow, third.flow];
    const { installer } = controlledInstaller(MANAGED);
    const { created, seen } = make({
      installer,
      startLogin: async () => flows.shift() as ClaudeLoginFlow,
    });
    const started = await created.login('claude');
    const cancelled = await created.cancelLogin('claude', started.login?.loginId);
    expect(first.flow.cancel).toHaveBeenCalled();
    expect(cancelled).toMatchObject({ status: 'signed_out' });
    expect(cancelled.lastError).toBeUndefined();

    await created.login('claude');
    const replaced = await created.login('claude');
    expect(second.flow.cancel).toHaveBeenCalledTimes(1);
    expect(replaced.login?.authUrl).toBe('http://localhost:3/third');
    // 被换掉的流程退出（cancel 让它兑现 cancelled）不影响现在的状态。
    await Promise.resolve();
    expect(seen.at(-1)?.status).toBe('signing_in');
    expect(seen.at(-1)?.login?.authUrl).toBe('http://localhost:3/third');
    // loginId 不是当前的：什么都不做。
    expect((await created.cancelLogin('claude', 'other')).status).toBe('signing_in');
  });

  it('不能登录的情形：没装、启动不了', async () => {
    const { created } = make({ installer: controlledInstaller().installer });
    await expect(created.login('claude')).rejects.toMatchObject({ code: 'engine_unavailable' });
    const { installer } = controlledInstaller(MANAGED);
    const { created: broken } = make({
      installer,
      startLogin: async () => {
        throw new Error('claude did not report a sign-in address within 15 s');
      },
    });
    await expect(broken.login('claude')).rejects.toMatchObject({
      code: 'engine_unavailable',
      message: expect.stringContaining('did not report a sign-in address'),
    });
    expect((await broken.read('claude')).status).toBe('signed_out');
  });

  it('应用内登出：跑 claude auth logout，再检测', async () => {
    const { installer } = controlledInstaller(MANAGED);
    let signOutNow: () => void = () => {};
    const runCommand = vi.fn(async () => {
      signOutNow();
      return { ok: true as const, stdout: '', stderr: '' };
    });
    const { created, signIn, signOut } = make({ installer, runCommand });
    signOutNow = signOut;
    signIn();
    expect(await created.read('claude')).toMatchObject({ status: 'signed_in' });
    expect(await created.logout('claude')).toMatchObject({ status: 'signed_out' });
    expect(runCommand).toHaveBeenCalledWith(
      MANAGED.path,
      ['auth', 'logout'],
      expect.any(Object),
      expect.any(Number),
      expect.anything(),
    );

    const { created: failing } = make({
      installer,
      runCommand: async () => ({ ok: false as const, message: 'not logged in' }),
    });
    await expect(failing.logout('claude')).rejects.toMatchObject({
      code: 'engine_unavailable',
      message: 'not logged in',
    });
  });

  it('dispose：取消安装与登录', async () => {
    const control = controlledInstaller();
    const { flow } = loginFlow();
    const { created } = make({
      installer: control.installer,
      startLogin: async () => flow,
      findExecutable: () => '/opt/claude',
    });
    await created.login('claude');
    created.dispose();
    expect(flow.cancel).toHaveBeenCalled();
    expect(control.state.cancelled).toBe(1);
  });
});
