// “压缩上下文”的入口给会话侧栏用：会话侧栏挂在工作台布局里，不在 SessionView 下面，SessionView 把它算好的 onCompact（同输入框
// 的用量表、`/compact`）按会话登记在这里，侧栏的“上下文”卡片按会话取。只在进程内存里。

import { useEffect } from 'react';
import { createStore } from '@/lib/store';

interface Entry {
  run: () => void;
  /** 登记它的那个视图（同一个会话可能同时开在主窗格与旁边的窗格里）。 */
  owner: symbol;
}

const actions = createStore<ReadonlyMap<string, Entry>>(new Map());

/** SessionView 调用：`run` 为 undefined（Host 或引擎不会压缩、会话只读）时不登记；卸载时只撤掉自己登记的。 */
export function useRegisterCompact(sessionId: string, run: (() => void) | undefined): void {
  useEffect(() => {
    if (run === undefined) return;
    const owner = Symbol(sessionId);
    actions.set((current) => new Map(current).set(sessionId, { run, owner }));
    return () =>
      actions.set((current) => {
        if (current.get(sessionId)?.owner !== owner) return current;
        const next = new Map(current);
        next.delete(sessionId);
        return next;
      });
  }, [sessionId, run]);
}

export function useCompactAction(sessionId: string): (() => void) | undefined {
  return actions.use().get(sessionId)?.run;
}
