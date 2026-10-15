// 按 Provider 选处理方式（docs/architecture/model-gateway.md §2）与网关自己的配置检查。

import type { ProviderIssue } from '@wevir/runtime-adapter';
import type { GatewayCompat, GatewayProvider } from './types.js';

/** DeepSeek 的 Responses 端点（官方 Codex 接入文档：api-docs.deepseek.com/quick_start/agent_integrations/codex）。 */
export const DEEPSEEK_RESPONSES_BASE_URL = 'https://api.deepseek.com';

export type Route =
  | { mode: 'responses'; url: string }
  | { mode: 'chat'; url: string }
  | { mode: 'messages'; url: string }
  | { mode: 'unsupported'; message: string };

/** `anthropic-messages` 上 `compat.thinkingFormat` 的取值（model-gateway.md §5.4）。 */
export const MESSAGES_THINKING_FORMATS = ['adaptive', 'enabled'] as const;

/** 地址 → 默认 compat（model-gateway.md §4.4）；各家只在此登记，显式开关仍优先。 */
export const PROVIDER_COMPAT_DEFAULTS: readonly {
  matches(baseURL: string): boolean;
  compat: GatewayCompat;
}[] = [
  { matches: isXaiHost, compat: { supportsCustomTools: false, supportsNamespaceTools: false } },
];

/** 每个字段按 Provider 声明 > 地址默认 > 全局默认取值，undefined 视为没写。 */
export function effectiveCompat(provider: GatewayProvider): GatewayCompat {
  const defaults = PROVIDER_COMPAT_DEFAULTS.find((entry) =>
    entry.matches(provider.baseURL ?? ''),
  )?.compat;
  const declared = provider.compat;
  return {
    ...declared,
    supportsCustomTools: declared?.supportsCustomTools ?? defaults?.supportsCustomTools ?? true,
    supportsNamespaceTools:
      declared?.supportsNamespaceTools ?? defaults?.supportsNamespaceTools ?? true,
    toolChoice: declared?.toolChoice ?? defaults?.toolChoice ?? 'any',
  };
}

/**
 * Provider → 上游地址与处理方式：
 * - `deepseek-official`：Responses 透传到 DeepSeek（`deepseekBaseURL`，默认官方地址）。Provider 的 `baseURL`
 *   不用：那是 dsh 的 Anthropic Messages 地址（providers.md §2.2），协议不同。
 * - `openai-compatible` + `openai-responses`：透传到 `<baseURL>/responses`。
 * - `openai-compatible` + `openai-completions`：转换后发往 `<baseURL>/chat/completions`。
 * - `openai-compatible` + `anthropic-messages`：转换后发往 `<baseURL>/v1/messages`（`baseURL` 已以 `/v1` 结尾时
 *   只加 `/messages`，与 adapter-dsh 对 DeepSeek 的 Messages 地址同一拼法）。
 * - 其余（缺字段、取值不对）：不支持，原因在 `message` 里。
 */
export function routeOf(
  provider: GatewayProvider,
  deepseekBaseURL = DEEPSEEK_RESPONSES_BASE_URL,
  model = provider.defaultModelId,
): Route {
  if (provider.kind === 'deepseek-official') {
    return { mode: 'responses', url: `${trimSlash(deepseekBaseURL)}/responses` };
  }
  const issues = validateProvider(provider);
  if (issues.length > 0) return { mode: 'unsupported', message: describeIssues(issues) };
  if (provider.kind === 'google-vertex') {
    const project = provider.vertex?.project ?? '';
    const location = provider.vertex?.location ?? 'global';
    const host =
      location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
    if (!vertexModelMatches(provider.api, model))
      return { mode: 'unsupported', message: '模型 ID 与 Vertex 协议不匹配' };
    if (provider.api === 'anthropic-messages')
      return {
        mode: 'messages',
        url: `https://${host}/v1/projects/${project}/locations/${location}/publishers/anthropic/models/${encodeURIComponent(model)}:streamRawPredict`,
      };
    const version = location === 'global' ? 'v1' : 'v1beta1';
    return {
      mode: 'chat',
      url: `https://${host}/${version}/projects/${project}/locations/${location}/endpoints/openapi/chat/completions`,
    };
  }
  const base = trimSlash(provider.baseURL ?? '');
  if (provider.api === 'openai-responses') return { mode: 'responses', url: `${base}/responses` };
  if (provider.api === 'anthropic-messages') {
    return {
      mode: 'messages',
      url: base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`,
    };
  }
  return { mode: 'chat', url: `${base}/chat/completions` };
}

/**
 * 网关处理不了的配置（adapter-codex 的 `validateProvider` 用它，与 dsh 的检查无关）：协议、地址、compat 开关的取值。
 */
export function validateProvider(provider: GatewayProvider): ProviderIssue[] {
  const issues: ProviderIssue[] = [];
  const issue = (path: ProviderIssue['path'], message: string) => issues.push({ path, message });
  if (provider.kind === 'openai-compatible') {
    if (
      !['openai-responses', 'openai-completions', 'anthropic-messages'].includes(provider.api ?? '')
    ) {
      issue(
        ['api'],
        provider.api === undefined
          ? 'OpenAI 兼容 Provider 必须有 api'
          : `不认识的协议 ${provider.api}`,
      );
    }
    if (provider.baseURL === undefined) issue(['baseURL'], 'OpenAI 兼容 Provider 必须有 baseURL');
    else {
      const problem = baseURLProblem(provider.baseURL);
      if (problem !== undefined) issue(['baseURL'], problem);
    }
  } else if (provider.kind === 'google-vertex') {
    if (!['openai-completions', 'anthropic-messages'].includes(provider.api ?? ''))
      issue(['api'], 'Vertex 只支持 Gemini Chat 或 Claude Messages');
    if (!/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{1,32})$/.test(provider.vertex?.project ?? ''))
      issue(['vertex', 'project'], '请填写有效的 Google Cloud project ID 或项目编号');
    const location = provider.vertex?.location ?? 'global';
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(location))
      issue(['vertex', 'location'], '请填写有效的 Google Cloud location');
    if (provider.baseURL !== undefined)
      issue(['baseURL'], 'Vertex 地址由 project 与 location 生成');
    if (provider.models.length === 0) issue(['models'], '至少要有一个模型');
    for (const [index, model] of provider.models.entries()) {
      if (!vertexModelMatches(provider.api, model.id))
        issue(['models', index, 'id'], '模型 ID 与 Vertex 协议不匹配');
    }
    if (!provider.models.some((m) => m.id === provider.defaultModelId))
      issue(['defaultModelId'], '默认模型必须在模型列表里');
  } else if (provider.kind !== 'deepseek-official') {
    issue(['kind'], `不认识的 Provider 类型 ${String(provider.kind)}`);
  }
  const compat = provider.compat ?? {};
  if (
    compat.systemMessageMode !== undefined &&
    !['inline', 'merge', 'user'].includes(compat.systemMessageMode)
  ) {
    issue(['compat', 'systemMessageMode'], 'systemMessageMode 只能是 inline、merge 或 user');
  }
  if (compat.supportsCustomTools !== undefined && typeof compat.supportsCustomTools !== 'boolean') {
    issue(['compat', 'supportsCustomTools'], 'supportsCustomTools 只能是 true 或 false');
  }
  if (
    compat.supportsNamespaceTools !== undefined &&
    typeof compat.supportsNamespaceTools !== 'boolean'
  ) {
    issue(['compat', 'supportsNamespaceTools'], 'supportsNamespaceTools 只能是 true 或 false');
  }
  if (compat.toolChoice !== undefined && !['any', 'auto_only'].includes(compat.toolChoice)) {
    issue(['compat', 'toolChoice'], 'toolChoice 只能是 any 或 auto_only');
  }
  if (compat.geminiToolSchema !== undefined && typeof compat.geminiToolSchema !== 'boolean') {
    issue(['compat', 'geminiToolSchema'], 'geminiToolSchema 只能是 true 或 false');
  }
  // Chat 读取已实现的思考格式；其他 pi-ai 格式仍接受保存并沿用旧发法，不收窄协议的 string 类型。
  if (
    provider.api === 'anthropic-messages' &&
    compat.thinkingFormat !== undefined &&
    !(MESSAGES_THINKING_FORMATS as readonly string[]).includes(compat.thinkingFormat)
  ) {
    issue(
      ['compat', 'thinkingFormat'],
      'anthropic-messages 的 thinkingFormat 只能是 adaptive 或 enabled',
    );
  }
  return issues;
}

export function describeIssues(issues: readonly ProviderIssue[]): string {
  return issues.map((i) => `${i.path.join('.')}：${i.message}`).join('；');
}

function baseURLProblem(baseURL: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return `不是合法的地址：${baseURL}`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'baseURL 只能是 http 或 https';
  if (url.username !== '' || url.password !== '') return 'baseURL 不能带用户名或密码，Key 单独填写';
  if (url.search !== '' || url.hash !== '') return 'baseURL 不能带查询参数或片段';
  return undefined;
}

/** 与 adapter-dsh 的 compat 默认值同一判断（providers.md §2.3）。 */
export function isOpenAIOfficial(baseURL: string): boolean {
  return hostnameOf(baseURL) === 'api.openai.com';
}

/** Anthropic 按量 API；其他 Messages 兼容服务不套用 Claude 的模型限制。 */
export function isAnthropicHost(baseURL: string): boolean {
  return hostnameOf(baseURL) === 'api.anthropic.com';
}

export function isDeepSeekHost(baseURL: string): boolean {
  return /(^|\.)deepseek\.com$/.test(hostnameOf(baseURL));
}

/**
 * xAI 的 API（`api.x.ai`，以及 `us.api.x.ai` 这类地域端点）。Responses 透传按它补 xAI 的方言（model-gateway.md
 * §3.2）：不支持自定义工具与 namespace 工具。经代理或自建网关接 xAI 时地址认不出，用 compat 开关。
 */
export function isXaiHost(baseURL: string): boolean {
  return /(^|\.)x\.ai$/.test(hostnameOf(baseURL));
}

/**
 * Google 的 Gemini API（OpenAI 兼容端点 `generativelanguage.googleapis.com/v1beta/openai/`）。Chat 转换按它带回
 * thought signature（model-gateway.md §4.5）。
 */
export function isGeminiHost(baseURL: string): boolean {
  return hostnameOf(baseURL) === 'generativelanguage.googleapis.com';
}

function hostnameOf(baseURL: string): string {
  try {
    return new URL(baseURL).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Vertex 只接 Gemini 与 Claude，模型名不能改变 URL 的路径。 */
export function vertexModelMatches(api: string | undefined, model: string): boolean {
  return api === 'openai-completions'
    ? /^google\/gemini-[a-z0-9][a-z0-9.-]*$/.test(model)
    : api === 'anthropic-messages' && /^claude-[a-z0-9][a-z0-9.-]*(?:@[0-9]{8})?$/.test(model);
}
