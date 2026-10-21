// 调优的建议（0.87.0）：startHost 组装出的真实 Host，echo 引擎的 `generateTitle` 按说明回回顾摘要或脚本里的建议。走一遍
// “生成（先补回顾摘要）→ 改 → 采纳四种 → 新会话的版本记下建议”，再看过时、拒绝进入下一次输入、重新生成与失败的原因。

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
  it('生成（先补摘要、合计用量）→ 改 → 采纳四种 → 下一个会话的版本记下建议', async () => {
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
    expect(generated.proposals.map((p: TuningProposal) => [p.kind, p.target, p.status])).toEqual([
      ['rule', 'AGENTS.md', 'pending'],
      ['skill', '.agents/skills/release-checklist/SKILL.md', 'pending'],
      ['memory', 'build-first', 'pending'],
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
    expect(rule.change.kind === 'rule' && rule.change.after).toContain('pnpm build');
    expect(rule.usage).toEqual({ inputTokens: 2400, outputTokens: 360 });
    expect(rule.providerId).toBe('deepseek-official');
    // 输入里有回顾、项目的 AGENTS.md 与允许的种类。
    const input = h.adapter.requests.at(-1)?.input ?? '';
    expect(input).toContain(`[${turnRef}] turn`);
    expect(input).toContain('<rule_file path="AGENTS.md" editable="true">');
    expect(input).toContain('<allowed>rule, skill, memory, guardrail</allowed>');
    expect(input).toContain('Fixed the build.');

    // 改：文本换掉，标“改过”。
    const edited = 'Run `pnpm build` first, always.';
    const updated = await h.client.request('tuning.proposal.update', {
      proposalId: memory.id,
      after: edited,
      description: 'Build first',
    });
    expect(updated.proposal).toMatchObject({
      edited: true,
      change: { after: edited, description: 'Build first' },
    });
    await expect(
      h.client.request('tuning.proposal.update', {
        proposalId: memory.id,
        rule: { kind: 'protected_path', glob: 'x' },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAMS });

    // 采纳：写文件、启用技能、写记忆（来源是会话与建议）。
    for (const p of [rule, skill, memory]) {
      const { proposal: decided } = await h.client.request('tuning.proposal.decide', {
        proposalId: p.id,
        decision: 'accept',
      });
      expect(decided.status).toBe('accepted');
    }
    expect(readFileSync(join(h.repo, 'AGENTS.md'), 'utf8')).toBe(
      `${AGENTS}- Run \`pnpm build\` before \`pnpm test\`.\n`,
    );
    expect(
      readFileSync(join(h.repo, '.agents', 'skills', 'release-checklist', 'SKILL.md'), 'utf8'),
    ).toContain('1. Tag.');
    const { skills } = await h.client.request('plugins.list', {});
    expect(skills.find((s: Skill) => s.name === 'release-checklist')?.enabled).toBe(true);
    const { note } = await h.client.request('memory.read', {
      scope: 'project',
      workspaceId: h.workspaceId,
      name: 'build-first',
    });
    expect(note).toMatchObject({ content: edited, description: 'Build first', type: 'feedback' });
    expect(note.origin).toMatchObject({ by: 'user', sessionId, proposalId: memory.id });
    // 同样的决定再来一次原样返回，相反的决定不行。
    await expect(
      h.client.request('tuning.proposal.decide', { proposalId: rule.id, decision: 'reject' }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_PARAMS });
    expect(h.client.notifications('tuning.proposal.changed').length).toBeGreaterThan(0);

    // 下一个会话开的版本记下三条建议；已处理的列表带版本与会话数。
    await h.newSession();
    const { versions } = await h.client.request('tuning.versions', { workspaceId: h.workspaceId });
    expect(versions[0]?.cause?.proposalIds).toEqual([rule.id, skill.id, memory.id]);
    expect(versions[1]?.cause).toBeUndefined();
    const decided = await h.client.request('tuning.proposal.list', {
      workspaceId: h.workspaceId,
      status: 'decided',
    });
    expect(decided.proposals).toHaveLength(3);
    for (const p of decided.proposals) {
      expect(p.version?.id).toBe(versions[0]?.id);
      expect(p.stats).toEqual({ sessions: 1 });
    }
    expect((await h.client.request('tuning.proposal.list', { status: 'open' })).proposals).toEqual(
      [],
    );
  }, 60_000);

  it('目标变了：已过时，不能改不能采纳；拒绝的进入下一次输入；重新生成换掉过时的；护栏采纳', async () => {
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
    // 第二次不再补摘要。
    expect(first.summarized).toBe(true);

    writeFileSync(join(h.repo, 'AGENTS.md'), `${AGENTS}- Changed by hand.\n`);
    await expect(
      h.client.request('tuning.proposal.decide', { proposalId: rule.id, decision: 'accept' }),
    ).rejects.toMatchObject({ code: ErrorCode.PROPOSAL_STALE });
    const open = await h.client.request('tuning.proposal.list', { status: 'open' });
    expect(open.proposals.find((p: TuningProposal) => p.id === rule.id)?.status).toBe('stale');
    await expect(
      h.client.request('tuning.proposal.update', { proposalId: rule.id, after: 'x' }),
    ).rejects.toMatchObject({ code: ErrorCode.PROPOSAL_STALE });

    // 护栏：采纳加进这个项目。
    await h.client.request('tuning.proposal.decide', {
      proposalId: guardrail.id,
      decision: 'accept',
    });
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

    // 重新生成换掉过时的那条；上一条被拒绝的进入输入。
    const old = await h.client.request('tuning.proposal.generate', { sessionId });
    expect(old.summarized).toBeUndefined();
    const toReject = old.proposals[0] as TuningProposal;
    await h.client.request('tuning.proposal.decide', {
      proposalId: toReject.id,
      decision: 'reject',
    });
    h.adapter.proposals = '{"proposals": []}';
    const again = await h.client.request('tuning.proposal.generate', {
      sessionId,
      replaces: rule.id,
    });
    expect(again).toMatchObject({ proposals: [], usage: { inputTokens: 1500, outputTokens: 300 } });
    expect(h.adapter.requests.at(-1)?.input).toContain(`- rule AGENTS.md: ${toReject.title}`);
    await expect(
      h.client.request('tuning.proposal.decide', { proposalId: rule.id, decision: 'reject' }),
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
