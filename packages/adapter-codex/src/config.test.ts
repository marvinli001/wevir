import type { ProviderConfig } from '@wevir/runtime-adapter';
import { describe, expect, it } from 'vitest';
import {
  catalogEntry,
  codexProviderId,
  fromCodexEffort,
  renderConfigToml,
  renderModelCatalog,
  threadConfig,
  toCodexEffort,
  tomlString,
} from './config.js';

const deepseek: ProviderConfig = {
  id: 'deepseek',
  kind: 'deepseek-official',
  displayName: 'DeepSeek',
  models: [
    {
      id: 'deepseek-flash',
      displayName: 'DeepSeek Flash',
      contextWindow: 128_000,
      reasoningEfforts: ['off', 'high'],
    },
    { id: 'deepseek-v4-pro' },
  ],
  defaultModelId: 'deepseek-flash',
  apiKey: 'sk-must-not-appear',
};

const openaiNamed: ProviderConfig = {
  id: 'my-openai',
  kind: 'openai-compatible',
  displayName: 'OpenAI',
  api: 'openai-responses',
  baseURL: 'https://api.openai.com/v1',
  models: [
    { id: 'deepseek-flash', contextWindow: 64_000 },
    { id: 'gpt-x', supportsImages: true },
  ],
  defaultModelId: 'gpt-x',
  apiKey: 'sk-also-secret',
};

const gatewayBaseURL = (id: string) => `http://127.0.0.1:4567/v1/p/${id}`;

describe('renderConfigToml', () => {
  const toml = renderConfigToml({
    providers: [deepseek, openaiNamed],
    gatewayBaseURL,
    catalogFile: '/data/engines/codex/wevir-models.json',
  });

  it('包含 ADR-0005 决策 5 与补记 1 的全部加固项', () => {
    for (const line of [
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      'approvals_reviewer = "user"',
      'check_for_update_on_startup = false',
      'web_search = "disabled"',
      '[analytics]\nenabled = false',
      '[features]\nplugins = false\ngoals = false\nmemories = false',
      '[tools.update_plan]\nenabled = true',
      '[skills]\ninclude_instructions = false',
      '[skills.bundled]\nenabled = false',
      '[shell_environment_policy]\nignore_default_excludes = false\nexclude = ["WEVIR_*"]',
      'model_catalog_json = "/data/engines/codex/wevir-models.json"',
    ]) {
      expect(toml).toContain(line);
    }
  });

  it('顶层键都在第一张表之前（TOML 的要求）', () => {
    const firstTable = toml.indexOf('\n[');
    for (const key of ['approval_policy', 'model_catalog_json', 'model =', 'model_provider =']) {
      expect(toml.indexOf(key)).toBeLessThan(firstTable);
    }
  });

  it('每个 Provider 一个 wevir_<id>，指向网关，只有令牌的变量名，名字不会是 OpenAI', () => {
    expect(toml).toContain(
      [
        '[model_providers."wevir_my-openai"]',
        'name = "Wevir/OpenAI"',
        'base_url = "http://127.0.0.1:4567/v1/p/my-openai"',
        'wire_api = "responses"',
        'env_key = "WEVIR_GATEWAY_TOKEN"',
      ].join('\n'),
    );
    expect(toml).toContain('[model_providers."wevir_deepseek"]');
    expect(toml).toContain('model = "deepseek-flash"\nmodel_provider = "wevir_deepseek"');
    expect(toml).not.toMatch(/name = "OpenAI"/);
    expect(toml).not.toContain('sk-must-not-appear');
    expect(toml).not.toContain('sk-also-secret');
    expect(toml).not.toContain('api.openai.com');
  });

  it('没有 Provider 时不写默认模型与模型目录', () => {
    const empty = renderConfigToml({ providers: [], gatewayBaseURL });
    expect(empty).not.toContain('model_catalog_json');
    expect(empty).not.toContain('model_provider');
    expect(empty).not.toContain('[model_providers');
  });

  it('providerExtra 进每个 Provider 表', () => {
    expect(
      renderConfigToml({
        providers: [deepseek],
        gatewayBaseURL,
        providerExtra: { request_max_retries: 0 },
      }),
    ).toContain('env_key = "WEVIR_GATEWAY_TOKEN"\nrequest_max_retries = 0');
  });
});

describe('模型目录', () => {
  const render = (vars: { model_display_name: string; provider_display_name: string }) =>
    `I am ${vars.model_display_name} by ${vars.provider_display_name}`;

  it('每个模型一条，同名模型以先出现的 Provider 为准；没有模型时省略', () => {
    const catalog = JSON.parse(renderModelCatalog([deepseek, openaiNamed], render) ?? '') as {
      models: Array<Record<string, unknown>>;
    };
    expect(catalog.models.map((m) => m.slug)).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
      'gpt-x',
    ]);
    expect(catalog.models[0]).toMatchObject({
      display_name: 'DeepSeek Flash',
      base_instructions: 'I am DeepSeek Flash by DeepSeek',
      context_window: 128_000,
      apply_patch_tool_type: 'freeform',
      supported_reasoning_levels: [
        { effort: 'none', description: '不推理' },
        { effort: 'high', description: '深度推理' },
      ],
      input_modalities: ['text'],
      visibility: 'list',
      priority: 1,
    });
    expect(catalog.models[1]).not.toHaveProperty('context_window');
    expect(catalog.models[2]).toMatchObject({ input_modalities: ['text', 'image'], priority: 3 });
    expect(renderModelCatalog([], render)).toBeUndefined();
  });

  it('必填字段都在（codex-notes §3.3）', () => {
    const entry = catalogEntry({ id: 'm' }, 'base', 1);
    for (const key of [
      'slug',
      'display_name',
      'supported_reasoning_levels',
      'shell_type',
      'visibility',
      'supported_in_api',
      'priority',
      'support_verbosity',
      'truncation_policy',
      'experimental_supported_tools',
      'base_instructions',
    ]) {
      expect(entry).toHaveProperty(key);
    }
  });
});

describe('threadConfig 与其他', () => {
  it('会话的 Provider 条目、上下文大小与推理档位', () => {
    const model = deepseek.models[0];
    if (model === undefined) throw new Error('fixture');
    expect(threadConfig(deepseek, model, gatewayBaseURL('deepseek'), 'off')).toEqual({
      'model_providers.wevir_deepseek': {
        name: 'Wevir/DeepSeek',
        base_url: 'http://127.0.0.1:4567/v1/p/deepseek',
        wire_api: 'responses',
        env_key: 'WEVIR_GATEWAY_TOKEN',
      },
      model_context_window: 128_000,
      model_reasoning_effort: 'none',
    });
    expect(threadConfig(deepseek, { id: 'x' }, 'u', undefined)).toEqual({
      'model_providers.wevir_deepseek': expect.any(Object),
    });
  });

  it('推理档位与 Provider ID 的换算', () => {
    expect(toCodexEffort('off')).toBe('none');
    expect(toCodexEffort('xhigh')).toBe('xhigh');
    expect(fromCodexEffort('none')).toBe('off');
    expect(fromCodexEffort('medium')).toBe('medium');
    expect(codexProviderId('my-ds')).toBe('wevir_my-ds');
  });

  it('TOML 字符串转义（Windows 路径、引号、换行）', () => {
    expect(tomlString('C:\\Users\\a "b"\nc')).toBe('"C:\\\\Users\\\\a \\"b\\"\\nc"');
  });
});
