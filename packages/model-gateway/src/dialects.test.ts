import { describe, expect, it } from 'vitest';
import { applyDialects } from './dialects.js';
import { codexRequest } from './test-fixtures/codex.js';
import type { GatewayProvider, ResponsesEvent, ResponsesItem, ResponsesRequest } from './types.js';

// 地址认不出是哪家服务的 Responses 上游：只有对所有 Provider 生效的修正与 compat 开关起作用。xAI 的地址另有默认值（下面）。
const provider = (
  compat?: GatewayProvider['compat'],
  baseURL = 'https://responses.example.com/v1',
): GatewayProvider => ({
  id: 'generic',
  kind: 'openai-compatible',
  displayName: 'Generic',
  api: 'openai-responses',
  baseURL,
  models: [{ id: 'm' }],
  defaultModelId: 'm',
  apiKey: 'k',
  ...(compat === undefined ? {} : { compat }),
});
const xai = (compat?: GatewayProvider['compat']) => provider(compat, 'https://api.x.ai/v1');

describe('drop-tool-choice-without-tools', () => {
  it('压缩请求的 tools: [] + tool_choice → 去掉 tool_choice（xAI 会 400），其余不动', () => {
    const body = codexRequest('4-compact').body;
    expect(body.tools).toEqual([]);
    expect(body.tool_choice).toBe('auto');
    const { body: fixed, applied } = applyDialects(provider(), body);
    expect(fixed).not.toHaveProperty('tool_choice');
    expect(fixed.tools).toEqual([]);
    expect(applied).toEqual(['drop-tool-choice-without-tools']);
    const { tool_choice: _drop, ...rest } = body;
    expect(fixed).toEqual(rest);
  });

  it('没有 tools 字段时同样去掉；有工具时保留', () => {
    expect(applyDialects(provider(), { model: 'm', input: [], tool_choice: 'auto' }).body).toEqual({
      model: 'm',
      input: [],
    });
    const body = codexRequest('1-first-turn').body;
    const { body: kept, applied } = applyDialects(provider(), body);
    expect(kept).toBe(body);
    expect(applied).toEqual([]);
  });
});

describe('flatten-custom-tools（compat.supportsCustomTools: false）', () => {
  const body = codexRequest('2-tool-results').body;

  it('默认不生效', () => {
    expect(applyDialects(provider(), body).applied).toEqual([]);
    expect(applyDialects(provider({ supportsCustomTools: true }), body).applied).toEqual([]);
  });

  it('请求：custom 工具 → 只有 input 参数的函数；历史里的 custom_tool_call / _output → 函数调用与输出；namespace 不动', () => {
    const { body: fixed, applied } = applyDialects(provider({ supportsCustomTools: false }), body);
    expect(applied).toEqual(['flatten-custom-tools']);
    const applyPatch = fixed.tools?.find((t) => t.name === 'apply_patch');
    expect(applyPatch).toMatchObject({
      type: 'function',
      parameters: { type: 'object', required: ['input'] },
      strict: false,
    });
    expect(String(applyPatch?.description)).toContain('begin_patch');
    expect(fixed.tools?.find((t) => t.type === 'namespace')).toEqual(
      body.tools?.find((t) => t.type === 'namespace'),
    );
    const items = fixed.input as ResponsesItem[];
    expect(items.some((i) => i.type.startsWith('custom_tool_call'))).toBe(false);
    expect(items.find((i) => i.call_id === 'call_1' && i.type === 'function_call')).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'apply_patch',
      arguments: JSON.stringify({
        input: '*** Begin Patch\n*** Add File: notes.md\n+# 笔记\n*** End Patch',
      }),
    });
    expect(
      items.find((i) => i.call_id === 'call_1' && i.type === 'function_call_output'),
    ).toMatchObject({
      output: expect.stringContaining('Success.'),
    });
    // 原来的函数调用不动（连 id 一起保留）。
    expect(items.find((i) => i.call_id === 'call_2' && i.type === 'function_call')).toEqual(
      (body.input as ResponsesItem[]).find(
        (i) => i.call_id === 'call_2' && i.type === 'function_call',
      ),
    );
    // 不改传入的请求体。
    expect((body.input as ResponsesItem[]).some((i) => i.type === 'custom_tool_call')).toBe(true);
  });

  it('响应：同名的 function_call 还原成 custom_tool_call（added、done 与 completed 里的 output），别的不动', () => {
    const { rewrite } = applyDialects(provider({ supportsCustomTools: false }), body);
    expect(rewrite).toBeDefined();
    const patchCall = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'c1',
      name: 'apply_patch',
      arguments: '{"input":"*** Begin Patch"}',
      status: 'completed',
    };
    const execCall = {
      type: 'function_call',
      call_id: 'c2',
      name: 'exec_command',
      arguments: '{}',
    };
    const done = rewrite?.({ type: 'response.output_item.done', output_index: 0, item: patchCall });
    expect(done?.item).toEqual({
      type: 'custom_tool_call',
      id: 'fc_1',
      call_id: 'c1',
      name: 'apply_patch',
      status: 'completed',
      input: '*** Begin Patch',
    });
    const added = rewrite?.({
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...patchCall, arguments: '' },
    });
    expect(added?.item).toMatchObject({ type: 'custom_tool_call', input: '' });
    expect(
      rewrite?.({ type: 'response.output_item.done', output_index: 1, item: execCall })?.item,
    ).toEqual(execCall);
    const completed = rewrite?.({
      type: 'response.completed',
      response: { id: 'r', output: [patchCall, execCall] },
    }) as ResponsesEvent;
    expect(
      (completed.response as { output: Array<{ type: string }> }).output.map((i) => i.type),
    ).toEqual(['custom_tool_call', 'function_call']);
    const delta = { type: 'response.output_text.delta', delta: 'x', item_id: 'm' };
    expect(rewrite?.(delta)).toBe(delta);
  });

  it('namespace 里的 custom 工具也摊平，按命名空间还原；tool_choice 指定 custom 时改成 function', () => {
    const request: ResponsesRequest = {
      model: 'm',
      input: [],
      tools: [{ type: 'namespace', name: 'ns', tools: [{ type: 'custom', name: 'free' }] }],
      tool_choice: { type: 'custom', name: 'free' },
    };
    const { body: fixed, rewrite } = applyDialects(
      provider({ supportsCustomTools: false }),
      request,
    );
    expect((fixed.tools?.[0]?.tools as Array<{ type: string }> | undefined)?.[0]?.type).toBe(
      'function',
    );
    expect(fixed.tool_choice).toEqual({ type: 'function', name: 'free' });
    const item = {
      type: 'function_call',
      call_id: 'c',
      name: 'free',
      namespace: 'ns',
      arguments: '{"input":"x"}',
    };
    expect(rewrite?.({ type: 'response.output_item.done', item })?.item).toMatchObject({
      type: 'custom_tool_call',
      namespace: 'ns',
      input: 'x',
    });
    // 同名但不在这个命名空间里的函数不还原。
    const other = { ...item, namespace: undefined };
    expect(rewrite?.({ type: 'response.output_item.done', item: other })?.item).toEqual(other);
  });
});

describe('strip-null-reasoning-content', () => {
  it('reasoning 项的 content: null 去掉（openai/codex#47733），别的项与有内容的推理不动', () => {
    const request: ResponsesRequest = {
      model: 'm',
      input: [
        { type: 'reasoning', id: 'rs_1', summary: [], content: null, encrypted_content: 'blob' },
        { type: 'reasoning', id: 'rs_2', summary: [], content: [{ type: 'reasoning_text' }] },
        { type: 'message', role: 'user', content: null },
      ],
    };
    const { body, applied } = applyDialects(provider(), request);
    expect(applied).toEqual(['strip-null-reasoning-content']);
    const items = body.input as ResponsesItem[];
    expect(items[0]).toEqual({
      type: 'reasoning',
      id: 'rs_1',
      summary: [],
      encrypted_content: 'blob',
    });
    expect(items[1]).toBe((request.input as ResponsesItem[])[1]);
    expect(items[2]).toBe((request.input as ResponsesItem[])[2]);
    expect((request.input as ResponsesItem[])[0]).toHaveProperty('content', null);
  });
});

describe('xAI 的地址（api.x.ai）', () => {
  const body = codexRequest('2-tool-results').body;

  it('默认摊平 custom 与 namespace 工具；compat.supportsCustomTools: true 时只摊平 namespace；别的地址不摊平 namespace', () => {
    expect(applyDialects(xai(), body).applied).toEqual([
      'flatten-custom-tools',
      'flatten-namespace-tools',
    ]);
    expect(applyDialects(provider(undefined, 'https://us.api.x.ai/v1'), body).applied).toEqual([
      'flatten-custom-tools',
      'flatten-namespace-tools',
    ]);
    expect(applyDialects(xai({ supportsCustomTools: true }), body).applied).toEqual([
      'flatten-namespace-tools',
    ]);
    expect(applyDialects(provider({ supportsCustomTools: false }), body).applied).toEqual([
      'flatten-custom-tools',
    ]);
  });

  it('请求：namespace 里的工具摊平成 <ns>__<name> 函数，历史里带 namespace 的调用换成摊平的名字', () => {
    const { body: fixed } = applyDialects(xai(), body);
    expect(fixed.tools?.some((t) => t.type === 'namespace' || t.type === 'custom')).toBe(false);
    const names = fixed.tools?.map((t) => t.name) ?? [];
    expect(names).toContain('multi_agent_v1__spawn_agent');
    expect(names).toContain('apply_patch');
    const request: ResponsesRequest = {
      model: 'grok',
      input: [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'spawn_agent',
          namespace: 'multi_agent_v1',
          arguments: '{}',
        },
        { type: 'function_call_output', call_id: 'c1', output: 'ok' },
      ],
      tools: [
        {
          type: 'namespace',
          name: 'multi_agent_v1',
          tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object' } }],
        },
      ],
    };
    const { body: flat } = applyDialects(xai(), request);
    expect(flat.tools).toEqual([
      {
        type: 'function',
        name: 'multi_agent_v1__spawn_agent',
        parameters: { type: 'object' },
      },
    ]);
    expect((flat.input as ResponsesItem[])[0]).toEqual({
      type: 'function_call',
      call_id: 'c1',
      name: 'multi_agent_v1__spawn_agent',
      arguments: '{}',
    });
  });

  it('响应：先还原命名空间，再还原 namespace 里的 custom 工具', () => {
    const request: ResponsesRequest = {
      model: 'grok',
      input: [],
      tools: [
        {
          type: 'namespace',
          name: 'ns',
          tools: [
            { type: 'custom', name: 'free' },
            { type: 'function', name: 'fn' },
          ],
        },
      ],
    };
    const { body: fixed, rewrite } = applyDialects(xai(), request);
    expect(fixed.tools?.map((t) => [t.type, t.name])).toEqual([
      ['function', 'ns__free'],
      ['function', 'ns__fn'],
    ]);
    const done = (item: Record<string, unknown>) =>
      rewrite?.({ type: 'response.output_item.done', output_index: 0, item })?.item;
    expect(
      done({ type: 'function_call', call_id: 'c', name: 'ns__free', arguments: '{"input":"x"}' }),
    ).toEqual({
      type: 'custom_tool_call',
      call_id: 'c',
      name: 'free',
      namespace: 'ns',
      input: 'x',
    });
    expect(done({ type: 'function_call', call_id: 'd', name: 'ns__fn', arguments: '{}' })).toEqual({
      type: 'function_call',
      call_id: 'd',
      name: 'fn',
      namespace: 'ns',
      arguments: '{}',
    });
    // 模型编的名字原样交给 Codex。
    expect(done({ type: 'function_call', call_id: 'e', name: 'nope', arguments: '{}' })).toEqual({
      type: 'function_call',
      call_id: 'e',
      name: 'nope',
      arguments: '{}',
    });
  });
});
