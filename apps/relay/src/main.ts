#!/usr/bin/env node
// wevir-relay：中继的进程入口。配置全在环境变量里（config.ts），日志是写到 stdout 的 JSON 行；SIGINT / SIGTERM 时以 1001 关闭
// 全部连接后退出。

import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { RelayServer } from './server.js';

const config = (() => {
  try {
    return loadConfig(process.env);
  } catch (error) {
    process.stderr.write(`wevir-relay: ${(error as Error).message}\n`);
    process.exit(2);
  }
})();
const logger = createLogger(config.logLevel);
const relay = new RelayServer({
  limits: config.limits,
  logger,
  trustProxy: config.trustProxy,
  ...(config.tls !== undefined && { tls: config.tls }),
});

try {
  const port = await relay.listen(config.port, config.host);
  logger.info('relay listening', {
    host: config.host,
    port,
    tls: config.tls !== undefined,
    trustProxy: config.trustProxy,
  });
} catch (error) {
  logger.error('relay failed to listen', { error: (error as Error).message });
  process.exit(1);
}

let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info('relay stopping', { signal });
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();
  void relay.close().then(() => process.exit(0));
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
