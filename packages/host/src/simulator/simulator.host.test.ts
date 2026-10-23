// iOS 模拟器（0.122.0，Host 功能 `ios_simulator`）：startHost 组装出的 Host，helper 是假的（test-fixtures/fake-ios-simulator.mjs），
// simctl 是假的。经真实的 WebSocket 调 `simulator.*`、连 `/simulator/stream` 收帧、按权限拒绝；模型那一侧直接按 MCP 调 `/mcp`：
// 截图是图片内容项、不带 structuredContent，agent 的 attach 发 `simulator.show`，设置关掉后工具不列出。只在 macOS 上跑。

import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { ErrorCode, type Permission, type SessionId } from '@wevir/protocol';
import type { AppToolsEndpoint, EngineSession, SessionConfig } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startHost } from '../host-process.js';
import { createLogger } from '../logger.js';
import { TestRpcClient, useTempDir } from '../test-utils.js';
import { BOOTED, fakeHelperBin, fakeSimctl } from './test-helpers.js';

const mac = process.platform === 'darwin';
const tempDir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class ToolEcho extends EchoAdapter {
  readonly appTools = true;
  readonly endpoints = new Map<string, AppToolsEndpoint | undefined>();

  override async createSession(config: SessionConfig): Promise<EngineSession> {
    const session = await super.createSession(config);
    this.endpoints.set(session.engineSessionId, config.appTools);
    return session;
  }
}

const VIEWER: Permission[] = ['session.read', 'workspace.read'];

async function boot(options: { bin?: boolean } = {}) {
  const root = realpathSync(tempDir());
  const workspaceDir = join(root, 'project');
  mkdirSync(workspaceDir, { recursive: true });
  const home = join(root, 'home');
  const adapter = new ToolEcho({ stepDelayMs: 1 });
  const simctl = fakeSimctl();
  const host = await startHost({
    adapter,
    engine: 'echo',
    logger: createLogger({ level: 'error', mirror: () => {} }),
    home,
    iosSimulator: {
      bin: options.bin === false ? join(root, 'missing') : fakeHelperBin(root),
      sandbox: false,
      simctl: simctl.run,
    },
    testConnectionGrant: (client) =>
      client.clientId === 'viewer'
        ? { principal: { kind: 'device', deviceId: client.deviceId }, permissions: VIEWER }
        : undefined,
  });
  cleanups.push(() => host.shutdown());
  const token = (
    JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as { token: string }
  ).token;
  const connect = async (clientId = 'desk') => {
    const client = await TestRpcClient.connect(host.url);
    cleanups.push(() => client.ws.close());
    const hello = await client.hello(token, {
      deviceId: 'dev-1',
      clientId,
      clientKind: 'desktop',
    });
    expect(hello.error).toBeUndefined();
    return { client, features: hello.result.features as Record<string, boolean> };
  };
  const { client, features } = await connect();
  return { host, client, features, connect, adapter, simctl, workspaceDir };
}

/** 连上画面流，收前几帧。 */
function stream(url: string, count: number): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames: Buffer[] = [];
    ws.on('message', (data, isBinary) => {
      expect(isBinary).toBe(true);
      frames.push(data as Buffer);
      if (frames.length === count) {
        ws.close();
        resolve(frames);
      }
    });
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
}

describe.runIf(mac)('iOS 模拟器经 Host API', () => {
  it('没有 helper 时不声明功能，simulator.* 回 INVALID_PARAMS', async () => {
    const h = await boot({ bin: false });
    expect(h.features.ios_simulator).toBeUndefined();
    const frame = await h.client.call('simulator.list');
    expect(frame.error?.code).toBe(ErrorCode.INVALID_PARAMS);
  });

  it('列表、attach 与 /simulator/stream：令牌一次有效，帧是二进制，先配置后关键帧', async () => {
    const h = await boot();
    expect(h.features.ios_simulator).toBe(true);
    const list = await h.client.request('simulator.list');
    expect(list.devices.map((device: { udid: string }) => device.udid)).toContain(BOOTED);
    const attached = await h.client.request('simulator.attach', { udid: BOOTED });
    expect(attached.streamUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/simulator\/stream\?token=/);
    const frames = await stream(attached.streamUrl, 2);
    expect(frames.map((frame) => frame.readUInt8(0))).toEqual([0, 1]);
    expect(frames[0]?.subarray(13).toString()).toBe('avcC');
    // 用过的令牌与乱写的令牌都是 403。
    await expect(stream(attached.streamUrl, 1)).rejects.toThrow('HTTP 403');
    const base = attached.streamUrl.slice(0, attached.streamUrl.indexOf('?'));
    await expect(stream(`${base}?token=nope`, 1)).rejects.toThrow('HTTP 403');
    await expect(stream(base, 1)).rejects.toThrow('HTTP 403');
    expect(await h.client.request('simulator.detach', { udid: BOOTED })).toEqual({});
  });

  it('输入、截图、剪贴板；helper 的失败是 SIMULATOR_FAILED 带错误码', async () => {
    const h = await boot();
    // 调过 simulator.* 之后才收 simulator.orientation。
    await h.client.request('simulator.list');
    expect(
      await h.client.request('simulator.input', {
        udid: BOOTED,
        input: { type: 'rotate', direction: 'left' },
      }),
    ).toEqual({ orientation: 'landscapeLeft' });
    await h.client.until(
      () => h.client.notifications('simulator.orientation')[0],
      'simulator.orientation',
    );
    const shot = await h.client.request('simulator.screenshot', { udid: BOOTED });
    expect(shot).toMatchObject({ mimeType: 'image/png', width: 402, height: 874 });
    expect(await h.client.request('simulator.clipboard.get', { udid: BOOTED })).toEqual({
      text: 'from device',
    });
    const failed = await h.client.call('simulator.input', {
      udid: 'OFF',
      input: { type: 'tap', x: 1, y: 1 },
    });
    expect(failed.error?.code).toBe(ErrorCode.SIMULATOR_FAILED);
    expect(failed.error?.data).toEqual({ code: 'sim_not_booted' });
  });

  it('权限：只读的连接能列出与看画面，不能输入、启动或录像', async () => {
    const h = await boot();
    const { client: viewer } = await h.connect('viewer');
    expect((await viewer.request('simulator.list')).devices.length).toBeGreaterThan(0);
    expect((await viewer.request('simulator.attach', { udid: BOOTED })).token).toBeTruthy();
    for (const [method, params] of [
      ['simulator.input', { udid: BOOTED, input: { type: 'tap', x: 1, y: 1 } }],
      ['simulator.boot', { udid: BOOTED }],
      ['simulator.record.start', { udid: BOOTED }],
      ['simulator.clipboard.set', { udid: BOOTED, text: 'x' }],
    ] as const) {
      const frame = await viewer.call(method, params);
      expect(frame.error?.code, method).toBe(ErrorCode.DEVICE_FORBIDDEN);
    }
  });

  it('agent 的工具：attach 发 simulator.show，截图是图片内容项、不带 structuredContent；设置关掉后不列出', async () => {
    const h = await boot();
    const workspaceId = (await h.client.request('workspace.add', { rootPath: h.workspaceDir }))
      .workspace.id;
    await h.client.request('provider.upsert', {
      id: 'deepseek-official',
      kind: 'deepseek-official',
      displayName: 'DeepSeek',
      models: [],
      defaultModelId: 'deepseek-chat',
    });
    const { session } = await h.client.request('session.create', {
      workspaceId,
      providerId: 'deepseek-official',
    });
    const sessionId = session.id as SessionId;
    const endpoint = h.adapter.endpoints.get(session.engine.sessionId) as AppToolsEndpoint;
    const mcp = async (method: string, params: unknown = {}) => {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${endpoint.token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      // biome-ignore lint/suspicious/noExplicitAny: 读任意形状的 MCP 回复。
      return ((await response.json()) as Record<string, any>).result;
    };
    const names = async () =>
      ((await mcp('tools/list')).tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(await names()).toEqual(expect.arrayContaining(['simulator_control', 'simulator_build']));

    const attached = await mcp('tools/call', {
      name: 'simulator_control',
      arguments: { action: 'attach', device: 'iPhone 17 Pro' },
    });
    expect(attached.isError).toBeUndefined();
    expect(attached.content[0].text).toContain('402×874 points');
    await h.client.until(() => h.client.notifications('simulator.show')[0], 'simulator.show');
    expect(h.client.notifications('simulator.show')[0]).toEqual({ udid: BOOTED, sessionId });

    const shot = await mcp('tools/call', {
      name: 'simulator_control',
      arguments: { action: 'screenshot' },
    });
    expect(shot.structuredContent).toBeUndefined();
    expect(shot.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(shot.content[1].text).toContain('402×874 points');

    const tapped = await mcp('tools/call', {
      name: 'simulator_control',
      arguments: { action: 'tap', x: 100, y: 200 },
    });
    expect(tapped.content).toEqual([{ type: 'text', text: 'Done.' }]);
    const bad = await mcp('tools/call', {
      name: 'simulator_control',
      arguments: { action: 'press_key', key: 'f13' },
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/^sim_invalid_argument:/);

    await h.client.request('settings.update', { settings: { iosSimulator: false } });
    expect(await names()).not.toContain('simulator_control');
    const off = await mcp('tools/call', {
      name: 'simulator_control',
      arguments: { action: 'list' },
    });
    expect(off.isError).toBe(true);
  });
});
