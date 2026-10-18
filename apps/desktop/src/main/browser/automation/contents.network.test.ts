// 网络记录合并 CDP 的 ExtraInfo 事件（Cookie 与 Set-Cookie 只在那里），用假的 webContents 驱动 TabMonitor。

import { describe, expect, it } from 'vitest';
import { adaptWebContents } from './contents.js';

type Listener = (event: unknown, method: string, params?: Record<string, unknown>) => void;

function fakeTab() {
  let listener: Listener | undefined;
  let id = 9_000 + Math.floor(Math.random() * 1_000_000);
  id += 1;
  const contents = {
    id,
    on: () => {},
    once: () => {},
    removeListener: () => {},
    isDestroyed: () => false,
    getURL: () => 'https://example.test/',
    debugger: {
      isAttached: () => true,
      attach: () => {},
      sendCommand: async () => ({}),
      on: (event: string, handler: Listener) => {
        if (event === 'message') listener = handler;
      },
    },
  };
  const tab = adaptWebContents(contents as never);
  const emit = (method: string, params: Record<string, unknown>) => listener?.({}, method, params);
  return { tab, emit };
}

const request = (requestId: string, headers: Record<string, string> = { Accept: '*/*' }) => ({
  requestId,
  loaderId: 'L1',
  timestamp: 1,
  type: 'Fetch',
  request: { url: 'https://example.test/api', method: 'GET', headers },
});

const response = (
  requestId: string,
  headers: Record<string, string> = { 'Content-Type': 'x' },
) => ({
  requestId,
  timestamp: 2,
  response: { url: 'https://example.test/api', status: 200, statusText: 'OK', headers },
});

describe('网络记录的 ExtraInfo', () => {
  it('Cookie 与 Set-Cookie 并进记录，详情里只给长度', () => {
    const { tab, emit } = fakeTab();
    emit('Network.requestWillBeSent', request('r1'));
    emit('Network.requestWillBeSentExtraInfo', {
      requestId: 'r1',
      headers: { Accept: '*/*', Cookie: 'smk=1' },
    });
    emit('Network.responseReceived', response('r1'));
    emit('Network.responseReceivedExtraInfo', {
      requestId: 'r1',
      statusCode: 200,
      headers: { 'Content-Type': 'x', 'Set-Cookie': 'a=b; Path=/' },
    });
    const detail = tab.getNetworkDetail?.('1');
    expect(detail?.requestHeaders).toMatchObject({ Cookie: '[redacted, 5 characters]' });
    expect(detail?.responseHeaders).toMatchObject({
      'Set-Cookie': '[redacted, 11 characters]',
      'Content-Type': 'x',
    });
  });

  it('比主事件先到的 ExtraInfo 先放着，主事件到了再合并', () => {
    const { tab, emit } = fakeTab();
    emit('Network.requestWillBeSentExtraInfo', { requestId: 'r2', headers: { cookie: 'k=v' } });
    emit('Network.responseReceivedExtraInfo', {
      requestId: 'r2',
      statusCode: 200,
      headers: { 'set-cookie': 'z=1' },
    });
    emit('Network.requestWillBeSent', request('r2', { Cookie: 'old=1' }));
    emit('Network.responseReceived', response('r2'));
    const detail = tab.getNetworkDetail?.('1');
    // 同名（不分大小写）的以 ExtraInfo 为准，不会出现两份。
    expect(
      Object.keys(detail?.requestHeaders ?? {}).filter((k) => /^cookie$/i.test(k)),
    ).toHaveLength(1);
    expect(detail?.requestHeaders).toMatchObject({ cookie: '[redacted, 3 characters]' });
    expect(detail?.responseHeaders).toMatchObject({ 'set-cookie': '[redacted, 3 characters]' });
  });
});
