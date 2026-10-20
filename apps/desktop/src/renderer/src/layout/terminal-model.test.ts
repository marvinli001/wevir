import { describe, expect, it } from 'vitest';
import {
  chunkInput,
  endTarget,
  placeOutput,
  terminalLabel,
  terminalPalette,
} from './terminal-model';

describe('终端窗格', () => {
  it('大段输入按上限切开，不切在代理对中间', () => {
    expect(chunkInput('')).toEqual([]);
    expect(chunkInput('ls\r')).toEqual(['ls\r']);
    expect(chunkInput('abcdef', 4)).toEqual(['abcd', 'ef']);
    const emoji = 'abc😀def';
    const chunks = chunkInput(emoji, 4);
    expect(chunks).toEqual(['abc', '😀de', 'f']);
    expect(chunks.join('')).toBe(emoji);
  });

  it('按位置接上输出：重复的丢掉，部分重复的只写新的，缺了一段要重新 attach', () => {
    expect(placeOutput(10, { offset: 0, data: 'x'.repeat(10) })).toEqual({ kind: 'skip' });
    expect(placeOutput(10, { offset: 8, data: 'abcd' })).toEqual({
      kind: 'write',
      data: 'cd',
      next: 12,
    });
    expect(placeOutput(10, { offset: 10, data: 'z' })).toEqual({
      kind: 'write',
      data: 'z',
      next: 11,
    });
    expect(placeOutput(10, { offset: 12, data: 'z' })).toEqual({ kind: 'gap' });
  });

  it('标签名、结束的对象与配色', () => {
    expect(terminalLabel({ title: '  vim a.txt ', shell: '/bin/zsh' })).toBe('vim a.txt');
    expect(terminalLabel({ title: '', shell: '/bin/zsh' })).toBe('zsh');
    expect(terminalLabel({ title: '', shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' })).toBe(
      'pwsh',
    );
    expect(endTarget('/bin/zsh')).toBe('session');
    expect(endTarget('C:\\Windows\\System32\\cmd.exe')).toBe('tree');
    const colors = { background: '#fff', foreground: '#000', selection: '#ccc' };
    expect(terminalPalette('light', colors)).toMatchObject({ background: '#fff', cursor: '#000' });
    expect(terminalPalette('dark', colors).yellow).not.toBe(
      terminalPalette('light', colors).yellow,
    );
  });
});
