import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { jsonResult } from './app-mcp.js';
import { useTempDir } from './test-utils.js';
import {
  countLines,
  headAndTail,
  TOOL_OUTPUT_INLINE_BYTES,
  TOOL_OUTPUT_MAX_AGE_MS,
  ToolOutputStore,
} from './tool-output.js';

const tempDir = useTempDir();
const SESSION = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId;

const lines = (count: number, prefix = 'line') =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n');

describe('ToolOutputStore.spill', () => {
  it('不超过上限的结果原样返回', async () => {
    const store = new ToolOutputStore(join(tempDir(), 'tool-output'));
    const result = {
      content: [{ type: 'text' as const, text: 'x'.repeat(TOOL_OUTPUT_INLINE_BYTES) }],
    };
    expect(await store.spill(SESSION, 'browser_snapshot', result)).toBe(result);
    expect(existsSync(store.dir)).toBe(false);
  });

  it('超过上限的文本整份写进会话目录，结果只留开头、结尾与路径；图片保留', async () => {
    const store = new ToolOutputStore(join(tempDir(), 'tool-output'));
    const text = lines(3000);
    const image = { type: 'image' as const, data: 'aGk=', mimeType: 'image/png' };
    const spilled = await store.spill(SESSION, 'browser_snapshot', {
      content: [{ type: 'text', text }, image],
    });
    const summary = spilled.content[0];
    expect(summary?.type).toBe('text');
    const body = summary?.type === 'text' ? summary.text : '';
    const path = body.split('\n')[1] as string;
    expect(path.startsWith(join(store.dir, SESSION))).toBe(true);
    expect(path).toMatch(/browser_snapshot-[0-9a-f]{6}\.txt$/);
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(body).toContain('(3000 lines)');
    expect(body).toContain('line 1\n');
    expect(body).toContain('line 3000');
    expect(body).not.toContain('line 1500\n');
    expect(Buffer.byteLength(body)).toBeLessThan(TOOL_OUTPUT_INLINE_BYTES);
    expect(spilled.content[1]).toEqual(image);
    expect(spilled.isError).toBeUndefined();
  });

  it('JSON 结果写成缩进的 JSON，去掉 structuredContent；错误结果仍是错误', async () => {
    const store = new ToolOutputStore(join(tempDir(), 'tool-output'));
    const value = {
      items: Array.from({ length: 400 }, (_, index) => ({ index, name: `item-${index}` })),
    };
    const spilled = await store.spill(SESSION, 'wevir_session_read', jsonResult(value));
    expect(spilled.structuredContent).toBeUndefined();
    const body = spilled.content[0]?.type === 'text' ? spilled.content[0].text : '';
    const path = body.split('\n')[1] as string;
    expect(path.endsWith('.json')).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(value);
    expect(readFileSync(path, 'utf8')).toContain('\n  "items": [\n');

    const error = await store.spill(SESSION, 'x', {
      content: [{ type: 'text', text: lines(2000) }],
      isError: true,
    });
    expect(error.isError).toBe(true);
  });

  it('写不进去时原样返回', async () => {
    const root = tempDir();
    writeFileSync(join(root, 'tool-output'), 'not a directory');
    const store = new ToolOutputStore(join(root, 'tool-output'));
    const result = { content: [{ type: 'text' as const, text: lines(3000) }] };
    expect(await store.spill(SESSION, 'x', result)).toBe(result);
  });
});

describe('headAndTail', () => {
  it('在行边界上截，两段不重叠时分开给', () => {
    const { head, tail } = headAndTail(lines(1000), 50, 30);
    expect(head).toBe('line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7');
    expect(tail).toBe('line 998\nline 999\nline 1000');
  });

  it('全都放得下时只给开头', () => {
    expect(headAndTail('a\nb\nc\n', 100, 100)).toEqual({ head: 'a\nb\nc', tail: '' });
  });

  it('单行超长时按字节截，不留半个字符', () => {
    const { head } = headAndTail('文'.repeat(1000), 10, 10);
    expect(head).toBe('文文文 …');
  });
});

describe('countLines 与 prune', () => {
  it('数行', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
  });

  it('删掉过期的文件和空了的会话目录', async () => {
    const store = new ToolOutputStore(join(tempDir(), 'tool-output'));
    const oldDir = join(store.dir, 'ses_old');
    const keepDir = join(store.dir, 'ses_keep');
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(keepDir, { recursive: true });
    writeFileSync(join(oldDir, 'a.txt'), 'a');
    writeFileSync(join(keepDir, 'old.txt'), 'b');
    writeFileSync(join(keepDir, 'new.txt'), 'c');
    const past = (Date.now() - TOOL_OUTPUT_MAX_AGE_MS - 60_000) / 1000;
    utimesSync(join(oldDir, 'a.txt'), past, past);
    utimesSync(join(keepDir, 'old.txt'), past, past);
    await store.prune();
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(join(keepDir, 'old.txt'))).toBe(false);
    expect(existsSync(join(keepDir, 'new.txt'))).toBe(true);
  });
});
