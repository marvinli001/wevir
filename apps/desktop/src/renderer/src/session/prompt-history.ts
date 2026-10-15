// 发过的消息（U36）：输入框为空时按 ↑ 取回上一条、再按往前翻，↓ 往回（照 T3 Code 的 composerPromptHistory 与终端的习惯）。
// 所有会话共用一份，最多 50 条，只存在本机。

import { createPersistedStore } from '@/lib/store';

const LIMIT = 50;

const history = createPersistedStore<readonly string[]>('wevir.prompt-history.v1', [], (raw) =>
  Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string').slice(0, LIMIT)
    : undefined,
);

/** 记一条发出去的消息（最新的在前，与上一条相同时不重复记）。 */
export function rememberPrompt(text: string): void {
  const trimmed = text.trim();
  if (trimmed === '') return;
  history.set((current) =>
    current[0] === trimmed ? current : [trimmed, ...current].slice(0, LIMIT),
  );
}

/** 第 `index` 条（0 是最近的）；没有时 undefined。 */
export function promptAt(index: number): string | undefined {
  return history.get()[index];
}

/** 光标在第一行（↑ 取历史）；多行的消息只在第一行按 ↑ 时才翻。 */
export function caretOnFirstLine(text: string, caret: number): boolean {
  return !text.slice(0, caret).includes('\n');
}

/** 光标在最后一行（↓ 往回翻）。 */
export function caretOnLastLine(text: string, caret: number): boolean {
  return !text.slice(caret).includes('\n');
}
