// 设置 → 联网搜索的纯逻辑（0.34.0）：搜索服务的显示名与 `web.test` 结果的说法。

import type { WebTestFailure, WebTestResult } from '@wevir/protocol';
import { type PlainMessageKey, t } from '@/i18n';
import type { Notice } from './settings-ui';

/** 认得的搜索服务的名字；Host 以后多出来的按 ID 显示。 */
const SERVICE_NAMES: Readonly<Record<string, PlainMessageKey>> = {
  bocha: 'settings.web.service.bocha',
  tavily: 'settings.web.service.tavily',
};

const REASONS: Record<WebTestFailure, PlainMessageKey> = {
  missing_key: 'provider.test.reason.missing_key',
  auth: 'provider.test.reason.auth',
  quota: 'settings.web.test.quota',
  rate_limited: 'provider.test.reason.rate_limited',
  network: 'provider.test.reason.network',
  timeout: 'provider.test.reason.timeout',
  server: 'provider.test.reason.server',
  invalid_response: 'settings.web.test.invalidResponse',
  unknown: 'provider.test.reason.unknown',
};

export function serviceName(id: string): string {
  const key = SERVICE_NAMES[id];
  return key === undefined ? id : t(key);
}

/** `web.test` 的结果 → 一条通知：成功说用时，失败说原因并附服务端原文。 */
export function testNotice(result: WebTestResult): Notice {
  if (result.ok) {
    return {
      tone: 'success',
      text: t('provider.test.okLatency', {
        latency: t('provider.test.milliseconds', { ms: result.latencyMs ?? 0 }),
      }),
    };
  }
  const reason = t(REASONS[result.reason ?? 'unknown']);
  return {
    tone: 'error',
    text: result.message ? `${reason}${t('common.colon')}${result.message}` : reason,
  };
}
