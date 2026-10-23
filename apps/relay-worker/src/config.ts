import { RELAY_ACCEPT_TIMEOUT_MS, RELAY_REGISTER_TIMEOUT_MS } from '@wevir/protocol';
import type { Control } from './control.js';
import type { Pipe } from './pipe.js';
import type { Route } from './route.js';

/** Worker 的绑定（wrangler.jsonc）。限制都是字符串变量，省略时用与 apps/relay 相同的默认值。 */
export interface Env {
  ROUTES: DurableObjectNamespace<Route>;
  CONTROLS: DurableObjectNamespace<Control>;
  PIPES: DurableObjectNamespace<Pipe>;
  /** 每个来源地址每分钟能发起的 WebSocket 升级（Workers 的 Rate Limiting 绑定，按 Cloudflare 机房计）。省略时不限。 */
  CONNECT_LIMITER?: RateLimit;
  /** 来源标记的 HMAC 密钥（`wrangler secret put SOURCE_TAG_KEY`）。省略时每个 isolate 随机一个。 */
  SOURCE_TAG_KEY?: string;
  WEVIR_RELAY_LOG_LEVEL?: string;
  WEVIR_RELAY_MAX_CONNECTIONS_PER_ROUTE?: string;
  WEVIR_RELAY_MAX_QUEUED_MESSAGES?: string;
  WEVIR_RELAY_MAX_QUEUED_BYTES?: string;
  WEVIR_RELAY_ACCEPT_TIMEOUT_MS?: string;
  WEVIR_RELAY_REGISTER_TIMEOUT_MS?: string;
}

/** 中继的限制（apps/relay 的 `RelayLimits` 里在 Workers 上做得到的那几项）。 */
export interface WorkerLimits {
  maxConnectionsPerRoute: number;
  maxQueuedMessages: number;
  maxQueuedBytes: number;
  acceptTimeoutMs: number;
  registerTimeoutMs: number;
}

/**
 * 一个路由上同时的设备连接的上限。连接 ID 记在控制连接的 WebSocket 附件里（休眠后还在），附件最多 2 KiB，一个 ID 22 个字符，
 * 64 条放得下。
 */
export const MAX_CONNECTIONS_PER_ROUTE_CAP = 64;

export function limitsOf(env: Env): WorkerLimits {
  return {
    maxConnectionsPerRoute: integer(
      env.WEVIR_RELAY_MAX_CONNECTIONS_PER_ROUTE,
      32,
      MAX_CONNECTIONS_PER_ROUTE_CAP,
    ),
    maxQueuedMessages: integer(env.WEVIR_RELAY_MAX_QUEUED_MESSAGES, 8),
    maxQueuedBytes: integer(env.WEVIR_RELAY_MAX_QUEUED_BYTES, 256 * 1024),
    acceptTimeoutMs: integer(env.WEVIR_RELAY_ACCEPT_TIMEOUT_MS, RELAY_ACCEPT_TIMEOUT_MS),
    registerTimeoutMs: integer(env.WEVIR_RELAY_REGISTER_TIMEOUT_MS, RELAY_REGISTER_TIMEOUT_MS),
  };
}

/** 不合法的值用默认值（Worker 没有启动时报错退出的地方）。 */
function integer(raw: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? Math.min(value, max) : fallback;
}
