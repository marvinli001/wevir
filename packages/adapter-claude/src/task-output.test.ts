// 前台 Bash 实时输出的读取：文件被截断重写、写得太快跳到末尾时，不留下半个字符的 U+FFFD。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tailClaudeTaskOutput } from './task-output.js';

const SESSION_ID = 'session-1';
const TASK_ID = 'b1';

const roots: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function taskFile(): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'wevir-task-output-'));
  roots.push(root);
  const tasks = join(root, 'project', SESSION_ID, 'tasks');
  mkdirSync(tasks, { recursive: true });
  return { root, file: join(tasks, `${TASK_ID}.output`) };
}

/** 跟着读一个任务的输出；`next(n)` 等到第 n 段为止。 */
function tail(root: string) {
  const chunks: string[] = [];
  const waiters = new Set<() => void>();
  const { stop } = tailClaudeTaskOutput({
    root,
    sessionId: SESSION_ID,
    taskId: TASK_ID,
    pollMs: 10,
    onChunk: (chunk) => {
      chunks.push(chunk);
      for (const waiter of waiters) waiter();
    },
  });
  stops.push(stop);
  const next = (count: number) =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; saw ${chunks.length}`)), 3000);
      const check = () => {
        if (chunks.length < count) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(chunks[count - 1] ?? '');
      };
      waiters.add(check);
      check();
    });
  return { next };
}

describe('tailClaudeTaskOutput', () => {
  it('文件被截断重写：上次没读完的半个字符不接到新内容前面', async () => {
    const { root, file } = taskFile();
    // 第一次读停在两字节的 é 中间。
    writeFileSync(file, new TextEncoder().encode('café').subarray(0, 4));
    const { next } = tail(root);
    expect(await next(1)).toBe('caf');
    writeFileSync(file, 'ok\n');
    expect(await next(2)).toBe('ok\n');
  });

  it('写得太快跳到末尾：落在多字节字符中间时跳过它，不以 U+FFFD 开头', async () => {
    const { root, file } = taskFile();
    writeFileSync(file, 'start\n');
    const { next } = tail(root);
    expect(await next(1)).toBe('start\n');
    // 跳到的位置落在两字节的 é 的第二个字节上。
    writeFileSync(file, `start\n${'é\n'.repeat(1_000_000)}end.\n`);
    const flooded = await next(2);
    expect(flooded.length).toBeLessThanOrEqual(256 * 1024 + 1);
    expect(flooded.slice(0, 3)).toBe('\n\né');
    expect(flooded.endsWith('é\nend.\n')).toBe(true);
  });
});
