import { describe, expect, it } from 'vitest';
import { parseCodexReview } from './review-findings.js';

describe('parseCodexReview', () => {
  it('拆出总体说明与每条发现：严重度标签、按最后一个破折号分开标题与位置、缩进的说明', () => {
    const text = [
      'The patch breaks two callers.',
      '',
      'Full review comments:',
      '',
      '- [P0] Guard against null — not undefined — /r/a.ts:3-3',
      '  `x.y` throws when `x` is null.',
      '',
      '- Keep the old export — /r/dir with space/b.ts:10-12',
      '  Callers import `old`.',
    ].join('\n');
    expect(parseCodexReview(text)).toEqual({
      summary: 'The patch breaks two callers.',
      findings: [
        {
          title: 'Guard against null — not undefined',
          body: '`x.y` throws when `x` is null.',
          priority: 0,
          path: '/r/a.ts',
          startLine: 3,
          endLine: 3,
        },
        {
          title: 'Keep the old export',
          body: 'Callers import `old`.',
          path: '/r/dir with space/b.ts',
          startLine: 10,
          endLine: 12,
        },
      ],
    });
  });

  it('只有发现（没有总体说明）、一条时的标题；行号为 0 或反过来时纠正', () => {
    expect(parseCodexReview('Review comment:\n\n- [P2] Typo — /r/c.md:9-0\n  teh')).toEqual({
      summary: '',
      findings: [
        { title: 'Typo', body: 'teh', priority: 2, path: '/r/c.md', startLine: 1, endLine: 9 },
      ],
    });
  });

  it('不是这个格式时返回 undefined', () => {
    expect(parseCodexReview('Looks good to me.')).toBeUndefined();
    expect(parseCodexReview('Reviewer failed to output a response.')).toBeUndefined();
    // 发现列表里出现了别的行。
    expect(
      parseCodexReview('Full review comments:\n\n- A — /r/a.ts:1-2\nnot indented'),
    ).toBeUndefined();
    // 位置不是 路径:起-止。
    expect(parseCodexReview('Full review comments:\n\n- A — somewhere')).toBeUndefined();
    // 正文里提到标题行但后面没有发现。
    expect(parseCodexReview('Full review comments:')).toBeUndefined();
  });
});
