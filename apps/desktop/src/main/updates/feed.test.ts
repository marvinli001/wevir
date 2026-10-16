import { describe, expect, it } from 'vitest';
import { fakeServer, manifestText, signText, testKeyPair } from '../test-fixtures/update-feed.js';
import {
  channelNames,
  type Fetcher,
  feedUrl,
  installerFile,
  manifestFile,
  mirrorsFromEnv,
  PROBE_BYTES,
  parseManifest,
  pickDownloadMirror,
  raceMirrors,
  readMirror,
  UPDATE_MIRRORS,
  UpdateFeedError,
  verifyManifest,
} from './feed.js';
import { UPDATE_PUBLIC_KEYS } from './keys.js';

const GLOBAL = { id: 'global', url: 'https://download.example' };
const OPTIMIZED = { id: 'optimized', url: 'https://download2.example' };

describe('线路与清单的位置', () => {
  it('内置两条线路是维护者定的域名，内置了公钥', () => {
    expect(UPDATE_MIRRORS.map((m) => m.url)).toEqual([
      'https://download.wevir.si',
      'https://download2.wevir.si',
    ]);
    expect(UPDATE_PUBLIC_KEYS.length).toBeGreaterThan(0);
  });

  it('发布目录按平台与架构分开，清单名照 electron-builder', () => {
    expect(feedUrl(GLOBAL, 'darwin', 'arm64')).toBe(
      'https://download.example/desktop/darwin-arm64/',
    );
    expect(manifestFile('latest', 'darwin')).toBe('latest-mac.yml');
    expect(manifestFile('beta', 'win32')).toBe('beta.yml');
    expect(manifestFile('latest', 'linux')).toBe('latest-linux.yml');
    expect(channelNames('stable')).toEqual(['latest']);
    expect(channelNames('dev')).toEqual(['latest', 'beta']);
  });

  it('WEVIR_UPDATE_MIRRORS 换线路，格式不对时不用', () => {
    expect(mirrorsFromEnv('global=http://127.0.0.1:8701/,optimized=http://127.0.0.1:8702')).toEqual(
      [
        { id: 'global', url: 'http://127.0.0.1:8701' },
        { id: 'optimized', url: 'http://127.0.0.1:8702' },
      ],
    );
    expect(mirrorsFromEnv(undefined)).toBeUndefined();
    expect(mirrorsFromEnv('global=ftp://x')).toBeUndefined();
  });
});

describe('verifyManifest / parseManifest', () => {
  const { privateKey, publicKey } = testKeyPair();
  const other = testKeyPair();
  const text = manifestText('0.2.0');

  it('任何一把内置公钥验过就通过；改一个字节、换了私钥、没有公钥都不通过', () => {
    const signature = signText(text, privateKey);
    expect(verifyManifest(Buffer.from(text), signature, [other.publicKey, publicKey])).toBe(true);
    expect(
      verifyManifest(Buffer.from(text.replace('0.2.0', '0.2.1')), signature, [publicKey]),
    ).toBe(false);
    expect(verifyManifest(Buffer.from(text), signText(text, other.privateKey), [publicKey])).toBe(
      false,
    );
    expect(verifyManifest(Buffer.from(text), signature, [])).toBe(false);
    expect(verifyManifest(Buffer.from(text), 'not-base64', [publicKey])).toBe(false);
  });

  it('文件只能是发布目录里的相对路径', () => {
    expect(parseManifest(text).version).toBe('0.2.0');
    expect(() => parseManifest(manifestText('0.2.0', 'https://evil.example/x.zip'))).toThrow(
      'outside',
    );
    expect(() => parseManifest(manifestText('0.2.0', '../x.zip'))).toThrow('outside');
    expect(() => parseManifest('version: banana\nfiles: []')).toThrow('version');
  });

  it('installerFile：macOS 取 zip，Windows 取 exe', () => {
    const info = parseManifest(
      'version: 0.2.0\nfiles:\n  - url: a.zip\n    sha512: A\n  - url: a.dmg\n    sha512: B\n  - url: a.exe\n    sha512: C\n',
    );
    expect(installerFile(info, 'darwin')).toBe('a.zip');
    expect(installerFile(info, 'win32')).toBe('a.exe');
  });
});

describe('readMirror / raceMirrors', () => {
  const { privateKey, publicKey } = testKeyPair();
  const base = (mirror: { url: string }) => `${mirror.url}/desktop/darwin-arm64/`;
  function routes(mirror: { url: string }, latest: string | undefined, beta?: string) {
    const r: Record<string, string> = {};
    if (latest !== undefined) {
      r[`${base(mirror)}latest-mac.yml`] = manifestText(latest);
      r[`${base(mirror)}latest-mac.yml.sig`] = signText(manifestText(latest), privateKey);
    }
    if (beta !== undefined) {
      r[`${base(mirror)}beta-mac.yml`] = manifestText(beta);
      r[`${base(mirror)}beta-mac.yml.sig`] = signText(manifestText(beta), privateKey);
    }
    return r;
  }
  const read =
    (fetcher: Fetcher, channel: 'stable' | 'dev') => (mirror: typeof GLOBAL, signal: AbortSignal) =>
      readMirror({
        mirror,
        channel,
        platform: 'darwin',
        arch: 'arm64',
        publicKeys: [publicKey],
        fetcher,
        signal,
      });

  it('开发版读 latest 与 beta 取高的：正式版发布后开发版用户也收到它', async () => {
    const newerStable = fakeServer(routes(GLOBAL, '0.3.0', '0.3.0-beta.4'));
    const { first } = await raceMirrors({
      mirrors: [GLOBAL],
      timeoutMs: 1000,
      read: read(newerStable.fetcher, 'dev'),
    });
    expect(first.info.version).toBe('0.3.0');
    const newerBeta = fakeServer(routes(GLOBAL, '0.3.0', '0.3.1-beta.1'));
    const dev = await raceMirrors({
      mirrors: [GLOBAL],
      timeoutMs: 1000,
      read: read(newerBeta.fetcher, 'dev'),
    });
    expect(dev.first.info.version).toBe('0.3.1-beta.1');
    const stable = await raceMirrors({
      mirrors: [GLOBAL],
      timeoutMs: 1000,
      read: read(newerBeta.fetcher, 'stable'),
    });
    expect(stable.first.info.version).toBe('0.3.0');
    expect(newerBeta.requests.some((r) => r.url.endsWith('beta-mac.yml'))).toBe(true);
  });

  it('还没发过正式版：开发版只读 beta；该通道一份清单都没有时报 empty（不是连不上）', async () => {
    const betaOnly = fakeServer({
      ...routes(GLOBAL, undefined, '0.0.1-beta.180'),
      ...routes(OPTIMIZED, undefined, '0.0.1-beta.180'),
    });
    const dev = await raceMirrors({
      mirrors: [GLOBAL, OPTIMIZED],
      timeoutMs: 1000,
      read: read(betaOnly.fetcher, 'dev'),
    });
    expect(dev.first.info.version).toBe('0.0.1-beta.180');

    const error = await raceMirrors({
      mirrors: [GLOBAL, OPTIMIZED],
      timeoutMs: 1000,
      read: read(betaOnly.fetcher, 'stable'),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpdateFeedError);
    expect((error as UpdateFeedError).empty).toBe(true);
    expect((error as UpdateFeedError).tampered).toBe(false);

    // 一条线路没有清单、另一条连不上：不算 empty。
    const half: Fetcher = (url, init) =>
      url.startsWith(OPTIMIZED.url)
        ? Promise.reject(new Error('connect ECONNREFUSED'))
        : betaOnly.fetcher(url, init);
    const mixed = await raceMirrors({
      mirrors: [GLOBAL, OPTIMIZED],
      timeoutMs: 1000,
      read: read(half, 'stable'),
    }).catch((e: unknown) => e);
    expect((mixed as UpdateFeedError).empty).toBe(false);
  });

  it('先给出验过签的清单的线路胜出；慢的那条在后台跑完，结果给测速用', async () => {
    const server = fakeServer(
      { ...routes(GLOBAL, '0.2.0'), ...routes(OPTIMIZED, '0.2.0') },
      { delayMs: { [GLOBAL.url]: 80 } },
    );
    const { first, rest } = await raceMirrors({
      mirrors: [GLOBAL, OPTIMIZED],
      timeoutMs: 1000,
      read: read(server.fetcher, 'stable'),
    });
    expect(first.mirror.id).toBe('optimized');
    expect((await rest).map((m) => m.mirror.id)).toEqual(['global']);
  });

  it('签名不对的线路被跳过；都不行时报出每条线路的原因，篡改与连不上分开', async () => {
    const tampered = {
      ...routes(GLOBAL, '0.2.0'),
      [`${base(GLOBAL)}latest-mac.yml`]: manifestText('9.9.9'),
    };
    const server = fakeServer({ ...tampered, ...routes(OPTIMIZED, '0.2.0') });
    const { first } = await raceMirrors({
      mirrors: [GLOBAL, OPTIMIZED],
      timeoutMs: 1000,
      read: read(server.fetcher, 'stable'),
    });
    expect(first.mirror.id).toBe('optimized');

    const none = fakeServer(tampered);
    const error = await raceMirrors({
      mirrors: [GLOBAL, OPTIMIZED],
      timeoutMs: 1000,
      read: read(none.fetcher, 'stable'),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpdateFeedError);
    expect((error as UpdateFeedError).tampered).toBe(true);
    expect((error as UpdateFeedError).failures.map((f) => [f.mirror.id, f.reason]).sort()).toEqual([
      ['global', 'signature'],
      ['optimized', 'empty'],
    ]);
  });

  it('整体超时', async () => {
    const server = fakeServer(routes(GLOBAL, '0.2.0'), { delayMs: { [GLOBAL.url]: 500 } });
    await expect(
      raceMirrors({ mirrors: [GLOBAL], timeoutMs: 30, read: read(server.fetcher, 'stable') }),
    ).rejects.toBeInstanceOf(UpdateFeedError);
  });
});

describe('pickDownloadMirror', () => {
  const info = parseManifest(manifestText('0.2.0'));
  const candidate = (mirror: typeof GLOBAL, latencyMs: number) => ({
    mirror,
    info,
    baseUrl: `${mirror.url}/desktop/darwin-arm64/`,
    latencyMs,
  });
  const zip = new Uint8Array(PROBE_BYTES * 2);
  const files = {
    [`${GLOBAL.url}/desktop/darwin-arm64/Wevir-0.2.0-mac-arm64.zip`]: zip,
    [`${OPTIMIZED.url}/desktop/darwin-arm64/Wevir-0.2.0-mac-arm64.zip`]: zip,
  };

  it('按安装包开头一段的下载速度选，不按谁先给清单', async () => {
    const server = fakeServer(files, { delayMs: { [GLOBAL.url]: 60 } });
    const { chosen, bytesPerMs } = await pickDownloadMirror({
      candidates: [candidate(GLOBAL, 5), candidate(OPTIMIZED, 40)],
      file: (c) => c.baseUrl + installerFile(c.info, 'darwin'),
      fetcher: server.fetcher,
      timeoutMs: 1000,
    });
    expect(chosen.mirror.id).toBe('optimized');
    expect(bytesPerMs.size).toBe(2);
    expect(server.requests.every((r) => r.range === `bytes=0-${PROBE_BYTES - 1}`)).toBe(true);
  });

  it('不认 Range 的线路不参加比较；只有一条时不测', async () => {
    const server = fakeServer(files, { rangeless: true });
    const { chosen } = await pickDownloadMirror({
      candidates: [candidate(GLOBAL, 5), candidate(OPTIMIZED, 40)],
      file: (c) => c.baseUrl + installerFile(c.info, 'darwin'),
      fetcher: server.fetcher,
      timeoutMs: 1000,
    });
    expect(chosen.mirror.id).toBe('global');
    const single = fakeServer(files);
    await pickDownloadMirror({
      candidates: [candidate(GLOBAL, 5)],
      file: (c) => c.baseUrl,
      fetcher: single.fetcher,
      timeoutMs: 1000,
    });
    expect(single.requests).toEqual([]);
  });
});
