import type { UserTextPart } from '@wevir/protocol';

export const PASTE_MIN_LENGTH = 800;
export const PASTE_MIN_LINES = 10;

export function lineCount(text: string): number {
  return text.split(/\r\n|\r|\n/).length;
}

export function isLargePaste(text: string): boolean {
  return text.length >= PASTE_MIN_LENGTH || lineCount(text) >= PASTE_MIN_LINES;
}

export function pastePreview(text: string, max = 80): string {
  return text
    .slice(0, max * 4)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

interface PasteBlock {
  key: string;
  text: string;
}
const pending = new Map<string, WeakRef<PasteBlock>>();
const collected = new FinalizationRegistry<string>((key) => {
  if (!pending.get(key)?.deref()) pending.delete(key);
});

// 发送回调也用于 /goal 和建项目后的延迟发送。标记只在传递本次输入期间解析，不持有历史粘贴的正文。
export function withDraftPastes(blocks: readonly PasteBlock[], text: string): string {
  if (!blocks.length) return text;
  const tokens = blocks.map((block) => {
    if (pending.get(block.key)?.deref() !== block) {
      pending.set(block.key, new WeakRef(block));
      collected.register(block, block.key);
    }
    return `\u2063[wevir-paste:${block.key}]\u2063`;
  });
  return [...tokens, ...(text ? [text] : [])].join('\n');
}

export function textParts(text: string): UserTextPart[] {
  const parts: UserTextPart[] = [];
  let start = 0;
  for (const match of text.matchAll(/\u2063\[wevir-paste:([a-zA-Z0-9-]+)\]\u2063/g)) {
    const block = pending.get(match[1] ?? '')?.deref();
    if (!block) continue;
    const own = text.slice(start, match.index).trim();
    if (own) parts.push({ type: 'text', text: own });
    parts.push({ type: 'text', text: block.text, pasted: true });
    start = match.index + match[0].length;
  }
  if (!parts.length) return text ? [{ type: 'text', text }] : [];
  const tail = text.slice(start).trim();
  if (tail) parts.push({ type: 'text', text: tail });
  return parts;
}

export function expandPastes(text: string): string {
  return text.replace(
    /\u2063\[wevir-paste:([a-zA-Z0-9-]+)\]\u2063/g,
    (match: string, key: string) => pending.get(key)?.deref()?.text ?? match,
  );
}
