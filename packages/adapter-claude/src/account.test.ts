import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
