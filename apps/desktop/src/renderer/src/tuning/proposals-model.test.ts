import type { TuningProposal } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  changeTexts,
  diffLineCount,
  editParams,
  evidenceLabel,
  generatedText,
  kindName,
  openCount,
  proposalTokens,
  reasonText,
  ruleLine,
  statsText,
  withNewline,
} from './proposals-model';

const rule: TuningProposal['change'] = {
  kind: 'rule',
  path: '/p/AGENTS.md',
  before: '# A\n',
  after: '# A\n- b\n',
};
const guardrail: TuningProposal['change'] = {
  kind: 'guardrail',
  rule: { kind: 'forbidden_command', match: 'prefix', pattern: 'git push --force' },
};

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
    expect(proposalTokens({ usage: { inputTokens: 10, outputTokens: 2 } })).toBe('12 tokens');
    expect(proposalTokens({})).toBeUndefined();
  });

  it('证据、统计与待审数', () => {
    expect(evidenceLabel({ id: 't:a', text: 'fix ci', turn: 4 })).toBe('回合 4');
    expect(evidenceLabel({ id: 'v:1', text: 'test: failed' })).toBe('test: failed');
    expect(evidenceLabel({ id: 'e9', text: '' })).toBe('e9');
    expect(
      evidenceLabel({ id: 'c3', text: 'npm  run build &&\n  npm test -- --reporter verbose' }),
    ).toBe('npm run build &&');
    expect(
      evidenceLabel({ id: 'c4', text: 'node scripts/check-engine-boundary.mjs --strict --all' }),
    ).toBe('node scripts/check-engine-b…');
    expect(statsText({ stats: { sessions: 2, checks: { passed: 3, total: 4 } } })).toBe(
      '2 个会话 · 验证通过 3/4',
    );
    expect(statsText({ stats: { sessions: 0 } })).toBe('0 个会话');
    expect(statsText({})).toBeUndefined();
    expect(openCount([{ status: 'pending' }, { status: 'stale' }, { status: 'accepted' }])).toBe(2);
  });

  it('改动的文本与编辑参数', () => {
    expect(changeTexts(rule)).toEqual({ name: 'AGENTS.md', before: '# A\n', after: '# A\n- b\n' });
    expect(changeTexts(guardrail).after).toContain('"pattern": "git push --force"');
    expect(ruleLine(guardrail.rule)).toBe('forbidden_command (prefix): git push --force');
    expect(editParams(rule, '# A\n- b\n')).toBeUndefined();
    expect(editParams(rule, '# A\n- c\n')).toEqual({ after: '# A\n- c\n' });
    expect(editParams(guardrail, changeTexts(guardrail).after)).toBeUndefined();
    expect(editParams(guardrail, '{"kind":"protected_path","glob":".env"}')).toEqual({
      rule: { kind: 'protected_path', glob: '.env' },
    });
    expect(editParams(guardrail, '{"kind":"shell"}')).toBe('invalid');
    expect(editParams(guardrail, 'not json')).toBe('invalid');
  });

  it('diff 的行数：改后的加上删掉的；末尾补换行', () => {
    expect(withNewline('a')).toBe('a\n');
    expect(withNewline('a\n')).toBe('a\n');
    expect(withNewline('')).toBe('');
    expect(diffLineCount('', 'a\nb')).toBe(2);
    expect(diffLineCount('a\nb\n', 'a\nc\nd\n')).toBe(4);
    expect(diffLineCount('', '')).toBe(1);
    // 折行：每行 10 个字宽时，25 字的行占 3 行，全角字符算两个字宽。
    expect(diffLineCount('', `${'x'.repeat(25)}\nshort`, 10)).toBe(4);
    expect(diffLineCount('', '测试测试测试', 10)).toBe(2);
  });
});
