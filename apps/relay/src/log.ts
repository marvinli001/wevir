export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * 中继的日志：一行一个 JSON 对象，写到 stdout。只记连接的起止、计数与原因；从不记帧内容、IP 地址或完整的路由 ID（只记路由 ID
 * 哈希的前几位，见 server.ts 的 `routeTag`）。
 */
export interface RelayLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(
  level: LogLevel = 'info',
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): RelayLogger {
  const at =
    (name: LogLevel) =>
    (message: string, fields: Record<string, unknown> = {}): void => {
      if (ORDER[name] < ORDER[level]) return;
      write(
        JSON.stringify({ time: new Date().toISOString(), level: name, msg: message, ...fields }),
      );
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export const silentLogger: RelayLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
