import type { Guardrail, ProfileLayer, RepoHook } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  approvalItems,
  draftOf,
  draftValid,
  guardrailKindName,
  guardrailLabel,
  regexError,
  repoHookLabel,
  repoHookStatus,
  ruleOf,
  ruleSummary,
} from './guardrails-model';

const guardrail = (patch: Partial<Guardrail>): Guardrail => ({
  id: 'grd_1' as Guardrail['id'],
  rule: { kind: 'forbidden_command', match: 'prefix', pattern: 'rm -rf' },
  enabled: true,
  revision: 1,
  createdAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
  hits: 0,
  ...patch,
});

const hook = (patch: Partial<RepoHook>): RepoHook => ({
  id: '.codex/hooks.json:PreToolUse:0:0',
  file: '.codex/hooks.json',
  event: 'PreToolUse',
  handler: 'command',
  command: './x.sh',
  hash: 'sha256:a',
  status: 'disabled',
  ...patch,
});

describe('护栏层的纯逻辑', () => {
  it('种类名称与参数摘要；有名字时行上写名字', () => {
    expect(guardrailKindName('stop_check')).toBe('结束前检查');
    expect(guardrailKindName('later_kind')).toBe('later_kind');
    expect(ruleSummary({ kind: 'forbidden_command', match: 'regex', pattern: '^git push' })).toBe(
      '/^git push/',
    );
    expect(ruleSummary({ kind: 'protected_path', glob: '.env' })).toBe('.env');
    expect(ruleSummary({ kind: 'commit_check', command: 'pnpm lint' })).toBe('pnpm lint');
    expect(guardrailLabel(guardrail({}))).toBe('rm -rf');
    expect(guardrailLabel(guardrail({ name: 'no rm' }))).toBe('no rm');
  });

  it('草稿与规则互转：切换种类不丢已填的，编辑时带回时限，项目规则的范围是项目', () => {
    const fresh = draftOf(undefined, 'project');
    expect(fresh).toMatchObject({ kind: 'forbidden_command', scope: 'project', maxAttempts: 3 });
    expect(draftValid(fresh)).toBe(false);
    const filled = { ...fresh, pattern: ' rm -rf ', kind: 'stop_check' as const };
    expect(draftValid(filled)).toBe(false);
    expect(ruleOf({ ...filled, kind: 'forbidden_command' })).toEqual({
      kind: 'forbidden_command',
      match: 'prefix',
      pattern: 'rm -rf',
    });
    const stop = guardrail({
      workspaceId: 'ws_1' as Guardrail['workspaceId'],
      rule: { kind: 'stop_check', command: 'pnpm test', maxAttempts: 5, timeoutSec: 120 },
    });
    const draft = draftOf(stop);
    expect(draft).toMatchObject({ id: 'grd_1', scope: 'project', command: 'pnpm test' });
    expect(ruleOf(draft)).toEqual(stop.rule);
    expect(ruleOf({ ...draft, kind: 'commit_check' })).toEqual({
      kind: 'commit_check',
      command: 'pnpm test',
      timeoutSec: 120,
    });
  });

  it('正则写错时不能保存，给出原因', () => {
    const draft = { ...draftOf(), match: 'regex' as const, pattern: '(' };
    expect(regexError(draft)).toBeDefined();
    expect(draftValid(draft)).toBe(false);
    expect(regexError({ ...draft, match: 'prefix' })).toBeUndefined();
    expect(draftValid({ ...draft, pattern: '^rm\\s' })).toBe(true);
  });

  it('仓库 hooks 的显示与状态；审批规则取档案层的条目', () => {
    expect(repoHookLabel(hook({}))).toBe('.codex/hooks.json · PreToolUse · ./x.sh');
    expect(repoHookLabel(hook({ handler: 'prompt', command: undefined, event: 'Stop' }))).toBe(
      '.codex/hooks.json · Stop · prompt',
    );
    expect(repoHookStatus(hook({}))).toBeUndefined();
    expect(repoHookStatus(hook({ status: 'enabled' }))).toBeUndefined();
    expect(repoHookStatus(hook({ status: 'unsupported' }))).toBe('不支持');
    expect(repoHookStatus(hook({ status: 'changed' }))).toBe('内容已变');
    const layer: ProfileLayer = {
      key: 'guardrails',
      hash: 'a'.repeat(64),
      items: [
        { id: 'guardrail:global:grd_1', label: 'rm -rf', scope: 'global', hash: 'b'.repeat(64) },
        {
          id: 'approval:global:command_prefix:["git"]',
          label: 'git',
          scope: 'global',
          hash: 'c'.repeat(64),
          detail: 'approval',
        },
      ],
    };
    expect(approvalItems(layer).map((item) => item.label)).toEqual(['git']);
  });
});
