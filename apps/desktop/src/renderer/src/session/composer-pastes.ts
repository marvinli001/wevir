import type { UserTextPart } from '@wevir/protocol';
import { t } from '@/i18n';

// 粘贴的大段文字（0.89.0，照 Claude Code）：输入框里只放一个占位符，原文记在这里；发出去时占位符换成单独一段、标 `pasted` 的文本，
// Host 交给模型时包进 `<pasted_content>`，模型据此分清哪些是用户自己写的。占位符被改动或删掉时就当作普通文字（或不发）。
// 登记表只在内存里，按占位符找，同一次运行里占位符的编号不重复；翻历史、切会话再切回来都还能展开。

/** 不少于这么多字符，或不少于这么多行的粘贴，才换成占位符。 */
export const PASTE_MIN_LENGTH = 800;
export const PASTE_MIN_LINES = 10;

const pastes = new Map<string, string>();
let counter = 0;

export function lineCount(text: string): number {
  return text.split(/\r\n|\r|\n/).length;
}

/** 这段粘贴要不要换成占位符。 */
export function isLargePaste(text: string): boolean {
  return text.length >= PASTE_MIN_LENGTH || lineCount(text) >= PASTE_MIN_LINES;
}

/** 记下一段粘贴，返回放进输入框的占位符。 */
export function registerPaste(text: string): string {
  counter += 1;
  const token = `[${t('composer.pastedText', { n: counter, lines: lineCount(text) })}]`;
  pastes.set(token, text);
  return token;
}

/** 文字里出现的占位符，按出现的先后。 */
function tokensIn(text: string): Array<{ at: number; token: string }> {
  const found: Array<{ at: number; token: string }> = [];
  for (const token of pastes.keys()) {
    for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + token.length)) {
      found.push({ at, token });
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

/**
 * 发出去的文本段：占位符换成标 `pasted` 的一段原文，前后用户自己写的各成一段（去掉首尾空白，空的不要）。没有占位符时就是
 * 原样的一段。
 */
export function textParts(text: string): UserTextPart[] {
  const found = tokensIn(text);
  if (found.length === 0) return text === '' ? [] : [{ type: 'text', text }];
  const parts: UserTextPart[] = [];
  const own = (value: string) => {
    const trimmed = value.trim();
    if (trimmed !== '') parts.push({ type: 'text', text: trimmed });
  };
  let from = 0;
  for (const { at, token } of found) {
    if (at < from) continue;
    own(text.slice(from, at));
    parts.push({ type: 'text', text: pastes.get(token) ?? token, pasted: true });
    from = at + token.length;
  }
  own(text.slice(from));
  return parts;
}

/** 占位符换回原文（目标、支线提问这类只收一段文字的地方）。 */
export function expandPastes(text: string): string {
  let out = text;
  for (const { token } of tokensIn(text)) out = out.replaceAll(token, pastes.get(token) ?? token);
  return out;
}
