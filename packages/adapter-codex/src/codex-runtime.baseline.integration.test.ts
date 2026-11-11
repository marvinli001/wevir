// 两份真实二进制、同一网关和工作区；无模型服务请求。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { startModelGateway } from '@wevir/model-gateway';
import { startMockChat, startMockMessages } from '@wevir/model-gateway/testing';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CodexProcess } from './codex-process.js';
import { renderConfigToml, renderModelCatalog, writeCodexConfig } from './config.js';
import { buildCodexEnv } from './env.js';
import { CODEX_VERSION, codexPaths, prepareCodexHome } from './paths.js';
import { BasePrompt, defaultPromptsDir } from './prompts.js';
import type { ThreadStartResponse, TurnStartResponse } from './protocol.js';
import { writeSuggestTasksServer } from './suggest-tasks.js';
import { codexBinaryOrSkip, NO_RETRIES, TempDirs } from './test-fixtures/harness.js';
import { MOCK_MODEL, mockProvider, startMockModel } from './test-fixtures/mock-model.js';

const current = codexBinaryOrSkip('Codex 升级请求基线');
const legacy = process.env.WEVIR_CODEX_LEGACY_BIN;
const dirs = new TempDirs();
afterAll(() => dirs.cleanup());

function normalized(value: unknown): unknown {
  if (typeof value === 'string')
    return value
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
      .replace(/call_wevir_mock_\d+|toolu_\d+|(?:call|resp|msg_resp)_\d+/g, '<response-id>')
      .replace(/Chunk ID: \S+/g, 'Chunk ID: <chunk>')
      .replace(/Wall time: [\d.]+ seconds/g, 'Wall time: <duration> seconds');
  if (Array.isArray(value)) return value.map(normalized);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalized(item)]),
    );
  return value;
}

describe.skipIf(!current || !legacy || process.platform === 'win32')(
  '165 / 167 mock 上游请求基线',
  { timeout: 90_000 },
  () => {
    it.each(['openai-responses', 'openai-completions', 'anthropic-messages'] as const)(
      '%s 的逐请求上下文与工具声明',
      async (api) => {
        const reply = ({ index }: { index: number }) =>
          index % 3 === 1
            ? {
                toolCalls: [
                  {
                    kind: 'function' as const,
                    name: 'exec_command',
                    args: { cmd: 'printf baseline-output' },
                  },
                ],
              }
            : { text: ['baseline reply'] };
        const upstream =
          api === 'openai-responses'
            ? await startMockModel(reply)
            : api === 'openai-completions'
              ? await startMockChat(reply)
              : await startMockMessages(reply);
        const { home, workspace } = dirs.make('request-baseline');
        const paths = prepareCodexHome(codexPaths(home));
        const providers = [mockProvider(upstream, { api })];
        const gateway = await startModelGateway();
        gateway.setProviders(providers);
        const prompt = new BasePrompt(defaultPromptsDir());
        const catalog = renderModelCatalog(providers, (vars) => prompt.render(vars));
        const suggestTasks = writeSuggestTasksServer(paths.codexHome);
        const runs: Array<{
          version: string;
          bodies: unknown[];
          sizes: number[];
          toolBytes: number[];
          toolDigests: string[];
        }> = [];
        try {
          for (const [version, binary] of [
            ['0.165.0', legacy],
            [CODEX_VERSION.replace('rust-v', ''), current],
          ] as const) {
            const start = upstream.requests.length;
            const toml = renderConfigToml({
              providers,
              gatewayBaseURL: (id) => gateway.baseURL(id),
              catalogFile: paths.catalogFile,
              providerExtra: NO_RETRIES,
              suggestTasks,
            });
            writeCodexConfig(
              paths,
              version === '0.165.0'
                ? toml.replace(
                    /^deferred_tool_world_state = false\n|^plugin_discovery_prefetch = false\n/gm,
                    '',
                  )
                : toml,
              catalog,
            );
            const terminal = new Set<string>();
            const process = new CodexProcess({
              launcher: {
                prepare: async () => ({
                  command: binary as string,
                  args: ['--strict-config', '-c', 'model_provider="wevir_mock"'],
                  options: {
                    cwd: paths.codexHome,
                    env: buildCodexEnv({ codexHome: paths.codexHome, gatewayToken: gateway.token }),
                    stdio: ['pipe', 'pipe', 'pipe'],
                    detached: globalThis.process.platform !== 'win32',
                    windowsHide: true,
                  },
                }),
              },
              clientInfo: { name: 'wevir', version: 'upgrade-baseline' },
              onNotification: (method, params) => {
                if (method === 'turn/completed') {
                  const turn = (params as { turn: { id: string; status: string } }).turn;
                  if (turn.status === 'completed') terminal.add(turn.id);
                }
              },
            });
            try {
              const initialized = await process.start();
              expect(initialized.userAgent.split(' ')[0]).toBe(`wevir/${version}`);
              const { thread } = await process.request<ThreadStartResponse>('thread/start', {
                model: MOCK_MODEL,
                modelProvider: 'wevir_mock',
                cwd: workspace,
                approvalPolicy: 'never',
                sandbox: 'workspace-write',
              });
              for (const text of ['baseline first', 'baseline tool']) {
                const result = await process.request<TurnStartResponse>('turn/start', {
                  threadId: thread.id,
                  input: [{ type: 'text', text }],
                });
                await vi.waitFor(() => expect(terminal.has(result.turn.id)).toBe(true), {
                  timeout: 30_000,
                });
              }
            } finally {
              await process.dispose();
            }
            const bodies = upstream.requests.slice(start).map((request) => request.body);
            const tools = bodies.map((body) => (body as { tools?: unknown }).tools);
            runs.push({
              version,
              bodies: bodies.map(normalized),
              sizes: bodies.map((body) => Buffer.byteLength(JSON.stringify(body))),
              toolBytes: tools.map((value) => Buffer.byteLength(JSON.stringify(value))),
              toolDigests: tools.map((value) =>
                createHash('sha256')
                  .update(JSON.stringify(normalized(value)))
                  .digest('hex'),
              ),
            });
          }
          console.log(
            `CODEX_REQUEST_BASELINE ${JSON.stringify({ api, runs: runs.map(({ bodies: _bodies, ...stats }) => stats) })}`,
          );
          expect(runs[0]?.bodies).toHaveLength(3);
          expect(runs[1]?.bodies).toHaveLength(3);
          expect(runs[1]?.toolDigests, '工具声明').toEqual(runs[0]?.toolDigests);
          expect(runs[1]?.sizes, '逐请求原始字节数').toEqual(runs[0]?.sizes);
          expect(runs[1]?.toolBytes, '工具声明字节数').toEqual(runs[0]?.toolBytes);
          // 文本与命令输出顺序及完整字段相同，随机标识和耗时已归一化。
          expect(
            JSON.stringify(runs[1]?.bodies) === JSON.stringify(runs[0]?.bodies),
            '逐请求上下文',
          ).toBe(true);
          expect(readFileSync(paths.catalogFile, 'utf8')).toBe(catalog);
        } finally {
          await gateway.close();
          await upstream.close();
        }
      },
    );
  },
);
