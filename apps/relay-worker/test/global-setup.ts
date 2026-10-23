// 协议测试之前打包一次 Worker：wrangler 的 dry-run 打包与部署时同一套，打包条件加上 "@wevir/source"，直接用工作区依赖的源码（与
// 其他包的测试一样不用先 pnpm build）。每个测试再用 Miniflare 起一个带自己限制的实例（conformance.test.ts）。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { unstable_getMiniflareWorkerOptions } from 'wrangler';

const root = dirname(import.meta.dirname);

declare module 'vitest' {
  export interface ProvidedContext {
    worker: { script: string; options: WorkerConfig };
  }
}

/** Miniflare 要的 wrangler.jsonc 里的那几项。 */
export interface WorkerConfig {
  compatibilityDate: string;
  durableObjects: Record<string, { className: string; useSQLite?: boolean }>;
  ratelimits: Record<string, { namespace_id: string; simple: { limit: number; period?: 10 | 60 } }>;
  bindings: Record<string, string>;
}

export default function setup(project: TestProject) {
  const out = mkdtempSync(join(tmpdir(), 'wevir-relay-worker-'));
  const wrangler = join(
    dirname(createRequire(import.meta.url).resolve('wrangler/package.json')),
    'bin',
    'wrangler.js',
  );
  // 用 process.execPath 起，不继承 Vitest worker 的 execArgv（AGENTS.md）。
  const result = spawnSync(
    process.execPath,
    [wrangler, 'deploy', '--dry-run', '--outdir', out, '--config', join(root, 'wrangler.jsonc')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: 'false',
        WRANGLER_BUILD_CONDITIONS: '@wevir/source,workerd,worker,browser',
      },
    },
  );
  if (result.status !== 0) {
    rmSync(out, { recursive: true, force: true });
    throw new Error(`wrangler build failed:\n${result.stdout}\n${result.stderr}`);
  }
  const { workerOptions } = unstable_getMiniflareWorkerOptions(join(root, 'wrangler.jsonc'));
  project.provide('worker', {
    script: join(out, 'index.js'),
    options: {
      compatibilityDate: workerOptions.compatibilityDate as string,
      durableObjects: workerOptions.durableObjects as WorkerConfig['durableObjects'],
      ratelimits: workerOptions.ratelimits as WorkerConfig['ratelimits'],
      bindings: workerOptions.bindings as Record<string, string>,
    },
  });
  return () => rmSync(out, { recursive: true, force: true });
}
