import { afterEach, describe, expect, it } from 'vitest';
import { loadCatalog, setLocale } from '@/i18n';
import { zhCN } from '@/i18n/zh-CN';
import { presentTestResult } from '@/settings/provider-test-result';
import { phalaErrorPresentation } from './phala-error';

afterEach(() => setLocale('zh-CN', zhCN));

describe('RedPill / Phala 路由错误的文案', () => {
  it.each([
    ['phala_no_route', 404, '没有符合条件的 RedPill 路由', '检查模型与路由条件'],
    [
      'phala_attestation_unavailable',
      503,
      'RedPill 暂无可证明的上游',
      '稍后重试或换用其他 TEE 模型',
    ],
  ] as const)('%s 在连接测试与 Codex 会话使用同一说法', (code, status, title, hint) => {
    const detail = `[${code}] upstream details`;
    expect(
      presentTestResult({
        ok: false,
        reason: 'server',
        httpStatus: status,
        error: { category: 'provider', code, message: detail },
      }),
    ).toEqual({ ok: false, title, hint, detail });
    // Codex 将 HTTP 状态作为 code，上游的标记只在 message 中保留。
    expect(
      phalaErrorPresentation({
        code: status,
        message: `unexpected status ${status}: {"error":{"message":"${detail}"}}`,
      }),
    ).toEqual({ title, hint });
  });

  it('换语言后按当前界面语言展示；普通 404 / 503 不冒充路由或证明错误', async () => {
    setLocale('en', await loadCatalog('en'));
    expect(phalaErrorPresentation({ code: 'phala_no_route' })?.title).toBe(
      'No RedPill route meets the constraints',
    );
    for (const code of [404, 503])
      expect(phalaErrorPresentation({ code, message: 'Not Found / Maintenance' })).toBeUndefined();
    expect(phalaErrorPresentation({ message: 'phala_no_route' })).toBeUndefined();
  });
});
