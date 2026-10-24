import { describe, expect, it } from 'vitest';
import { applyDialects, stripNullReasoningEncryptedContent } from './dialects.js';
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
    // 旧工具方言的断言保持原样；新增的通用 null 清理在下方用原始录制样本单独验证。
    const body = stripNullReasoningEncryptedContent.apply(codexRequest('4-compact').body).body;
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
  const body = stripNullReasoningEncryptedContent.apply(codexRequest('2-tool-results').body).body;

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
  const body = stripNullReasoningEncryptedContent.apply(codexRequest('2-tool-results').body).body;

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

describe('auto-only-tool-choice（录制请求）', () => {
  it.each([
    'required',
    { type: 'function', name: 'exec_command' },
    { type: 'custom', name: 'apply_patch' },
    { type: 'function', name: 'spawn_agent', namespace: 'multi_agent_v1' },
  ])('显式 auto_only 把 %j 改 auto，any 与默认值仍保持原有选择', (tool_choice) => {
    const body = { ...codexRequest('1-first-turn').body, tool_choice };
    const fixed = applyDialects(provider({ toolChoice: 'auto_only' }), body);
    expect(fixed.body.tool_choice).toBe('auto');
    expect(fixed.body.tools).toBe(body.tools);
    expect(fixed.applied).toEqual(['auto-only-tool-choice']);
    expect(body.tool_choice).toEqual(tool_choice);
    expect(applyDialects(provider(), body).body).toBe(body);
    expect(applyDialects(provider({ toolChoice: 'any' }), body).body).toBe(body);
  });

  it('none 只去掉 tool_choice、保留 tools；auto 与没有选择不补写，压缩请求仍不发选择', () => {
    const body = { ...codexRequest('1-first-turn').body, tool_choice: 'none' };
    const fixed = applyDialects(provider({ toolChoice: 'auto_only' }), body).body;
    expect(fixed).not.toHaveProperty('tool_choice');
    expect(fixed.tools).toBe(body.tools);
    expect(applyDialects(provider(), body).body.tool_choice).toBe('none');
    const auto = { ...body, tool_choice: 'auto' };
    expect(applyDialects(provider({ toolChoice: 'auto_only' }), auto).body).toBe(auto);
    const { tool_choice: _drop, ...absent } = body;
    expect(applyDialects(provider({ toolChoice: 'auto_only' }), absent).body).toBe(absent);
    expect(
      applyDialects(provider({ toolChoice: 'auto_only' }), codexRequest('4-compact').body).body,
    ).not.toHaveProperty('tool_choice');
  });
});

describe('通用 namespace 开关（录制请求）', () => {
  it('任意地址显式 false 就摊平，custom 保持支持；xAI 显式 true 覆盖地址默认', () => {
    const body = codexRequest('1-first-turn').body;
    const fixed = applyDialects(provider({ supportsNamespaceTools: false }), body);
    expect(fixed.applied).toEqual(['flatten-namespace-tools']);
    expect(fixed.body.tools?.some((tool) => tool.type === 'namespace')).toBe(false);
    expect(fixed.body.tools?.find((tool) => tool.name === 'apply_patch')?.type).toBe('custom');
    expect(fixed.body.tools?.map((tool) => tool.name)).toContain('multi_agent_v1__spawn_agent');
    const kept = applyDialects(
      xai({ supportsNamespaceTools: true, supportsCustomTools: true }),
      body,
    );
    expect(kept.body).toBe(body);
    expect(kept.applied).toEqual([]);
  });

  it('与 custom 开关组合时仍按逆序还原 added、done、completed 的类型与命名空间', () => {
    const body = codexRequest('1-first-turn').body;
    const patch = body.tools?.find((tool) => tool.name === 'apply_patch');
    const request: ResponsesRequest = {
      ...body,
      tools: [{ type: 'namespace', name: 'ns', tools: [patch] }],
      tool_choice: { type: 'custom', name: 'apply_patch', namespace: 'ns' },
    };
    const { body: fixed, rewrite } = applyDialects(
      provider({ supportsCustomTools: false, supportsNamespaceTools: false }),
      request,
    );
    expect(fixed.tool_choice).toEqual({ type: 'function', name: 'ns__apply_patch' });
    const item = {
      type: 'function_call',
      call_id: 'c',
      name: 'ns__apply_patch',
      arguments: '{"input":"patch"}',
    };
    const expected = {
      type: 'custom_tool_call',
      call_id: 'c',
      name: 'apply_patch',
      namespace: 'ns',
      input: 'patch',
    };
    for (const type of ['response.output_item.added', 'response.output_item.done']) {
      expect(rewrite?.({ type, item })?.item).toEqual(expected);
    }
    expect(
      rewrite?.({ type: 'response.completed', response: { id: 'r', output: [item] } })?.response,
    ).toEqual({ id: 'r', output: [expected] });
  });

  it('摊平 namespace 与顶层函数撞名时，定义、历史、具名选择与响应一致', () => {
    const body: ResponsesRequest = {
      ...codexRequest('1-first-turn').body,
      tools: [
        { type: 'function', name: 'ns__fn' },
        { type: 'namespace', name: 'ns', tools: [{ type: 'function', name: 'fn' }] },
      ],
      input: [
        { type: 'function_call', name: 'fn', namespace: 'ns', call_id: 'c', arguments: '{}' },
      ],
      tool_choice: { type: 'function', name: 'fn', namespace: 'ns' },
    };
    const { body: fixed, rewrite } = applyDialects(
      provider({ supportsNamespaceTools: false }),
      body,
    );
    const renamed = fixed.tools?.[1]?.name;
    expect(renamed).toMatch(/^ns__fn_[a-f0-9]{8}$/);
    expect(fixed.tools?.[0]?.name).toBe('ns__fn');
    expect(fixed.tool_choice).toEqual({ type: 'function', name: renamed });
    expect((fixed.input as ResponsesItem[])[0]).toMatchObject({ name: renamed });
    expect((fixed.input as ResponsesItem[])[0]).not.toHaveProperty('namespace');
    expect(
      rewrite?.({
        type: 'response.output_item.done',
        item: { type: 'function_call', name: renamed },
      })?.item,
    ).toMatchObject({ name: 'fn', namespace: 'ns' });
  });
});

describe('strip-null-reasoning-encrypted-content（录制回放）', () => {
  it('null 去掉、明文与 summary 保留；缺失与非空字符串不改，其他输入项不改', () => {
    const recorded = codexRequest('3-next-turn').body;
    const input = recorded.input as ResponsesItem[];
    const request: ResponsesRequest = {
      ...recorded,
      input: [
        ...input.map((item) =>
          item.type === 'reasoning' ? { ...item, encrypted_content: null } : item,
        ),
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'summary only' }],
          content: null,
        },
        { type: 'message', role: 'assistant', content: [], encrypted_content: null },
      ],
    };
    const { body, applied } = applyDialects(provider(), request);
    expect(applied).toEqual([
      'strip-null-reasoning-content',
      'strip-null-reasoning-encrypted-content',
    ]);
    const fixed = body.input as ResponsesItem[];
    for (const [index, item] of input.entries()) {
      if (item.type !== 'reasoning') continue;
      expect(fixed[index]).not.toHaveProperty('encrypted_content');
      expect(fixed[index]?.content).toEqual(item.content);
      expect(fixed[index]?.summary).toEqual(item.summary);
    }
    expect(fixed.at(-2)).toEqual({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'summary only' }],
    });
    expect(fixed.at(-1)).toBe((request.input as ResponsesItem[]).at(-1));
    const encrypted: ResponsesRequest = {
      ...recorded,
      input: input.map((item) =>
        item.type === 'reasoning' ? { ...item, encrypted_content: 'opaque-non-null' } : item,
      ),
    };
    expect(applyDialects(provider(), encrypted).body).toBe(encrypted);
    expect((request.input as ResponsesItem[]).some((item) => item.encrypted_content === null)).toBe(
      true,
    );
  });

  it('原始 xAI 录制回放同时经过通用清理与原有两条工具方言', () => {
    const { body, applied } = applyDialects(xai(), codexRequest('2-tool-results').body);
    expect(applied).toEqual([
      'strip-null-reasoning-encrypted-content',
      'flatten-custom-tools',
      'flatten-namespace-tools',
    ]);
    expect(body.tools?.some((tool) => tool.type === 'custom' || tool.type === 'namespace')).toBe(
      false,
    );
    for (const item of body.input as ResponsesItem[]) {
      if (item.type === 'reasoning') expect(item).not.toHaveProperty('encrypted_content');
    }
  });
});

describe('flatten-mcp-instructions（摊平 namespace 的上游）', () => {
  const NOTES = '# Instructions from MCP servers\n\n## mcp__wevir\n先读记忆索引。';
  const withMcp = (description = '先读记忆索引。'): ResponsesRequest => ({
    model: 'm',
    input: 'ping',
    instructions: '原指令',
    tools: [
      {
        type: 'namespace',
        name: 'mcp__wevir',
        description,
        tools: [{ type: 'function', name: 'memory_list', parameters: { type: 'object' } }],
      },
      {
        type: 'namespace',
        name: 'multi_agent_v1',
        description: '子智能体。',
        tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object' } }],
      },
    ],
  });

  it('xAI 等默认摊平的上游：说明接到 instructions 后面，命名空间与描述随摊平去掉', () => {
    const body = withMcp();
    const original = structuredClone(body);
    const result = applyDialects(xai(), body);
    expect(result.body.instructions).toBe(`原指令\n\n${NOTES}`);
    expect(result.body.tools?.map((tool) => tool.name)).toEqual([
      'mcp__wevir__memory_list',
      'multi_agent_v1__spawn_agent',
    ]);
    expect(result.applied).toEqual([
      'flatten-mcp-instructions',
      'flatten-custom-tools',
      'flatten-namespace-tools',
    ]);
    expect(body).toEqual(original);
  });

  it('显式支持 namespace 或没有 MCP 说明时不改', () => {
    const body = withMcp();
    expect(applyDialects(provider(), body).body).toEqual(body);
    expect(applyDialects(xai({ supportsNamespaceTools: true }), body).body).toEqual(body);
    const plain = withMcp('Tools in the mcp__wevir namespace.');
    expect(applyDialects(xai(), plain).body.instructions).toBe('原指令');
  });

  it('DeepSeek 显式摊平时说明只出现一次；Azure 补的占位描述不进 instructions', () => {
    const deepseek = applyDialects(
      provider({ supportsNamespaceTools: false }, 'https://api.deepseek.com/v1'),
      withMcp(),
    );
    expect(deepseek.body.instructions).toBe(`原指令\n\n${NOTES}`);
    const azure = applyDialects(
      provider({ supportsNamespaceTools: false }, 'https://r.openai.azure.com/openai/v1'),
      withMcp(''),
    );
    expect(azure.body.instructions).toBe('原指令');
  });
});
