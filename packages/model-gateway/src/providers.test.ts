import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_RESPONSES_BASE_URL,
  effectiveCompat,
  isBailianHost,
  isXaiHost,
  routeOf,
  validateProvider,
} from './providers.js';
import type { GatewayProvider } from './types.js';

const compatible = (patch: Partial<GatewayProvider>): GatewayProvider => ({
  id: 'p',
  kind: 'openai-compatible',
  displayName: 'P',
  api: 'openai-completions',
  baseURL: 'https://example.com/v1/',
  models: [{ id: 'm' }],
  defaultModelId: 'm',
  ...patch,
});

describe('routeOf', () => {
  it('deepseek-official → Responses 透传到 DeepSeek 官方地址，不用 Provider 的 baseURL（那是 dsh 的 Messages 地址）', () => {
    const provider: GatewayProvider = {
      id: 'deepseek-official',
      kind: 'deepseek-official',
      displayName: 'DeepSeek',
      baseURL: 'https://api.deepseek.com/anthropic',
      models: [],
      defaultModelId: 'deepseek-flash',
    };
    expect(DEEPSEEK_RESPONSES_BASE_URL).toBe('https://api.deepseek.com');
    expect(routeOf(provider)).toEqual({
      mode: 'responses',
      url: 'https://api.deepseek.com/responses',
    });
    expect(routeOf(provider, 'http://127.0.0.1:9/v1/')).toEqual({
      mode: 'responses',
      url: 'http://127.0.0.1:9/v1/responses',
    });
  });

  it('openai-responses → 透传；openai-completions → Chat 转换；末尾斜线去掉', () => {
    expect(routeOf(compatible({ api: 'openai-responses' }))).toEqual({
      mode: 'responses',
      url: 'https://example.com/v1/responses',
    });
    expect(routeOf(compatible({}))).toEqual({
      mode: 'chat',
      url: 'https://example.com/v1/chat/completions',
    });
  });

  it('anthropic-messages → Messages 转换：<baseURL>/v1/messages，baseURL 已以 /v1 结尾时只加 /messages', () => {
    expect(
      routeOf(
        compatible({ api: 'anthropic-messages', baseURL: 'https://api.deepseek.com/anthropic' }),
      ),
    ).toEqual({ mode: 'messages', url: 'https://api.deepseek.com/anthropic/v1/messages' });
    expect(routeOf(compatible({ api: 'anthropic-messages' }))).toEqual({
      mode: 'messages',
      url: 'https://example.com/v1/messages',
    });
  });

  it('配置不对 → unsupported，原因写在 message 里', () => {
    expect(routeOf(compatible({ api: 'gemini' }))).toEqual({
      mode: 'unsupported',
      message: 'api：不认识的协议 gemini',
    });
  });
});

describe('validateProvider', () => {
  it('Gemini Schema 开关只接受布尔值，省略与 false 不启用', () => {
    for (const geminiToolSchema of [undefined, false, true])
      expect(validateProvider(compatible({ compat: { geminiToolSchema } }))).toEqual([]);
    expect(
      validateProvider(compatible({ compat: { geminiToolSchema: 'true' as never } })).map(
        (i) => i.path,
      ),
    ).toEqual([['compat', 'geminiToolSchema']]);
    expect(effectiveCompat(compatible({})).geminiToolSchema).toBeUndefined();
    expect(
      effectiveCompat(compatible({ compat: { geminiToolSchema: false } })).geminiToolSchema,
    ).toBe(false);
  });
  it('新的工具开关检查取值，不限制可用的协议', () => {
    for (const api of ['openai-responses', 'openai-completions', 'anthropic-messages']) {
      expect(
        validateProvider(
          compatible({ api, compat: { supportsNamespaceTools: false, toolChoice: 'auto_only' } }),
        ),
      ).toEqual([]);
    }
    expect(
      validateProvider(
        compatible({
          compat: { supportsNamespaceTools: 'no' as never, toolChoice: 'required' as never },
        }),
      ).map((issue) => issue.path),
    ).toEqual([
      ['compat', 'supportsNamespaceTools'],
      ['compat', 'toolChoice'],
    ]);
  });
  it('合法的配置没有问题', () => {
    expect(validateProvider(compatible({}))).toEqual([]);
    expect(
      validateProvider(
        compatible({ api: 'openai-responses', compat: { supportsCustomTools: false } }),
      ),
    ).toEqual([]);
  });

  it('协议、地址与网关的 compat 开关', () => {
    expect(validateProvider(compatible({ api: 'anthropic-messages' }))).toEqual([]);
    expect(
      validateProvider(
        compatible({ api: 'anthropic-messages', compat: { thinkingFormat: 'adaptive' } }),
      ),
    ).toEqual([]);
    expect(
      validateProvider(
        compatible({ api: 'anthropic-messages', compat: { thinkingFormat: 'qwen' } }),
      ),
    ).toEqual([
      {
        path: ['compat', 'thinkingFormat'],
        message: 'anthropic-messages 的 thinkingFormat 只能是 adaptive 或 enabled',
      },
    ]);
    // 其他协议的 thinkingFormat 是 pi-ai 的写法，网关不查。
    expect(validateProvider(compatible({ compat: { thinkingFormat: 'qwen' } }))).toEqual([]);
    expect(
      validateProvider(compatible({ api: undefined, baseURL: undefined })).map((i) => i.path),
    ).toEqual([['api'], ['baseURL']]);
    expect(
      validateProvider(compatible({ baseURL: 'https://u:p@example.com' }))[0]?.message,
    ).toContain('用户名');
    expect(
      validateProvider(
        compatible({
          compat: { systemMessageMode: 'top' as never, supportsCustomTools: 'no' as never },
        }),
      ).map((i) => i.path),
    ).toEqual([
      ['compat', 'systemMessageMode'],
      ['compat', 'supportsCustomTools'],
    ]);
  });
});

describe('工具 compat：声明 > 地址默认 > 全局默认', () => {
  it.each([
    'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'https://DASHSCOPE-INTL.ALIYUNCS.COM/compatible-mode/v1/',
    ...[
      'cn-beijing',
      'ap-southeast-1',
      'us-east-1',
      'eu-central-1',
      'ap-northeast-1',
      'cn-hongkong',
    ].map((region) => `https://workspace.${region}.maas.aliyuncs.com/compatible-mode/v1`),
  ])('百炼按量地址 %s 自动使用保守工具默认值', (baseURL) => {
    expect(isBailianHost(baseURL)).toBe(true);
    expect(effectiveCompat(compatible({ baseURL }))).toEqual({
      supportsCustomTools: false,
      supportsNamespaceTools: false,
      toolChoice: 'auto_only',
    });
  });

  it.each([
    'https://coding.dashscope.aliyuncs.com/v1',
    'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    'https://coding.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    'https://dashscope.aliyuncs.com.example.com/v1',
    'https://notdashscope.aliyuncs.com/v1',
    'https://notmaas.aliyuncs.com/v1',
    'https://maas.aliyuncs.com.example.com/v1',
    'https://example.com/dashscope.aliyuncs.com',
    'invalid',
  ])('套餐或相似地址 %s 不使用百炼默认值', (baseURL) => {
    expect(isBailianHost(baseURL)).toBe(false);
    expect(effectiveCompat(compatible({ baseURL }))).toEqual({
      supportsCustomTools: true,
      supportsNamespaceTools: true,
      toolChoice: 'any',
    });
  });

  it('百炼显式 compat 逐字段优先，undefined 不覆盖地址默认，其他字段保留', () => {
    const provider = compatible({
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      compat: {
        supportsCustomTools: true,
        supportsNamespaceTools: undefined,
        toolChoice: 'any',
        thinkingFormat: 'qwen',
      },
    });
    expect(effectiveCompat(provider)).toEqual({
      supportsCustomTools: true,
      supportsNamespaceTools: false,
      toolChoice: 'any',
      thinkingFormat: 'qwen',
    });
    expect(provider.compat?.supportsNamespaceTools).toBeUndefined();
  });

  it('只认 x.ai 本身及子域，大小写不影响；不把路径、前缀或后缀相似的地址当成 xAI', () => {
    for (const baseURL of ['https://x.ai', 'https://US.API.X.AI/v1']) {
      expect(isXaiHost(baseURL)).toBe(true);
      expect(effectiveCompat(compatible({ baseURL }))).toMatchObject({
        supportsCustomTools: false,
        supportsNamespaceTools: false,
        toolChoice: 'any',
      });
    }
    for (const baseURL of [
      'https://x.ai.example.com/v1',
      'https://notx.ai/v1',
      'https://example.com/api.x.ai',
      'invalid',
    ]) {
      expect(isXaiHost(baseURL)).toBe(false);
      expect(effectiveCompat(compatible({ baseURL }))).toMatchObject({
        supportsCustomTools: true,
        supportsNamespaceTools: true,
        toolChoice: 'any',
      });
    }
  });

  it('true / any 可以覆盖地址默认，undefined 仍用地址默认；其他 compat 不丢失、不修改 Provider', () => {
    const provider = compatible({
      baseURL: 'https://api.x.ai/v1',
      compat: {
        supportsCustomTools: true,
        supportsNamespaceTools: true,
        toolChoice: 'any',
        maxTokensField: 'max_tokens',
      },
    });
    expect(effectiveCompat(provider)).toEqual(provider.compat);
    const undeclared = compatible({
      baseURL: provider.baseURL,
      compat: { supportsCustomTools: undefined, supportsNamespaceTools: undefined },
    });
    expect(effectiveCompat(undeclared)).toEqual({
      supportsCustomTools: false,
      supportsNamespaceTools: false,
      toolChoice: 'any',
    });
    expect(undeclared.compat?.supportsNamespaceTools).toBeUndefined();
  });
});
