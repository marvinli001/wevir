import { describe, expect, it } from 'vitest';
import {
  evidenceIndex,
  loadProposalInstructions,
  parseProposals,
  proposalInput,
} from './proposals-input.js';

const ALL = ['rule', 'skill', 'memory', 'guardrail'] as const;
const known = new Set(['t:trn_1', 'e5', 'g9']);

function output(proposals: unknown[]): string {
  return `Here you go:\n${JSON.stringify({ proposals })}\n`;
}

const base = {
  title: 'Run build first',
  target: '',
  description: '',
  memoryType: '',
  evidence: ['t:trn_1', 'e5', 'e5', 'x99'],
};

describe('parseProposals', () => {
  it('四种都能解析；证据只留认识的、去重', () => {
    const parsed = parseProposals(
      output([
        { ...base, kind: 'rule', target: 'AGENTS.md', body: '@@ -1 +1,2 @@\n a\n+b' },
        {
          ...base,
          kind: 'skill',
          target: 'release-checklist',
          body: '---\nname: release-checklist\ndescription: Release steps\n---\n1. x',
        },
        {
          ...base,
          kind: 'memory',
          target: 'invoice-cents',
          description: '  Amounts   in cents ',
          memoryType: 'feedback',
          body: ' Store cents. ',
        },
      ]),
      { allowed: ALL, knownIds: known },
    );
    expect(parsed?.dropped).toEqual([]);
    expect(parsed?.proposals).toEqual([
      {
        kind: 'rule',
        title: 'Run build first',
        diff: '@@ -1 +1,2 @@\n a\n+b',
        evidence: ['t:trn_1', 'e5'],
      },
      {
        kind: 'skill',
        title: 'Run build first',
        name: 'release-checklist',
        content: '---\nname: release-checklist\ndescription: Release steps\n---\n1. x',
        evidence: ['t:trn_1', 'e5'],
      },
      {
        kind: 'memory',
        title: 'Run build first',
        name: 'invoice-cents',
        type: 'feedback',
        description: 'Amounts in cents',
        content: 'Store cents.',
        evidence: ['t:trn_1', 'e5'],
      },
    ]);
    const guardrail = parseProposals(
      output([
        {
          ...base,
          kind: 'guardrail',
          target: 'No force push',
          body: '{"kind":"forbidden_command","match":"prefix","pattern":"git push --force"}',
          memoryType: 'nonsense',
        },
      ]),
      { allowed: ALL, knownIds: known },
    );
    expect(guardrail?.proposals[0]).toMatchObject({
      kind: 'guardrail',
      name: 'No force push',
      rule: { kind: 'forbidden_command', match: 'prefix', pattern: 'git push --force' },
    });
  });

  it('不合格的丢掉并记原因；不允许的种类也丢；最多三条', () => {
    const parsed = parseProposals(
      output([
        { ...base, kind: 'skill', target: 'Bad Name', body: 'x' },
        { ...base, kind: 'memory', target: 'x', description: '', body: 'x' },
        { ...base, kind: 'guardrail', target: 'g', body: '{"kind":"shell"}' },
        {
          ...base,
          kind: 'guardrail',
          target: 'g',
          body: '{"kind":"forbidden_command","match":"regex","pattern":"("}',
        },
        { ...base, kind: 'rule', title: '', body: 'x' },
        { ...base, kind: 'rule', body: '' },
        { ...base, kind: 'role', body: 'x' },
        { ...base, kind: 'rule', body: 'a' },
        { ...base, kind: 'rule', body: 'b' },
        { ...base, kind: 'rule', body: 'c' },
        { ...base, kind: 'rule', body: 'd' },
      ]),
      { allowed: ['rule', 'skill', 'memory'], knownIds: known },
    );
    expect(parsed?.proposals.map((p) => (p.kind === 'rule' ? p.diff : p.kind))).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(parsed?.dropped).toHaveLength(8);
    expect(parsed?.dropped.join('\n')).toMatch(/kind guardrail/);
  });

  it('不是 JSON、不是那个形状：undefined；空列表是正常结果', () => {
    expect(parseProposals('no json', { allowed: ALL, knownIds: known })).toBeUndefined();
    expect(parseProposals('{"points": []}', { allowed: ALL, knownIds: known })).toBeUndefined();
    expect(parseProposals('{"proposals": [}', { allowed: ALL, knownIds: known })).toBeUndefined();
    expect(parseProposals('{"proposals": []}', { allowed: ALL, knownIds: known })).toEqual({
      proposals: [],
      dropped: [],
    });
  });
});

describe('proposalInput', () => {
  it('各段都在，转义尖括号；项目的 AGENTS.md 总放进去，太长的别的规则文件只列名字', () => {
    const text = proposalInput({
      summary: {
        points: [{ text: 'Fixed <CI>', refs: ['e5'] }],
        providerId: 'p',
        modelId: 'm',
        throughSeq: 9,
        generatedAt: '2026-10-21T00:00:00.000Z',
        inputBytes: 1,
        outputBytes: 1,
      },
      retro: '<retro>\n[e5] turn: x\n</retro>',
      guardrailHits: [
        {
          seq: 9,
          blocked: {
            guardrailId: 'grd_1',
            kind: 'forbidden_command',
            action: 'denied',
            command: 'rm -rf /',
            reason: 'blocked',
          },
        },
      ],
      ruleFiles: [
        { label: 'AGENTS.md', text: 'x'.repeat(30_000), editable: true },
        { label: '~/.codex/AGENTS.md', text: 'user rules' },
      ],
      agentsMissing: false,
      skills: [{ name: 'deploy', description: 'Deploy it', source: 'project' }],
      memoryIndex: '- [project] a (project): b',
      guardrails: [{ rule: { kind: 'stop_check', command: 'pnpm test' }, scope: 'project' }],
      rejected: [{ kind: 'rule', title: 'Use npm', target: 'AGENTS.md' }],
      allowed: ['rule', 'memory'],
    });
    expect(text).toContain('- Fixed &lt;CI&gt; [e5]');
    expect(text).toContain('[g9] guardrail denied forbidden_command: rm -rf /: blocked');
    expect(text).toContain('<rule_file path="AGENTS.md" editable="true">');
    expect(text).toContain('<rule_file path="~/.codex/AGENTS.md" omitted="too long"/>');
    expect(text).toContain('- deploy (project): Deploy it');
    expect(text).toContain('- [project] stop_check: pnpm test');
    expect(text).toContain('- rule AGENTS.md: Use npm');
    expect(text).toContain('<allowed>rule, memory</allowed>');
  });

  it('提示词能读，没有残留的模板语法', () => {
    expect(loadProposalInstructions()).toMatch(/^You review one finished/);
  });
});

describe('evidenceIndex', () => {
  it('回合带序号与事件出处，护栏命中按 g<seq>', () => {
    const index = evidenceIndex(
      {
        turns: [
          { id: 't:a', turnId: 'trn_a', seq: 3, text: 'first', kind: 'user' },
          { id: 't:b', turnId: 'trn_b', seq: 8, text: 'second', kind: 'user' },
        ],
        goal: { recorded: false },
        done: [],
        open: [],
        verification: {
          recorded: true,
          checks: [{ id: 'v:vrn_1', runId: 'vrn_1', name: 'test', status: 'failed', seq: 12 }],
          commands: [],
        },
        changes: { recorded: true, files: [], commits: [] },
        review: { recorded: false, comments: [] },
        decisions: [{ id: 'e4', text: 'no', kind: 'reject', ref: { kind: 'event', seq: 4 } }],
        next: [],
        sessions: [],
        memories: [],
      } as never,
      [
        {
          seq: 9,
          blocked: {
            guardrailId: 'grd_1',
            kind: 'stop_check',
            action: 'continued',
            reason: 'fail',
          },
        },
      ],
    );
    expect(index.get('t:b')).toEqual({
      text: 'second',
      turn: 2,
      ref: { kind: 'event', seq: 8, turnId: 'trn_b' },
    });
    expect(index.get('v:vrn_1')).toEqual({
      text: 'test: failed',
      ref: { kind: 'verification', runId: 'vrn_1', seq: 12 },
    });
    expect(index.get('e4')?.ref).toEqual({ kind: 'event', seq: 4 });
    expect(index.get('g9')).toEqual({ text: 'stop_check: fail', ref: { kind: 'event', seq: 9 } });
  });
});
