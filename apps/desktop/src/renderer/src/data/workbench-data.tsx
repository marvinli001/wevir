import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { describe, useHostConnection } from '@/host/host-connection';
import { recordBaselines } from './seen-sessions';
import { groupSessions, type WorkbenchData } from './workbench-model';

const WorkbenchDataContext = createContext<WorkbenchData>({ status: 'loading' });

/**
 * 工作区与会话列表的快照：每次（重新）连上 Host 时读一次 workspace.list 与 session.list。骨架只读
 * 快照，不订阅事件；会话状态的实时更新、按最近活动排序、新建会话归 T5.3。
 */
export function WorkbenchDataProvider({ children }: { children: ReactNode }) {
  const { view, client } = useHostConnection();
  const [data, setData] = useState<WorkbenchData>({ status: 'loading' });
  // 每次连上（含重连）hello 都是新对象，据此重新读取。
  const hello = view.status === 'connected' ? view.hello : undefined;

  useEffect(() => {
    if (!client || !hello) return;
    let cancelled = false;
    void (async () => {
      try {
        const [{ workspaces }, { sessions }] = await Promise.all([
          client.request('workspace.list'),
          client.request('session.list'),
        ]);
        if (cancelled) return;
        recordBaselines(sessions);
        setData({ status: 'ready', workspaces: groupSessions(workspaces, sessions) });
      } catch (error) {
        // 已经有数据时保留旧快照（断线重连中途失败很常见），没有数据才显示错误。
        if (!cancelled) {
          setData((current) =>
            current.status === 'ready' ? current : { status: 'error', error: describe(error) },
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, hello]);

  return <WorkbenchDataContext value={data}>{children}</WorkbenchDataContext>;
}

export function useWorkbenchData(): WorkbenchData {
  return useContext(WorkbenchDataContext);
}
