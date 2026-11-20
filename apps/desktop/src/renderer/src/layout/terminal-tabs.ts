import type { WevirClient } from '@wevir/client-sdk';
import type { Terminal, TerminalId } from '@wevir/protocol';
import { useEffect } from 'react';
import { useHostConnection } from '@/host/host-connection';
import { onPanesClosed } from './pane-events';
import type { PaneTab } from './pane-state';

/** 跨窗格挂载复用正在创建的终端，直到标签明确关闭。 */
export const createdTerminals = new Map<string, Promise<Terminal>>();

async function closeTerminalTab(client: WevirClient, tab: PaneTab): Promise<void> {
  const creation = createdTerminals.get(tab.id);
  createdTerminals.delete(tab.id);
  const terminalId = creation ? (await creation).id : (tab.params?.id as TerminalId | undefined);
  if (terminalId) await client.request('terminal.close', { terminalId });
}

export function useTerminalTabCleanup(): void {
  const { client } = useHostConnection();
  useEffect(() => {
    if (!client) return;
    return onPanesClosed((tabs) => {
      for (const tab of tabs) {
        if (tab.kind === 'terminal') void closeTerminalTab(client, tab).catch(() => undefined);
      }
    });
  }, [client]);
}
