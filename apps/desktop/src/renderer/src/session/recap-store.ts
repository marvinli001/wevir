// 离开后回顾（0.54.0，desktop-tokens §61）的状态与时机：离开登记和各会话的摘要都只放在进程内存里（刷新窗口就没了，不落盘），
// 逻辑在 recap-model.ts。SessionView 经 useSessionRecap 接入：会话在主窗格里显示期间监听窗口的失焦与回到前台，会话卸载（切走）
// 算离开，回来时离开够久就向 Host 要摘要（`session.recap`），失败静默。

import type { WevirClient } from '@wevir/client-sdk';
import type { SessionId, SessionState } from '@wevir/protocol';
import { useEffect, useRef } from 'react';
import { createStore } from '@/lib/store';
import {
  type AwayMap,
  clearRecap,
  dismissRecap,
  isActiveState,
  markLeft,
  markReturned,
  type RecapMap,
  receiveRecap,
  visibleRecap,
} from './recap-model';

const aways = createStore<AwayMap>({});
const recaps = createStore<RecapMap>({});
/** 正在向 Host 要摘要的会话：同一个会话不并发要两次。 */
const asking = new Set<string>();

/** 窗口在前台、有键盘焦点：用户看得到这个会话。 */
function windowFocused(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function dismiss(sessionId: string): void {
  recaps.set((current) => dismissRecap(current, sessionId));
}

/** 回来：清掉这一段离开，离开够久就向 Host 要摘要。 */
function comeBack(
  client: WevirClient,
  sessionId: SessionId,
  currentState: () => SessionState | undefined,
): void {
  const returned = markReturned(aways.get(), sessionId, Date.now());
  aways.set(returned.map);
  const { request } = returned;
  if (request === undefined || asking.has(sessionId)) return;
  // 新的一段离开：上一段的摘要不再算数。
  recaps.set((current) => clearRecap(current, sessionId));
  asking.add(sessionId);
  client
    .request('session.recap', { sessionId, ...request })
    .then((result) => {
      const { recap } = result;
      if (recap === undefined) return;
      recaps.set((current) => receiveRecap(current, sessionId, recap, currentState()));
    })
    .catch(() => {
      // 摘要是锦上添花：失败（连接断了、会话没了）不提示。
    })
    .finally(() => asking.delete(sessionId));
}

/**
 * 接入一个会话的离开后回顾：返回现在该显示的摘要。`enabled` 为假（Host 没有功能、设置里关了、不是主窗格的顶层会话）时什么都不做。
 * `seq()` 给会话现在看到的最后一个事件，离开时记下来。
 */
export function useSessionRecap(options: {
  sessionId: SessionId;
  client: WevirClient | undefined;
  enabled: boolean;
  state: SessionState | undefined;
  seq: number;
}): { text: string; dismiss: () => void } | undefined {
  const { sessionId, client, enabled, state, seq } = options;
  const seqRef = useRef(seq);
  seqRef.current = seq;
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!enabled || client === undefined) return;
    const left = () =>
      aways.set((current) => markLeft(current, sessionId, Date.now(), seqRef.current));
    const back = () => {
      if (windowFocused()) comeBack(client, sessionId, () => stateRef.current);
    };
    const onVisibility = () => (document.visibilityState === 'hidden' ? left() : back());
    // 挂载就是回来（从别的会话切回来）；窗口没焦点时等 focus。
    back();
    window.addEventListener('blur', left);
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('blur', left);
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', onVisibility);
      left();
    };
  }, [sessionId, client, enabled]);

  // 会话开始了新的回合：摘要过时了，关掉，回合结束也不再冒出来。
  useEffect(() => {
    if (isActiveState(state)) dismiss(sessionId);
  }, [sessionId, state]);

  const map = recaps.use();
  const recap = visibleRecap(map, sessionId, state);
  return recap === undefined ? undefined : { text: recap.text, dismiss: () => dismiss(sessionId) };
}
