import type { AccountState, ProviderProfile, SessionId } from '@wevir/protocol';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { useHostConnection } from '@/host/host-connection';
import { AccountsStore } from './accounts-store';
import { type SessionActivity, SessionActivityTracker } from './session-activity';
import { TranscriptCache, type TranscriptState } from './transcript-store';
import type { WorkbenchData } from './workbench-model';
import { LIST_FALLBACK_REFRESH_MS, LIST_REFRESH_MS, WorkbenchStore } from './workbench-store';

interface Stores {
  workbench: WorkbenchStore;
  transcripts: TranscriptCache;
  accounts: AccountsStore;
  activity: SessionActivityTracker;
}

const StoresContext = createContext<Stores | undefined>(undefined);

const LOADING: WorkbenchData = { status: 'loading' };
const noop = () => () => {};

/**
 * 工作区与会话列表（workbench-store.ts）。每次连上 Host（含重连）、窗口获得焦点时重读列表，另外定时重读：Host 推送列表的
 * 变化（`session_list_push`）时每 60 s 兜底，否则每 10 s。已知会话的变化经事件订阅实时到达。
 */
export function WorkbenchDataProvider({ children }: { children: ReactNode }) {
  const { view, client } = useHostConnection();
  const [stores, setStores] = useState<Stores>();
  const store = stores?.workbench;
  // 每次连上（含重连）hello 都是新对象，据此重新读取。
  const hello = view.status === 'connected' ? view.hello : undefined;

  useEffect(() => {
    if (!client) return;
    const workbench = new WorkbenchStore(client);
    const activity = new SessionActivityTracker();
    workbench.onSessionEvent((event, session) => activity.apply(event, session));
    const created = {
      workbench,
      transcripts: new TranscriptCache(client),
      accounts: new AccountsStore(client, workbench),
      activity,
    };
    setStores(created);
    return () => {
      created.workbench.dispose();
      created.transcripts.dispose();
      created.accounts.dispose();
    };
  }, [client]);

  useEffect(() => {
    if (!store || !hello) return;
    void store.refresh();
    const interval =
      hello.features.session_list_push === true ? LIST_FALLBACK_REFRESH_MS : LIST_REFRESH_MS;
    const timer = window.setInterval(() => void store.refresh(), interval);
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

/**
 * 只要 Provider 列表时用它（列表读到以前为 undefined）：会话的每条事件都会换掉整份 WorkbenchData，Provider 列表本身只在重读时换，
 * 订阅它的组件不随事件重渲染。
 */
export function useWorkbenchProviders(): readonly ProviderProfile[] | undefined {
  const store = useContext(StoresContext)?.workbench;
  return useSyncExternalStore(store?.subscribe ?? noop, () => {
    const data = store?.get();
    return data?.status === 'ready' ? data.providers : undefined;
  });
}

/** 列表的写入口（新建会话后立即放进列表等）；还没连上 Host 时为 undefined。 */
export function useWorkbenchStore(): WorkbenchStore | undefined {
  return useContext(StoresContext)?.workbench;
}

const NO_ACCOUNTS = () => undefined;

/** ChatGPT 与订阅来源的账号（0.19.0，accounts-store.ts）；还没连上或还没读到时为 undefined。 */
export function useAccounts(): AccountState[] | undefined {
  const store = useContext(StoresContext)?.accounts;
  return useSyncExternalStore(store?.subscribe ?? noop, store?.get ?? NO_ACCOUNTS);
}

/** 账号表的写入口（本端操作的结果立即合进来）。 */
export function useAccountsStore(): AccountsStore | undefined {
  return useContext(StoresContext)?.accounts;
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

const NO_ACTIVITY = () => () => {};

/** 会话进行中的回合的当前动作（session-activity.ts）；没在跑、或还没收到这个回合的事件时 undefined。只随这个会话的动作变化重渲染。 */
export function useSessionActivity(id: SessionId): SessionActivity | undefined {
  const tracker = useContext(StoresContext)?.activity;
  const subscribe = useCallback(
    (listener: () => void) => tracker?.subscribe(id, listener) ?? NO_ACTIVITY(),
    [tracker, id],
  );
  return useSyncExternalStore(subscribe, () => tracker?.get(id));
}
