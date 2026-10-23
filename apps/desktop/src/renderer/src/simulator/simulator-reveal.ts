// agent 在会话里 attach 了模拟器（0.122.0，`simulator.show`）：那个会话的主视图打开模拟器窗格，看 agent attach 的那台。

import type { SessionId } from '@wevir/protocol';
import { useEffect } from 'react';
import { useHostConnection } from '@/host/host-connection';
import type { PaneController } from '@/layout/pane-controller';
import { selectDevice } from './simulator-feed';

export function useSimulatorReveal(sessionId: SessionId, panes: PaneController | undefined): void {
  const { client } = useHostConnection();
  useEffect(() => {
    if (!panes || !client?.supports('ios_simulator')) return;
    return client.onSimulatorShow((show) => {
      if (show.sessionId !== sessionId) return;
      selectDevice(sessionId, show.udid);
      panes.open({ kind: 'simulator' });
    });
  }, [client, sessionId, panes]);
}
