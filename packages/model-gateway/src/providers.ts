// 按 Provider 选处理方式（docs/architecture/model-gateway.md §2）与网关自己的配置检查。

import type { ProviderIssue } from '@wevir/runtime-adapter';
import type { GatewayProvider } from './types.js';

/** DeepSeek 的 Responses 端点（官方 Codex 接入文档：api-docs.deepseek.com/quick_start/agent_integrations/codex）。 */
export const DEEPSEEK_RESPONSES_BASE_URL = 'https://api.deepseek.com';

export type Route =
  | { mode: 'responses'; url: string }
  | { mode: 'chat'; url: string }
  | { mode: 'messages'; url: string }
  | { mode: 'unsupported'; message: string };

/** `anthropic-messages` 上 `compat.thinkingFormat` 的取值（model-gateway.md §5.4）。 */
export const MESSAGES_THINKING_FORMATS = ['adaptive', 'enabled'] as const;

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
): Route {
  if (provider.kind === 'deepseek-official') {
    return { mode: 'responses', url: `${trimSlash(deepseekBaseURL)}/responses` };
  }
  const issues = validateProvider(provider);
  if (issues.length > 0) return { mode: 'unsupported', message: describeIssues(issues) };
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
  // 其他协议的 thinkingFormat 是 pi-ai 的写法（adapter-dsh 用），网关不读也不查。
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

export function isDeepSeekHost(baseURL: string): boolean {
  return /(^|\.)deepseek\.com$/.test(hostnameOf(baseURL));
}

/**
 * xAI 的 API（`api.x.ai`，以及 `us.api.x.ai` 这类地域端点）。Responses 透传按它补 xAI 的方言（model-gateway.md
 * §3.2）：不支持自定义工具与 namespace 工具。经代理或自建网关接 xAI 时地址认不出，自定义工具用 compat 开关。
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
