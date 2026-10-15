// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/web/src/components/DiffWorkerPoolProvider.tsx
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：主题取自 theme/theme.ts；错误不用 effect 的 TaggedError，直接打到控制台；加载中的文案走 t()。
//
// Shiki 高亮的 worker 池：第一个 diff 视图挂上时建，所有视图共用，最后一个卸载 30 s 后关掉（短暂关掉窗格再打开不重建）。
// 池大小是核数的一半，限制在 2–6 个。高亮用 Shiki 的 WASM 引擎（oniguruma），CSP 为此放行 'wasm-unsafe-eval'
// （src/shared/csp.ts）。

import { useWorkerPool, WorkerPoolContext } from '@pierre/diffs/react';
import { WorkerPoolManager } from '@pierre/diffs/worker';
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { t } from '@/i18n';
import { useTheme } from '@/theme/theme';
import { type DiffThemeName, resolveDiffThemeName } from './diff-rendering';

/** 高亮用 Shiki 的 WASM 引擎（T3 的 PREFERRED_HIGHLIGHTER）。 */
export const PREFERRED_HIGHLIGHTER = 'shiki-wasm' as const;

const DIFF_WORKER_IDLE_TTL_MS = 30_000;
let sharedWorkerPool:
  | {
      readonly pool: WorkerPoolManager;
      consumers: number;
      idleTimer: ReturnType<typeof setTimeout> | undefined;
    }
  | undefined;

/** 视图提交之后才建 worker，短暂关掉窗格再打开时沿用。 */
function acquireDiffWorkerPool(themeName: DiffThemeName, poolSize: number) {
  sharedWorkerPool ??= {
    pool: new WorkerPoolManager(
      { workerFactory: () => new DiffsWorker(), poolSize, totalASTLRUCacheSize: 240 },
      {
        theme: themeName,
        preferredHighlighter: PREFERRED_HIGHLIGHTER,
        tokenizeMaxLineLength: 1_000,
        useTokenTransformer: true,
      },
    ),
    consumers: 0,
    idleTimer: undefined,
  };
  const entry = sharedWorkerPool;
  clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
  entry.consumers += 1;
  return entry;
}

function DiffWorkerThemeSync({ themeName }: { themeName: DiffThemeName }) {
  const workerPool = useWorkerPool();
  useEffect(() => {
    if (!workerPool) return;
    void (async () => {
      try {
        const current = workerPool.getDiffRenderOptions();
        if (current.theme === themeName) return;
        await workerPool.setRenderOptions({ ...current, theme: themeName });
      } catch (error) {
        console.error('[changes] diff worker theme', themeName, error);
      }
    })();
  }, [themeName, workerPool]);
  return null;
}

/** 纯文本的视图不排高亮任务，所以等池初始化完再画，免得第一次画成空白再重画。失败的池走 Pierre 的主线程高亮。 */
function DiffWorkerReady({ children }: { children?: ReactNode }) {
  const workerPool = useWorkerPool();
  const [readyPool, setReadyPool] = useState<WorkerPoolManager>();
  const ready = workerPool
    ? readyPool === workerPool || workerPool.isInitialized() || !workerPool.isWorkingPool()
    : false;

  useEffect(() => {
    if (ready || !workerPool) return;
    let mounted = true;
    const finish = () => {
      if (mounted) setReadyPool(workerPool);
    };
    void workerPool.initialize().then(finish, finish);
    return () => {
      mounted = false;
    };
  }, [ready, workerPool]);

  return ready ? (
    children
  ) : (
    <div
      role="status"
      className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-muted-foreground"
    >
      {t('changes.loadingCode')}
    </div>
  );
}

export function DiffWorkerPoolProvider({ children }: { children?: ReactNode }) {
  const { resolved } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolved);
  const workerPoolSize = useMemo(() => {
    const cores = Math.max(1, navigator.hardwareConcurrency || 4);
    return Math.max(2, Math.min(6, Math.floor(cores / 2)));
  }, []);
  const workerPool = useSyncExternalStore(
    useCallback(
      (onStoreChange: () => void) => {
        const entry = acquireDiffWorkerPool(diffThemeName, workerPoolSize);
        onStoreChange();
        return () => {
          entry.consumers -= 1;
          if (entry.consumers !== 0) return;
          entry.idleTimer = setTimeout(() => {
            entry.idleTimer = undefined;
            entry.pool.terminate();
            if (sharedWorkerPool === entry) sharedWorkerPool = undefined;
          }, DIFF_WORKER_IDLE_TTL_MS);
        };
      },
      [diffThemeName, workerPoolSize],
    ),
    () => sharedWorkerPool?.pool,
  );

  return (
    <WorkerPoolContext value={workerPool}>
      <DiffWorkerThemeSync themeName={diffThemeName} />
      <DiffWorkerReady>{children}</DiffWorkerReady>
    </WorkerPoolContext>
  );
}
