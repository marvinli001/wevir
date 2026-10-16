// 输入框的本机偏好（U35，设置 → 常规）：发送消息用 Enter 还是 ⌘ / Ctrl + Enter；输入框底栏显不显示上下文用量（`/status` 开关）。
// 只存在本机。

import { IS_MAC } from '@/lib/shortcuts';
import { createPersistedStore } from '@/lib/store';

export type SendShortcut = 'enter' | 'mod-enter';

export interface ComposerPrefs {
  /** `enter`：Enter 发送、Shift+Enter 换行（默认）；`mod-enter`：⌘ / Ctrl + Enter 发送、Enter 换行。 */
  sendShortcut: SendShortcut;
  /** 输入框底栏显示上下文用量圆环（context-meter.tsx），默认显示；`/status` 切换。 */
  showContext: boolean;
}

export const composerPrefs = createPersistedStore<ComposerPrefs>(
  'wevir.composer.v1',
  { sendShortcut: 'enter', showContext: true },
  (raw) => {
    if (raw === null || typeof raw !== 'object') return undefined;
    const value = raw as { sendShortcut?: unknown; showContext?: unknown };
    return {
      sendShortcut: value.sendShortcut === 'mod-enter' ? 'mod-enter' : 'enter',
      showContext: value.showContext !== false,
    };
  },
);

/** `/status`：开着就关，关着就开。 */
export function toggleContextMeter(): void {
  composerPrefs.set((current) => ({ ...current, showContext: !current.showContext }));
}

/** 发送键的写法（发送按钮的提示、设置与快捷键页共用）。 */
export function sendKeyLabel(shortcut: SendShortcut): string {
  if (shortcut === 'enter') return 'Enter';
  return IS_MAC ? '⌘ Enter' : 'Ctrl+Enter';
}
