import { fileURLToPath } from 'node:url';
import { type UtilityProcess, utilityProcess } from 'electron';
import type { StorageUsage } from '../shared/storage.js';

const CACHE_TTL_MS = 30_000;

export type StorageScanResult = { ok: true; usage: StorageUsage } | { ok: false; error: string };

/** 扫描只在临时 utility process 中运行，主进程缓存结果与合并并发读取。 */
export class StorageUsageReader {
  #cached: { usage: StorageUsage; at: number } | undefined;
  #pending: { generation: number; result: Promise<StorageUsage> } | undefined;
  #worker: UtilityProcess | undefined;
  #generation = 0;
  #disposed = false;

  constructor(private readonly home: string) {}

  async read(): Promise<StorageUsage> {
    if (this.#disposed) throw new Error('Storage reader is closed');
    if (this.#cached && Date.now() - this.#cached.at < CACHE_TTL_MS) return this.#cached.usage;
    const pending = this.#pending;
    if (pending) {
      const usage = await pending.result;
      return pending.generation === this.#generation ? usage : this.read();
    }
    const generation = this.#generation;
    const result = this.#scan();
    this.#pending = { generation, result };
    try {
      const usage = await result;
      if (generation === this.#generation && !this.#disposed) {
        this.#cached = { usage, at: Date.now() };
      }
      return usage;
    } finally {
      this.#pending = undefined;
    }
  }

  invalidate(): void {
    this.#generation += 1;
    this.#cached = undefined;
  }

  dispose(): void {
    this.#disposed = true;
    this.#cached = undefined;
    this.#worker?.kill();
  }

  #scan(): Promise<StorageUsage> {
    return new Promise((resolve, reject) => {
      const worker = utilityProcess.fork(
        fileURLToPath(new URL('./storage-worker.js', import.meta.url)),
        [],
        { stdio: 'ignore', serviceName: 'Wevir Storage' },
      );
      this.#worker = worker;
      worker.once('spawn', () => worker.postMessage(this.home));
      worker.once('message', (message: StorageScanResult) => {
        if (this.#disposed) reject(new Error('Storage reader is closed'));
        else if (message.ok) resolve(message.usage);
        else reject(new Error(message.error));
        worker.kill();
      });
      worker.once('exit', (code) => {
        if (this.#worker === worker) this.#worker = undefined;
        reject(new Error(`Storage scan exited with code ${code}`));
      });
    });
  }
}
