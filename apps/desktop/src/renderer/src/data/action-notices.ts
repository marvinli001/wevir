// 动作结果的提示：一条条排进窗口右下角的通知区（components/action-toasts.tsx）。菜单动作失败时用它（右键菜单与
// 行上的按钮没有对话框可以显示错误）；插件页的操作结果（装好、删掉、复制链接…）也用它，成功的几秒后自动消失。

import { createStore } from '@/lib/store';

export interface ActionNotice {
  key: number;
  tone: 'success' | 'danger';
  text: string;
  /** 已关闭、正在播离场动画，播完从列表里删掉。 */
  closing: boolean;
}

/** 同时最多显示这么多条，更早的被挤掉。 */
export const MAX_ACTION_NOTICES = 3;

/** 离场动画（components/toast.tsx 的 duration-150）播完再删，多留一点余量。 */
const EXIT_MS = 200;

export const actionNotices = createStore<readonly ActionNotice[]>([]);

let nextKey = 1;

function report(tone: ActionNotice['tone'], text: string): void {
  actionNotices.set((current) =>
    [...current, { key: nextKey++, tone, text, closing: false }].slice(-MAX_ACTION_NOTICES),
  );
}

/** 报告一个动作失败：`text` 是写好的整句（“归档失败：…”）。 */
export function reportActionFailure(text: string): void {
  report('danger', text);
}

/** 报告一个动作做完了（“已复制链接”）。 */
export function reportActionSuccess(text: string): void {
  report('success', text);
}

export function dismissActionNotice(key: number): void {
  actionNotices.set((current) =>
    current.map((notice) => (notice.key === key ? { ...notice, closing: true } : notice)),
  );
  window.setTimeout(
    () => actionNotices.set((current) => current.filter((notice) => notice.key !== key)),
    EXIT_MS,
  );
}
