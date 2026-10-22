// 调优的建议（0.87.0，0.107.0 起直接进入试用）：startHost 组装出的真实 Host，echo 引擎的 `generateTitle` 按说明回回顾摘要或脚本里的
// 建议。走一遍“生成（先补回顾摘要）→ 写入并试用 → 新会话的版本记下建议 → 保留与撤销”，再看被改过的目标、护栏与失败的原因。

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ErrorCode,
  type Guardrail,
  type SessionId,
  type Skill,
  type TuningProposal,
  type WevirEvent,
} from '@wevir/protocol';
import type { TitleRequest } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from '../host-process.js';
import { createLogger } from '../logger.js';
import { TestRpcClient, useTempDir } from '../test-utils.js';

const WAIT_MS = 20_000;
const tempDir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** `generateTitle`：回顾摘要回一点，建议回 `proposals`（脚本），记下收到的请求。 */
class ScriptedEcho extends EchoAdapter {
  proposals = '{"proposals": []}';
  readonly requests: TitleRequest[] = [];

  async generateTitle(_engineSessionId: string, request: TitleRequest): Promise<string> {
    this.requests.push(request);
    if (request.instructions.startsWith('You review one finished')) {
      request.onUsage?.({ inputTokens: 1500, outputTokens: 300 });
      return this.proposals;
    }
    request.onUsage?.({ inputTokens: 900, outputTokens: 60 });
    return '{"points": [{"text": "Fixed the build.", "refs": []}]}';
  }
}

const AGENTS = '# AGENTS.md\n\n## Rules\n\n- Use pnpm.\n';

async function boot() {
  const root = realpathSync(tempDir());
  const home = join(root, 'home');
  const repo = join(root, 'project');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'AGENTS.md'), AGENTS);
  const adapter = new ScriptedEcho({ stepDelayMs: 1 });
  const host = await startHost({
    adapter,
    engine: 'echo',
    logger: createLogger({ level: 'error', mirror: () => {} }),
    home,
    userHome: join(root, 'user'),
  });
  cleanups.push(() => host.shutdown());
  const token = (
    JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as { token: string }
  ).token;
  const client = await TestRpcClient.connect(host.url);
  cleanups.push(() => client.ws.close());
  const hello = await client.hello(token);
  expect(hello.result.features.tuning_proposals).toBe(true);
  const { workspace } = await client.request('workspace.add', { rootPath: repo });
  const workspaceId = workspace.id as string;
  await client.request('provider.upsert', {
    id: 'deepseek-official',
    kind: 'deepseek-official',
    displayName: 'DeepSeek',
    models: [],
    defaultModelId: 'deepseek-chat',
  });
  const newSession = async (text?: string) => {
    const { session } = await client.request('session.create', {
      workspaceId,
      providerId: 'deepseek-official',
    });
    const sessionId = session.id as SessionId;
    const { subscriptionId } = await client.request('events.subscribe', {
      sessionId,
      sinceSeq: 0,
    });
    const events = (): WevirEvent[] => client.events(subscriptionId);
    if (text !== undefined) {
      await client.request('session.send', { sessionId, content: [{ type: 'text', text }] });
      await client.until(
        () => events().some((event) => event.type === 'turn.finished') || undefined,
        'turn',
        WAIT_MS,
      );
      await client.until(
        async () =>
          (await client.request('session.get', { sessionId })).session.state === 'idle' ||
          undefined,
        'idle',
        WAIT_MS,
      );
    }
    return { sessionId, events };
  };
  return { adapter, client, repo, workspaceId, newSession };
}

function proposal(kind: string, target: string, body: string, extra: object = {}) {
  return {
    kind,
    title: `Proposal ${target}`,
    target,
    description: '',
    memoryType: '',
    body,
    evidence: [],
    ...extra,
  };
}

const RULE_DIFF = [
  '--- a/AGENTS.md',
  '+++ b/AGENTS.md',
  '@@ -4,2 +4,3 @@',
  ' ',
  ' - Use pnpm.',
  '+- Run `pnpm build` before `pnpm test`.',
].join('\n');

describe('调优的建议', () => {
  it('生成（先补摘要、合计用量）→ 直接写入并进入试用 → 下一个会话的版本记下建议 → 保留、撤销', async () => {
    const h = await boot();
    const { sessionId, events } = await h.newSession('fix ci');
    const turn = events().find((event) => event.type === 'turn.started');
    if (turn?.type !== 'turn.started') throw new Error('no turn');
    const turnRef = `t:${turn.payload.turnId}`;
    h.adapter.proposals = JSON.stringify({
      proposals: [
        proposal('rule', 'AGENTS.md', RULE_DIFF, { evidence: [turnRef, 'nope'] }),
        proposal(
          'skill',
          'release-checklist',
          '---\nname: release-checklist\ndescription: Steps for a release\n---\n1. Tag.',
        ),
        proposal('memory', 'build-first', 'The build must run before tests.', {
          description: 'Build before tests',
          memoryType: 'feedback',
        }),
      ],
    });

    const generated = await h.client.request('tuning.proposal.generate', { sessionId });
    expect(generated.reason).toBeUndefined();
    expect(generated.summarized).toBe(true);
    expect(generated.usage).toEqual({ inputTokens: 2400, outputTokens: 360 });
    expect(
      generated.proposals.map((p: TuningProposal) => [p.kind, p.target, p.status, p.origin]),
    ).toEqual([
      ['rule', 'AGENTS.md', 'trial', 'user'],
      ['skill', '.agents/skills/release-checklist/SKILL.md', 'trial', 'user'],
      ['memory', 'build-first', 'trial', 'user'],
    ]);
    const [rule, skill, memory] = generated.proposals as [
      TuningProposal,
      TuningProposal,
      TuningProposal,
    ];
    expect(rule.evidence).toEqual([
      expect.objectContaining({ id: turnRef, turn: 1, text: 'fix ci', ref: expect.anything() }),
    ]);
    expect(rule.change).toMatchObject({ before: AGENTS });
    expect(rule.usage).toEqual({ inputTokens: 2400, outputTokens: 360 });
    expect(rule.providerId).toBe('deepseek-official');
    // 输入里有回顾、项目的 AGENTS.md 与允许的种类。
    const input = h.adapter.requests.at(-1)?.input ?? '';
    expect(input).toContain(`[${turnRef}] turn`);
    expect(input).toContain('<rule_file path="AGENTS.md" editable="true">');
    expect(input).toContain('<allowed>rule, skill, memory, guardrail</allowed>');
    expect(input).toContain('Fixed the build.');

    // 已经写入：文件、启用的技能、记忆（来源是会话与建议）。
    expect(readFileSync(join(h.repo, 'AGENTS.md'), 'utf8')).toBe(
      `${AGENTS}- Run \`pnpm build\` before \`pnpm test\`.\n`,
    );
    const skillPath = join(h.repo, '.agents', 'skills', 'release-checklist', 'SKILL.md');
    expect(readFileSync(skillPath, 'utf8')).toContain('1. Tag.');
    const { skills } = await h.client.request('plugins.list', {});
    expect(skills.find((s: Skill) => s.name === 'release-checklist')?.enabled).toBe(true);
    const { note } = await h.client.request('memory.read', {
      scope: 'project',
      workspaceId: h.workspaceId,
      name: 'build-first',
    });
    expect(note).toMatchObject({ type: 'feedback', content: 'The build must run before tests.' });
    expect(note.origin).toMatchObject({ by: 'user', sessionId, proposalId: memory.id });
    // 试用中的不能再改。
    await expect(
      h.client.request('tuning.proposal.update', { proposalId: memory.id, after: 'x' }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAMS });

    // 总览：试用还没有起点，生成记进本月消耗。
    let overview = await h.client.request('tuning.overview', { workspaceId: h.workspaceId });
    expect(overview.auto).toEqual({ enabled: false, decided: false });
    expect(overview.trial).toMatchObject({
      proposalIds: [rule.id, skill.id, memory.id],
      sessions: 0,
    });
    expect(overview.trial?.startVersion).toBeUndefined();
    expect(overview.budget).toMatchObject({ usedTokens: 2760, autoTokens: 0, exhausted: false });
    expect(overview.lastRun).toMatchObject({ origin: 'user', proposals: 3 });
    expect(overview.totals).toEqual({ adopted: 3, kept: 0, reverted: 0 });

    // 下一个会话开的版本记下三条建议，成为试用的起点。
    await h.newSession('next');
    const { versions } = await h.client.request('tuning.versions', { workspaceId: h.workspaceId });
    expect(versions[0]?.cause?.proposalIds).toEqual([rule.id, skill.id, memory.id]);
    overview = await h.client.request('tuning.overview', { workspaceId: h.workspaceId });
    expect(overview.trial).toMatchObject({ sessions: 1, needed: 5 });
    expect(overview.trial?.startVersion?.id).toBe(versions[0]?.id);
    expect(overview.series.at(-1)).toMatchObject({ trial: true, metrics: { sessions: 1 } });

    // 提前保留一条；撤销另两条：AGENTS.md 写回原文，原来没有的技能删掉并停用、记忆删掉。
    const kept = await h.client.request('tuning.proposal.decide', {
      proposalId: memory.id,
      decision: 'accept',
    });
    expect(kept.proposal).toMatchObject({
      status: 'accepted',
      outcome: { decidedBy: 'user', result: 'kept', reason: 'manual' },
    });
    const reverted = await h.client.request('tuning.proposal.revert', { proposalId: rule.id });
    expect(reverted.proposal).toMatchObject({
      status: 'reverted',
      outcome: { decidedBy: 'user', result: 'reverted' },
    });
    expect(readFileSync(join(h.repo, 'AGENTS.md'), 'utf8')).toBe(AGENTS);
    expect(h.client.notifications('tuning.proposal.changed').length).toBeGreaterThan(0);
    // 再撤销一次原样返回。
    expect(
      (await h.client.request('tuning.proposal.revert', { proposalId: rule.id })).proposal.status,
    ).toBe('reverted');
    await h.client.request('tuning.proposal.decide', { proposalId: skill.id, decision: 'reject' });
    expect(() => readFileSync(skillPath, 'utf8')).toThrow();
    // 保留了的记忆也能撤销：原来没有，删掉。
    await h.client.request('tuning.proposal.revert', { proposalId: memory.id });
    await expect(
      h.client.request('memory.read', {
        scope: 'project',
        workspaceId: h.workspaceId,
        name: 'build-first',
      }),
    ).rejects.toBeDefined();
    overview = await h.client.request('tuning.overview', { workspaceId: h.workspaceId });
    expect(overview.trial).toBeUndefined();
    expect(overview.totals).toEqual({ adopted: 3, kept: 0, reverted: 3 });
    const decided = await h.client.request('tuning.proposal.list', {
      workspaceId: h.workspaceId,
      status: 'decided',
    });
    expect(decided.proposals.map((p: TuningProposal) => p.status)).toEqual([
      'reverted',
      'reverted',
      'reverted',
    ]);
  }, 60_000);

  it('目标在采纳后被改过：撤销回 PROPOSAL_STALE、不动目标；护栏进入试用与撤销；全局总览', async () => {
    const h = await boot();
    const { sessionId } = await h.newSession('protect secrets');
    h.adapter.proposals = JSON.stringify({
      proposals: [
        proposal('rule', 'AGENTS.md', RULE_DIFF),
        proposal(
          'guardrail',
          'No force push',
          '{"kind":"forbidden_command","match":"prefix","pattern":"git push --force"}',
        ),
      ],
    });
    const first = await h.client.request('tuning.proposal.generate', { sessionId });
    const [rule, guardrail] = first.proposals as [TuningProposal, TuningProposal];
    expect([rule.status, guardrail.status]).toEqual(['trial', 'trial']);
    const { guardrails } = await h.client.request('guardrail.list', {
      workspaceId: h.workspaceId,
    });
    expect(guardrails.map((g: Guardrail) => [g.workspaceId, g.name, g.rule])).toEqual([
      [
        h.workspaceId,
        'No force push',
        { kind: 'forbidden_command', match: 'prefix', pattern: 'git push --force' },
      ],
    ]);

    const changed = `${AGENTS}- Changed by hand.\n`;
    writeFileSync(join(h.repo, 'AGENTS.md'), changed);
    await expect(
      h.client.request('tuning.proposal.revert', { proposalId: rule.id }),
    ).rejects.toMatchObject({ code: ErrorCode.PROPOSAL_STALE });
    expect(readFileSync(join(h.repo, 'AGENTS.md'), 'utf8')).toBe(changed);

    await h.client.request('tuning.proposal.revert', { proposalId: guardrail.id });
    expect(
      (await h.client.request('guardrail.list', { workspaceId: h.workspaceId })).guardrails,
    ).toEqual([]);

    // 全局总览只有开关、预算与走势。
    const global = await h.client.request('tuning.overview', {});
    expect(global).not.toHaveProperty('trial');
    expect(global).not.toHaveProperty('totals');
    expect(global.budget.usedTokens).toBe(2760);
    await expect(
      h.client.request('tuning.proposal.revert', { proposalId: 'tpr_01JA2B3C4D5E6F7G8H9JKMNPQR' }),
    ).rejects.toMatchObject({ code: ErrorCode.PROPOSAL_NOT_FOUND });
  }, 60_000);

  it('失败的原因：会话还没有回合、子会话、输出解析不了（用量照记）', async () => {
    const h = await boot();
    const empty = await h.newSession();
    expect(
      await h.client.request('tuning.proposal.generate', { sessionId: empty.sessionId }),
    ).toEqual({ proposals: [], reason: 'empty' });
    const parent = await h.newSession('subagent');
    const started = parent.events().find((event) => event.type === 'subagent.started');
    if (started?.type !== 'subagent.started') throw new Error('no subagent');
    expect(
      await h.client.request('tuning.proposal.generate', {
        sessionId: started.payload.subagent.sessionId,
      }),
    ).toEqual({ proposals: [], reason: 'sub_session' });
    const { sessionId } = await h.newSession('hi');
    h.adapter.proposals = 'sorry, no JSON';
    expect(await h.client.request('tuning.proposal.generate', { sessionId })).toEqual({
      proposals: [],
      reason: 'unparsable',
      usage: { inputTokens: 2400, outputTokens: 360 },
    });
    expect((await h.client.request('tuning.proposal.list', {})).proposals).toEqual([]);
  }, 60_000);
});
