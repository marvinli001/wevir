import { useCan, useHostConnection } from '@/host/host-connection';
import { capabilities } from '@/platform/platform';
import type { PaneAccess } from './pane-kinds';

/** 外壳与这条连接能用哪些窗格（pane-kinds.ts 的 `paneKindUsable`）。 */
export function usePaneAccess(): PaneAccess {
  const { client } = useHostConnection();
  return {
    browserPane: capabilities().browserPane,
    terminalWrite: useCan('terminal.write'),
    simulator: client?.supports('ios_simulator') === true,
  };
}
