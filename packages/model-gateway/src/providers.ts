// 按 Provider 选处理方式（docs/architecture/model-gateway.md §2）与网关自己的配置检查。

import type { ProviderIssue } from '@wevir/runtime-adapter';
import type { GatewayProvider } from './types.js';

/** DeepSeek 的 Responses 端点（官方 Codex 接入文档：api-docs.deepseek.com/quick_start/agent_integrations/codex）。 */
export const DEEPSEEK_RESPONSES_BASE_URL = 'https://api.deepseek.com';

export type Route =
  | { mode: 'responses'; url: string }
  | { mode: 'chat'; url: string }
  | { mode: 'unsupported'; message: string };

/** Anthropic Messages 还没做（R10）：检查与请求时都这样说。 */
export const ANTHROPIC_UNSUPPORTED =
  'Codex 引擎的模型网关暂不支持 anthropic-messages 协议（R10 之后支持）';

/**
 * Provider → 上游地址与处理方式：
 * - `deepseek-official`：Responses 透传到 DeepSeek（`deepseekBaseURL`，默认官方地址）。Provider 的 `baseURL`
 *   不用：那是 dsh 的 Anthropic Messages 地址（providers.md §2.2），协议不同。
 * - `openai-compatible` + `openai-responses`：透传到 `<baseURL>/responses`。
 * - `openai-compatible` + `openai-completions`：转换后发往 `<baseURL>/chat/completions`。
 * - 其余（`anthropic-messages`、缺字段）：不支持，原因在 `message` 里。
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
  return provider.api === 'openai-responses'
    ? { mode: 'responses', url: `${base}/responses` }
    : { mode: 'chat', url: `${base}/chat/completions` };
}

/**
 * 网关处理不了的配置（adapter-codex 的 `validateProvider` 用它，与 dsh 的检查无关）：协议、地址、compat 开关的取值。
 */
export function validateProvider(provider: GatewayProvider): ProviderIssue[] {
  const issues: ProviderIssue[] = [];
  const issue = (path: ProviderIssue['path'], message: string) => issues.push({ path, message });
  if (provider.kind === 'openai-compatible') {
    if (provider.api === 'anthropic-messages') issue(['api'], ANTHROPIC_UNSUPPORTED);
    else if (provider.api !== 'openai-responses' && provider.api !== 'openai-completions') {
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
