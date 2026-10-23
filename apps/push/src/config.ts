import { readFileSync } from 'node:fs';
import { DEFAULT_PUSH_LIMITS, type PushLimits } from './limits.js';
import type { LogLevel } from './log.js';
import type { ApnsClientOptions, FcmCredentials } from './upstream.js';

/**
 * 网关进程的配置，全部来自环境变量（README.md 的“配置”）。APNs 与 FCM 的凭据只能从环境变量或挂载的文件读，从不进仓库、镜像或日志；
 * 这里的错误信息只提变量名，不带内容。
 */
export interface PushConfig {
  port: number;
  host: string;
  logLevel: LogLevel;
  trustProxy: boolean;
  tls: { cert: Buffer; key: Buffer } | undefined;
  /** 绑定存在这个目录的 `bindings.db`；省略时只在内存里。 */
  dataDir: string | undefined;
  apns: Omit<ApnsClientOptions, 'now' | 'timeoutMs'> | undefined;
  fcm: { credentials: FcmCredentials; baseUrl?: string } | undefined;
  limits: PushLimits;
}

const LIMIT_ENV: Record<string, keyof PushLimits> = {
  WEVIR_PUSH_SENDS_PER_HOUR_PER_ROUTE: 'sendsPerHourPerRoute',
  WEVIR_PUSH_SENDS_PER_HOUR_PER_TOKEN: 'sendsPerHourPerToken',
  WEVIR_PUSH_VERIFIES_PER_HOUR_PER_TOKEN: 'verifiesPerHourPerToken',
  WEVIR_PUSH_VERIFIES_PER_HOUR_PER_SOURCE: 'verifiesPerHourPerSource',
  WEVIR_PUSH_REQUESTS_PER_MINUTE_PER_SOURCE: 'requestsPerMinutePerSource',
  WEVIR_PUSH_MAX_BINDINGS_PER_ROUTE: 'maxBindingsPerRoute',
  WEVIR_PUSH_BINDS_PER_HOUR_PER_ROUTE: 'bindsPerHourPerRoute',
};

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

type Env = Readonly<Record<string, string | undefined>>;

/** 读环境变量；不合法时抛出，进程以非零码退出。 */
export function loadConfig(env: Env): PushConfig {
  const port = integer(env, 'WEVIR_PUSH_PORT', 8080, 0, 65_535);
  const logLevel = (env.WEVIR_PUSH_LOG_LEVEL ?? 'info') as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) {
    throw new Error(`WEVIR_PUSH_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  }
  const limits: PushLimits = { ...DEFAULT_PUSH_LIMITS };
  for (const [name, key] of Object.entries(LIMIT_ENV)) {
    limits[key] = integer(env, name, DEFAULT_PUSH_LIMITS[key], 1, Number.MAX_SAFE_INTEGER);
  }
  const cert = env.WEVIR_PUSH_TLS_CERT;
  const key = env.WEVIR_PUSH_TLS_KEY;
  if ((cert === undefined) !== (key === undefined)) {
    throw new Error('set both WEVIR_PUSH_TLS_CERT and WEVIR_PUSH_TLS_KEY, or neither');
  }
  return {
    port,
    host: env.WEVIR_PUSH_HOST ?? '0.0.0.0',
    logLevel,
    trustProxy: flag(env.WEVIR_PUSH_TRUST_PROXY),
    tls:
      cert !== undefined && key !== undefined
        ? { cert: readFileSync(cert), key: readFileSync(key) }
        : undefined,
    dataDir: nonEmpty(env.WEVIR_PUSH_DATA_DIR),
    apns: loadApns(env),
    fcm: loadFcm(env),
    limits,
  };
}

/** APNs：`.p8` 的内容（`WEVIR_PUSH_APNS_KEY`）或文件（`WEVIR_PUSH_APNS_KEY_FILE`），加 key ID、team ID 与 topic。全没设时不开 APNs。 */
function loadApns(env: Env): PushConfig['apns'] {
  const names = [
    'WEVIR_PUSH_APNS_KEY_ID',
    'WEVIR_PUSH_APNS_TEAM_ID',
    'WEVIR_PUSH_APNS_TOPIC',
  ] as const;
  const key = secret(env, 'WEVIR_PUSH_APNS_KEY');
  const set = names.filter((name) => nonEmpty(env[name]) !== undefined);
  if (key === undefined && set.length === 0) return undefined;
  const missing = [
    ...(key === undefined ? ['WEVIR_PUSH_APNS_KEY or WEVIR_PUSH_APNS_KEY_FILE'] : []),
  ].concat(names.filter((name) => !set.includes(name)));
  if (missing.length > 0) throw new Error(`APNs is partly configured: set ${missing.join(', ')}`);
  const productionUrl = nonEmpty(env.WEVIR_PUSH_APNS_URL);
  const sandboxUrl = nonEmpty(env.WEVIR_PUSH_APNS_SANDBOX_URL);
  return {
    key: key as string,
    keyId: env.WEVIR_PUSH_APNS_KEY_ID as string,
    teamId: env.WEVIR_PUSH_APNS_TEAM_ID as string,
    topic: env.WEVIR_PUSH_APNS_TOPIC as string,
    ...(productionUrl !== undefined && { productionUrl }),
    ...(sandboxUrl !== undefined && { sandboxUrl }),
  };
}

/** FCM：服务账号 JSON 的内容（`WEVIR_PUSH_FCM_CREDENTIALS`）或文件（`WEVIR_PUSH_FCM_CREDENTIALS_FILE`）。没设时不开 FCM。 */
function loadFcm(env: Env): PushConfig['fcm'] {
  const raw = secret(env, 'WEVIR_PUSH_FCM_CREDENTIALS');
  if (raw === undefined) return undefined;
  let value: Partial<Record<keyof FcmCredentials, unknown>>;
  try {
    value = JSON.parse(raw) as typeof value;
  } catch {
    throw new Error('the FCM service account credentials are not JSON');
  }
  for (const field of ['project_id', 'client_email', 'private_key'] as const) {
    if (typeof value[field] !== 'string' || value[field] === '') {
      throw new Error(`the FCM service account credentials have no ${field}`);
    }
  }
  const baseUrl = nonEmpty(env.WEVIR_PUSH_FCM_URL);
  return {
    credentials: {
      project_id: value.project_id as string,
      client_email: value.client_email as string,
      private_key: value.private_key as string,
      ...(typeof value.token_uri === 'string' && { token_uri: value.token_uri }),
    },
    ...(baseUrl !== undefined && { baseUrl }),
  };
}

/** `<NAME>` 的内容，或 `<NAME>_FILE` 指向的文件的内容；两个都设时报错。 */
function secret(env: Env, name: string): string | undefined {
  const inline = nonEmpty(env[name]);
  const file = nonEmpty(env[`${name}_FILE`]);
  if (inline !== undefined && file !== undefined) {
    throw new Error(`set ${name} or ${name}_FILE, not both`);
  }
  if (file === undefined) return inline;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    throw new Error(`${name}_FILE cannot be read`);
  }
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function flag(raw: string | undefined): boolean {
  return raw === '1' || raw?.toLowerCase() === 'true';
}
