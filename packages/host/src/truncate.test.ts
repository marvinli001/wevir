import {
  JSON_PREVIEW_LENGTH,
  JSON_STRING_MAX_LENGTH,
  JSON_VALUE_MAX_LENGTH,
  TOOL_OUTPUT_MAX_LENGTH,
  TruncatedJsonSchema,
} from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { truncateJson, truncateToolOutput } from './truncate.js';

const HALF = TOOL_OUTPUT_MAX_LENGTH / 2;
const EMOJI = '😀'; // 一个代理对，length 为 2

describe('truncateToolOutput', () => {
  it('不超过上限时原样返回', () => {
    const output = { text: 'x'.repeat(TOOL_OUTPUT_MAX_LENGTH), truncated: false };
    expect(truncateToolOutput(output)).toBe(output);
  });

  it('超过上限时保留首尾各一半，中间插入一行省略标记', () => {
    const text = `${'a'.repeat(HALF)}${'m'.repeat(10)}${'z'.repeat(HALF)}`;
    expect(truncateToolOutput({ text, truncated: false })).toEqual({
      text: `${'a'.repeat(HALF)}\n[… 10 chars truncated …]\n${'z'.repeat(HALF)}`,
      truncated: true,
      originalLength: TOOL_OUTPUT_MAX_LENGTH + 10,
    });
  });

  it('切点不落在代理对中间', () => {
    // 开头一半的最后一个 code unit 是代理对的前半，结尾一半的第一个 code unit 是代理对的后半。
    const text = `${'a'.repeat(HALF - 1)}${EMOJI}${'m'.repeat(10)}${EMOJI}${'z'.repeat(HALF - 1)}`;
    const result = truncateToolOutput({ text, truncated: false });
    expect(result.text).toBe(
      `${'a'.repeat(HALF - 1)}\n[… 14 chars truncated …]\n${'z'.repeat(HALF - 1)}`,
    );
    expect(result.originalLength).toBe(text.length);
  });

  it('适配器已截过时保留更大的原长', () => {
    const text = 'x'.repeat(TOOL_OUTPUT_MAX_LENGTH + 1);
    expect(truncateToolOutput({ text, truncated: true, originalLength: 10_000_000 })).toMatchObject(
      {
        truncated: true,
        originalLength: 10_000_000,
      },
    );
  });
});

describe('truncateJson', () => {
  it('没有超长内容时返回原值本身', () => {
    const value = { file_path: 'a.txt', list: [1, 'b', null, { deep: true }] };
    expect(truncateJson(value)).toBe(value);
    expect(truncateJson('short')).toBe('short');
    expect(truncateJson(42)).toBe(42);
    expect(truncateJson(null)).toBe(null);
  });

  it('逐个截断超长字符串（含数组和嵌套对象里的），其他字段不变，原值不被修改', () => {
    const long = 'y'.repeat(JSON_STRING_MAX_LENGTH + 3);
    const value = { file_path: 'a.txt', content: long, nested: { list: ['ok', long] } };
    const kept = `${'y'.repeat(JSON_STRING_MAX_LENGTH)}…[+3 chars]`;
    expect(truncateJson(value)).toEqual({
      file_path: 'a.txt',
      content: kept,
      nested: { list: ['ok', kept] },
    });
    expect(value.content).toBe(long);
  });

  it('字符串的切点不落在代理对中间', () => {
    const value = `${'y'.repeat(JSON_STRING_MAX_LENGTH - 1)}${EMOJI}tail`;
    expect(truncateJson(value)).toBe(`${'y'.repeat(JSON_STRING_MAX_LENGTH - 1)}…[+6 chars]`);
  });

  it('字符串截断后整体仍超过上限时换成 TruncatedJson，预览取原 JSON 文本开头', () => {
    const count = Math.ceil(JSON_VALUE_MAX_LENGTH / JSON_STRING_MAX_LENGTH) + 1;
    const value = Array.from({ length: count }, (_, i) =>
      `${i}`.padEnd(JSON_STRING_MAX_LENGTH + 10, 'q'),
    );
    const original = JSON.stringify(value);
    const result = truncateJson(value);
    expect(TruncatedJsonSchema.parse(result)).toEqual({
      $truncated: true,
      originalLength: original.length,
      preview: original.slice(0, JSON_PREVIEW_LENGTH),
    });
  });

  it('`__proto__` 键只作为普通属性保留', () => {
    const value = JSON.parse(
      `{"__proto__":{"polluted":"${'p'.repeat(JSON_STRING_MAX_LENGTH + 1)}"}}`,
    );
    const result = truncateJson(value) as Record<string, unknown>;
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
