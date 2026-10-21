import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { subscriptionAccountEngines, subscriptionEngines } from './engines.js';
import { createLogger } from './logger.js';

const home = mkdtempSync(join(tmpdir(), 'wevir-engines-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('subscriptionEngines', () => {
  it('开发环境装了两个 SDK：七种订阅引擎都挂上', () => {
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
    ]);
    expect(lines.join('\n')).not.toContain('engine sdk not installed');
  });

  it('安装包里没有 Claude 与 Cursor 的 SDK：不挂这两个引擎并记一条日志（ADR-0007 补记 3）', () => {
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
    ]);
    expect(lines.filter((line) => line.includes('engine sdk not installed'))).toHaveLength(2);
  });
});

describe('subscriptionAccountEngines（0.63.0）', () => {
  it('能添加账号的是 Claude、Cursor、Grok、Antigravity；SDK 没装的不能；建出的引擎只有这一种账号，构造时不起进程', async () => {
    const context = { home, logger: createLogger({ mirror: () => {} }), env: {} };
    expect(subscriptionAccountEngines(context).kinds).toEqual([
      'claude',
      'cursor',
      'grok',
      'antigravity',
    ]);
    expect(subscriptionAccountEngines(context, { claude: false, cursor: false }).kinds).toEqual([
      'grok',
      'antigravity',
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
    expect(() => factory.create('opencode', { id: 'opencode-0001', root: home })).toThrow();
  });
});
