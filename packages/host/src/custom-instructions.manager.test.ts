// 用户的说明与输出风格（0.78.0）在 SessionManager 上：与规则文件一起进引擎说明或随消息补、`session.rules` 的 `custom`、每回合
// 提醒、设置改了从下一次恢复起生效。

import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { HostSettings, SessionId } from '@wevir/protocol';
import type { EngineRuleFiles, EngineSession, SessionConfig } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  customInputs,
  loadCustomPrompts,
  planCustom,
  styleReminder,
  writingStyleInput,
} from './custom-instructions.js';
import { EngineRouter } from './engine-router.js';
import { EventStore } from './event-store.js';
import { createHostMethods } from './host-methods.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';
import { WritingStyleStore } from './writing-style/store.js';

const tempDir = useTempDir();
const storages = useStorages();
const T0 = '2026-10-21T00:00:00.000Z';
const prompts = loadCustomPrompts();

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

describe('用户的说明与输出风格（SessionManager）', () => {
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  });

  /** `ownGuidance`：两个引擎都像 Claude Code 那样自带写代码的做法（适配器的 `codingGuidance`）。 */
  function setup(
    initial: Partial<HostSettings>,
    writingStyle?: WritingStyleStore,
    ownGuidance = false,
  ) {
    let settings: HostSettings = { sendWhileBusy: 'steer', ...initial };
    const root = join(realpathSync(tempDir()), `c${managers.length}`);
    const workspaceDir = join(root, 'ws');
    mkdirSync(join(workspaceDir, '.git'), { recursive: true });
    const storage = storages.open(join(root, 'data'));
    storage.workspaces.insert({
      id: 'ws_1',
      rootPath: workspaceDir,
      displayName: 'wevir',
      createdAt: T0,
      updatedAt: T0,
    });
    for (const [id, kind] of [
      ['mock', 'openai-compatible'],
      ['grok', 'grok'],
    ] as const) {
      storage.providers.insert({
        id,
        kind,
        displayName: id,
        ...(kind === 'openai-compatible' && {
          api: 'openai-completions' as const,
          baseURL: 'http://127.0.0.1:9/v1',
        }),
        models: [{ id: 'm' }],
        defaultModelId: 'm',
        createdAt: T0,
        updatedAt: T0,
      });
    }
    const codex = new RulesEcho({
      user: [],
      project: [],
      imports: false,
      instructions: true,
      codingGuidance: ownGuidance,
    });
    const acp = new RulesEcho({
      user: [],
      project: [],
      imports: false,
      instructions: false,
      codingGuidance: ownGuidance,
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
      ruleFiles: { discover: async () => [] },
      customInstructions: {
        plan: async ({ styled, codingDiscipline }) => {
          const profile = settings.writingStyle === true ? await writingStyle?.get() : undefined;
          const writing = writingStyleInput(settings, profile?.content);
          return planCustom(prompts, {
            ...customInputs(settings, styled, codingDiscipline),
            ...(writing !== undefined && { writingStyle: writing }),
          });
        },
        reminder: (outputStyle) => styleReminder(prompts, outputStyle),
      },
    });
    managers.push(manager);
    const set = (patch: Partial<HostSettings>) => {
      settings = { ...settings, ...patch };
    };
    return { events, manager, codex, acp, set };
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

  it('进引擎说明：说明与风格；没有规则文件也记 custom；每回合消息末尾带提醒，消息记录里没有', async () => {
    const env = setup({ agentInstructions: '回答用中文。', outputStyle: 'concise' });
    const session = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const id = session.id as SessionId;
    const instructions = env.codex.configs[0]?.ruleInstructions ?? '';
    expect(instructions).toContain('# 用户的说明');
    expect(instructions).toContain('<user_instructions>\n回答用中文。\n</user_instructions>');
    expect(instructions).toContain('# 输出风格：简洁');
    expect(session.rules).toMatchObject({
      providerId: 'mock',
      files: [],
      channel: 'instructions',
      bytes: Buffer.byteLength(instructions),
      custom: { instructions: true, outputStyle: 'concise' },
    });

    const answer = await turn(env, id, 'hi');
    expect(answer).toContain('hi\n<system-reminder>');
    expect(answer).not.toContain('# 用户的说明');
    const message = env.events.readSince(id, 0).findLast((event) => event.type === 'user.message');
    expect(JSON.stringify(message)).not.toContain('system-reminder');
  });

  it('随消息补的引擎：说明放在第一条消息开头，之后只带提醒', async () => {
    const env = setup({ agentInstructions: '回答用中文。', outputStyle: 'proactive' });
    const { id } = await env.manager.create({ workspaceId: 'ws_1', providerId: 'grok' });
    const sessionId = id as SessionId;
    expect(env.acp.configs[0]?.ruleInstructions).toBeUndefined();
    const first = await turn(env, sessionId, 'first');
    expect(first).toContain('# 输出风格：主动');
    expect(first).toContain('回答用中文。');
    expect(first).toContain('first\n<system-reminder>');
    const second = await turn(env, sessionId, 'second');
    expect(second).not.toContain('# 输出风格：主动');
    expect(second).toContain('second\n<system-reminder>');
  });

  it('设置改了：已经开着的会话不变，恢复时按新的设置重新给并记下', async () => {
    const env = setup({ agentInstructions: '回答用中文。', outputStyle: 'explanatory' });
    const { id } = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = id as SessionId;
    // 讲解没有每回合提醒。
    expect(await turn(env, sessionId, 'hi')).not.toContain('system-reminder');
    env.set({ outputStyle: 'default' });
    await env.manager.close(sessionId);
    await env.manager.resume(sessionId);
    const resumed = env.codex.configs.at(-1)?.ruleInstructions ?? '';
    expect(resumed).not.toContain('# 输出风格');
    expect(resumed).toContain('回答用中文。');
    expect(env.events.snapshot(sessionId)?.session.rules?.custom).toEqual({
      instructions: true,
      bytes: Buffer.byteLength(resumed),
    });
  });

  it('写作风格（0.95.0）：开着交档案，没有档案交建档提示，关着不交', async () => {
    const store = new WritingStyleStore({ dir: join(realpathSync(tempDir()), 'writing-style') });
    const env = setup({ writingStyle: true }, store);
    const first = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    expect(env.codex.configs[0]?.ruleInstructions).toContain('wevir_writing_style_setup');
    expect(first.rules?.custom).toMatchObject({ instructions: false, writingStyle: 'setup' });

    await store.save('- 句子短，先说结论。', { by: 'agent' });
    const second = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    expect(env.codex.configs[1]?.ruleInstructions).toContain(
      '<writing_style_profile>\n- 句子短，先说结论。\n</writing_style_profile>',
    );
    expect(second.rules?.custom?.writingStyle).toBe('profile');

    env.set({ writingStyle: false });
    const third = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    expect(env.codex.configs[2]?.ruleInstructions ?? '').not.toContain('writing_style');
    // 只剩编码纪律。
    expect(third.rules?.custom).toEqual({
      instructions: false,
      bytes: Buffer.byteLength(prompts.codingDiscipline),
    });
  });

  it('编码纪律：没有自带写代码做法的引擎都交，没有别的说明也记 custom；随消息补的引擎第一条消息带一次', async () => {
    const env = setup({});
    const session = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    expect(env.codex.configs[0]?.ruleInstructions).toBe(prompts.codingDiscipline);
    expect(session.rules).toMatchObject({
      providerId: 'mock',
      files: [],
      channel: 'instructions',
      bytes: Buffer.byteLength(prompts.codingDiscipline),
      custom: { instructions: false, bytes: Buffer.byteLength(prompts.codingDiscipline) },
    });

    const { id } = await env.manager.create({ workspaceId: 'ws_1', providerId: 'grok' });
    const sessionId = id as SessionId;
    expect(env.acp.configs[0]?.ruleInstructions).toBeUndefined();
    expect(await turn(env, sessionId, 'first')).toContain(prompts.codingDiscipline);
    expect(await turn(env, sessionId, 'second')).not.toContain(prompts.codingDiscipline);
  });

  it('编码纪律：引擎自带写代码的做法（Claude Code）时不交，用户的说明照交', async () => {
    const bare = setup({}, undefined, true);
    const none = await bare.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    expect(bare.codex.configs[0]?.ruleInstructions).toBeUndefined();
    expect(none.rules?.custom).toBeUndefined();

    const env = setup({ agentInstructions: '回答用中文。' }, undefined, true);
    const session = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const instructions = env.codex.configs[0]?.ruleInstructions ?? '';
    expect(instructions).toContain('<user_instructions>\n回答用中文。\n</user_instructions>');
    expect(instructions).not.toContain(prompts.codingDiscipline);
    expect(session.rules?.custom).toEqual({
      instructions: true,
      bytes: Buffer.byteLength(instructions),
    });
  });

  it('编码纪律：已经开着的会话恢复时照样带，说明在它后面', async () => {
    const env = setup({ agentInstructions: '回答用中文。' });
    const { id } = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = id as SessionId;
    await env.manager.close(sessionId);
    await env.manager.resume(sessionId);
    const resumed = env.codex.configs.at(-1)?.ruleInstructions ?? '';
    expect(resumed.startsWith(prompts.codingDiscipline)).toBe(true);
    expect(resumed.indexOf('<user_instructions>')).toBeGreaterThan(prompts.codingDiscipline.length);
  });

  it('writingStyle.*：用户看、改、删；关掉设置时删样本、留档案', async () => {
    const env = setup({});
    const root = realpathSync(tempDir());
    const store = new WritingStyleStore({ dir: join(root, 'writing-style') });
    const methods = createHostMethods({
      storage: storages.open(join(root, 'methods')),
      events: env.events,
      sessions: env.manager,
      secrets: new FileSecretStore(join(root, 'methods')),
      writingStyle: store,
    });
    const context = { client: identity, capabilities: {} };
    expect(await methods['writingStyle.get']({}, context)).toEqual({});
    const { profile } = await methods['writingStyle.update']({ content: '- 句子短。' }, context);
    expect(profile).toMatchObject({
      content: '- 句子短。',
      updatedBy: 'user',
      setupComplete: true,
    });
    await store.save('- 先说结论。', { by: 'agent' });
    const stale = await methods['writingStyle.update'](
      { content: '- 用户改的', revision: profile.revision },
      context,
    );
    expect(stale).toMatchObject({ conflict: true, profile: { content: '- 先说结论。' } });

    await store.addSamples('chat', 'agent', [{ text: '先跑测试。' }]);
    await methods['settings.update']({ settings: { writingStyle: true } }, context);
    expect((await store.summary()).files).toBe(1);
    await methods['settings.update']({ settings: { writingStyle: false } }, context);
    expect((await store.summary()).files).toBe(0);
    expect((await methods['writingStyle.get']({}, context)).profile?.content).toBe('- 先说结论。');

    await methods['writingStyle.delete']({}, context);
    expect(await methods['writingStyle.get']({}, context)).toEqual({});
  });

  it('settings.update：只收认识的风格，不认识的拒绝且不改', async () => {
    const env = setup({});
    const root = realpathSync(tempDir());
    const methods = createHostMethods({
      storage: storages.open(join(root, 'methods')),
      events: env.events,
      sessions: env.manager,
      secrets: new FileSecretStore(join(root, 'methods')),
    });
    const context = { client: identity, capabilities: {} };
    const { settings } = await methods['settings.update'](
      { settings: { agentInstructions: '回答用中文。', outputStyle: 'friendly' } },
      context,
    );
    expect(settings).toMatchObject({ agentInstructions: '回答用中文。', outputStyle: 'friendly' });
    await expect(
      methods['settings.update']({ settings: { outputStyle: 'shouty' } }, context),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect((await methods['settings.get']({}, context)).settings.outputStyle).toBe('friendly');
  });
});
