import { describe, expect, it } from 'vitest';
import { fileTypeLabel, formatFileSize, sharedFilePath } from './shared-files-model';

describe('formatFileSize', () => {
  it('按 1000 进位，字节不带小数', () => {
    expect(formatFileSize(0, 'en')).toBe('0 B');
    expect(formatFileSize(999, 'en')).toBe('999 B');
    expect(formatFileSize(18_432, 'en')).toBe('18.4 KB');
    expect(formatFileSize(5_000_000, 'en')).toBe('5 MB');
    expect(formatFileSize(1_234_567_890, 'en')).toBe('1.2 GB');
  });
});

describe('fileTypeLabel', () => {
  it('扩展名大写；没有扩展名、点开头的名字没有', () => {
    expect(fileTypeLabel('周报.docx')).toBe('DOCX');
    expect(fileTypeLabel('a.tar.gz')).toBe('GZ');
    expect(fileTypeLabel('Makefile')).toBeUndefined();
    expect(fileTypeLabel('.env')).toBeUndefined();
    expect(fileTypeLabel('x.')).toBeUndefined();
  });
});

describe('sharedFilePath', () => {
  it('cwd 加相对路径，Windows 用反斜杠', () => {
    expect(sharedFilePath('/data/chats/ses_1', { path: 'out/a.md' })).toBe(
      '/data/chats/ses_1/out/a.md',
    );
    expect(sharedFilePath('/', { path: 'a.md' })).toBe('/a.md');
    expect(sharedFilePath('C:\\Users\\me\\proj', { path: 'out/a.md' })).toBe(
      'C:\\Users\\me\\proj\\out\\a.md',
    );
  });
});
