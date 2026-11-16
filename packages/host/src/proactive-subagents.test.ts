// 主动派子智能体（Host 设置 `proactiveSubagents`）：建立与恢复会话时按当时的设置交给引擎的 `SessionConfig`，关着时不带。

import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { describe, expect, it, vi } from 'vitest';
import { EventStore } from './event-store.js';
import { createHostMethods } from './host-methods.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const context = { client: identity, capabilities: {} };

describe('proactive subagents', () => {
  it('建立与恢复时按当时的设置给引擎，关着时不带', async () => {
    const root = realpathSync(tempDir());
    const dataDir = join(root, 'data');
    const project = join(root, 'project');
    mkdirSync(dataDir);
    mkdirSync(project);
    const storage = storages.open(dataDir);
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const adapter = new EchoAdapter({ stepDelayMs: 0 });
    const create = vi.spyOn(adapter, 'createSession');
    const resume = vi.spyOn(adapter, 'resumeSession');
    let enabled = false;
    const sessions = new SessionManager({
      storage,
      events,
      adapter,
      worktreesDir: join(dataDir, 'worktrees'),
      proactiveSubagents: () => enabled,
    });
    const methods = createHostMethods({
      storage,
      events,
      sessions,
      secrets: new FileSecretStore(dataDir),
    });
    storage.providers.insert({
      id: 'mock',
      kind: 'openai-compatible',
      displayName: 'Mock',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:9/v1',
      models: [{ id: 'm' }],
      defaultModelId: 'm',
      createdAt: '2026-11-16T00:00:00.000Z',
      updatedAt: '2026-11-16T00:00:00.000Z',
    });
    const { workspace } = await methods['workspace.add']({ rootPath: project }, context);

    const { session } = await methods['session.create'](
      { workspaceId: workspace.id, providerId: 'mock' },
      context,
    );
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('proactiveSubagents');

    enabled = true;
    await methods['session.close']({ sessionId: session.id }, context);
    await methods['session.resume']({ sessionId: session.id }, context);
    expect(resume.mock.calls.at(-1)?.[1]).toMatchObject({ proactiveSubagents: true });
    await methods['session.create']({ workspaceId: workspace.id, providerId: 'mock' }, context);
    expect(create.mock.calls[1]?.[0]).toMatchObject({ proactiveSubagents: true });
  });
});
