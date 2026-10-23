// iOS 模拟器（0.122.0）的 Host 一侧：真的拉起假 helper（test-fixtures/fake-ios-simulator.mjs），simctl 换成假的。覆盖请求与回答、
// fd 3 帧的解析与转发、新订阅者先收配置与关键帧、积压丢帧、关键帧组超限、helper 崩溃与重启、停流、截图与录像。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { useTempDir } from '../test-utils.js';
import { SimulatorError } from './errors.js';
import { SimulatorService, type SimulatorServiceOptions } from './service.js';
import { parseSimctlList, Simctl } from './simctl.js';
import { BOOTED, FakeSocket, fakeHelperBin, fakeSimctl, SHUT, until } from './test-helpers.js';

const posix = process.platform !== 'win32';
const tempDir = useTempDir();
const services: SimulatorService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
});

function setup(overrides: Partial<SimulatorServiceOptions> = {}, env: Record<string, string> = {}) {
  const dir = tempDir();
  const simctl = fakeSimctl();
  const warnings: string[] = [];
  const service = new SimulatorService({
    bin: fakeHelperBin(dir, env),
    dir: join(dir, 'simulator'),
    streamBase: () => 'ws://127.0.0.1:5000',
    simctl: new Simctl(simctl.run),
    sandbox: false,
    onWarning: (message) => warnings.push(message),
    ...overrides,
  });
  services.push(service);
  return { service, simctl, warnings, dir };
}

async function stats(service: SimulatorService) {
  return (await service.helperCommand('stats', {})) as {
    counts: Record<string, number>;
    streams: number[];
  };
}

/** attach 并接上一个假 WebSocket。 */
async function subscribe(service: SimulatorService, owner = 'conn-1') {
  const attached = await service.attach({ udid: BOOTED }, owner);
  const accept = service.acceptStream(attached.token);
  expect(accept).toBeDefined();
  const socket = new FakeSocket();
  accept?.(socket);
  return { attached, socket };
}

describe('simctl 的列表', () => {
  it('只留 iOS 的设备，已启动的在前，系列与版本取自设备类型与运行时', () => {
    const { run } = fakeSimctl();
    return run(['list']).then(({ stdout }) => {
      const list = parseSimctlList(stdout);
      expect(list.devices.map((device) => [device.name, device.state, device.family])).toEqual([
        ['iPhone 17 Pro', 'booted', 'iphone'],
        ['iPad Air', 'shutdown', 'ipad'],
      ]);
      expect(list.devices[0]?.osVersion).toBe('26.5');
      expect(list.runtimes).toEqual([
        {
          id: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
          name: 'iOS 26.5',
          platform: 'ios',
          version: '26.5',
          available: true,
        },
      ]);
    });
  });
});

describe.runIf(posix)('SimulatorService', () => {
  it('available：只在 macOS 上、helper 可执行时', async () => {
    const bin = fakeHelperBin(tempDir());
    expect(await SimulatorService.available(bin, 'darwin')).toBe(true);
    expect(await SimulatorService.available(bin, 'linux')).toBe(false);
    expect(await SimulatorService.available(undefined, 'darwin')).toBe(false);
    expect(await SimulatorService.available(join(tempDir(), 'missing'), 'darwin')).toBe(false);
  });

  it('请求与回答：describe_device、helper 的错误码原样带回', async () => {
    const { service } = setup();
    expect(await service.describe(BOOTED)).toEqual({
      screen: { width: 402, height: 874, scale: 3 },
      orientation: 'portrait',
    });
    const error = await service.input('OFF', { type: 'tap', x: 1, y: 2 }).catch((e) => e);
    expect(error).toBeInstanceOf(SimulatorError);
    expect(error).toMatchObject({ code: 'sim_not_booted' });
  });

  it('attach 给出一次性的令牌；新订阅者先收配置与关键帧，之后的帧原样转发（去掉 streamId）', async () => {
    const { service } = setup();
    const { attached, socket } = await subscribe(service);
    expect(attached.streamUrl).toBe(`ws://127.0.0.1:5000/simulator/stream?token=${attached.token}`);
    expect(attached.screen).toEqual({ width: 402, height: 874, scale: 3 });
    // 令牌只能用一次。
    expect(service.acceptStream(attached.token)).toBeUndefined();
    expect(service.acceptStream('nope')).toBeUndefined();
    await until(() => socket.sent.length >= 2);
    expect(socket.frames().slice(0, 2)).toEqual([
      { kind: 0, text: 'avcC' },
      { kind: 1, text: 'key-0' },
    ]);
    const streamId = (await stats(service)).streams[0] as number;
    await service.helperCommand('emit', { streamId, kind: 2, text: 'delta-1' });
    await until(() => socket.sent.length >= 3);
    const frame = socket.sent[2] as Buffer;
    // u8 kind | u64 pts | u32 length | bytes
    expect(frame.readUInt8(0)).toBe(2);
    expect(frame.readBigUInt64BE(1)).toBeGreaterThan(0n);
    expect(frame.readUInt32BE(9)).toBe(7);
    expect(frame.subarray(13).toString()).toBe('delta-1');
  });

  it('后来的订阅者从缓存收尺寸、配置与最近关键帧之后的帧', async () => {
    const { service } = setup();
    const first = await subscribe(service, 'a');
    const streamId = (await stats(service)).streams[0] as number;
    await service.helperCommand('emit', {
      streamId,
      kind: 3,
      text: JSON.stringify({ width: 1206, height: 2622, orientation: 'portrait' }),
    });
    await service.helperCommand('emit', { streamId, kind: 0, text: 'avcC-2' });
    await service.helperCommand('emit', { streamId, kind: 1, text: 'key-1' });
    await service.helperCommand('emit', { streamId, kind: 2, text: 'd-1' });
    await until(() => first.socket.sent.length >= 6);
    const second = await subscribe(service, 'b');
    expect(second.socket.frames().map((frame) => frame.text)).toEqual([
      JSON.stringify({ width: 1206, height: 2622, orientation: 'portrait' }),
      'avcC-2',
      'key-1',
      'd-1',
    ]);
    // 两个订阅者共用一路流。
    expect((await stats(service)).counts.stream_start).toBe(1);
  });

  it('积压超过上限时丢非关键帧并要关键帧，关键帧到了接着发；不断开', async () => {
    const { service } = setup({ backlogBytes: 1000 });
    const { socket } = await subscribe(service);
    const streamId = (await stats(service)).streams[0] as number;
    await until(() => socket.sent.length >= 2);
    socket.bufferedAmount = 5000;
    await service.helperCommand('emit', { streamId, kind: 2, text: 'dropped-1' });
    // 要关键帧之后 helper 发的是 key-requested；它到之前的非关键帧都不发。
    await until(() => socket.frames().some((frame) => frame.text === 'key-requested'));
    socket.bufferedAmount = 0;
    await service.helperCommand('emit', { streamId, kind: 2, text: 'after' });
    await until(() => socket.frames().some((frame) => frame.text === 'after'));
    expect(socket.frames().map((frame) => frame.text)).toEqual([
      'avcC',
      'key-0',
      'key-requested',
      'after',
    ]);
    expect(socket.closed).toBeUndefined();
    expect((await stats(service)).counts.keyframe).toBe(1);
  });

  it('关键帧组超过上限时不再缓存，新订阅者等下一个关键帧', async () => {
    const { service } = setup({ backlogBytes: 100 });
    const first = await subscribe(service, 'a');
    const streamId = (await stats(service)).streams[0] as number;
    await service.helperCommand('emit', { streamId, kind: 2, size: 200 });
    await until(() => first.socket.sent.length >= 3);
    const second = await subscribe(service, 'b');
    // 只有配置；关键帧是向 helper 要来的。
    await until(() => second.socket.frames().some((frame) => frame.text === 'key-requested'));
    expect(second.socket.frames()[0]).toEqual({ kind: 0, text: 'avcC' });
    expect(second.socket.frames().map((frame) => frame.kind)).not.toContain(2);
  });

  it('同一条连接再 attach 时断开旧的流；detach 与连接关闭撤掉订阅，没人看之后停流', async () => {
    const { service } = setup({ streamIdleMs: 50 });
    const first = await subscribe(service, 'conn');
    const second = await subscribe(service, 'conn');
    expect(first.socket.closed).toBeDefined();
    expect(second.socket.closed).toBeUndefined();
    service.detach(BOOTED, 'conn');
    expect(second.socket.closed).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await stats(service)).streams).toEqual([]);
    expect((await stats(service)).counts.stream_stop).toBe(1);
    // detachOwner 撤掉没用的令牌。
    const attached = await service.attach({ udid: BOOTED }, 'other');
    service.detachOwner('other');
    expect(service.acceptStream(attached.token)).toBeUndefined();
  });

  it('agent 用着设备时推迟停流', async () => {
    const { service } = setup({ streamIdleMs: 150 });
    await service.agentAttach('ses_01JA2B3C4D5E6F7G8H9JKMNPQR', BOOTED);
    await new Promise((resolve) => setTimeout(resolve, 100));
    service.touch(BOOTED);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await stats(service)).streams).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await stats(service)).streams).toEqual([]);
  });

  it('helper 崩溃：在途请求以 sim_helper_unavailable 失败，有人看时重启 helper 并重新起流', async () => {
    const { service, warnings } = setup();
    const { socket } = await subscribe(service);
    await until(() => socket.sent.length >= 2);
    const crashed = await service.helperCommand('crash', {}).catch((error) => error);
    expect(crashed).toMatchObject({ code: 'sim_helper_unavailable' });
    // 新 helper 的流从配置与关键帧开始。
    await until(() => socket.sent.length >= 4, 5000);
    expect(socket.frames().slice(2)).toEqual([
      { kind: 0, text: 'avcC' },
      { kind: 1, text: 'key-0' },
    ]);
    expect(socket.closed).toBeUndefined();
    expect(warnings).toContain('ios simulator helper exited');
  });

  it('流意外结束时有人看就重新起流', async () => {
    const { service } = setup();
    const { socket } = await subscribe(service);
    const streamId = (await stats(service)).streams[0] as number;
    await service.helperCommand('end_stream', { streamId });
    await until(() => socket.sent.length >= 4, 5000);
    expect((await stats(service)).counts.stream_start).toBe(2);
  });

  it('helper 不报 ready 时请求以 sim_helper_unavailable 失败', async () => {
    const { service } = setup({}, { FAKE_SIM_NO_READY: '1' });
    // 等 ready 的上限是 15 秒，这里只看它在等：helper 进程起来了但请求还没回。
    const pending = service.describe(BOOTED).catch((error) => error);
    const race = await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
    ]);
    expect(race).toBe('waiting');
    await service.dispose();
    expect(await pending).toBeInstanceOf(SimulatorError);
  });

  it('截图：base64 或写到给定路径；录像写进输出目录', async () => {
    const { service, dir } = setup();
    const shot = await service.screenshot({ udid: BOOTED });
    expect(shot).toMatchObject({ mimeType: 'image/png', width: 402, height: 874 });
    expect(shot.data?.length).toBeGreaterThan(10);
    const path = join(dir, 'shot.png');
    const saved = await service.screenshot({ udid: BOOTED, path, scale: 3 });
    expect(saved).toEqual({ path, mimeType: 'image/png', width: 1206, height: 2622 });
    expect(readFileSync(path).subarray(1, 4).toString()).toBe('PNG');
    const recordingId = await service.recordStart(BOOTED);
    expect(recordingId).toMatch(/^rec_/);
    await expect(service.recordStart(BOOTED)).rejects.toMatchObject({
      code: 'sim_invalid_argument',
    });
    const stopped = await service.recordStop(recordingId);
    expect(stopped.durationMs).toBe(1234);
    expect(stopped.path.startsWith(join(dir, 'simulator', 'output'))).toBe(true);
    expect(existsSync(stopped.path)).toBe(true);
  });

  it('旋转：结果带新方向，发 simulator.orientation 一次，屏幕尺寸重新读', async () => {
    const { service } = setup();
    const notices: unknown[] = [];
    service.watch((notice) => notices.push(notice));
    await service.describe(BOOTED);
    expect(await service.input(BOOTED, { type: 'rotate', direction: 'right' })).toEqual({
      orientation: 'landscapeRight',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(notices).toEqual([
      {
        method: 'simulator.orientation',
        params: { udid: BOOTED, orientation: 'landscapeRight' },
      },
    ]);
    await service.describe(BOOTED);
    expect((await stats(service)).counts.describe_device).toBe(2);
  });

  it('attachedBy 与 simulator.changed、simulator.show；attach 没启动的设备先启动', async () => {
    const { service, simctl } = setup();
    const notices: Array<{ method: string; params: unknown }> = [];
    const shows: unknown[] = [];
    service.watch((notice) => notices.push(notice));
    service.watchShow((show) => shows.push(show));
    await service.list();
    const session = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR';
    await service.agentAttach(session, SHUT);
    expect(simctl.calls.some((call) => call[0] === 'boot' && call[1] === SHUT)).toBe(true);
    expect(shows).toEqual([{ udid: SHUT, sessionId: session }]);
    const devices = (await service.list()).devices;
    expect(devices.find((device) => device.udid === SHUT)).toMatchObject({
      state: 'booted',
      attachedBy: [session],
    });
    expect(notices.at(-1)?.method).toBe('simulator.changed');
    service.removeSessions([session]);
    expect((await service.list()).devices.every((device) => device.attachedBy.length === 0)).toBe(
      true,
    );
  });
});
