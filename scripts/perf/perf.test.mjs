import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventStore } from '../../packages/host/dist/index.js';
import { openStorage } from '../../packages/storage/dist/index.js';
import { DELETE_SESSION, seedLibrary } from './fixture.mjs';
import { hostMetrics } from './metrics.mjs';
import { parseCim, parsePs, processTree, readProcesses } from './process-tree.mjs';

describe('runtime performance measurements', () => {
  it('seeds replayable archived history that can exercise session deletion', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'wevir-perf-test-'));
    try {
      const home = join(scratch, 'home');
      const fixture = await seedLibrary(home, scratch, 1);
      expect(fixture.sessions).toBe(16);
      expect((await stat(join(home, 'wevir.db'))).size).toBeGreaterThan(1024 * 1024);
      const storage = openStorage({ dataDir: home });
      const events = new EventStore({ storage });
      try {
        expect(storage.sessions.get(DELETE_SESSION).archivedAt).toBeDefined();
        expect(events.snapshot(DELETE_SESSION)).toMatchObject({
          session: { state: 'closed' },
        });
        expect(
          [...storage.events.iterate(DELETE_SESSION)].some(
            (event) => event.type === 'tool.updated',
          ),
        ).toBe(true);
      } finally {
        events.close();
        storage.close();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
  it('normalizes POSIX KiB and Windows WorkingSet bytes', () => {
    expect(parsePs(' PID PPID RSS COMM\n 42 1 2048 /Applications/Wevir Helper\n')).toEqual([
      { pid: 42, ppid: 1, rss: 2097152, name: '/Applications/Wevir Helper' },
    ]);
    expect(
      parseCim(
        '\uFEFF{"ProcessId":42,"ParentProcessId":1,"WorkingSetSize":"2097152","Name":"Wevir.exe","CommandLine":null}',
      )[0],
    ).toMatchObject({ pid: 42, ppid: 1, rss: 2097152, command: '' });
    expect(parseCim('[]')).toEqual([]);
  });

  it('includes detached Host descendants and classifies without retaining arguments', () => {
    const row = (pid, ppid, name, command = '') => ({ pid, ppid, name, command, rss: 100 });
    const tree = processTree(
      [
        row(1, 0, 'Wevir'),
        row(2, 1, 'Wevir Helper', '--type=renderer'),
        row(3, 99, 'Wevir Helper'),
        row(4, 3, 'codex-app-server'),
        row(5, 4, 'Wevir Helper', '/home/mcp/wevir-history.mjs secret-value'),
        row(6, 3, 'node', '/usr/lib/typescript/bin/tsc --lsp'),
        row(7, 3, 'powershell.exe'),
        row(8, 3, 'watchdog'),
        row(9, 99, 'unrelated'),
      ],
      { desktopPid: 1, hostPid: 3 },
    );
    expect(tree.count).toBe(8);
    expect(tree.rss).toBe(800);
    for (const total of Object.values(tree.totals)) expect(total).toEqual({ count: 1, rss: 100 });
    expect(JSON.stringify(tree)).not.toContain('secret-value');
  });

  it('reads the current platform process list and finds this process', async () => {
    const tree = processTree(await readProcesses(), { desktopPid: process.pid });
    expect(tree.processes.find((row) => row.pid === process.pid)?.rss).toBeGreaterThan(0);
  }, 35_000);

  it('observes an event loop stall and resets the sampling window', async () => {
    const metrics = hostMetrics();
    try {
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
      const end = performance.now() + 50;
      while (performance.now() < end) {
        /* Simulate synchronous SQLite work. */
      }
      expect(metrics.sample().eventLoop.timerDriftMaxMs).toBeGreaterThan(40);
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      metrics.sample();
      expect(metrics.sample()).toMatchObject({
        memory: { rss: expect.any(Number) },
        eventLoop: { count: 0, maxMs: 0 },
      });
    } finally {
      metrics.close();
    }
  });
});
