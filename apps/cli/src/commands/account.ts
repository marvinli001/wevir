import type { WevirClient } from '@wevir/client-sdk';
import type { AccountKind, AccountRateLimitWindow, AccountState } from '@wevir/protocol';
import { type Context, withClient } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';

// `wevir provider login / status / logout`（R6）：ChatGPT 账号，登录只用设备码（浏览器回调要在 Host 这台机器上，
// 终端里不一定有浏览器）。账号与凭据都在 Host 的 Codex 引擎里，CLI 只看状态（host-api.md §3.1 account.*）。

/** 账号的种类；现在只有 chatgpt，参数可以省略。 */
export function parseAccountKind(value: string | undefined): AccountKind {
  if (value === undefined || value === 'chatgpt') return 'chatgpt';
  throw new UsageError(`不认识的账号：${value}`, '现在只有 chatgpt');
}

/** 条款的提醒（ADR-0005 决策 4，codex-notes §4.1）：OpenAI 只允许本地或开源应用用 app-server 的登录。 */
export const CHATGPT_TERMS_NOTE =
  '仅供个人在本机使用 Wevir 时登录：登录走 OpenAI 自己的 Codex 登录流程，凭据只存在本机，Wevir 不读取、不转交。';

export async function accountLogin(ctx: Context, kind: AccountKind): Promise<number> {
  return withClient(ctx, async (client) => {
    requireAccounts(client);
    const { account: current } = await client.request('account.get', { kind });
    if (current.status === 'signed_in') {
      ctx.print(`已经登录 ChatGPT：${describeAccount(current)}`);
      ctx.print(ctx.styles.dim('要换账号，先运行 wevir provider logout'));
      return EXIT.ok;
    }
    ctx.print(ctx.styles.dim(CHATGPT_TERMS_NOTE));
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
        throw new CliError('Host 没有给出设备码', '稍后重试，或在桌面端的设置里登录');
      }
      ctx.print('');
      ctx.print(`1. 在浏览器里打开 ${ctx.styles.bold(login.verificationUrl)} 并登录 ChatGPT`);
      ctx.print(`2. 输入一次性码 ${ctx.styles.bold(login.userCode)}（15 分钟内有效）`);
      ctx.print(ctx.styles.dim('   这个码是你刚在 Wevir 里发起的登录；不是自己发起的，不要输入。'));
      ctx.print('');
      ctx.print(ctx.styles.dim('等待完成…（Ctrl-C 取消）'));
      // 只看这次登录开始之后的状态：watchAccount 先读的那一次（未登录）不算失败。
      let started = false;
      for (;;) {
        if (interrupted) {
          await client.request('account.cancelLogin', { kind, loginId: login.loginId });
          ctx.print(ctx.styles.yellow('已取消登录。'));
          return EXIT.interrupted;
        }
        for (const update of updates.splice(0)) {
          if (update.status === 'signing_in') {
            if (update.login?.loginId === login.loginId) started = true;
            else if (started) {
              throw new CliError('登录被另一处发起的登录替换了', '重新运行 wevir provider login');
            }
          } else if (update.status === 'signed_in' && update.email !== undefined) {
            ctx.print(ctx.styles.green(`✓ 已登录 ChatGPT：${describeAccount(update)}`));
            ctx.print(
              ctx.styles.dim('下一步：wevir session new -w <路径> --provider chatgpt "<提示>"'),
            );
            return EXIT.ok;
          } else if (update.status === 'signed_out' && started) {
            throw new CliError(
              `登录没有成功：${update.lastError ?? '已取消'}`,
              '重新运行 wevir provider login',
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
        ctx.print(`ChatGPT：已登录 ${describeAccount(account)}`);
        const { primary, secondary } = account.rateLimits ?? {};
        if (primary !== undefined) ctx.print(`  ${describeWindow(primary)}`);
        if (secondary !== undefined) ctx.print(`  ${describeWindow(secondary)}`);
        return EXIT.ok;
      }
      case 'signing_in':
        ctx.print('ChatGPT：登录中（在桌面端或另一个终端发起）');
        return EXIT.ok;
      case 'signed_out':
        ctx.print('ChatGPT：没有登录');
        if (account.lastError !== undefined) {
          ctx.print(ctx.styles.dim(`  上次登录失败：${account.lastError}`));
        }
        ctx.print(ctx.styles.dim('下一步：wevir provider login'));
        return EXIT.ok;
    }
  });
}

export async function accountLogout(ctx: Context, kind: AccountKind): Promise<number> {
  return withClient(ctx, async (client) => {
    requireAccounts(client);
    await client.request('account.logout', { kind }, { timeoutMs: 30_000 });
    ctx.print('已登出 ChatGPT（本机的凭据已删除）。用 ChatGPT 的会话要重新登录后才能继续。');
    return EXIT.ok;
  });
}

function requireAccounts(client: WevirClient): void {
  if (!client.supports('chatgpt_account')) {
    throw new CliError(
      '这个 Host 没有 ChatGPT 账号（只有 Codex 引擎有）',
      '用默认的 Codex 引擎重新启动 Host：wevir host stop && wevir host start',
    );
  }
}

/** `me@example.com（Plus）`。 */
export function describeAccount(account: AccountState): string {
  const plan = account.plan === undefined ? '' : `（${planLabel(account.plan)}）`;
  return `${account.email ?? '（邮箱未知）'}${plan}`;
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
      ? '用量'
      : minutes % 1440 === 0
        ? minutes === 10080
          ? '每周'
          : `${minutes / 1440} 天窗口`
        : minutes % 60 === 0
          ? `${minutes / 60} 小时窗口`
          : `${minutes} 分钟窗口`;
  const used = `已用 ${Math.round(window.usedPercent)}%`;
  if (window.resetsAt === undefined) return `${span}${used}`;
  const resets = new Date(window.resetsAt);
  const sameDay = resets.toDateString() === now.toDateString();
  const time = resets.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const day = sameDay ? '' : `${resets.getMonth() + 1} 月 ${resets.getDate()} 日 `;
  return `${span}${used}，${day}${time} 重置`;
}
