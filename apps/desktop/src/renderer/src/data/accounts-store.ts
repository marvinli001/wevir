// 全部账号（0.19.0，client-sdk 的 watchAccounts）：ChatGPT 与订阅来源的状态，设置页与模型选择共用一份。连上与重连时读全部，
// 之后跟着 account.updated。某个账号刚变成已登录时 Host 会在后台建（或刷新）它的 Provider，所以这时重读工作台的列表。

import type { WevirClient } from '@wevir/client-sdk';
import type { AccountState } from '@wevir/protocol';
import type { WorkbenchStore } from './workbench-store';

export class AccountsStore {
  #accounts: AccountState[] | undefined;
  #error: unknown;
  readonly #listeners = new Set<() => void>();
  readonly #stop: () => void;

  constructor(client: WevirClient, workbench: WorkbenchStore) {
    this.#stop = client.watchAccounts(
      (accounts) => {
        const before = new Map(this.#accounts?.map((account) => [account.kind, account.status]));
        this.#accounts = accounts;
        this.#error = undefined;
        if (
          accounts.some(
            (account) => account.status === 'signed_in' && before.get(account.kind) !== 'signed_in',
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

  /** 本端操作的结果（login、setPath 等的返回值）立即合进来，不等通知。 */
  merge(account: AccountState): void {
    const accounts = [...(this.#accounts ?? [])];
    const index = accounts.findIndex((item) => item.kind === account.kind);
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
    this.#stop();
    this.#listeners.clear();
  }

  #publish(): void {
    for (const listener of this.#listeners) listener();
  }
}
