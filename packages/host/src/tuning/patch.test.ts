import { describe, expect, it } from 'vitest';
import { applyUnifiedDiff } from './patch.js';

const BEFORE = ['# AGENTS.md', '', '## Rules', '', '- Use pnpm.', '- Keep commits small.', ''].join(
  '\n',
);

describe('applyUnifiedDiff', () => {
  it('按上下文放，不看行号', () => {
    const diff = [
      '--- a/AGENTS.md',
      '+++ b/AGENTS.md',
      '@@ -40,3 +40,4 @@',
      ' ',
      ' - Use pnpm.',
      '+- Run `pnpm build` before `pnpm test`.',
      ' - Keep commits small.',
    ].join('\n');
    expect(applyUnifiedDiff(BEFORE, diff)).toBe(
      [
        '# AGENTS.md',
        '',
        '## Rules',
        '',
        '- Use pnpm.',
        '- Run `pnpm build` before `pnpm test`.',
        '- Keep commits small.',
        '',
      ].join('\n'),
    );
  });

  it('删除与替换；空上下文行写成真正的空行也认；行尾空白不同也认', () => {
    const diff = ['@@ -3,4 +3,3 @@', ' ## Rules   ', '', '-- Use pnpm.', '+- Use pnpm 12.'].join(
      '\n',
    );
    expect(applyUnifiedDiff(BEFORE, diff)).toBe(
      ['# AGENTS.md', '', '## Rules', '', '- Use pnpm 12.', '- Keep commits small.', ''].join('\n'),
    );
  });

  it('新文件：只有新增行', () => {
    const diff = [
      '--- /dev/null',
      '+++ b/AGENTS.md',
      '@@ -0,0 +1,2 @@',
      '+# AGENTS.md',
      '+- x',
    ].join('\n');
    expect(applyUnifiedDiff('', diff)).toBe('# AGENTS.md\n- x\n');
  });

  it('几个 hunk 依次放；保留原文结尾没有换行', () => {
    const before = 'a\nb\nc\nd\ne';
    const diff = ['@@ -1,2 +1,2 @@', ' a', '-b', '+B', '@@ -4,2 +4,2 @@', ' d', '-e', '+E'].join(
      '\n',
    );
    expect(applyUnifiedDiff(before, diff)).toBe('a\nB\nc\nd\nE');
  });

  it('上下文对不上、没有 hunk、没有改动、读不懂的行：失败', () => {
    expect(applyUnifiedDiff(BEFORE, '@@ -1 +1 @@\n nope\n+x')).toBeUndefined();
    expect(applyUnifiedDiff(BEFORE, 'just text')).toBeUndefined();
    expect(applyUnifiedDiff(BEFORE, '@@ -1 +1 @@\n # AGENTS.md')).toBeUndefined();
    expect(applyUnifiedDiff(BEFORE, '@@ -1 +1 @@\n # AGENTS.md\n?? x')).toBeUndefined();
  });
});
