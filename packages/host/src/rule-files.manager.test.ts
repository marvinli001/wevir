// 跨引擎的规则文件（0.68.0）在 SessionManager 上：建会话、接力（进说明的与随消息的两种引擎）、换回、恢复、分支与设置开关。

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId, WevirEvent } from '@wevir/protocol';
import type { EngineRuleFiles, EngineSession, SessionConfig } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineRouter } from './engine-router.js';
import { EventStore } from './event-store.js';
import { discoverRuleFiles } from './rule-files.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const T0 = '2026-10-20T00:00:00.000Z';

/** 记下交给它的配置、按给定的规则文件作答的 echo 引擎。 */
class RulesEcho extends EchoAdapter {
  readonly configs: SessionConfig[] = [];
  constructor(readonly rules: EngineRuleFiles) {
    super({ stepDelayMs: 0, chunkSize: 4096 });
  }
  ruleFiles(): EngineRuleFiles {
    return this.rules;
  }
  override async createSession(config: SessionConfig): Promise<EngineSession> {
    this.configs.push(config);
    return super.createSession(config);
  }
  override async resumeSession(id: string, config: SessionConfig): Promise<EngineSession> {
    this.configs.push(config);
    return super.resumeSession(id, config);
  }
}

describe('规则文件（SessionManager）', () => {
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  });

  function setup(options: { enabled?: () => boolean } = {}) {
    const root = join(realpathSync(tempDir()), `r${managers.length}`);
    const home = join(root, 'home');
    const workspaceDir = join(root, 'ws');
    mkdirSync(join(workspaceDir, '.git'), { recursive: true });
    mkdirSync(home);
    writeFileSync(join(workspaceDir, 'AGENTS.md'), 'Run pnpm test before finishing.');
    writeFileSync(join(workspaceDir, 'CLAUDE.md'), 'Indent with tabs.');
    const storage = storages.open(join(root, 'data'));
    storage.workspaces.insert({
      id: 'ws_1',
      rootPath: workspaceDir,
      displayName: 'ws',
      createdAt: T0,
      updatedAt: T0,
    });
    storage.providers.insert({
      id: 'mock',
      kind: 'openai-compatible',
      displayName: 'Mock API',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:9/v1',
      models: [{ id: 'm' }],
      defaultModelId: 'm',
      createdAt: T0,
      updatedAt: T0,
    });
    storage.providers.insert({
      id: 'grok',
      kind: 'grok',
      displayName: 'Grok',
      models: [{ id: 'g' }],
      defaultModelId: 'g',
      createdAt: T0,
      updatedAt: T0,
    });
    // mock 像 Codex：自己读 AGENTS.md，补的进说明；grok 像 ACP 引擎：只读 AGENTS.md，补的随消息。
    const codex = new RulesEcho({
      user: [],
      project: ['agents'],
      imports: false,
      instructions: true,
    });
    const acp = new RulesEcho({
      user: [],
      project: ['agents'],
      imports: false,
      instructions: false,
    });
    const router = new EngineRouter([
      { name: 'echo', adapter: codex, kinds: ['openai-compatible'] },
      { name: 'echo-grok', adapter: acp, kinds: ['grok'] },
    ]);
    void router.configureProviders([
      { id: 'mock', kind: 'openai-compatible' } as never,
      { id: 'grok', kind: 'grok' } as never,
    ]);
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const manager = new SessionManager({
      storage,
      events,
      adapter: router,
      engine: 'echo',
      engineFeatures: router.engineFeatures(),
      ruleFiles: {
        discover: (cwd) => discoverRuleFiles({ cwd, home, env: {} }),
        ...(options.enabled !== undefined && { enabled: options.enabled }),
      },
    });
    managers.push(manager);
    return { events, manager, codex, acp, workspaceDir };
  }

  async function turn(env: ReturnType<typeof setup>, sessionId: SessionId, text: string) {
    await env.manager.send({ sessionId, content: [{ type: 'text', text }] }, identity);
    await vi.waitFor(() => expect(env.events.snapshot(sessionId)?.session.state).toBe('idle'), {
      timeout: 5000,
    });
    const answer = env.events
      .readSince(sessionId, 0)
      .findLast((event) => event.type === 'assistant.message');
    return answer?.type === 'assistant.message' ? answer.payload.text : '';
  }

  function rulesEvents(env: ReturnType<typeof setup>, sessionId: SessionId) {
    return env.events
      .readSince(sessionId, 0)
      .filter(
        (event): event is Extract<WevirEvent, { type: 'session.rules' }> =>
          event.type === 'session.rules',
      );
  }

  it('建会话：引擎读的标 engine，不读的进引擎说明；会话带着这份列表', async () => {
    const env = setup();
    const session = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const id = session.id as SessionId;
    const instructions = env.codex.configs[0]?.ruleInstructions;
    expect(instructions).toContain('Indent with tabs.');
    expect(instructions).toContain(`path="${join(env.workspaceDir, 'CLAUDE.md')}"`);
    expect(instructions).not.toContain('Run pnpm test');
    const [event] = rulesEvents(env, id);
    expect(event?.seq).toBe(2);
    expect(event?.payload).toMatchObject({
      providerId: 'mock',
      channel: 'instructions',
      files: [
        { path: join(env.workspaceDir, 'AGENTS.md'), delivery: 'engine', kind: 'agents' },
        { path: join(env.workspaceDir, 'CLAUDE.md'), delivery: 'wevir', kind: 'claude' },
      ],
    });
    expect(event?.payload.context).toBeUndefined();
    expect(session.rules?.files).toHaveLength(2);
    // 进说明的不改消息。
    expect(await turn(env, id, 'hi')).not.toContain('Indent with tabs');
  });

  it('接力到随消息补的引擎：下一条消息开头带着规则，之后不再带；换回去重新给说明，再换过来不重复', async () => {
    const env = setup();
    const { id } = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = id as SessionId;
    await turn(env, sessionId, 'first');
    await env.manager.configure({ sessionId, providerId: 'grok' });
    const toGrok = rulesEvents(env, sessionId).at(-1);
    expect(toGrok?.payload).toMatchObject({ providerId: 'grok', channel: 'message' });
    expect(toGrok?.payload.context).toContain('Indent with tabs.');
    expect(env.acp.configs[0]?.ruleInstructions).toBeUndefined();
    // 规则在接力摘要之前，用户的消息在最后。
    const answer = await turn(env, sessionId, 'second');
    expect(answer.indexOf('Indent with tabs.')).toBeLessThan(answer.indexOf('Context handoff'));
    expect(answer).toMatch(/User message:\nsecond$/);
    expect(await turn(env, sessionId, 'third')).not.toContain('Indent with tabs');
    expect(env.events.snapshot(sessionId)?.session.rules?.providerId).toBe('grok');

    await env.manager.configure({ sessionId, providerId: 'mock' });
    expect(env.codex.configs.at(-1)?.ruleInstructions).toContain('Indent with tabs.');
    expect(rulesEvents(env, sessionId).at(-1)?.payload.providerId).toBe('mock');
    const before = rulesEvents(env, sessionId).length;
    await env.manager.configure({ sessionId, providerId: 'grok' });
    // 接着用以前的 grok 引擎会话：它已经收过规则，只更新列表，不再带正文。
    const back = rulesEvents(env, sessionId);
    expect(back).toHaveLength(before + 1);
    expect(back.at(-1)?.payload.context).toBeUndefined();
    expect(await turn(env, sessionId, 'fourth')).not.toContain('Indent with tabs');
  });

  it('接力预览列出新来源会加载的规则文件', async () => {
    const env = setup();
    const { id } = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = id as SessionId;
    await turn(env, sessionId, 'first');
    const { preview } = await env.manager.handoffPreview({ sessionId, providerId: 'grok' });
    expect(preview.rules).toMatchObject({ providerId: 'grok', channel: 'message' });
    expect(preview.rules?.files.map((file) => file.delivery)).toEqual(['engine', 'wevir']);
  });

  it('恢复引擎会话：进说明的按当时的文件重新给，列表没变不再写；改了文件写新的', async () => {
    const env = setup();
    const { id } = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = id as SessionId;
    await env.manager.close(sessionId);
    await env.manager.resume(sessionId);
    expect(env.codex.configs.at(-1)?.ruleInstructions).toContain('Indent with tabs.');
    expect(rulesEvents(env, sessionId)).toHaveLength(1);

    writeFileSync(join(env.workspaceDir, 'GEMINI.md'), 'Prefer small commits.');
    await env.manager.close(sessionId);
    await env.manager.resume(sessionId);
    expect(env.codex.configs.at(-1)?.ruleInstructions).toContain('Prefer small commits.');
    const events = rulesEvents(env, sessionId);
    expect(events).toHaveLength(2);
    expect(events[1]?.payload.files.map((file) => file.kind)).toEqual([
      'agents',
      'claude',
      'gemini',
    ]);
  });

  it('分支：新会话记下同样的规则，进说明的照给', async () => {
    const env = setup();
    const { id } = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = id as SessionId;
    await turn(env, sessionId, 'first');
    const branch = await env.manager.fork({ sessionId });
    expect(rulesEvents(env, branch.id as SessionId)[0]?.payload).toMatchObject({
      providerId: 'mock',
      channel: 'instructions',
    });
    expect(branch.rules?.files).toHaveLength(2);
  });

  it('设置关掉：不补，引擎不读的列为 disabled', async () => {
    const env = setup({ enabled: () => false });
    const session = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    expect(env.codex.configs[0]?.ruleInstructions).toBeUndefined();
    expect(session.rules?.files.map((file) => [file.delivery, file.skipReason])).toEqual([
      ['engine', undefined],
      ['skipped', 'disabled'],
    ]);
    expect(session.rules?.channel).toBeUndefined();
  });
});
