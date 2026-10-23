// 全 App 共用的助理数据：一个 `BotStore`，背后是样例数据（电脑上的助理接口合入后换成各台电脑的连接）。

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { BotStore, type Timeline } from '../lib/bot-store';
import type { Bot } from '../lib/bots';
import { createFixtureSource } from './bot-fixtures';

const BotsContext = createContext<BotStore | undefined>(undefined);

export function BotsProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new BotStore(createFixtureSource()));
  useEffect(() => {
    store.start().catch((error: unknown) => console.warn('[wevir] could not list bots', error));
    return () => store.stop();
  }, [store]);
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

/** 新建时可选的电脑：有助理的电脑，按显示名去重。 */
export function useBotComputers(): { computer: string; name: string }[] {
  const { bots } = useBots();
  const seen = new Map<string, string>();
  for (const bot of bots) if (!seen.has(bot.computer)) seen.set(bot.computer, bot.computerName);
  return [...seen].map(([computer, name]) => ({ computer, name }));
}
