import type { AccountState, ProviderProfile } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { resetText, subscriptionUsage, usageBar } from './usage-model';

const providers = [
  { id: 'chatgpt', kind: 'chatgpt', models: [] },
  { id: 'claude', kind: 'claude', models: [] },
  { id: 'opencode', kind: 'opencode', models: [] },
  { id: 'deepseek', kind: 'deepseek', models: [] },
] as unknown as ProviderProfile[];

const chatgpt: AccountState = {
  kind: 'chatgpt',
  status: 'signed_in',
  plan: 'plus',
  rateLimits: {
    primary: { usedPercent: 12, windowMinutes: 300 },
    secondary: { usedPercent: 90, windowMinutes: 10080 },
  },
};

describe('subscriptionUsage', () => {
  it('同一来源的多个账号（0.63.0）：按 Provider ID 找账号，带上标签', () => {
    const added: AccountState = {
      ...chatgpt,
      id: 'chatgpt-3f9a',
      label: '副号',
      rateLimits: { primary: { usedPercent: 40 } },
    };
    const both = [
      ...providers,
      { id: 'chatgpt-3f9a', kind: 'chatgpt', models: [] },
    ] as unknown as ProviderProfile[];
    expect(subscriptionUsage({ providerId: 'chatgpt-3f9a' }, both, [chatgpt, added])).toMatchObject(
      { label: '副号', peak: { usedPercent: 40 } },
    );
    expect(subscriptionUsage({ providerId: 'chatgpt' }, both, [chatgpt, added])).toMatchObject({
      peak: { usedPercent: 90 },
    });
  });

  it('会话的 Provider 来自订阅：给出那个账号的窗口与用得最多的一个，ChatGPT 的套餐换成显示名', () => {
    expect(subscriptionUsage({ providerId: 'chatgpt' }, providers, [chatgpt])).toEqual({
      kind: 'chatgpt',
      plan: 'Plus',
      windows: [chatgpt.rateLimits?.primary, chatgpt.rateLimits?.secondary],
      peak: chatgpt.rateLimits?.secondary,
    });
  });

  it('套餐优先用 planLabel；只有一个窗口时它就是摘要', () => {
    const claude: AccountState = {
      kind: 'claude',
      status: 'signed_in',
      plan: 'max',
      planLabel: 'Max 20x',
      rateLimits: { primary: { usedPercent: 3 } },
    };
    expect(subscriptionUsage({ providerId: 'claude' }, providers, [chatgpt, claude])).toEqual({
      kind: 'claude',
      plan: 'Max 20x',
      windows: [{ usedPercent: 3 }],
      peak: { usedPercent: 3 },
    });
  });

  it('0.45.0 的 windows 有时显示全部窗口（OpenCode Go 的 5 小时、每周、每月）', () => {
    const windows = [
      { usedPercent: 10, windowMinutes: 300 },
      { usedPercent: 20, windowMinutes: 10080 },
      { usedPercent: 60, period: 'monthly' as const },
    ];
    const opencode: AccountState = {
      kind: 'opencode',
      status: 'signed_in',
      rateLimits: { primary: windows[0], secondary: windows[1], windows },
    };
    expect(subscriptionUsage({ providerId: 'opencode' }, providers, [opencode])).toEqual({
      kind: 'opencode',
      windows,
      peak: windows[2],
    });
  });

  it('API 类 Provider、找不到 Provider、账号未登录或没报用量时没有', () => {
    expect(subscriptionUsage({ providerId: 'deepseek' }, providers, [chatgpt])).toBeUndefined();
    expect(subscriptionUsage({ providerId: 'gone' }, providers, [chatgpt])).toBeUndefined();
    expect(subscriptionUsage({ providerId: 'chatgpt' }, providers, undefined)).toBeUndefined();
    expect(
      subscriptionUsage({ providerId: 'chatgpt' }, providers, [
        { ...chatgpt, status: 'signed_out' },
      ]),
    ).toBeUndefined();
    expect(
      subscriptionUsage({ providerId: 'chatgpt' }, providers, [
        { kind: 'chatgpt', status: 'signed_in' },
      ]),
    ).toBeUndefined();
  });
});

describe('usageBar', () => {
  it('取整并限在 0–100，颜色到 80% 提醒、95% 警告', () => {
    expect(usageBar({ usedPercent: 12.4 })).toEqual({ percent: 12, tone: 'normal' });
    expect(usageBar({ usedPercent: 90 })).toEqual({ percent: 90, tone: 'warning' });
    expect(usageBar({ usedPercent: 130 })).toEqual({ percent: 100, tone: 'danger' });
  });
});

describe('resetText', () => {
  const now = new Date('2026-10-14T08:00:00');
  it('一天之内说还有多久，不足一分钟按一分钟', () => {
    expect(resetText('2026-10-14T12:29:00', now)).toBe('4 小时 29 分钟后重置');
    expect(resetText('2026-10-14T10:00:00', now)).toBe('2 小时后重置');
    expect(resetText('2026-10-14T08:45:00', now)).toBe('45 分钟后重置');
    expect(resetText('2026-10-14T08:00:20', now)).toBe('1 分钟后重置');
  });

  it('更远的说日期与时刻；已过、读不出或没有时不说', () => {
    expect(resetText('2026-10-20T10:00:00', now)).toBe('10月20日 10:00 重置');
    expect(resetText('2026-10-14T07:00:00', now)).toBeUndefined();
    expect(resetText('soon', now)).toBeUndefined();
    expect(resetText(undefined, now)).toBeUndefined();
  });
});
