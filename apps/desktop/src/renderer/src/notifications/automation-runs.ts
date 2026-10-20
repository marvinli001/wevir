// 自动化运行的提醒（0.66.0，Host 功能 `automations`）：通知协调器（notification-coordinator.tsx）用它。先读一次
// `automation.list`（Host 只把 `automation.changed` 发给调用过 `automation.*` 的连接），记下每个自动化的标题与通知设置；
// 一次运行有了会话就把会话放进列表（Host 开的会话本端还不知道）；状态变了按 automations-model.ts 的 `shouldNotify` 决定
// 要不要提醒。发进已有会话（不是自动化开的，0.71.0）的运行也按自动化的设置提醒：运行进行中把那个会话记进 `quietSessions`，
// 通知协调器这期间不按会话事件提醒它。

import { hostSupports, type WevirClient } from '@wevir/client-sdk';
import type { Automation, AutomationNotify, AutomationRun, Session } from '@wevir/protocol';
import { type RefObject, useEffect, useRef } from 'react';
import { isRunActive, shouldNotify } from '@/automations/automations-model';
import type { WorkbenchStore } from '@/data/workbench-store';
import type { NotificationKind } from './notification-model';

const KIND: Partial<Record<AutomationRun['status'], NotificationKind>> = {
  waiting: 'approval',
  failed: 'failed',
  completed: 'completed',
};

type Deliver = (
  kind: NotificationKind,
  target: { sessionId: string; workspaceId: string; title: string },
  key: string,
) => void;

export function useAutomationRuns(
  client: WevirClient | undefined,
  store: WorkbenchStore | undefined,
  sessions: RefObject<Map<string, Session>>,
  deliver: Deliver,
  /** 自动化的运行正在里面进行的已有会话：协调器不按它们的会话事件提醒。 */
  quietSessions: RefObject<Set<string>>,
): void {
  const deliverRef = useRef(deliver);
  deliverRef.current = deliver;
  useEffect(() => {
    if (client === undefined || store === undefined) return;
    if (!hostSupports(client.hello.features, 'automations')) return;
    let disposed = false;
    const known = new Map<string, { title: string; notify: AutomationNotify }>();
    /** 已经处理过的“运行:状态”，同一状态不重复提醒。 */
    const seen = new Set<string>();
    const remember = (automations: readonly Automation[]) => {
      known.clear();
      for (const automation of automations) {
        known.set(automation.id, { title: automation.title, notify: automation.notify });
        const run = automation.lastRun;
        if (run) seen.add(`${run.id}:${run.status}`);
        if (run?.sessionId !== undefined && isRunActive(run)) {
          quietSessions.current.add(run.sessionId);
        }
      }
    };
    const reload = () =>
      client
        .request('automation.list', {})
        .then(({ automations }) => {
          if (!disposed) remember(automations);
        })
        .catch(() => undefined);
    void reload();

    const sessionOf = async (run: AutomationRun): Promise<Session | undefined> => {
      if (run.sessionId === undefined) return undefined;
      const listed = sessions.current.get(run.sessionId);
      if (listed) return listed;
      try {
        const { session } = await client.request('session.get', { sessionId: run.sessionId });
        if (!disposed) store.upsertSession(session);
        return session;
      } catch {
        return undefined;
      }
    };

    const onRun = async (automationId: string, run: AutomationRun) => {
      const key = `${run.id}:${run.status}`;
      if (seen.has(key)) return;
      seen.add(key);
      // 先同步记下，免得回合结束的会话事件比这里的异步处理先到。
      if (run.sessionId !== undefined) {
        if (isRunActive(run)) quietSessions.current.add(run.sessionId);
        else quietSessions.current.delete(run.sessionId);
      }
      const session = await sessionOf(run);
      if (!known.has(automationId)) await reload();
      const automation = known.get(automationId);
      const kind = KIND[run.status];
      if (disposed || !automation || !kind || !session) return;
      if (!shouldNotify(automation.notify, run)) return;
      deliverRef.current(
        kind,
        { sessionId: session.id, workspaceId: session.workspaceId, title: automation.title },
        key,
      );
    };

    const off = client.onAutomationsChanged((change) => {
      if (change === undefined) {
        void reload();
        return;
      }
      if (change.deleted) {
        known.delete(change.automationId);
        return;
      }
      if (change.run) void onRun(change.automationId, change.run);
      else void reload();
    });
    return () => {
      disposed = true;
      off();
      quietSessions.current.clear();
    };
  }, [client, store, sessions, quietSessions]);
}
