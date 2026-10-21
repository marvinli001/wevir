// 官方插件市场（0.90.0）：自动测速并记住镜像、手动选择、验签与回退、序号防回滚、缓存。
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MarketMirror, MarketMirrorPreference, WevirMarketIndex } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { HostError } from '../errors.js';
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
  index?: WevirMarketIndex;
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
