import type { ProviderConfig } from '@wevir/runtime-adapter';
import { describe, expect, it } from 'vitest';
import {
  appToolsConfig,
  autoCompactLimit,
  catalogEntry,
  chatgptEndpointEnv,
  chatgptThreadConfig,
  codexProviderId,
  contextWindowOf,
  DEFAULT_CONTEXT_WINDOW,
  fromCodexEffort,
  renderChatgptConfigToml,
  renderConfigToml,
  renderModelCatalog,
  sessionEnvConfig,
  threadConfig,
  toCodexEffort,
  tomlString,
  webToolThreadConfig,
  windowsSandboxTable,
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

  it('Windows 上打开 Codex 的受限令牌沙箱（ADR-0005 补记 17），其他平台不写', () => {
    expect(windowsSandboxTable('win32')).toEqual(['', '[windows]', 'sandbox = "unelevated"']);
    expect(windowsSandboxTable('darwin')).toEqual([]);
    expect(windowsSandboxTable('linux')).toEqual([]);
  });

  it('包含 ADR-0005 决策 5 与补记 1 的全部加固项', () => {
    for (const line of [
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      'approvals_reviewer = "user"',
      'check_for_update_on_startup = false',
      'web_search = "disabled"',
      '[analytics]\nenabled = false',
      '[features]\nplugins = false\napps = false\ngoals = true\nimage_generation = true\nmemories = false\ninstant_interrupt = false',
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
      supports_search_tool: true,
    });
    // 没填上下文大小的按默认值写，Codex 才会自动压缩（codex-event-mapping §3）。
    expect(catalog.models[1]).toMatchObject({ context_window: DEFAULT_CONTEXT_WINDOW });
    expect(catalog.models[2]).toMatchObject({ input_modalities: ['text', 'image'], priority: 3 });
    expect(renderModelCatalog([], render)).toBeUndefined();
  });

  it('工具搜索按 Provider 的 compat toolSearch：默认打开，off 时关', () => {
    const off = { ...deepseek, compat: { toolSearch: 'off' as const } };
    const catalog = JSON.parse(renderModelCatalog([off, openaiNamed], render) ?? '') as {
      models: Array<Record<string, unknown>>;
    };
    expect(catalog.models.map((m) => [m.slug, m.supports_search_tool])).toEqual([
      ['deepseek-flash', false],
      ['deepseek-v4-pro', false],
      ['gpt-x', true],
    ]);
    expect(catalogEntry({ id: 'm' }, 'base', 1)).toMatchObject({ supports_search_tool: false });
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

describe('sessionEnvConfig（0.130.0）', () => {
  it('环境的变量放进 shell_environment_policy.set，值登记打码（太短的不登记）；没有变量时不覆盖', () => {
    const secrets: string[] = [];
    expect(
      sessionEnvConfig({ STRIPE_SECRET_KEY: 'sk_test_51abc', NODE_ENV: 'test' }, (value) =>
        secrets.push(value),
      ),
    ).toEqual({
      'shell_environment_policy.set': { STRIPE_SECRET_KEY: 'sk_test_51abc', NODE_ENV: 'test' },
    });
    expect(secrets).toEqual(['sk_test_51abc']);
    expect(sessionEnvConfig(undefined)).toEqual({});
    expect(sessionEnvConfig({})).toEqual({});
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
      model_context_window: DEFAULT_CONTEXT_WINDOW,
    });
  });

  it('上下文大小与自动压缩阈值：没填时按默认值，阈值是 90%', () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(128_000);
    expect(contextWindowOf({ id: 'x' })).toBe(128_000);
    expect(contextWindowOf({ id: 'x', contextWindow: 32_768 })).toBe(32_768);
    expect(autoCompactLimit({ id: 'x' })).toBe(115_200);
    expect(autoCompactLimit({ id: 'x', contextWindow: 262_144 })).toBe(235_929);
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

describe('renderChatgptConfigToml（ChatGPT 进程，R6）', () => {
  const toml = renderChatgptConfigToml();

  it('加固项照旧，另有 openai Provider、文件存凭据、只许 ChatGPT 登录；没有 Wevir 的 Provider 与模型目录', () => {
    for (const line of [
      'approval_policy = "on-request"',
      'web_search = "disabled"',
      'model_provider = "openai"',
      'cli_auth_credentials_store = "file"',
      'forced_login_method = "chatgpt"',
      'mcp_oauth_credentials_store = "file"',
      '[features]\nplugins = false\napps = false\ngoals = true\nimage_generation = true\nmemories = false\ninstant_interrupt = false',
      '[shell_environment_policy]\nignore_default_excludes = false\nexclude = ["WEVIR_*"]',
    ]) {
      expect(toml).toContain(line);
    }
    expect(toml).not.toContain('model_catalog_json');
    expect(toml).not.toContain('[model_providers');
    expect(toml).not.toContain('WEVIR_GATEWAY_TOKEN');
    expect(toml).not.toContain('chatgpt_base_url');
  });

  it('顶层键都在第一张表之前', () => {
    const firstTable = toml.indexOf('\n[');
    for (const key of ['model_provider =', 'cli_auth_credentials_store', 'forced_login_method']) {
      expect(toml.indexOf(key)).toBeLessThan(firstTable);
    }
  });

  it('测试用的 mock 地址：后端写进 chatgpt_base_url 与 openai_base_url，登录服务走环境变量', () => {
    const endpoints = { issuer: 'http://127.0.0.1:9/', backend: 'http://127.0.0.1:9' };
    const withMock = renderChatgptConfigToml(endpoints);
    expect(withMock).toContain('chatgpt_base_url = "http://127.0.0.1:9/backend-api/"');
    expect(withMock).toContain('openai_base_url = "http://127.0.0.1:9/backend-api/codex"');
    expect(withMock.indexOf('openai_base_url')).toBeLessThan(withMock.indexOf('\n['));
    expect(chatgptEndpointEnv(endpoints)).toEqual({
      CODEX_APP_SERVER_LOGIN_ISSUER: 'http://127.0.0.1:9',
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: 'http://127.0.0.1:9/oauth/token',
    });
  });

  it('会话只覆盖推理档位', () => {
    expect(chatgptThreadConfig(undefined)).toEqual({});
    expect(chatgptThreadConfig('off')).toEqual({ model_reasoning_effort: 'none' });
    expect(chatgptThreadConfig('high')).toEqual({ model_reasoning_effort: 'high' });
  });
});

describe('Vertex 凭据边界', () => {
  it('服务账号 JSON 不进 Codex 配置、模型目录或 thread 配置', () => {
    const provider: ProviderConfig = {
      id: 'vertex',
      kind: 'google-vertex',
      displayName: 'Vertex',
      api: 'openai-completions',
      vertex: { project: 'vertex-example', location: 'global' },
      models: [{ id: 'google/gemini-3.8-flash' }],
      defaultModelId: 'google/gemini-3.8-flash',
      serviceAccountJson: 'service-account-must-stay-in-host',
    };
    const rendered = JSON.stringify([
      renderConfigToml({ providers: [provider], gatewayBaseURL }),
      renderModelCatalog([provider], () => 'test prompt'),
      threadConfig(
        provider,
        { id: provider.defaultModelId },
        gatewayBaseURL(provider.id),
        undefined,
      ),
    ]);
    expect(rendered).not.toContain('service-account-must-stay-in-host');
    expect(rendered).not.toContain('serviceAccountJson');
    expect(rendered).not.toContain('aiplatform.googleapis.com');
  });
});

describe('读历史的工具（0.25.0）', () => {
  const server = {
    script: '/data/mcp/wevir-history.mjs',
    node: '/usr/bin/node',
    historyDir: '/data/history',
  };

  it('两种进程的 config.toml 都登记 [mcp_servers.wevir_history]：只开 read_session_history、不需要批准', () => {
    const table = [
      '[mcp_servers.wevir_history]',
      'command = "/usr/bin/node"',
      'args = ["/data/mcp/wevir-history.mjs", "/data/history"]',
      'env = { ELECTRON_RUN_AS_NODE = "1" }',
      'default_tools_approval_mode = "approve"',
      'enabled_tools = ["read_session_history"]',
    ].join('\n');
    const gateway = renderConfigToml({
      providers: [deepseek],
      gatewayBaseURL: () => 'http://127.0.0.1:1/v1/p/deepseek',
      historyTool: server,
    });
    expect(gateway).toContain(table);
    expect(renderChatgptConfigToml(undefined, undefined, server)).toContain(table);
    expect(
      renderConfigToml({ providers: [deepseek], gatewayBaseURL: () => 'http://x' }),
    ).not.toContain('wevir_history');
  });
});

describe('联网工具（0.34.0）', () => {
  const webTool = {
    server: {
      script: '/data/mcp/wevir-web.mjs',
      node: '/usr/bin/node',
      endpoint: () => undefined,
      state: () => ({ enabled: true, search: true }),
    },
    endpoint: { url: 'http://127.0.0.1:4567', token: 'secret-token-not-in-file' },
  };

  it('网关进程登记两个工具，ChatGPT 进程只有抓取；令牌经 env_vars 转、不写进文件', () => {
    const gateway = renderConfigToml({
      providers: [deepseek],
      gatewayBaseURL: () => 'http://127.0.0.1:1/v1/p/deepseek',
      webTool,
    });
    expect(gateway).toContain(
      [
        '[mcp_servers.wevir_web]',
        'command = "/usr/bin/node"',
        'args = ["/data/mcp/wevir-web.mjs", "http://127.0.0.1:4567"]',
        'env = { ELECTRON_RUN_AS_NODE = "1" }',
        'env_vars = ["WEVIR_WEB_TOKEN"]',
        'default_tools_approval_mode = "approve"',
        'enabled_tools = ["web_search", "web_fetch"]',
        'omit_tools_from = ["deferred"]',
        'startup_timeout_sec = 10',
        'tool_timeout_sec = 60',
        '',
        '[mcp_servers.wevir_web.tools.web_search]',
        'output_token_limit = 4000',
        '',
        '[mcp_servers.wevir_web.tools.web_fetch]',
        'output_token_limit = 12000',
      ].join('\n'),
    );
    // Codex 托管的搜索照旧关着。
    expect(gateway).toContain('web_search = "disabled"');
    expect(gateway).not.toContain('secret-token-not-in-file');
    const chatgpt = renderChatgptConfigToml(undefined, undefined, undefined, webTool);
    expect(chatgpt).toContain('enabled_tools = ["web_fetch"]');
    expect(chatgpt).not.toContain('[mcp_servers.wevir_web.tools.web_search]');
    expect(chatgpt).not.toContain('secret-token-not-in-file');
  });

  it('每个会话按设置收窄：关着不起，没有 Key 只有抓取', () => {
    expect(webToolThreadConfig({ enabled: true, search: true })).toEqual({
      'mcp_servers.wevir_web.enabled': true,
      'mcp_servers.wevir_web.enabled_tools': ['web_search', 'web_fetch'],
    });
    expect(webToolThreadConfig({ enabled: true, search: false })).toEqual({
      'mcp_servers.wevir_web.enabled': true,
      'mcp_servers.wevir_web.enabled_tools': ['web_fetch'],
    });
    expect(webToolThreadConfig({ enabled: false, search: true })).toEqual({
      'mcp_servers.wevir_web.enabled': false,
    });
  });

  it('ChatGPT 会话：联网开着用 Codex 托管搜索的 cached，关着 disabled；登记了 wevir_web 时只开抓取', () => {
    expect(chatgptThreadConfig('high', { enabled: true, search: true }, true)).toEqual({
      model_reasoning_effort: 'high',
      web_search: 'cached',
      'mcp_servers.wevir_web.enabled': true,
      'mcp_servers.wevir_web.enabled_tools': ['web_fetch'],
    });
    expect(chatgptThreadConfig(undefined, { enabled: false, search: false }, true)).toEqual({
      web_search: 'disabled',
      'mcp_servers.wevir_web.enabled': false,
    });
    expect(chatgptThreadConfig(undefined, { enabled: true, search: false })).toEqual({
      web_search: 'cached',
    });
  });
});

describe('应用级工具的两个服务', () => {
  it('wevir 只列常驻层且不延迟，wevir_more 列按需层；同一个令牌', () => {
    const config = appToolsConfig({ url: 'http://127.0.0.1:4567/mcp', token: 'tok' });
    expect(config).toEqual({
      'mcp_servers.wevir': {
        url: 'http://127.0.0.1:4567/mcp?tier=core',
        http_headers: { Authorization: 'Bearer tok' },
        startup_timeout_sec: 10,
        tool_timeout_sec: 660,
        default_tools_approval_mode: 'auto',
        omit_tools_from: ['deferred'],
      },
      'mcp_servers.wevir_more': {
        url: 'http://127.0.0.1:4567/mcp?tier=more',
        http_headers: { Authorization: 'Bearer tok' },
        startup_timeout_sec: 10,
        tool_timeout_sec: 660,
        default_tools_approval_mode: 'auto',
      },
    });
  });
});
