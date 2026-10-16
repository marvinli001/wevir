// 内置浏览器（0.33.0）的协调：桌面端连上 Host、Host 有 `browser_tools` 时把这个窗口登记为浏览器提供方，Host 交来的请求
// （会话里的 agent 调的 `browser_*` 工具）原样转给主进程执行（client-sdk 的 `provideBrowser`）；并把正在看的会话告诉主进程，
// 决定哪个会话的标签页能上屏。

import { BROWSER_COMMANDS, type BrowserResponse } from '@wevir/protocol';
import { useEffect } from 'react';
import { useHostConnection } from '@/host/host-connection';
import { router } from '@/routes/router';

/** 主窗格正在显示的会话（会话页与它的子智能体详情）。 */
function currentSessionId(): string | null {
  for (const match of router.state.matches) {
    const id = match.params.sessionId;
    if (id) return id;
  }
  return null;
}

export function BrowserCoordinator() {
  const { client, view } = useHostConnection();
  const connected = view.status === 'connected';

  useEffect(() => {
    if (!client || !window.wevir?.browser) return;
    const browser = window.wevir.browser;
    // 重连后 client-sdk 自己重新登记；Host 没有这项功能时它不登记。
    return client.provideBrowser(BROWSER_COMMANDS, async (request) => {
      const { requestId: _requestId, ...response } = (await browser.execute(
        request,
      )) as BrowserResponse;
      return response;
    });
  }, [client]);

  useEffect(() => {
    if (!connected || !window.wevir?.browser) return;
    const browser = window.wevir.browser;
    let last: string | null | undefined;
    const sync = () => {
      const next = currentSessionId();
      if (next === last) return;
      last = next;
      void browser.setVisibleSession(next).catch(() => {});
    };
    sync();
    return router.subscribe(sync);
  }, [connected]);

  return null;
}
