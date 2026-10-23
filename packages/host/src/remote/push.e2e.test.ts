// 推送的端到端（0.112.0，ADR-0017 §6）：真实的 Host（EchoAdapter）、本地起的推送网关（apps/push）、假 APNs，与扮演手机的 Noise
// 测试客户端。配对时答“开推送” → 手机向网关要验证码、经隧道报令牌 → 电脑前没人时审批变成一条只有密文的 APNs 推送，手机用自己的私钥
// 解开 → 电脑前有人时不推 → 移除设备后网关解绑、不再推。

import { mkdirSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { derivePushKey, openPushMessage } from '@wevir/noise';
import {
  type ClientIdentity,
  DEFAULT_REMOTE_SETTINGS,
  PUSH_GATEWAY_PATHS,
  PushMessageSchema,
  parsePairingUri,
  type RemoteSettings,
} from '@wevir/protocol';
import { ApnsClient, createLogger as createPushLogger, PushGatewayServer } from '@wevir/push';
import { startFakeApns, testApnsKey } from '@wevir/push/testing';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from '../host-process.js';
import { createLogger } from '../logger.js';
import { TestRpcClient, useTempDir } from '../test-utils.js';
import { classifyAddress, type NetworkInterfaces } from './network.js';
import { newTestDevice, pairRemote } from './test-client.js';

const tempDir = useTempDir();
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const DESKTOP: ClientIdentity = { deviceId: 'mac', clientId: 'desktop', clientKind: 'desktop' };
const PHONE: ClientIdentity = { deviceId: 'phone', clientId: 'phone-app', clientKind: 'mobile' };
const TOKEN = '7c3f9e1a'.repeat(8);

const LOOPBACK: NetworkInterfaces = {
  lo0: [
    {
      address: '127.0.0.1',
      netmask: '255.0.0.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:00',
      internal: true,
      cidr: '127.0.0.1/8',
    },
  ],
};

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('推送端到端', () => {
  it('配对时打开推送 → 报令牌 → 没人在电脑前时审批推到手机、只有密文 → 有人时不推 → 移除后不推', async () => {
    // 假 APNs 与本地网关。
    const apnsKey = testApnsKey();
    const apns = await startFakeApns(apnsKey.publicPem);
    cleanups.push(() => apns.close());
    const gatewayLogs: string[] = [];
    const gateway = new PushGatewayServer({
      apns: new ApnsClient({
        key: apnsKey.pem,
        keyId: 'KEY1234567',
        teamId: 'TEAM123456',
        topic: 'si.wevir.mobile',
        productionUrl: apns.url,
        sandboxUrl: apns.url,
      }),
      logger: createPushLogger('debug', (line) => gatewayLogs.push(line)),
    });
    const gatewayPort = await gateway.listen(0, '127.0.0.1');
    cleanups.push(() => gateway.close());
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

    // Host：远程监听在回环上，推送指向本地网关，不合并。
    const home = join(realpathSync(tempDir()), 'home');
    const host = await startHost({
      adapter: new EchoAdapter({ stepDelayMs: 1 }),
      engine: 'echo',
      logger: createLogger({ level: 'error', mirror: () => {} }),
      home,
      remoteListener: {
        networkInterfaces: () => LOOPBACK,
        classifyAddress: (address, internal) =>
          address === '127.0.0.1' ? 'lan' : classifyAddress(address, internal),
        lookupMagicDnsName: async () => undefined,
        advertiser: { update: () => {}, shutdown: async () => {} },
        pollMs: 50,
      },
      push: { gatewayUrl, coalesceMs: 0 },
    });
    cleanups.push(() => host.shutdown());
    const { token } = JSON.parse(await readFile(join(home, 'run', 'host.json'), 'utf8')) as {
      token: string;
    };
    const desktop = await TestRpcClient.connect(host.url);
    cleanups.push(() => desktop.ws.terminate());
    expect((await desktop.hello(token, DESKTOP)).error).toBeUndefined();
    expect((await desktop.call('host.ping')).error).toBeUndefined();

    const port = await freePort();
    const current: RemoteSettings =
      (await desktop.request('settings.get')).settings.remote ?? DEFAULT_REMOTE_SETTINGS;
    await desktop.request('settings.update', {
      settings: {
        remote: { ...current, enabled: true, interfaces: { lan: true, tailscale: false }, port },
      },
    });
    await desktop.request('remote.status');
    await desktop.until(
      () => desktop.notifications('remote.changed').find((status) => status.listening),
      'listening',
    );

    // 配对，桌面允许并答“开推送”：设备与总开关都打开。
    const offer = await desktop.request('pairing.start');
    const payload = parsePairingUri(offer.uri);
    if (payload === null) throw new Error('bad pairing uri');
    const device = newTestDevice();
    const phone = await pairRemote({
      base: `ws://127.0.0.1:${port}`,
      host: { hostPublicKey: payload.hostPublicKey, routeId: payload.routeId },
      secret: new Uint8Array(Buffer.from(payload.secret, 'base64url')),
      device,
      name: 'iPhone',
      platform: 'ios',
    });
    cleanups.push(() => phone.ws.terminate());
    const hello = phone.client.hello('ignored', PHONE);
    const request = await desktop.until(
      () => desktop.notifications('pairing.request')[0],
      'pairing.request',
    );
    const { device: record } = await desktop.request('pairing.respond', {
      requestId: request.requestId,
      allow: true,
      push: true,
    });
    expect((await hello).error).toBeUndefined();
    expect(record.push).toEqual({ enabled: true, registered: false });
    expect((await desktop.request('settings.get')).settings.remote.push.enabled).toBe(true);

    // 手机：看自己的推送状态，向网关要验证码，从假 APNs 那里收到，经隧道报令牌。
    const state = await phone.client.request('push.get');
    expect(state).toEqual({
      enabled: true,
      registered: false,
      gatewayUrl,
      routeId: payload.routeId,
    });
    const verify = await fetch(`${state.gatewayUrl}${PUSH_GATEWAY_PATHS.verify}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ routeId: state.routeId, platform: 'apns', token: TOKEN }),
    });
    expect(verify.status).toBe(202);
    const code = (apns.requests[0]?.body as { code?: string } | undefined)?.code;
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const registered = await phone.client.request('push.register', {
      platform: 'apns',
      token: TOKEN,
      code,
    });
    expect(registered.registered).toBe(true);
    expect(gateway.stats().bindings).toBe(1);
    // 本机连接调不了 push.*。
    expect((await desktop.call('push.get')).error?.code).toBe(-32600);

    // 电脑前没人：审批变成一条推送。
    const workspaceDir = join(tempDir(), 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    const { workspace } = await desktop.request('workspace.add', { rootPath: workspaceDir });
    await desktop.request('provider.upsert', {
      id: 'deepseek-official',
      kind: 'deepseek-official',
      displayName: 'DeepSeek',
      models: [],
      defaultModelId: 'deepseek-chat',
    });
    const { session } = await desktop.request('session.create', {
      workspaceId: workspace.id,
      providerId: 'deepseek-official',
    });
    await desktop.request('session.rename', { sessionId: session.id, title: 'Quarterly numbers' });
    const sent = () => apns.requests.filter((entry) => entry.headers['apns-push-type'] === 'alert');
    const { subscriptionId } = await desktop.request('events.subscribe', {
      sessionId: session.id,
      sinceSeq: 0,
    });
    const approvals = () =>
      desktop.events(subscriptionId).filter((event) => event.type === 'approval.requested');
    const finished = () =>
      desktop.events(subscriptionId).filter((event) => event.type === 'turn.finished');
    /** 发一句让 echo 请求审批的话，等审批出现、允许它、等回合结束。 */
    const approveOnce = async (turn: number) => {
      await desktop.request('session.send', {
        sessionId: session.id,
        content: [{ type: 'text', text: 'please approve' }],
      });
      const requested = await desktop.until(() => approvals()[turn], `approval ${turn}`);
      if (requested.type !== 'approval.requested') throw new Error('unexpected event');
      return async () => {
        await desktop.request('approval.respond', {
          approvalId: requested.payload.approval.id,
          optionId: 'allow-once',
        });
        await desktop.until(() => finished()[turn], `turn ${turn} finished`);
      };
    };
    const allowFirst = await approveOnce(0);
    const pushed = await desktop.until(() => sent()[0], 'APNs alert push', 5000);
    const body = pushed.body as { aps: unknown; wevir: string; p: string };
    expect(Object.keys(body).sort()).toEqual(['aps', 'p', 'wevir']);
    expect(pushed.path).toBe(`/3/device/${TOKEN}`);
    // 网关与 APNs 只见到密文：标题、会话 ID 都不在请求里。
    const raw = JSON.stringify(pushed);
    expect(raw).not.toContain('Quarterly numbers');
    expect(raw).not.toContain(session.id);

    // 手机用自己的私钥与 Host 公钥解开。
    const hostPublicKey = new Uint8Array(Buffer.from(payload.hostPublicKey, 'base64url'));
    const key = derivePushKey({
      secretKey: device.keys.secretKey,
      publicKey: hostPublicKey,
      hostPublicKey,
      devicePublicKey: device.keys.publicKey,
    });
    const open = (entry: { body: unknown }) =>
      PushMessageSchema.parse(
        JSON.parse(
          new TextDecoder().decode(openPushMessage(key, (entry.body as { p: string }).p).plaintext),
        ),
      );
    expect(open(pushed)).toMatchObject({
      kind: 'approval',
      category: 'action',
      title: 'Quarterly numbers',
      sessionId: session.id,
    });
    const status = await desktop.request('remote.status');
    expect(status.push).toMatchObject({ state: 'ok', gatewayUrl, devices: 1 });
    // 没人在电脑前时回合结束：再推一条“完成”。
    await allowFirst();
    const completed = await desktop.until(() => sent()[1], 'completion push', 5000);
    expect(open(completed)).toMatchObject({ category: 'completion', sessionId: session.id });

    // 有人在电脑前：审批与完成都不推。
    await desktop.request('presence.update', { active: true });
    await (await approveOnce(1))();
    await delay(300);
    expect(sent()).toHaveLength(2);

    // 移除设备：网关解绑，没人在电脑前也不再推。
    await desktop.request('presence.update', { active: false });
    await desktop.request('device.revoke', { id: record.id });
    await desktop.until(() => (gateway.stats().bindings === 0 ? true : undefined), 'unbound');
    await (await approveOnce(2))();
    await delay(300);
    expect(sent()).toHaveLength(2);

    // 网关的日志里没有令牌、验证码、密文与路由 ID。
    const logs = gatewayLogs.join('\n');
    for (const secret of [TOKEN, code as string, body.p, payload.routeId]) {
      expect(logs).not.toContain(secret);
    }
    expect(logs).toContain('push sent');
    expect(logs).toContain('unbound');
  });
});
