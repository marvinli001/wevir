import { describe, expect, it } from 'vitest';
import { generatedText, kindName, reasonText } from './proposals-model';

describe('proposals-model', () => {
  it('种类、原因与生成结果', () => {
    expect(kindName('rule')).toBe('规则');
    expect(kindName('later')).toBe('later');
    expect(reasonText('no_project')).toBe('会话不在项目中');
    expect(reasonText('running')).toBe('回合进行中');
    expect(reasonText('odd')).toBe('odd');
    expect(generatedText({ proposals: [], usage: { inputTokens: 1500, outputTokens: 300 } })).toBe(
      '暂无建议 · 1.8k tokens',
    );
    expect(generatedText({ proposals: [1, 2] })).toBe('2 条建议');
  });
});
