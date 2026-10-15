import { chmodSync, closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Record<string, unknown>;

/** 日志文件名，位于 `<数据目录>/logs/`。骨架阶段只追加、不轮转。 */
export const LOG_FILE = 'host.log';

/** 替换敏感内容的占位。 */
export const REDACTED = '[REDACTED]';

/**
 * 字段名命中即整体替换（不分大小写，按子串）：令牌、密钥、密码、API Key、凭据、Authorization、
 * Cookie。宁可多遮。
 */
const SENSITIVE_KEY =
  /token|secret|password|passwd|api[-_]?key|private[-_]?key|serviceAccountJson|credential|authorization|cookie/i;

/** 嵌套过深的值不再展开。 */
const MAX_DEPTH = 8;

export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** 之后的日志里，字符串中出现这个值的地方一律替换为 `[REDACTED]`（例如本次启动的令牌）。 */
  addSecret(value: string): void;
  /** 关闭日志文件；之后的日志只写 `mirror`。可重复调用。 */
  close(): void;
}

export interface LoggerOptions {
  /** 默认 `info`。 */
  level?: LogLevel;
  /** 日志目录（0700），写 `<dir>/host.log`（0600，追加）。不给时只写 `mirror`。 */
  dir?: string;
  /** 每一行（不含换行）也交给它，例如开发时 stderr 是终端就镜像一份。 */
  mirror?: (line: string) => void;
  /** 每行都带的字段，例如 `pid`。 */
  base?: LogFields;
  now?: () => Date;
}

/**
 * Host 的结构化日志：一行一个 JSON 对象，`{ts, level, msg, ...base, ...fields}`。同步追加写入，
 * 进程随后崩溃也不丢已写的行。写日志失败不影响 Host。
 *
 * 脱敏（ADR-0002 §2 令牌不写日志、AGENTS.md 第 5 条密钥不落地）：字段名像令牌 / 密钥的整体替换；
 * 经 `addSecret` 登记的值在任何字符串里出现都替换；`Error` 展开成 `{name, message, code, stack}`
 * 后同样处理。
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const threshold = LOG_LEVELS.indexOf(level);
  const now = options.now ?? (() => new Date());
  const secrets: string[] = [];
  let fd: number | undefined;
  if (options.dir !== undefined) {
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    const path = join(options.dir, LOG_FILE);
    fd = openSync(path, 'a', 0o600);
    if (process.platform !== 'win32') {
      chmodSync(options.dir, 0o700);
      chmodSync(path, 0o600);
    }
  }

  const write = (lineLevel: LogLevel, msg: string, fields: LogFields | undefined): void => {
    if (LOG_LEVELS.indexOf(lineLevel) < threshold) return;
    const rest = redact({ ...options.base, ...fields }, secrets) as LogFields;
    delete rest.ts;
    delete rest.level;
    delete rest.msg;
    const line = JSON.stringify({
      ts: now().toISOString(),
      level: lineLevel,
      msg: redactString(msg, secrets),
      ...rest,
    });
    if (fd !== undefined) {
      try {
        writeSync(fd, `${line}\n`);
      } catch {
        // 磁盘满、文件被删等：放弃这一行。
      }
    }
    try {
      options.mirror?.(line);
    } catch {
      // 同上。
    }
  };

  return {
    level,
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    addSecret: (value) => {
      if (value !== '' && !secrets.includes(value)) secrets.push(value);
    },
    close: () => {
      if (fd === undefined) return;
      try {
        closeSync(fd);
      } catch {
        // 已关闭。
      }
      fd = undefined;
    },
  };
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** 按上面的规则脱敏，返回可以直接 `JSON.stringify` 的新值；不修改原值。 */
export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  return redactValue(value, secrets, 0, new WeakSet());
}

function redactValue(
  value: unknown,
  secrets: readonly string[],
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  seen.add(value);
  try {
    if (value instanceof Error) return redactValue(errorFields(value), secrets, depth + 1, seen);
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, secrets, depth + 1, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(item, secrets, depth + 1, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function redactString(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  return out;
}

/** `Error` 的可序列化字段：name、message、code、data（HostError）、cause、stack。 */
function errorFields(error: Error): Record<string, unknown> {
  const fields: Record<string, unknown> = { name: error.name, message: error.message };
  const extra = error as Error & { code?: unknown; data?: unknown };
  if (extra.code !== undefined) fields.code = extra.code;
  if (extra.data !== undefined) fields.data = extra.data;
  if (error.cause !== undefined) fields.cause = error.cause;
  if (error.stack !== undefined) fields.stack = error.stack;
  return fields;
}
