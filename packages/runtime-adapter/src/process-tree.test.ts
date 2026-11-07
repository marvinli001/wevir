import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it, vi } from 'vitest';
import { killTree } from './process-tree.js';

it.skipIf(process.platform === 'win32')('POSIX优先整个进程组，不是组长时回到子进程', () => {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const child = { pid: 12345, kill: vi.fn() } as unknown as ChildProcess;
  try {
    killTree(child, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(-12345, 'SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();
    kill.mockImplementation(() => {
      throw new Error('ESRCH');
    });
    killTree(child, 'SIGKILL');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  } finally {
    kill.mockRestore();
  }
});

it.skipIf(process.platform !== 'win32')(
  'Windows的CMD启动器与Node孙进程一起结束',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wevir-kill-tree-'));
    const script = join(dir, 'engine.cjs');
    const shim = join(dir, 'engine.cmd');
    await writeFile(
      script,
      `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000);`,
    );
    await writeFile(shim, `@echo off\r\n"${process.execPath}" "${script}"\r\n`);
    const child = spawn(shim, [], {
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let grandchild: number | undefined;
    try {
      const lines = createInterface({ input: child.stdout });
      const [line] = await once(lines, 'line');
      grandchild = Number(line);
      lines.close();
      expect(grandchild).toBeGreaterThan(0);
      const exited = once(child, 'exit');
      killTree(child, 'SIGTERM');
      await exited;
      await expect
        .poll(
          () => {
            try {
              process.kill(grandchild as number, 0);
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 5000 },
        )
        .toBe(false);
    } finally {
      killTree(child, 'SIGKILL');
      if (grandchild !== undefined) {
        try {
          process.kill(grandchild, 'SIGKILL');
        } catch {}
      }
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
  20_000,
);
