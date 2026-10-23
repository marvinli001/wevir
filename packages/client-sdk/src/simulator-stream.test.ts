// iOS 模拟器的画面流（0.122.0）：解帧，经真实的 WebSocket（`ws` 包与 Node 的全局 WebSocket）收二进制帧，异步迭代在流结束时结束。

import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import type { BinaryWebSocketConstructor } from './remote.js';
import {
  openSimulatorStream,
  parseSimulatorFrame,
  type SimulatorFrame,
  simulatorFrames,
} from './simulator-stream.js';

function frame(kind: number, payload: string | Uint8Array, pts = 16_667n): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(payload);
  const header = Buffer.alloc(13);
  header.writeUInt8(kind, 0);
  header.writeBigUInt64BE(pts, 1);
  header.writeUInt32BE(body.length, 9);
  return Buffer.concat([header, body]);
}

const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

/** 连上就发这几帧、然后关闭的服务。 */
async function serve(frames: Buffer[]): Promise<string> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  await new Promise((resolve) => server.once('listening', resolve));
  server.on('connection', (ws) => {
    for (const data of frames) ws.send(data);
    ws.close(1000, 'done');
  });
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/simulator/stream?token=t`;
}

describe('parseSimulatorFrame', () => {
  it('四种帧；尺寸帧带解析好的尺寸', () => {
    expect(parseSimulatorFrame(frame(0, 'avcC'))).toMatchObject({
      kind: 'config',
      ptsMicros: 16667,
    });
    const key = parseSimulatorFrame(frame(1, new Uint8Array([1, 2, 3])));
    expect(key?.kind).toBe('key');
    expect([...(key?.data ?? [])]).toEqual([1, 2, 3]);
    expect(parseSimulatorFrame(frame(2, 'd'))?.kind).toBe('delta');
    const size = parseSimulatorFrame(
      frame(3, JSON.stringify({ width: 1206, height: 2622, orientation: 'portrait' })),
    );
    expect(size).toMatchObject({
      kind: 'size',
      size: { width: 1206, height: 2622, orientation: 'portrait' },
    });
  });

  it('长度不对、种类不认识、尺寸不是 JSON 时返回 undefined', () => {
    expect(parseSimulatorFrame(new Uint8Array(5))).toBeUndefined();
    expect(parseSimulatorFrame(frame(9, 'x'))).toBeUndefined();
    expect(parseSimulatorFrame(frame(1, 'abc').subarray(0, 14))).toBeUndefined();
    expect(parseSimulatorFrame(frame(3, 'not json'))).toBeUndefined();
    // ArrayBuffer 与带偏移的视图都行。
    const padded = Buffer.concat([Buffer.from('xx'), frame(2, 'ok')]);
    expect(parseSimulatorFrame(padded.subarray(2))?.kind).toBe('delta');
    const copy = new Uint8Array(frame(2, 'ok'));
    expect(parseSimulatorFrame(copy.buffer)?.kind).toBe('delta');
  });
});

describe.each([
  ['ws', WsWebSocket as unknown as BinaryWebSocketConstructor],
  ['global WebSocket', globalThis.WebSocket as unknown as BinaryWebSocketConstructor],
])('经 %s 收帧', (_name, WebSocketImpl) => {
  it('openSimulatorStream：逐帧回调，流结束时 onClose 一次', async () => {
    const url = await serve([frame(0, 'avcC'), frame(1, 'key'), frame(2, 'delta')]);
    const frames: SimulatorFrame[] = [];
    const closed = await new Promise<{ code: number }>((resolve) => {
      openSimulatorStream(WebSocketImpl, url, {
        onFrame: (frame) => frames.push(frame),
        onClose: resolve,
      });
    });
    expect(closed.code).toBe(1000);
    expect(frames.map((frame) => frame.kind)).toEqual(['config', 'key', 'delta']);
  });

  it('simulatorFrames：异步迭代，服务关掉时结束', async () => {
    const url = await serve([frame(0, 'avcC'), frame(1, 'key')]);
    const kinds: string[] = [];
    for await (const frame of simulatorFrames(WebSocketImpl, url)) kinds.push(frame.kind);
    expect(kinds).toEqual(['config', 'key']);
  });
});
