import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Script, startMockChat, startMockMessages } from '@wevir/model-gateway/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { CodexRuntime } from './codex-runtime.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  collectingLogger,
  NO_RETRIES,
  runTurn,
  TempDirs,
} from './test-fixtures/harness.js';
import { MOCK_MODEL, mockProvider } from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('Codex 进程池 Chat / Messages');
const dirs = new TempDirs();
afterAll(() => dirs.cleanup());

describe.skipIf(binary === undefined)('进程池网关协议与历史恢复', { timeout: 60_000 }, () => {
  it.each([
    { api: 'openai-completions' as const, start: startMockChat },
    { api: 'anthropic-messages' as const, start: startMockMessages },
  ])('$api 的命令、补丁与重启后历史恢复', async ({ api, start }) => {
    const { home, workspace } = dirs.make(api);
    const patch = '*** Begin Patch\n*** Add File: pool.txt\n+pool-patched\n*** End Patch';
    const script: Script = ({ index }) => {
      if (index === 0)
        return {
          toolCalls: [
            {
              kind: 'function',
              name: 'exec_command',
              args: { cmd: 'node -e "process.stdout.write(\'12345\')"' },
            },
          ],
        };
      if (index === 1)
        return { toolCalls: [{ kind: 'function', name: 'apply_patch', args: { input: patch } }] };
      return { text: ['done'] };
    };
    const upstream = await start(script);
    const providers = [mockProvider(upstream, { id: 'mock', api })];
    const create = () =>
      new CodexRuntime({
        home,
        binary,
        providers,
        providerExtra: NO_RETRIES,
        logger: collectingLogger(),
      });
    let adapter = create();
    try {
      const config = {
        cwd: workspace,
        providerId: 'mock',
        modelId: MOCK_MODEL,
        permissionMode: 'full_access' as const,
      };
      const session = await adapter.createSession(config);
      const events = await runTurn(
        adapter,
        session.engineSessionId,
        'save protocol history',
        collectEvents(adapter, session.engineSessionId),
      );
      expect(events.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(events.find((event) => event.type === 'tool.finished')).toMatchObject({
        status: 'completed',
        exitCode: 0,
        output: '12345',
      });
      expect(readFileSync(join(workspace, 'pool.txt'), 'utf8').trim()).toBe('pool-patched');
      expect(JSON.stringify(upstream.requests.map((r) => r.body))).toContain('12345');
      await adapter.dispose();
      adapter = create();
      await adapter.resumeSession(session.engineSessionId, config);
      expect(
        (
          await runTurn(
            adapter,
            session.engineSessionId,
            'resume protocol history',
            collectEvents(adapter, session.engineSessionId),
          )
        ).at(-1)?.type,
      ).toBe('turn.settled');
      const history = JSON.stringify(upstream.requests.at(-1)?.body);
      expect(history).toContain('save protocol history');
      expect(history).toContain('pool-patched');
    } finally {
      await adapter.dispose();
      await upstream.close();
    }
  });
});
