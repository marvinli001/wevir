import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentEvent, isTurnTerminal } from '@wevir/runtime-adapter';
import { expect, it, vi } from 'vitest';
import { OPENCODE_BIN_ENV } from './executable.js';
import { OpenCodeAdapter, openCodeEngineDir } from './opencode-adapter.js';
import { isolatedOpenCodeEnv, startMockModel } from './test-fixtures/mock-model.js';

const binary = process.env.WEVIR_TEST_OPENCODE_V2_BIN;

it.skipIf(!binary)(
  'OpenCode 2 冷启动、模型目录、流式回合、恢复与分支使用隔离的账号数据库',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wevir-opencode-v2-')));
    const model = await startMockModel();
    const home = join(root, 'wevir');
    const foreignDb = join(root, 'other.db');
    const accountHome = join(root, 'second-account');
    const env = {
      ...isolatedOpenCodeEnv(root, model.baseUrl),
      [OPENCODE_BIN_ENV]: binary,
      OPENCODE_DB: foreignDb,
    };
    const options = {
      home,
      env,
      idleTtlMs: 100,
      installer: null,
      sdk: async () => {
        throw new Error('OpenCode 2 must not load the 1.x SDK');
      },
    };
    const adapter = new OpenCodeAdapter(options);
    const second = new OpenCodeAdapter({ ...options, account: { dataHome: accountHome } });
    const config = {
      cwd: root,
      modelId: 'mock/echo',
      providerId: 'opencode',
      permissionMode: 'on_request' as const,
      ruleInstructions: 'Use the Wevir test rule.',
    };
    try {
      expect(adapter.serverPid).toBeUndefined();
      const state = await adapter.accounts.read('opencode');
      expect(state.lastError).toBeUndefined();
      expect(state).toMatchObject({ status: 'signed_in', version: expect.stringMatching(/^2\./) });
      expect(state.loginCommand).toContain('--standalone auth login');
      expect(await adapter.accounts.models('opencode')).toMatchObject({
        models: expect.arrayContaining([expect.objectContaining({ id: 'mock/echo' })]),
      });
      const { engineSessionId } = await adapter.createSession(config);
      expect(await adapter.listCommands(engineSessionId)).not.toContainEqual(
        expect.objectContaining({ name: 'review' }),
      );
      await expect(
        adapter.send(engineSessionId, { content: [{ type: 'text', text: '/review' }] }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      const events: AgentEvent[] = [];
      const read = (async () => {
        for await (const event of adapter.subscribe(engineSessionId)) events.push(event);
      })();
      await adapter.send(engineSessionId, { content: [{ type: 'text', text: 'Say hello' }] });
      await vi.waitFor(() => expect(events.some(isTurnTerminal)).toBe(true), { timeout: 10_000 });
      expect(events).toContainEqual(expect.objectContaining({ type: 'assistant.message' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'turn.settled' }));
      expect(JSON.stringify(model.requests)).toContain('Use the Wevir test rule.');

      await adapter.close(engineSessionId);
      await read;
      await vi.waitFor(() => expect(adapter.serverPid).toBeUndefined());
      await expect(adapter.resumeSession(engineSessionId, config)).resolves.toMatchObject({
        engineSessionId,
      });
      const branch = await adapter.fork(engineSessionId, {
        ...config,
        permissionMode: 'full_access',
      });
      expect(branch.engineSessionId).not.toBe(engineSessionId);
      expect(await adapter.listCommands(branch.engineSessionId)).toContainEqual(
        expect.objectContaining({ name: 'review' }),
      );
      const commandEvents: AgentEvent[] = [];
      void (async () => {
        for await (const event of adapter.subscribe(branch.engineSessionId))
          commandEvents.push(event);
      })();
      await adapter.send(branch.engineSessionId, { content: [{ type: 'text', text: '/review' }] });
      await vi.waitFor(() => expect(commandEvents.some(isTurnTerminal)).toBe(true), {
        timeout: 10_000,
      });
      expect(commandEvents).toContainEqual(expect.objectContaining({ type: 'turn.settled' }));

      await expect(second.resumeSession(engineSessionId, config)).rejects.toMatchObject({
        code: 'session_lost',
      });
      expect(existsSync(join(openCodeEngineDir(home), 'v2-data', 'opencode', 'opencode.db'))).toBe(
        true,
      );
      expect(existsSync(join(accountHome, 'v2-data', 'opencode', 'opencode.db'))).toBe(true);
      expect(existsSync(foreignDb)).toBe(false);
    } finally {
      await Promise.all([adapter.dispose(), second.dispose()]);
      await model.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  45_000,
);
