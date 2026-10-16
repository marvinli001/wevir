// 内置浏览器（0.33.0）：BrowserBroker 怎样选提供方、记住标签页在哪、超时、断开与取消（照 Paseo 的 broker.test.ts 取舍）。

import type { BrowserRequest, BrowserResponse, SessionId } from '@wevir/protocol';
import { BROWSER_COMMANDS } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { BrowserBroker } from './browser-broker.js';

const SESSION = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId;

function provider(id: string, answer?: (request: BrowserRequest) => BrowserResponse | undefined) {
  const requests: BrowserRequest[] = [];
  let broker: BrowserBroker | undefined;
  return {
    id,
    commands: [...BROWSER_COMMANDS],
    requests,
    attach(target: BrowserBroker) {
      broker = target;
      return target.register(this);
    },
    send(request: BrowserRequest) {
      requests.push(request);
      const response = answer?.(request);
      if (response) queueMicrotask(() => broker?.respond(id, response));
      return true;
    },
  };
}

const newTab = (url = 'http://localhost:5173/') => ({
  sessionId: SESSION,
  cwd: '/work',
  command: { command: 'new_tab' as const, args: { url } },
});

const tabAnswer =
  (browserId: string) =>
  (request: BrowserRequest): BrowserResponse => {
    switch (request.command.command) {
      case 'new_tab':
        return {
          requestId: request.requestId,
          ok: true,
          result: { command: 'new_tab', browserId, url: request.command.args.url ?? 'about:blank' },
        };
      case 'list_tabs':
        return {
          requestId: request.requestId,
          ok: true,
          result: {
            command: 'list_tabs',
            tabs: [
              {
                browserId,
                url: 'http://localhost:5173/',
                title: 'App',
                isActive: true,
                isLoading: false,
                controller: 'agent',
              },
            ],
          },
        };
      default:
        return {
          requestId: request.requestId,
          ok: true,
          result: { command: 'reload', browserId },
        };
    }
  };

describe('BrowserBroker', () => {
  it('没有提供方时明确说不可用', async () => {
    const broker = new BrowserBroker();
    expect(broker.available).toBe(false);
    const payload = await broker.execute(newTab());
    expect(payload).toMatchObject({
      ok: false,
      error: { code: 'browser_no_host', retryable: true },
    });
  });

  it('请求带会话与目录，回答按 requestId 对上', async () => {
    const broker = new BrowserBroker();
    const desktop = provider('a', tabAnswer('tab_1'));
    desktop.attach(broker);
    const payload = await broker.execute(newTab());
    expect(payload).toEqual({
      ok: true,
      result: { command: 'new_tab', browserId: 'tab_1', url: 'http://localhost:5173/' },
    });
    expect(desktop.requests[0]).toMatchObject({ sessionId: SESSION, cwd: '/work' });
    expect(desktop.requests[0]?.requestId).toMatch(/^brq_/);
    expect(broker.pendingCount).toBe(0);
  });

  it('标签页交给开出它的提供方；新开的交给最近登记的', async () => {
    const broker = new BrowserBroker();
    const first = provider('a', tabAnswer('tab_a'));
    const second = provider('b', tabAnswer('tab_b'));
    first.attach(broker);
    await broker.execute(newTab());
    second.attach(broker);
    await broker.execute(newTab());
    expect(second.requests).toHaveLength(1);
    await broker.execute({
      sessionId: SESSION,
      cwd: '/work',
      command: { command: 'reload', args: { browserId: 'tab_a' } },
    });
    expect(first.requests.map((request) => request.command.command)).toEqual(['new_tab', 'reload']);
    const unknown = await broker.execute({
      sessionId: SESSION,
      cwd: '/work',
      command: { command: 'reload', args: { browserId: 'tab_x' } },
    });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'browser_tab_not_found' } });
  });

  it('list_tabs 问所有提供方再合起来', async () => {
    const broker = new BrowserBroker();
    provider('a', tabAnswer('tab_a')).attach(broker);
    provider('b', tabAnswer('tab_b')).attach(broker);
    const payload = await broker.execute({
      sessionId: SESSION,
      cwd: '/work',
      command: { command: 'list_tabs', args: {} },
    });
    expect(
      payload.ok && payload.result.command === 'list_tabs'
        ? payload.result.tabs.map((tab) => tab.browserId)
        : [],
    ).toEqual(['tab_a', 'tab_b']);
  });

  it('提供方断开：在途的请求失败，它的标签页等它重新登记', async () => {
    const broker = new BrowserBroker();
    const desktop = provider('a', tabAnswer('tab_1'));
    const unregister = desktop.attach(broker);
    await broker.execute(newTab());
    const silent = provider('a');
    // 同一条连接换成不回答的：先发出请求再断开。
    unregister();
    const reregister = silent.attach(broker);
    const inflight = broker.execute({
      sessionId: SESSION,
      cwd: '/work',
      command: { command: 'reload', args: { browserId: 'tab_1' } },
    });
    reregister();
    expect(await inflight).toMatchObject({ ok: false, error: { code: 'browser_no_host' } });
    const stranded = await broker.execute({
      sessionId: SESSION,
      cwd: '/work',
      command: { command: 'reload', args: { browserId: 'tab_1' } },
    });
    expect(stranded).toMatchObject({ ok: false, error: { code: 'browser_no_host' } });
    desktop.attach(broker);
    const back = await broker.execute({
      sessionId: SESSION,
      cwd: '/work',
      command: { command: 'reload', args: { browserId: 'tab_1' } },
    });
    expect(back.ok).toBe(true);
  });

  it('超时与取消；之后到的回答不收', async () => {
    const broker = new BrowserBroker({ defaultTimeoutMs: 20 });
    const desktop = provider('a');
    desktop.attach(broker);
    expect(await broker.execute(newTab())).toMatchObject({
      ok: false,
      error: { code: 'browser_timeout', retryable: true },
    });
    const late = desktop.requests[0] as BrowserRequest;
    expect(
      broker.respond('a', {
        requestId: late.requestId,
        ok: true,
        result: { command: 'new_tab', browserId: 'tab_1', url: 'about:blank' },
      }),
    ).toBe(false);

    const controller = new AbortController();
    const cancelled = broker.execute({ ...newTab(), signal: controller.signal, timeoutMs: 5000 });
    controller.abort();
    expect(await cancelled).toMatchObject({ ok: false, error: { message: 'cancelled' } });
    expect(broker.pendingCount).toBe(0);
  });

  it('别的连接不能回答不是交给它的请求', async () => {
    const broker = new BrowserBroker({ defaultTimeoutMs: 50 });
    const desktop = provider('a');
    desktop.attach(broker);
    const pending = broker.execute(newTab());
    const request = desktop.requests[0] as BrowserRequest;
    expect(
      broker.respond('b', {
        requestId: request.requestId,
        ok: false,
        error: { code: 'browser_denied', message: 'no' },
      }),
    ).toBe(false);
    expect(await pending).toMatchObject({ error: { code: 'browser_timeout' } });
  });

  it('提供方没声明的命令不发过去', async () => {
    const broker = new BrowserBroker();
    broker.register({ id: 'old', commands: ['list_tabs', 'new_tab'], send: () => true });
    const payload = await broker.execute({
      sessionId: SESSION,
      cwd: '/work',
      command: { command: 'snapshot', args: { browserId: 'tab_1' } },
    });
    expect(payload).toMatchObject({ ok: false, error: { code: 'browser_unsupported' } });
  });

  it('发不出去时立即失败', async () => {
    const broker = new BrowserBroker();
    broker.register({ id: 'closing', commands: [...BROWSER_COMMANDS], send: () => false });
    expect(await broker.execute(newTab())).toMatchObject({ error: { code: 'browser_no_host' } });
  });
});
