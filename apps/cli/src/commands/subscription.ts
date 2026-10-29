import { accountId, type WevirClient } from '@wevir/client-sdk';
import {
  type AccountKind,
  AccountKindSchema,
  type AccountLoginMethod,
  type AccountState,
  type MethodParams,
} from '@wevir/protocol';
import { type Context, requireFeature, withClient } from '../context.js';
import { CliError, EXIT, UsageError } from '../errors.js';
import { table } from '../format.js';
import { joinList, t } from '../i18n/index.js';
import { Questioner } from '../prompt.js';
import { describeAccount, describeWindow } from './account.js';

// `wevir account`（0.19.0 订阅来源、0.63.0 多账号、0.56.0 上游）：ChatGPT 与各家订阅（Claude、Cursor、OpenCode、Grok、
// Antigravity、WorkBuddy、Devin、GitHub Copilot）的状态、安装、登录与登出。凭据都在引擎里，CLI 只看状态（host-api.md §3.1 account.*）。
// 应用内登录给出网址（浏览器回调落在 Host 那台电脑上）或设备码；要在终端里登录的给出命令，之后 `status --refresh` 重新检测。

/** 来源的产品名，原样显示。 */
export const ACCOUNT_NAMES: Record<AccountKind, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  grok: 'Grok',
  antigravity: 'Antigravity',
  workbuddy: 'WorkBuddy',
  devin: 'Devin',
  copilot: 'GitHub Copilot',
};

/** 账号的说法：`Claude`，添加的账号带标签或 ID：`Claude（工作）`。 */
export function accountName(account: Pick<AccountState, 'kind' | 'id' | 'label'>): string {
  const name = ACCOUNT_NAMES[account.kind] ?? account.kind;
  const id = accountId(account);
  const extra = account.label ?? (id === account.kind ? undefined : id);
  return extra === undefined ? name : `${name}${t('common.parenAfter', { text: extra })}`;
}

interface AccountRef {
  kind: AccountKind;
  /** 添加的账号（0.63.0）；首个账号省略。 */
  id?: string;
}

const refParams = (ref: AccountRef) => ({
  kind: ref.kind,
  ...(ref.id !== undefined && { id: ref.id }),
});

function requireAccountKind(client: WevirClient, kind: AccountKind): void {
  if (kind === 'chatgpt') {
    if (!client.supports('chatgpt_account')) {
      throw new CliError(t('account.unsupported'), t('account.unsupported.hint'));
    }
  } else requireFeature(client, 'subscription_sources');
}

/** `<种类>` 或账号 ID（`claude-1a2b`，`wevir account list` 的第一列）。 */
async function resolveAccount(client: WevirClient, value: string): Promise<AccountRef> {
  const kind = AccountKindSchema.safeParse(value.trim().toLowerCase());
  if (kind.success) {
    requireAccountKind(client, kind.data);
    return { kind: kind.data };
  }
  requireFeature(client, 'subscription_sources');
  const { accounts } = await client.request('account.list');
  const found = accounts.find((account) => accountId(account) === value);
  if (found === undefined) {
    throw new UsageError(
      t('subscription.unknown', { value }),
      t('subscription.unknown.hint', { kinds: joinList(Object.keys(ACCOUNT_NAMES)) }),
    );
  }
  return accountId(found) === found.kind
    ? { kind: found.kind }
    : { kind: found.kind, id: accountId(found) };
}

function withAccount<T>(
  ctx: Context,
  value: string,
  fn: (client: WevirClient, ref: AccountRef) => Promise<T>,
): Promise<T> {
  return withClient(ctx, async (client) => fn(client, await resolveAccount(client, value)));
}

function statusLabel(account: AccountState): string {
  if (account.installing !== undefined) return t('subscription.installing');
  if (account.installed === false) return t('subscription.notInstalled');
  switch (account.status) {
    case 'signed_in':
      return t('subscription.signedIn');
    case 'signing_in':
      return t('subscription.signingIn');
    case 'signed_out':
      return t('subscription.signedOut');
  }
}

const planText = (account: AccountState): string | undefined => account.planLabel ?? account.plan;

/** `wevir account list [--json]`：Host 的引擎支持的全部账号。 */
export async function accountList(ctx: Context, options: { json?: boolean }): Promise<number> {
  return withClient(ctx, async (client) => {
    requireFeature(client, 'subscription_sources');
    const { accounts } = await client.request('account.list');
    if (options.json) {
      ctx.print(JSON.stringify(accounts, null, 2));
      return EXIT.ok;
    }
    if (accounts.length === 0) {
      ctx.print(t('subscription.none'));
      return EXIT.ok;
    }
    ctx.print(
      table(
        [
          'ID',
          t('subscription.col.source'),
          t('subscription.col.status'),
          t('subscription.col.account'),
          t('subscription.col.version'),
        ],
        accounts.map((account) => [
          accountId(account),
          accountName(account),
          statusLabel(account),
          account.status === 'signed_in'
            ? [account.email, planText(account)].filter(Boolean).join(' · ') || '-'
            : '-',
          account.version ?? '-',
        ]),
      ),
    );
    return EXIT.ok;
  });
}

/** `wevir account status <种类|ID> [--refresh] [--json]`：状态、用量、怎样登录或安装。 */
export async function accountShow(
  ctx: Context,
  value: string,
  options: { json?: boolean; refresh?: boolean },
): Promise<number> {
  return withAccount(ctx, value, async (client, ref) => {
    const { account } = await client.request(
      'account.get',
      { ...refParams(ref), ...(options.refresh && { refresh: true }) },
      { timeoutMs: 30_000 },
    );
    if (options.json) {
      ctx.print(JSON.stringify(account, null, 2));
      return EXIT.ok;
    }
    printAccount(ctx, account);
    return EXIT.ok;
  });
}

function printAccount(ctx: Context, account: AccountState): void {
  const name = accountName(account);
  const s = ctx.styles;
  if (account.status === 'signed_in') {
    const plan = planText(account);
    const who = `${account.email ?? t('account.unknownEmail')}${
      plan === undefined ? '' : t('common.parenAfter', { text: plan })
    }`;
    ctx.print(t('subscription.statusLine', { name, status: `${statusLabel(account)} ${who}` }));
  } else {
    ctx.print(t('subscription.statusLine', { name, status: statusLabel(account) }));
  }
  const windows = account.rateLimits?.windows ?? [
    ...(account.rateLimits?.primary === undefined ? [] : [account.rateLimits.primary]),
    ...(account.rateLimits?.secondary === undefined ? [] : [account.rateLimits.secondary]),
  ];
  for (const window of windows) ctx.print(`  ${describeWindow(window)}`);
  if (account.executablePath !== undefined) {
    ctx.print(s.dim(`  ${t('subscription.executable', { path: account.executablePath })}`));
  }
  if (account.installing !== undefined) {
    ctx.print(s.dim(`  ${installProgress(account.installing)}`));
  } else if (account.installed === false) {
    if (account.canInstall)
      ctx.print(s.dim(`  ${t('subscription.installWith', { kind: account.kind })}`));
    if (account.installCommand !== undefined) {
      ctx.print(
        s.dim(`  ${t('subscription.installCommand', { command: account.installCommand })}`),
      );
    }
    if (account.installUrl !== undefined) {
      ctx.print(s.dim(`  ${t('subscription.installUrl', { url: account.installUrl })}`));
    }
  } else if (account.status === 'signed_out') {
    if (account.signIn === 'command' && account.loginCommand !== undefined) {
      ctx.print(s.dim(`  ${t('subscription.loginCommand', { command: account.loginCommand })}`));
    } else if (account.signIn === 'in_app') {
      ctx.print(s.dim(`  ${t('subscription.loginWith', { id: accountId(account) })}`));
    }
  }
  if (account.lastError !== undefined && account.status !== 'signed_in') {
    ctx.print(s.dim(`  ${t('account.status.lastError', { error: account.lastError })}`));
  }
}

function installProgress(installing: NonNullable<AccountState['installing']>): string {
  const { completedBytes, totalBytes } = installing;
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  return totalBytes === undefined || totalBytes === 0
    ? t('subscription.progressBytes', { done: mb(completedBytes) })
    : t('subscription.progress', {
        percent: Math.floor((completedBytes / totalBytes) * 100),
        done: mb(completedBytes),
        total: mb(totalBytes),
      });
}

export interface AccountLoginFlags {
  browser?: boolean;
  deviceCode?: boolean;
  /** 登录方式（`loginOptions`，如 WorkBuddy 的国内 / 国际站），或上游的接入方式。 */
  option?: string;
  /** 接哪家上游（OpenCode，0.56.0）。 */
  upstream?: string;
}

/**
 * `wevir account login <种类|ID> [--browser|--device-code] [--option <ID>] [--upstream <ID>]`：应用内登录打印网址或设备码并
 * 等到完成（Ctrl-C 取消）；要在终端里登录的打印命令。上游的 API Key 从 stdin 读一行，终端上不回显。
 */
export async function accountLogin(
  ctx: Context,
  value: string,
  flags: AccountLoginFlags,
): Promise<number> {
  if (flags.browser && flags.deviceCode) throw new UsageError(t('subscription.methodConflict'));
  return withAccount(ctx, value, async (client, ref) => {
    const { account: current } = await client.request('account.get', refParams(ref));
    const name = accountName(current);
    const id = accountId(current);
    if (current.installed === false) {
      throw new CliError(
        t('subscription.needsInstall', { name }),
        current.canInstall
          ? t('subscription.installWith', { kind: current.kind })
          : (current.installCommand ?? current.installUrl ?? t('subscription.installElsewhere')),
      );
    }
    if (flags.upstream !== undefined) return loginUpstream(ctx, client, ref, current, flags);
    if (current.status === 'signed_in') {
      ctx.print(t('subscription.alreadySignedIn', { name, account: describeAccount(current) }));
      ctx.print(ctx.styles.dim(t('subscription.alreadySignedIn.hint', { id })));
      return EXIT.ok;
    }
    if (current.signIn === 'command') {
      ctx.print(t('subscription.runInTerminal', { name }));
      ctx.print(`  ${ctx.styles.bold(current.loginCommand ?? '-')}`);
      ctx.print(ctx.styles.dim(t('subscription.thenRefresh', { id })));
      return EXIT.ok;
    }
    const methods = current.loginMethods ?? ['device_code'];
    const method: AccountLoginMethod = flags.browser
      ? 'browser'
      : flags.deviceCode
        ? 'device_code'
        : methods.includes('device_code')
          ? 'device_code'
          : 'browser';
    if (!methods.includes(method)) {
      throw new UsageError(
        t('subscription.methodUnsupported', { name, method }),
        t('subscription.methodUnsupported.hint', { methods: joinList(methods) }),
      );
    }
    if (flags.option !== undefined && current.loginOptions !== undefined) {
      if (!current.loginOptions.some((option) => option.id === flags.option)) {
        throw new UsageError(
          t('subscription.badOption', { option: flags.option }),
          t('subscription.badOption.hint', {
            options: joinList(
              current.loginOptions.map(
                (o) => `${o.id}${t('common.parenAfter', { text: o.label })}`,
              ),
            ),
          }),
        );
      }
    }
    return waitForLogin(ctx, client, ref, name, {
      ...refParams(ref),
      method,
      ...(flags.option !== undefined && { option: flags.option }),
    });
  });
}

async function loginUpstream(
  ctx: Context,
  client: WevirClient,
  ref: AccountRef,
  current: AccountState,
  flags: AccountLoginFlags,
): Promise<number> {
  requireFeature(client, 'subscription_upstreams');
  const { upstreams } = await client.request('account.upstreams', refParams(ref), {
    timeoutMs: 30_000,
  });
  const upstream = upstreams.find((item) => item.id === flags.upstream);
  if (upstream === undefined) {
    throw new UsageError(
      t('subscription.noUpstream', { upstream: flags.upstream as string }),
      t('subscription.noUpstream.hint', { id: accountId(current) }),
    );
  }
  const method =
    flags.option === undefined
      ? upstream.methods[0]
      : upstream.methods.find((item) => item.option === flags.option);
  if (method === undefined) {
    throw new UsageError(
      t('subscription.badOption', { option: flags.option as string }),
      t('subscription.badOption.hint', {
        options: joinList(
          upstream.methods.map((m) => `${m.option}${t('common.parenAfter', { text: m.label })}`),
        ),
      }),
    );
  }
  const params = {
    ...refParams(ref),
    method: 'browser' as const,
    upstream: upstream.id,
    option: method.option,
  };
  if (method.type === 'oauth') {
    return waitForLogin(ctx, client, ref, `${accountName(current)} · ${upstream.name}`, params);
  }
  const q = new Questioner(ctx.io);
  let apiKey: string | undefined;
  try {
    apiKey = q.interactive
      ? await q.askSecret(t('subscription.askKey', { name: upstream.name }))
      : (await q.readLine())?.trim();
  } finally {
    q.close();
  }
  if (!apiKey) throw new UsageError(t('subscription.keyMissing'));
  await client.request('account.login', { ...params, apiKey }, { timeoutMs: 60_000 });
  ctx.print(ctx.styles.green(t('subscription.upstreamConnected', { name: upstream.name })));
  return EXIT.ok;
}

/** 发起登录，打印网址或设备码，等到登录完成、失败或 Ctrl-C。 */
async function waitForLogin(
  ctx: Context,
  client: WevirClient,
  ref: AccountRef,
  name: string,
  params: MethodParams<'account.login'>,
): Promise<number> {
  const wanted = ref.id ?? ref.kind;
  const updates: AccountState[] = [];
  let wake: (() => void) | undefined;
  const push = (account: AccountState) => {
    updates.push(account);
    wake?.();
  };
  const stop =
    ref.id === undefined
      ? client.watchAccount(ref.kind, push)
      : client.watchAccounts((accounts) => {
          const found = accounts.find((account) => accountId(account) === wanted);
          if (found) push(found);
        });
  let interrupted = false;
  const offInterrupt = ctx.io.onInterrupt(() => {
    interrupted = true;
    wake?.();
  });
  try {
    const { account } = await client.request('account.login', params, { timeoutMs: 60_000 });
    const login = account.login;
    if (login === undefined) {
      // 立即完成（已接上的上游等）。
      if (account.status === 'signed_in') {
        ctx.print(
          ctx.styles.green(
            t('subscription.signedInAs', { name, account: describeAccount(account) }),
          ),
        );
        return EXIT.ok;
      }
      throw new CliError(t('account.noDeviceCode'), t('account.noDeviceCode.hint'));
    }
    ctx.print('');
    if (login.verificationUrl !== undefined && login.userCode !== undefined) {
      ctx.print(t('subscription.deviceStep1', { url: ctx.styles.bold(login.verificationUrl) }));
      ctx.print(t('account.step2', { code: ctx.styles.bold(login.userCode) }));
      ctx.print(ctx.styles.dim(`   ${t('account.codeWarning')}`));
    } else if (login.authUrl !== undefined) {
      ctx.print(t('subscription.openUrl', { url: ctx.styles.bold(login.authUrl) }));
      ctx.print(ctx.styles.dim(`   ${t('subscription.callbackNote')}`));
    } else {
      // 引擎的 CLI 自己在 Host 的电脑上打开了浏览器（Devin；Windows 上的 Claude 用不了钩子时），没有地址可给。
      ctx.print(t('subscription.browserOnHost'));
    }
    ctx.print('');
    ctx.print(ctx.styles.dim(t('account.waiting')));
    let started = false;
    for (;;) {
      if (interrupted) {
        await client.request('account.cancelLogin', { ...refParams(ref), loginId: login.loginId });
        ctx.print(ctx.styles.yellow(t('account.loginCancelled')));
        return EXIT.interrupted;
      }
      for (const update of updates.splice(0)) {
        if (update.status === 'signing_in') {
          if (update.login?.loginId === login.loginId) started = true;
          else if (started) throw new CliError(t('account.replaced'));
        } else if (update.status === 'signed_in' && (started || params.upstream !== undefined)) {
          ctx.print(
            ctx.styles.green(
              t('subscription.signedInAs', { name, account: describeAccount(update) }),
            ),
          );
          return EXIT.ok;
        } else if (update.status === 'signed_out' && started) {
          throw new CliError(
            t('account.loginFailed', { error: update.lastError ?? t('account.cancelled') }),
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
}

/** `wevir account logout <种类|ID> [--upstream <ID>]`。 */
export async function accountLogout(
  ctx: Context,
  value: string,
  options: { upstream?: string },
): Promise<number> {
  return withAccount(ctx, value, async (client, ref) => {
    const { account } = await client.request(
      'account.logout',
      { ...refParams(ref), ...(options.upstream !== undefined && { upstream: options.upstream }) },
      { timeoutMs: 30_000 },
    );
    ctx.print(
      options.upstream === undefined
        ? t('subscription.loggedOut', { name: accountName(account) })
        : t('subscription.upstreamDisconnected', { upstream: options.upstream }),
    );
    if (account.localLogin && options.upstream === undefined) {
      ctx.print(ctx.styles.dim(t('subscription.localLogout')));
    }
    return EXIT.ok;
  });
}

/** `wevir account upstreams <种类|ID> [--json]`：OpenCode 后面能接的上游。 */
export async function accountUpstreams(
  ctx: Context,
  value: string,
  options: { json?: boolean },
): Promise<number> {
  return withAccount(ctx, value, async (client, ref) => {
    requireFeature(client, 'subscription_upstreams');
    const { upstreams } = await client.request('account.upstreams', refParams(ref), {
      timeoutMs: 30_000,
    });
    if (options.json) {
      ctx.print(JSON.stringify(upstreams, null, 2));
      return EXIT.ok;
    }
    ctx.print(
      table(
        [
          'ID',
          t('subscription.col.name'),
          t('subscription.col.status'),
          t('subscription.col.methods'),
        ],
        upstreams.map((upstream) => [
          upstream.id,
          upstream.name,
          upstream.connected ? t('subscription.connected') : '-',
          upstream.methods
            .map((m) => `${m.option}${t('common.parenAfter', { text: m.label })}`)
            .join(t('list.separator')),
        ]),
      ),
    );
    return EXIT.ok;
  });
}

/** `wevir account install <种类>`：Wevir 替用户下载安装（`canInstall`），显示进度直到完成。 */
export async function accountInstall(ctx: Context, value: string): Promise<number> {
  return withAccount(ctx, value, async (client, ref) => {
    const done = new Promise<AccountState>((resolve) => {
      let seen = false;
      const stop = client.watchAccount(ref.kind, (account) => {
        if (account.installing !== undefined) {
          seen = true;
          ctx.print(ctx.styles.dim(installProgress(account.installing)));
        } else if (seen || account.installed !== false) {
          stop();
          resolve(account);
        }
      });
    });
    const { account: started } = await client.request('account.install', { kind: ref.kind });
    const account = started.installing === undefined ? started : await done;
    if (account.installed === false) {
      throw new CliError(
        t('subscription.installFailed', { error: account.lastError ?? t('account.cancelled') }),
      );
    }
    ctx.print(
      ctx.styles.green(
        t('subscription.installed', {
          name: accountName(account),
          version: account.version ?? '-',
        }),
      ),
    );
    return EXIT.ok;
  });
}

/** `wevir account add <种类> [--label <标签>]`：添加一个账号（与已有的互不相通），之后用它的 ID 登录。 */
export async function accountAdd(
  ctx: Context,
  value: string,
  options: { label?: string; json?: boolean },
): Promise<number> {
  return withAccount(ctx, value, async (client, ref) => {
    requireFeature(client, 'subscription_accounts');
    const { account } = await client.request('account.add', {
      kind: ref.kind,
      ...(options.label !== undefined && { label: options.label }),
    });
    if (options.json) {
      ctx.print(JSON.stringify(account, null, 2));
      return EXIT.ok;
    }
    ctx.print(t('subscription.added', { name: accountName(account), id: accountId(account) }));
    return EXIT.ok;
  });
}

/** `wevir account remove <ID>`：删掉添加的账号（登出、关掉用它的会话、删它的 Provider 与数据）。 */
export async function accountRemove(ctx: Context, value: string): Promise<number> {
  return withAccount(ctx, value, async (client, ref) => {
    if (ref.id === undefined) throw new UsageError(t('subscription.firstAccount'));
    requireFeature(client, 'subscription_accounts');
    await client.request('account.remove', { id: ref.id });
    ctx.print(t('subscription.removed', { id: ref.id }));
    return EXIT.ok;
  });
}

/** `wevir account label <种类|ID> [<标签>] [--clear]`。 */
export async function accountLabel(
  ctx: Context,
  value: string,
  label: string | undefined,
  options: { clear?: boolean },
): Promise<number> {
  if ((label === undefined) === !options.clear) {
    throw new UsageError(t('subscription.labelUsage'));
  }
  return withAccount(ctx, value, async (client, ref) => {
    requireFeature(client, 'subscription_accounts');
    const { account } = await client.request('account.setLabel', {
      id: ref.id ?? ref.kind,
      label: label ?? null,
    });
    ctx.print(t('subscription.labelled', { name: accountName(account) }));
    return EXIT.ok;
  });
}

/** `wevir account path <种类> [<可执行文件>] [--clear]`：用这个可执行文件运行这种订阅的引擎。 */
export async function accountPath(
  ctx: Context,
  value: string,
  path: string | undefined,
  options: { clear?: boolean },
): Promise<number> {
  if ((path === undefined) === !options.clear) throw new UsageError(t('subscription.pathUsage'));
  return withAccount(ctx, value, async (client, ref) => {
    const { account } = await client.request('account.setPath', {
      kind: ref.kind,
      path: path ?? null,
    });
    printAccount(ctx, account);
    return EXIT.ok;
  });
}
