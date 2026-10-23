// 全 App 共用的助理数据：一个 `BotStore`，跟着配对的电脑与它们的连接走（每台在线、有频道接口的电脑读自己的助理）。

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { type BotAccess, BotStore, type Timeline } from '../lib/bot-store';
import type { Bot } from '../lib/bots';
import { displayName } from '../lib/records';
import { useRegistry } from './registry';

const BotsContext = createContext<BotStore | undefined>(undefined);

export function BotsProvider({ children }: { children: ReactNode }) {
  const registry = useRegistry();
  const [store] = useState(() => new BotStore());
  useEffect(() => {
    const sync = () =>
      store.setHosts(
        registry.snapshots.map(({ record }) => ({
          computer: record.name,
          computerName: displayName(record),
          client: registry.link(record.name)?.channels,
        })),
      );
    sync();
    const stop = registry.subscribe(sync);
    return () => {
      stop();
      store.setHosts([]);
    };
  }, [registry, store]);
  return <BotsContext.Provider value={store}>{children}</BotsContext.Provider>;
}

export function useBotStore(): BotStore {
  const store = useContext(BotsContext);
  if (store === undefined) throw new Error('useBotStore outside BotsProvider');
  return store;
}

export function useBots(): { loaded: boolean; bots: readonly Bot[] } {
  const store = useBotStore();
  const bots = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.list,
  );
  return { loaded: store.loaded, bots };
}

export function useBot(key: string): Bot | undefined {
  const { bots } = useBots();
  return bots.find((b) => b.key === key);
}

export function useTimeline(key: string): Timeline {
  const store = useBotStore();
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.timeline(key),
  );
}

/** 在线、能看助理的电脑数。 */
export function useOnlineBotHosts(): number {
  const store = useBotStore();
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.onlineCount(),
  );
}

/** 这台设备在助理所在电脑上能做的事。 */
export function useBotAccess(key: string): BotAccess {
  const store = useBotStore();
  const json = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => JSON.stringify(store.access(key)),
  );
  return JSON.parse(json) as BotAccess;
}

/** 能建助理的电脑（这台设备在那台电脑上有建助理的权限）。 */
export function useBotCreators(): { computer: string; name: string }[] {
  const store = useBotStore();
  const key = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => JSON.stringify(store.creators()),
  );
  return JSON.parse(key) as { computer: string; name: string }[];
}
