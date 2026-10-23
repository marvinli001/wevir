// 主进程推来的自动更新状态（ADR-0007 补记 4）：第一次用到时订阅，之后整个渲染进程共用一份。

import { useSyncExternalStore } from 'react';
import { capabilities, platformApi } from '@/platform/platform';
import type { UpdateState } from '../../../shared/desktop-api.js';

let current: UpdateState | undefined;
let started = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function start(): void {
  if (started) return;
  started = true;
  // 外壳不管应用更新（浏览器客户端）：一直是 undefined，界面不显示更新入口。
  if (!capabilities().updates) return;
  platformApi().onUpdateState((state) => {
    current = state;
    emit();
  });
  void platformApi()
    .getUpdateState()
    .then((state) => {
      // 推送可能先到：先到的更新。
      if (current === undefined) {
        current = state;
        emit();
      }
    });
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 自动更新的状态；还没从主进程读到时为 undefined。 */
export function useUpdateState(): UpdateState | undefined {
  return useSyncExternalStore(subscribe, () => current);
}
