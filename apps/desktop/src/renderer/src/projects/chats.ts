// 不在项目里的会话（0.39.0）：Host 声明 `chat_sessions` 时，新会话可以不选项目（“不在目录中工作”），会话建在 Host 的“对话”
// 工作区里、每个一个新建的文件夹；左栏单独一组“对话”。

import { hostSupports } from '@wevir/client-sdk';
import type { Workspace } from '@wevir/protocol';
import { isChats } from '@/data/workbench-model';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';

/** Host 能建不在项目里的会话。 */
export function useChatsSupported(): boolean {
  const { view } = useHostConnection();
  return view.status === 'connected' && hostSupports(view.hello.features, 'chat_sessions');
}

/** 界面上写的工作区名：“对话”工作区写“对话”（Host 给它的名字是给老客户端的英文）。 */
export function workspaceLabel(workspace: Pick<Workspace, 'displayName' | 'kind'>): string {
  return isChats(workspace) ? t('sidebar.chats') : workspace.displayName;
}
