// 真实 dsh 的集成测试：只需要本机能运行 dsh（pnpm install 之后即可），不需要模型 Key。
// 需要模型回复的用例用本地脚本化的 OpenAI 兼容服务代替（startMockModel）。

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { DshProcess, dshSpawnSpec } from './dsh-process.js';
import { dshPaths, prepareDshHome, resolveDshEntry } from './paths.js';

const posix = process.platform !== 'win32';
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `wevir-adapter-dsh-${label}-`)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `pid` 的全部后代进程（POSIX，`ps`）。 */
function descendants(pid: number): Array<{ pid: number; command: string }> {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] ?? '' }));
  const out: Array<{ pid: number; command: string }> = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const row of rows) {
      if (row.ppid === parent) {
        out.push({ pid: row.pid, command: row.command });
        queue.push(row.pid);
      }
    }
  }
  return out;
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs} ms）：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const SLEEP_SECONDS = 291;

/**
 * 最小的 OpenAI Chat Completions 流式服务：对话里还没有工具结果时让模型调用 bash 执行
 * `sleep 291`，之后回一句文本。
 */
async function startMockModel(): Promise<{ baseURL: string }> {
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'wevir-mock', object: 'model' }] }));
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      const request = JSON.parse(body) as { messages: Array<{ role: string }> };
      const hasToolResult = request.messages.some((m) => m.role === 'tool');
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({
          id: 'chatcmpl-wevir',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'wevir-mock',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content: '' }, null));
      if (hasToolResult) {
        res.write(chunk({ content: 'done' }, null));
        res.write(chunk({}, 'stop'));
      } else {
        res.write(
          chunk(
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_wevir_sleep',
                  type: 'function',
                  function: {
                    name: 'bash',
                    arguments: JSON.stringify({
                      command: `sleep ${SLEEP_SECONDS}`,
                      description: 'Sleep',
                    }),
                  },
                },
              ],
            },
            null,
          ),
        );
        res.write(chunk({}, 'tool_calls'));
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

/** 指向本地 mock 的 Provider overlay（格式见 T0.3 §6.2），只写 Key 的环境变量名。 */
function writeMockOverlay(dir: string, baseURL: string): string {
  const file = join(dir, 'provider.yml');
  writeFileSync(
    file,
    [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      wevir-test:',
      '        displayName: Wevir Test',
      '        apiKeyEnv: WEVIR_PROVIDER_WEVIR_TEST_KEY',
      '        api: openai-completions',
      `        baseURL: ${baseURL}`,
      '        compat:',
      '          supportsDeveloperRole: false',
      '          maxTokensField: max_tokens',
      '        models:',
      '          - id: wevir-mock',
      '- id: acp',
      '  config:',
      '    provider: wevir-test',
      '    model: wevir-mock',
      '',
    ].join('\n'),
  );
  return file;
}

describe('DshProcess（真实 dsh）', () => {
  it('启动 → initialize 成功 → 一个进程承载多个会话 → dispose 后无残留进程', async () => {
    const home = tempDir('home');
    const dsh = new DshProcess({ home });
    cleanups.push(() => dsh.dispose());

    const started = performance.now();
    const init = await dsh.start();
    const startMs = performance.now() - started;
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(init.agentInfo?.name).toBe('deepseek-harness-acp');
    expect(dsh.state).toBe('ready');
    // dsh 首次启动时自己初始化 DSH_HOME
    expect(readdirSync(dsh.paths.dshHome)).toEqual(expect.arrayContaining(['profiles']));
    expect(readdirSync(dsh.paths.agentsHome)).toEqual([]);

    // ADR-0001 §2：一个 dsh 进程承载全部会话
    const workspaces = ['a', 'b', 'c'].map((name) => {
      const dir = join(tempDir('ws'), name);
      mkdirSync(dir);
      return dir;
    });
    const sessions = await Promise.all(
      workspaces.map((cwd) =>
        dsh.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] }),
      ),
    );
    expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(3);

    const pid = dsh.pid as number;
    const tree = [pid, ...(posix ? descendants(pid).map((p) => p.pid) : [])];
    const disposeStarted = performance.now();
    await dsh.dispose();
    const disposeMs = performance.now() - disposeStarted;

    expect(dsh.state).toBe('disposed');
    // 走的是第一步：关 stdin 后 dsh 自行退出，没有用到信号
    expect(dsh.lastExit).toMatchObject({ pid, signal: null });
    expect(disposeMs).toBeLessThan(5000);
    await waitFor(
      () => (tree.every((p) => !alive(p)) ? true : undefined),
      3000,
      `进程 ${tree.join(', ')} 全部退出`,
    );
    console.info(
      `[T3.1] spawn → initialize ${startMs.toFixed(0)} ms；dispose ${disposeMs.toFixed(0)} ms；进程树 ${tree.length} 个`,
    );
  });

  it.skipIf(!posix)(
    'Host 被强杀时 dsh 因 stdin EOF 自行退出，它拉起的工具子进程随之结束',
    async () => {
      const home = tempDir('home');
      const workspace = tempDir('ws');
      const model = await startMockModel();
      const spec = dshSpawnSpec({
        entry: resolveDshEntry().entry,
        paths: prepareDshHome(dshPaths(home)),
        patches: [writeMockOverlay(tempDir('overlay'), model.baseURL)],
        env: { WEVIR_PROVIDER_WEVIR_TEST_KEY: 'wevir-mock-key-not-a-secret' },
      });

      // 假 Host：按 dshSpawnSpec 拉起 dsh，把自己的 stdin / stdout 转给它，然后被 SIGKILL。
      const host = spawn(
        process.execPath,
        [
          '-e',
          `const { spawn } = require('node:child_process');
           const spec = JSON.parse(process.env.WEVIR_TEST_SPAWN_SPEC);
           const dsh = spawn(spec.command, spec.args, spec.options);
           process.stderr.write(JSON.stringify({ dshPid: dsh.pid }) + '\\n');
           dsh.stdout.pipe(process.stdout);
           process.stdin.pipe(dsh.stdin);
           dsh.stderr.resume();`,
        ],
        {
          env: { PATH: process.env.PATH, WEVIR_TEST_SPAWN_SPEC: JSON.stringify(spec) },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      cleanups.push(() => host.kill('SIGKILL'));
      let hostStderr = '';
      host.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        hostStderr += chunk;
      });
      const dshPid = await waitFor(
        () => {
          const m = /\{"dshPid":(\d+)\}/.exec(hostStderr);
          return m === null ? undefined : Number(m[1]);
        },
        5000,
        '假 Host 报告 dsh 的 pid',
      );
      cleanups.push(() => {
        if (alive(dshPid)) process.kill(-dshPid, 'SIGKILL');
      });

      const connection = client({ name: 'wevir-test' }).connect(
        ndJsonStream(
          Writable.toWeb(host.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(host.stdout) as ReadableStream<Uint8Array>,
        ),
      );
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const { sessionId } = await connection.agent.request(methods.agent.session.new, {
        cwd: workspace,
        mcpServers: [],
      });
      void connection.agent
        .request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: `用 bash 执行 sleep ${SLEEP_SECONDS}` }],
        })
        .catch(() => {});

      const tool = await waitFor(
        () =>
          descendants(dshPid).find((p) =>
            new RegExp(`(^|/)sleep ${SLEEP_SECONDS}\\b`).test(p.command),
          ),
        30_000,
        `dsh 拉起 sleep ${SLEEP_SECONDS}`,
      );
      const tree = [dshPid, ...descendants(dshPid).map((p) => p.pid)];
      expect(tree).toContain(tool.pid);

      const killedAt = performance.now();
      host.kill('SIGKILL');
      await waitFor(() => (alive(dshPid) ? undefined : true), 5000, 'dsh 读到 stdin EOF 后退出');
      const dshExitMs = performance.now() - killedAt;
      await waitFor(
        () => (tree.every((p) => !alive(p)) ? true : undefined),
        5000,
        `进程树 ${tree.join(', ')} 全部退出`,
      );
      console.info(
        `[T3.1] 假 Host 被 SIGKILL 后 ${dshExitMs.toFixed(0)} ms dsh 退出；进程树 ${tree.length} 个全部结束`,
      );
    },
    60_000,
  );
});
