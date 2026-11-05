import { describe, expect, it } from 'vitest';
import { descendants, killOrphans, type ProcEntry, readLinuxProcesses } from './orphans.js';

const entry = (pid: number, ppid: number, pgid: number, start = 's'): ProcEntry => ({
  pid,
  ppid,
  pgid,
  start,
});

const table = (...entries: ProcEntry[]) => new Map(entries.map((item) => [item.pid, item]));

// Linux 上的真实形状：app-server 100 → 外层沙箱 200 → bwrap 201 → 内层沙箱 202（新会话）→ bash 203 → sleep 204；
// 300 是同一个 app-server 下与命令无关的进程。
const running = table(
  entry(1, 0, 1),
  entry(100, 1, 100),
  entry(200, 100, 200),
  entry(201, 200, 200),
  entry(202, 201, 202),
  entry(203, 202, 202),
  entry(204, 203, 202),
  entry(300, 100, 300),
);

function recorder() {
  const signals: number[] = [];
  return { signals, kill: (pid: number) => void signals.push(pid) };
}

describe('killOrphans', () => {
  it('结束 Codex 杀掉外层沙箱之后被过继出去的内层沙箱和命令，同一 app-server 下的其他进程不动', async () => {
    const before = descendants(running, 100);
    const { signals, kill } = recorder();
    const after = table(
      entry(1, 0, 1),
      entry(100, 1, 100),
      entry(202, 1, 202),
      entry(203, 202, 202),
      entry(204, 203, 202),
      entry(300, 100, 300),
    );
    const killed = await killOrphans(100, before, { read: () => after, kill, timeoutMs: 0 });
    expect(killed.sort()).toEqual([202, 203, 204]);
    expect(signals).toEqual([-202, 202, 203, 204]);
  });

  it('外层沙箱死了、bwrap 还没死时，连同 bwrap 下面的进程一起结束', async () => {
    const before = descendants(running, 100);
    const { signals, kill } = recorder();
    const after = table(
      entry(100, 1, 100),
      entry(201, 1, 200),
      entry(202, 201, 202),
      entry(203, 202, 202),
      entry(204, 203, 202),
      entry(300, 100, 300),
    );
    const killed = await killOrphans(100, before, { read: () => after, kill, timeoutMs: 0 });
    expect(killed.sort()).toEqual([201, 202, 203, 204]);
    expect(signals).not.toContain(300);
  });

  it('命令整棵树都已结束时什么都不做', async () => {
    const before = descendants(running, 100);
    const { signals, kill } = recorder();
    const after = table(entry(100, 1, 100), entry(300, 100, 300));
    expect(await killOrphans(100, before, { read: () => after, kill })).toEqual([]);
    expect(signals).toEqual([]);
  });

  it('等进程退出：先没有变化，下一轮外层沙箱死了再结束', async () => {
    const before = descendants(running, 100);
    const { kill } = recorder();
    const after = table(
      entry(100, 1, 100),
      entry(202, 1, 202),
      entry(203, 202, 202),
      entry(204, 203, 202),
    );
    const reads = [running, after];
    const killed = await killOrphans(100, before, {
      read: () => reads.shift() ?? after,
      kill,
      intervalMs: 1,
    });
    expect(killed.sort()).toEqual([202, 203, 204]);
  });

  it('超时前没有进程退出就不动；pid 被别的进程复用不算活着', async () => {
    const before = descendants(running, 100);
    const { signals, kill } = recorder();
    expect(await killOrphans(100, before, { read: () => running, kill, timeoutMs: 0 })).toEqual([]);
    const reused = table(entry(100, 1, 100), entry(202, 1, 202, 'other'), entry(300, 100, 300));
    expect(await killOrphans(100, before, { read: () => reused, kill, timeoutMs: 0 })).toEqual([]);
    expect(signals).toEqual([]);
  });
});

describe.runIf(process.platform === 'linux')('readLinuxProcesses', () => {
  it('读出本进程和它的父进程', () => {
    const processes = readLinuxProcesses();
    expect(processes.get(process.pid)).toMatchObject({ pid: process.pid, ppid: process.ppid });
    expect(processes.get(process.pid)?.start).not.toBe('');
  });
});
