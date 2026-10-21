// 听写润色（0.92.0，prompts/dictation-polish.md）：设置 `speechPolish` 开着、听写时在某个会话里，转写出的文字交给这个会话的模型改同音字、
// 技术名词与标点（不带工具的单次生成，经 SessionManager.generateOnce）。这里是与引擎无关的部分：读提示词、组输入、检查输出。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultPromptsDir } from '../title.js';

export function loadPolishInstructions(dir: string = defaultPromptsDir()): string {
  const text = readFileSync(join(dir, 'dictation-polish.md'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\n/, '');
  if (text.includes('{{'))
    throw new Error('dictation-polish.md 里残留了 {{（prompts/README.md 模板语法）');
  return text;
}

/** 等润色的时限；超时就用原文。 */
export const POLISH_TIMEOUT_MS = 20_000;

export const POLISH_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
});

/** `<transcript>…</transcript>`，`&`、`<`、`>` 转义（这是校对的对象，不是指令）。 */
export function polishInput(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<transcript>\n${escaped}\n</transcript>`;
}

/**
 * 模型的输出 → 润色后的文字。不是 `{"text": …}`、是空的，或长度与原文差得太远（模型答了话、扩写了或丢了大半）时返回 undefined，
 * 调用方用原文。
 */
export function parsePolish(output: string, original: string): string | undefined {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(output.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const text = (value as { text?: unknown } | null)?.text;
  if (typeof text !== 'string') return undefined;
  const polished = text.trim();
  if (polished === '') return undefined;
  const before = Array.from(original.trim()).length;
  const after = Array.from(polished).length;
  if (after > before * 1.5 + 20 || after < before * 0.4) return undefined;
  return polished;
}
