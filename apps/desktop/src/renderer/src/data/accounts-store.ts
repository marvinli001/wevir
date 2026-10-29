// 全部账号（0.19.0，client-sdk 的 watchAccounts）：ChatGPT 与订阅来源的状态，设置页与模型选择共用一份。连上与重连时读全部，
// 之后跟着 account.updated；删掉的账号（account.remove）由 client-sdk 在删成功时去掉。某个账号刚变成已登录时 Host 会在后台建
// （或刷新）它的 Provider，所以这时重读工作台的列表。窗口回到前台时再读一次全部（至多每 15 秒一次，client-sdk 的
// refreshAccounts）：Host 已不再有的账号（例如在别的设备上删掉的）随之消失；Host 顺带在后台重读过期的用量，结果跟着
// account.updated 到（usage-refresh.ts）。

import { accountId, type WevirClient } from '@wevir/client-sdk';
import type { AccountState } from '@wevir/protocol';
import type { WorkbenchStore } from './workbench-store';

/** 回到前台时至多多久读一次。 */
const FOCUS_READ_MIN_MS = 15_000;

export class AccountsStore {
  #accounts: AccountState[] | undefined;
  #error: unknown;
  readonly #listeners = new Set<() => void>();
  readonly #stop: () => void;
  readonly #stopFocus: () => void;
  #focusReadAt = 0;

  constructor(client: WevirClient, workbench: WorkbenchStore) {
    const onFocus = () => {
      if (document.visibilityState !== 'visible' || this.#accounts === undefined) return;
      if (Date.now() - this.#focusReadAt < FOCUS_READ_MIN_MS) return;
      this.#focusReadAt = Date.now();
      // 只是顺带的，读不到等下次。
      client.refreshAccounts().catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    this.#stopFocus = () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
    this.#stop = client.watchAccounts(
      (accounts) => {
        const before = new Map(
          this.#accounts?.map((account) => [accountId(account), account.status]),
        );
        this.#accounts = accounts;
        this.#error = undefined;
        if (
          accounts.some(
            (account) =>
              account.status === 'signed_in' && before.get(accountId(account)) !== 'signed_in',
          )
        ) {
          // Host 建 Provider 在后台，稍等再读一次，免得读到建好之前的列表。
          void workbench.refresh();
          setTimeout(() => void workbench.refresh(), 800);
        }
        this.#publish();
      },
      (error) => {
        this.#error = error;
        this.#publish();
      },
    );
  }

  /** 还没读到时是 undefined。 */
  get = (): AccountState[] | undefined => this.#accounts;

  error(): unknown {
    return this.#error;
  }

  /** 本端操作的结果（login、setPath 等的返回值）立即合进来，不等通知。按账号 ID（0.63.0，一种可以有多个账号）。 */
  merge(account: AccountState): void {
    const accounts = [...(this.#accounts ?? [])];
    const id = accountId(account);
    const index = accounts.findIndex((item) => accountId(item) === id);
    if (index >= 0) accounts[index] = account;
    else accounts.push(account);
    this.#accounts = accounts;
    this.#publish();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  dispose(): void {
    this.#stopFocus();
    this.#stop();
    this.#listeners.clear();
  }

  #publish(): void {
    for (const listener of this.#listeners) listener();
  }
}
