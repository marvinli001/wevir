import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import type { ThreadForkResponse, TurnStartResponse } from './protocol.js';
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
  type MockScript,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('Codex 上游怪癖');
const dirs = new TempDirs();
let mock: MockModel;
let script: MockScript = () => ({ text: ['done'] });
const adapters: CodexAdapter[] = [];

function setup() {
  const paths = dirs.make('quirks');
  const raw: Array<{ method: string; params: unknown }> = [];
  const adapter = newAdapter({
    home: paths.home,
    binary,
    providers: [mockProvider(mock, { compat: { toolSearch: 'off' } })],
    onRawNotification: (method, params) => raw.push({ method, params }),
  });
  adapters.push(adapter);
  const config = {
    cwd: paths.workspace,
    providerId: 'mock',
    modelId: MOCK_MODEL,
    permissionMode: 'full_access' as const,
  };
  return { ...paths, adapter, config, raw };
}

describe.skipIf(binary === undefined)(
  'Codex 上游行为复核（真实二进制）',
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      mock = await startMockModel((view) => script(view));
    });
    afterEach(async () => {
      await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
      script = () => ({ text: ['done'] });
    });
    afterAll(async () => {
      await mock?.close();
      dirs.cleanup();
    });

    it('MCP 结果的 Wall time 包装与 structuredContent 优先行为', async () => {
      const h = setup();
      const server = join(h.root, 'mcp.mjs');
      writeFileSync(
        server,
        `import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 const request=JSON.parse(line); if(request.id===undefined)continue;
 const result=request.method==='initialize'?{protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'quirk',version:'1'}}:
 request.method==='tools/list'?{tools:[{name:'probe_tool',description:'Local probe',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}}]}:
 request.method==='tools/call'?{content:[{type:'text',text:'CONTENT_ONLY_CANARY'}],structuredContent:{marker:'STRUCTURED_CANARY'}}:{};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
}`,
      );
      h.adapter.bindPlugins({
        read: async () => ({
          skillsRoot: h.workspace,
          skills: [],
          connectors: [
            {
              name: 'quirk',
              enabled: true,
              config: { transport: 'stdio', command: process.execPath, args: [server] },
            },
          ],
        }),
        changed: () => {},
      });
      let output = '';
      script = (view) => {
        if (view.toolOutputs.length > 0) {
          output = view.toolOutputs.join('\n');
          return { text: ['done'] };
        }
        for (const tool of view.body.tools ?? []) {
          if (
            tool.type === 'namespace' &&
            (tool.tools as Array<{ name?: string }> | undefined)?.some(
              (entry) => entry.name === 'probe_tool',
            )
          )
            return {
              toolCalls: [{ kind: 'function', name: 'probe_tool', namespace: tool.name, args: {} }],
            };
          if (tool.name?.endsWith('probe_tool'))
            return { toolCalls: [{ kind: 'function', name: tool.name, args: {} }] };
        }
        return { text: ['MCP_TOOL_MISSING'] };
      };
      const session = await h.adapter.createSession(h.config);
      expect(
        (
          await runTurn(
            h.adapter,
            session.engineSessionId,
            'probe',
            collectEvents(h.adapter, session.engineSessionId),
          )
        ).at(-1)?.type,
      ).toBe('turn.settled');
      expect(output).toContain('Wall time:');
      expect(output).toContain('STRUCTURED_CANARY');
      expect(output).not.toContain('CONTENT_ONLY_CANARY');
    });

    it('fork 继承父规则，但 developerInstructions 参数覆盖仍不生效', async () => {
      const h = setup();
      const parent = await h.adapter.createSession({
        ...h.config,
        ruleInstructions: 'PARENT_RULE_CANARY',
      });
      await runTurn(
        h.adapter,
        parent.engineSessionId,
        'persist parent',
        collectEvents(h.adapter, parent.engineSessionId),
      );
      const fork = await h.adapter.process.request<ThreadForkResponse>('thread/fork', {
        threadId: parent.engineSessionId,
        cwd: h.workspace,
        model: MOCK_MODEL,
        modelProvider: 'wevir_mock',
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        developerInstructions: 'FORK_OVERRIDE_CANARY',
      });
      const response = await h.adapter.process.request<TurnStartResponse>('turn/start', {
        threadId: fork.thread.id,
        input: [{ type: 'text', text: 'probe fork' }],
      });
      await vi.waitFor(() =>
        expect(
          h.raw.some((entry) => {
            const params = entry.params as { turn?: { id?: string; status?: string } };
            return (
              entry.method === 'turn/completed' &&
              params.turn?.id === response.turn.id &&
              params.turn.status === 'completed'
            );
          }),
        ).toBe(true),
      );
      const input = JSON.stringify(mock.requests.at(-1)?.body);
      expect(input).toContain('PARENT_RULE_CANARY');
      expect(input).not.toContain('FORK_OVERRIDE_CANARY');
    });

    it.skipIf(process.platform === 'win32').each([1000, 30000])(
      'sleep 在 %i ms 预算下的让出与后台进程生命周期',
      async (yieldMs) => {
        const h = setup();
        const marker = join(h.workspace, 'background-finished');
        let output = '';
        let toolReturnedAt = 0;
        script = (view) => {
          if (view.toolOutputs.length > 0) {
            output = view.toolOutputs.join('\n');
            toolReturnedAt = performance.now();
            return { text: ['done'] };
          }
          return {
            toolCalls: [
              {
                kind: 'function',
                name: 'exec_command',
                args: {
                  cmd: `sleep 12; printf finished > '${marker}'`,
                  yield_time_ms: yieldMs,
                },
              },
            ],
          };
        };
        const session = await h.adapter.createSession(h.config);
        const start = performance.now();
        await runTurn(
          h.adapter,
          session.engineSessionId,
          'probe sleep',
          collectEvents(h.adapter, session.engineSessionId),
        );
        await new Promise((resolve) => setTimeout(resolve, 13500));
        const result = {
          yieldMs,
          toolReturnMs: Math.round(toolReturnedAt - start),
          runningSession: /running with session|Process ID|session ID/i.test(output),
          markerWritten: existsSync(marker),
        };
        console.log(`CODEX_SLEEP_QUIRK ${JSON.stringify(result)}`);
        expect(output.length).toBeGreaterThan(0);
        expect(toolReturnedAt).toBeGreaterThan(start);
        expect(result.runningSession).toBe(yieldMs === 1000);
        expect(result.markerWritten).toBe(true);
      },
    );

    it.skipIf(process.platform === 'win32').each(['rm', 'escalation'] as const)(
      'never 模式的 %s 内置限制仍生效',
      async (kind) => {
        const h = setup();
        const target = join(h.workspace, 'owned');
        mkdirSync(target);
        writeFileSync(join(target, 'canary'), 'keep');
        const marker = join(h.workspace, 'escalated.txt');
        script = (view) =>
          view.toolOutputs.length > 0
            ? { text: ['done'] }
            : {
                toolCalls: [
                  {
                    kind: 'function',
                    name: 'exec_command',
                    args:
                      kind === 'rm'
                        ? { cmd: `rm -rf '${target}'` }
                        : {
                            cmd: `printf escalated > '${marker}'`,
                            sandbox_permissions: 'require_escalated',
                            justification: 'Local test',
                          },
                  },
                ],
              };
        const session = await h.adapter.createSession(h.config);
        const events: AgentEvent[] = collectEvents(h.adapter, session.engineSessionId);
        await runTurn(h.adapter, session.engineSessionId, 'probe policy', events);
        expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
        expect(readFileSync(join(target, 'canary'), 'utf8')).toBe('keep');
        expect(existsSync(marker)).toBe(false);
        expect(JSON.stringify(mock.requests.at(-1)?.body.input)).toMatch(
          /reject|not allowed|policy/i,
        );
      },
    );
  },
);
