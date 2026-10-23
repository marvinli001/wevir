// 用 Miniflare 起一个 Worker：workerd 与线上同一个运行时，Durable Object 用内存里的 SQLite，每次一个新实例。

import { dirname } from 'node:path';
import type { ConformanceLimits } from '@wevir/relay/conformance';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { inject } from 'vitest';

const worker = inject('worker');

export async function startWorker(limits: ConformanceLimits) {
  const { options } = worker;
  const vars: Record<string, string> = { ...options.bindings, WEVIR_RELAY_LOG_LEVEL: 'warn' };
  const set = (name: string, value: number | undefined) => {
    if (value !== undefined) vars[name] = String(value);
  };
  set('WEVIR_RELAY_REGISTER_TIMEOUT_MS', limits.registerTimeoutMs);
  set('WEVIR_RELAY_ACCEPT_TIMEOUT_MS', limits.acceptTimeoutMs);
  set('WEVIR_RELAY_MAX_QUEUED_MESSAGES', limits.maxQueuedMessages);
  set('WEVIR_RELAY_MAX_CONNECTIONS_PER_ROUTE', limits.maxConnectionsPerRoute);
  const ratelimits = Object.fromEntries(
    Object.entries(options.ratelimits).map(([name, config]) => [
      name,
      {
        ...config,
        simple: {
          ...config.simple,
          limit: limits.connectsPerMinutePerSource ?? config.simple.limit,
        },
      },
    ]),
  );
  // wrangler 给的是 Miniflare 4 形状的选项（unstable_getMiniflareWorkerOptions），经 Miniflare 自己的转换喂给 5。
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      host: '127.0.0.1',
      port: 0,
      workers: [
        {
          name: 'wevir-relay',
          modules: true,
          scriptPath: worker.script,
          // 模块名相对这个目录；默认是当前目录，脚本在临时目录里时名字以 ../ 开头，workerd 起不来。
          modulesRoot: dirname(worker.script),
          compatibilityDate: options.compatibilityDate,
          durableObjects: options.durableObjects,
          ratelimits,
          bindings: vars,
        },
      ],
    }),
  );
  const url = await mf.ready;
  return { url: `ws://${url.host}`, close: () => mf.dispose() };
}
