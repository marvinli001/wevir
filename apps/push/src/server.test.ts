// 推送网关的单测：真实的 HTTP 服务、假的 APNs（明文 HTTP/2）与 FCM。Host 是这里用 Ed25519 签名的小客户端，手机只调 `verify`
// 并从假 APNs / FCM 收到的推送里取验证码。

import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PUSH_GATEWAY_PATHS,
  PUSH_SIGNATURE_HEADER,
  type PushPlatform,
  pushSignatureMessage,
} from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteBindingStore } from './bindings.js';
import { loadConfig } from './config.js';
import type { PushLimits } from './limits.js';
import { createLogger } from './log.js';
import { PushGatewayServer } from './server.js';
import {
  type FakeApns,
  type FakeFcm,
  startFakeApns,
  startFakeFcm,
  testApnsKey,
} from './testing.js';
import { ApnsClient, FcmClient, loadPrivateKey } from './upstream.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const APNS_TOKEN = 'a1b2c3d4'.repeat(8);
const FCM_TOKEN = 'cZ1x-Y2w:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8OvPVGJ-hQMRKRrZuJAEcl7B338';
const PAYLOAD = 'AQAAAZWm9yAAc2VjcmV0LWNpcGhlcnRleHQtdGhhdC1tdXN0LW5vdC1iZS1sb2dnZWQ';

interface Route {
  readonly routeId: string;
  readonly key: KeyObject;
}

function newRoute(): Route {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { routeId: publicKey.export({ format: 'jwk' }).x as string, key: privateKey };
}

let nonceCounter = 0;
function nonce(): string {
  nonceCounter += 1;
  return Buffer.from(`nonce-${nonceCounter}`.padEnd(16, '.')).toString('base64url');
}

async function start(
  options: {
    apns?: boolean;
    fcm?: boolean;
    limits?: Partial<PushLimits>;
    now?: () => number;
    store?: string;
  } = {},
) {
  const logs: string[] = [];
  const apnsKey = testApnsKey();
  let apns: FakeApns | undefined;
  let fcm: FakeFcm | undefined;
  if (options.apns !== false) {
    apns = await startFakeApns(apnsKey.publicPem);
    cleanups.push(() => apns?.close());
  }
  if (options.fcm === true) {
    fcm = await startFakeFcm();
    cleanups.push(() => fcm?.close());
  }
  const gateway = new PushGatewayServer({
    ...(apns !== undefined && {
      apns: new ApnsClient({
        key: apnsKey.pem,
        keyId: 'KEY1234567',
        teamId: 'TEAM123456',
        topic: 'si.wevir.mobile',
        productionUrl: apns.url,
        sandboxUrl: apns.url,
      }),
    }),
    ...(fcm !== undefined && {
      fcm: new FcmClient({ credentials: fcm.credentials, baseUrl: fcm.url }),
    }),
    ...(options.store !== undefined && { bindings: new SqliteBindingStore(options.store) }),
    ...(options.limits !== undefined && { limits: options.limits }),
    ...(options.now !== undefined && { now: options.now }),
    logger: createLogger('debug', (line) => logs.push(line)),
  });
  const port = await gateway.listen(0, '127.0.0.1');
  cleanups.push(() => gateway.close());
  const url = `http://127.0.0.1:${port}`;

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  /** Host 的签名请求：`tamper` 在签名之后改请求体。 */
  function signed(
    route: Route,
    path: string,
    fields: Record<string, unknown>,
    options: { tamper?: (body: string) => string; at?: number; nonce?: string } = {},
  ) {
    const text = JSON.stringify({
      routeId: route.routeId,
      timestamp: options.at ?? Date.now(),
      nonce: options.nonce ?? nonce(),
      ...fields,
    });
    const signature = sign(null, pushSignatureMessage(path, Buffer.from(text)), route.key);
    return post(path, options.tamper?.(text) ?? text, {
      [PUSH_SIGNATURE_HEADER]: signature.toString('base64url'),
    });
  }

  /** 手机要验证码，从假 APNs / FCM 收到的那条推送里取出来。 */
  async function verify(route: Route, platform: PushPlatform, token: string) {
    const before = platform === 'fcm' ? (fcm?.requests.length ?? 0) : (apns?.requests.length ?? 0);
    const response = await post(PUSH_GATEWAY_PATHS.verify, {
      routeId: route.routeId,
      platform,
      token,
    });
    if (response.status !== 202) return { response, code: undefined };
    const request = platform === 'fcm' ? fcm?.requests[before] : apns?.requests[before];
    const body = request?.body as {
      wevir?: string;
      code?: string;
      message?: { data?: { wevir?: string; code?: string } };
    };
    const data = platform === 'fcm' ? body.message?.data : body;
    expect(data?.wevir).toBe('verify');
    return { response, code: data?.code };
  }

  async function bind(route: Route, platform: PushPlatform, token: string) {
    const { code } = await verify(route, platform, token);
    return signed(route, PUSH_GATEWAY_PATHS.bind, { platform, token, code });
  }

  function send(route: Route, platform: PushPlatform, token: string, extra: object = {}) {
    return signed(route, PUSH_GATEWAY_PATHS.send, {
      platform,
      token,
      payload: PAYLOAD,
      collapseKey: 'abc_DEF-0123456789abcd',
      expiresAt: Date.now() + 60_000,
      ...extra,
    });
  }

  return { gateway, url, logs, apns, fcm, post, signed, verify, bind, send };
}

describe('绑定与转发（APNs）', () => {
  it('验证码经推送给手机，Host 带着它绑定，之后推送原样转给 APNs', async () => {
    const { apns, bind, send, gateway } = await start();
    const route = newRoute();
    const bound = await bind(route, 'apns', APNS_TOKEN);
    expect(bound).toEqual({ status: 200, body: {} });
    expect(gateway.stats().bindings).toBe(1);

    const verifyRequest = apns?.requests[0];
    expect(verifyRequest?.path).toBe(`/3/device/${APNS_TOKEN}`);
    expect(verifyRequest?.headers['apns-push-type']).toBe('background');
    expect(verifyRequest?.headers['apns-priority']).toBe('5');
    expect(verifyRequest?.headers['apns-topic']).toBe('si.wevir.mobile');

    expect(await send(route, 'apns', APNS_TOKEN)).toEqual({ status: 200, body: {} });
    const pushed = apns?.requests[1];
    expect(pushed?.headers['apns-push-type']).toBe('alert');
    expect(pushed?.headers['apns-priority']).toBe('10');
    expect(pushed?.headers['apns-collapse-id']).toBe('abc_DEF-0123456789abcd');
    expect(Number(pushed?.headers['apns-expiration'])).toBeGreaterThan(Date.now() / 1000);
    expect(pushed?.body).toEqual({
      aps: {
        alert: { 'title-loc-key': 'WEVIR_PUSH_TITLE', 'loc-key': 'WEVIR_PUSH_BODY' },
        'mutable-content': 1,
        sound: 'default',
      },
      wevir: 'push',
      p: PAYLOAD,
    });
    expect(apns?.verifiedJwts).toBe(2);
  });

  it('开发环境的令牌走 sandbox 地址', async () => {
    const { bind, send } = await start();
    const route = newRoute();
    expect((await bind(route, 'apns_sandbox', APNS_TOKEN)).status).toBe(200);
    expect((await send(route, 'apns_sandbox', APNS_TOKEN)).status).toBe(200);
    // 同一令牌按正式环境没有绑定。
    expect((await send(route, 'apns', APNS_TOKEN)).body).toMatchObject({
      error: { code: 'not_bound' },
    });
  });

  it('没绑定的令牌、别的电脑绑定的令牌都推不了', async () => {
    const { bind, send } = await start();
    const mine = newRoute();
    const other = newRoute();
    expect((await send(mine, 'apns', APNS_TOKEN)).status).toBe(404);
    expect((await bind(mine, 'apns', APNS_TOKEN)).status).toBe(200);
    const stolen = await send(other, 'apns', APNS_TOKEN);
    expect(stolen).toEqual({
      status: 404,
      body: { error: { code: 'not_bound', message: expect.any(String) } },
    });
  });

  it('验证码不对、过期或用过都绑不上；别的电脑拿到验证码也不行', async () => {
    let now = Date.now();
    const { verify, signed } = await start({ now: () => now });
    const route = newRoute();
    const other = newRoute();
    const { code } = await verify(route, 'apns', APNS_TOKEN);
    const bindWith = (r: Route, value: string | undefined) =>
      signed(
        r,
        PUSH_GATEWAY_PATHS.bind,
        { platform: 'apns', token: APNS_TOKEN, code: value },
        { at: now },
      );
    expect((await bindWith(route, 'AAAAAAAAAAAAAAAAAAAAAA')).status).toBe(403);
    expect((await bindWith(other, code)).body).toMatchObject({ error: { code: 'bad_code' } });
    expect((await bindWith(route, code)).status).toBe(200);
    expect((await bindWith(route, code)).status).toBe(403);

    const second = await verify(route, 'apns', `${APNS_TOKEN}ff`);
    now += 11 * 60_000;
    const late = await signed(
      route,
      PUSH_GATEWAY_PATHS.bind,
      { platform: 'apns', token: `${APNS_TOKEN}ff`, code: second.code },
      { at: now },
    );
    expect(late.body).toMatchObject({ error: { code: 'bad_code' } });
  });

  it('同一个验证码试错五次就作废', async () => {
    const { verify, signed } = await start();
    const route = newRoute();
    const { code } = await verify(route, 'apns', APNS_TOKEN);
    for (let i = 0; i < 5; i++) {
      const wrong = await signed(route, PUSH_GATEWAY_PATHS.bind, {
        platform: 'apns',
        token: APNS_TOKEN,
        code: `${'B'.repeat(21)}${i}`,
      });
      expect(wrong.status).toBe(403);
    }
    const right = await signed(route, PUSH_GATEWAY_PATHS.bind, {
      platform: 'apns',
      token: APNS_TOKEN,
      code,
    });
    expect(right.status).toBe(403);
  });

  it('解绑后不再推送', async () => {
    const { bind, send, signed } = await start();
    const route = newRoute();
    await bind(route, 'apns', APNS_TOKEN);
    const unbound = await signed(route, PUSH_GATEWAY_PATHS.unbind, {
      platform: 'apns',
      token: APNS_TOKEN,
    });
    expect(unbound.status).toBe(200);
    expect((await send(route, 'apns', APNS_TOKEN)).status).toBe(404);
  });

  it('APNs 说令牌失效时回 unregistered 并删掉绑定', async () => {
    const { apns, bind, send, gateway } = await start();
    const route = newRoute();
    await bind(route, 'apns', APNS_TOKEN);
    apns?.respond(() => ({ status: 410, body: { reason: 'Unregistered' } }));
    expect((await send(route, 'apns', APNS_TOKEN)).body).toMatchObject({
      error: { code: 'unregistered' },
    });
    expect(gateway.stats().bindings).toBe(0);
    apns?.respond(() => undefined);
    expect((await send(route, 'apns', APNS_TOKEN)).status).toBe(404);
  });

  it('APNs 出错是 upstream_failed，限速是 rate_limited，绑定留着', async () => {
    const { apns, bind, send, gateway } = await start();
    const route = newRoute();
    await bind(route, 'apns', APNS_TOKEN);
    apns?.respond(() => ({ status: 500, body: { reason: 'InternalServerError' } }));
    expect((await send(route, 'apns', APNS_TOKEN)).status).toBe(502);
    apns?.respond(() => ({ status: 429, body: { reason: 'TooManyRequests' } }));
    expect((await send(route, 'apns', APNS_TOKEN)).status).toBe(429);
    expect(gateway.stats().bindings).toBe(1);
  });

  it('没配这个平台时 platform_unavailable', async () => {
    const { verify } = await start({ apns: false });
    const { response } = await verify(newRoute(), 'apns', APNS_TOKEN);
    expect(response).toMatchObject({
      status: 503,
      body: { error: { code: 'platform_unavailable' } },
    });
  });
});

describe('FCM', () => {
  it('data 消息带验证码与载荷，访问令牌只换一次', async () => {
    const { fcm, bind, send } = await start({ apns: false, fcm: true });
    const route = newRoute();
    expect((await bind(route, 'fcm', FCM_TOKEN)).status).toBe(200);
    expect((await send(route, 'fcm', FCM_TOKEN)).status).toBe(200);
    expect(fcm?.tokenRequests).toBe(1);
    const pushed = fcm?.requests[1];
    expect(pushed?.path).toBe('/v1/projects/wevir-test/messages:send');
    expect(pushed?.body).toEqual({
      message: {
        token: FCM_TOKEN,
        data: { wevir: 'push', p: PAYLOAD },
        android: {
          priority: 'HIGH',
          ttl: expect.stringMatching(/^\d+s$/),
          collapse_key: 'abc_DEF-0123456789abcd',
        },
      },
    });
  });

  it('UNREGISTERED 删掉绑定', async () => {
    const { fcm, bind, send, gateway } = await start({ apns: false, fcm: true });
    const route = newRoute();
    await bind(route, 'fcm', FCM_TOKEN);
    fcm?.respond(() => ({
      status: 404,
      body: {
        error: {
          status: 'NOT_FOUND',
          details: [
            {
              '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
              errorCode: 'UNREGISTERED',
            },
          ],
        },
      },
    }));
    expect((await send(route, 'fcm', FCM_TOKEN)).status).toBe(410);
    expect(gateway.stats().bindings).toBe(0);
  });
});

describe('签名与重放', () => {
  it('签名不对、请求体被改、没有签名都是 bad_signature', async () => {
    const { bind, signed, post } = await start();
    const route = newRoute();
    await bind(route, 'apns', APNS_TOKEN);
    const forged = await signed(
      route,
      PUSH_GATEWAY_PATHS.send,
      { platform: 'apns', token: APNS_TOKEN, payload: PAYLOAD, expiresAt: Date.now() + 60_000 },
      { tamper: (body) => body.replace(PAYLOAD, `${PAYLOAD}x`) },
    );
    expect(forged.body).toMatchObject({ error: { code: 'bad_signature' } });
    const unsigned = await post(PUSH_GATEWAY_PATHS.send, {
      routeId: route.routeId,
      timestamp: Date.now(),
      nonce: nonce(),
      platform: 'apns',
      token: APNS_TOKEN,
      payload: PAYLOAD,
      expiresAt: Date.now() + 60_000,
    });
    expect(unsigned.status).toBe(401);
  });

  it('签给 bind 的请求不能当 send 用', async () => {
    const { bind, post } = await start();
    const route = newRoute();
    await bind(route, 'apns', APNS_TOKEN);
    const text = JSON.stringify({
      routeId: route.routeId,
      timestamp: Date.now(),
      nonce: nonce(),
      platform: 'apns',
      token: APNS_TOKEN,
      payload: PAYLOAD,
      expiresAt: Date.now() + 60_000,
    });
    const signature = sign(
      null,
      pushSignatureMessage(PUSH_GATEWAY_PATHS.bind, Buffer.from(text)),
      route.key,
    );
    const response = await post(PUSH_GATEWAY_PATHS.send, text, {
      [PUSH_SIGNATURE_HEADER]: signature.toString('base64url'),
    });
    expect(response.status).toBe(401);
  });

  it('时间戳偏差超过五分钟、随机数重用都是 stale_request', async () => {
    const { bind, send } = await start();
    const route = newRoute();
    await bind(route, 'apns', APNS_TOKEN);
    const old = await send(route, 'apns', APNS_TOKEN, { timestamp: Date.now() - 6 * 60_000 });
    expect(old.body).toMatchObject({ error: { code: 'stale_request' } });
    const fixed = nonce();
    expect((await send(route, 'apns', APNS_TOKEN, { nonce: fixed })).status).toBe(200);
    expect((await send(route, 'apns', APNS_TOKEN, { nonce: fixed })).body).toMatchObject({
      error: { code: 'stale_request' },
    });
  });

  it('过期时间在过去或超过一天的推送不收', async () => {
    const { bind, send } = await start();
    const route = newRoute();
    await bind(route, 'apns', APNS_TOKEN);
    expect((await send(route, 'apns', APNS_TOKEN, { expiresAt: Date.now() - 1 })).status).toBe(400);
    expect(
      (await send(route, 'apns', APNS_TOKEN, { expiresAt: Date.now() + 25 * 60 * 60_000 })).status,
    ).toBe(400);
  });

  it('请求体不合 schema 或太大是 bad_request', async () => {
    const { post } = await start();
    expect((await post(PUSH_GATEWAY_PATHS.verify, 'not json')).status).toBe(400);
    expect((await post(PUSH_GATEWAY_PATHS.verify, { platform: 'apns' })).status).toBe(400);
    const huge = await fetch(`${(await start()).url}${PUSH_GATEWAY_PATHS.verify}`, {
      method: 'POST',
      body: 'x'.repeat(9000),
    }).catch(() => undefined);
    expect(huge === undefined || huge.status === 400).toBe(true);
  });
});

describe('限制', () => {
  it('按令牌限推送，按路由限推送', async () => {
    const { bind, send } = await start({
      limits: { sendsPerHourPerToken: 2, sendsPerHourPerRoute: 4 },
    });
    const route = newRoute();
    await bind(route, 'apns', APNS_TOKEN);
    await bind(route, 'apns', `${APNS_TOKEN}ee`);
    expect((await send(route, 'apns', APNS_TOKEN)).status).toBe(200);
    expect((await send(route, 'apns', APNS_TOKEN)).status).toBe(200);
    expect((await send(route, 'apns', APNS_TOKEN)).body).toMatchObject({
      error: { code: 'rate_limited' },
    });
    expect((await send(route, 'apns', `${APNS_TOKEN}ee`)).status).toBe(200);
    // 路由的 4 次用完了（被令牌拦下的那次也算）。
    expect((await send(route, 'apns', `${APNS_TOKEN}ee`)).status).toBe(429);
  });

  it('按令牌限验证码，按路由限绑定数', async () => {
    const { verify, bind } = await start({
      limits: { verifiesPerHourPerToken: 2, maxBindingsPerRoute: 1 },
    });
    const route = newRoute();
    expect((await verify(route, 'apns', APNS_TOKEN)).response.status).toBe(202);
    expect((await bind(route, 'apns', APNS_TOKEN)).status).toBe(200);
    expect((await verify(route, 'apns', APNS_TOKEN)).response.status).toBe(429);
    const second = await bind(route, 'apns', `${APNS_TOKEN}ee`);
    expect(second.body).toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('按来源限请求频率', async () => {
    const { post } = await start({ limits: { requestsPerMinutePerSource: 2 } });
    await post(PUSH_GATEWAY_PATHS.verify, {});
    await post(PUSH_GATEWAY_PATHS.verify, {});
    expect((await post(PUSH_GATEWAY_PATHS.verify, {})).status).toBe(429);
  });
});

describe('日志与存储', () => {
  it('日志里没有令牌、载荷、验证码与路由 ID', async () => {
    const { logs, apns, bind, send } = await start({ fcm: true });
    const route = newRoute();
    await bind(route, 'apns', APNS_TOKEN);
    await send(route, 'apns', APNS_TOKEN);
    const code = (apns?.requests[0]?.body as { code: string } | undefined)?.code ?? 'missing';
    await send(route, 'apns', APNS_TOKEN, { payload: 'x', token: FCM_TOKEN });
    const text = logs.join('\n');
    expect(logs.length).toBeGreaterThan(3);
    for (const secret of [APNS_TOKEN, FCM_TOKEN, PAYLOAD, code, route.routeId, '127.0.0.1']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('push sent');
  });

  it('绑定存在 SQLite 里，重启后还在；存的只是哈希', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wevir-push-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const route = newRoute();
    const first = await start({ store: dir });
    await first.bind(route, 'apns', APNS_TOKEN);
    await first.gateway.close();
    const second = await start({ store: dir });
    expect(second.gateway.stats().bindings).toBe(1);
    expect((await second.send(route, 'apns', APNS_TOKEN)).status).toBe(200);
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(join(dir, 'bindings.db'));
    expect(raw.includes(Buffer.from(APNS_TOKEN))).toBe(false);
    expect(raw.includes(Buffer.from(route.routeId))).toBe(false);
  });

  it('健康检查', async () => {
    const { url } = await start();
    const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      bindings: 0,
      apns: true,
      fcm: false,
    });
    expect((await fetch(`${url}/v1/send`)).status).toBe(404);
  });
});

describe('loadConfig', () => {
  it('凭据从文件或环境变量读，缺一半时报错且不带内容', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wevir-push-config-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const { pem } = testApnsKey();
    writeFileSync(join(dir, 'AuthKey.p8'), pem);
    writeFileSync(
      join(dir, 'fcm.json'),
      JSON.stringify({ project_id: 'p', client_email: 'e@x', private_key: 'PRIVATE-KEY-CONTENT' }),
    );
    const config = loadConfig({
      WEVIR_PUSH_APNS_KEY_FILE: join(dir, 'AuthKey.p8'),
      WEVIR_PUSH_APNS_KEY_ID: 'KEY',
      WEVIR_PUSH_APNS_TEAM_ID: 'TEAM',
      WEVIR_PUSH_APNS_TOPIC: 'si.wevir.mobile',
      WEVIR_PUSH_FCM_CREDENTIALS_FILE: join(dir, 'fcm.json'),
      WEVIR_PUSH_SENDS_PER_HOUR_PER_TOKEN: '10',
    });
    expect(config.apns?.key).toBe(pem);
    expect(config.fcm?.credentials.project_id).toBe('p');
    expect(config.limits.sendsPerHourPerToken).toBe(10);
    expect(config.dataDir).toBeUndefined();

    expect(loadConfig({}).apns).toBeUndefined();
    let message = '';
    try {
      loadConfig({ WEVIR_PUSH_APNS_KEY: pem });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/WEVIR_PUSH_APNS_KEY_ID/);
    expect(message).not.toContain('PRIVATE KEY');
    expect(() => loadConfig({ WEVIR_PUSH_FCM_CREDENTIALS: '{"project_id":"p"}' })).toThrow(
      /client_email/,
    );
    expect(() => new ApnsClient({ key: 'garbage', keyId: 'k', teamId: 't', topic: 'x' })).toThrow(
      'the APNs key is not a valid PEM private key',
    );
  });
});

describe('loadPrivateKey', () => {
  it('还原平台变量编辑器压掉或转义了换行的 PEM', () => {
    const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const body = pem.split('\n').filter((line) => line !== '' && !line.startsWith('-----'));
    const variants = [
      pem,
      pem.replace(/\n/g, ' '),
      pem.replace(/\n/g, ''),
      pem.replace(/\n/g, '\\n'),
      body.join(''),
      `  ${pem.replace(/\n/g, '\r\n')}  `,
    ];
    for (const value of variants) {
      expect(loadPrivateKey(value, 'the APNs key').asymmetricKeyType).toBe('ec');
    }
    expect(() => loadPrivateKey(pem.slice(0, 80), 'the APNs key')).toThrow(
      'the APNs key is not a valid PEM private key',
    );
  });
});
