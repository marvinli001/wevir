// R6：wevir provider login / status / logout 对着进程内的 Host。引擎是带假 ChatGPT 账号的 EchoAdapter（真实
// codex-app-server 的账号流程在 packages/adapter-codex 的 codex-runtime.chatgpt.integration.test.ts）。

import { join } from 'node:path';
import { createLogger, type RunningHost, startHost } from '@wevir/host';
import type {
  AccountKind,
  AccountLoginMethod,
  AccountModels,
  AccountState,
  EngineAccounts,
} from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { describeWindow } from './commands/account.js';
import { setLocale } from './i18n/index.js';
import { type FakeRun, run, runFake, startEchoHost, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const hosts: RunningHost[] = [];
const fakes: FakeRun[] = [];

afterEach(async () => {
  for (const fake of fakes.splice(0)) {
    fake.interrupt();
    await fake.exit.catch(() => {});
  }
  for (const host of hosts.splice(0)) await host.shutdown();
});

class FakeAccounts implements EngineAccounts {
  readonly kinds: readonly AccountKind[] = ['chatgpt'];
  state: AccountState = { kind: 'chatgpt', status: 'signed_out' };
  readonly calls: string[] = [];
  readonly #listeners = new Set<(state: AccountState) => void>();

  async read(): Promise<AccountState> {
    return this.state;
  }
  async login(_kind: AccountKind, method: AccountLoginMethod): Promise<AccountState> {
    this.calls.push(`login:${method}`);
    this.set({
      kind: 'chatgpt',
      status: 'signing_in',
      login: {
        loginId: 'login-1',
        method,
        verificationUrl: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-EFGH',
        startedAt: new Date().toISOString(),
      },
    });
    return this.state;
  }
  async cancelLogin(_kind: AccountKind, loginId?: string): Promise<AccountState> {
    this.calls.push(`cancel:${loginId}`);
    this.set({ kind: 'chatgpt', status: 'signed_out' });
    return this.state;
  }
  async logout(): Promise<AccountState> {
    this.calls.push('logout');
    this.set({ kind: 'chatgpt', status: 'signed_out' });
    return this.state;
  }
  async models(): Promise<AccountModels> {
    return {
      models: [{ id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol' }],
      defaultModelId: 'gpt-6.1-sol',
    };
  }
  onChange(listener: (state: AccountState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  set(state: AccountState): void {
    this.state = state;
    for (const listener of this.#listeners) listener(state);
  }
}

class AccountAdapter extends EchoAdapter {
  readonly accounts = new FakeAccounts();
}

async function setup() {
  const home = join(tempDir(), 'home');
  const adapter = new AccountAdapter({ stepDelayMs: 1 });
  hosts.push(
    await startHost({
      home,
      adapter,
      engine: 'echo',
      logger: createLogger({ level: 'error', mirror: () => {} }),
    }),
  );
  return { home, accounts: adapter.accounts };
}

function start(argv: string[], home: string): FakeRun {
  const fake = runFake(argv, { home });
  fakes.push(fake);
  return fake;
}

describe('wevir provider login / status / logout（ChatGPT 账号）', () => {
  it('登录：打印网址与一次性码，等到登录成功；之后 status 显示账号、套餐与用量，list 里有 chatgpt', async () => {
    const { home, accounts } = await setup();
    expect((await run(['provider', 'status'], { home })).out).toContain('ChatGPT：没有登录');

    const login = start(['provider', 'login'], home);
    await login.waitFor('ABCD-EFGH');
    expect(login.out()).toContain('仅供个人在本机使用 Wevir 时登录');
    expect(login.out()).toContain('https://auth.openai.com/codex/device');
    expect(accounts.calls).toEqual(['login:device_code']);
    accounts.set({
      kind: 'chatgpt',
      status: 'signed_in',
      email: 'me@example.com',
      plan: 'plus',
      rateLimits: { primary: { usedPercent: 23.4, windowMinutes: 300 } },
    });
    expect(await login.exit).toBe(0);
    expect(login.out()).toContain('✓ 已登录 ChatGPT：me@example.com（Plus）');

    const status = await run(['provider', 'status', 'chatgpt'], { home });
    expect(status.out).toContain('ChatGPT：已登录 me@example.com（Plus）');
    expect(status.out).toContain('5 小时窗口已用 23%');
    // 已登录时再 login 不重新登录。
    const again = await run(['provider', 'login'], { home });
    expect(again.code).toBe(0);
    expect(again.out).toContain('已经登录 ChatGPT');
    // Host 在登录成功后建了 chatgpt Provider（后台进行，等一下）。
    let list = '';
    for (let i = 0; i < 50 && !list.includes('ChatGPT 登录'); i += 1) {
      list = (await run(['provider', 'list'], { home })).out;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(list).toMatch(/chatgpt\s+ChatGPT\s+chatgpt\s+gpt-6\.1-sol\s+ChatGPT 登录/);

    const logout = await run(['provider', 'logout'], { home });
    expect(logout.code).toBe(0);
    expect(logout.out).toContain('已登出 ChatGPT');
    expect(accounts.calls.at(-1)).toBe('logout');
  });

  it('Ctrl-C 取消登录；登录失败时报出原因', async () => {
    const { home, accounts } = await setup();
    const login = start(['provider', 'login'], home);
    await login.waitFor('ABCD-EFGH');
    login.interrupt();
    expect(await login.exit).toBe(130);
    expect(login.out()).toContain('已取消登录');
    expect(accounts.calls).toContain('cancel:login-1');

    const failing = start(['provider', 'login'], home);
    await failing.waitFor('ABCD-EFGH');
    accounts.set({ kind: 'chatgpt', status: 'signed_out', lastError: 'device auth timed out' });
    expect(await failing.exit).toBe(1);
    expect(failing.err()).toContain('登录没有成功：device auth timed out');
  });

  it('引擎没有账号（echo、dsh）：说明只有 Codex 引擎有', async () => {
    const home = join(tempDir(), 'home');
    hosts.push(await startEchoHost(home));
    const result = await run(['provider', 'status'], { home });
    expect(result.code).not.toBe(0);
    expect(result.err).toContain('这个 Host 没有 ChatGPT 账号');
  });

  it('用量窗口的说法', () => {
    setLocale('zh');
    const now = new Date('2026-10-14T08:00:00');
    expect(describeWindow({ usedPercent: 40, windowMinutes: 10080 }, now)).toBe('每周已用 40%');
    expect(
      describeWindow({ usedPercent: 5, windowMinutes: 300, resetsAt: '2026-10-14T10:30:00' }, now),
    ).toBe('5 小时窗口已用 5%，10:30 重置');
    expect(
      describeWindow({ usedPercent: 5, windowMinutes: 300, resetsAt: '2026-10-16T10:30:00' }, now),
    ).toBe('5 小时窗口已用 5%，10 月 16 日 10:30 重置');
    setLocale('en');
    try {
      expect(describeWindow({ usedPercent: 40, windowMinutes: 10080 }, now)).toBe(
        'Weekly: 40% used',
      );
      expect(
        describeWindow(
          { usedPercent: 5, windowMinutes: 300, resetsAt: '2026-10-16T10:30:00' },
          now,
        ),
      ).toBe('5-hour window: 5% used, resets 10/16 10:30 AM');
    } finally {
      setLocale('zh');
    }
  });
});
