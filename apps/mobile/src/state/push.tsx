// 推送（push.ts、push-native.ts）接进 App：每台连上的电脑按它的推送状态登记、重登或清理；令牌变了全部重来；维护扩展与后台任务读的
// 电脑清单；点系统通知打开对应的会话或助理（`notificationTarget`）；App 在前台、连着那台电脑时不另弹系统通知。

import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { AppState } from 'react-native';
import type { ComputerLink } from '../lib/computer-link';
import { notificationTarget } from '../lib/notifications';
import { type PushComputer, type PushRegistrar, type PushStatus, targetIntent } from '../lib/push';
import {
  ensureAndroidChannels,
  ensureIosCategory,
  pushTargetOf,
  registerPushTask,
  setForegroundSuppression,
  setVerifyCodeSink,
} from '../lib/push-native';
import { readSharedState, writeSharedState } from '../lib/push-store';
import { usePushRegistrar, useRegistry } from './registry';

interface PushContextValue {
  registrar: PushRegistrar;
  hideOnLockScreen: boolean;
  setHideOnLockScreen(value: boolean): void;
}

const PushContext = createContext<PushContextValue | undefined>(undefined);

/** 前台的系统通知：Wevir 的推送在连着那台电脑时不弹（提醒条已经弹了），别的照常显示。 */
let isOnline: (computer: string) => boolean = () => false;

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const target = await pushTargetOf(notification.request).catch(() => undefined);
    const show = target === undefined || !isOnline(target.computer);
    return {
      shouldShowBanner: show,
      shouldShowList: show,
      shouldPlaySound: show,
      shouldSetBadge: false,
    };
  },
});

export function PushProvider({ children }: { children: ReactNode }) {
  const registry = useRegistry();
  const registrar = usePushRegistrar();
  const router = useRouter();
  const [hideOnLockScreen, setHide] = useState(false);

  useEffect(() => {
    registerPushTask();
    void ensureAndroidChannels().catch(() => {});
    void ensureIosCategory().catch(() => {});
    setVerifyCodeSink((code) => registrar.deliverCode(code));
    const online = (computer: string) =>
      AppState.currentState === 'active' &&
      registry.link(computer)?.snapshot.status.kind === 'online';
    isOnline = online;
    setForegroundSuppression(online);
    void readSharedState().then((state) => setHide(state.hideOnLockScreen));
    return () => {
      setVerifyCodeSink(undefined);
      setForegroundSuppression(undefined);
      isOnline = () => false;
    };
  }, [registry, registrar]);

  // 每台电脑的每条连接登记一次，并跟着 `push.changed`；令牌变了全部重来。
  useEffect(() => {
    const watches = new Map<string, { connection: object; stop: () => void }>();
    const computerOf = (link: ComputerLink): PushComputer => ({
      name: link.snapshot.record.name,
      routeId: link.snapshot.record.routeId,
    });
    const start = (link: ComputerLink) => {
      const client = link.push;
      if (client === undefined) return () => {};
      const computer = computerOf(link);
      void registrar.sync(computer, client);
      return client.onChanged((state) => void registrar.sync(computer, client, state));
    };
    const sync = () => {
      const names = new Set<string>();
      for (const { record } of registry.snapshots) {
        names.add(record.name);
        const link = registry.link(record.name);
        const connection = link?.connection;
        const current = watches.get(record.name);
        if (current?.connection === connection) continue;
        current?.stop();
        watches.delete(record.name);
        if (link === undefined || connection === undefined) continue;
        watches.set(record.name, { connection, stop: start(link) });
      }
      for (const [name, watch] of watches) {
        if (names.has(name)) continue;
        watch.stop();
        watches.delete(name);
      }
    };
    sync();
    const off = registry.subscribe(sync);
    // expo-notifications 每次 `getDevicePushTokenAsync` 都会发一次这个事件；只在令牌真的变了时重登。
    const tokenSubscription = Notifications.addPushTokenListener((token) => {
      if (!registrar.tokenChanged(String(token.data))) return;
      registrar.resetToken();
      for (const [name] of watches) {
        const link = registry.link(name);
        if (link?.push !== undefined) void registrar.sync(computerOf(link), link.push);
      }
    });
    // 从系统设置里回来时通知权限可能变了。
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') registrar.resetToken();
    });
    return () => {
      off();
      tokenSubscription.remove();
      appState.remove();
      for (const watch of watches.values()) watch.stop();
    };
  }, [registry, registrar]);

  // 扩展与后台任务要逐台试的电脑（已移除的不算）。
  useEffect(() => {
    let last = '';
    const write = () => {
      if (!registry.loaded) return;
      const computers = registry.snapshots
        .filter((s) => s.status.kind !== 'removed')
        .map((s) => ({ name: s.record.name, routeId: s.record.routeId }));
      const next = JSON.stringify({ computers, hideOnLockScreen });
      if (next === last) return;
      last = next;
      void writeSharedState({ version: 1, hideOnLockScreen, computers }).catch((error: unknown) =>
        console.warn('[wevir] could not write the push state', error),
      );
    };
    write();
    return registry.subscribe(write);
  }, [registry, hideOnLockScreen]);

  // 点系统通知：冷启动时的那一次，与之后的每一次。
  const lastResponse = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (lastResponse === undefined || lastResponse === null) return;
    if (lastResponse.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    let stopped = false;
    void pushTargetOf(lastResponse.notification.request)
      .catch(() => undefined)
      .then((target) => {
        if (stopped || target === undefined) return;
        Notifications.clearLastNotificationResponse();
        router.push(notificationTarget(target.computer, targetIntent(target)));
      });
    return () => {
      stopped = true;
    };
  }, [lastResponse, router]);

  const setHideOnLockScreen = useCallback((value: boolean) => setHide(value), []);
  return (
    <PushContext.Provider value={{ registrar, hideOnLockScreen, setHideOnLockScreen }}>
      {children}
    </PushContext.Provider>
  );
}

function usePushContext(): PushContextValue {
  const value = useContext(PushContext);
  if (value === undefined) throw new Error('usePush outside PushProvider');
  return value;
}

/** 一台电脑的推送状态；没连上过、或电脑不支持推送时按连接状态推断。 */
export function usePushStatus(name: string): PushStatus | undefined {
  const { registrar } = usePushContext();
  const registry = useRegistry();
  return useSyncExternalStore(
    (listener) => {
      const offPush = registrar.subscribe(listener);
      const offRegistry = registry.subscribe(listener);
      return () => {
        offPush();
        offRegistry();
      };
    },
    () => {
      const link = registry.link(name);
      if (link?.connection !== undefined && link.push === undefined) return UNSUPPORTED;
      return registrar.status(name);
    },
  );
}

const UNSUPPORTED: PushStatus = { kind: 'unsupported' };

export function usePushSettings(): {
  hideOnLockScreen: boolean;
  setHideOnLockScreen(value: boolean): void;
} {
  const { hideOnLockScreen, setHideOnLockScreen } = usePushContext();
  return { hideOnLockScreen, setHideOnLockScreen };
}
