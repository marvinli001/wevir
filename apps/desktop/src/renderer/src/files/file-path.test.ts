import { describe, expect, it } from 'vitest';
import {
  fileLinkPaths,
  isMarkdownPath,
  parseFileHref,
  resolveRelativeTo,
  toAbsolutePath,
  toRelativePath,
} from './file-path';

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

describe('resolveRelativeTo', () => {
  it('按文件所在的目录解析，不许走出会话目录', () => {
    expect(resolveRelativeTo('docs/guide.md', './img/a.png', '/w')).toBe('docs/img/a.png');
    expect(resolveRelativeTo('docs/guide.md', '../logo%20big.png?raw=1#x', '/w')).toBe(
      'logo big.png',
    );
    expect(resolveRelativeTo('README.md', '/w/assets/a.png', '/w')).toBe('assets/a.png');
    expect(resolveRelativeTo('README.md', '/elsewhere/a.png', '/w')).toBeUndefined();
    expect(resolveRelativeTo('README.md', '../outside.png', '/w')).toBeUndefined();
    expect(resolveRelativeTo('README.md', 'https://example.com/a.png', '/w')).toBeUndefined();
    expect(resolveRelativeTo('README.md', 'data:image/png;base64,AA', '/w')).toBeUndefined();
  });
});

describe('fileLinkPaths', () => {
  it('目录里的链接：完整路径、相对路径、名称与行号', () => {
    expect(fileLinkPaths('src/a.ts:12', '/w')).toEqual({
      absolute: '/w/src/a.ts',
      relative: 'src/a.ts',
      name: 'a.ts',
      line: 12,
    });
    expect(fileLinkPaths('/w/docs/', '/w')).toEqual({
      absolute: '/w/docs/',
      relative: 'docs',
      name: 'docs',
    });
  });

  it('目录外的绝对路径没有相对路径；往上走、没有会话目录时没有完整路径', () => {
    expect(fileLinkPaths('/etc/hosts', '/w')).toEqual({ absolute: '/etc/hosts', name: 'hosts' });
    expect(fileLinkPaths('../x.ts', '/w')).toEqual({ name: 'x.ts' });
    expect(fileLinkPaths('a.ts', '')).toEqual({ name: 'a.ts' });
    expect(fileLinkPaths('/w', '/w')).toEqual({ absolute: '/w', name: 'w' });
  });

  it('不是文件链接时 undefined', () => {
    expect(fileLinkPaths('https://example.com', '/w')).toBeUndefined();
    expect(fileLinkPaths('#top', '/w')).toBeUndefined();
  });
});
