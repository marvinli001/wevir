// OAuth 连接器的登录（0.97.0）：`connector.login` 拿到授权地址后用系统浏览器打开；完成、失败、超时与取消都由 Host 发
// `plugins.changed`，列表跟着变。这个窗口发起的登录记下 loginId，“取消”用它。

import type { WevirClient } from '@wevir/client-sdk';
import type { Connector } from '@wevir/protocol';
import { platformApi } from '@/platform/platform';

const logins = new Map<string, string>();

function ref(connector: Connector) {
  return {
    name: connector.name,
    ...(connector.workspaceId !== undefined && { workspaceId: connector.workspaceId }),
    ...(connector.pluginId !== undefined && { pluginId: connector.pluginId }),
  };
}

/** 开始登录并打开浏览器；权限不够时带上服务器要的 scope。同一个连接器再登录会取消上一次。 */
export async function signInConnector(client: WevirClient, connector: Connector): Promise<void> {
  const scopes =
    connector.oauth?.status === 'insufficient_scope' ? connector.oauth.scopes : undefined;
  const { loginId, authUrl } = await client.request('connector.login', {
    ...ref(connector),
    ...(scopes !== undefined && scopes.length > 0 && { scopes }),
  });
  logins.set(connector.id, loginId);
  await platformApi().openExternal(authUrl);
}

/** 这个窗口发起的、还能取消的登录。 */
export function canCancelSignIn(connector: Connector): boolean {
  return connector.oauth?.status === 'signing_in' && logins.has(connector.id);
}

export async function cancelSignIn(client: WevirClient, connector: Connector): Promise<void> {
  const loginId = logins.get(connector.id);
  if (loginId === undefined) return;
  logins.delete(connector.id);
  await client.request('connector.loginCancel', { loginId });
}

export async function signOutConnector(client: WevirClient, connector: Connector): Promise<void> {
  logins.delete(connector.id);
  await client.request('connector.logout', ref(connector));
}
