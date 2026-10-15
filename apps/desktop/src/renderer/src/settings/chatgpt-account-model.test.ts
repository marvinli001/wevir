import { describe, expect, it } from 'vitest';
import {
  accountPhase,
  planLabel,
  resetLabel,
  usageTone,
  windowName,
} from './chatgpt-account-model';

describe('ChatGPT 账号的界面阶段（R6）', () => {
  it('没读到、未登录（带失败原因）、浏览器与设备码登录中、已登录', () => {
    expect(accountPhase(undefined)).toEqual({ kind: 'loading' });
    expect(accountPhase({ kind: 'chatgpt', status: 'signed_out' })).toEqual({ kind: 'signed_out' });
    expect(
      accountPhase({ kind: 'chatgpt', status: 'signed_out', lastError: 'Login timed out' }),
    ).toEqual({ kind: 'signed_out', error: 'Login timed out' });
    expect(
      accountPhase({
        kind: 'chatgpt',
        status: 'signing_in',
        login: {
          loginId: 'l1',
          method: 'browser',
          authUrl: 'https://auth.openai.com/a',
          startedAt: '2026-10-14T08:00:00.000Z',
        },
      }),
    ).toEqual({ kind: 'browser', loginId: 'l1', authUrl: 'https://auth.openai.com/a' });
    expect(
      accountPhase({
        kind: 'chatgpt',
        status: 'signing_in',
        login: {
          loginId: 'l2',
          method: 'device_code',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-EFGH',
          startedAt: '2026-10-14T08:00:00.000Z',
        },
      }),
    ).toEqual({
      kind: 'device_code',
      loginId: 'l2',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
    });
    expect(
      accountPhase({ kind: 'chatgpt', status: 'signed_in', email: 'me@example.com', plan: 'pro' }),
    ).toEqual({ kind: 'signed_in', email: 'me@example.com', plan: 'pro' });
  });

  it('套餐名：认得的换成显示名，认不出的原样，unknown 不显示', () => {
    expect(planLabel('plus')).toBe('Plus');
    expect(planLabel('prolite')).toBe('Pro Lite');
    expect(planLabel('enterprise_cbp_usage_based')).toBe('enterprise_cbp_usage_based');
    expect(planLabel('unknown')).toBeUndefined();
    expect(planLabel(undefined)).toBeUndefined();
  });

  it('用量窗口的名字、重置时间与颜色', () => {
    expect(windowName({ usedPercent: 1, windowMinutes: 300 })).toBe('5 小时用量');
    expect(windowName({ usedPercent: 1, windowMinutes: 10080 })).toBe('每周用量');
    expect(windowName({ usedPercent: 1, windowMinutes: 2880 })).toBe('2 天用量');
    expect(windowName({ usedPercent: 1 })).toBe('用量');
    const now = new Date('2026-10-14T08:00:00');
    expect(resetLabel('2026-10-14T10:30:00', now)).toBe('今天 10:30 重置');
    expect(resetLabel('2026-10-20T09:05:00', now)).toBe('10月20日 09:05 重置');
    expect(resetLabel(undefined, now)).toBeUndefined();
    expect(usageTone({ usedPercent: 50 })).toBe('normal');
    expect(usageTone({ usedPercent: 80 })).toBe('warning');
    expect(usageTone({ usedPercent: 99 })).toBe('danger');
  });
});
