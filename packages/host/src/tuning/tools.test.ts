import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId, TuningProposal } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import type { AppTool, AppToolResult } from '../app-mcp.js';
import { AppToolError } from '../app-mcp.js';
import { HostError } from '../errors.js';
import { useTempDir } from '../test-utils.js';
import type { ProposeInput } from './proposals.js';
import { TUNING_TOOLS, tuningTools } from './tools.js';

const tempDir = useTempDir();
const SES = 'ses_1' as SessionId;
const T0 = '2026-10-22T00:00:00.000Z';

const ruleProposal: TuningProposal = {
  id: 'tpr_01JA2B3C4D5E6F7G8H9JKMNPQR',
  workspaceId: 'ws_1',
  sessionId: SES,
  kind: 'rule',
  title: 'Build first',
  target: 'AGENTS.md',
  change: { kind: 'rule', path: '/p/AGENTS.md', before: '', after: '- Build first.\n' },
  evidence: [],
  status: 'accepted',
  createdAt: T0,
};
const trialProposal: TuningProposal = { ...ruleProposal, status: 'trial', origin: 'auto' };

function setup() {
  const proposed: ProposeInput[] = [];
  const decided: string[] = [];
  let listed: TuningProposal[] = [];
  const workspaces = new Map([
    ['ws_1', { id: 'ws_1', rootPath: '/p', displayName: 'p', createdAt: T0, updatedAt: T0 }],
    [
      'ws_chats',
      { id: 'ws_chats', rootPath: '/chats', displayName: 'c', createdAt: T0, updatedAt: T0 },
    ],
  ]);
  const sessions = new Map([
    ['ses_1', { workspaceId: 'ws_1' }],
    ['ses_chat', { workspaceId: 'ws_chats' }],
  ]);
  const spillDir = join(tempDir(), 'spill');
  const tools = tuningTools({
    storage: {
      sessions: { get: (id: string) => sessions.get(id) } as never,
      workspaces: { get: (id: string) => workspaces.get(id) } as never,
    },
    proposals: {
      propose: async (_sessionId, input) => {
        proposed.push(input);
        if (input.title === 'Stale')
          throw new HostError('INVALID_PARAMS', 'no change', { issues: [] });
        return { ...trialProposal, origin: 'agent' };
      },
      keep: (id) => {
        decided.push(`keep ${id}`);
        return { ...trialProposal, status: 'accepted' };
      },
      revert: async (id) => {
        decided.push(`revert ${id}`);
        if (id === 'tpr_conflict') {
          throw new HostError('PROPOSAL_STALE', 'the target changed; change it back by hand');
        }
        return { ...trialProposal, status: 'reverted' };
      },
      list: async () => ({ proposals: listed }),
    },
    trials: {
      overview: async () => ({
        auto: { enabled: false, decided: true },
        budget: {
          month: '2026-10',
          limitTokens: 1,
          usedTokens: 0,
          autoTokens: 0,
          exhausted: false,
        },
        series: [],
      }),
    },
    tuning: {
      get: async () => ({
        profile: {
          fingerprint: 'f'.repeat(64),
          layers: [{ key: 'rules', hash: 'a'.repeat(64), items: [] }],
        },
        pending: false,
        pendingLayers: [],
      }),
    },
    isChats: (workspace) => workspace.rootPath === '/chats',
    spillDir,
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const call = async (name: string, args: Record<string, unknown>, sessionId = SES) =>
    (byName.get(name) as AppTool).call(args, {
      sessionId,
      signal: new AbortController().signal,
    });
  return {
    tools,
    call,
    proposed,
    decided,
    setListed: (list: TuningProposal[]) => {
      listed = list;
    },
  };
}

const json = (result: AppToolResult) => result.structuredContent as Record<string, unknown>;

describe('wevir_tuning_*', () => {
  it('名字与注解：只有 status 是只读的，都不破坏、不对外', () => {
    const h = setup();
    expect(h.tools.map((tool) => tool.name)).toEqual([...TUNING_TOOLS]);
    expect(h.tools.map((tool) => tool.annotations.readOnlyHint)).toEqual([true, false, false]);
    for (const tool of h.tools) {
      expect(tool.annotations).toMatchObject({ destructiveHint: false, openWorldHint: false });
    }
  });

  it('status：总览、层摘要、试用中的改动全文（太长的写文件）与最近的结论', async () => {
    const h = setup();
    const long = 'x'.repeat(5000);
    h.setListed([
      {
        ...trialProposal,
        change: { ...ruleProposal.change, kind: 'rule', after: long } as TuningProposal['change'],
      },
      {
        ...ruleProposal,
        id: 'tpr_01JA2B3C4D5E6F7G8H9JKMNPR9',
        status: 'reverted',
        outcome: { decidedBy: 'auto', result: 'reverted', reason: 'worse', decidedAt: T0 },
      },
    ]);
    const result = json(await h.call('wevir_tuning_status', {}));
    expect(result.layers).toEqual([{ key: 'rules', items: 0, hash: 'aaaaaaaa' }]);
    const [trial] = result.trial as Array<{ change: { after: { path: string; length: number } } }>;
    expect(trial?.change.after.length).toBe(5000);
    expect(readFileSync(trial?.change.after.path as string, 'utf8')).toBe(long);
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        status: 'reverted',
        outcome: expect.objectContaining({ reason: 'worse' }),
      }),
    ]);
    await expect(h.call('wevir_tuning_status', {}, 'ses_chat' as SessionId)).rejects.toThrow(
      /not in one/,
    );
  });

  it('propose：按种类整理输入；校验失败与 Host 的错误都给模型看原因', async () => {
    const h = setup();
    const result = json(
      await h.call('wevir_tuning_propose', {
        kind: 'rule',
        title: 'Build first',
        reason: 'Tests failed twice without a build.',
        content: '# AGENTS.md\n- Build first.\n',
      }),
    );
    expect(result).toMatchObject({ status: 'trial', target: 'AGENTS.md' });
    await h.call('wevir_tuning_propose', {
      kind: 'memory',
      title: 'Cents',
      name: 'invoice-cents',
      type: 'project',
      description: 'Amounts in cents',
      content: 'Store amounts in cents.',
    });
    await h.call('wevir_tuning_propose', {
      kind: 'guardrail',
      title: 'Env',
      rule: { kind: 'protected_path', glob: '.env*' },
    });
    expect(h.proposed).toEqual([
      {
        kind: 'rule',
        title: 'Build first',
        reason: 'Tests failed twice without a build.',
        content: '# AGENTS.md\n- Build first.\n',
      },
      {
        kind: 'memory',
        title: 'Cents',
        name: 'invoice-cents',
        type: 'project',
        description: 'Amounts in cents',
        content: 'Store amounts in cents.',
      },
      { kind: 'guardrail', title: 'Env', rule: { kind: 'protected_path', glob: '.env*' } },
    ]);
    for (const args of [
      { kind: 'skill', title: 'x', name: 'Bad Name', content: 'x' },
      { kind: 'memory', title: 'x', name: 'n', type: 'secret', description: 'd', content: 'c' },
      { kind: 'guardrail', title: 'x', rule: { kind: 'shell_hook' } },
      { kind: 'rule', title: 'x' },
      { kind: 'nope', title: 'x' },
    ]) {
      await expect(h.call('wevir_tuning_propose', args)).rejects.toBeInstanceOf(AppToolError);
    }
    await expect(
      h.call('wevir_tuning_propose', { kind: 'rule', title: 'Stale', content: 'x' }),
    ).rejects.toThrow(/no change/);
  });

  it('decide：只认这个项目里的改动；被改过的目标说明原因', async () => {
    const h = setup();
    h.setListed([trialProposal, { ...trialProposal, id: 'tpr_conflict' as TuningProposal['id'] }]);
    expect(
      json(await h.call('wevir_tuning_decide', { proposalId: trialProposal.id, decision: 'keep' }))
        .status,
    ).toBe('accepted');
    expect(
      json(
        await h.call('wevir_tuning_decide', { proposalId: trialProposal.id, decision: 'revert' }),
      ).status,
    ).toBe('reverted');
    await expect(
      h.call('wevir_tuning_decide', { proposalId: 'tpr_conflict', decision: 'revert' }),
    ).rejects.toThrow(/change it back by hand/);
    await expect(
      h.call('wevir_tuning_decide', { proposalId: 'tpr_other', decision: 'keep' }),
    ).rejects.toThrow(/No tuning change/);
    await expect(
      h.call('wevir_tuning_decide', { proposalId: trialProposal.id, decision: 'later' }),
    ).rejects.toThrow(/keep or revert/);
    expect(h.decided).toEqual([
      `keep ${trialProposal.id}`,
      `revert ${trialProposal.id}`,
      'revert tpr_conflict',
    ]);
  });
});
