import { describe, expect, it } from 'vitest';
import { canOpenExternally } from './open-path.js';

describe('canOpenExternally', () => {
  it('文档与媒体可以，可执行文件与脚本不行', () => {
    expect(canOpenExternally('/Users/me/a/Report.DOCX')).toBe(true);
    expect(canOpenExternally('C:\\work\\deck.pptx')).toBe(true);
    expect(canOpenExternally('/Users/me/a/clip.mov')).toBe(true);
    for (const path of [
      '/a/run.command',
      '/a/Tool.app',
      '/a/x.sh',
      '/a/setup.exe',
      '/a/.docx',
      '/a/noext',
    ]) {
      expect(canOpenExternally(path), path).toBe(false);
    }
  });
});
