import { describe, expect, it } from 'vitest';
import { captureRange, locate, splitLines } from './anchor.js';

const FILE = [
  'import x',
  '',
  'function a() {',
  '  return 1;',
  '}',
  '',
  'function b() {',
  '  return 2;',
  '}',
];

describe('splitLines', () => {
  it('去掉行尾的 \\r，结尾的换行不多出空行', () => {
    expect(splitLines('a\r\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
    expect(splitLines('')).toEqual([]);
  });
});

describe('captureRange', () => {
  it('取出几行与前后两行上下文；超出文件时没有', () => {
    expect(captureRange(FILE, 4, 5)).toEqual({
      snippet: '  return 1;\n}',
      contextBefore: '\nfunction a() {',
      contextAfter: '\nfunction b() {',
    });
    expect(captureRange(FILE, 1, 1)?.contextBefore).toBe('');
    expect(captureRange(FILE, 9, 10)).toBeUndefined();
    expect(captureRange(FILE, 3, 2)).toBeUndefined();
  });
});

describe('locate', () => {
  const target = {
    startLine: 4,
    endLine: 4,
    ...(captureRange(FILE, 4, 4) as NonNullable<ReturnType<typeof captureRange>>),
  };

  it('原来的行没变是 current', () => {
    expect(locate(FILE, target)).toEqual({ state: 'current', startLine: 4, endLine: 4 });
  });

  it('上面插了行，按原文找到新位置', () => {
    const moved = ['// header', '// more', ...FILE];
    expect(locate(moved, target)).toEqual({ state: 'relocated', startLine: 6, endLine: 6 });
  });

  it('原文被改掉是 outdated（changed），不指向别的行', () => {
    const edited = FILE.map((line) => (line === '  return 1;' ? '  return 10;' : line));
    expect(locate(edited, target)).toEqual({ state: 'outdated', reason: 'changed' });
  });

  it('重复的片段靠上下文区分；上下文也分不出是 outdated（ambiguous）', () => {
    const brace = {
      startLine: 5,
      endLine: 5,
      ...(captureRange(FILE, 5, 5) as NonNullable<ReturnType<typeof captureRange>>),
    };
    expect(locate(FILE, brace)).toEqual({ state: 'current', startLine: 5, endLine: 5 });
    const shifted = ['// header', ...FILE];
    expect(locate(shifted, brace)).toEqual({ state: 'relocated', startLine: 6, endLine: 6 });
    // a() 的上下文改了，两处 `}` 都对不上：宁可过期也不猜。
    const rewritten = [
      '// header',
      'import x',
      '',
      'function a() {',
      '  return 3;',
      '}',
      '',
      'function b() {',
      '  return 2;',
      '}',
    ];
    expect(locate(rewritten, brace)).toEqual({ state: 'outdated', reason: 'ambiguous' });
  });

  it('原位置的文字相同但上下文不同、另一处上下文吻合时认另一处', () => {
    const brace = {
      startLine: 9,
      endLine: 9,
      ...(captureRange(FILE, 9, 9) as NonNullable<ReturnType<typeof captureRange>>),
    };
    // 在 b() 之前插入一个新函数，原来第 9 行现在是新函数的 `}`。
    const inserted = [
      ...FILE.slice(0, 6),
      'function c() {',
      '  return 3;',
      '}',
      '',
      ...FILE.slice(6),
    ];
    expect(locate(inserted, brace)).toEqual({ state: 'relocated', startLine: 13, endLine: 13 });
  });
});
