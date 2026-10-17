// 网关把标记同时写进 code 与 message；Codex 会把上游 HTTP 错误包装进会话原文，message 中的标记仍可识别。
import { t } from '@/i18n';

export function phalaErrorPresentation(error: {
  code?: string | number | undefined;
  message?: string | undefined;
}): { title: string; hint: string } | undefined {
  for (const code of ['phala_no_route', 'phala_attestation_unavailable'] as const) {
    if (error.code === code || error.message?.includes(`[${code}]`)) {
      return { title: t(`provider.phala.${code}.title`), hint: t(`provider.phala.${code}.hint`) };
    }
  }
  return undefined;
}
