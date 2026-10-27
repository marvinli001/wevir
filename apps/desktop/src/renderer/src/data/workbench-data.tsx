import type { AccountState, ProviderProfile, Session, SessionId } from '@wevir/protocol';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useHostConnection } from '@/host/host-connection';
import { AccountsStore } from './accounts-store';
import { type SessionActivity, SessionActivityTracker } from './session-activity';
import { TranscriptCache, type TranscriptState } from './transcript-store';
import { type RouteTarget, resolveRoute, type WorkbenchData } from './workbench-model';
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

/**
 * 整份工作区与会话列表：任何会话的状态、标题等一变就重渲染。只要其中一部分时用下面挑选的 hook（`useSession`、`useRouteTarget`、
 * `useWorkbenchProviders` 等），会话页、顶栏这些常驻的组件不跟着别的会话重渲染。
 */
export function useWorkbenchData(): WorkbenchData {
  const store = useContext(StoresContext)?.workbench;
  return useSyncExternalStore(store?.subscribe ?? noop, store?.get ?? (() => LOADING));
}

/**
 * 从列表里挑一部分：列表换了时重新挑，结果与上一次 `isEqual` 就沿用上一次的值，组件只在挑出来的部分变了时重渲染。`select` 可以
 * 每次渲染新建（参数变了照样重挑）。
 */
export function useWorkbenchSelector<T>(
  select: (data: WorkbenchData) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const store = useContext(StoresContext)?.workbench;
  const last = useRef<{ data: WorkbenchData; select: (data: WorkbenchData) => T; value: T }>(
    undefined,
  );
  const getSnapshot = () => {
    const data = store?.get() ?? LOADING;
    const previous = last.current;
    if (previous?.data === data && previous.select === select) return previous.value;
    const picked = select(data);
    const value =
      previous !== undefined && isEqual(previous.value, picked) ? previous.value : picked;
    last.current = { data, select, value };
    return value;
  };
  return useSyncExternalStore(store?.subscribe ?? noop, getSnapshot);
}

/**
 * 只要 Provider 列表时用它（列表读到以前为 undefined）：Provider 列表只在重读时换，订阅它的组件不随会话的变化重渲染。
 */
export function useWorkbenchProviders(): readonly ProviderProfile[] | undefined {
  return useWorkbenchSelector(selectProviders);
}

function selectProviders(data: WorkbenchData): readonly ProviderProfile[] | undefined {
  return data.status === 'ready' ? data.providers : undefined;
}

/** 列表里的一个会话；还没读到或不在列表里时 undefined。只随这个会话变化重渲染。 */
export function useSession(id: SessionId | undefined): Session | undefined {
  return useWorkbenchSelector((data) => findSessionIn(data, id));
}

function findSessionIn(data: WorkbenchData, id: SessionId | undefined): Session | undefined {
  if (id === undefined || data.status !== 'ready') return undefined;
  for (const entry of data.workspaces) {
    const session = entry.sessions.find((candidate) => candidate.id === id);
    if (session) return session;
  }
  return undefined;
}

/**
 * 按 URL 里的 ID 找工作区与会话（`resolveRoute`）；`workspaceId` 为 undefined 时 undefined。工作区条目与会话都没换时沿用上一次的
 * 结果，只随这个工作区里的会话变化重渲染。
 */
export function useRouteTarget(
  workspaceId: string | undefined,
  sessionId: string | undefined,
): RouteTarget | undefined {
  return useWorkbenchSelector(
    (data) => (workspaceId === undefined ? undefined : resolveRoute(data, workspaceId, sessionId)),
    sameTarget,
  );
}

function sameTarget(a: RouteTarget | undefined, b: RouteTarget | undefined): boolean {
  if (a === undefined || b === undefined || a.kind !== b.kind) return a === b;
  const fields = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const field of fields)
    if (a[field as keyof typeof a] !== b[field as keyof typeof b]) return false;
  return true;
}

/**
 * 按 ID 查会话标题的函数，查的是调用时的列表：引用不变，放进 effect 的依赖不会让 effect 随列表变化重跑，调用它的组件也不订阅
 * 列表。
 */
export function useSessionTitleOf(): (id: SessionId) => string | undefined {
  const store = useContext(StoresContext)?.workbench;
  return useCallback(
    (id: SessionId) => (store ? findSessionIn(store.get(), id)?.title : undefined),
    [store],
  );
}

const SESSIONS_BY_ID = new WeakMap<WorkbenchData, ReadonlyMap<SessionId, Session>>();
const NO_SESSIONS: ReadonlyMap<SessionId, Session> = new Map();

/** 列表里全部会话按 ID 查；列表换了才重建，同一份列表的多个调用方共用一张表。 */
export function useSessionsById(): ReadonlyMap<SessionId, Session> {
  return useWorkbenchSelector(sessionsById);
}

function sessionsById(data: WorkbenchData): ReadonlyMap<SessionId, Session> {
  if (data.status !== 'ready') return NO_SESSIONS;
  let map = SESSIONS_BY_ID.get(data);
  if (!map) {
    const built = new Map<SessionId, Session>();
    for (const entry of data.workspaces)
      for (const session of entry.sessions) built.set(session.id, session);
    map = built;
    SESSIONS_BY_ID.set(data, map);
  }
  return map;
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
