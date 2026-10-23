// Wevir 的中继跑在 Cloudflare Workers + Durable Objects 上（README.md）：线路协议与 apps/relay 相同，Host 与客户端不用改。Worker
// 只做升级前的事（健康检查、按来源限速、校验参数、找到要去的 Durable Object），WebSocket 都由 Durable Object 用休眠 API 接受：
//   - `/v1/host` → 新的 Control（每条控制连接一个），注册成功后登记在路由 ID 的 Route 上；
//   - 设备路径 `?route=` → 问 Route 现在是哪条控制连接，生成连接 ID，交给以它命名的 Pipe；
//   - `/v1/accept?id=` → 以连接 ID 命名的 Pipe。

import {
  PublicKeySchema,
  RELAY_ACCEPT_PARAM,
  RELAY_CONNECTION_ID_BYTES,
  RELAY_PATHS,
  RELAY_ROUTE_PARAM,
  REMOTE_PATHS,
  RelayConnectionIdSchema,
} from '@wevir/protocol';
import type { Env } from './config.js';
import { base64url, randomBase64url, status } from './util.js';

export { Control } from './control.js';
export { Pipe } from './pipe.js';
export { Route } from './route.js';

const DEVICE_PATHS = new Set<string>(Object.values(REMOTE_PATHS));

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      if (path === RELAY_PATHS.health && (request.method === 'GET' || request.method === 'HEAD')) {
        // 没有全局的计数：路由与连接分散在各自的 Durable Object 里。
        return new Response(request.method === 'HEAD' ? null : JSON.stringify({ status: 'ok' }), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
      return status(404);
    }

    // 与 apps/relay 一样，每次升级都算进来源的发起频率，路径不对的也算。不检查 Origin：网页客户端只能经中继。
    const source = request.headers.get('CF-Connecting-IP') ?? '';
    if (env.CONNECT_LIMITER !== undefined) {
      const { success } = await env.CONNECT_LIMITER.limit({ key: source });
      if (!success) return status(429);
    }

    if (path === RELAY_PATHS.host) {
      return env.CONTROLS.get(env.CONTROLS.newUniqueId()).fetch(request);
    }
    if (path === RELAY_PATHS.accept) {
      const id = url.searchParams.get(RELAY_ACCEPT_PARAM) ?? '';
      if (!RelayConnectionIdSchema.safeParse(id).success) return status(404);
      const inner = new URL('https://pipe/accept');
      inner.searchParams.set('id', id);
      return env.PIPES.get(env.PIPES.idFromName(id)).fetch(new Request(inner, request));
    }
    if (DEVICE_PATHS.has(path)) {
      const routeId = url.searchParams.get(RELAY_ROUTE_PARAM) ?? '';
      if (!PublicKeySchema.safeParse(routeId).success) return status(404);
      const control = await env.ROUTES.get(env.ROUTES.idFromName(routeId)).lookup();
      if (control === null) return status(404);
      const id = randomBase64url(RELAY_CONNECTION_ID_BYTES);
      const inner = new URL('https://pipe/device');
      inner.searchParams.set('id', id);
      inner.searchParams.set('control', control);
      inner.searchParams.set('path', path);
      inner.searchParams.set('source', await sourceTag(env, source));
      return env.PIPES.get(env.PIPES.idFromName(id)).fetch(new Request(inner, request));
    }
    return status(404);
  },
} satisfies ExportedHandler<Env>;

/** 没配 `SOURCE_TAG_KEY` 时每个 isolate 随机的密钥。 */
let isolateKey: Uint8Array<ArrayBuffer> | undefined;

/**
 * 来源地址的不透明标记（HMAC-SHA-256 的前 12 字节），Host 按它给握手限速，看不到 IP。密钥之外再混进 UTC 日期，同一地址的标记每天
 * 一换，不能长期关联；Host 的限速窗口最长 10 分钟，跨零点换一次不碍事。
 */
async function sourceTag(env: Env, source: string): Promise<string> {
  isolateKey ??= crypto.getRandomValues(new Uint8Array(32));
  const secret =
    env.SOURCE_TAG_KEY !== undefined && env.SOURCE_TAG_KEY !== ''
      ? new TextEncoder().encode(env.SOURCE_TAG_KEY)
      : isolateKey;
  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const day = new Date().toISOString().slice(0, 10);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${day}\n${source}`));
  return base64url(new Uint8Array(mac).subarray(0, 12));
}
