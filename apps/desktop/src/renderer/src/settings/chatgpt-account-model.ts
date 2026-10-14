// 设置页“ChatGPT 账号”（R6）的纯逻辑：账号状态 → 界面的阶段、套餐名、用量的说法。账号与凭据都在 Host 的 Codex
// 引擎里（host-api.md §3.1 account.*），这里只读状态。

import type { AccountRateLimitWindow, AccountState } from '@wevir/protocol';
import { t } from '@/i18n';

/** 界面的几个阶段：没读到、未登录、浏览器登录中、设备码登录中、已登录。 */
export type AccountPhase =
  | { kind: 'loading' }
  | { kind: 'signed_out'; error?: string }
  | { kind: 'browser'; loginId: string; authUrl?: string }
  | { kind: 'device_code'; loginId: string; verificationUrl?: string; userCode?: string }
  | { kind: 'signed_in'; email?: string; plan?: string };

export function accountPhase(state: AccountState | undefined): AccountPhase {
  if (state === undefined) return { kind: 'loading' };
  switch (state.status) {
    case 'signed_out':
      return state.lastError === undefined
        ? { kind: 'signed_out' }
        : { kind: 'signed_out', error: state.lastError };
    case 'signing_in': {
      const login = state.login;
      if (login === undefined) return { kind: 'loading' };
      return login.method === 'browser'
        ? {
            kind: 'browser',
            loginId: login.loginId,
            ...(login.authUrl !== undefined && { authUrl: login.authUrl }),
          }
        : {
            kind: 'device_code',
            loginId: login.loginId,
            ...(login.verificationUrl !== undefined && { verificationUrl: login.verificationUrl }),
            ...(login.userCode !== undefined && { userCode: login.userCode }),
          };
    }
    case 'signed_in':
      return {
        kind: 'signed_in',
        ...(state.email !== undefined && { email: state.email }),
        ...(state.plan !== undefined && { plan: state.plan }),
      };
  }
}

const PLAN_LABELS: Readonly<Record<string, string>> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  promax: 'Pro Max',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
};

/** Codex 的 PlanType 原值 → 显示名；认不出的原样（`unknown` 不显示）。 */
export function planLabel(plan: string | undefined): string | undefined {
  if (plan === undefined || plan === 'unknown') return undefined;
  return PLAN_LABELS[plan] ?? plan;
}

/** 用量窗口的名字：5 小时、每周，其余按长度说。 */
export function windowName(window: AccountRateLimitWindow): string {
  const minutes = window.windowMinutes;
  if (minutes === undefined) return t('account.chatgpt.usage.window');
  if (minutes === 10080) return t('account.chatgpt.usage.weekly');
  if (minutes % 1440 === 0) return t('account.chatgpt.usage.days', { count: minutes / 1440 });
  if (minutes % 60 === 0) return t('account.chatgpt.usage.hours', { count: minutes / 60 });
  return t('account.chatgpt.usage.minutes', { count: minutes });
}

/** 什么时候重置：今天的只说时刻，别的天带上日期。 */
export function resetLabel(resetsAt: string | undefined, now = new Date()): string | undefined {
  if (resetsAt === undefined) return undefined;
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return undefined;
  const time = at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === now.toDateString())
    return t('account.chatgpt.usage.resetsToday', { time });
  return t('account.chatgpt.usage.resetsOn', {
    month: at.getMonth() + 1,
    day: at.getDate(),
    time,
  });
}

/** 用量条的颜色：80% 起提醒，95% 起警告。 */
export function usageTone(window: AccountRateLimitWindow): 'normal' | 'warning' | 'danger' {
  if (window.usedPercent >= 95) return 'danger';
  if (window.usedPercent >= 80) return 'warning';
  return 'normal';
}
