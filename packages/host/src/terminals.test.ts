import { describe, expect, it } from 'vitest';
import { foregroundName } from './terminals.js';

describe('foregroundName', () => {
  it('去掉路径：Linux 的 node-pty 给 argv[0]，macOS 给进程名', () => {
    expect(foregroundName('/bin/bash')).toBe('bash');
    expect(foregroundName('/usr/bin/vim.basic')).toBe('vim.basic');
    expect(foregroundName('sleep')).toBe('sleep');
    expect(foregroundName('')).toBeUndefined();
    expect(foregroundName('/')).toBeUndefined();
    expect(foregroundName('x'.repeat(300))).toHaveLength(200);
  });
});
