import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentEvent,
  APP_TOOLS_ENGINE_SESSION_HEADER,
  isTurnTerminal,
} from '@wevir/runtime-adapter';
import { DEFAULT_CONTRACT_PROMPTS } from '@wevir/runtime-adapter/contract';
import { expect, it, vi } from 'vitest';
import { compareVersions, OPENCODE_BIN_ENV } from './executable.js';
import { OpenCodeAdapter } from './opencode-adapter.js';
import {
  APP_TOOL_REPLY_PREFIX,
  EXTRA_PROMPTS,
  isolatedOpenCodeEnv,
  startMockModel,
} from './test-fixtures/mock-model.js';

const binary = process.env.WEVIR_TEST_OPENCODE_V2_BIN;
const approvalPrompt = {
  content: [{ type: 'text' as const, text: DEFAULT_CONTRACT_PROMPTS.approval }],
};

it.skipIf(!binary)(
  'OpenCode 2 单次审批不影响同一项目的其他会话，取消时撤销待审批请求',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wevir-opencode-v2-approval-')));
    const model = await startMockModel();
    const adapter = new OpenCodeAdapter({
      home: join(root, 'wevir'),
      env: { ...isolatedOpenCodeEnv(root, model.baseUrl), [OPENCODE_BIN_ENV]: binary },
      installer: null,
    });
    const config = {
      cwd: root,
      modelId: 'mock/echo',
      providerId: 'opencode',
      permissionMode: 'on_request' as const,
    };
    const watchers: Promise<void>[] = [];
    const requestApproval = async () => {
      const { engineSessionId } = await adapter.createSession(config);
      const events: AgentEvent[] = [];
      watchers.push(
        (async () => {
          for await (const event of adapter.subscribe(engineSessionId)) events.push(event);
        })(),
      );
      await adapter.send(engineSessionId, approvalPrompt);
      const approval = await vi.waitFor(
        () => {
          const request = events.find((event) => event.type === 'approval.requested');
          if (!request) throw new Error(`Approval missing from ${JSON.stringify(events)}`);
          return request;
        },
        { timeout: 10000 },
      );
      return { engineSessionId, events, approval };
    };
    try {
      const first = await requestApproval();
      expect(first.approval.options.map(({ optionId }) => optionId)).toEqual([
        'accept',
        'decline',
        'cancel',
      ]);
      await expect(
        adapter.respondToApproval(first.engineSessionId, first.approval.requestId, {
          optionId: 'acceptForSession',
        }),
      ).rejects.toMatchObject({ code: 'invalid_option' });
      await adapter.respondToApproval(first.engineSessionId, first.approval.requestId, {
        optionId: 'accept',
      });
      await vi.waitFor(
        () =>
          expect(first.events.filter(isTurnTerminal)).toMatchObject([
            { type: 'turn.settled', outcome: 'completed' },
          ]),
        { timeout: 10000 },
      );
      expect(first.events).toContainEqual(
        expect.objectContaining({
          type: 'tool.finished',
          toolCallId: first.approval.toolCallId,
          status: 'completed',
          output: expect.stringContaining('wevir'),
        }),
      );

      const second = await requestApproval();
      expect(await adapter.listPendingApprovals(second.engineSessionId)).toMatchObject([
        { requestId: second.approval.requestId },
      ]);
      await adapter.cancel(second.engineSessionId);
      await vi.waitFor(
        () =>
          expect(second.events.filter(isTurnTerminal)).toMatchObject([
            { type: 'turn.settled', outcome: 'cancelled' },
          ]),
        { timeout: 10000 },
      );
      expect(second.events).toContainEqual(
        expect.objectContaining({
          type: 'approval.cancelled',
          requestId: second.approval.requestId,
        }),
      );
      expect(await adapter.listPendingApprovals(second.engineSessionId)).toEqual([]);
    } finally {
      await adapter.dispose();
      await Promise.all(watchers);
      await model.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  45_000,
);

it.skipIf(!binary)(
  'OpenCode 2 原生应用工具经审批后携带引擎会话 ID 调用 Host',
  async ({ skip }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'wevir-opencode-v2-app-tools-')));
    const model = await startMockModel();
    const token = 'fixture-engine-token';
    const requests: { method: string; sessionID?: string | string[]; params: unknown }[] = [];
    const host = createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ method, sessionID: req.headers[APP_TOOLS_ENGINE_SESSION_HEADER], params });
      const result =
        method === 'tools/list'
          ? {
              tools: [
                {
                  name: 'wevir_session_create',
                  description: 'Open a new Wevir session.',
                  inputSchema: {
                    type: 'object',
                    properties: { prompt: { type: 'string' } },
                    required: ['prompt'],
                  },
                },
              ],
            }
          : { content: [{ type: 'text', text: 'created fixture session' }] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result,
        }),
      );
    });
    await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(host.address() as AddressInfo).port}/mcp`;
    const adapter = new OpenCodeAdapter({
      home: join(root, 'wevir'),
      env: { ...isolatedOpenCodeEnv(root, model.baseUrl), [OPENCODE_BIN_ENV]: binary },
      installer: null,
    });
    adapter.bindEngineAppTools((kinds) =>
      kinds.includes('opencode') ? { url, token } : undefined,
    );
    let read: Promise<void> | undefined;
    try {
      const state = await adapter.accounts.read('opencode');
      expect(state.lastError).toBeUndefined();
      if (compareVersions(state.version ?? '0.0.0', '2.2.5') < 0) {
        skip('Requires a release with the native Promise plugin permission API');
      }
      const { engineSessionId } = await adapter.createSession({
        cwd: root,
        modelId: 'mock/echo',
        providerId: 'opencode',
        permissionMode: 'on_request',
      });
      const events: AgentEvent[] = [];
      read = (async () => {
        for await (const event of adapter.subscribe(engineSessionId)) events.push(event);
      })();
      await adapter.send(engineSessionId, {
        content: [{ type: 'text', text: EXTRA_PROMPTS.appCreate }],
      });
      const approval = await vi.waitFor(
        () => {
          const request = events.find((event) => event.type === 'approval.requested');
          if (!request) throw new Error(`Approval missing from ${JSON.stringify(events)}`);
          return request;
        },
        { timeout: 10000 },
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool.started',
          toolCallId: approval.toolCallId,
          toolName: 'mcp__wevir__wevir_session_create',
        }),
      );
      expect(requests).toContainEqual(
        expect.objectContaining({
          method: 'tools/list',
          sessionID: undefined,
        }),
      );
      expect(requests.filter(({ method }) => method === 'tools/call')).toEqual([]);
      await adapter.respondToApproval(engineSessionId, approval.requestId, { optionId: 'accept' });
      await vi.waitFor(
        () =>
          expect(events.filter(isTurnTerminal)).toMatchObject([
            { type: 'turn.settled', outcome: 'completed' },
          ]),
        { timeout: 10000 },
      );
      expect(requests.filter(({ method }) => method === 'tools/call')).toEqual([
        {
          method: 'tools/call',
          sessionID: engineSessionId,
          params: { name: 'wevir_session_create', arguments: { prompt: 'Say hi' } },
        },
      ]);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'assistant.message',
          text: `${APP_TOOL_REPLY_PREFIX}created fixture session`,
        }),
      );
    } finally {
      await adapter.dispose();
      await read;
      await model.close();
      host.closeAllConnections();
      await new Promise<void>((resolve) => host.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  },
  45_000,
);
