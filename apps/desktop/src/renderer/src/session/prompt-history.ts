/** 光标在第一行（↑ 取历史）；多行的消息只在第一行按 ↑ 时才翻。 */
export function caretOnFirstLine(text: string, caret: number): boolean {
  return !text.slice(0, caret).includes('\n');
}

/** 光标在最后一行（↓ 往回翻）。 */
export function caretOnLastLine(text: string, caret: number): boolean {
  return !text.slice(caret).includes('\n');
}
