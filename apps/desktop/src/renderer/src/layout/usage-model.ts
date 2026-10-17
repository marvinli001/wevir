// 会话侧栏“用量”卡片（desktop-layout.md §12）的纯逻辑：会话的模型来自哪个订阅、那个账号的用量窗口，与重置时间的说法。
// 用量是账号级的（AccountState.rateLimits，0.19.0），Codex 与 Claude Agent 在回合里推送更新，侧栏只读。

import type {
  AccountKind,
  AccountRateLimitWindow,
  AccountState,
  ProviderProfile,
  Session,
} from '@wevir/protocol';
import { sourceOf } from '@/data/sources';
import { t } from '@/i18n';
import { planLabel, resetLabel, usageTone } from '@/settings/chatgpt-account-model';

export interface SubscriptionUsage {
  kind: AccountKind;
  /** 套餐给人看的说法，引擎没给时是原值。 */
  plan?: string;
  /** 主窗口在前（5 小时），次窗口在后（每周）。 */
  windows: AccountRateLimitWindow[];
  /** 用得最多的那个窗口：收起时的摘要显示它。 */
  peak: AccountRateLimitWindow;
}

/**
 * 会话的 Provider 来自订阅、账号已登录且报了用量时给出用量；API 类 Provider、账号未登录或引擎不报用量时没有。
 */
export function subscriptionUsage(
  session: Pick<Session, 'providerId'>,
  providers: readonly ProviderProfile[],
  accounts: readonly AccountState[] | undefined,
): SubscriptionUsage | undefined {
  const provider = providers.find((candidate) => candidate.id === session.providerId);
  const source = provider && sourceOf(provider);
  if (!source) return undefined;
  const account = accounts?.find((candidate) => candidate.kind === source.kind);
  if (account?.status !== 'signed_in') return undefined;
  const { primary, secondary } = account.rateLimits ?? {};
  const windows = [primary, secondary].filter(
    (window): window is AccountRateLimitWindow => window !== undefined,
  );
  const [first] = windows;
  if (first === undefined) return undefined;
  const peak = windows.reduce(
    (max, window) => (window.usedPercent > max.usedPercent ? window : max),
    first,
  );
  // ChatGPT 的套餐是 Codex 的 PlanType 原值，照设置页换成显示名。
  const plan =
    account.planLabel ?? (source.kind === 'chatgpt' ? planLabel(account.plan) : account.plan);
  return {
    kind: source.kind,
    ...(plan !== undefined && { plan }),
    windows,
    peak,
  };
}

/** 用量条的长度与颜色（`ContextBar` 用）：0–100 取整，颜色同设置页（80% 提醒、95% 警告）。 */
export function usageBar(window: AccountRateLimitWindow): {
  percent: number;
  tone: 'normal' | 'warning' | 'danger';
} {
  return {
    percent: Math.round(Math.min(100, Math.max(0, window.usedPercent))),
    tone: usageTone(window),
  };
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** 什么时候重置：一天之内说还有多久（“4 小时 29 分钟后重置”），再远说日期与时刻；已过或没有时不说。 */
export function resetText(resetsAt: string | undefined, now = new Date()): string | undefined {
  if (resetsAt === undefined) return undefined;
  const left = new Date(resetsAt).getTime() - now.getTime();
  if (Number.isNaN(left) || left <= 0) return undefined;
  if (left >= DAY) return resetLabel(resetsAt, now);
  const total = Math.max(1, Math.ceil(left / MINUTE));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const duration =
    hours === 0
      ? t('rail.usage.minutes', { minutes })
      : minutes === 0
        ? t('rail.usage.hours', { hours })
        : t('rail.usage.hoursMinutes', { hours, minutes });
  return t('rail.usage.resetsIn', { duration });
}
