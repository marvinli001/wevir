// 调优的档案（0.85.0）在 SessionManager 上：建会话记下版本、`session.rules` 带上版本、恢复时重取、分支沿用当时的版本。

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId, WevirEvent } from '@wevir/protocol';
import type { EngineRuleFiles } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { EventStore } from '../event-store.js';
import { discoverRuleFiles } from '../rule-files.js';
import { SessionManager } from '../session-manager.js';
import { useStorages, useTempDir } from '../test-utils.js';
import { ProfileBlobStore } from './blobs.js';
import { ProfileCollector } from './profile.js';
import { TuningService } from './service.js';

const tempDir = useTempDir();
const storages = useStorages();
const T0 = '2026-10-21T00:00:00.000Z';

/** 像 Codex 一样自己读 AGENTS.md 的 echo 引擎：会写 `session.rules`。 */
class RulesEcho extends EchoAdapter {
  ruleFiles(): EngineRuleFiles {
    return { user: [], project: ['agents'], imports: false, instructions: true };
  }
}

describe('档案版本（SessionManager）', () => {
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  });

  function setup(adapter: EchoAdapter) {
    const root = join(realpathSync(tempDir()), `t${managers.length}`);
    const home = join(root, 'home');
    const project = join(root, 'ws');
    mkdirSync(join(project, '.git'), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(project, 'AGENTS.md'), 'Run pnpm test.');
    const storage = storages.open(join(root, 'data'));
    storage.workspaces.insert({
      id: 'ws_1',
      rootPath: project,
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
    const discover = (cwd: string) => discoverRuleFiles({ cwd, home, env: {} });
    const tuning = new TuningService({
      storage,
      collector: new ProfileCollector({ userHome: home, ruleFiles: discover }),
      blobs: new ProfileBlobStore(join(root, 'data', 'tuning', 'blobs')),
    });
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const manager = new SessionManager({
      storage,
      events,
      adapter,
      engine: 'echo',
      ruleFiles: { discover },
      profile: { ensure: (workspaceId) => tuning.ensure(workspaceId) },
    });
    managers.push(manager);
    return { storage, events, manager, project };
  }

  const rulesEvents = (events: EventStore, sessionId: SessionId) =>
    events
      .readSince(sessionId, 0)
      .filter(
        (event): event is Extract<WevirEvent, { type: 'session.rules' }> =>
          event.type === 'session.rules',
      );

  it('不读规则文件的引擎：会话照样记下版本，同样的配置沿用同一版', async () => {
    const env = setup(new EchoAdapter({ stepDelayMs: 0 }));
    const a = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const b = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const version = env.storage.sessions.get(a.id)?.profileVersionId;
    expect(version).toMatch(/^pfv_/);
    expect(env.storage.sessions.get(b.id)?.profileVersionId).toBe(version);
    expect(rulesEvents(env.events, a.id as SessionId)).toEqual([]);
    expect(
      env.storage.profileVersions.sessionCounts([version as string]).get(version as string),
    ).toBe(2);
  });

  it('session.rules 带版本；改了配置后新会话开新版本，恢复的会话写下新版本', async () => {
    const env = setup(new RulesEcho({ stepDelayMs: 0 }));
    const session = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const id = session.id as SessionId;
    const first = session.rules?.profileVersion;
    expect(first).toMatchObject({ seq: 1 });
    expect(env.storage.sessions.get(id)?.profileVersionId).toBe(first?.id);

    // 没变：恢复不重写。
    await env.manager.close(id);
    await env.manager.resume(id);
    expect(rulesEvents(env.events, id)).toHaveLength(1);

    writeFileSync(join(env.project, 'CLAUDE.md'), 'Indent with tabs.');
    await env.manager.close(id);
    await env.manager.resume(id);
    const events = rulesEvents(env.events, id);
    expect(events.at(-1)?.payload.profileVersion).toMatchObject({ seq: 2 });
    // 会话建时用的版本不变。
    expect(env.storage.sessions.get(id)?.profileVersionId).toBe(first?.id);

    const next = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    expect(next.rules?.profileVersion?.seq).toBe(2);
  });
});
