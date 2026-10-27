// 全 App 共用的收件箱：一个 `InboxStore` 跟着电脑列表（state/registry.tsx），收件箱页与标签上的数字都从这里读。

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { type InboxSnapshot, InboxStore } from '../lib/inbox-store';
import { useRegistry } from './registry';

const InboxContext = createContext<InboxStore | undefined>(undefined);

export function InboxProvider({ children }: { children: ReactNode }) {
  const registry = useRegistry();
  const [store] = useState(() => new InboxStore(registry));
  useEffect(() => store.start(), [store]);
  return <InboxContext.Provider value={store}>{children}</InboxContext.Provider>;
}

export function useInboxStore(): InboxStore {
  const store = useContext(InboxContext);
  if (store === undefined) throw new Error('useInboxStore outside InboxProvider');
  return store;
}

export function useInbox(): InboxSnapshot {
  const store = useInboxStore();
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.snapshot,
  );
}
