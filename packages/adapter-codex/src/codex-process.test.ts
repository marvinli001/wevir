import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type CodexExit, CodexProcess, type CodexProcessOptions } from './codex-process.js';

// CodexProcess 的 stdout 读取，对着 `node -e` 起的最小 app-server：回应 initialize，其余方法按名字做一件事。

const SERVER = String.raw`
const fs = require('node:fs');
const write = (text) => new Promise((resolve) => process.stdout.write(text, resolve));
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
const reply = (id, result) => write(JSON.stringify({ id, result }) + '\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    switch (message.method) {
      case 'initialize':
        await reply(message.id, { userAgent: 'fake', codexHome: '', platformFamily: 'unix', platformOs: 'macos' });
        break;
      case 'split': {
        // 一条回复分几块写出，块的边界落在一个汉字的 UTF-8 字节中间，行尾是 CRLF。
        const bytes = Buffer.from(JSON.stringify({ id: message.id, result: { text: '你好' } }) + '\r\n');
        const cut = bytes.indexOf(Buffer.from('你')) + 1;
        await write(bytes.subarray(0, cut));
        await pause();
        await write(bytes.subarray(cut));
        break;
      }
      case 'huge':
        // 一行分两块写出，单块都不超过上限，合起来超过。
        await write('{"id":' + message.id + ',"result":"' + 'x'.repeat(600));
        await pause();
        await write('y'.repeat(600));
        break;
      case 'closeStdout':
        // 关掉 stdout 但进程不退出（像 app-server 的输出管道坏了）。
        fs.closeSync(1);
        setInterval(() => {}, 1000);
        break;
    }
  }
});
`;

const dirs: string[] = [];
const processes: CodexProcess[] = [];

afterEach(async () => {
  await Promise.all(processes.splice(0).map((process) => process.dispose()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function start(options: Partial<CodexProcessOptions> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'wevir-codex-process-'));
  dirs.push(cwd);
  const codex = new CodexProcess({
    launcher: {
      prepare: async () => ({
        command: process.execPath,
        args: ['-e', SERVER],
        options: { cwd, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] },
      }),
    },
    clientInfo: { name: 'wevir-test', version: '0.0.0' },
    restart: { maxRestarts: 0 },
    ...options,
  });
  processes.push(codex);
  const exits: CodexExit[] = [];
  codex.on('exit', (exit) => exits.push(exit));
  const failed = new Promise<void>((resolve) => codex.once('failed', () => resolve()));
  return { codex, exits, failed };
}

describe('CodexProcess 的 stdout', () => {
  it('跨块的一行按字节拼起来再解码，去掉行尾的 \\r', async () => {
    const { codex } = start();
    await codex.start();
    await expect(codex.request('split', {})).resolves.toEqual({ text: '你好' });
  });

  it('一行超过上限：挂起的请求失败，进程按意外退出结束，原因记在 stderr 尾部', async () => {
    const { codex, exits, failed } = start({ maxLineBytes: 1024 });
    await codex.start();
    const huge = codex.request('huge', {});
    await expect(huge).rejects.toMatchObject({
      code: 'engine_unavailable',
      message: expect.stringContaining('超过 1024 字节'),
    });
    await failed;
    expect(exits).toHaveLength(1);
    expect(exits[0]?.signal).toBe('SIGTERM');
    expect(exits[0]?.stderrTail).toContain('超过 1024 字节');
  });

  it('stdout 关闭而进程还在：短暂等待后挂起的请求失败，进程被结束', async () => {
    const { codex, exits, failed } = start();
    await codex.start();
    const startedAt = Date.now();
    const pending = codex.request('closeStdout', {});
    await expect(pending).rejects.toMatchObject({
      code: 'engine_unavailable',
      message: expect.stringContaining('stdout 已关闭'),
    });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    await failed;
    expect(exits).toHaveLength(1);
    expect(exits[0]?.stderrTail).toContain('stdout 已关闭');
  });
});
