// 跨进程 iframe（OOPIF）的 CDP 子会话：接上时打开各个域、装替身、接下一层，最后放行；子会话里的请求、控制台与选文件框记进
// 这个标签页，响应体与交文件走那个子会话；子会话的根 frame 换文档不清空记录。用假的 webContents 驱动 TabMonitor。

import { describe, expect, it, vi } from 'vitest';
import { adaptWebContents, setNetworkMonitoring, watchTab } from './contents.js';

type Listener = (
  event: unknown,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => void;

function fakeTab(agentControlled = true) {
  let listener: Listener | undefined;
  const sent: Array<{ command: string; params: Record<string, unknown>; sessionId?: string }> = [];
  const contents = {
    id: 5_000_000 + Math.floor(Math.random() * 1_000_000),
    on: () => {},
    once: () => {},
    removeListener: () => {},
    isDestroyed: () => false,
    getURL: () => 'https://parent.test/',
    debugger: {
      isAttached: () => true,
      attach: () => {},
      sendCommand: async (command: string, params: Record<string, unknown>, sessionId?: string) => {
        sent.push({ command, params, ...(sessionId !== undefined && { sessionId }) });
        if (command === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'shim' };
        if (command === 'Network.getResponseBody')
          return { body: '{"pong":true}', base64Encoded: false };
        return {};
      },
      on: (event: string, handler: Listener) => {
        if (event === 'message') listener = handler;
      },
    },
  };
  watchTab(contents as never, agentControlled);
  const tab = adaptWebContents(contents as never);
  const emit = (method: string, params: Record<string, unknown>, sessionId = '') =>
    listener?.({}, method, params, sessionId);
  return { tab, emit, sent, contents };
}

describe('跨进程 iframe 的 CDP 子会话', () => {
  it('用户标签的首次只读命令不拦选文件框，并使用较小的网络缓冲', async () => {
    const { sent } = fakeTab(false);
    await vi.waitFor(() =>
      expect(sent).toContainEqual({
        command: 'Network.enable',
        params: { maxTotalBufferSize: 4 * 1024 * 1024, maxResourceBufferSize: 1024 * 1024 },
      }),
    );
    expect(sent).toContainEqual({
      command: 'Page.setInterceptFileChooserDialog',
      params: { enabled: false },
    });
  });

  it('交回用户时停主页面与子会话的 Network，晚到记录不重新变成 pending，接管后可以恢复', async () => {
    const { tab, contents, emit, sent } = fakeTab();
    await vi.waitFor(() =>
      expect(sent.some((entry) => entry.command === 'Target.setAutoAttach')).toBe(true),
    );
    emit('Target.attachedToTarget', {
      sessionId: 'child-1',
      targetInfo: { type: 'iframe' },
      waitingForDebugger: true,
    });
    await vi.waitFor(() => expect(sent.at(-1)?.command).toBe('Runtime.runIfWaitingForDebugger'));
    emit(
      'Network.requestWillBeSent',
      {
        requestId: 'pending',
        loaderId: 'L1',
        timestamp: 1,
        request: { url: 'https://child.test/pending', method: 'GET' },
      },
      'child-1',
    );
    expect(tab.getNetworkLog?.().entries).toHaveLength(1);
    setNetworkMonitoring(contents.id, false);
    expect(sent).toContainEqual({ command: 'Network.disable', params: {} });
    expect(sent).toContainEqual({ command: 'Network.disable', params: {}, sessionId: 'child-1' });
    emit(
      'Network.requestWillBeSent',
      {
        requestId: 'late',
        loaderId: 'L1',
        timestamp: 2,
        request: { url: 'https://child.test/late', method: 'GET' },
      },
      'child-1',
    );
    expect(tab.getNetworkLog?.().entries).toEqual([]);
    setNetworkMonitoring(contents.id, true);
    expect(sent.at(-1)).toEqual({
      command: 'Network.enable',
      params: { maxTotalBufferSize: 4 * 1024 * 1024, maxResourceBufferSize: 1024 * 1024 },
      sessionId: 'child-1',
    });
    emit(
      'Network.requestWillBeSent',
      {
        requestId: 'new',
        loaderId: 'L1',
        timestamp: 3,
        request: { url: 'https://child.test/new', method: 'GET' },
      },
      'child-1',
    );
    expect(tab.getNetworkLog?.().entries).toHaveLength(1);
  });

  it('主页面打开自动接上；接上的 iframe 打开各个域、装替身、接下一层，最后放行；worker 只放行', async () => {
    const { emit, sent } = fakeTab();
    await vi.waitFor(() =>
      expect(sent).toContainEqual({
        command: 'Target.setAutoAttach',
        params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      }),
    );
    emit('Target.attachedToTarget', {
      sessionId: 'child-1',
      targetInfo: { type: 'iframe', url: 'https://child.test/' },
      waitingForDebugger: true,
    });
    await vi.waitFor(() =>
      expect(sent.at(-1)).toEqual({
        command: 'Runtime.runIfWaitingForDebugger',
        params: {},
        sessionId: 'child-1',
      }),
    );
    const child = sent
      .filter((entry) => entry.sessionId === 'child-1')
      .map((entry) => entry.command);
    expect(child).toEqual(
      expect.arrayContaining([
        'Page.enable',
        'Page.setInterceptFileChooserDialog',
        'Runtime.enable',
        'Log.enable',
        'Network.enable',
        'Page.addScriptToEvaluateOnNewDocument',
        'Target.setAutoAttach',
      ]),
    );

    emit('Target.attachedToTarget', {
      sessionId: 'worker-1',
      targetInfo: { type: 'worker' },
      waitingForDebugger: true,
    });
    await vi.waitFor(() =>
      expect(sent.at(-1)).toMatchObject({
        command: 'Runtime.runIfWaitingForDebugger',
        sessionId: 'worker-1',
      }),
    );
    expect(sent.filter((entry) => entry.sessionId === 'worker-1')).toHaveLength(1);
  });

  it('子会话的请求记进标签页（iframe 文档只记一条），响应体从子会话取；子会话换文档不清空', async () => {
    const { tab, emit, sent } = fakeTab();
    emit('Network.requestWillBeSent', {
      requestId: 'doc',
      loaderId: 'L1',
      timestamp: 1,
      type: 'Document',
      request: { url: 'https://parent.test/', method: 'GET' },
    });
    emit('Page.frameNavigated', { frame: { id: 'main', loaderId: 'L1' } });
    // iframe 的文档：父页面与子会话各报一次。
    const frameDoc = {
      requestId: 'L2',
      loaderId: 'L2',
      timestamp: 2,
      type: 'Document',
      request: { url: 'https://child.test/', method: 'GET' },
    };
    emit('Network.requestWillBeSent', frameDoc);
    emit('Network.requestWillBeSent', frameDoc, 'child-1');
    emit('Network.responseReceived', { requestId: 'L2', response: { status: 200 } });
    emit('Network.loadingFinished', { requestId: 'L2', timestamp: 3 }, 'child-1');
    emit(
      'Network.requestWillBeSent',
      {
        requestId: 'api',
        loaderId: 'L2',
        timestamp: 4,
        type: 'Fetch',
        request: { url: 'https://child.test/api', method: 'GET' },
      },
      'child-1',
    );
    emit('Network.responseReceived', { requestId: 'api', response: { status: 200 } }, 'child-1');
    emit('Network.loadingFinished', { requestId: 'api', timestamp: 5 }, 'child-1');
    emit(
      'Page.frameNavigated',
      { frame: { id: 'child-root', parentId: 'main', loaderId: 'L2' } },
      'child-1',
    );
    emit(
      'Runtime.consoleAPICalled',
      { type: 'log', args: [{ type: 'string', value: 'from frame' }] },
      'child-1',
    );

    const log = tab.getNetworkLog?.();
    expect(log?.entries.map((entry) => [entry.url, entry.pending ?? false])).toEqual([
      ['https://parent.test/', true],
      ['https://child.test/', false],
      ['https://child.test/api', false],
    ]);
    expect(tab.getConsoleMessages?.().map((entry) => entry.message)).toEqual(['from frame']);
    const body = await tab.getNetworkBody?.('3', 1_000);
    expect(body).toMatchObject({ text: '{"pong":true}' });
    expect(sent.find((entry) => entry.command === 'Network.getResponseBody')).toMatchObject({
      params: { requestId: 'api' },
      sessionId: 'child-1',
    });
  });

  it('子会话里拦下的选文件框记着它的会话', () => {
    const { tab, emit } = fakeTab();
    emit(
      'Page.fileChooserOpened',
      { frameId: 'f', mode: 'selectSingle', backendNodeId: 42 },
      'child-1',
    );
    expect(tab.takeFileChooser?.()).toEqual({
      backendNodeId: 42,
      multiple: false,
      sessionId: 'child-1',
    });
  });
});
