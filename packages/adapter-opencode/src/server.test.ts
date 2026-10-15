// server.ts 的进程管理：用一个假的 `opencode`（Node 脚本，照 `opencode serve` 打出监听地址、再起一个孙进程）核对就绪、交给它的
// 环境、整组停掉、启动前退出与超时，以及台账清理上一个 Host 留下的服务器。Windows 上的服务器不分离、不记台账，这里跳过。

import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SERVER_PERMISSION_CONFIG } from './permissions.js';
import { LEDGER_DIRECTORY, ServerLedger, startOpenCodeServer } from './server.js';

const root = mkdtempSync(join(tmpdir(), 'wevir-opencode-server-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SCRIPT = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const http = require('node:http');
const port = Number(process.argv.find((arg) => arg.startsWith('--port='))?.slice(7));
const out = process.env.FAKE_OUT;
writeFileSync(out + '.env', JSON.stringify({
  password: process.env.OPENCODE_SERVER_PASSWORD,
  config: process.env.OPENCODE_CONFIG_CONTENT,
  args: process.argv.slice(2),
}));
if (process.env.FAKE_MODE === 'exit') { console.error('boom: no provider'); process.exit(3); }
if (process.env.FAKE_MODE === 'hang') { setInterval(() => {}, 1000); return; }
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(out + '.child', String(child.pid));
http.createServer((req, res) => res.end('{}')).listen(port, '127.0.0.1', () => {
  console.log('Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.');
  console.log('opencode server listening on http://127.0.0.1:' + port);
});
`;

const executable = join(root, 'opencode');
writeFileSync(executable, SCRIPT);
chmodSync(executable, 0o755);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const posix = process.platform !== 'win32';

describe.skipIf(!posix)('startOpenCodeServer', { timeout: 20_000 }, () => {
  it('就绪后核对版本；带随机密码与并进权限配置的 OPENCODE_CONFIG_CONTENT；停的时候整组退出，台账条目删掉', async () => {
    const out = join(root, 'ready');
    const engineDir = join(root, 'engine-ready');
    const ledger = new ServerLedger({ engineDir });
    let verified: { url: string; password: string } | undefined;
    const server = await startOpenCodeServer({
      executable,
      env: { ...process.env, FAKE_OUT: out, OPENCODE_CONFIG_CONTENT: '{"model":"a/b"}' },
      ledger,
      verify: async (url, password) => {
        verified = { url, password };
        return '1.18.34';
      },
    });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.version).toBe('1.18.34');
    expect(verified).toEqual({ url: server.url, password: server.password });
    const env = JSON.parse(readFileSync(`${out}.env`, 'utf8')) as {
      password: string;
      config: string;
      args: string[];
    };
    expect(env.password).toBe(server.password);
    expect(env.password.length).toBeGreaterThanOrEqual(40);
    expect(JSON.parse(env.config)).toEqual({ model: 'a/b', permission: SERVER_PERMISSION_CONFIG });
    expect(env.args).toEqual([
      'serve',
      '--hostname=127.0.0.1',
      `--port=${new URL(server.url).port}`,
    ]);
    const grandchild = Number(readFileSync(`${out}.child`, 'utf8'));
    expect(alive(grandchild)).toBe(true);
    expect(readdirSync(join(engineDir, LEDGER_DIRECTORY))).toEqual([`${server.pid}.json`]);

    await server.stop();
    await waitUntil(() => !alive(grandchild));
    expect(readdirSync(join(engineDir, LEDGER_DIRECTORY))).toEqual([]);
    expect(await server.exited).toMatchObject({ signal: 'SIGTERM' });
    await server.stop();
  });

  it('启动前退出：报退出码与 stderr', async () => {
    await expect(
      startOpenCodeServer({
        executable,
        env: { ...process.env, FAKE_OUT: join(root, 'exit'), FAKE_MODE: 'exit' },
        verify: async () => '1.18.34',
      }),
    ).rejects.toThrow(/exited before startup completed \(code: 3\)[\s\S]*boom: no provider/);
  });

  it('超时：停掉进程并报错', async () => {
    const out = join(root, 'hang');
    await expect(
      startOpenCodeServer({
        executable,
        env: { ...process.env, FAKE_OUT: out, FAKE_MODE: 'hang' },
        verify: async () => '1.18.34',
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/Timed out waiting for the OpenCode server after 300 ms/);
  });

  it('核对版本失败：停掉进程', async () => {
    const out = join(root, 'verify');
    await expect(
      startOpenCodeServer({
        executable,
        env: { ...process.env, FAKE_OUT: out },
        verify: async () => {
          throw new Error('OpenCode v1.0.0 is too old');
        },
      }),
    ).rejects.toThrow(/too old/);
    const grandchild = Number(readFileSync(`${out}.child`, 'utf8'));
    await waitUntil(() => !alive(grandchild));
  });

  it('找不到可执行文件', async () => {
    await expect(
      startOpenCodeServer({
        executable: join(root, 'missing'),
        env: process.env,
        verify: async () => 'x',
      }),
    ).rejects.toThrow(/ENOENT|exited before startup/);
  });
});

describe.skipIf(!posix)('ServerLedger', { timeout: 20_000 }, () => {
  it('主人已经不在的服务器：下一个 Host 停掉整组并删掉条目；主人还在的不动', async () => {
    const engineDir = join(root, 'engine-reap');
    const args = ['-e', 'setInterval(() => {}, 1000)', 'serve', '--port=1'];
    const orphan = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
    orphan.unref();
    const pid = orphan.pid as number;
    const ledger = new ServerLedger({ engineDir });
    await ledger.track({ pid, port: 1, args });
    const file = join(engineDir, LEDGER_DIRECTORY, `${pid}.json`);
    expect(existsSync(file)).toBe(true);

    // 主人（本进程）还在：不动。
    await new ServerLedger({ engineDir }).reapOrphans();
    expect(alive(pid)).toBe(true);
    expect(existsSync(file)).toBe(true);

    // 改成一个早就不在的主人：停掉。
    const entry = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...entry, owner: { pid: 999_999, startTime: 'gone' } }));
    await new ServerLedger({ engineDir }).reapOrphans();
    await waitUntil(() => !alive(pid));
    expect(existsSync(file)).toBe(false);
  });

  it('pid 被别的进程复用（命令行对不上）：只删条目，不发信号', async () => {
    const engineDir = join(root, 'engine-reuse');
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    other.unref();
    const pid = other.pid as number;
    const ledger = new ServerLedger({ engineDir });
    await ledger.track({ pid, port: 2, args: ['serve'] });
    const file = join(engineDir, LEDGER_DIRECTORY, `${pid}.json`);
    const entry = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      file,
      JSON.stringify({
        ...entry,
        command: 'opencode serve --port=2',
        owner: { pid: 999_999, startTime: 'gone' },
      }),
    );
    await new ServerLedger({ engineDir }).reapOrphans();
    expect(existsSync(file)).toBe(false);
    expect(alive(pid)).toBe(true);
    process.kill(-pid, 'SIGKILL');
  });
});
