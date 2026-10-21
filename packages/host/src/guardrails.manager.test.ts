// 护栏（0.86.0）在 SessionManager 上：认 Codex hooks 的来源建会话时挂上 hooks，别的不挂；引擎报的拦截写成 `guardrail.blocked`、记命中。

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId } from '@wevir/protocol';
import type { AgentEvent, EngineSession, SessionConfig } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { guardrailChecker } from '@wevir/runtime-adapter/guardrail';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineRouter } from './engine-router.js';
import { EventStore } from './event-store.js';
import { GuardrailService } from './guardrails/service.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const T0 = '2026-10-21T00:00:00.000Z';

/** 记下交给它的配置；`dialect` 时像 Codex 认 hooks，每条回复之前报一次拦截。 */
class HookEcho extends EchoAdapter {
  readonly configs: SessionConfig[] = [];
  blockedId = '';
  constructor(readonly dialect: boolean) {
    super({ stepDelayMs: 0, chunkSize: 4096 });
  }
  hookDialect(): 'codex' | undefined {
    return this.dialect ? 'codex' : undefined;
  }
  override async createSession(config: SessionConfig): Promise<EngineSession> {
    this.configs.push(config);
    return super.createSession(config);
  }
  override subscribe(engineSessionId: string): AsyncIterable<AgentEvent> {
    const source = super.subscribe(engineSessionId);
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of source) {
          if (event.type === 'assistant.message' && self.dialect) {
            yield {
              type: 'guardrail.blocked',
              engineSessionId,
              guardrailId: self.blockedId,
              kind: 'forbidden_command',
              action: 'denied',
              tool: 'Bash',
              command: 'rm -rf build',
              reason: 'x'.repeat(2500),
            };
          }
          yield event;
        }
      },
    };
  }
}

describe('护栏（SessionManager）', () => {
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  });

  function setup() {
    const root = realpathSync(tempDir());
    const workspaceDir = join(root, 'ws');
    mkdirSync(join(workspaceDir, '.git'), { recursive: true });
    mkdirSync(join(workspaceDir, '.codex'));
    writeFileSync(
      join(workspaceDir, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo repo' }] }] },
      }),
    );
    const storage = storages.open(join(root, 'data'));
    storage.workspaces.insert({
      id: 'ws_1',
      rootPath: workspaceDir,
      displayName: 'ws',
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
      } as never);
    }
    const codex = new HookEcho(true);
    const other = new HookEcho(false);
    const router = new EngineRouter([
      { name: 'echo', adapter: codex, kinds: ['openai-compatible'] },
      { name: 'echo-grok', adapter: other, kinds: ['grok'] },
    ]);
    void router.configureProviders([
      { id: 'mock', kind: 'openai-compatible' } as never,
      { id: 'grok', kind: 'grok' } as never,
    ]);
    const guardrails = new GuardrailService({
      checker: guardrailChecker(join(root, 'guardrails')),
      workspaceRoot: () => workspaceDir,
    });
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const manager = new SessionManager({
      storage,
      events,
      adapter: router,
      engine: 'echo',
      engineFeatures: router.engineFeatures(),
      guardrails,
    });
    managers.push(manager);
    return { events, manager, codex, other, guardrails, workspaceDir };
  }

  it('Codex 方言的来源挂上 hooks 与仓库 hooks 的停用清单，别的引擎不挂', async () => {
    const env = setup();
    await env.guardrails.add({
      rule: { kind: 'forbidden_command', match: 'prefix', pattern: 'rm -rf' },
    });
    await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    await env.manager.create({ workspaceId: 'ws_1', providerId: 'grok' });
    const [config] = env.codex.configs;
    expect(config?.hooks).toEqual([
      expect.objectContaining({ event: 'PreToolUse', matcher: 'Bash|apply_patch' }),
    ]);
    // 命令行的引号：POSIX 用单引号，Windows 的 cmd 用双引号。
    expect(config?.hooks?.[0]?.command).toContain(
      process.platform === 'win32' ? '"--workspace" "ws_1"' : "'--workspace' 'ws_1'",
    );
    expect(config?.disabledHooks).toEqual([
      `${join(env.workspaceDir, '.codex', 'hooks.json')}:pre_tool_use:0:0`,
    ]);
    expect(env.other.configs[0]?.hooks).toBeUndefined();
    expect(env.other.configs[0]?.disabledHooks).toBeUndefined();
  });

  it('拦截写成 guardrail.blocked（带回合、理由截断），命中计数加一', async () => {
    const env = setup();
    const rule = await env.guardrails.add({
      rule: { kind: 'forbidden_command', match: 'prefix', pattern: 'rm -rf' },
    });
    env.codex.blockedId = rule.id;
    const { id } = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = id as SessionId;
    await env.manager.send({ sessionId, content: [{ type: 'text', text: 'hi' }] }, identity);
    await vi.waitFor(() => expect(env.events.snapshot(sessionId)?.session.state).toBe('idle'), {
      timeout: 5000,
    });
    const written = env.events.readSince(sessionId, 0);
    const blocked = written.find((event) => event.type === 'guardrail.blocked');
    const turn = written.find((event) => event.type === 'turn.started');
    expect(blocked?.source).toBe('host');
    expect(blocked?.payload).toMatchObject({
      guardrailId: rule.id,
      kind: 'forbidden_command',
      action: 'denied',
      tool: 'Bash',
      command: 'rm -rf build',
      turnId: (turn?.payload as { turnId: string } | undefined)?.turnId,
    });
    expect((blocked?.payload as { reason: string } | undefined)?.reason).toHaveLength(2000);
    await vi.waitFor(() => expect(env.guardrails.list()[0]?.hits).toBe(1));
  });
});
