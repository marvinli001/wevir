import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { subscriptionEngines } from './engines.js';
import { createLogger } from './logger.js';

const home = mkdtempSync(join(tmpdir(), 'wevir-engines-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('subscriptionEngines', () => {
  it('开发环境装了两个 SDK：五种订阅引擎都挂上', () => {
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
    ]);
    expect(lines.join('\n')).not.toContain('engine sdk not installed');
  });

  it('安装包里没有 Claude 与 Cursor 的 SDK：不挂这两个引擎并记一条日志（ADR-0007 补记 3）', () => {
    const lines: string[] = [];
    const routes = subscriptionEngines(
      { home, logger: createLogger({ mirror: (line) => lines.push(line) }), env: {} },
      { claude: false, cursor: false },
    );
    expect(routes.map((route) => route.name)).toEqual(['opencode', 'grok', 'antigravity']);
    expect(lines.filter((line) => line.includes('engine sdk not installed'))).toHaveLength(2);
  });
});
