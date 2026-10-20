import type { SessionRules } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { displayRulePath, loadedRuleCount, ruleRows } from './rules-model';

const RULES: SessionRules = {
  providerId: 'claude',
  files: [
    {
      path: '/Users/me/.claude/CLAUDE.md',
      scope: 'user',
      kind: 'claude',
      delivery: 'engine',
      bytes: 9,
    },
    {
      path: '/Users/me/p/AGENTS.md',
      scope: 'project',
      kind: 'agents',
      delivery: 'wevir',
      bytes: 9,
    },
    {
      path: '/Users/me/p/docs/x.md',
      scope: 'project',
      kind: 'claude',
      delivery: 'wevir',
      bytes: 9,
      truncated: true,
      importedFrom: '/Users/me/p/CLAUDE.md',
    },
    {
      path: '/Users/me/p/GEMINI.md',
      scope: 'project',
      kind: 'gemini',
      delivery: 'skipped',
      bytes: 9,
      skipReason: 'duplicate',
    },
  ],
  channel: 'instructions',
  bytes: 30,
  budgetBytes: 32768,
};

describe('规则文件的行', () => {
  it('会话目录里的写相对路径，别处的缩写家目录', () => {
    expect(displayRulePath('/Users/me/p/a/AGENTS.md', '/Users/me/p')).toBe('a/AGENTS.md');
    expect(displayRulePath('/Users/me/p2/AGENTS.md', '/Users/me/p/')).toBe('~/p2/AGENTS.md');
    expect(displayRulePath('C:\\w\\CLAUDE.md', 'C:\\w')).toBe('CLAUDE.md');
  });

  it('谁读的、截断与引入；摘要只数加载了的', () => {
    const rows = ruleRows(RULES, '/Users/me/p');
    expect(rows.map((row) => [row.name, row.status, row.truncated, row.importedFrom])).toEqual([
      ['~/.claude/CLAUDE.md', 'engine', false, undefined],
      ['AGENTS.md', 'wevir', false, undefined],
      ['docs/x.md', 'wevir', true, 'CLAUDE.md'],
      ['GEMINI.md', 'skipped', false, undefined],
    ]);
    expect(rows[3]?.skipReason).toBe('duplicate');
    expect(loadedRuleCount(RULES)).toBe(3);
  });
});
