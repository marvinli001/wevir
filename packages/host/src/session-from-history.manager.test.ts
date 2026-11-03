import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId } from '@wevir/protocol';
import type { AgentInput, SessionConfig } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from './event-store.js';
import { parseClaudeSession } from './external-import/claude-session.js';
import { parseCodexSession } from './external-import/codex-session.js';
import { SessionImports } from './external-import/sessions.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const temp = useTempDir();
const storages = useStorages();
const managers: SessionManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.dispose();
});

class NativeMock extends EchoAdapter {
  readonly appTools = true;
  native = false;
  rejected = false;
  resumed: string[] = [];
  inputs: AgentInput[] = [];
  aliases = new Map<string, string>();
  async canResumeExternalSession(_origin: unknown, config: SessionConfig) {
    return this.native && (config.providerId === 'claude' || config.providerId === 'chatgpt');
  }
  override async resumeSession(id: string, config: SessionConfig) {
    if (!id.startsWith('11111111-') && !id.startsWith('22222222-'))
      return super.resumeSession(id, config);
    this.resumed.push(id);
    if (this.rejected) throw new Error('mock incompatible session');
    const existing = this.aliases.get(id);
    const session =
      existing === undefined
        ? await super.createSession(config)
        : await super.resumeSession(existing, config);
    this.aliases.set(id, session.engineSessionId);
    return { ...session, engineSessionId: id };
  }
  override subscribe(id: string) {
    const events = super.subscribe(this.aliases.get(id) ?? id);
    return (async function* () {
      for await (const event of events) yield { ...event, engineSessionId: id };
    })();
  }
  override send(id: string, input: AgentInput) {
    this.inputs.push(input);
    return super.send(this.aliases.get(id) ?? id, input);
  }
  override close(id: string) {
    return super.close(this.aliases.get(id) ?? id);
  }
}

async function setup(app: 'claude' | 'codex' = 'claude') {
  const root = temp();
  const project = join(root, 'project');
  mkdirSync(project);
  const storage = storages.open(join(root, 'db'));
  const events = new EventStore({ storage });
  const adapter = new NativeMock({ stepDelayMs: 0, chunkSize: 16_384 });
  const historyDir = join(root, 'history');
  const prepare = vi.fn(async (_id: SessionId, _target: { engineSessionId?: string }) => undefined);
  const createManager = (store = events) => {
    const manager = new SessionManager({
      storage,
      events: store,
      adapter,
      engine: 'echo',
      historyDir,
      contexts: { prepare, bind: () => undefined, forget: () => {} },
      engineFeatures: {
        claude: { engine: 'echo', historyTool: true },
        chatgpt: { engine: 'echo', historyTool: true },
        'openai-compatible': { engine: 'echo', historyTool: true },
      },
    });
    managers.push(manager);
    return manager;
  };
  const manager = createManager();
  const path = join(root, 'source.jsonl');
  const source = readFileSync(
    new URL(`./external-import/fixtures/${app}-session.jsonl`, import.meta.url),
    'utf8',
  ).replaceAll('/workspace/demo', project.replaceAll('\\', '\\\\'));
  writeFileSync(path, source);
  const info = await (app === 'claude' ? parseClaudeSession : parseCodexSession)(path);
  if (!info) throw new Error('fixture missing');
  const imported = await new SessionImports(storage, events).apply({
    ...info,
    app,
    path,
    key: 'session:fixture',
  });
  const id = imported.sessionId as SessionId;
  const at = info.startedAt;
  for (const [providerId, kind] of [
    ['claude', 'claude'],
    ['chatgpt', 'chatgpt'],
    ['mock', 'openai-compatible'],
  ] as const)
    storage.providers.insert({
      id: providerId,
      kind,
      displayName: providerId,
      models: [{ id: 'demo-model' }],
      defaultModelId: 'demo-model',
      createdAt: at,
      updatedAt: at,
    });
  return {
    storage,
    events,
    adapter,
    manager,
    createManager,
    historyDir,
    id,
    path,
    source,
    prepare,
  };
}

async function send(
  env: Awaited<ReturnType<typeof setup>>,
  manager: SessionManager,
  id: SessionId,
) {
  await manager.send(
    { sessionId: id, content: [{ type: 'text', text: 'Continue the counter' }] },
    identity,
  );
  await vi.waitFor(() => expect(env.storage.sessions.get(id)?.state).toBe('idle'));
}

describe('createFromHistory', () => {
  it.each(['claude', 'codex'] as const)(
    '%s uses native resume only for a matching tool/directory and keeps the source read-only',
    async (app) => {
      const env = await setup(app);
      env.adapter.native = true;
      const sourceSeq = env.events.snapshot(env.id)?.session.lastSeq;
      const continued = await env.manager.createFromHistory(env.id);
      expect(continued).toMatchObject({
        origin: { kind: 'history', sessionId: env.id, via: 'native' },
        state: 'idle',
      });
      expect(continued.id).not.toBe(env.id);
      expect(env.adapter.resumed).toEqual([
        app === 'claude'
          ? '11111111-1111-4111-8111-111111111111'
          : '22222222-2222-4222-8222-222222222222',
      ]);
      expect(env.adapter.inputs).toHaveLength(0);
      expect(env.prepare.mock.calls.at(-1)?.[1]).toMatchObject({
        engineSessionId: env.adapter.resumed[0],
      });
      await send(env, env.manager, continued.id);
      expect(env.adapter.inputs[0]?.content).toEqual([
        { type: 'text', text: 'Continue the counter' },
      ]);
      expect(env.events.snapshot(env.id)?.session).toMatchObject({
        readOnly: { reason: 'imported' },
        lastSeq: sourceSeq,
      });
      expect(readFileSync(env.path, 'utf8')).toBe(env.source);
      await expect(env.manager.resume(env.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
      const removeEngine = vi.spyOn(env.adapter, 'deleteSession');
      await env.manager.archive(continued.id, true);
      await env.manager.delete(continued.id);
      await env.manager.archive(env.id, true);
      await env.manager.delete(env.id);
      expect(removeEngine).not.toHaveBeenCalled();
      expect(readFileSync(env.path, 'utf8')).toBe(env.source);
    },
  );

  it.each(['different-directory', 'native-rejected', 'different-tool'])(
    '%s falls back to a persisted full-thread summary and history tool',
    async (mode) => {
      const env = await setup();
      env.adapter.native = mode !== 'different-directory';
      env.adapter.rejected = mode === 'native-rejected';
      const continued = await env.manager.createFromHistory(
        env.id,
        mode === 'different-tool' ? { providerId: 'mock' } : {},
      );
      expect(continued.origin).toMatchObject({ kind: 'history', via: 'handoff' });
      expect(env.adapter.resumed).toHaveLength(mode === 'native-rejected' ? 1 : 0);
      expect(env.prepare.mock.calls.at(-1)?.[1].engineSessionId).toBeUndefined();
      if (mode === 'native-rejected')
        expect(env.prepare.mock.calls[0]?.[1].engineSessionId).toBeDefined();
      expect(env.adapter.inputs).toHaveLength(0);
      await env.manager.dispose();
      const reloadedEvents = new EventStore({ storage: env.storage });
      const reloaded = env.createManager(reloadedEvents);
      expect(reloadedEvents.handoffState(continued.id)?.context).toContain('Repair the counter');
      const file = JSON.parse(readFileSync(join(env.historyDir, `${env.id}.json`), 'utf8'));
      expect(file.items.some((item: { text: string }) => item.text === 'Add a counter check')).toBe(
        true,
      );
      await send(env, reloaded, continued.id);
      const input = JSON.stringify(env.adapter.inputs[0]);
      expect(input).toContain('Repair the counter');
      expect(input).toContain('read_session_history');
      expect(reloadedEvents.handoffState(continued.id)?.context).toBeUndefined();
    },
  );

  it('also continues a Wevir read-only session; writable sessions are refused', async () => {
    const env = await setup();
    const original = await env.manager.create({
      workspaceId: env.events.snapshot(env.id)?.session.workspaceId,
      providerId: 'mock',
    });
    await expect(env.manager.createFromHistory(original.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await send(env, env.manager, original.id);
    await env.manager.close(original.id);
    env.events.append(original.id, {
      type: 'session.read_only',
      source: 'host',
      payload: { reason: 'engine_session_not_found', message: 'mock missing log' },
    });
    const continued = await env.manager.createFromHistory(original.id);
    expect(continued.origin).toMatchObject({
      kind: 'history',
      sessionId: original.id,
      via: 'handoff',
    });
    await send(env, env.manager, continued.id);
    expect(env.adapter.resumed).toHaveLength(0);
    expect(JSON.stringify(env.adapter.inputs.at(-1))).toContain('Continue the counter');
  });
});
