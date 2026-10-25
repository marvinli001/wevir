// `wevir account`：订阅账号对着进程内的 Host，引擎是带假订阅账号（EchoAccounts，开发用，不碰真实凭据、不联网）的 EchoAdapter。
// 默认情形：claude、grok 已登录（终端登录），cursor 未登录（应用内），workbuddy 未登录（终端登录），opencode、antigravity、devin 未安装，copilot 未登录（应用内）
// 但 Wevir 能下载。

import { join } from 'node:path';
import { createLogger, type RunningHost, startHost } from '@wevir/host';
import { EchoAccounts, EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeRun, run, runFake, useTempDir } from './test-utils.js';

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

class SubscriptionAdapter extends EchoAdapter {
  readonly accounts = new EchoAccounts({ delayMs: 30 });
}

async function setup() {
  const home = join(tempDir(), 'home');
  const adapter = new SubscriptionAdapter({ stepDelayMs: 1 });
  hosts.push(
    await startHost({
      home,
      adapter,
      engine: 'echo',
      logger: createLogger({ level: 'error', mirror: () => {} }),
    }),
  );
  return { home };
}

describe('wevir account', () => {
  it('list 与 status：状态、套餐、用量与登录方式', async () => {
    const { home } = await setup();
    const list = await run(['account', 'list'], { home });
    expect(list.code, list.err).toBe(0);
    expect(list.out).toMatch(/ID\s+来源\s+状态\s+账号\s+版本/);
    expect(list.out).toMatch(/claude\s+Claude\s+已登录\s+me@example\.com · Max 20x/);
    expect(list.out).toMatch(/cursor\s+Cursor\s+未登录/);
    expect(list.out).toMatch(/antigravity\s+Antigravity\s+未安装/);
    const json = JSON.parse((await run(['account', 'list', '--json'], { home })).out) as Array<{
      kind: string;
    }>;
    expect(json.map((account) => account.kind)).toContain('workbuddy');

    const claude = await run(['account', 'status', 'claude'], { home });
    expect(claude.out).toContain('Claude：已登录 me@example.com（Max 20x）');
    const workbuddy = await run(['account', 'status', 'workbuddy', '--refresh'], { home });
    expect(workbuddy.out).toContain('WorkBuddy：未登录');
    expect(workbuddy.out).toContain('在终端里登录：codebuddy');
    const antigravity = await run(['account', 'status', 'antigravity'], { home });
    expect(antigravity.out).toContain('安装：wevir account install antigravity');

    const unknown = await run(['account', 'status', 'nope'], { home });
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('未知来源或账号：nope');
  });

  it('login：应用内登录打印网址并等到完成；终端登录打印命令；已登录时不重登', async () => {
    const { home } = await setup();
    const login = runFake(['account', 'login', 'cursor'], { home });
    fakes.push(login);
    expect(await login.exit).toBe(0);
    expect(login.out()).toContain('在浏览器中打开：https://example.com/echo-login/cursor');
    expect(login.out()).toContain('✓ 已登录 Cursor：me@example.com（Pro）');
    expect((await run(['account', 'status', 'cursor'], { home })).out).toContain(
      'Cursor：已登录 me@example.com',
    );

    const device = await run(['account', 'login', 'cursor', '--device-code'], { home });
    expect(device.code).toBe(0);
    expect(device.out).toContain('已登录 Cursor');

    const terminal = await run(['account', 'login', 'workbuddy'], { home });
    expect(terminal.code, terminal.err).toBe(0);
    expect(terminal.out).toContain('WorkBuddy 在终端里登录，运行：');
    expect(terminal.out).toContain('  codebuddy');
    expect(terminal.out).toContain('登录后运行 wevir account status workbuddy --refresh');

    const conflict = await run(['account', 'login', 'cursor', '--browser', '--device-code'], {
      home,
    });
    expect(conflict.code).toBe(2);
  });

  it('Ctrl-C 取消应用内登录', async () => {
    const home = join(tempDir(), 'home');
    const adapter = new (class extends EchoAdapter {
      readonly accounts = new EchoAccounts({ delayMs: 60_000 });
    })({ stepDelayMs: 1 });
    hosts.push(
      await startHost({
        home,
        adapter,
        engine: 'echo',
        logger: createLogger({ level: 'error', mirror: () => {} }),
      }),
    );
    const login = runFake(['account', 'login', 'cursor'], { home });
    fakes.push(login);
    await login.waitFor('等待登录');
    login.interrupt();
    expect(await login.exit).toBe(130);
    expect(login.out()).toContain('登录已取消');
    expect((await run(['account', 'status', 'cursor'], { home })).out).toContain('Cursor：未登录');
  });

  it('install 显示进度并完成；未安装时 login 给出安装方法', async () => {
    const { home } = await setup();
    const before = await run(['account', 'login', 'opencode'], { home });
    expect(before.code).toBe(1);
    expect(before.err).toContain('OpenCode 未安装');
    expect(before.err).toContain('wevir account install opencode');
    const installed = await run(['account', 'install', 'opencode'], { home });
    expect(installed.code, installed.err).toBe(0);
    expect(installed.out).toMatch(/✓ 已安装 OpenCode \S+/);
    expect((await run(['account', 'list'], { home })).out).not.toMatch(
      /opencode\s+OpenCode\s+未安装/,
    );
  });

  it('OpenCode 的上游：列出、以 API Key 接入（从 stdin 读）、断开', async () => {
    const { home } = await setup();
    await run(['account', 'install', 'opencode'], { home });
    const upstreams = await run(['account', 'upstreams', 'opencode'], { home });
    expect(upstreams.code, upstreams.err).toBe(0);
    expect(upstreams.out).toMatch(/opencode\s+OpenCode Zen\s+已接入/);
    expect(upstreams.out).toMatch(/anthropic\s+Anthropic\s+-\s+default（API key）/);
    const connected = await run(['account', 'login', 'opencode', '--upstream', 'anthropic'], {
      home,
      input: 'sk-ant-test\n',
    });
    expect(connected.code, connected.err).toBe(0);
    expect(connected.out).toContain('✓ 已接入 Anthropic');
    expect(connected.out).not.toContain('sk-ant-test');
    expect((await run(['account', 'upstreams', 'opencode'], { home })).out).toMatch(
      /anthropic\s+Anthropic\s+已接入/,
    );
    const bad = await run(['account', 'login', 'opencode', '--upstream', 'nowhere'], { home });
    expect(bad.err).toContain('未知上游：nowhere');
    const disconnected = await run(['account', 'logout', 'opencode', '--upstream', 'anthropic'], {
      home,
    });
    expect(disconnected.code, disconnected.err).toBe(0);
    expect(disconnected.out).toContain('已断开上游 anthropic');
  });

  it('logout、label、remove 与 path 的用法', async () => {
    const { home } = await setup();
    const logout = await run(['account', 'logout', 'claude'], { home });
    expect(logout.code, logout.err).toBe(0);
    expect(logout.out).toContain('已登出 Claude');
    expect((await run(['account', 'status', 'claude'], { home })).out).toContain('Claude：未登录');

    const remove = await run(['account', 'remove', 'claude'], { home });
    expect(remove.code).toBe(2);
    expect(remove.err).toContain('首个账号不能删除');
    // 这个 Host 的引擎不能添加账号（没有每个账号一个引擎的路由）：说明是 Host 不支持。
    const add = await run(['account', 'add', 'claude', '--label', 'Work'], { home });
    expect(add.code).toBe(1);
    expect(add.err).toContain('不支持此功能（subscription_accounts）');
    const label = await run(['account', 'label', 'claude'], { home });
    expect(label.code).toBe(2);
    expect(label.err).toContain('给出标签或 --clear 之一');
    const path = await run(['account', 'path', 'claude', '/opt/claude/bin/claude'], { home });
    expect(path.code, path.err).toBe(0);
    expect(path.out).toContain('Claude：');
    const cleared = await run(['account', 'path', 'claude', '--clear'], { home });
    expect(cleared.code, cleared.err).toBe(0);
  });
});
