// WEVIR_CODEX_LEGACY_BIN 指向保留的 0.165.0；WEVIR_CODEX_BIN 为当前锁定版本。
import { execFileSync } from 'node:child_process';
import { startModelGateway } from '@wevir/model-gateway';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CodexProcess } from './codex-process.js';
import { CodexRuntime } from './codex-runtime.js';
import { renderConfigToml, renderModelCatalog, writeCodexConfig } from './config.js';
import { buildCodexEnv } from './env.js';
import { codexPaths, prepareCodexHome } from './paths.js';
import type { ThreadResumeResponse, ThreadStartResponse, TurnStartResponse } from './protocol.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  collectingLogger,
  NO_RETRIES,
  runTurn,
  TempDirs,
} from './test-fixtures/harness.js';
import { MOCK_MODEL, mockProvider, startMockModel } from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('Codex 升级回退兼容');
const legacy = process.env.WEVIR_CODEX_LEGACY_BIN;
const dirs = new TempDirs();
afterAll(() => dirs.cleanup());

describe.skipIf(binary === undefined || !legacy)(
  'Codex 单进程 → 进程池 → 旧二进制',
  { timeout: 90_000 },
  () => {
    it('两个服务商的旧 thread 与暂停目标无需迁移，升级后再回退仍能续聊', async () => {
      expect(execFileSync(legacy as string, ['--version'], { encoding: 'utf8' }).trim()).toBe(
        'codex-app-server 0.165.0',
      );
      const { home, workspace } = dirs.make('compat');
      const mock = await startMockModel();
      const providers = ['a', 'b'].map((id) => mockProvider(mock, { id }));
      const config = (providerId: string) => ({ providerId, modelId: MOCK_MODEL, cwd: workspace });
      const paths = prepareCodexHome(codexPaths(home));
      const close: Array<() => Promise<unknown>> = [() => mock.close()];
      async function singleProcess() {
        const gateway = await startModelGateway();
        gateway.setProviders(providers);
        close.push(() => gateway.close());
        const catalog = renderModelCatalog(providers, () => 'Wevir compatibility mock.');
        const toml = renderConfigToml({
          providers,
          gatewayBaseURL: (id) => gateway.baseURL(id),
          catalogFile: paths.catalogFile,
          providerExtra: NO_RETRIES,
        }).replace(
          /^deferred_tool_world_state = false\n|^plugin_discovery_prefetch = false\n/gm,
          '',
        );
        writeCodexConfig(paths, toml, catalog);
        const notifications: Array<{ method: string; params: unknown }> = [];
        const process = new CodexProcess({
          clientInfo: { name: 'wevir', version: 'compatibility-test' },
          launcher: {
            prepare: async () => ({
              command: legacy as string,
              args: ['--strict-config'],
              options: {
                cwd: paths.codexHome,
                env: buildCodexEnv({ codexHome: paths.codexHome, gatewayToken: gateway.token }),
                stdio: ['pipe', 'pipe', 'pipe'],
                detached: globalThis.process.platform !== 'win32',
                windowsHide: true,
              },
            }),
          },
          onNotification: (method, params) => notifications.push({ method, params }),
        });
        close.push(() => process.dispose());
        await process.start();
        async function turn(threadId: string, text: string) {
          const response = await process.request<TurnStartResponse>('turn/start', {
            threadId,
            input: [{ type: 'text', text }],
          });
          await vi.waitFor(
            () => {
              const done = notifications.find((entry) => {
                const params = entry.params as {
                  threadId?: string;
                  turn?: { id: string; status: string };
                };
                return (
                  entry.method === 'turn/completed' &&
                  params.threadId === threadId &&
                  params.turn?.id === response.turn.id
                );
              });
              expect(
                (done?.params as { turn?: { status: string } } | undefined)?.turn?.status,
              ).toBe('completed');
            },
            { timeout: 30_000 },
          );
        }
        return {
          process,
          turn,
          stop: async () => {
            await process.dispose();
            await gateway.close();
          },
        };
      }
      try {
        const original = await singleProcess();
        const threads: string[] = [];
        for (const provider of providers) {
          const started = await original.process.request<ThreadStartResponse>('thread/start', {
            model: MOCK_MODEL,
            modelProvider: `wevir_${provider.id}`,
            cwd: workspace,
            approvalPolicy: 'never',
            sandbox: 'workspace-write',
          });
          threads.push(started.thread.id);
          await original.turn(started.thread.id, `legacy-history-${provider.id}`);
        }
        await original.process.request('thread/goal/set', {
          threadId: threads[0],
          objective: 'Keep this paused objective',
          status: 'paused',
        });
        await original.stop();
        const pooled = new CodexRuntime({
          home,
          binary,
          providers,
          providerExtra: NO_RETRIES,
          logger: collectingLogger(),
        });
        close.push(() => pooled.dispose());
        for (const [index, provider] of providers.entries()) {
          const id = threads[index] as string;
          await pooled.resumeSession(id, config(provider.id));
          const result = await runTurn(
            pooled,
            id,
            `pooled-history-${provider.id}`,
            collectEvents(pooled, id),
          );
          expect(result.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
          expect(JSON.stringify(mock.requests.at(-1)?.body.input)).toContain(
            `legacy-history-${provider.id}`,
          );
        }
        const goal = await pooled.gatewayAdapters
          .get('a')
          ?.process.request('thread/goal/get', { threadId: threads[0] });
        expect(goal).toMatchObject({
          goal: { objective: 'Keep this paused objective', status: 'paused' },
        });
        await pooled.dispose();
        const rollback = await singleProcess();
        for (const [index, provider] of providers.entries()) {
          const id = threads[index] as string;
          await rollback.process.request<ThreadResumeResponse>('thread/resume', {
            threadId: id,
            model: MOCK_MODEL,
            modelProvider: `wevir_${provider.id}`,
            cwd: workspace,
            excludeTurns: true,
          });
          await rollback.turn(id, `rollback-history-${provider.id}`);
          const input = JSON.stringify(mock.requests.at(-1)?.body.input);
          expect(input).toContain(`legacy-history-${provider.id}`);
          expect(input).toContain(`pooled-history-${provider.id}`);
        }
        expect(
          await rollback.process.request('thread/goal/get', { threadId: threads[0] }),
        ).toMatchObject({ goal: { status: 'paused' } });
      } finally {
        for (const action of close.reverse()) await action();
      }
    });
  },
);
