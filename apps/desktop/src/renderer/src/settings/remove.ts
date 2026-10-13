import { isRpcError, type WevirClient } from '@wevir/client-sdk';
import type { Session } from '@wevir/protocol';

/** 未关闭的会话：workspace.remove / provider.remove 会被它们挡住（RESOURCE_IN_USE，host-api.md §3.1）。 */
export function openSessions(sessions: Iterable<Session>): Session[] {
  return [...sessions].filter((session) => session.state !== 'closed');
}

/**
 * 移除工作区或 Provider。被未关闭的会话挡住时先关闭 Host 列出的那些会话（运行中的由 Host 先取消），再试一次；
 * 调用方要在确认框里写明会关闭会话。会话关闭后可以 resume，不丢历史。
 */
export async function removeClosingSessions(
  client: WevirClient,
  remove: () => Promise<unknown>,
): Promise<void> {
  try {
    await remove();
  } catch (error) {
    if (!isRpcError(error, 'RESOURCE_IN_USE') || !error.data) throw error;
    for (const sessionId of error.data.sessionIds) {
      await client.request('session.close', { sessionId });
    }
    await remove();
  }
}
