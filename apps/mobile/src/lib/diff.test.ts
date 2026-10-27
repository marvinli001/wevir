import type { DiffFile } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  columns,
  diffRowsByPath,
  displayLine,
  filePage,
  MAX_LINE_CHARS,
  noDiffReason,
  parseFilePatch,
  splitPatch,
  splitPath,
  unquote,
  widestLine,
} from './diff';

const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,4 +1,5 @@ export function main() {',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' const d = 5;',
  '@@ -20,2 +21,2 @@',
  '-old tail',
  '+new tail',
  '\\ No newline at end of file',
  'diff --git a/old name.txt b/new name.txt',
  'similarity index 90%',
  'rename from old name.txt',
  'rename to new name.txt',
  '--- a/old name.txt\t',
  '+++ b/new name.txt\t',
  '@@ -1 +1 @@',
  '-x',
  '+y',
  'diff --git a/gone.md b/gone.md',
  'deleted file mode 100644',
  '--- a/gone.md',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  'diff --git a/logo.png b/logo.png',
  'new file mode 100644',
  'Binary files /dev/null and b/logo.png differ',
  'diff --git "a/tab\\there.txt" "b/tab\\there.txt"',
  'new file mode 100644',
  '--- /dev/null',
  '+++ "b/tab\\there.txt"',
  '@@ -0,0 +1 @@',
  '+hi',
  '',
].join('\n');

describe('splitPatch', () => {
  it('finds each file by its new path, the old path for deletions', () => {
    expect(splitPatch(PATCH).map((f) => f.path)).toEqual([
      'src/app.ts',
      'new name.txt',
      'gone.md',
      'logo.png',
      'tab\there.txt',
    ]);
  });

  it('keeps each block from its diff --git line', () => {
    const [first, second] = splitPatch(PATCH);
    expect(first?.text.startsWith('diff --git a/src/app.ts')).toBe(true);
    expect(first?.text).not.toContain('old name');
    expect(second?.text.startsWith('diff --git a/old name.txt')).toBe(true);
  });

  it('returns nothing for an empty patch', () => {
    expect(splitPatch('')).toEqual([]);
    expect(diffRowsByPath(undefined).size).toBe(0);
  });
});

describe('parseFilePatch', () => {
  it('numbers both sides and keeps hunk headers and notes', () => {
    const block = splitPatch(PATCH)[0]?.text ?? '';
    expect(parseFilePatch(block)).toEqual([
      { kind: 'hunk', text: '@@ -1,4 +1,5 @@ export function main() {' },
      { kind: 'context', text: 'const a = 1;', oldLine: 1, newLine: 1 },
      { kind: 'remove', text: 'const b = 2;', oldLine: 2 },
      { kind: 'add', text: 'const b = 3;', newLine: 2 },
      { kind: 'add', text: 'const c = 4;', newLine: 3 },
      { kind: 'context', text: 'const d = 5;', oldLine: 3, newLine: 4 },
      { kind: 'hunk', text: '@@ -20,2 +21,2 @@' },
      { kind: 'remove', text: 'old tail', oldLine: 20 },
      { kind: 'add', text: 'new tail', newLine: 21 },
      { kind: 'note', text: '\\ No newline at end of file' },
    ]);
  });

  it('has no rows for a binary file', () => {
    expect(diffRowsByPath(PATCH).get('logo.png')).toEqual([]);
  });

  it('treats an empty context line inside a hunk as context', () => {
    const rows = parseFilePatch('@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n');
    expect(rows[2]).toEqual({ kind: 'context', text: '', oldLine: 2, newLine: 2 });
  });
});

describe('unquote', () => {
  it('decodes C-style escapes and octal UTF-8 bytes', () => {
    expect(unquote('"a\\"b\\\\c"')).toBe('a"b\\c');
    expect(unquote('"\\346\\226\\207.txt"')).toBe('文.txt');
    expect(unquote('plain')).toBe('plain');
  });
});

function file(path: string, extra: Partial<DiffFile> = {}): DiffFile {
  return { path, status: 'modified', added: 1, removed: 1, ...extra };
}

describe('filePage', () => {
  const files = [file('a'), file('b'), file('c')];

  it('gives the neighbours for paging', () => {
    expect(filePage(files, 'a')).toEqual({ index: 0, count: 3, next: 'b' });
    expect(filePage(files, 'b')).toEqual({ index: 1, count: 3, previous: 'a', next: 'c' });
    expect(filePage(files, 'c')).toEqual({ index: 2, count: 3, previous: 'b' });
    expect(filePage(files, 'z')).toBeUndefined();
  });
});

describe('noDiffReason', () => {
  it('explains a file without a diff', () => {
    expect(noDiffReason(file('x', { binary: true }), [])).toBe('binary');
    expect(noDiffReason(file('x', { omitted: 'too_large' }), [])).toBe('too_large');
    expect(noDiffReason(file('x', { omitted: 'over_limit' }), [])).toBe('too_large');
    expect(noDiffReason(file('x'), [])).toBe('empty');
    expect(noDiffReason(file('x'), [{ kind: 'hunk', text: '@@' }])).toBeUndefined();
  });
});

describe('line width', () => {
  it('counts wide characters as two columns', () => {
    expect(columns('abc')).toBe(3);
    expect(columns('文件')).toBe(4);
    expect(widestLine(['ab', '文件x', 'abcd'])).toBe(5);
  });

  it('expands tabs and clips very long lines', () => {
    expect(displayLine('\tx')).toBe('    x');
    const long = displayLine('a'.repeat(MAX_LINE_CHARS + 50));
    expect(long.length).toBe(MAX_LINE_CHARS + 1);
    expect(long.endsWith('…')).toBe(true);
  });

  it('splits paths into name and directory', () => {
    expect(splitPath('src/lib/a.ts')).toEqual({ name: 'a.ts', dir: 'src/lib/' });
    expect(splitPath('a.ts')).toEqual({ name: 'a.ts', dir: '' });
  });
});
