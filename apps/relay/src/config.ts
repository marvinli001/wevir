import { readFileSync } from 'node:fs';
import { DEFAULT_RELAY_LIMITS, type RelayLimits } from './limits.js';
import type { LogLevel } from './log.js';
import type { RelayServerOptions } from './server.js';

/** 中继进程的配置，全部来自环境变量（README.md 的“配置”）。 */
export interface RelayConfig {
  port: number;
  host: string;
  logLevel: LogLevel;
  trustProxy: boolean;
  tls: RelayServerOptions['tls'];
  limits: RelayLimits;
}

const LIMIT_ENV: Record<string, keyof RelayLimits> = {
  WEVIR_RELAY_MAX_ROUTES: 'maxRoutes',
  WEVIR_RELAY_MAX_CONNECTIONS: 'maxConnections',
  WEVIR_RELAY_MAX_CONNECTIONS_PER_ROUTE: 'maxConnectionsPerRoute',
  WEVIR_RELAY_MAX_CONNECTIONS_PER_SOURCE: 'maxConnectionsPerSource',
  WEVIR_RELAY_CONNECTS_PER_MINUTE: 'connectsPerMinutePerSource',
  WEVIR_RELAY_BYTES_PER_SECOND: 'bytesPerSecond',
  WEVIR_RELAY_BURST_BYTES: 'burstBytes',
};

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** 读环境变量；不合法时抛出，进程以非零码退出。 */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): RelayConfig {
  const port = integer(env, 'WEVIR_RELAY_PORT', 8080, 0, 65_535);
  const logLevel = (env.WEVIR_RELAY_LOG_LEVEL ?? 'info') as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`WEVIR_RELAY_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  }
  const limits: RelayLimits = { ...DEFAULT_RELAY_LIMITS };
  for (const [name, key] of Object.entries(LIMIT_ENV)) {
    limits[key] = integer(env, name, DEFAULT_RELAY_LIMITS[key], 1, Number.MAX_SAFE_INTEGER);
  }
  const cert = env.WEVIR_RELAY_TLS_CERT;
  const key = env.WEVIR_RELAY_TLS_KEY;
  if ((cert === undefined) !== (key === undefined)) {
    throw new Error('set both WEVIR_RELAY_TLS_CERT and WEVIR_RELAY_TLS_KEY, or neither');
  }
  return {
    port,
    host: env.WEVIR_RELAY_HOST ?? '0.0.0.0',
    logLevel,
    trustProxy: flag(env.WEVIR_RELAY_TRUST_PROXY),
    tls:
      cert !== undefined && key !== undefined
        ? { cert: readFileSync(cert), key: readFileSync(key) }
        : undefined,
    limits,
  };
}

function integer(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function flag(raw: string | undefined): boolean {
  return raw === '1' || raw?.toLowerCase() === 'true';
}
