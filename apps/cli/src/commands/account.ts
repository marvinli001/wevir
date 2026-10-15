import type { WevirClient } from '@wevir/client-sdk';
import type { AccountKind, AccountRateLimitWindow, AccountState } from '@wevir/protocol';
import { type Context, withClient } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { intlLocale, t } from '../i18n/index.js';

// `wevir provider login / status / logout`（R6）：ChatGPT 账号，登录只用设备码（浏览器回调要在 Host 这台机器上，
// 终端里不一定有浏览器）。账号与凭据都在 Host 的 Codex 引擎里，CLI 只看状态（host-api.md §3.1 account.*）。

/** 账号的种类；现在只有 chatgpt，参数可以省略。 */
export function parseAccountKind(value: string | undefined): AccountKind {
  if (value === undefined || value === 'chatgpt') return 'chatgpt';
  throw new UsageError(t('account.unknownKind', { kind: value }), t('account.unknownKind.hint'));
}

/** 条款的提醒（ADR-0005 决策 4，codex-notes §4.1）：OpenAI 只允许本地或开源应用用 app-server 的登录。 */
export const chatgptTermsNote = (): string => t('account.terms');

export async function accountLogin(ctx: Context, kind: AccountKind): Promise<number> {
  return withClient(ctx, async (client) => {
    requireAccounts(client);
    const { account: current } = await client.request('account.get', { kind });
    if (current.status === 'signed_in') {
      ctx.print(t('account.alreadySignedIn', { account: describeAccount(current) }));
      ctx.print(ctx.styles.dim(t('account.alreadySignedIn.hint')));
      return EXIT.ok;
    }
    ctx.print(ctx.styles.dim(chatgptTermsNote()));
    const updates: AccountState[] = [];
    let wake: (() => void) | undefined;
    const stop = client.watchAccount(kind, (account) => {
      updates.push(account);
      wake?.();
    });
    let interrupted = false;
    const offInterrupt = ctx.io.onInterrupt(() => {
      interrupted = true;
      wake?.();
    });
    try {
      const { account } = await client.request(
        'account.login',
        { kind, method: 'device_code' },
        { timeoutMs: 60_000 },
      );
      const login = account.login;
      if (login?.verificationUrl === undefined || login.userCode === undefined) {
        throw new CliError(t('account.noDeviceCode'), t('account.noDeviceCode.hint'));
      }
      ctx.print('');
      ctx.print(t('account.step1', { url: ctx.styles.bold(login.verificationUrl) }));
      ctx.print(t('account.step2', { code: ctx.styles.bold(login.userCode) }));
      ctx.print(ctx.styles.dim(`   ${t('account.codeWarning')}`));
      ctx.print('');
      ctx.print(ctx.styles.dim(t('account.waiting')));
      // 只看这次登录开始之后的状态：watchAccount 先读的那一次（未登录）不算失败。
      let started = false;
      for (;;) {
        if (interrupted) {
          await client.request('account.cancelLogin', { kind, loginId: login.loginId });
          ctx.print(ctx.styles.yellow(t('account.loginCancelled')));
          return EXIT.interrupted;
        }
        for (const update of updates.splice(0)) {
          if (update.status === 'signing_in') {
            if (update.login?.loginId === login.loginId) started = true;
            else if (started) {
              throw new CliError(t('account.replaced'), t('account.retry.hint'));
            }
          } else if (update.status === 'signed_in' && update.email !== undefined) {
            ctx.print(
              ctx.styles.green(t('account.signedIn', { account: describeAccount(update) })),
            );
            ctx.print(ctx.styles.dim(t('error.hint', { hint: t('account.signedIn.hint') })));
            return EXIT.ok;
          } else if (update.status === 'signed_out' && started) {
            throw new CliError(
              t('account.loginFailed', { error: update.lastError ?? t('account.cancelled') }),
              t('account.retry.hint'),
            );
          }
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    } finally {
      offInterrupt();
      stop();
    }
  });
}

export async function accountStatus(ctx: Context, kind: AccountKind): Promise<number> {
  return withClient(ctx, async (client) => {
    requireAccounts(client);
    const { account } = await client.request('account.get', { kind });
    switch (account.status) {
      case 'signed_in': {
        ctx.print(t('account.status.signedIn', { account: describeAccount(account) }));
        const { primary, secondary } = account.rateLimits ?? {};
        if (primary !== undefined) ctx.print(`  ${describeWindow(primary)}`);
        if (secondary !== undefined) ctx.print(`  ${describeWindow(secondary)}`);
        return EXIT.ok;
      }
      case 'signing_in':
        ctx.print(t('account.status.signingIn'));
        return EXIT.ok;
      case 'signed_out':
        ctx.print(t('account.status.signedOut'));
        if (account.lastError !== undefined) {
          ctx.print(
            ctx.styles.dim(`  ${t('account.status.lastError', { error: account.lastError })}`),
          );
        }
        ctx.print(ctx.styles.dim(t('error.hint', { hint: t('account.status.signedOut.hint') })));
        return EXIT.ok;
    }
  });
}

export async function accountLogout(ctx: Context, kind: AccountKind): Promise<number> {
  return withClient(ctx, async (client) => {
    requireAccounts(client);
    await client.request('account.logout', { kind }, { timeoutMs: 30_000 });
    ctx.print(t('account.loggedOut'));
    return EXIT.ok;
  });
}

function requireAccounts(client: WevirClient): void {
  if (!client.supports('chatgpt_account')) {
    throw new CliError(t('account.unsupported'), t('account.unsupported.hint'));
  }
}

/** `me@example.com（Plus）`。 */
export function describeAccount(account: AccountState): string {
  const plan =
    account.plan === undefined ? '' : t('common.parenAfter', { text: planLabel(account.plan) });
  return `${account.email ?? t('account.unknownEmail')}${plan}`;
}

/** Codex 的 PlanType 原值 → 显示名；认不出的原样。 */
export function planLabel(plan: string): string {
  const labels: Record<string, string> = {
    free: 'Free',
    go: 'Go',
    plus: 'Plus',
    pro: 'Pro',
    prolite: 'Pro Lite',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    edu: 'Edu',
  };
  return labels[plan] ?? plan;
}

/** `5 小时窗口已用 23%，14:20 重置`。 */
export function describeWindow(window: AccountRateLimitWindow, now = new Date()): string {
  const minutes = window.windowMinutes;
  const span =
    minutes === undefined
      ? t('account.window.usage')
      : minutes % 1440 === 0
        ? minutes === 10080
          ? t('account.window.weekly')
          : t('account.window.days', { count: minutes / 1440 })
        : minutes % 60 === 0
          ? t('account.window.hours', { count: minutes / 60 })
          : t('account.window.minutes', { count: minutes });
  const usage = t('account.window.used', { span, percent: Math.round(window.usedPercent) });
  if (window.resetsAt === undefined) return usage;
  const resets = new Date(window.resetsAt);
  const sameDay = resets.toDateString() === now.toDateString();
  const time = resets.toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' });
  const when = sameDay
    ? time
    : t('account.window.date', { month: resets.getMonth() + 1, day: resets.getDate(), time });
  return t('account.window.resets', { usage, time: when });
}
