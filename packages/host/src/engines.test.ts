import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CursorSdkInstaller, cursorSdkDirectory } from '@wevir/adapter-cursor';
import { afterAll, describe, expect, it } from 'vitest';
import { subscriptionAccountEngines, subscriptionEngines } from './engines.js';
import { createLogger } from './logger.js';

const home = mkdtempSync(join(tmpdir(), 'wevir-engines-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('subscriptionEngines', () => {
  it('开发环境装了两个 SDK：八种订阅引擎都挂上', () => {
    const lines: string[] = [];
    const routes = subscriptionEngines({
      home,
      logger: createLogger({ mirror: (line) => lines.push(line) }),
      env: {},
    });
    expect(routes.map((route) => route.name)).toEqual([
      'claude',
      'cursor',
      'opencode',
      'grok',
      'antigravity',
      'workbuddy',
      'devin',
      'copilot',
    ]);
    expect(lines.join('\n')).not.toContain('engine sdk not installed');
  });

  it('没有 Claude 的 SDK、Cursor 的 SDK 没有本平台的构建：不挂这两个引擎并各记一条日志', () => {
    const lines: string[] = [];
    const routes = subscriptionEngines(
      { home, logger: createLogger({ mirror: (line) => lines.push(line) }), env: {} },
      { claude: false, cursor: false },
    );
    expect(routes.map((route) => route.name)).toEqual([
      'opencode',
      'grok',
      'antigravity',
      'workbuddy',
      'devin',
      'copilot',
    ]);
    expect(lines.filter((line) => line.includes('engine sdk not installed'))).toHaveLength(2);
  });

  it('安装包里 Cursor 的 SDK 要下载：照样挂上，账号报未安装、能装；添加的账号共用同一个安装器', async () => {
    const lines: string[] = [];
    const context = { home, logger: createLogger({ mirror: (line) => lines.push(line) }), env: {} };
    const installer = new CursorSdkInstaller({
      directory: cursorSdkDirectory(home),
      registries: ['http://127.0.0.1:9'],
    });
    const sdks = { claude: true, cursor: installer };
    const routes = subscriptionEngines(context, sdks);
    expect(routes.map((route) => route.name)).toContain('cursor');
    expect(lines.join('\n')).toContain('engine sdk installs on demand');
    const cursor = routes.find((route) => route.name === 'cursor')?.adapter;
    const expected = {
      kind: 'cursor',
      status: 'signed_out',
      installed: false,
      ...(installer.supported && { canInstall: true }),
    };
    expect(await cursor?.accounts?.read('cursor')).toMatchObject(expected);
    const factory = subscriptionAccountEngines(context, sdks);
    expect(factory.kinds).toContain('cursor');
    const added = factory.create('cursor', {
      id: 'cursor-0001',
      root: join(home, 'accounts', 'cursor-0001'),
    });
    expect(await added.accounts?.read('cursor')).toMatchObject(expected);
    await added.dispose();
    for (const route of routes) await route.adapter.dispose();
  });
});

describe('subscriptionAccountEngines（0.63.0）', () => {
  it('能添加账号的是 Claude、Cursor、Grok、OpenCode、Antigravity、Copilot；SDK 没有的不能；建出的引擎只有这一种账号，构造时不起进程', async () => {
    const context = { home, logger: createLogger({ mirror: () => {} }), env: {} };
    expect(subscriptionAccountEngines(context).kinds).toEqual([
      'claude',
      'cursor',
      'grok',
      'opencode',
      'antigravity',
      'copilot',
    ]);
    expect(subscriptionAccountEngines(context, { claude: false, cursor: false }).kinds).toEqual([
      'grok',
      'opencode',
      'antigravity',
      'copilot',
    ]);
    const factory = subscriptionAccountEngines(context);
    for (const kind of factory.kinds) {
      const adapter = factory.create(kind, {
        id: `${kind}-0001`,
        root: join(home, 'accounts', kind),
      });
      expect(adapter.accounts?.kinds).toEqual([kind]);
      await adapter.dispose();
    }
    expect(() => factory.create('workbuddy', { id: 'workbuddy-0001', root: home })).toThrow();
  });
});
