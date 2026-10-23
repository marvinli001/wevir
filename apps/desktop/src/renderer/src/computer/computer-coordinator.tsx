// 电脑操作（0.114.0）的协调：Host 有 `computer_use` 时把这个窗口登记为电脑操作的提供方（client-sdk 的 `provideComputer`），
// Host 交来的请求转给主进程执行；`request_access` 在这里弹授权框（一次一个，排队），用户选完交给主进程记下。另外把回合在跑的
// 会话告诉主进程（回合结束时收起提示条、不再监听 Esc），送去提示条的文字，用户按 Esc 停下的会话在这里取消它们的回合。

import { COMPUTER_COMMANDS, type ComputerRequest } from '@wevir/protocol';
import { useEffect, useRef, useState } from 'react';
import { useWorkbenchData } from '@/data/workbench-data';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { platformApi } from '@/platform/platform';
import type { ComputerAccessPreparation, ComputerAnswer } from '../../../shared/desktop-api';
import { AccessDialog } from './access-dialog';

interface PendingAccess {
  preparation: ComputerAccessPreparation;
  resolve: (bundleIds: string[]) => void;
}

const ACTIVE_STATES = new Set(['running', 'awaiting_approval', 'cancelling']);

export function ComputerCoordinator() {
  const { client } = useHostConnection();
  const data = useWorkbenchData();
  const [queue, setQueue] = useState<PendingAccess[]>([]);
  const queueRef = useRef(setQueue);
  queueRef.current = setQueue;

  useEffect(() => {
    if (!client || !platformApi()?.computer) return;
    const computer = platformApi().computer;
    const ask = (preparation: ComputerAccessPreparation) =>
      new Promise<string[]>((resolve) =>
        queueRef.current((current) => [...current, { preparation, resolve }]),
      );
    const access = async (
      request: Extract<ComputerRequest['command'], { command: 'request_access' }>,
      sessionId: string,
    ): Promise<ComputerAnswer> => {
      const prepared = await computer.prepareAccess(
        sessionId,
        request.args.apps,
        request.args.reason,
      );
      if ('error' in prepared) return { ok: false, error: prepared.error };
      const approved = await ask(prepared);
      return computer.grant(prepared.accessId, approved);
    };
    // 重连后 client-sdk 自己重新登记；Host 没有这项功能时它不登记。
    return client.provideComputer(COMPUTER_COMMANDS, (request) =>
      request.command.command === 'request_access'
        ? access(request.command, request.sessionId)
        : computer.execute(request),
    );
  }, [client]);

  useEffect(() => {
    const computer = platformApi()?.computer;
    if (!computer) return;
    void computer.setOverlayLabel(t('computer.overlay')).catch(() => undefined);
    if (!client) return;
    return computer.onStopped((sessionIds) => {
      for (const sessionId of sessionIds) {
        client
          .request('session.cancel', { sessionId: sessionId as `ses_${string}` })
          .catch(() => undefined);
      }
    });
  }, [client]);

  const active =
    data.status === 'ready'
      ? data.workspaces
          .flatMap((entry) => entry.sessions)
          .filter((session) => ACTIVE_STATES.has(session.state))
          .map((session) => session.id)
          .sort()
          .join(',')
      : undefined;
  useEffect(() => {
    if (active === undefined || !platformApi()?.computer) return;
    void platformApi()
      .computer.setActiveSessions(active === '' ? [] : active.split(','))
      .catch(() => undefined);
  }, [active]);

  const current = queue[0];
  const title =
    current === undefined || data.status !== 'ready'
      ? undefined
      : data.workspaces
          .flatMap((entry) => entry.sessions)
          .find((session) => session.id === current.preparation.sessionId)?.title;

  if (current === undefined) return null;
  return (
    <AccessDialog
      key={current.preparation.accessId}
      preparation={current.preparation}
      sessionTitle={title}
      onDone={(bundleIds) => {
        current.resolve(bundleIds);
        setQueue((items) => items.slice(1));
      }}
    />
  );
}
