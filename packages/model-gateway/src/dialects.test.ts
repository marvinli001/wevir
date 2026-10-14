import { describe, expect, it } from 'vitest';
import { applyDialects } from './dialects.js';
import { codexRequest } from './test-fixtures/codex.js';
import type { GatewayProvider, ResponsesEvent, ResponsesItem, ResponsesRequest } from './types.js';

const provider = (compat?: GatewayProvider['compat']): GatewayProvider => ({
  id: 'xai',
  kind: 'openai-compatible',
  displayName: 'xAI',
  api: 'openai-responses',
  baseURL: 'https://api.x.ai/v1',
  models: [{ id: 'grok' }],
  defaultModelId: 'grok',
  apiKey: 'k',
  ...(compat === undefined ? {} : { compat }),
});

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
