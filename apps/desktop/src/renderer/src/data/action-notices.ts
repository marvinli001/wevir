// 菜单动作失败时的提示（右键菜单与行上的按钮没有对话框可以显示错误）：一条条排进窗口右下角的通知区
// （components/action-toasts.tsx）。成功的动作不提示，结果直接显示在界面上。

import { createStore } from '@/lib/store';

export interface ActionNotice {
  key: number;
  text: string;
}

/** 同时最多显示这么多条，更早的被挤掉。 */
export const MAX_ACTION_NOTICES = 3;

export const actionNotices = createStore<readonly ActionNotice[]>([]);

let nextKey = 1;

/** 报告一个动作失败：`text` 是写好的整句（“归档失败：…”）。 */
export function reportActionFailure(text: string): void {
  actionNotices.set((current) => [...current, { key: nextKey++, text }].slice(-MAX_ACTION_NOTICES));
}

export function dismissActionNotice(key: number): void {
  actionNotices.set((current) => current.filter((notice) => notice.key !== key));
}
