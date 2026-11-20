// 输入栏上待发的照片，按草稿键（`<routeId>/<会话或助理>`）存在内存里：离开页面再回来照片还在，正在传的照片传完也落回这里。
// 文字草稿另存在本地数据库（drafts.ts）；照片只活到 App 进程结束，忘掉一台电脑时连同它的草稿一起清掉。

import type { UserImagePart } from '@wevir/protocol';
import type { ComposerAttachment } from '../components/composer';

export interface PhotoAttachment extends ComposerAttachment {
  image?: UserImagePart;
}

const EMPTY: readonly PhotoAttachment[] = [];
const store = new Map<string, readonly PhotoAttachment[]>();
const listeners = new Map<string, Set<() => void>>();

function notify(key: string) {
  for (const listener of listeners.get(key) ?? []) listener();
}

export function readAttachments(key: string): readonly PhotoAttachment[] {
  return store.get(key) ?? EMPTY;
}

export function updateAttachments(
  key: string,
  update: (current: readonly PhotoAttachment[]) => readonly PhotoAttachment[],
) {
  const next = update(readAttachments(key));
  if (next.length > 0) store.set(key, next);
  else store.delete(key);
  notify(key);
}

export function watchAttachments(key: string, listener: () => void) {
  const set = listeners.get(key) ?? new Set();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(key);
  };
}

/** 一台电脑（`routeId`）的待发照片全清掉。 */
export function forgetAttachments(scope: string) {
  for (const key of [...store.keys()])
    if (key.startsWith(`${scope}/`)) {
      store.delete(key);
      notify(key);
    }
}
