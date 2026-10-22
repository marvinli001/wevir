// 自动调优的试用（0.108.0）：agent 提交的改动直接写入并进入试用；撤销与回退对四种目标核对 `applied`，没变就恢复采纳前的内容，变了的
// 手动撤销回 `PROPOSAL_STALE`、自动回退改记保留（`conflict`）。

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Guardrail, MethodParams, SessionId, TuningProposalId } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { isHostError } from '../errors.js';
import { MemoryStore } from '../memory.js';
import { useStorages, useTempDir } from '../test-utils.js';
import { ProposalService } from './proposals.js';

const tempDir = useTempDir();
const storages = useStorages();
const T0 = '2026-10-22T00:00:00.000Z';
const WS = 'ws_1';
const SES = 'ses_1' as SessionId;
const AGENTS = '# AGENTS.md\n';

function setup() {
  const root = realpathSync(tempDir());
  const project = join(root, 'project');
  const chats = join(root, 'chats');
  mkdirSync(project, { recursive: true });
  mkdirSync(chats, { recursive: true });
  writeFileSync(join(project, 'AGENTS.md'), AGENTS);
  const storage = storages.open(join(root, 'data'));
  for (const [id, rootPath] of [
    [WS, project],
    ['ws_chats', chats],
  ] as const) {
    storage.workspaces.insert({ id, rootPath, displayName: id, createdAt: T0, updatedAt: T0 });
  }
  for (const [id, workspaceId] of [
    [SES, WS],
    ['ses_chats', 'ws_chats'],
  ] as const) {
    storage.sessions.insert({
      id,
      workspaceId,
      cwd: project,
      engine: 'echo',
      engineSessionId: id,
      providerId: 'p',
      modelId: 'm',
      title: '',
      titleSource: 'first_prompt',
      state: 'idle',
      lastSeq: 0,
      createdAt: T0,
      updatedAt: T0,
    });
  }
  const memory = new MemoryStore({ dir: join(root, 'memory') });
  let guardrails: Guardrail[] = [];
  let next = 0;
  const skillCalls: string[] = [];
  const service = new ProposalService({
    storage,
    events: { readSince: () => [], snapshot: () => undefined },
    retro: { get: async () => ({}) as never, summarize: async () => ({}) as never },
    isChats: (workspace) => workspace.rootPath === chats,
    ruleFiles: async () => [],
    skills: async () => [],
    enableSkill: async (path) => {
      skillCalls.push(`enable ${path}`);
    },
    disableSkill: async (path) => {
      skillCalls.push(`disable ${path}`);
    },
    memory,
    guardrails: {
      list: () => guardrails,
      add: async (params: MethodParams<'guardrail.add'>) => {
        const added: Guardrail = {
          id: `grd_${++next}` as Guardrail['id'],
          ...(params.workspaceId !== undefined && { workspaceId: params.workspaceId }),
          ...(params.name !== undefined && { name: params.name }),
          rule: params.rule,
          enabled: true,
          revision: 1,
          createdAt: T0,
          updatedAt: T0,
          hits: 0,
        };
        guardrails = [...guardrails, added];
        return added;
      },
      delete: async (id) => {
        guardrails = guardrails.filter((g) => g.id !== id);
      },
    },
    userHome: root,
  });
  const bumpGuardrail = (id: string) => {
    guardrails = guardrails.map((g) => (g.id === id ? { ...g, revision: g.revision + 1 } : g));
  };
  return {
    storage,
    service,
    memory,
    project,
    skillCalls,
    bumpGuardrail,
    guardrails: () => guardrails,
  };
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return isHostError(error) ? error.code : String(error);
  }
}

describe('试用', () => {
  it('规则：agent 提交写入 AGENTS.md 并进入试用；撤销写回原文；没有变化或不在项目里时拒绝', async () => {
    const h = setup();
    const after = `${AGENTS}\n- Run tests.\n`;
    const proposal = await h.service.propose(SES, {
      kind: 'rule',
      title: 'Run tests',
      reason: 'The user keeps asking for tests.',
      content: after,
    });
    expect(proposal).toMatchObject({
      status: 'trial',
      origin: 'agent',
      target: 'AGENTS.md',
      evidence: [{ id: 'agent', text: 'The user keeps asking for tests.' }],
    });
    expect(readFileSync(join(h.project, 'AGENTS.md'), 'utf8')).toBe(after);
    expect(h.service.pendingCause(WS)).toEqual({ proposalIds: [proposal.id] });
    expect(
      await code(h.service.propose(SES, { kind: 'rule', title: 'Same', content: after })),
    ).toBe('INVALID_PARAMS');
    expect(
      await code(
        h.service.propose('ses_chats' as SessionId, { kind: 'rule', title: 'x', content: 'y' }),
      ),
    ).toBe('INVALID_PARAMS');
    expect(
      await code(
        h.service.propose(SES, {
          kind: 'rule',
          title: 'Key',
          content: `${AGENTS}OPENAI_API_KEY=sk-proj-${'a'.repeat(40)}\n`,
        }),
      ),
    ).toBe('INVALID_PARAMS');

    const reverted = await h.service.revert(proposal.id, 'agent');
    expect(reverted).toMatchObject({
      status: 'reverted',
      outcome: { decidedBy: 'agent', result: 'reverted', reason: 'manual' },
    });
    expect(readFileSync(join(h.project, 'AGENTS.md'), 'utf8')).toBe(AGENTS);
  });

  it('规则：采纳前没有 AGENTS.md 的，撤销时删掉；被改过的不动，自动回退改记保留', async () => {
    const h = setup();
    const path = join(h.project, 'AGENTS.md');
    rmSync(path);
    const created = await h.service.propose(SES, { kind: 'rule', title: 'New', content: 'x\n' });
    await h.service.revert(created.id, 'user');
    expect(existsSync(path)).toBe(false);

    const changed = await h.service.propose(SES, {
      kind: 'rule',
      title: 'Changed',
      content: 'y\n',
    });
    writeFileSync(path, 'edited by hand\n');
    expect(await code(h.service.revert(changed.id, 'user'))).toBe('PROPOSAL_STALE');
    const kept = await h.service.revert(changed.id, 'auto', { reason: 'worse' });
    expect(kept).toMatchObject({
      status: 'accepted',
      outcome: { decidedBy: 'auto', result: 'kept', reason: 'conflict' },
    });
    expect(readFileSync(path, 'utf8')).toBe('edited by hand\n');
  });

  it('技能：原来有的写回原文；原来没有的删掉 SKILL.md 与空目录并停用', async () => {
    const h = setup();
    const skill = (name: string, body: string) =>
      `---\nname: ${name}\ndescription: ${name} steps\n---\n${body}\n`;
    const dir = join(h.project, '.agents', 'skills', 'release');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), skill('release', '1. Tag.'));
    const updated = await h.service.propose(SES, {
      kind: 'skill',
      title: 'Release',
      name: 'release',
      content: skill('release', '1. Tag.\n2. Push.'),
    });
    await h.service.revert(updated.id, 'user');
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe(skill('release', '1. Tag.'));

    const created = await h.service.propose(SES, {
      kind: 'skill',
      title: 'Deploy',
      name: 'deploy',
      content: skill('deploy', 'Run deploy.'),
    });
    const path = join(h.project, '.agents', 'skills', 'deploy', 'SKILL.md');
    expect(existsSync(path)).toBe(true);
    await h.service.revert(created.id, 'user');
    expect(existsSync(join(h.project, '.agents', 'skills', 'deploy'))).toBe(false);
    expect(h.skillCalls).toContain(`disable ${path}`);
    expect(
      await code(
        h.service.propose(SES, { kind: 'skill', title: 'Bad', name: 'bad', content: 'no front' }),
      ),
    ).toBe('INVALID_PARAMS');
  });

  it('记忆：原来有的写回正文；被用户改过的不动', async () => {
    const h = setup();
    await h.memory.save('project', WS, {
      name: 'build-first',
      type: 'feedback',
      description: 'Build first',
      content: 'Build before tests.',
    });
    const proposal = await h.service.propose(SES, {
      kind: 'memory',
      title: 'Build first',
      name: 'build-first',
      type: 'feedback',
      description: 'Build first',
      content: 'Always build before tests.',
    });
    expect((await h.memory.read('project', WS, 'build-first')).content).toBe(
      'Always build before tests.',
    );
    await h.service.revert(proposal.id, 'user');
    expect((await h.memory.read('project', WS, 'build-first')).content).toBe('Build before tests.');

    const again = await h.service.propose(SES, {
      kind: 'memory',
      title: 'Build first',
      name: 'build-first',
      type: 'feedback',
      description: 'Build first',
      content: 'Build twice.',
    });
    const note = await h.memory.read('project', WS, 'build-first');
    await h.memory.update('project', WS, 'build-first', note.revision, { content: 'Mine.' });
    expect(await code(h.service.revert(again.id, 'user'))).toBe('PROPOSAL_STALE');
    expect((await h.memory.read('project', WS, 'build-first')).content).toBe('Mine.');
  });

  it('护栏：撤销删掉规则；规则被改过时冲突，已被删掉时算已回退', async () => {
    const h = setup();
    const rule = { kind: 'protected_path', glob: '.env*' } as const;
    const first = await h.service.propose(SES, { kind: 'guardrail', title: 'Env', rule });
    expect(h.guardrails()).toHaveLength(1);
    expect(
      await code(h.service.propose(SES, { kind: 'guardrail', title: 'Env again', rule })),
    ).toBe('INVALID_PARAMS');
    h.bumpGuardrail(h.guardrails()[0]?.id as string);
    expect(await code(h.service.revert(first.id, 'user'))).toBe('PROPOSAL_STALE');
    // 用户自己删了规则：目标已是采纳前的样子。
    h.guardrails().splice(0);
    const second = await h.service.propose(SES, {
      kind: 'guardrail',
      title: 'Push',
      rule: { kind: 'forbidden_command', match: 'prefix', pattern: 'git push -f' },
    });
    await h.service.revert(second.id, 'user');
    expect(h.guardrails()).toEqual([]);
    expect(h.storage.tuningProposals.get(second.id)?.status).toBe('reverted');
  });

  it('提前保留与状态检查', async () => {
    const h = setup();
    const proposal = await h.service.propose(SES, { kind: 'rule', title: 'x', content: 'x\n' });
    expect(h.service.keep(proposal.id, 'agent')).toMatchObject({
      status: 'accepted',
      outcome: { decidedBy: 'agent', result: 'kept', reason: 'manual' },
    });
    // 已保留的再保留原样返回；仍可撤销。
    expect(h.service.keep(proposal.id, 'user').status).toBe('accepted');
    await h.service.revert(proposal.id, 'user');
    expect(() => h.service.keep(proposal.id, 'user')).toThrow(/not in trial/);
    h.storage.tuningProposals.update(proposal.id, { status: 'rejected' });
    expect(await code(h.service.revert(proposal.id as TuningProposalId, 'user'))).toBe(
      'INVALID_PARAMS',
    );
    // 没有 applied 的旧记录不能撤销。
    h.storage.tuningProposals.update(proposal.id, {
      status: 'accepted',
      payload: {
        change: { kind: 'rule', path: join(h.project, 'AGENTS.md'), before: '', after: 'x\n' },
      },
    });
    writeFileSync(join(h.project, 'AGENTS.md'), 'x\n');
    expect(await code(h.service.revert(proposal.id, 'user'))).toBe('PROPOSAL_STALE');
  });
});
