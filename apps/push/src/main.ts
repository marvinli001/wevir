#!/usr/bin/env node
// wevir-push：推送网关的进程入口。配置全在环境变量里（config.ts），日志是写到 stdout 的 JSON 行；SIGINT / SIGTERM 时关掉监听后退出。

import { type BindingStore, MemoryBindingStore, SqliteBindingStore } from './bindings.js';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { PushGatewayServer } from './server.js';
import { ApnsClient, FcmClient } from './upstream.js';

const config = (() => {
  try {
    return loadConfig(process.env);
  } catch (error) {
    process.stderr.write(`wevir-push: ${(error as Error).message}\n`);
    process.exit(2);
  }
})();
const logger = createLogger(config.logLevel);

let gateway: PushGatewayServer;
try {
  const bindings: BindingStore =
    config.dataDir !== undefined
      ? new SqliteBindingStore(config.dataDir)
      : new MemoryBindingStore();
  if (config.dataDir === undefined) {
    logger.warn('WEVIR_PUSH_DATA_DIR is not set: bindings are kept in memory only');
  }
  gateway = new PushGatewayServer({
    ...(config.apns !== undefined && { apns: new ApnsClient(config.apns) }),
    ...(config.fcm !== undefined && { fcm: new FcmClient(config.fcm) }),
    bindings,
    limits: config.limits,
    logger,
    trustProxy: config.trustProxy,
    ...(config.tls !== undefined && { tls: config.tls }),
  });
} catch (error) {
  process.stderr.write(`wevir-push: ${(error as Error).message}\n`);
  process.exit(2);
}

try {
  const port = await gateway.listen(config.port, config.host);
  logger.info('push gateway listening', {
    host: config.host,
    port,
    tls: config.tls !== undefined,
    trustProxy: config.trustProxy,
    apns: config.apns !== undefined,
    fcm: config.fcm !== undefined,
    persistent: config.dataDir !== undefined,
  });
} catch (error) {
  logger.error('push gateway failed to listen', { error: (error as Error).message });
  process.exit(1);
}

let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info('push gateway stopping', { signal });
  const force = setTimeout(() => process.exit(1), 5000);
  force.unref();
  void gateway.close().then(() => process.exit(0));
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
