// 休眠之后照常工作：控制连接与接通的设备连接空闲到 Durable Object 被驱逐（workerd 本地也是空闲约 10 s），状态只剩 WebSocket 附件，
// 醒来后转发、通知新的设备连接、Host 拒绝与断开都照常。

import { REMOTE_PATHS, RelayCloseCode } from '@wevir/protocol';
import { acceptUrl, deviceUrl, relayTestKit, until } from '@wevir/relay/conformance';
import { expect, it } from 'vitest';
import { startWorker } from './start.js';

const { cleanups, open, registerHost } = relayTestKit();

it('空闲到休眠之后转发、通知、拒绝与断开照常', async () => {
  const relay = await startWorker({});
  cleanups.push(() => relay.close());
  const { url } = relay;
  const host = await registerHost(url);
  const device = await open(deviceUrl(url, host.key.routeId));
  device.ws.send(Buffer.from([1]));
  const data = await open(acceptUrl(url, (await host.incoming(0)).id));
  await until(() => data.messages[0], 'first message');

  await new Promise((resolve) => setTimeout(resolve, 15_000));

  device.ws.send(Buffer.from([2]));
  await until(() => data.messages[1], 'message after hibernation');
  data.ws.send(Buffer.from([3]));
  await until(() => device.messages[0], 'reply after hibernation');
  expect([...(device.messages[0]?.data ?? [])]).toEqual([3]);

  const second = await open(deviceUrl(url, host.key.routeId, REMOTE_PATHS.pair));
  const incoming = await host.incoming(1);
  expect(incoming.path).toBe(REMOTE_PATHS.pair);
  host.control.ws.send(JSON.stringify({ type: 'reject', id: incoming.id }));
  await until(() => second.closed, 'rejected');
  expect(second.closed?.code).toBe(RelayCloseCode.HOST_REJECTED);

  data.ws.close(4007, 'device removed');
  await until(() => device.closed, 'device closed');
  expect(device.closed).toEqual({ code: 4007, reason: 'device removed' });
}, 40_000);
