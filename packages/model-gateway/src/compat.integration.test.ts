// P0a：上游明确拒收不支持的字段，用录制的 Codex 请求确认 compat 真正改变线上请求。

import { afterEach, describe, expect, it } from 'vitest';
import { startModelGateway } from './gateway.js';
import { sseEvent } from './sse.js';
import {
  codexProblems,
  codexRequest,
  doneItems,
  postResponses,
  readEvents,
} from './test-fixtures/codex.js';
import { sendHttpError, startMockServer } from './test-fixtures/mock-server.js';
import type { ChatRequest, GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const provider = (baseURL: string, compat?: GatewayProvider['compat']): GatewayProvider => ({
  id: 'compat',
  kind: 'openai-compatible',
  displayName: 'Compat mock',
  api: 'openai-responses',
  baseURL,
  models: [{ id: 'wevir-mock' }],
  defaultModelId: 'wevir-mock',
  apiKey: 'placeholder-not-a-real-key',
  ...(compat === undefined ? {} : { compat }),
});

const completed = (output: ResponsesItem[] = []) =>
  sseEvent({ type: 'response.completed', response: { id: 'resp_mock', output } });

describe('Responses 通用工具方言', () => {
  it.each([
    'required',
    { type: 'function', name: 'exec_command' },
    { type: 'custom', name: 'apply_patch' },
    'none',
  ])('上游拒收 %j：不开开关 400，auto_only 后 200；none 仍保留工具', async (tool_choice) => {
    const mock = await startMockServer<ResponsesRequest>(
      '/responses',
      async (body, _record, res) => {
        if (body.tool_choice !== undefined && body.tool_choice !== 'auto') {
          sendHttpError(res, { status: 400, message: 'only auto tool_choice is supported' });
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(completed());
      },
    );
    cleanups.push(() => mock.close());
    const gw = await startModelGateway();
    cleanups.push(() => gw.close());
    const body = { ...codexRequest('1-first-turn').body, tool_choice };
    gw.setProviders([provider(mock.baseURL)]);
    const rejected = await postResponses(gw.baseURL('compat'), gw.token, body);
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain('only auto');
    gw.setProviders([provider(mock.baseURL, { toolChoice: 'auto_only' })]);
    const accepted = await postResponses(gw.baseURL('compat'), gw.token, body);
    expect(accepted.status).toBe(200);
    expect(codexProblems(await readEvents(accepted))).toEqual([]);
    expect(mock.requests[1]?.body.tools).toEqual(body.tools);
    if (tool_choice === 'none') expect(mock.requests[1]?.body).not.toHaveProperty('tool_choice');
    else expect(mock.requests[1]?.body.tool_choice).toBe('auto');
  });

  it.each([true, false])(
    '上游拒收 namespace（supportsCustomTools=%s）：显式 false 后工具、历史与响应能往返',
    async (supportsCustomTools) => {
      const patch = '*** Begin Patch\n*** Add File: notes.md\n+# 笔记\n*** End Patch';
      const mock = await startMockServer<ResponsesRequest>(
        '/responses',
        async (body, _record, res) => {
          if (body.tools?.some((tool) => tool.type === 'namespace')) {
            sendHttpError(res, { status: 400, message: 'namespace tools are unsupported' });
            return;
          }
          if (!supportsCustomTools && body.tools?.some((tool) => tool.type === 'custom')) {
            sendHttpError(res, { status: 400, message: 'custom tools are unsupported' });
            return;
          }
          const output: ResponsesItem[] = [
            supportsCustomTools
              ? { type: 'custom_tool_call', call_id: 'p', name: 'apply_patch', input: patch }
              : {
                  type: 'function_call',
                  call_id: 'p',
                  name: 'apply_patch',
                  arguments: JSON.stringify({ input: patch }),
                },
            {
              type: 'function_call',
              call_id: 'a',
              name: 'multi_agent_v1__spawn_agent',
              arguments: '{}',
            },
          ];
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(
            output.map((item) => sseEvent({ type: 'response.output_item.done', item })).join('') +
              completed(output),
          );
        },
      );
      cleanups.push(() => mock.close());
      const gw = await startModelGateway();
      cleanups.push(() => gw.close());
      const body = codexRequest('2-tool-results').body;
      gw.setProviders([provider(mock.baseURL)]);
      const rejected = await postResponses(gw.baseURL('compat'), gw.token, body);
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).toContain('namespace');
      gw.setProviders([
        provider(mock.baseURL, {
          supportsNamespaceTools: false,
          supportsCustomTools,
          toolChoice: 'auto_only',
        }),
      ]);
      const accepted = await postResponses(gw.baseURL('compat'), gw.token, body);
      expect(accepted.status).toBe(200);
      const events = await readEvents(accepted);
      expect(codexProblems(events)).toEqual([]);
      expect(doneItems(events)).toEqual([
        { type: 'custom_tool_call', call_id: 'p', name: 'apply_patch', input: patch },
        {
          type: 'function_call',
          call_id: 'a',
          name: 'spawn_agent',
          namespace: 'multi_agent_v1',
          arguments: '{}',
        },
      ]);
      const upstream = mock.requests[1]?.body;
      expect(upstream?.tools?.some((tool) => tool.type === 'namespace')).toBe(false);
      expect(upstream?.tools?.find((tool) => tool.name === 'apply_patch')?.type).toBe(
        supportsCustomTools ? 'custom' : 'function',
      );
      const input = upstream?.input;
      if (!Array.isArray(input)) throw new Error('没有录到上游的 input 数组');
      expect(input.some((item) => item.type === 'custom_tool_call')).toBe(supportsCustomTools);
      expect(upstream?.tool_choice).toBe('auto');
    },
  );

  it('上游拒收 encrypted_content: null；经过网关后去掉 null 并保留推理原文', async () => {
    const mock = await startMockServer<ResponsesRequest>(
      '/responses',
      async (body, _record, res) => {
        if (
          Array.isArray(body.input) &&
          body.input.some((item) => item.type === 'reasoning' && item.encrypted_content === null)
        ) {
          sendHttpError(res, {
            status: 400,
            message: 'encrypted_content must be a string or omitted',
          });
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(completed());
      },
    );
    cleanups.push(() => mock.close());
    const recorded = codexRequest('3-next-turn').body;
    const body: ResponsesRequest = {
      ...recorded,
      input: (recorded.input as ResponsesItem[]).map((item) =>
        item.type === 'reasoning' ? { ...item, encrypted_content: null } : item,
      ),
    };
    const raw = await postResponses(mock.baseURL, 'mock-token', body);
    expect(raw.status).toBe(400);
    await raw.text();
    const gw = await startModelGateway();
    cleanups.push(() => gw.close());
    gw.setProviders([provider(mock.baseURL)]);
    const accepted = await postResponses(gw.baseURL('compat'), gw.token, body);
    expect(accepted.status).toBe(200);
    expect(codexProblems(await readEvents(accepted))).toEqual([]);
    const original = (body.input as ResponsesItem[]).filter((item) => item.type === 'reasoning');
    const forwardedInput = mock.requests[1]?.body.input;
    if (!Array.isArray(forwardedInput)) throw new Error('没有录到上游的 input 数组');
    const forwarded = forwardedInput.filter((item) => item.type === 'reasoning');
    expect(forwarded).toHaveLength(original.length);
    for (const [index, item] of forwarded.entries()) {
      expect(item).not.toHaveProperty('encrypted_content');
      expect(item.content).toEqual(original[index]?.content);
      expect(item.summary).toEqual(original[index]?.summary);
    }
  });
});

describe('Chat 的 auto_only', () => {
  it.each(['required', { type: 'custom', name: 'apply_patch' }, 'none'])(
    'Chat 上游拒收 %j，显式开关后能完成 Responses 对话',
    async (tool_choice) => {
      const mock = await startMockServer<ChatRequest>(
        '/chat/completions',
        async (body, _record, res) => {
          if (body.tool_choice !== undefined && body.tool_choice !== 'auto') {
            sendHttpError(res, { status: 400, message: 'only auto tool_choice is supported' });
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chat_mock',
              choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            }),
          );
        },
      );
      cleanups.push(() => mock.close());
      const gw = await startModelGateway();
      cleanups.push(() => gw.close());
      const body = { ...codexRequest('1-first-turn').body, tool_choice };
      gw.setProviders([{ ...provider(mock.baseURL), api: 'openai-completions' }]);
      const rejected = await postResponses(gw.baseURL('compat'), gw.token, body);
      expect(rejected.status).toBe(400);
      await rejected.text();
      gw.setProviders([
        { ...provider(mock.baseURL, { toolChoice: 'auto_only' }), api: 'openai-completions' },
      ]);
      const accepted = await postResponses(gw.baseURL('compat'), gw.token, body);
      expect(accepted.status).toBe(200);
      const events = await readEvents(accepted);
      expect(codexProblems(events)).toEqual([]);
      expect(doneItems(events)).toMatchObject([
        { type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
      ]);
      expect(mock.requests[1]?.body.tools).toEqual(mock.requests[0]?.body.tools);
      if (tool_choice === 'none') expect(mock.requests[1]?.body).not.toHaveProperty('tool_choice');
      else expect(mock.requests[1]?.body.tool_choice).toBe('auto');
    },
  );
});
