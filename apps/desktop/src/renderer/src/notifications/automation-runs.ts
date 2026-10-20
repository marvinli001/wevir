// 自动化运行的提醒（0.66.0，Host 功能 `automations`）：通知协调器（notification-coordinator.tsx）用它。先读一次
// `automation.list`（Host 只把 `automation.changed` 发给调用过 `automation.*` 的连接），记下每个自动化的标题与通知设置；
// 一次运行有了会话就把会话放进列表（Host 开的会话本端还不知道）；状态变了按 automations-model.ts 的 `shouldNotify` 决定
// 要不要提醒。发回某个已有会话（不是自动化开的）的运行不在这里提醒，那个会话的事件照常提醒。

import { hostSupports, type WevirClient } from '@wevir/client-sdk';
import type { Automation, AutomationNotify, AutomationRun, Session } from '@wevir/protocol';
import { type RefObject, useEffect, useRef } from 'react';
import { shouldNotify } from '@/automations/automations-model';
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
      const session = await sessionOf(run);
      if (!known.has(automationId)) await reload();
      const automation = known.get(automationId);
      const kind = KIND[run.status];
      if (disposed || !automation || !kind || !session) return;
      // 发回已有会话的运行：那个会话的事件已经提醒过了。
      if (session.automation?.automationId !== automationId) return;
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
    };
  }, [client, store, sessions]);
}
