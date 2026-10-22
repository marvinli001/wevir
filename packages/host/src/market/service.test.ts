// 官方插件市场（0.91.0）：自动测速并记住镜像、手动选择、验签与回退、序号防回滚、缓存；0.93.0 起读索引时丢掉未知字段；0.94.0 读条目文件；0.99.0 安装。
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MarketMirror, MarketMirrorPreference, WevirMarketIndex } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { describe, expect, it } from 'vitest';
import { HostError } from '../errors.js';
import { PluginRegistry } from '../plugins.js';
import { useTempDir } from '../test-utils.js';
import { MARKET_INDEX_MAX_AGE_MS, MarketService } from './service.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const other = generateKeyPairSync('ed25519').privateKey;

const indexOf = (sequence: number): WevirMarketIndex => ({
  schemaVersion: 1,
  name: 'Wevir',
  generatedAt: '2026-10-21T08:00:00Z',
  sequence,
  commit: 'a'.repeat(40),
  categories: [],
  featured: [],
  entries: [],
});

interface Served {
  /** 毫秒；省略立即回答。 */
  delay?: number;
  status?: number;
  /** 不一定合乎当前的 schema：市场仓库可能比客户端新。 */
  index?: unknown;
  /** 用别的私钥签名。 */
  forged?: boolean;
}

/** 三个假镜像：地址是 `https://<镜像>/<ref>/<path>`，记下每次请求。 */
function mirrors(served: Partial<Record<MarketMirror, Served>>) {
  const requests: string[] = [];
  const fake = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(`${url.host}${url.pathname}`);
    const config = served[url.host as MarketMirror] ?? { status: 503 };
    if (config.delay) await new Promise((resolve) => setTimeout(resolve, config.delay));
    if (config.status !== undefined) return new Response('no', { status: config.status });
    const body = Buffer.from(JSON.stringify(config.index ?? indexOf(1)));
    if (url.pathname.endsWith('/index.json')) return new Response(body);
    const signature = sign(null, body, config.forged ? other : privateKey).toString('base64');
    return new Response(`${signature}\n`);
  }) as typeof fetch;
  const url = (mirror: MarketMirror) => (ref: string, path: string) =>
    `https://${mirror}/${ref}/${path}`;
  return {
    requests,
    options: {
      fetch: fake,
      publicKeys: [PUBLIC_KEY],
      mirrors: { github: url('github'), cnb: url('cnb'), gitee: url('gitee') },
    },
  };
}

/** 比客户端新的市场仓库生成的条目：各层多出几个字段。 */
const futureEntry = {
  id: 'notes',
  kind: 'plugin',
  path: 'plugins/notes',
  name: 'Notes',
  version: '1.0.0',
  category: 'productivity',
  listedAt: '2026-10-21T08:00:00Z',
  verification: { level: 'verified', publisher: 'Acme', since: '2026-10', badge: 'gold' },
  rating: 4.5,
  contents: { connectors: [], skills: [], inputs: [], apps: [] },
  files: [{ path: 'wevir-plugin.json', size: 10, sha256: 'b'.repeat(64) }],
  digest: 'c'.repeat(64),
};

describe('MarketService', () => {
  const temp = useTempDir();
  const service = (
    options: ReturnType<typeof mirrors>['options'],
    preference: () => MarketMirrorPreference = () => 'auto',
    now?: () => number,
  ) =>
    new MarketService({ dir: join(temp(), 'market'), preference, ...options, ...(now && { now }) });

  it('自动：测速选最先回来的镜像，记进 state.json，下次不再测', async () => {
    const served = mirrors({ github: { delay: 80 }, cnb: {}, gitee: { status: 404 } });
    expect(await service(served.options).status()).toEqual({ preference: 'auto', mirror: 'cnb' });
    const state = JSON.parse(readFileSync(join(temp(), 'market', 'state.json'), 'utf8'));
    expect(state.mirror).toBe('cnb');

    const again = mirrors({ github: {}, cnb: {}, gitee: {} });
    expect(await service(again.options).status()).toEqual({ preference: 'auto', mirror: 'cnb' });
    expect(again.requests).toEqual([]);
  });

  it('自动：三家都不通时不记，结果里没有镜像', async () => {
    const served = mirrors({});
    expect(await service(served.options).status()).toEqual({ preference: 'auto' });
  });

  it('手动：直接用选的那家，不测速', async () => {
    const served = mirrors({ github: {}, cnb: {}, gitee: {} });
    const market = service(served.options, () => 'gitee');
    expect(await market.status()).toEqual({ preference: 'gitee', mirror: 'gitee' });
    const result = await market.index();
    expect(result.mirror).toBe('gitee');
    expect(served.requests.every((r) => r.startsWith('gitee/'))).toBe(true);
  });

  it('签名不对时换下一家，自动模式记住换成功的那家', async () => {
    const served = mirrors({ cnb: { forged: true }, github: { delay: 30 }, gitee: { delay: 30 } });
    const market = service(served.options);
    const result = await market.index();
    expect(result.mirror).not.toBe('cnb');
    expect(result.index.sequence).toBe(1);
    expect((await market.status()).mirror).toBe(result.mirror);
  });

  it('序号比缓存小的索引不用', async () => {
    let now = 0;
    const first = mirrors({ github: { index: indexOf(5) } });
    await service(
      first.options,
      () => 'github',
      () => now,
    ).index();

    now = MARKET_INDEX_MAX_AGE_MS + 1;
    const stale = mirrors({ github: { index: indexOf(4) }, cnb: { index: indexOf(6) } });
    const result = await service(
      stale.options,
      () => 'github',
      () => now,
    ).index();
    expect(result).toMatchObject({ mirror: 'cnb', index: { sequence: 6 } });
  });

  it('一小时内用缓存，refresh 强制重读', async () => {
    let now = 0;
    const served = mirrors({ github: {} });
    const market = service(
      served.options,
      () => 'github',
      () => now,
    );
    await market.index();
    const count = served.requests.length;
    now = MARKET_INDEX_MAX_AGE_MS - 1;
    await market.index();
    expect(served.requests.length).toBe(count);
    await market.index(true);
    expect(served.requests.length).toBeGreaterThan(count);
  });

  it('都读不到时有缓存就回缓存并带 error，没有缓存回 ENGINE_ERROR', async () => {
    const ok = mirrors({ github: {} });
    await service(ok.options, () => 'github').index();
    const down = mirrors({});
    const cached = await service(down.options, () => 'github').index(true);
    expect(cached.mirror).toBe('github');
    expect(cached.error).toMatch(/github: HTTP 503/);

    const empty = new MarketService({
      dir: join(temp(), 'empty'),
      preference: () => 'github',
      ...down.options,
    });
    await expect(empty.index()).rejects.toBeInstanceOf(HostError);
  });

  it('索引里不认识的字段丢掉，不拒收整份索引', async () => {
    const index = {
      ...indexOf(2),
      layout: 'grid',
      categories: [{ id: 'productivity', name: { en: 'Productivity' }, icon: 'x.svg' }],
      entries: [futureEntry],
    };
    const result = await service(mirrors({ github: { index } }).options, () => 'github').index();
    expect(result.mirror).toBe('github');
    expect(result.index).not.toHaveProperty('layout');
    expect(result.index.categories[0]).not.toHaveProperty('icon');
    const [entry] = result.index.entries;
    expect(entry).not.toHaveProperty('rating');
    expect(entry?.verification).toEqual({ level: 'verified', publisher: 'Acme', since: '2026-10' });
    expect(entry?.contents).not.toHaveProperty('apps');
  });

  it('不认识的 schemaVersion 当作读取失败：换镜像，都不行就回缓存', async () => {
    const v2 = { ...indexOf(9), schemaVersion: 2 };
    const fallback = await service(
      mirrors({ github: { index: v2 }, cnb: { index: indexOf(3) } }).options,
      () => 'github',
    ).index();
    expect(fallback).toMatchObject({ mirror: 'cnb', index: { sequence: 3 } });

    const cached = await service(
      mirrors({ github: { index: v2 }, cnb: { index: v2 }, gitee: { index: v2 } }).options,
      () => 'github',
    ).index(true);
    expect(cached.index.sequence).toBe(3);
    expect(cached.error).toMatch(/unsupported index schemaVersion: 2/);
  });

  it('从手动改回自动时忘掉之前测出的镜像', async () => {
    let preference: MarketMirrorPreference = 'auto';
    const served = mirrors({ github: {}, cnb: { delay: 50 }, gitee: { delay: 50 } });
    const market = service(served.options, () => preference);
    expect((await market.status()).mirror).toBe('github');

    preference = 'gitee';
    await market.preferenceChanged();
    preference = 'auto';
    await market.preferenceChanged();
    const state = JSON.parse(readFileSync(join(temp(), 'market', 'state.json'), 'utf8'));
    expect(state.mirror).toBeUndefined();
  });
});

describe('MarketService.file（0.94.0）', () => {
  const temp = useTempDir();
  const readme = Buffer.from('# Notes\n');
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const index: WevirMarketIndex = {
    ...indexOf(1),
    entries: [
      {
        ...(futureEntry as unknown as WevirMarketIndex['entries'][number]),
        files: [
          { path: 'README.md', size: readme.length, sha256: sha(readme) },
          { path: 'big.bin', size: 2 * 1024 * 1024, sha256: 'd'.repeat(64) },
        ],
      },
    ],
  };

  /** 镜像上的条目文件：`files` 是 `<镜像>` → 内容；索引照常签名。 */
  function serve(files: Partial<Record<MarketMirror, Buffer>>, dir = 'market') {
    const base = mirrors({ github: { index }, cnb: { index }, gitee: { index } });
    const requests: string[] = [];
    const fake = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith('/dist/')) return base.options.fetch(input);
      requests.push(`${url.host}${url.pathname}`);
      const body = files[url.host as MarketMirror];
      return body === undefined
        ? new Response('no', { status: 404 })
        : new Response(new Uint8Array(body));
    }) as typeof fetch;
    const market = new MarketService({
      dir: join(temp(), dir),
      preference: () => 'github',
      ...base.options,
      fetch: fake,
    });
    return { market, requests };
  }

  it('按索引的提交读条目目录下的文件，校验后缓存，第二次不再请求', async () => {
    const { market, requests } = serve({ github: readme });
    const result = await market.file('notes', 'README.md');
    expect(Buffer.from(result.data, 'base64').toString()).toBe('# Notes\n');
    expect(requests).toEqual([`github/${'a'.repeat(40)}/plugins/notes/README.md`]);
    expect(
      readFileSync(
        join(temp(), 'market', 'files', 'a'.repeat(40), 'plugins', 'notes', 'README.md'),
        'utf8',
      ),
    ).toBe('# Notes\n');
    await market.file('notes', 'README.md');
    expect(requests).toHaveLength(1);
  });

  it('sha256 不符或读不到时换镜像；都不行回 ENGINE_ERROR', async () => {
    const tampered = serve({ github: Buffer.from('# Evil!\n'), cnb: readme });
    const result = await tampered.market.file('notes', 'README.md');
    expect(Buffer.from(result.data, 'base64').toString()).toBe('# Notes\n');
    expect(tampered.requests.map((request) => request.split('/')[0])).toEqual(['github', 'cnb']);

    const { market } = serve({ github: Buffer.from('# Evil!\n') }, 'other');
    const error = await market.file('notes', 'README.md').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(HostError);
    expect((error as HostError).code).toBe('ENGINE_ERROR');
  });

  it('条目或路径不在索引里、文件太大时回 INVALID_PARAMS，不请求镜像', async () => {
    const { market, requests } = serve({ github: readme });
    for (const [entry, path] of [
      ['missing', 'README.md'],
      ['notes', 'SKILL.md'],
      ['notes', 'big.bin'],
    ] as const) {
      const error = await market.file(entry, path).catch((reason: unknown) => reason);
      expect((error as HostError).code).toBe('INVALID_PARAMS');
    }
    expect(requests).toEqual([]);
  });
});

describe('MarketService.install（0.99.0）', () => {
  const temp = useTempDir();
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      id: 'notes',
      name: 'Notes',
      version: '1.0.0',
      connectors: { notes: { transport: 'stdio', command: 'node', args: ['server.js'] } },
    }),
  );
  const server = Buffer.from('console.log("notes")\n'.repeat(200));
  const skill = Buffer.from('---\nname: pdf\ndescription: Read PDFs\n---\n\nUse it.\n');
  const entryOf = (id: string, path: string, files: Record<string, Buffer>) => ({
    ...(futureEntry as unknown as WevirMarketIndex['entries'][number]),
    id,
    name: id,
    path,
    files: Object.entries(files).map(([file, bytes]) => ({
      path: file,
      size: bytes.length,
      sha256: sha(bytes),
    })),
  });
  const index: WevirMarketIndex = {
    ...indexOf(1),
    entries: [
      entryOf('notes', 'plugins/notes', { 'wevir-plugin.json': manifest, 'server.js': server }),
      entryOf('pdf', 'skills/pdf', { 'SKILL.md': skill }),
    ],
  };
  const repo: Record<string, Buffer> = {
    'plugins/notes/wevir-plugin.json': manifest,
    'plugins/notes/server.js': server,
    'skills/pdf/SKILL.md': skill,
  };

  /** 镜像上的仓库：`tamper` 里的路径在 github 上被改过；`hold` 让文件请求挂起直到被中止。 */
  function serve(options: { tamper?: string[]; tamperAll?: boolean; hold?: boolean } = {}) {
    const base = mirrors({ github: { index }, cnb: { index }, gitee: { index } });
    const requests: string[] = [];
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith('/dist/')) return base.options.fetch(input);
      requests.push(`${url.host}${url.pathname}`);
      if (options.hold) {
        await new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        );
      }
      const path = url.pathname.split('/').slice(2).join('/');
      const body = repo[path];
      if (body === undefined) return new Response('no', { status: 404 });
      const tampered =
        options.tamperAll || (url.host === 'github' && options.tamper?.includes(path));
      return new Response(new Uint8Array(tampered ? Buffer.from('evil') : body));
    }) as typeof fetch;
    const market = new MarketService({
      dir: join(temp(), 'market'),
      preference: () => 'github',
      ...base.options,
      fetch: fake,
    });
    const progress: { phase: string; receivedBytes: number; totalBytes: number }[] = [];
    market.watch(({ phase, receivedBytes, totalBytes }) =>
      progress.push({ phase, receivedBytes, totalBytes }),
    );
    return { market, requests, progress };
  }

  const installs = () => readdirSync(join(temp(), 'market', 'installs'));

  it('下载并校验全部文件后交给安装事务，进度从 0 到全部字节再到 install，临时目录删掉', async () => {
    const { market, progress } = serve({ tamper: ['plugins/notes/server.js'] });
    const seen = await market.install('notes', async (root) => ({
      files: readdirSync(root).sort(),
      server: readFileSync(join(root, 'server.js'), 'utf8'),
    }));
    expect(seen.files).toEqual(['server.js', 'wevir-plugin.json']);
    expect(seen.server).toBe(server.toString());
    const total = manifest.length + server.length;
    expect(progress[0]).toEqual({ phase: 'download', receivedBytes: 0, totalBytes: total });
    expect(progress.at(-1)).toEqual({ phase: 'install', receivedBytes: total, totalBytes: total });
    expect(progress.every((item) => item.receivedBytes <= total)).toBe(true);
    expect(installs()).toEqual([]);
  });

  it('skills/ 下的简便投稿包成只含这个 skill 的插件，真实的插件注册表能装上', async () => {
    const { market } = serve();
    const store = new PluginRegistry({
      home: join(temp(), 'home'),
      userHome: join(temp(), 'user'),
      roots: () => [],
      adapter: new EchoAdapter({ stepDelayMs: 0 }),
    });
    await store.load();
    const result = await market.install('pdf', (root, signal) =>
      store.installPlugin(root, { signal }),
    );
    expect(result.plugin).toMatchObject({ id: 'pdf', name: 'pdf', version: '1.0.0' });
    expect(result.plugin.skills).toHaveLength(1);
  });

  it('三家都校验不过时回 ENGINE_ERROR，不调安装事务', async () => {
    const { market } = serve({ tamperAll: true });
    let called = false;
    const error = await market
      .install('notes', async () => {
        called = true;
      })
      .catch((reason: unknown) => reason);
    expect((error as HostError).code).toBe('ENGINE_ERROR');
    expect(called).toBe(false);
    expect(installs()).toEqual([]);
  });

  it('同一条目并入正在进行的安装；cancelInstall 停下它，回 ENGINE_ERROR', async () => {
    const { market } = serve({ hold: true });
    let calls = 0;
    const run = async () => {
      calls++;
    };
    const first = market.install('notes', run).catch((reason: unknown) => reason);
    const second = market.install('notes', run).catch((reason: unknown) => reason);
    await new Promise((resolve) => setTimeout(resolve, 20));
    market.cancelInstall('notes');
    const [a, b] = await Promise.all([first, second]);
    expect((a as HostError).code).toBe('ENGINE_ERROR');
    expect((a as HostError).message).toMatch(/cancelled/);
    expect(b).toBe(a);
    expect(calls).toBe(0);
    expect(installs()).toEqual([]);
  });

  it('条目不在索引里回 INVALID_PARAMS', async () => {
    const { market, requests } = serve();
    const error = await market.install('missing', async () => {}).catch((reason) => reason);
    expect((error as HostError).code).toBe('INVALID_PARAMS');
    expect(requests).toEqual([]);
  });
});
