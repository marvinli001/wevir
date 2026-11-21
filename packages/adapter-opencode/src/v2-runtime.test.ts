import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { OpenCodeRuntime } from './runtime.js';
import type { ServerExit } from './server.js';
import { FakeOpenCode } from './test-fixtures/fake-opencode.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('切换大版本时等待中的借用不会拿到另一代的服务器', async () => {
  const engineDir = mkdtempSync(join(tmpdir(), 'wevir-opencode-version-switch-'));
  const starting = deferred<void>();
  const ready = deferred<void>();
  let version = '1.19.3';
  const sdk = new FakeOpenCode();
  const runtime = new OpenCodeRuntime({
    engineDir,
    env: {},
    installer: null,
    sdk: async () => sdk,
    findExecutable: () => '/mock/opencode',
    probeVersion: async () => ({ ok: true, version }),
    startServer: async ({ generation }) => {
      if (generation === undefined) {
        starting.resolve();
        await ready.promise;
      }
      const exited = deferred<ServerExit>();
      return {
        url: 'http://127.0.0.1',
        password: 'fixture',
        version: generation === 2 ? '2.0.28' : '1.19.3',
        pid: generation === 2 ? 2 : 1,
        exited: exited.promise,
        stop: async () => exited.resolve({ code: 0, signal: null, stderrTail: '' }),
      };
    },
  });
  try {
    await runtime.detect();
    const previous = runtime.acquire();
    await starting.promise;
    version = '2.0.28';
    await runtime.detect();
    const current = expect(runtime.acquire()).rejects.toThrow('switch server versions');
    ready.resolve();
    const lease = await previous;
    expect(lease.server.version).toBe('1.19.3');
    await current;
    lease.release();
    await vi.waitFor(() => expect(runtime.serverPid).toBeUndefined());
    const next = await runtime.acquire();
    expect(next.client(engineDir).generation).toBe(2);
    next.release();
  } finally {
    ready.resolve();
    await runtime.dispose();
    rmSync(engineDir, { recursive: true, force: true });
  }
});
