import { mkdir } from 'node:fs/promises';
import { EventStore } from '../../packages/host/dist/index.js';
import { openStorage } from '../../packages/storage/dist/index.js';

export const PROVIDER = 'perf-echo';
export const WORKSPACE = 'ws_perf';
export const DELETE_SESSION = 'ses_perf0';

export async function seedLibrary(home, workspace, libraryMiB) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const storage = openStorage({ dataDir: home });
  const events = new EventStore({ storage });
  const at = '2026-01-01T00:00:00.000Z';
  try {
    if (!storage.workspaces.get(WORKSPACE))
      storage.workspaces.insert({
        id: WORKSPACE,
        rootPath: workspace,
        displayName: 'Performance fixture',
        createdAt: at,
        updatedAt: at,
      });
    if (!storage.providers.get(PROVIDER))
      storage.providers.insert({
        id: PROVIDER,
        kind: 'openai-compatible',
        displayName: 'Offline Echo',
        api: 'openai-responses',
        baseURL: 'http://127.0.0.1:9/v1',
        models: [{ id: 'echo', displayName: 'Echo' }],
        defaultModelId: 'echo',
        createdAt: at,
        updatedAt: at,
      });
    const output = 'Synthetic tool output: fixed content for repeatable SQLite measurements.\n'
      .repeat(1000)
      .slice(0, 64 * 1024);
    let updates = 0;
    const sessions = libraryMiB > 0 ? 16 : 0;
    for (let index = 0; index < sessions; index++) {
      const id = `ses_perf${index}`;
      const turnId = `trn_perf${index}`;
      storage.sessions.insert({
        id,
        workspaceId: WORKSPACE,
        cwd: workspace,
        engine: 'echo',
        engineSessionId: `seed-${index}`,
        providerId: PROVIDER,
        modelId: 'echo',
        title: `Library ${index}`,
        titleSource: 'user',
        state: 'idle',
        lastSeq: 0,
        createdAt: at,
        updatedAt: at,
      });
      const append = (type, payload, source = 'host') =>
        events.append(id, { type, payload, source, ts: at });
      append('session.created', {
        workspaceId: WORKSPACE,
        cwd: workspace,
        providerId: PROVIDER,
        modelId: 'echo',
      });
      append('turn.started', { turnId });
      append('session.state_changed', { from: 'idle', to: 'running', reason: 'turn_started' });
      append(
        'tool.started',
        {
          turnId,
          toolCallId: 'seed',
          toolName: 'echo',
          display: { kind: 'shell', command: 'synthetic-output' },
        },
        'engine',
      );
      const rows = Math.ceil(
        (libraryMiB * 1024 * 1024 * (index === 0 ? 1 / 3 : 2 / 45)) / output.length,
      );
      for (let row = 0; row < rows; row++) {
        append(
          'tool.updated',
          { turnId, toolCallId: 'seed', output: { text: output, truncated: false } },
          'engine',
        );
      }
      updates += rows;
      append(
        'tool.finished',
        {
          turnId,
          toolCallId: 'seed',
          status: 'completed',
          output: { text: output, truncated: false },
        },
        'engine',
      );
      append('turn.finished', { turnId, outcome: 'completed', durationMs: 1 });
      append('session.state_changed', { from: 'running', to: 'idle', reason: 'turn_finished' });
      append('session.state_changed', { from: 'idle', to: 'closed', reason: 'closed' });
      storage.sessions.setArchived(id, at);
    }
    return {
      sessions,
      updates,
      payloadMiB: libraryMiB,
      deleteSessionId: sessions ? DELETE_SESSION : null,
    };
  } finally {
    events.close();
    storage.close();
  }
}
