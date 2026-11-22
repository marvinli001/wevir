import { describe, expect, it } from 'vitest';
import {
  documentLinkHref,
  fileLinkPaths,
  folderFile,
  isMarkdownPath,
  paneFile,
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

describe('folderFile', () => {
  const folders = ['/work/extra', '/work/extra/nested', 'C:\\work\\win'];

  it('找到附加文件夹与相对路径，嵌套时取最深的', () => {
    expect(folderFile('/work/extra/docs/a.md', folders)).toEqual({
      folder: '/work/extra',
      path: 'docs/a.md',
    });
    expect(folderFile('/work/extra/nested/b.md', folders)).toEqual({
      folder: '/work/extra/nested',
      path: 'b.md',
    });
    expect(folderFile('C:\\work\\win\\c.md', folders)).toEqual({
      folder: 'C:\\work\\win',
      path: 'c.md',
    });
  });

  it('文件夹外、文件夹本身、前缀相同的兄弟目录与相对路径都不算', () => {
    expect(folderFile('/work/other/a.md', folders)).toBeUndefined();
    expect(folderFile('/work/extra', folders)).toBeUndefined();
    expect(folderFile('/work/extra-cloud/AGENTS.md', folders)).toBeUndefined();
    expect(folderFile('docs/a.md', folders)).toBeUndefined();
    expect(folderFile('/work/extra/a.md', [])).toBeUndefined();
  });
});

describe('paneFile', () => {
  const scope = { workspaceId: 'ws_a', sessionId: 'ses_a', root: '/work/main' };
  const folders = ['/work/extra'];

  it('相对路径照旧，会话目录里的绝对路径换成相对路径', () => {
    expect(paneFile(scope, 'docs/a.md', folders)).toEqual({ scope, path: 'docs/a.md' });
    expect(paneFile(scope, '/work/main/docs/a.md', folders)).toEqual({ scope, path: 'docs/a.md' });
  });

  it('附加文件夹里的绝对路径带上 folder，root 换成那个文件夹', () => {
    expect(paneFile(scope, '/work/extra/TODO.md', folders)).toEqual({
      scope: { ...scope, folder: '/work/extra', root: '/work/extra' },
      path: 'TODO.md',
    });
  });

  it('其余的绝对路径读不了', () => {
    expect(paneFile(scope, '/elsewhere/a.md', folders)).toBeUndefined();
    expect(paneFile(scope, '/work/extra/TODO.md', [])).toBeUndefined();
    expect(paneFile(scope, '/work/main', folders)).toBeUndefined();
  });
});

describe('documentLinkHref（文件窗格里 Markdown 的文件链接）', () => {
  const doc = '/project/docs/v1/README.md';

  it('相对路径按文件所在的目录解析，parseFileHref 读回同一个文件与行', () => {
    expect(documentLinkHref(doc, 'plan.md')).toBe('/project/docs/v1/plan.md');
    expect(documentLinkHref(doc, './tasks/P04.md#L12')).toBe('/project/docs/v1/tasks/P04.md#L12');
    expect(documentLinkHref(doc, '../adr/0001.md:3')).toBe('/project/docs/adr/0001.md#L3');
    expect(documentLinkHref(doc, '%E8%AE%A1%E5%88%92.md')).toBe('/project/docs/v1/计划.md');
    expect(parseFileHref(documentLinkHref(doc, '../a%23b%2525.md:7') ?? '')).toEqual({
      path: '/project/docs/a#b%25.md',
      line: 7,
    });
  });

  it('往上走出会话目录也给绝对路径，文件夹链接保留结尾的 /', () => {
    expect(documentLinkHref(doc, '../../../../other/x.md')).toBe('/other/x.md');
    expect(documentLinkHref(doc, '../')).toBe('/project/docs/');
    expect(documentLinkHref('/a.md', '..')).toBe('/');
  });

  it('绝对路径原样，Windows 的盘符不丢', () => {
    expect(documentLinkHref(doc, '/elsewhere/a.md')).toBe('/elsewhere/a.md');
    expect(documentLinkHref('C:\\work\\docs\\a.md', '..\\b.md')).toBe('C:/work/b.md');
  });

  it('不像文件路径的链接不换', () => {
    expect(documentLinkHref(doc, 'https://example.com/a.md')).toBeUndefined();
    expect(documentLinkHref(doc, '#section')).toBeUndefined();
  });
});
