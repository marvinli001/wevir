import type { WevirClient } from '@wevir/client-sdk';
import type { AccountState } from '@wevir/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountsStore } from './accounts-store';
import type { WorkbenchStore } from './workbench-store';

const first: AccountState = {
  kind: 'claude',
  id: 'claude',
  status: 'signed_in',
  signIn: 'command',
};
const added: AccountState = {
  kind: 'claude',
  id: 'claude-5704',
  status: 'signed_in',
  signIn: 'command',
};

/** 像 client-sdk 的 watchAccounts 一样：重读把 Host 当前的全部交给监听器。 */
function fakeClient(host: { accounts: AccountState[] }) {
  let deliver: ((accounts: AccountState[]) => void) | undefined;
  const refreshAccounts = vi.fn(async () => deliver?.([...host.accounts]));
  const client = {
    watchAccounts: (listener: (accounts: AccountState[]) => void) => {
      deliver = listener;
      listener([...host.accounts]);
      return () => {
        deliver = undefined;
      };
    },
    refreshAccounts,
  };
  return { client: client as unknown as WevirClient, refreshAccounts };
}

function stubWindow() {
  const target = new EventTarget();
  vi.stubGlobal('window', target);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  return () => target.dispatchEvent(new Event('focus'));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('AccountsStore', () => {
  it('回到前台时经 client-sdk 重读全部：Host 已不再有的账号从表里消失', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const focus = stubWindow();
    const host = { accounts: [first, added] };
    const { client, refreshAccounts } = fakeClient(host);
    const workbench = { refresh: vi.fn(async () => {}) } as unknown as WorkbenchStore;
    const store = new AccountsStore(client, workbench);
    expect(store.get()).toEqual([first, added]);

    host.accounts = [first];
    focus();
    await vi.waitFor(() => expect(store.get()).toEqual([first]));
    expect(refreshAccounts).toHaveBeenCalledTimes(1);

    // 至多每 15 秒一次。
    focus();
    expect(refreshAccounts).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 15_000);
    focus();
    expect(refreshAccounts).toHaveBeenCalledTimes(2);
    store.dispose();
  });
});
