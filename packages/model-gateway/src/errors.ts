// 上游非 2xx 的正文整理成 OpenAI 的错误形状 `{"error": {"message", "type"?, "code"?}}` 再交给 Codex。
// Codex 按状态码决定重试，按 `error.code` / `error.type` 认出额度用完等情况（codex-api/src/api_bridge.rs），
// 所以上游给了 type / code 就保留。

import { isPhalaHost, isXaiHost } from './providers.js';
import { isObject } from './tools.js';

/** 上游错误原文最多保留这么多字符。 */
const MAX_MESSAGE_CHARS = 4000;

export interface ErrorBody {
  error: { message: string; type?: string; code?: string };
}

/** Phala 的路由不可用与证明失败不是协议错误；标记进 message 以穿过 Codex 的 HTTP 错误封装。 */
export function phalaRoutingError(
  body: ErrorBody,
  status: number,
  baseURL: string,
): ErrorBody | undefined {
  if (!isPhalaHost(baseURL)) return undefined;
  const error = body.error;
  const code =
    status === 404 && error.type === 'not_found_error'
      ? 'phala_no_route'
      : status === 503 &&
          error.type === 'service_unavailable' &&
          /upstream verification failed/i.test(error.message)
        ? 'phala_attestation_unavailable'
        : undefined;
  if (code === undefined) return undefined;
  return {
    error: { ...error, code, message: `[${code}] ${error.message}`.slice(0, MAX_MESSAGE_CHARS) },
  };
}

/**
 * 解析上游的错误正文：OpenAI 风格 `{error: {message, type, code}}`、`{error: "…"}`、Anthropic 风格
 * `{type: "error", error: {type, message}}`、`{message}` / `{detail}`，都不是时用原文。`secret` 出现在原文里的地方
 * 换成 `***`（有的服务会在报错里回显 Key）。`baseURL` 为 x.ai 地址时另保留字符串 error 旁的顶层 code。
 */
export function normalizeErrorBody(
  text: string,
  status: number,
  secret?: string,
  baseURL = '',
): ErrorBody {
  const redact = (s: string) =>
    (secret === undefined || secret === '' ? s : s.replaceAll(secret, '***')).slice(
      0,
      MAX_MESSAGE_CHARS,
    );
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  const fallback = text.trim() === '' ? `上游返回 HTTP ${status}` : text.trim();
  if (!isObject(data)) return { error: { message: redact(fallback) } };
  const error = data.error;
  if (typeof error === 'string')
    return {
      error: {
        message: redact(error),
        // SpaceXAI 官方地域端点的错误样本；只按地址补顶层 code，其他服务保持原有行为。
        ...(isXaiHost(baseURL) && typeof data.code === 'string' ? { code: redact(data.code) } : {}),
      },
    };
  const source = isObject(error) ? error : data;
  const message =
    typeof source.message === 'string' && source.message !== ''
      ? source.message
      : typeof source.detail === 'string'
        ? source.detail
        : fallback;
  return {
    error: {
      message: redact(message),
      ...(typeof source.type === 'string' && source.type !== 'error' ? { type: source.type } : {}),
      ...(typeof source.code === 'string' ? { code: source.code } : {}),
    },
  };
}

/** 网关自己产生的错误。 */
export function gatewayError(message: string, code?: string): string {
  return JSON.stringify({
    error: { message: `wevir gateway: ${message}`, ...(code === undefined ? {} : { code }) },
  });
}
