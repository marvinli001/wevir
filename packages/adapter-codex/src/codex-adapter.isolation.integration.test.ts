import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { type AgentEvent, isTurnTerminal } from '@wevir/runtime-adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import {
  codexBinaryOrSkip,
  collectingLogger,
  newAdapter,
  TempDirs,
} from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  type MockScript,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

// 外连与密钥（ADR-0005 决策 5 最后一条，改写自 spikes/codex-app-server/src/network-audit.ts 与 run-all.ts 的
// secrets 场景）：生成的配置下 codex-app-server 不连任何外部地址；网关令牌与上游 Key 不落盘、不进日志；模型跑的命令
// 看不到 WEVIR_*。

const binary = codexBinaryOrSkip('adapter-codex 外连与密钥');
const dirs = new TempDirs();
let mock: MockModel;
let script: MockScript = () => ({ text: ['ok'] });

beforeAll(async () => {
  if (binary !== undefined) mock = await startMockModel((view) => script(view));
});
afterAll(async () => {
  await mock?.close();
  dirs.cleanup();
});

/** 只记录目标主机、一律拒绝的代理：审计不产生真实外连。 */
async function startLoggingProxy() {
  const hosts = new Set<string>();
  const server = createServer((req, res) => {
    hosts.add(`http ${new URL(req.url ?? '', 'http://x').host}`);
    res.writeHead(502).end();
  });
  server.on('connect', (req, socket) => {
    hosts.add(`connect ${req.url}`);
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    hosts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 一个进程当前的 TCP 对端（lsof；没有 lsof 或 Windows 上返回 undefined）。 */
function tcpPeers(pid: number): string[] | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    return execFileSync('lsof', ['-a', '-p', String(pid), '-i', 'TCP', '-n', '-P', '-F', 'n'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.startsWith('n') && line.includes('->'))
      .map((line) => line.slice(1).split('->')[1] ?? '');
  } catch (error) {
    // lsof 找不到连接时退出码是 1，输出为空。
    if ((error as { status?: number }).status === 1) return [];
    return undefined;
  }
}

async function runTurn(a: CodexAdapter, id: string, text: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const done = (async () => {
    for await (const event of a.subscribe(id)) {
      events.push(event);
      if (isTurnTerminal(event)) return;
    }
  })();
  await a.send(id, { content: [{ type: 'text', text }] });
  await done;
  return events;
}

/** 目录里所有文件（含 SQLite 库、rollout、日志）中出现 `needle` 的文件。 */
function filesContaining(root: string, needle: string): string[] {
  const hits: string[] = [];
  const bytes = Buffer.from(needle);
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (stat?.isDirectory()) walk(path);
      else if (stat?.isFile() && readFileSync(path).includes(bytes)) hits.push(path);
    }
  };
  walk(root);
  return hits;
}

/** 打印全部环境变量与 WEVIR_* 的个数。Windows 上 Codex 用 PowerShell 跑命令。 */
const PRINT_ENV =
  process.platform === 'win32'
    ? 'Get-ChildItem env: | ForEach-Object { "$($_.Name)=$($_.Value)" }; ' +
      '"WEVIR_COUNT=" + @(Get-ChildItem env: | Where-Object Name -like \'WEVIR_*\').Count'
    : "env; echo WEVIR_COUNT=$(env | grep -c '^WEVIR_')";

/** 审计等待：插件同步、更新检查这类后台任务可能稍晚才发起（Spike 等 8 s）。 */
const AUDIT_WAIT_MS = 8000;

describe.skipIf(binary === undefined)('外连与密钥', { timeout: 90_000 }, () => {
  it('生成的配置下外连为零：没有 Provider 只启动进程，与有 Provider 跑一个带工具调用的回合', async () => {
    const proxy = await startLoggingProxy();
    const proxyEnv = {
      ...process.env,
      HTTP_PROXY: proxy.url,
      HTTPS_PROXY: proxy.url,
      ALL_PROXY: proxy.url,
      http_proxy: proxy.url,
      https_proxy: proxy.url,
      all_proxy: proxy.url,
      NO_PROXY: '127.0.0.1,localhost,::1',
      no_proxy: '127.0.0.1,localhost,::1',
    };
    const peers = new Set<string>();
    let lsof = true;
    const adapters: CodexAdapter[] = [];
    const watch = setInterval(() => {
      for (const a of adapters) {
        const pid = a.process.pid;
        if (pid === undefined) continue;
        const found = tcpPeers(pid);
        if (found === undefined) lsof = false;
        for (const peer of found ?? []) peers.add(peer);
      }
    }, 200);
    try {
      const idle = newAdapter({
        home: dirs.make('net-idle').home,
        parentEnv: proxyEnv,
        providers: [],
      });
      const { home, workspace } = dirs.make('net-turn');
      const busy = newAdapter({ home, parentEnv: proxyEnv, providers: [mockProvider(mock)] });
      adapters.push(idle, busy);
      script = (view) =>
        view.toolOutputs.length > 0
          ? { text: ['done'] }
          : { toolCalls: [{ kind: 'function', name: 'exec_command', args: { cmd: 'ls' } }] };
      await Promise.all([
        (async () => {
          await idle.process.start();
          await new Promise((resolve) => setTimeout(resolve, AUDIT_WAIT_MS));
        })(),
        (async () => {
          const session = await busy.createSession({
            cwd: workspace,
            providerId: 'mock',
            modelId: MOCK_MODEL,
          });
          const events = await runTurn(busy, session.engineSessionId, 'list files');
          expect(events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
          expect(events.some((e) => e.type === 'tool.finished' && e.status === 'completed')).toBe(
            true,
          );
          await new Promise((resolve) => setTimeout(resolve, AUDIT_WAIT_MS));
        })(),
      ]);
    } finally {
      clearInterval(watch);
      await Promise.allSettled(adapters.map((a) => a.dispose()));
      await proxy.close();
    }
    expect([...proxy.hosts]).toEqual([]);
    if (!lsof) {
      console.warn('[外连审计] 没有 lsof（或在 Windows 上），只检查了代理');
      return;
    }
    const local = (peer: string) => peer.startsWith('127.0.0.1:') || peer.startsWith('[::1]:');
    expect([...peers].filter((peer) => !local(peer))).toEqual([]);
  });

  it('网关令牌与上游 Key 不落盘、不进日志与 stderr；模型跑的命令看不到 WEVIR_*', async () => {
    const upstreamKey = `wevir-secret-upstream-${randomBytes(12).toString('hex')}`;
    const logger = collectingLogger();
    const { home, workspace } = dirs.make('secrets');
    const a = newAdapter({
      home,
      logger,
      rustLog: 'info',
      providers: [mockProvider(mock, { apiKey: upstreamKey })],
    });
    let token = '';
    let stderr = '';
    let output = '';
    try {
      script = (view) =>
        view.toolOutputs.length > 0
          ? { text: ['done'] }
          : {
              toolCalls: [
                {
                  kind: 'function',
                  name: 'exec_command',
                  args: { cmd: PRINT_ENV },
                },
              ],
            };
      const session = await a.createSession({
        cwd: workspace,
        providerId: 'mock',
        modelId: MOCK_MODEL,
      });
      token = a.gateway?.token ?? '';
      expect(token.length).toBeGreaterThan(20);
      const events = await runTurn(a, session.engineSessionId, 'print env');
      const finished = events.find((e) => e.type === 'tool.finished');
      output = finished?.type === 'tool.finished' ? (finished.output ?? '') : '';
      stderr = a.process.stderrTail;
    } finally {
      await a.dispose();
    }
    // 命令确实跑了，但环境里没有 WEVIR_*，也没有令牌与 Key。
    expect(output).toContain('WEVIR_COUNT=0');
    expect(output).toMatch(/^PATH=/im);
    expect(output).not.toContain(token);
    expect(output).not.toContain(upstreamKey);
    // 上游确实收到了 Key（经网关），Codex 那边只有令牌。
    expect(mock.requests.at(-1)?.headers.authorization).toBe(`Bearer ${upstreamKey}`);
    // 数据目录（CODEX_HOME 的 config.toml、模型目录、SQLite 库、rollout、日志）里都没有。
    expect(filesContaining(home, token)).toEqual([]);
    expect(filesContaining(home, upstreamKey)).toEqual([]);
    expect(stderr).not.toContain(token);
    expect(stderr).not.toContain(upstreamKey);
    const logs = [...logger.warnings, ...logger.infos].join('\n');
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(upstreamKey);
    // 令牌登记给了 Host 的日志去抹掉。
    expect(logger.secrets).toContain(token);
  });
});
