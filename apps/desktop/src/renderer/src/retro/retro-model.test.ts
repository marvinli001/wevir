import type { SessionRetro } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { nextDetail, nextLabel, retroMarkdownText, retroTarget } from './retro-model';

const SES = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR';
const TURN = 'trn_01JA2B3C4D5E6F7G8H9JKMNPQR';
const RUN = 'vrn_01JA2B3C4D5E6F7G8H9JKMNPQR';
const RUN0 = 'vrn_01JA2B3C4D5E6F7G8H9JKMNPR0';
const CHECK = 'chk_01JA2B3C4D5E6F7G8H9JKMNPQR';
const SHA = 'a'.repeat(40);
const TS = '2026-10-20T08:00:00.000Z';

function retro(overrides: Partial<SessionRetro> = {}): SessionRetro {
  return {
    sessionId: SES,
    schemaVersion: 1,
    throughSeq: 30,
    builtAt: TS,
    checkedAt: TS,
    build: 'incremental',
    running: false,
    goal: {
      recorded: true,
      request: { id: 'e2', text: '修复解析器', ref: { kind: 'event', seq: 2, turnId: TURN } },
    },
    done: [
      {
        id: 'e9.0',
        text: '补测试',
        origin: 'todo',
        status: 'completed',
        ref: { kind: 'event', seq: 9, turnId: TURN },
      },
    ],
    open: [],
    boardRecorded: true,
    turns: [],
    hiddenTurns: 1,
    changes: { recorded: true, repo: true, files: [], commits: [], uncommitted: 2 },
    verification: { recorded: false, checks: [], commands: [] },
    review: { recorded: true, comments: [] },
    decisions: [],
    delivery: {
      checks: 'unverified',
      commit: 'uncommitted',
      push: 'unknown',
      ci: 'unknown',
      deploy: 'unknown',
    },
    next: [{ id: 'n:commit', kind: 'commit', text: '2' }],
    sessions: [],
    memories: [],
    ...overrides,
  };
}

describe('任务回顾的 Markdown', () => {
  it('没有验证记录写“未验证”；清单的完成只算登记；撤销的回合写个数', () => {
    const text = retroMarkdownText(retro(), { title: '解析器' });
    expect(text).toContain('# 任务回顾 · 解析器');
    expect(text).toContain('## 验证\n- 未验证');
    expect(text).toContain('## 已完成（登记）\n- [清单] 补测试 (e9.0)');
    expect(text).toContain('1 个回合已撤销');
    expect(text).toContain('- 提交：有未提交的改动 · 2 个文件未提交');
    expect(text).toContain('- CI：未知');
    expect(text).not.toContain('已脱敏');
  });

  it('通过但对应旧版本、之前的失败、来源已删除、模型摘要的推断', () => {
    const text = retroMarkdownText(
      retro({
        verification: {
          recorded: true,
          acceptance: 'accepted',
          commands: [{ id: 'e7', text: 'pnpm test', status: 'completed' }],
          checks: [
            {
              id: `v:${RUN}`,
              checkId: CHECK,
              runId: RUN,
              name: 'test',
              command: 'pnpm test',
              kind: 'test',
              status: 'passed',
              evidence: 'outdated',
              tests: { passed: 3, failed: 0, skipped: 1 },
              seq: 20,
              earlier: [{ runId: RUN0, status: 'failed', reason: 'exit_code', seq: 12 }],
            },
          ],
        },
        memories: [
          {
            id: 'e25',
            text: 'parser',
            scope: 'project',
            name: 'parser',
            operation: 'save',
            source: 'deleted',
            ref: { kind: 'memory', scope: 'project', name: 'parser' },
          },
        ],
        changes: {
          recorded: true,
          repo: true,
          files: [],
          commits: [{ id: `c:${SHA}`, sha: SHA, subject: 'fix parser', at: TS }],
        },
        summary: {
          points: [
            { text: '解析器已修复', refs: [`v:${RUN}`] },
            { text: '可能还要补文档', refs: [], inferred: true },
          ],
          providerId: 'deepseek',
          modelId: 'deepseek-chat',
          throughSeq: 18,
          generatedAt: TS,
          inputBytes: 100,
          outputBytes: 50,
          outdated: true,
        },
      }),
      { redactions: 3 },
    );
    expect(text).toContain('已脱敏 3 处 · 仅正则检查');
    expect(text).toContain(`- test \`pnpm test\`：通过 · 结果对应旧版本 · 3/3 项通过 (v:${RUN})`);
    expect(text).toMatch(new RegExp(`\n  - 失败[^\n]* \\(v:${RUN0}\\)\n`));
    expect(text).toContain('Agent 运行的命令（不计入验证）');
    expect(text).toContain('[记忆已保存] parser (e25 · 来源已删除)');
    expect(text).toContain(`${SHA.slice(0, 12)} fix parser`);
    expect(text).toContain('## 模型生成 · deepseek/deepseek-chat · 早于最新事件');
    expect(text).toContain('- 可能还要补文档 (推断)');
    expect(text).toContain(`- 解析器已修复 (v:${RUN})`);
  });
});

describe('出处', () => {
  it('事件与验证跳到 seq，批注与回合改动开变更，来源已删除时没有', () => {
    expect(retroTarget({ kind: 'event', seq: 4 })).toEqual({ kind: 'seq', seq: 4 });
    expect(retroTarget({ kind: 'verification', runId: RUN, seq: 9 })).toEqual({
      kind: 'seq',
      seq: 9,
    });
    expect(retroTarget({ kind: 'turn_diff', turnId: TURN, path: 'a.ts' })).toEqual({
      kind: 'diff',
      scope: { kind: 'turn', turnId: TURN },
      path: 'a.ts',
    });
    expect(
      retroTarget({
        kind: 'review',
        commentId: 'rvc_01JA2B3C4D5E6F7G8H9JKMNPQR',
        path: 'b.ts',
        source: { kind: 'uncommitted' },
      }),
    ).toEqual({ kind: 'diff', scope: { kind: 'uncommitted' }, path: 'b.ts' });
    expect(retroTarget({ kind: 'commit', sha: SHA })).toEqual({ kind: 'commit', sha: SHA });
    expect(retroTarget({ kind: 'session', sessionId: SES }, 'deleted')).toBeUndefined();
    expect(retroTarget(undefined)).toBeUndefined();
  });

  it('提交与推送的下一步带个数，其余带原文', () => {
    expect(nextLabel({ kind: 'push', text: '3' })).toBe('推送 3 个提交');
    expect(nextDetail({ kind: 'push', text: '3' })).toBeUndefined();
    expect(nextLabel({ kind: 'fix_check', text: 'test' })).toBe('修复未通过的检查');
    expect(nextDetail({ kind: 'fix_check', text: 'test' })).toBe('test');
    expect(nextLabel({ kind: 'later_kind', text: '' })).toBe('later_kind');
  });
});
