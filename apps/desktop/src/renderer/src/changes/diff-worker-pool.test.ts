import { WorkerPoolManager } from '@pierre/diffs/worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 0),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

function poolFixture(failExtra = false) {
  const workers: Array<EventTarget & { terminate: ReturnType<typeof vi.fn> }> = [];
  const pool = new WorkerPoolManager(
    {
      poolSize: 2,
      initialPoolSize: 1,
      workerInitializationTimeout: 100,
      workerFactory: () => {
        const worker = Object.assign(new EventTarget(), {
          terminate: vi.fn(),
          postMessage(request: { type: string; id: string }) {
            if (!['initialize', 'set-render-options'].includes(request.type)) return;
            queueMicrotask(() => {
              worker.dispatchEvent(
                new MessageEvent('message', {
                  data:
                    failExtra && workers.indexOf(worker) > 0
                      ? { type: 'error', id: request.id, error: 'test initialization failure' }
                      : {
                          type: 'success',
                          requestType: request.type,
                          id: request.id,
                          sentAt: Date.now(),
                        },
                }),
              );
            });
          },
        });
        workers.push(worker);
        return worker as unknown as Worker;
      },
    },
    { theme: 'github-dark', preferredHighlighter: 'shiki-wasm' },
  );
  const work = (name: string) =>
    pool.highlightFileAST(
      { __id: name, onHighlightSuccess: vi.fn(), onHighlightError: vi.fn() },
      { name: `${name}.ts`, contents: `const ${name} = 1`, cacheKey: name },
    );
  return { pool, workers, work };
}

describe('diff worker 按需扩容', () => {
  it('先建一个，任务排队时增到两个，切换主题与释放保留生命周期约束', async () => {
    const { pool, workers, work } = poolFixture();
    try {
      await pool.initialize();
      expect(workers).toHaveLength(1);
      work('a');
      work('b');
      work('c');
      await vi.waitFor(() => expect(pool.getStats().busyWorkers).toBe(2));
      expect(workers).toHaveLength(2);
      await pool.setRenderOptions({ theme: 'github-light' });
      expect(workers).toHaveLength(2);
    } finally {
      pool.terminate();
    }
    expect(workers.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
    expect(pool.getStats().totalWorkers).toBe(0);
  });

  it('第二个初始化失败时保留第一个，不持续重建失败的 worker', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { pool, workers, work } = poolFixture(true);
    try {
      await pool.initialize();
      work('a');
      work('b');
      await vi.waitFor(() => expect(log).toHaveBeenCalled());
      expect(pool.getStats().totalWorkers).toBe(1);
      work('c');
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(workers).toHaveLength(2);
      expect(workers[1]?.terminate).toHaveBeenCalledOnce();
    } finally {
      pool.terminate();
      log.mockRestore();
    }
  });
});
