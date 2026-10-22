import { hostSupports } from '@wevir/client-sdk';
import type { NotificationIntent, Session, SessionId, WevirEvent } from '@wevir/protocol';
import { useEffect, useRef, useState } from 'react';
import { Toast, type ToastTone } from '@/components/toast';
import { Button } from '@/components/ui/button';
import { useWorkbenchData, useWorkbenchStore } from '@/data/workbench-data';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { router } from '@/routes/router';
import { useAutomationRuns } from './automation-runs';
import {
  type Delivery,
  deliveryFor,
  displayDelivery,
  intentDisplayKind,
  isFresh,
  type NotificationKind,
  notificationKind,
  notificationTag,
  sessionIdFromTag,
} from './notification-model';
import {
  getNotificationSettings,
  migrateNotificationKinds,
  useNotificationSettings,
} from './notification-settings';
import { usePresenceReporter } from './presence';

/** 应用内提醒最多同时几条；再来的挤掉最早的。 */
const MAX_TOASTS = 3;
const TOAST_MS = 8000;

const TITLES = {
  approval: 'notify.approval',
  question: 'notify.question',
  completed: 'notify.completed',
  failed: 'notify.failed',
} as const satisfies Record<NotificationKind, string>;

const TONES: Record<NotificationKind, ToastTone> = {
  approval: 'attention',
  question: 'attention',
  completed: 'success',
  failed: 'danger',
};

interface ShownToast {
  key: string;
  kind: NotificationKind;
  sessionId: string;
  workspaceId: string;
  title: string;
  open: boolean;
}

/** 主窗格正在显示的会话（会话页与它的子智能体详情）。 */
function currentSessionId(): string | undefined {
  for (const match of router.state.matches) {
    const id = match.params.sessionId;
    if (id) return id;
  }
  return undefined;
}

function windowFocused(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function openSession(workspaceId: string, sessionId: string): void {
  void router.navigate(paths.session(workspaceId, sessionId));
}

/**
 * 会话的通知（U31，照 T3 Code 的 ThreadNotificationCoordinator）：列表里的会话要审批、提问、出错或回合完成时，窗口在后台
 * 发系统通知（经主进程，点击回到这个会话）并记角标；窗口在前台、看的是别的会话时在右下角提醒。打开会话时收回它的系统
 * 通知与提醒，窗口回到前台时收回全部系统通知、清掉角标。挂在 ToastViewport 里。
 *
 * 0.106.0 起 Host 有 `notification_intents` 时“要不要提醒”由 Host 判定，这里只消费 `notification.intent`（种类开关在 Host 设置），
 * 并报告在场；旧 Host 上照旧从会话事件与自动化运行自己判定。
 */
export function NotificationCoordinator() {
  const store = useWorkbenchStore();
  const { client, view } = useHostConnection();
  const hostIntents =
    view.status === 'connected' && hostSupports(view.hello.features, 'notification_intents');
  const data = useWorkbenchData();
  const settings = useNotificationSettings();
  const [toasts, setToasts] = useState<ShownToast[]>([]);
  /** 窗口在后台时发出、还没收回的系统通知（按会话）。 */
  const delivered = useRef(new Set<string>());
  const sessions = useRef(new Map<string, Session>());
  /** 提醒过的会话所在的工作区：会话还不在左栏里（Host 开的自动化会话）时，点系统通知也能打开。 */
  const workspaces = useRef(new Map<string, string>());

  if (data.status === 'ready') {
    sessions.current = new Map(
      data.workspaces.flatMap((entry) => entry.sessions.map((session) => [session.id, session])),
    );
  }

  const updateBadge = () => {
    const count = getNotificationSettings().badge ? delivered.current.size : 0;
    void window.wevir.setBadgeCount(count).catch(() => undefined);
  };

  const dismissSession = (sessionId: string) => {
    setToasts((current) =>
      current.map((toast) => (toast.sessionId === sessionId ? { ...toast, open: false } : toast)),
    );
    if (delivered.current.delete(sessionId)) {
      void window.wevir.closeNotifications(notificationTag(sessionId)).catch(() => undefined);
      updateBadge();
    }
  };

  /**
   * 发一条提醒：前台看别的会话时在右下角，后台时发系统通知（点击回到会话）。`title` 是提醒里写的会话或自动化名。`decided` 时种类
   * 已由 Host 判过，不再看本机的种类开关。
   */
  const deliver = (
    kind: NotificationKind,
    target: { sessionId: string; workspaceId: string; title: string },
    key: string,
    decided = false,
  ) => {
    const current = getNotificationSettings();
    const context = { focused: windowFocused(), viewing: currentSessionId() === target.sessionId };
    const delivery: Delivery = decided
      ? displayDelivery(context, current)
      : deliveryFor(kind, context, current);
    workspaces.current.set(target.sessionId, target.workspaceId);
    if (delivery.toast) {
      setToasts((shown) => {
        const kept = shown.filter((toast) => toast.sessionId !== target.sessionId);
        const next: ShownToast = { key, kind, ...target, open: true };
        const open = kept.filter((toast) => toast.open);
        const overflow = new Set(
          open.slice(0, Math.max(0, open.length - (MAX_TOASTS - 1))).map((toast) => toast.key),
        );
        return [
          ...kept.map((toast) => (overflow.has(toast.key) ? { ...toast, open: false } : toast)),
          next,
        ];
      });
    }
    if (delivery.system) {
      void window.wevir
        .notify({
          tag: notificationTag(target.sessionId),
          title: t(TITLES[kind]),
          body: target.title,
          sound: current.sound,
        })
        .then((shown) => {
          if (!shown) return;
          delivered.current.add(target.sessionId);
          updateBadge();
        })
        .catch(() => undefined);
    }
  };
  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;

  // 会话事件 → 提醒。自动化开的会话、自动化的运行正在里面进行的已有会话（0.73.0）不在这里提醒，按自动化的通知设置走
  // 下面的运行状态（0.66.0）。
  const quietSessions = useRef(new Set<string>());
  useEffect(() => {
    if (!store || hostIntents) return;
    return store.onSessionEvent((event: WevirEvent, session: Session) => {
      if (session.automation !== undefined || quietSessions.current.has(session.id)) return;
      const kind = notificationKind(event, session);
      if (!kind || !isFresh(event, Date.now())) return;
      deliverRef.current(
        kind,
        {
          sessionId: session.id,
          workspaceId: session.workspaceId,
          title: session.title || t('session.untitled'),
        },
        `${session.id}:${event.seq}`,
      );
    });
  }, [store, hostIntents]);

  // 自动化的运行 → 提醒（0.66.0）：运行开出的会话先放进列表；状态变成等待处理、失败或完成时按自动化的通知设置提醒。
  useAutomationRuns(
    client,
    store,
    sessions,
    (kind, target, key) => deliverRef.current(kind, target, key),
    quietSessions,
    !hostIntents,
  );

  // Host 的通知意图 → 提醒（0.106.0）。没有会话的（自动化没建出会话）不提醒，同以前；工作区不知道时读一次会话。连上时先把本机的
  // 种类开关迁进 Host 设置。
  useEffect(() => {
    if (!client || !hostIntents) return;
    void migrateNotificationKinds(window.localStorage, client).catch(() => undefined);
    let disposed = false;
    const workspaceOf = async (intent: NotificationIntent, sessionId: SessionId) => {
      const known = intent.workspaceId ?? sessions.current.get(sessionId)?.workspaceId;
      if (known !== undefined) return known;
      try {
        const { session } = await client.request('session.get', { sessionId });
        return session.workspaceId;
      } catch {
        return undefined;
      }
    };
    const stop = client.watchNotifications((intent) => {
      const sessionId = intent.sessionId;
      if (sessionId === undefined) return;
      void workspaceOf(intent, sessionId).then((workspaceId) => {
        if (disposed || workspaceId === undefined) return;
        deliverRef.current(
          intentDisplayKind(intent),
          { sessionId, workspaceId, title: intent.title || t('session.untitled') },
          intent.id,
          true,
        );
      });
    });
    return () => {
      disposed = true;
      stop();
    };
  }, [client, hostIntents]);

  usePresenceReporter(client);

  // 窗口回到前台：收回全部系统通知，清掉角标。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时注册。
  useEffect(() => {
    const onFocus = () => {
      if (delivered.current.size === 0) return;
      delivered.current.clear();
      void window.wevir.closeNotifications().catch(() => undefined);
      updateBadge();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // 打开会话：收回这个会话的通知与提醒。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在挂载时订阅路由。
  useEffect(
    () =>
      router.subscribe(() => {
        const sessionId = currentSessionId();
        if (sessionId) dismissSession(sessionId);
      }),
    [],
  );

  // 点击系统通知：主进程已把窗口带回前台，这里打开那个会话。
  useEffect(
    () =>
      window.wevir.onNotificationClick((tag) => {
        const sessionId = sessionIdFromTag(tag);
        if (!sessionId) return;
        const workspaceId =
          sessions.current.get(sessionId)?.workspaceId ?? workspaces.current.get(sessionId);
        if (workspaceId) openSession(workspaceId, sessionId);
      }),
    [],
  );

  // 关掉的提醒等离场动画结束后从列表里去掉。
  useEffect(() => {
    if (toasts.every((toast) => toast.open)) return;
    const timer = window.setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.open)),
      400,
    );
    return () => window.clearTimeout(timer);
  }, [toasts]);

  // 关掉角标的开关时立即清掉。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只跟着开关。
  useEffect(() => updateBadge(), [settings.badge]);

  return toasts.map((toast) => (
    <Toast
      key={toast.key}
      open={toast.open}
      tone={TONES[toast.kind]}
      title={t(TITLES[toast.kind])}
      duration={TOAST_MS}
      testId="session-notification"
      onClose={() =>
        setToasts((current) =>
          current.map((item) => (item.key === toast.key ? { ...item, open: false } : item)),
        )
      }
    >
      <p className="truncate text-xs text-muted-foreground">{toast.title}</p>
      <div className="pt-1.5">
        <Button
          size="sm"
          variant="outline"
          onClick={() => openSession(toast.workspaceId, toast.sessionId)}
        >
          {t('notify.open')}
        </Button>
      </div>
    </Toast>
  ));
}
