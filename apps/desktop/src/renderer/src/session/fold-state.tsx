// 消息流里展开 / 收起的本地界面状态（U2）。只记用户点过的（没点过的按默认：工作组收起、正常完成的回合收起、出错的
// 回合展开），按会话放在进程内，不经 Host、不跨窗口：流式更新、断线重连后从头回放（订阅 reset）、切走会话再回来、
// 分段渲染把一段挪出去再挪回来，组件重新挂上都还是用户点过的样子。key 用投影里稳定的 ID：回合是 `turn:<回合 ID>`，
// 工作组与逐条的一行是部件 key（tool-model.ts）。

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';

/** 保留展开状态的会话数，超出时丢掉最久没用的。 */
const KEEP_SESSIONS = 32;

const sessions = new Map<string, Map<string, boolean>>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function store(sessionId: string, entries: ReadonlyArray<readonly [string, boolean]>): void {
  const map = sessions.get(sessionId) ?? new Map<string, boolean>();
  sessions.delete(sessionId);
  sessions.set(sessionId, map);
  for (const id of sessions.keys()) {
    if (sessions.size <= KEEP_SESSIONS) break;
    sessions.delete(id);
  }
  for (const [key, open] of entries) map.set(key, open);
  for (const listener of listeners) listener();
}

interface FoldScope {
  sessionId: string;
  /** 用户点开或收起了一处：消息流保持当前位置，不被拉回底部（scroll-controller.ts 的 holdPosition）。 */
  onToggle(): void;
}

const FoldContext = createContext<FoldScope | undefined>(undefined);

export function FoldScopeProvider({
  sessionId,
  onToggle,
  children,
}: FoldScope & { children: ReactNode }) {
  const scope = useMemo(() => ({ sessionId, onToggle }), [sessionId, onToggle]);
  return <FoldContext value={scope}>{children}</FoldContext>;
}

/**
 * 一处可展开内容的状态：用户点过就用点过的，否则用 `defaultOpen`（默认值可以随内容变，例如回合结束后变成收起）。
 * `setOpen` 记下用户的选择。
 */
/** 消息流属于哪个会话（U23：建议的任务卡片要知道是谁提出的）；不在消息流里时 undefined。 */
export function useTranscriptSessionId(): string | undefined {
  return useContext(FoldContext)?.sessionId;
}

export function useFold(key: string, defaultOpen: boolean): [boolean, (open: boolean) => void] {
  const setFolds = useFoldSetter();
  const sessionId = useContext(FoldContext)?.sessionId ?? '';
  const stored = useSyncExternalStore(subscribe, () => sessions.get(sessionId)?.get(key));
  const setOpen = useCallback((open: boolean) => setFolds([key], open), [setFolds, key]);
  return [stored ?? defaultOpen, setOpen];
}

/** 一次设置多处（“N 个文件已更改”同时展开回合与其中有修改的组）。 */
export function useFoldSetter(): (keys: readonly string[], open: boolean) => void {
  const scope = useContext(FoldContext);
  return useCallback(
    (keys, open) => {
      if (!scope) return;
      scope.onToggle();
      store(
        scope.sessionId,
        keys.map((key) => [key, open] as const),
      );
    },
    [scope],
  );
}
