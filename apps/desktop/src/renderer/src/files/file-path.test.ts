import { describe, expect, it } from 'vitest';
import { isMarkdownPath, parseFileHref, toAbsolutePath, toRelativePath } from './file-path';

describe('parseFileHref', () => {
  it('reads paths with line suffixes and anchors', () => {
    expect(parseFileHref('src/a.ts')).toEqual({ path: 'src/a.ts' });
    expect(parseFileHref('/Users/me/p/a.ts:12')).toEqual({ path: '/Users/me/p/a.ts', line: 12 });
    expect(parseFileHref('a.ts:12:5')).toEqual({ path: 'a.ts', line: 12 });
    expect(parseFileHref('a.ts#L7')).toEqual({ path: 'a.ts', line: 7 });
    expect(parseFileHref('a.ts#L7-L9')).toEqual({ path: 'a.ts', line: 7 });
    expect(parseFileHref('file:///Users/me/a%20b.ts')).toEqual({ path: '/Users/me/a b.ts' });
    expect(parseFileHref('src/my%20file.ts')).toEqual({ path: 'src/my file.ts' });
    expect(parseFileHref('C:\\work\\a.ts:3')).toEqual({ path: 'C:\\work\\a.ts', line: 3 });
  });

  it('ignores web links, other schemes and bare anchors', () => {
    expect(parseFileHref('https://example.com/a.ts')).toBeUndefined();
    expect(parseFileHref('mailto:a@b.c')).toBeUndefined();
    expect(parseFileHref('#section')).toBeUndefined();
    expect(parseFileHref('  ')).toBeUndefined();
  });
});

describe('toRelativePath', () => {
  const cwd = '/Users/me/proj';

  it('keeps paths inside the session directory', () => {
    expect(toRelativePath('/Users/me/proj/src/a.ts', cwd)).toBe('src/a.ts');
    expect(toRelativePath('/Users/me/proj', cwd)).toBe('');
    expect(toRelativePath('./src//a.ts', cwd)).toBe('src/a.ts');
    expect(toRelativePath('src\\b.ts', cwd)).toBe('src/b.ts');
  });

  it('rejects paths outside it', () => {
    expect(toRelativePath('/Users/me/project2/a.ts', cwd)).toBeUndefined();
    expect(toRelativePath('../secret', cwd)).toBeUndefined();
    expect(toRelativePath('/etc/passwd', cwd)).toBeUndefined();
  });
});

describe('toAbsolutePath', () => {
  it('joins with the platform separator of the root', () => {
    expect(toAbsolutePath('src/a.ts', '/Users/me/proj/')).toBe('/Users/me/proj/src/a.ts');
    expect(toAbsolutePath('', '/Users/me/proj')).toBe('/Users/me/proj');
    expect(toAbsolutePath('src/a.ts', 'C:\\work')).toBe('C:\\work\\src\\a.ts');
  });
});

describe('isMarkdownPath', () => {
  it('matches markdown extensions', () => {
    expect(isMarkdownPath('README.md')).toBe(true);
    expect(isMarkdownPath('docs/a.MDX')).toBe(true);
    expect(isMarkdownPath('a.mdc')).toBe(false);
  });
});
