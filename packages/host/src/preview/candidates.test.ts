import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDir } from '../test-utils.js';
import { explicitPort, findPreviewCandidates, shellQuote } from './candidates.js';

const tempDir = useTempDir();

describe('findPreviewCandidates', () => {
  it('读根目录与 apps/* 的开发服务器脚本（按锁文件选包管理器），跳过构建与测试；读 .claude/launch.json', async () => {
    const root = tempDir();
    writeFileSync(join(root, 'pnpm-lock.yaml'), '');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        scripts: { dev: 'vite --port 3000', build: 'vite build', 'dev:build': 'x', test: 'vitest' },
      }),
    );
    mkdirSync(join(root, 'apps', 'web'), { recursive: true });
    writeFileSync(
      join(root, 'apps', 'web', 'package.json'),
      JSON.stringify({ scripts: { start: 'next start', storybook: 'storybook dev -p 6006' } }),
    );
    mkdirSync(join(root, '.claude'));
    writeFileSync(
      join(root, '.claude', 'launch.json'),
      JSON.stringify({
        version: '0.0.1',
        configurations: [
          {
            name: 'api',
            runtimeExecutable: 'pnpm',
            runtimeArgs: ['--filter', 'api', 'dev', "it's"],
            port: 8787,
            cwd: 'services',
            env: { NODE_ENV: 'development', BAD: 1 },
          },
          { name: 'broken', runtimeArgs: ['x'] },
          { name: 'outside', runtimeExecutable: 'x', cwd: '../up' },
        ],
      }),
    );
    expect(await findPreviewCandidates(root)).toEqual([
      {
        name: 'api',
        command: "pnpm --filter api dev 'it'\\''s'",
        cwd: 'services',
        port: 8787,
        env: { NODE_ENV: 'development' },
        origin: 'claude_launch',
        file: '.claude/launch.json',
      },
      {
        name: 'dev',
        command: 'pnpm run dev',
        cwd: '',
        port: 3000,
        origin: 'package_script',
        file: 'package.json',
      },
      {
        name: 'start · apps/web',
        command: 'pnpm run start',
        cwd: 'apps/web',
        origin: 'package_script',
        file: 'apps/web/package.json',
      },
      {
        name: 'storybook · apps/web',
        command: 'pnpm run storybook',
        cwd: 'apps/web',
        port: 6006,
        origin: 'package_script',
        file: 'apps/web/package.json',
      },
    ]);
  });

  it('没有 package.json 与 launch.json 时是空的', async () => {
    expect(await findPreviewCandidates(tempDir())).toEqual([]);
  });

  it('只认写明的端口', () => {
    expect(explicitPort('vite --port 5174')).toBe(5174);
    expect(explicitPort('vite --port=5174')).toBe(5174);
    expect(explicitPort('next dev -p 3001')).toBe(3001);
    expect(explicitPort('PORT=4000 node server.js')).toBe(4000);
    expect(explicitPort('vite')).toBeUndefined();
    expect(explicitPort('x --port 99999')).toBeUndefined();
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote('--port=3000')).toBe('--port=3000');
  });
});
