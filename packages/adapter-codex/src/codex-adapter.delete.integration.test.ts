// 删除会话（0.43.0，codex-event-mapping.md §6.16）：真实 codex-app-server + 网关 + mock 模型。`deleteSession` 用 `thread/delete`
// 删掉 rollout，之后（同一进程或换了进程）都恢复不了；Codex 没有的 thread 算成功；挂着的会话先关闭。

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  newAdapter,
  runTurn,
  TempDirs,
} from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('adapter-codex 删除');
const dirs = new TempDirs();
let mock: MockModel;
const adapters: CodexAdapter[] = [];

function adapter(home: string): CodexAdapter {
  const created = newAdapter({ home, providers: [mockProvider(mock)] });
  adapters.push(created);
  return created;
}

function rollouts(home: string): string[] {
  const dir = join(home, 'engines', 'codex', 'sessions');
  try {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) =>
      name.endsWith('.jsonl'),
    );
  } catch {
    return [];
  }
}

describe.skipIf(binary === undefined)(
  'CodexAdapter 删除会话（真实 codex-app-server）',
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      mock = await startMockModel((view) => ({ text: [`收到：${view.lastUserText}`] }));
    });
    afterEach(async () => {
      await Promise.allSettled(adapters.splice(0).map((created) => created.dispose()));
    });
    afterAll(async () => {
      await mock?.close();
      dirs.cleanup();
    });

    it('删掉 rollout，之后恢复报 session_lost；别的会话不受影响；没有的 thread 算成功', async () => {
      const { home, workspace } = dirs.make('delete');
      const config = { cwd: workspace, providerId: 'mock', modelId: MOCK_MODEL };
      const first = adapter(home);
      const { engineSessionId: id } = await first.createSession(config);
      const { engineSessionId: other } = await first.createSession(config);
      await runTurn(first, id, '你好', collectEvents(first, id));
      await runTurn(first, other, '另一个', collectEvents(first, other));
      expect(rollouts(home).filter((name) => name.includes(id))).toHaveLength(1);

      // 挂着的会话：先关闭再删。
      await first.deleteSession(id);
      expect(first.hasSession(id)).toBe(false);
      expect(rollouts(home).filter((name) => name.includes(id))).toEqual([]);
      expect(rollouts(home).filter((name) => name.includes(other))).toHaveLength(1);
      await expect(first.resumeSession(id, config)).rejects.toMatchObject({
        code: 'session_lost',
      });
      // 再删一次、删一个 Codex 从没见过的 thread：都算成功。
      await first.deleteSession(id);
      await first.deleteSession('019a0000-0000-7000-8000-000000000000');
      await first.close(other);
      await first.dispose();

      // 换了进程（Host 重启后）：适配器不认识这个会话，照样交给 Codex 删。
      const second = adapter(home);
      await second.deleteSession(other);
      expect(rollouts(home)).toEqual([]);
      await expect(second.resumeSession(other, config)).rejects.toMatchObject({
        code: 'session_lost',
      });
    });
  },
);
