import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderConfig } from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import { dshPaths } from './paths.js';
import {
  effectiveCompat,
  providerEnv,
  providerKeyEnv,
  providerOverlayEntries,
  providerOverlayPath,
  renderProviderOverlay,
  validateProviderConfig,
  writeProviderOverlay,
} from './provider-config.js';

const KEY = 'sk-wevir-test-0123456789abcdef';

const deepseek: ProviderConfig = {
  id: 'deepseek-official',
  kind: 'deepseek-official',
  displayName: 'DeepSeek',
  models: [],
  defaultModelId: 'deepseek-flash',
  apiKey: KEY,
};

const kimi: ProviderConfig = {
  id: 'kimi',
  kind: 'openai-compatible',
  displayName: 'Kimi: 月之暗面 # 国内站',
  api: 'openai-completions',
  baseURL: 'https://api.moonshot.cn/v1',
  models: [
    {
      id: 'kimi-k2.6',
      displayName: 'Kimi K2.6',
      contextWindow: 262144,
      maxTokens: 32768,
      supportsImages: true,
      reasoningEfforts: ['off', 'high'],
    },
    { id: 'kimi-k2.7-code', supportsImages: false, reasoningEfforts: [] },
  ],
  defaultModelId: 'kimi-k2.6',
  apiKey: `${KEY}-kimi`,
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('providerKeyEnv', () => {
  it('ID 转大写、- 换成 _', () => {
    expect(providerKeyEnv('deepseek-official')).toBe('WEVIR_PROVIDER_DEEPSEEK_OFFICIAL_KEY');
    expect(providerKeyEnv('my-gateway-2')).toBe('WEVIR_PROVIDER_MY_GATEWAY_2_KEY');
  });
});

describe('overlay', () => {
  it('只含 Key 的变量名、不含 Key；子进程环境里有 Key', () => {
    const text = renderProviderOverlay([deepseek, kimi]);
    expect(text).not.toContain(KEY);
    expect(text).toContain('WEVIR_PROVIDER_DEEPSEEK_OFFICIAL_KEY');
    expect(text).toContain('WEVIR_PROVIDER_KIMI_KEY');
    expect(providerEnv([deepseek, kimi])).toEqual({
      WEVIR_PROVIDER_DEEPSEEK_OFFICIAL_KEY: KEY,
      WEVIR_PROVIDER_KIMI_KEY: `${KEY}-kimi`,
    });
  });

  it('没存 Key 的 Provider 不进环境', () => {
    expect(
      providerEnv([
        { ...kimi, apiKey: undefined },
        { ...deepseek, apiKey: '' },
      ]),
    ).toEqual({});
  });

  it('DeepSeek 官方：llm-deepseek 与 web-search-deepseek 的 Key 引用都换成 Wevir 的变量；不列模型时用 dsh 自带目录', () => {
    expect(providerOverlayEntries([deepseek])).toEqual([
      { id: 'llm-deepseek', config: { apiKeyEnv: 'WEVIR_PROVIDER_DEEPSEEK_OFFICIAL_KEY' } },
      { id: 'web-search-deepseek', config: { apiKeyEnv: 'WEVIR_PROVIDER_DEEPSEEK_OFFICIAL_KEY' } },
    ]);
  });

  it('没有任何 Provider 时也改掉 DEEPSEEK_API_KEY 的引用，不写 llm-pi-ai', () => {
    const entries = providerOverlayEntries([]);
    expect(entries.map((e) => e.id)).toEqual(['llm-deepseek', 'web-search-deepseek']);
    expect(JSON.stringify(entries)).not.toContain('DEEPSEEK_API_KEY');
  });

  it('DeepSeek 官方：地址与模型（图片 → inputModalities）', () => {
    const [entry] = providerOverlayEntries([
      {
        ...deepseek,
        baseURL: 'https://gateway.example/anthropic',
        models: [
          {
            id: 'deepseek-flash',
            contextWindow: 1_000_000,
            maxTokens: 64_000,
            supportsImages: true,
          },
        ],
      },
    ]);
    expect(entry?.config).toEqual({
      apiKeyEnv: 'WEVIR_PROVIDER_DEEPSEEK_OFFICIAL_KEY',
      baseURL: 'https://gateway.example/anthropic',
      models: [
        {
          id: 'deepseek-flash',
          contextWindow: 1_000_000,
          maxTokens: 64_000,
          inputModalities: ['text', 'image'],
        },
      ],
    });
  });

  it('OpenAI 兼容：路由、默认 compat、模型的上下文 / 最大输出 / 图片 / 推理档位', () => {
    const pi = providerOverlayEntries([kimi]).find((e) => e.id === 'llm-pi-ai');
    expect(pi?.config).toEqual({
      providers: {
        kimi: {
          displayName: 'Kimi: 月之暗面 # 国内站',
          apiKeyEnv: 'WEVIR_PROVIDER_KIMI_KEY',
          api: 'openai-completions',
          baseURL: 'https://api.moonshot.cn/v1',
          compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
          models: [
            {
              id: 'kimi-k2.6',
              name: 'Kimi K2.6',
              contextWindow: 262144,
              maxTokens: 32768,
              input: ['text', 'image'],
              reasoningEfforts: { off: null, high: 'high' },
            },
            { id: 'kimi-k2.7-code', input: ['text'], reasoningEfforts: false },
          ],
        },
      },
    });
  });

  it('JSON 写成的 overlay 原样保留特殊字符（YAML 1.2 是 JSON 的超集）', () => {
    const text = renderProviderOverlay([kimi]);
    const json = text.slice(text.indexOf('['));
    expect(JSON.parse(json)).toEqual(providerOverlayEntries([kimi]));
  });

  it('不合法的 Provider 抛错，不生成配置', () => {
    expect(() => providerOverlayEntries([{ ...kimi, api: 'anthropic-messages' }])).toThrow(
      /anthropic-messages/,
    );
  });

  it('写进 DSH_HOME/wevir/providers.yml：目录 0700、文件 0600，重写是整体替换', () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'wevir-provider-config-')));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const paths = dshPaths(home);
    const file = writeProviderOverlay(paths, renderProviderOverlay([deepseek, kimi]));
    expect(file).toBe(join(paths.dshHome, 'wevir', 'providers.yml'));
    expect(file).toBe(providerOverlayPath(paths));
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(paths.dshHome, 'wevir')).mode & 0o777).toBe(0o700);
    }
    writeProviderOverlay(paths, renderProviderOverlay([deepseek]));
    const content = readFileSync(file, 'utf8');
    expect(content).not.toContain('kimi');
    expect(content).not.toContain(KEY);
  });
});

describe('effectiveCompat', () => {
  const compat = (patch: Partial<ProviderConfig>) => effectiveCompat({ ...kimi, ...patch });

  it('OpenAI 官方地址不补默认值', () => {
    expect(compat({ baseURL: 'https://api.openai.com/v1' })).toEqual({});
  });

  it('DeepSeek 的 OpenAI 兼容端点另加 thinkingFormat 与 reasoning_content 修正', () => {
    expect(compat({ baseURL: 'https://api.deepseek.com' })).toEqual({
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      thinkingFormat: 'deepseek',
      requiresReasoningContentOnAssistantMessages: true,
    });
  });

  it('用户给的值优先', () => {
    expect(
      compat({ compat: { maxTokensField: 'max_completion_tokens', supportsDeveloperRole: true } }),
    ).toEqual({ supportsDeveloperRole: true, maxTokensField: 'max_completion_tokens' });
  });

  it('openai-responses 只保留它认的开关（否则 dsh 拒绝整份配置）', () => {
    expect(compat({ api: 'openai-responses', baseURL: 'https://api.deepseek.com' })).toEqual({
      supportsDeveloperRole: false,
    });
  });
});

describe('validateProviderConfig', () => {
  const paths = (provider: ProviderConfig) =>
    validateProviderConfig(provider).map((issue) => issue.path.join('.'));

  it('合法配置没有问题', () => {
    expect(validateProviderConfig(deepseek)).toEqual([]);
    expect(validateProviderConfig(kimi)).toEqual([]);
  });

  it('DeepSeek 官方：不列模型时 defaultModelId 要在 dsh 自带目录里；推理档位不能配', () => {
    expect(paths({ ...deepseek, defaultModelId: 'deepseek-chat' })).toEqual(['defaultModelId']);
    expect(
      paths({
        ...deepseek,
        models: [{ id: 'deepseek-chat', reasoningEfforts: ['high'] }],
        defaultModelId: 'deepseek-chat',
      }),
    ).toEqual(['models.0.reasoningEfforts']);
  });

  it('OpenAI 兼容：保留的 ID、anthropic-messages、缺 baseURL、defaultModelId、重复模型、不认识的档位', () => {
    expect(paths({ ...kimi, id: 'deepseek-official' })).toEqual(['id']);
    expect(paths({ ...kimi, id: 'deepseek-account' })).toEqual(['id']);
    expect(validateProviderConfig({ ...kimi, api: 'anthropic-messages' })[0]?.message).toMatch(
      /只预留/,
    );
    expect(paths({ ...kimi, baseURL: undefined })).toEqual(['baseURL']);
    expect(paths({ ...kimi, defaultModelId: 'nope' })).toEqual(['defaultModelId']);
    expect(paths({ ...kimi, models: [{ id: 'a' }, { id: 'a' }], defaultModelId: 'a' })).toEqual([
      'models.1.id',
    ]);
    expect(
      paths({ ...kimi, models: [{ id: 'a', reasoningEfforts: ['turbo'] }], defaultModelId: 'a' }),
    ).toEqual(['models.0.reasoningEfforts']);
  });

  it('compat 开关与协议不匹配', () => {
    expect(
      paths({ ...kimi, api: 'openai-responses', compat: { maxTokensField: 'max_tokens' } }),
    ).toEqual(['compat.maxTokensField']);
  });

  it('baseURL 不能带凭据（会写进 DSH_HOME）、查询或片段', () => {
    expect(paths({ ...kimi, baseURL: 'https://user:sk-secret@api.example/v1' })).toEqual([
      'baseURL',
    ]);
    expect(paths({ ...kimi, baseURL: 'https://api.example/v1?key=1' })).toEqual(['baseURL']);
    expect(paths({ ...deepseek, baseURL: 'https://api.example/anthropic#x' })).toEqual(['baseURL']);
  });
});
