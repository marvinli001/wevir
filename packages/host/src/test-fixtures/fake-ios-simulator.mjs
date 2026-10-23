// 测试用的假 iOS 模拟器 helper（simulator/*.test.ts）：按 iOS 模拟器策划 §3 的线缆协议回答（stdin / stdout 一行一个 JSON），在 fd 3 上发
// 帧（`u32 streamId | u8 kind | u64 ptsMicros | u32 length | bytes`，大端）。`stream_start` 立刻发配置与一个关键帧，之后的帧由测试用
// `emit` 命令发；`stats` 回收到的命令计数。结果的形状同真实 helper（录像 ID 是 `rec_…` 字符串，`rotate` 带新 `screen`，`ax_tree` 是 `{root, count, truncated}`）。UDID 是 `OFF` 的设备回 `sim_not_booted`。`crash` 让进程以 1 退出；`FAKE_SIM_NO_READY=1`
// 时不报 ready。

import { writeFileSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';

const counts = {};
const streams = new Map();
let nextStream = 1;
let nextRecording = 1;
let pts = 0n;
const recordings = new Map();
let orientation = 'portrait';
const screen = () =>
  orientation.startsWith('landscape')
    ? { width: 874, height: 402, scale: 3 }
    : { width: 402, height: 874, scale: 3 };

/** 1×1 的透明 PNG。 */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function frame(streamId, kind, payload) {
  const body = Buffer.from(payload);
  const header = Buffer.alloc(17);
  header.writeUInt32BE(streamId, 0);
  header.writeUInt8(kind, 4);
  pts += 16_667n;
  header.writeBigUInt64BE(pts, 5);
  header.writeUInt32BE(body.length, 13);
  writeSync(3, Buffer.concat([header, body]));
}

const handlers = {
  describe_device: () => ({ screen: screen(), orientation }),
  stream_start: ({ udid }) => {
    const streamId = nextStream++;
    streams.set(streamId, udid);
    frame(streamId, 0, 'avcC');
    frame(streamId, 1, 'key-0');
    return { streamId };
  },
  stream_stop: ({ streamId }) => {
    streams.delete(streamId);
    return {};
  },
  keyframe: ({ streamId }) => {
    if (streams.has(streamId)) frame(streamId, 1, 'key-requested');
    return {};
  },
  /** 测试控制：在一路流上发一帧（`size` 字节的 payload，默认是 `text`）。 */
  emit: ({ streamId, kind, text, size }) => {
    frame(streamId, kind, size === undefined ? (text ?? '') : Buffer.alloc(size, 7));
    return {};
  },
  end_stream: ({ streamId }) => {
    const udid = streams.get(streamId);
    streams.delete(streamId);
    send({ event: 'stream_ended', udid, streamId, reason: 'test' });
    return {};
  },
  stats: () => ({ counts, streams: [...streams.keys()] }),
  /** 测试控制：helper 看到的语言环境。 */
  locale: () => ({ LC_ALL: process.env.LC_ALL ?? null, LC_CTYPE: process.env.LC_CTYPE ?? null }),
  screenshot: ({ scale }) => ({
    base64: PNG,
    width: Math.round(402 * (scale ?? 1)),
    height: Math.round(874 * (scale ?? 1)),
  }),
  record_start: ({ path }) => {
    const recordingId = `rec_${nextRecording++}`;
    recordings.set(recordingId, path);
    return { recordingId };
  },
  record_stop: ({ recordingId }) => {
    const path = recordings.get(recordingId);
    writeFileSync(path, 'mp4');
    return { path, durationMs: 1234 };
  },
  rotate: ({ udid, direction }) => {
    orientation = direction === 'left' ? 'landscapeLeft' : 'landscapeRight';
    send({ event: 'orientation', udid, orientation });
    return { orientation, screen: screen() };
  },
  ax_tree: ({ point }) => ({
    root: {
      id: '@a1',
      role: 'Application',
      label: 'Demo',
      frame: { x: 0, y: 0, width: 402, height: 874 },
      enabled: true,
      children: [
        {
          id: '@a2',
          role: 'Button',
          label: point ? 'At point' : 'Continue',
          identifier: 'continue',
          frame: { x: 10.4, y: 20.6, width: 100, height: 44 },
          enabled: true,
        },
      ],
    },
    count: 2,
    truncated: false,
  }),
  foreground_app: () => ({ pid: 4242, bundleId: 'com.example.App' }),
  crash: () => process.exit(1),
};
for (const name of [
  'tap',
  'touch',
  'touch_raw',
  'text',
  'key',
  'button',
  'set_keyboard',
  'slow_animations',
]) {
  handlers[name] = () => ({});
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  counts[request.cmd] = (counts[request.cmd] ?? 0) + 1;
  process.stderr.write(`fake-ios-simulator: ${request.cmd}\n`);
  const handler = handlers[request.cmd];
  if (handler === undefined) {
    send({
      id: request.id,
      ok: false,
      error: { code: 'sim_invalid_argument', message: `unknown command ${request.cmd}` },
    });
    return;
  }
  if (request.udid === 'OFF') {
    send({
      id: request.id,
      ok: false,
      error: { code: 'sim_not_booted', message: 'the device is not booted' },
    });
    return;
  }
  send({ id: request.id, ok: true, result: handler(request) });
});

if (process.env.FAKE_SIM_NO_READY !== '1') {
  send({ event: 'ready', version: '0.0.0-test', xcode: '26.5', hidTransport: 'indigo' });
}
