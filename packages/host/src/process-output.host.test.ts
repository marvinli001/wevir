// 进程输出（0.69.0，Host 功能 `process_output`）：startHost 组装出的真实 Host（echo 引擎声明能挂应用级工具），Agent 那一侧直接按 MCP
// 调 `wevir_process_start`，客户端经 WebSocket 用 `process.*` 列出、分页读输出、停止，并收 `process.changed`。另跑一个检查，看检查的
// 进程也列得出、停止等于取消这次检查。覆盖大输出、断线重连后接着读、Host 重启、进程自己退出、非 UTF-8 输出与超长行。POSIX 上跑。

import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId, WevirEvent } from '@wevir/protocol';
import type { AppToolsEndpoint, EngineSession, SessionConfig } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { type ProcessGroupRecord, processFingerprint } from './process-groups.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const WAIT_MS = 15_000;
const tempDir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class ToolEcho extends EchoAdapter {
  readonly appTools = true;
  readonly endpoints = new Map<string, AppToolsEndpoint | undefined>();

  override async createSession(config: SessionConfig): Promise<EngineSession> {
    const session = await super.createSession(config);
    this.endpoints.set(session.engineSessionId, config.appTools);
    return session;
  }
}

async function connect(url: string, home: string) {
  const token = (
    JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as { token: string }
  ).token;
  const client = await TestRpcClient.connect(url);
  cleanups.push(() => client.ws.close());
  const hello = await client.hello(token);
  expect(hello.error).toBeUndefined();
  return { client, features: hello.result.features as Record<string, boolean> };
}

async function boot(home: string, workspaceDir: string, stepDelayMs = 1) {
  const adapter = new ToolEcho({ stepDelayMs });
  const host = await startHost({
    adapter,
    engine: 'echo',
    logger: createLogger({ level: 'error', mirror: () => {} }),
    home,
  });
  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    await host.shutdown();
  };
  cleanups.push(shutdown);
  const { client, features } = await connect(host.url, home);
  const workspaces = (await client.request('workspace.list')).workspaces as Array<{ id: string }>;
  const workspaceId =
    workspaces[0]?.id ??
    ((await client.request('workspace.add', { rootPath: workspaceDir })).workspace.id as string);
  await client.request('provider.upsert', {
    id: 'deepseek-official',
    kind: 'deepseek-official',
    displayName: 'DeepSeek',
    models: [],
    defaultModelId: 'deepseek-chat',
  });
  const create = async () =>
    (await client.request('session.create', { workspaceId, providerId: 'deepseek-official' }))
      .session.id as SessionId;
  /** Agent 调一个应用级工具，返回结果的文本。 */
  const tool = async (sessionId: SessionId, name: string, args: Record<string, unknown>) => {
    const { session } = await client.request('session.get', { sessionId });
    const endpoint = adapter.endpoints.get(session.engine.sessionId) as AppToolsEndpoint;
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${endpoint.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: 读任意形状的 MCP 回复。
    const result = ((await response.json()) as Record<string, any>).result;
    return (result.content as Array<{ text: string }>).map((part) => part.text).join('\n');
  };
  return { host, client, features, workspaceId, create, tool, shutdown };
}

/** 一页一页读到 `bytes`，返回拼起来的文本与最后的偏移量。 */
async function readAll(client: TestRpcClient, processId: string, offset = 0) {
  let text = '';
  let next = offset;
  for (;;) {
    const page = await client.request('process.output', { processId, offset: next });
    text += page.text;
    next = page.next;
    if (!page.more) return { text, next, page };
  }
}

/** 把脚本写进会话目录，返回运行它的命令（shell 里的引号与转义不碍事）。 */
let scripts = 0;
function node(dir: string, script: string): string {
  const file = `script-${++scripts}.mjs`;
  writeFileSync(join(dir, file), script);
  return `'${process.execPath}' ${file}`;
}

describe.runIf(process.platform !== 'win32')('进程输出经 Host API', () => {
  const dirs = () => {
    const root = realpathSync(tempDir());
    const workspaceDir = join(root, 'project');
    mkdirSync(workspaceDir, { recursive: true });
    return { home: join(root, 'home'), workspaceDir };
  };

  it('Agent 的进程：列表带来源，大输出分页读完，自己退出后状态与退出码对，变化有通知', async () => {
    const { home, workspaceDir } = dirs();
    const h = await boot(home, workspaceDir);
    expect(h.features.process_output).toBe(true);
    expect((await h.client.request('process.list')).processes).toEqual([]);
    const sessionId = await h.create();
    // 约 1 MB：多于三页（256 KiB），带非 UTF-8 字节与一行 300 KB 的长行。
    const script = [
      'const out = process.stdout;',
      "for (let i = 0; i < 6000; i++) out.write('line ' + i + ' ' + 'x'.repeat(100) + '\\n');",
      'out.write(Buffer.from([0x66, 0xff, 0xfe, 0x6f, 0x0a]));',
      "out.write('L'.repeat(300000) + '\\n');",
      "out.write('\\u001b[31mred\\u001b[0m 中文\\n');",
      'process.exitCode = 4;',
    ].join('\n');
    await h.tool(sessionId, 'wevir_process_start', {
      command: node(workspaceDir, script),
      name: 'big',
      notifyOnExit: false,
    });
    const listed = (await h.client.request('process.list', { sessionId })).processes;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: 'p1',
      workspaceId: h.workspaceId,
      source: { kind: 'agent', sessionId },
      name: 'big',
      cwd: workspaceDir,
    });
    const exited = await h.client.until(
      () =>
        h.client
          .notifications('process.changed')
          .find((change) => change.process?.id === 'p1' && change.process.status === 'exited')
          ?.process,
      'exited',
      WAIT_MS,
    );
    expect(exited).toMatchObject({ exitCode: 4, signal: null, stopSignals: [] });
    expect(exited.stoppedBy).toBeUndefined();
    expect(exited.bytes).toBeGreaterThan(900_000);

    // 默认读最后一页；往前翻到开头；整段读下来与写的一致（去掉了颜色、非 UTF-8 是 U+FFFD）。
    const tail = await h.client.request('process.output', { processId: 'p1' });
    expect(tail.next).toBe(exited.bytes);
    expect(tail.text.endsWith('red 中文\n')).toBe(true);
    const before = await h.client.request('process.output', {
      processId: 'p1',
      offset: Math.max(0, tail.from - 256 * 1024),
      until: tail.from,
    });
    expect(before.next).toBe(tail.from);
    const all = await readAll(h.client, 'p1');
    expect(all.next).toBe(exited.bytes);
    const lines = all.text.split('\n');
    expect(lines[0]).toBe(`line 0 ${'x'.repeat(100)}`);
    expect(lines[6000]).toBe('f��o');
    expect(lines[6001]).toHaveLength(300000);
    expect(lines[6002]).toBe('red 中文');
    // 页的边界不截在半个字符上：从“中”（结尾的“中文\n”是 7 个字节）的第二个字节读起会挪到“文”。
    const zh = exited.bytes - 7;
    const mid = await h.client.request('process.output', { processId: 'p1', offset: zh + 1 });
    expect(mid.from).toBe(zh + 3);
    expect(mid.text).toBe('文\n');
  }, 30_000);

  it('回合进行中起的进程：来源带这个回合', async () => {
    const { home, workspaceDir } = dirs();
    // echo 每一步慢一点，回合在调工具时还没结束。
    const h = await boot(home, workspaceDir, 400);
    const sessionId = await h.create();
    const { turnId } = await h.client.request('session.send', {
      sessionId,
      content: [{ type: 'text', text: 'think about it' }],
    });
    await h.tool(sessionId, 'wevir_process_start', {
      command: node(workspaceDir, "console.log('x');"),
      notifyOnExit: false,
    });
    const [listed] = (await h.client.request('process.list', { sessionId })).processes;
    expect(listed.source).toEqual({ kind: 'agent', sessionId, turnId });
  }, 30_000);

  it('停止：选的信号发给进程组，记下是用户停的；Agent 那边看得到，不发退出消息', async () => {
    const { home, workspaceDir } = dirs();
    const h = await boot(home, workspaceDir);
    const sessionId = await h.create();
    // 自己再起一个子进程：停的是整个进程组。
    writeFileSync(
      join(workspaceDir, 'serve.mjs'),
      [
        "import { spawn } from 'node:child_process';",
        "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
        "process.on('SIGINT', () => { console.log('got SIGINT'); process.exit(130); });",
        "console.log('ready');",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    await h.tool(sessionId, 'wevir_process_start', {
      command: `${JSON.stringify(process.execPath)} serve.mjs`,
      name: 'server',
      waitFor: 'ready',
      timeoutMs: 10_000,
    });
    const [running] = (await h.client.request('process.list', { sessionId })).processes;
    expect(running).toMatchObject({
      status: 'running',
      stopSignals: ['SIGINT', 'SIGTERM', 'SIGKILL'],
    });
    const refused = await h.client.call('process.stop', { processId: 'p1', signal: 'SIGHUP' });
    expect(refused.error?.code).toBeDefined();
    const stopped = await h.client.request('process.stop', { processId: 'p1', signal: 'SIGINT' });
    expect(stopped.process).toMatchObject({ id: 'p1', stoppedBy: 'user' });
    const exited = await h.client.until(
      () =>
        h.client
          .notifications('process.changed')
          .find((change) => change.process?.id === 'p1' && change.process.status === 'exited')
          ?.process,
      'stopped',
      WAIT_MS,
    );
    expect(exited).toMatchObject({ exitCode: 130, stoppedBy: 'user' });
    expect((await readAll(h.client, 'p1')).text).toContain('got SIGINT');
    // 孙进程也停了：组里没人了。
    expect(() => process.kill(-(running.pid as number), 0)).toThrow();
    const listText = await h.tool(sessionId, 'wevir_process_list', {});
    expect(listText).toContain('the user stopped it in Wevir');
    // 已退出的再停：照样返回，不报错。
    expect((await h.client.request('process.stop', { processId: 'p1' })).process.status).toBe(
      'exited',
    );
  }, 30_000);

  it('断线重连后从上次的偏移量接着读，不丢不重；Host 重启后列表是空的，旧 ID 读不到', async () => {
    const { home, workspaceDir } = dirs();
    const h = await boot(home, workspaceDir);
    const sessionId = await h.create();
    // 调过 `process.*` 的连接才收 `process.changed`。
    await h.client.request('process.list');
    await h.tool(sessionId, 'wevir_process_start', {
      command: node(workspaceDir, "let i = 0; setInterval(() => console.log('n' + i++), 20);"),
      name: 'counter',
    });
    await h.client.until(
      () =>
        h.client
          .notifications('process.changed')
          .find((change) => (change.process?.bytes ?? 0) > 20),
      'some output',
      WAIT_MS,
    );
    const first = await readAll(h.client, 'p1');
    h.client.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const again = await connect(h.host.url, home);
    const [still] = (await again.client.request('process.list')).processes;
    expect(still.bytes).toBeGreaterThan(first.next);
    const rest = await readAll(again.client, 'p1', first.next);
    const numbers = (first.text + rest.text)
      .trim()
      .split('\n')
      .map((line) => Number(line.slice(1)));
    expect(numbers).toEqual(numbers.map((_, index) => index));

    await h.shutdown();
    const restarted = await boot(home, workspaceDir);
    expect((await restarted.client.request('process.list')).processes).toEqual([]);
    const gone = await restarted.client.call('process.output', { processId: 'p1' });
    expect(gone.error?.message).toContain('not found');
  }, 30_000);

  it('Host 被强行结束后再启动：登记的后台进程被结束，列表里记成被 Host 停的，新进程的 ID 接着编', async () => {
    const { home, workspaceDir } = dirs();
    const h = await boot(home, workspaceDir);
    const sessionId = await h.create();
    // 运行中的进程登记在 process-groups/ 里。
    await h.tool(sessionId, 'wevir_process_start', { command: 'sleep 60', name: 'live' });
    const groupsDir = join(home, 'process-groups');
    await vi.waitFor(() => expect(readdirSync(groupsDir)).toHaveLength(1), { timeout: WAIT_MS });
    const live = JSON.parse(
      readFileSync(join(groupsDir, readdirSync(groupsDir)[0] as string), 'utf8'),
    ) as ProcessGroupRecord;
    expect(live).toMatchObject({ kind: 'process', sessionId, ownerId: 'p1', name: 'live' });
    await h.shutdown();
    // 正常关闭：进程结束，登记删掉。
    expect(readdirSync(groupsDir)).toEqual([]);

    // 模拟上一次 Host 被强行结束：一个还活着的组与它的登记（看门狗也没了）。
    const orphan = spawn('/bin/sh', ['-c', 'sleep 60 & exec sleep 60'], {
      detached: true,
      stdio: 'ignore',
    });
    const pgid = orphan.pid as number;
    cleanups.push(() => {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {}
    });
    const logPath = join(home, 'tool-output', sessionId, 'process-p4.log');
    writeFileSync(logPath, 'still running\n');
    const record: ProcessGroupRecord = {
      kind: 'process',
      name: 'orphan',
      sessionId,
      ownerId: 'p4',
      command: 'sleep 60',
      cwd: workspaceDir,
      logPath,
      pgid,
      fingerprint: (await processFingerprint(pgid)) as string,
      hostPid: 1,
      hostInstance: 'crashed',
      startedAt: Date.now() - 1000,
    };
    writeFileSync(join(groupsDir, `${pgid}.json`), JSON.stringify(record));

    const restarted = await boot(home, workspaceDir);
    expect(() => process.kill(-pgid, 0)).toThrow();
    expect(readdirSync(groupsDir)).toEqual([]);
    const { processes } = await restarted.client.request('process.list', { sessionId });
    expect(processes).toEqual([
      expect.objectContaining({
        id: 'p4',
        name: 'orphan',
        status: 'exited',
        stoppedBy: 'host',
        signal: 'SIGTERM',
        bytes: 14,
      }),
    ]);
    expect((await readAll(restarted.client, 'p4')).text).toBe('still running\n');
    // ID 不分会话编号（新起的会话挂在这次的引擎上）。
    const fresh = await restarted.create();
    expect(
      await restarted.tool(fresh, 'wevir_process_start', { command: 'true', name: 'next' }),
    ).toContain('p5');
  }, 30_000);

  it('检查的进程：跑的时候列得出（来源带检查与回合），停止等于取消这次检查', async () => {
    const { home, workspaceDir } = dirs();
    const h = await boot(home, workspaceDir);
    const sessionId = await h.create();
    const { subscriptionId } = await h.client.request('events.subscribe', {
      sessionId,
      sinceSeq: 0,
    });
    const { check } = await h.client.request('checks.save', {
      workspaceId: h.workspaceId,
      check: {
        name: 'slow test',
        command: node(
          workspaceDir,
          "console.log('starting'); setInterval(() => console.log('tick'), 50);",
        ),
        cwd: '',
        timeoutMs: 60_000,
        kind: 'other',
        trigger: 'manual',
      },
    });
    await h.client.request('process.list');
    await h.client.request('verification.run', { sessionId, checkIds: [check.id] });
    const proc = await h.client.until(
      () =>
        h.client
          .notifications('process.changed')
          .find((change) => change.process?.source.kind === 'check' && change.process.bytes > 0)
          ?.process,
      'check output',
      WAIT_MS,
    );
    expect(proc).toMatchObject({
      id: 'v1',
      name: 'slow test',
      source: { kind: 'check', sessionId, checkId: check.id, trigger: 'manual' },
      status: 'running',
      stopSignals: ['SIGTERM'],
    });
    expect((await h.client.request('process.output', { processId: 'v1' })).text).toContain(
      'starting',
    );
    await h.client.request('process.stop', { processId: 'v1' });
    const run = await h.client.until(
      () =>
        h.client
          .events(subscriptionId)
          .flatMap((event: WevirEvent) =>
            event.type === 'verification.updated' ? [event.payload.run] : [],
          )
          .find((item) => item.status === 'cancelled'),
      'cancelled run',
      WAIT_MS,
    );
    expect(run).toMatchObject({ id: proc.source.runId, reason: 'user' });
    const [after] = (await h.client.request('process.list', { sessionId })).processes;
    expect(after).toMatchObject({ id: 'v1', status: 'exited', stoppedBy: 'user' });
    // 跑完之后输出照样读得到（原始日志留着）。
    expect((await readAll(h.client, 'v1')).text).toContain('tick');
  }, 30_000);
});
