// “测试连接”的结果怎样读给用户（T5.4）：成功时说用时；失败时按 provider.test 的 `reason`（providers.md §6.2）
// 给一句结论和修复建议，再附适配器给的中文说明与服务端原文（Key 已替换成 ***）。纯函数。

import { isRpcError } from '@wevir/client-sdk';
import type { MethodResult, ProviderTestFailure } from '@wevir/protocol';
import { describe } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';

export interface TestPresentation {
  ok: boolean;
  title: string;
  hint?: string;
  /** 失败的详细说明（适配器的中文说明 + 服务端原文）。 */
  detail?: string;
}

const REASON_TITLE: Record<ProviderTestFailure, PlainMessageKey> = {
  missing_key: 'provider.test.reason.missing_key',
  network: 'provider.test.reason.network',
  timeout: 'provider.test.reason.timeout',
  auth: 'provider.test.reason.auth',
  model_not_found: 'provider.test.reason.model_not_found',
  protocol: 'provider.test.reason.protocol',
  rate_limited: 'provider.test.reason.rate_limited',
  server: 'provider.test.reason.server',
  unknown: 'provider.test.reason.unknown',
};

const REASON_HINT: Partial<Record<ProviderTestFailure, PlainMessageKey>> = {
  network: 'provider.test.hint.network',
  timeout: 'provider.test.hint.timeout',
  auth: 'provider.test.hint.auth',
  model_not_found: 'provider.test.hint.model_not_found',
  protocol: 'provider.test.hint.protocol',
  rate_limited: 'provider.test.hint.rate_limited',
};

export function presentTestResult(result: MethodResult<'provider.test'>): TestPresentation {
  if (result.ok) {
    return {
      ok: true,
      title:
        result.latencyMs === undefined
          ? t('provider.test.ok')
          : t('provider.test.okLatency', { latency: formatLatency(result.latencyMs) }),
    };
  }
  const reason = result.reason ?? 'unknown';
  const hint = REASON_HINT[reason];
  const presentation: TestPresentation = { ok: false, title: t(REASON_TITLE[reason]) };
  if (hint) presentation.hint = t(hint);
  if (result.error?.code === 'ollama_responses_unavailable')
    presentation.hint = t('provider.ollama.upgrade');
  if (result.error?.message) presentation.detail = result.error.message;
  return presentation;
}

function formatLatency(ms: number): string {
  return ms < 1000
    ? t('provider.test.milliseconds', { ms: Math.round(ms) })
    : t('provider.test.seconds', { seconds: (ms / 1000).toFixed(1) });
}

/** 测试没能完成（Provider 已被删除、与 Host 断开等），不是连通性的结论。 */
export function presentTestError(error: unknown): TestPresentation {
  return {
    ok: false,
    title: t('provider.test.notRun'),
    detail: isRpcError(error, 'PROVIDER_NOT_FOUND') ? t('provider.test.gone') : describe(error),
  };
}
