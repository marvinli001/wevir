// `wevir web`（0.34.0）：进程内的 echo Host 带着联网服务，搜索服务指向本机的 mock。Key 从管道读、不出现在输出里；切服务、开关、
// 测试与移除都改 Host 里的同一份设置。

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createLogger, type RunningHost, startHost, WebService } from '@wevir/host';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { run, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
let host: RunningHost | undefined;
let search: Server;
let searchUrl: string;
const authorizations: Array<string | undefined> = [];

beforeAll(async () => {
  search = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    request.resume();
    request.on('end', () => {
      response.writeHead(request.headers.authorization === 'Bearer sk-good' ? 200 : 401, {
        'content-type': 'application/json',
      });
      response.end(
        request.headers.authorization === 'Bearer sk-good'
          ? JSON.stringify({
              code: 200,
              data: { webPages: { value: [{ name: 'A', url: 'https://a.example/' }] } },
            })
          : JSON.stringify({ code: '401', message: 'Invalid API KEY' }),
      );
    });
  });
  await new Promise<void>((resolve) => search.listen(0, '127.0.0.1', resolve));
  searchUrl = `http://127.0.0.1:${(search.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await host?.shutdown();
  host = undefined;
});
afterAll(async () => {
  search.closeAllConnections();
  await new Promise((resolve) => search.close(resolve));
});

async function setup() {
  const home = join(tempDir(), 'home');
  host = await startHost({
    home,
    adapter: new EchoAdapter({ stepDelayMs: 1 }),
    engine: 'echo',
    logger: createLogger({ level: 'error', mirror: () => {} }),
    web: new WebService({
      settingsFile: join(home, 'web.json'),
      mcpDir: join(home, 'mcp'),
      endpoints: { bocha: `${searchUrl}/v1/web-search`, tavily: `${searchUrl}/search` },
    }),
  });
  return home;
}

describe('wevir web', () => {
  it('status、key（管道）、test、use、off、key --remove', async () => {
    const home = await setup();
    const status = await run(['web', 'status'], { home });
    expect(status.code, status.err).toBe(0);
    expect(status.out).toContain('联网工具：开启');
    expect(status.out).toMatch(/博查 \(bocha\)\s+未设置\s+当前/);

    const missing = await run(['web', 'test'], { home });
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('✗ 测试失败（未设置 Key）');

    const bad = await run(['web', 'key'], { home, input: 'sk-bad\n' });
    expect(bad.code, bad.err).toBe(0);
    expect(bad.out).toContain('✓ 已保存 博查 的 Key');
    expect(bad.out).not.toContain('sk-bad');
    const failed = await run(['web', 'test', 'bocha'], { home });
    expect(failed.code).toBe(1);
    expect(failed.out).toContain('✗ 测试失败（认证失败，HTTP 401）');

    await run(['web', 'key', 'bocha'], { home, input: 'sk-good\n' });
    const ok = await run(['web', 'test'], { home });
    expect(ok.code, ok.out).toBe(0);
    expect(ok.out).toContain('✓ 连接正常');
    expect(authorizations.at(-1)).toBe('Bearer sk-good');

    const use = await run(['web', 'use', 'tavily'], { home });
    expect(use.out).toMatch(/Tavily \(tavily\)\s+未设置\s+当前/);
    expect(use.out).toContain('尚未设置 Key：wevir web key tavily');
    const unknown = await run(['web', 'use', 'google'], { home });
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('不支持的搜索服务：google');

    const off = await run(['web', 'off'], { home });
    expect(off.out).toContain('联网工具：关闭');
    await run(['web', 'key', 'bocha', '--remove'], { home });
    const after = await run(['web', 'status'], { home });
    expect(after.out).toMatch(/博查 \(bocha\)\s+未设置/);
  });
});
