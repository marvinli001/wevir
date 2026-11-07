import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageUsage } from '../shared/storage.js';
import { StorageUsageReader } from './storage-reader.js';

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork } }));

class Worker extends EventEmitter {
  postMessage = vi.fn();
  kill = vi.fn(() => {
    this.emit('exit', 0);
    return true;
  });
}
let workers: Worker[];
let reader: StorageUsageReader;
const usage = (total: number): StorageUsage => ({ root: '/data', total, categories: [] });
const finish = (worker: Worker, total: number) => {
  worker.emit('spawn');
  worker.emit('message', { ok: true, usage: usage(total) });
};

beforeEach(() => {
  workers = [];
  fork.mockImplementation(() => {
    const worker = new Worker();
    workers.push(worker);
    return worker;
  });
  reader = new StorageUsageReader('/data');
});
afterEach(() => {
  reader.dispose();
  fork.mockReset();
  vi.restoreAllMocks();
});

describe('StorageUsageReader', () => {
  it('合并并发扫描，缓存30秒，完成立即停止utility process', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    const first = reader.read();
    const second = reader.read();
    expect(fork).toHaveBeenCalledTimes(1);
    finish(workers[0] as Worker, 42);
    expect((workers[0] as Worker).postMessage).toHaveBeenCalledWith('/data');
    expect(await first).toEqual(usage(42));
    expect(await second).toEqual(usage(42));
    expect((workers[0] as Worker).kill).toHaveBeenCalledOnce();
    expect(await reader.read()).toEqual(usage(42));
    expect(fork).toHaveBeenCalledTimes(1);
    now.mockReturnValue(30_001);
    const refreshed = reader.read();
    finish(workers[1] as Worker, 84);
    expect(await refreshed).toEqual(usage(84));
  });

  it('清理期间的旧扫描不缓存，清理后的读取等旧扫描结束再量一次', async () => {
    const first = reader.read();
    reader.invalidate();
    const refreshed = reader.read();
    finish(workers[0] as Worker, 42);
    await first;
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    finish(workers[1] as Worker, 21);
    expect(await refreshed).toEqual(usage(21));
    expect(await reader.read()).toEqual(usage(21));
  });

  it('扫描进程退出时报错，下次读取可重试；退出应用会停止扫描', async () => {
    const failed = reader.read();
    (workers[0] as Worker).emit('exit', 7);
    await expect(failed).rejects.toThrow('Storage scan exited with code 7');
    const retried = reader.read();
    finish(workers[1] as Worker, 42);
    expect(await retried).toEqual(usage(42));
    reader.invalidate();
    const pending = reader.read();
    reader.dispose();
    await expect(pending).rejects.toThrow('Storage scan exited');
    expect((workers[2] as Worker).kill).toHaveBeenCalledOnce();
    await expect(reader.read()).rejects.toThrow('Storage reader is closed');
  });
});
