import { describe, expect, it } from 'vitest';
import { effectiveCompat } from './providers.js';
import { CODEX_SAMPLES, codexRequest } from './test-fixtures/codex.js';
import type { ChatRequest, GatewayProvider, ResponsesItem, ResponsesRequest } from './types.js';
import { prepareUpstream } from './upstream.js';

const deepseek = (patch: Partial<GatewayProvider> = {}): GatewayProvider => ({
  id: 'deepseek',
  kind: 'openai-compatible',
  displayName: 'DeepSeek',
  api: 'openai-responses',
  baseURL: 'https://api.deepseek.com',
  models: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }],
  defaultModelId: 'deepseek-flash',
  ...patch,
});

describe('DeepSeek Responses 的录制请求', () => {
  for (const kind of ['deepseek-official', 'openai-compatible'] as const) {
    it.each(CODEX_SAMPLES)(`${kind} / %s 保留原生工具、明文推理和服务默认输出预算`, (name) => {
      const body: ResponsesRequest = {
        ...codexRequest(name).body,
        model: 'deepseek-flash',
        tool_choice: 'required',
      };
      const original = structuredClone(body);
      const prepared = prepareUpstream(deepseek({ kind }), body);
      if (!prepared.ok) throw new Error(prepared.message);
      expect(prepared.mode).toBe('responses');
      expect(prepared.url).toBe('https://api.deepseek.com/responses');
      const forwarded = prepared.payload as ResponsesRequest;
      expect(forwarded).not.toHaveProperty('client_metadata');
      expect(forwarded).not.toHaveProperty('max_output_tokens');
      for (const field of ['model', 'tools', 'reasoning', 'include', 'store', 'prompt_cache_key'])
        expect(forwarded[field]).toEqual(body[field]);
      if (name === '4-compact') expect(forwarded).not.toHaveProperty('tool_choice');
      else expect(forwarded.tool_choice).toBe('auto');
      expect(forwarded.input).toEqual(
        (body.input as ResponsesItem[]).map((item) => {
          if (item.type !== 'reasoning') return item;
          return Object.fromEntries(
            Object.entries(item).filter(
              ([key, value]) => !(['content', 'encrypted_content'].includes(key) && value === null),
            ),
          );
        }),
      );
      expect(prepared.dialects).not.toContain('flatten-custom-tools');
      expect(prepared.dialects).not.toContain('flatten-namespace-tools');
      expect(body).toEqual(original);
    });
  }

  it.each(['deepseek-flash', 'deepseek-v4-pro'])(
    '%s 原样传 none / low / high / max 与显式输出预算',
    (model) => {
      for (const effort of ['none', 'low', 'high', 'max']) {
        const prepared = prepareUpstream(deepseek(), {
          ...codexRequest('1-first-turn').body,
          model,
          reasoning: { effort },
          max_output_tokens: 393216,
        });
        if (!prepared.ok) throw new Error(prepared.message);
        expect(prepared.payload).toHaveProperty('reasoning', { effort });
        expect(prepared.payload).toHaveProperty('max_output_tokens', 393216);
        expect(prepared.payload).not.toHaveProperty('thinking');
      }
    },
  );
});

describe('DeepSeek Chat 的地址默认与显式覆盖', () => {
  it.each(['deepseek-flash', 'deepseek-v4-pro'])(
    '%s 的四份录制请求按 Chat 修正工具选择，保留全部 assistant 推理',
    (model) => {
      for (const sample of CODEX_SAMPLES) {
        const prepared = prepareUpstream(deepseek({ api: 'openai-completions' }), {
          ...codexRequest(sample).body,
          model,
          tool_choice: 'required',
        });
        if (!prepared.ok) throw new Error(prepared.message);
        const chat = prepared.payload as ChatRequest;
        expect(prepared.mode).toBe('chat');
        expect(prepared.url).toBe('https://api.deepseek.com/chat/completions');
        if (sample === '4-compact') expect(chat).not.toHaveProperty('tool_choice');
        else expect(chat.tool_choice).toBe('auto');
        for (const message of chat.messages.filter((m) => m.role === 'assistant'))
          expect(typeof message.reasoning_content).toBe('string');
        if (sample === '2-tool-results') {
          expect(chat.messages.find((m) => m.tool_calls)?.reasoning_content).toBe(
            '先建文件，再看目录。',
          );
          expect(chat.tools?.every((tool) => tool.type === 'function')).toBe(true);
        }
      }
    },
  );

  it('给官方 Responses / Chat 补 auto_only，不改 Messages、相似地址或显式 any', () => {
    const chat = deepseek({ api: 'openai-completions' });
    expect(effectiveCompat(chat).toolChoice).toBe('auto_only');
    expect(
      effectiveCompat(deepseek({ kind: 'deepseek-official', baseURL: undefined })).toolChoice,
    ).toBe('auto_only');
    expect(
      effectiveCompat(
        deepseek({ kind: 'deepseek-official', baseURL: 'https://dsh-proxy.example.com/anthropic' }),
      ).toolChoice,
    ).toBe('auto_only');
    expect(effectiveCompat(deepseek()).toolChoice).toBe('auto_only');
    expect(effectiveCompat(deepseek({ api: 'anthropic-messages' })).toolChoice).toBe('any');
    expect(effectiveCompat({ ...chat, compat: { toolChoice: 'any' } }).toolChoice).toBe('any');
    expect(effectiveCompat(deepseek({ compat: { toolChoice: 'any' } })).toolChoice).toBe('any');
    expect(effectiveCompat({ ...chat, compat: { toolChoice: undefined } }).toolChoice).toBe(
      'auto_only',
    );
    for (const baseURL of [
      'https://deepseek.com.example.com',
      'https://notdeepseek.com',
      'https://example.com/api.deepseek.com',
      'invalid',
    ])
      expect(effectiveCompat({ ...chat, baseURL }).toolChoice).toBe('any');
    expect(effectiveCompat({ ...chat, baseURL: 'https://API.DEEPSEEK.COM/v1/' }).toolChoice).toBe(
      'auto_only',
    );
  });

  it('代理可显式 auto_only，官方地址显式 any 保留具名选择；none 的退化保留工具', () => {
    const recorded = codexRequest('1-first-turn').body;
    const named = { type: 'function', name: 'exec_command' };
    const proxy = deepseek({
      api: 'openai-completions',
      baseURL: 'https://proxy.example.com/v1',
      compat: { thinkingFormat: 'deepseek', toolChoice: 'auto_only' },
    });
    for (const tool_choice of ['required', named, 'none']) {
      const prepared = prepareUpstream(proxy, { ...recorded, tool_choice });
      if (!prepared.ok) throw new Error(prepared.message);
      const chat = prepared.payload as ChatRequest;
      if (tool_choice === 'none') expect(chat).not.toHaveProperty('tool_choice');
      else expect(chat.tool_choice).toBe('auto');
      expect(chat.tools?.length).toBeGreaterThan(0);
    }
    const any = prepareUpstream(
      deepseek({ api: 'openai-completions', compat: { toolChoice: 'any' } }),
      { ...recorded, tool_choice: named },
    );
    if (!any.ok) throw new Error(any.message);
    expect(any.payload).toHaveProperty('tool_choice', {
      type: 'function',
      function: { name: 'exec_command' },
    });
  });
});
