// 开发服务器预览（preview/service.ts）：用真实的 /bin/sh 与 node 起一个小 HTTP 服务。Windows 上跳过（命令是 POSIX shell 写的）。

import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { CheckId, ReadinessItem, SessionId, WorkspaceId } from '@wevir/protocol';
import { openStorage } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { type ProcessChange, ProcessManager } from '../processes.js';
import { useTempDir } from '../test-utils.js';
import { ToolOutputStore } from '../tool-output.js';
import { localUrlIn, normalizeLocalUrl, PreviewService, portOf } from './service.js';
import { PreviewStore } from './store.js';

const tempDir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const WS = 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR' as WorkspaceId;
const A = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQA' as SessionId;
const B = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQB' as SessionId;

/** 起一个 HTTP 服务：端口来自第一个参数，`DELAY` 毫秒后才监听，监听后打印 Vite 式的地址。 */
const SERVER = `const http = require('node:http');
const port = Number(process.argv[2]);
setTimeout(() => {
  http.createServer((q, s) => s.end('hello preview')).listen(port, '127.0.0.1', () => {
    console.log('  \\u001b[32m➜\\u001b[0m  Local:   http://localhost:' + port + '/');
  });
}, Number(process.env.DELAY || 0));
`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

function setup(readiness?: (check: { cwd: string; command: string }) => ReadinessItem[]) {
  const root = tempDir();
  const project = join(root, 'project');
  mkdirSync(join(project, 'web'), { recursive: true });
  writeFileSync(join(project, 'web', 'server.cjs'), SERVER);
  const storage = openStorage({ dataDir: join(root, 'data') });
  cleanups.push(() => storage.close());
  const now = new Date().toISOString();
  storage.workspaces.insert({
    id: WS,
    rootPath: project,
    displayName: 'demo',
    createdAt: now,
    updatedAt: now,
  });
  for (const id of [A, B]) {
    storage.sessions.insert({
      id,
      workspaceId: WS,
      cwd: project,
      engine: 'echo',
      engineSessionId: `engine-${id}`,
      providerId: 'p',
      modelId: 'm',
      title: '',
      titleSource: 'first_prompt',
      state: 'idle',
      lastSeq: 0,
      createdAt: now,
      updatedAt: now,
    });
  }
  const changes: ProcessChange[] = [];
  const processes = new ProcessManager({
    output: new ToolOutputStore(join(root, 'tool-output')),
    onNotice: () => {},
    onChange: (change) => changes.push(change),
    env: { PATH: process.env.PATH, SHELL: '/bin/sh' },
  });
  cleanups.push(() => processes.close());
  const checked: Array<{ id: CheckId; cwd: string; command: string }> = [];
  const service = new PreviewService({
    storage,
    store: new PreviewStore({}),
    processes,
    ...(readiness !== undefined && {
      readiness: {
        blockingFor: async (_workspaceId, _sessionId, check) => {
          checked.push(check);
          return readiness(check);
        },
      },
    }),
    pollMs: 50,
  });
  cleanups.push(() => service.dispose());
  const node = JSON.stringify(process.execPath);
  return { project, storage, processes, service, changes, checked, node };
}

describe('地址的认读', () => {
  it('输出里的本机地址：去掉 0.0.0.0 与 [::]，认端口', () => {
    expect(localUrlIn('  ➜  Local:   http://localhost:5173/')).toBe('http://localhost:5173/');
    expect(localUrlIn('ready - started server on 0.0.0.0:3000, url: http://0.0.0.0:3000')).toBe(
      'http://localhost:3000',
    );
    expect(localUrlIn('Network: http://192.168.1.4:5173/')).toBeUndefined();
    expect(normalizeLocalUrl('http://[::]:8080/x')).toBe('http://localhost:8080/x');
    expect(portOf('http://localhost:5173/')).toBe(5173);
    expect(portOf('https://app.test/')).toBe(443);
    expect(portOf('nope')).toBeUndefined();
  });
});

describe.runIf(process.platform !== 'win32')('PreviewService', () => {
  it('配了端口：起来后等端口能连上才算就绪；同一根目录再启动是复用', async () => {
    const h = setup();
    const port = await freePort();
    const changed: unknown[] = [];
    h.service.watch((change) => changed.push(change));
    await h.service.save(
      WS,
      {
        name: 'web',
        command: `${h.node} server.cjs ${port}`,
        cwd: 'web',
        port,
        env: { DELAY: '300' },
      },
      { addedBy: 'user' },
    );
    expect(changed).toHaveLength(1);

    const started = await h.service.start({ sessionId: A, name: 'web', startedBy: 'user' });
    expect(started.status).toBe('started');
    if (started.status !== 'started') return;
    expect(started.process.preview).toMatchObject({
      name: 'web',
      root: h.project,
      port,
      url: `http://localhost:${port}`,
      ready: false,
      startedBy: 'user',
    });
    expect(started.process.cwd).toBe(join(h.project, 'web'));
    const ready = await h.service.waitReady(A, started.process.id, 10_000);
    expect(ready.preview?.ready).toBe(true);
    expect(await (await fetch(`http://localhost:${port}`)).text()).toBe('hello preview');
    expect(
      h.changes.some((change) => 'process' in change && change.process.preview?.ready === true),
    ).toBe(true);

    // 另一个会话（同一目录）：复用，不起第二份。
    const again = await h.service.start({ sessionId: B, name: 'web', startedBy: 'agent' });
    expect(again).toMatchObject({ status: 'reused', process: { id: started.process.id } });
    expect(h.service.previews(h.project)).toHaveLength(1);
  });

  it('没配端口：从输出里认地址，再等它能连上', async () => {
    const h = setup();
    const port = await freePort();
    await h.service.save(
      WS,
      { name: 'web', command: `${h.node} web/server.cjs ${port}` },
      { addedBy: 'agent' },
    );
    const started = await h.service.start({ sessionId: A, name: 'web', startedBy: 'agent' });
    if (started.status !== 'started') throw new Error(started.status);
    expect(started.process.preview?.url).toBeUndefined();
    const ready = await h.service.waitReady(A, started.process.id, 10_000);
    expect(ready.preview).toMatchObject({ ready: true, url: `http://localhost:${port}/` });
  });

  it('端口已被别的进程占着：不启动', async () => {
    const h = setup();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const address = blocker.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await h.service.save(WS, { name: 'web', command: 'sleep 5', port }, { addedBy: 'user' });
    expect(await h.service.start({ sessionId: A, name: 'web', startedBy: 'user' })).toEqual({
      status: 'port_in_use',
      port,
      url: `http://localhost:${port}`,
    });
    expect(h.processes.listAll()).toEqual([]);
  });

  it('环境没就绪：带上阻塞项，不启动；问的是这项配置的目录与命令', async () => {
    const item: ReadinessItem = {
      id: 'dependencies:web',
      kind: 'dependencies',
      name: 'node_modules',
      path: 'web',
      ecosystem: 'node',
      status: 'missing',
      blocking: true,
      reason: 'not_installed',
      evidence: [],
    } as unknown as ReadinessItem;
    const h = setup(() => [item]);
    await h.service.save(
      WS,
      { name: 'web', command: 'pnpm run dev', cwd: 'web' },
      { addedBy: 'user' },
    );
    expect(await h.service.start({ sessionId: A, name: 'web', startedBy: 'user' })).toEqual({
      status: 'blocked',
      readiness: [item],
    });
    expect(h.checked).toEqual([{ id: 'preview', cwd: 'web', command: 'pnpm run dev' }]);
    expect(h.processes.listAll()).toEqual([]);
  });

  it('起来就退出：不算就绪，等待随即返回', async () => {
    const h = setup();
    await h.service.save(
      WS,
      { name: 'web', command: 'echo boom; exit 3', port: 1 },
      {
        addedBy: 'user',
      },
    );
    const started = await h.service.start({ sessionId: A, name: 'web', startedBy: 'user' });
    if (started.status !== 'started') throw new Error(started.status);
    const info = await h.service.waitReady(A, started.process.id, 10_000);
    expect(info).toMatchObject({ status: 'exited', exitCode: 3, preview: { ready: false } });
  });

  it('没有这项配置时是 INVALID_PARAMS', async () => {
    const h = setup();
    await expect(
      h.service.start({ sessionId: A, name: 'nope', startedBy: 'user' }),
    ).rejects.toThrow(/no run configuration/);
  });
});
