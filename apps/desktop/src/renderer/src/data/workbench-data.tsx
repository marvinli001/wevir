import type { SessionId } from '@wevir/protocol';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { useHostConnection } from '@/host/host-connection';
import { TranscriptCache, type TranscriptState } from './transcript-store';
import type { WorkbenchData } from './workbench-model';
import { LIST_REFRESH_MS, WorkbenchStore } from './workbench-store';

interface Stores {
  workbench: WorkbenchStore;
  transcripts: TranscriptCache;
}

const StoresContext = createContext<Stores | undefined>(undefined);

const LOADING: WorkbenchData = { status: 'loading' };
const noop = () => () => {};

/**
 * 工作区与会话列表（workbench-store.ts）。每次连上 Host（含重连）、每 10 s、窗口获得焦点时重读列表；
 * 已知会话的变化经事件订阅实时到达。
 */
export function WorkbenchDataProvider({ children }: { children: ReactNode }) {
  const { view, client } = useHostConnection();
  const [stores, setStores] = useState<Stores>();
  const store = stores?.workbench;
  // 每次连上（含重连）hello 都是新对象，据此重新读取。
  const hello = view.status === 'connected' ? view.hello : undefined;

  useEffect(() => {
    if (!client) return;
    const created = {
      workbench: new WorkbenchStore(client),
      transcripts: new TranscriptCache(client),
    };
    setStores(created);
    return () => {
      created.workbench.dispose();
      created.transcripts.dispose();
    };
  }, [client]);

  useEffect(() => {
    if (!store || !hello) return;
    void store.refresh();
    const timer = window.setInterval(() => void store.refresh(), LIST_REFRESH_MS);
    const onFocus = () => void store.refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [store, hello]);

  return <StoresContext value={stores}>{children}</StoresContext>;
}

export function useWorkbenchData(): WorkbenchData {
  const store = useContext(StoresContext)?.workbench;
  return useSyncExternalStore(store?.subscribe ?? noop, store?.get ?? (() => LOADING));
}

/** 列表的写入口（新建会话后立即放进列表等）；还没连上 Host 时为 undefined。 */
export function useWorkbenchStore(): WorkbenchStore | undefined {
  return useContext(StoresContext)?.workbench;
}

const NO_TRANSCRIPT = () => undefined;

/**
 * 一个会话的消息投影（transcript-store.ts），按帧更新；还没连上 Host、或没有给会话（草稿页的窗格、置顶摘要）时为
 * undefined。
 */
export function useTranscript(sessionId: SessionId | undefined): TranscriptState | undefined {
  const cache = useContext(StoresContext)?.transcripts;
  const store = useMemo(
    () => (sessionId === undefined ? undefined : cache?.get(sessionId)),
    [cache, sessionId],
  );
  return useSyncExternalStore(store?.subscribe ?? noop, store?.get ?? NO_TRANSCRIPT);
}
