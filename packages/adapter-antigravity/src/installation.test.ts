// 运行体的下载安装（installation.ts）对着本机的假下载服务器：成功（含校验运行体）、sha256 不对、断线后用 Range 接着下、
// 服务器不支持 Range、卡住、取消、HTTP 错误、不安全的压缩包、校验失败、连不上 dl.google.com 时的说明。

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AntigravityInstallation,
  AntigravityInstallationError,
  AntigravityInstallCancelled,
  type InstallProgress,
} from './installation.js';
import {
  type AntigravityRuntimeContext,
  antigravityPaths,
  validateAntigravityRuntime,
} from './process.js';
import {
  ANTIGRAVITY_RELEASE_VERSION,
  type AntigravityReleaseAsset,
  antigravityDownloadUrl,
  resolveAntigravityReleaseAsset,
} from './release.js';
import {
  buildZip,
  collectingLogger,
  fakeRuntimeFiles,
  removeDir,
  tempDir,
} from './test-fixtures/runtime.js';

interface ServeOptions {
  /** 第一个请求发到这么多字节就断开连接。 */
  dropAfter?: number;
  /** 发到这么多字节就停住不动（不关连接）。 */
  stallAfter?: number;
  /** 支持 Range（默认是）。 */
  range?: boolean;
  status?: number;
  /** 每块之间等多久（ms）。 */
  chunkDelayMs?: number;
}

const files = fakeRuntimeFiles();
const ZIP = buildZip([
  { name: 'agy_acp_server.par', data: files.executable },
  { name: 'localharness_external', data: files.harness },
]);

let home: string;
let server: Server | undefined;
let requests: Array<{ url: string; range?: string; encoding?: string }>;

beforeEach(() => {
  home = tempDir();
  requests = [];
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server?.closeAllConnections();
  server = undefined;
  removeDir(home);
});

async function serve(body: Buffer, options: ServeOptions = {}): Promise<string> {
  let count = 0;
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    count += 1;
    const first = count === 1;
    requests.push({
      url: req.url ?? '',
      ...(req.headers.range !== undefined && { range: req.headers.range }),
      ...(req.headers['accept-encoding'] !== undefined && {
        encoding: String(req.headers['accept-encoding']),
      }),
    });
    if (options.status !== undefined) {
      res.writeHead(options.status).end('nope');
      return;
    }
    let start = 0;
    const range = /^bytes=(\d+)-$/u.exec(req.headers.range ?? '');
    if (range && options.range !== false) {
      start = Number(range[1]);
      res.writeHead(206, {
        'content-length': String(body.length - start),
        'content-range': `bytes ${start}-${body.length - 1}/${body.length}`,
      });
    } else {
      res.writeHead(200, { 'content-length': String(body.length) });
    }
    const slice = body.subarray(start);
    const step = 4096;
    let sent = 0;
    const pump = () => {
      while (sent < slice.length) {
        if (first && options.dropAfter !== undefined && start + sent >= options.dropAfter) {
          res.socket?.destroy();
          return;
        }
        if (options.stallAfter !== undefined && start + sent >= options.stallAfter) return;
        const part = slice.subarray(sent, sent + step);
        sent += part.length;
        res.write(part);
        if (options.chunkDelayMs !== undefined) {
          setTimeout(pump, options.chunkDelayMs);
          return;
        }
        // 要断开的连接一块一块地发，断开之前前面的数据已经送出去。
        if (options.dropAfter !== undefined) {
          setImmediate(pump);
          return;
        }
      }
      res.end();
    };
    pump();
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}/agy-extensions/releases/macos/agy-acp-server-test.zip`;
}

function assetFor(url: string, body = ZIP): AntigravityReleaseAsset {
  return {
    version: ANTIGRAVITY_RELEASE_VERSION,
    url,
    sha256: createHash('sha256').update(body).digest('hex'),
    archiveBytes: body.length,
    executable: { name: 'agy_acp_server.par', bytes: files.executable.length },
    harness: { name: 'localharness_external', bytes: files.harness.length },
  };
}

function installation(
  asset: AntigravityReleaseAsset,
  extra: Partial<ConstructorParameters<typeof AntigravityInstallation>[0]> = {},
): AntigravityInstallation {
  const paths = antigravityPaths(home);
  const env = { ...process.env, ...extra.env };
  const context: AntigravityRuntimeContext = {
    installation: undefined as unknown as AntigravityInstallation,
    paths,
    env,
    customPath: () => null,
    logger: collectingLogger(),
  };
  const created = new AntigravityInstallation({
    directory: paths.root,
    env,
    platform: process.platform,
    releaseAsset: asset,
    validate: (executable, version, signal) =>
      validateAntigravityRuntime(context, executable, version, signal),
    progressIntervalMs: 0,
    ...extra,
  });
  context.installation = created;
  return created;
}

function partialPath(asset: AntigravityReleaseAsset): string {
  return path.join(
    home,
    'engines',
    'antigravity',
    'runtime',
    `${process.platform}-${process.arch}`,
    'downloads',
    `${asset.sha256}.zip.part`,
  );
}

const posix = process.platform !== 'win32';

describe.skipIf(!posix)('AntigravityInstallation', () => {
  it('下载、核对 sha256、解包、启动校验后启用：之后 resolve 找到 Wevir 装的版本', async () => {
    const asset = assetFor(await serve(ZIP));
    const target = installation(asset);
    const progress: InstallProgress[] = [];
    const installed = await target.install((p) => progress.push(p));
    expect(installed).toMatchObject({ source: 'managed', version: ANTIGRAVITY_RELEASE_VERSION });
    expect(progress.some((p) => p.phase === 'downloading')).toBe(true);
    expect(progress.map((p) => p.phase)).toEqual(
      expect.arrayContaining(['downloading', 'extracting', 'verifying']),
    );
    expect(progress.at(-1)?.completedBytes).toBe(asset.archiveBytes);
    expect(requests[0]?.encoding).toBe('identity');
    const resolved = await target.resolve();
    expect(resolved.executablePath).toBe(
      path.join(target.managedDirectory, 'versions', asset.sha256, 'agy_acp_server.par'),
    );
    expect(statSync(resolved.executablePath).mode & 0o111).not.toBe(0);
    expect(existsSync(partialPath(asset))).toBe(false);
    // 校验用的临时 profile 不留下来。
    expect(
      readdirSync(path.join(home, 'engines', 'antigravity')).filter((n) =>
        n.startsWith('.validate-'),
      ),
    ).toEqual([]);
    // 再装一次：已经在了，只校验、重新启用。
    await target.install(() => {});
    expect(requests).toHaveLength(1);
  });

  it('sha256 不对：报错、什么都不装、删掉下载的文件', async () => {
    const asset = { ...assetFor(await serve(ZIP)), sha256: 'a'.repeat(64) };
    const target = installation(asset);
    await expect(target.install(() => {})).rejects.toThrow(/SHA-256 check/);
    await expect(target.resolve()).rejects.toThrow(/not installed/);
    expect(existsSync(partialPath(asset))).toBe(false);
  });

  it('断线：报错并留下没下完的部分，再装时用 Range 接着下', async () => {
    const asset = assetFor(await serve(ZIP, { dropAfter: Math.floor(ZIP.length / 3) }));
    const target = installation(asset);
    const failure = await target.install(() => {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AntigravityInstallationError);
    expect((failure as Error).message).toMatch(/partial download is kept/);
    const kept = statSync(partialPath(asset)).size;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(ZIP.length);

    await target.install(() => {});
    expect(requests).toHaveLength(2);
    expect(requests[1]?.range).toBe(`bytes=${kept}-`);
    await expect(target.resolve()).resolves.toMatchObject({ source: 'managed' });
  });

  it('服务器不支持 Range：从头重新下载，sha256 照样对', async () => {
    const asset = assetFor(await serve(ZIP, { dropAfter: 64 * 1024, range: false }));
    const target = installation(asset);
    await expect(target.install(() => {})).rejects.toThrow(/partial download is kept/);
    await target.install(() => {});
    expect(requests[1]?.range).toBeDefined();
    await expect(target.resolve()).resolves.toMatchObject({ source: 'managed' });
  });

  it('卡住（一段时间收不到数据）：报下载卡住', async () => {
    const asset = assetFor(await serve(ZIP, { stallAfter: 8192 }));
    const target = installation(asset, { idleTimeoutMs: 200 });
    await expect(target.install(() => {})).rejects.toThrow(/stalled/);
  });

  it('取消：抛 AntigravityInstallCancelled，没下完的留着，什么都没装', async () => {
    const asset = assetFor(await serve(ZIP, { chunkDelayMs: 20 }));
    const target = installation(asset);
    const progress: InstallProgress[] = [];
    const running = target.install((p) => progress.push(p));
    expect(target.installing).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    target.cancel();
    await expect(running).rejects.toBeInstanceOf(AntigravityInstallCancelled);
    expect(target.installing).toBe(false);
    await expect(target.resolve()).rejects.toThrow(/not installed/);
    expect(existsSync(partialPath(asset))).toBe(true);
  });

  it('HTTP 错误：说明状态码', async () => {
    const asset = assetFor(await serve(ZIP, { status: 404 }));
    await expect(installation(asset).install(() => {})).rejects.toThrow(/HTTP 404/);
  });

  it('压缩包里多了别的文件、或大小不对：拒绝解包', async () => {
    const extra = buildZip([
      { name: 'agy_acp_server.par', data: files.executable },
      { name: 'localharness_external', data: files.harness },
      { name: 'evil.sh', data: Buffer.from('echo') },
    ]);
    const extraAsset = assetFor(await serve(extra), extra);
    await expect(installation(extraAsset).install(() => {})).rejects.toThrow(
      /exactly the Antigravity/,
    );
    await new Promise<void>((resolve) => server?.close(() => resolve()));

    const renamed = buildZip([
      { name: 'agy_acp_server.bin', data: files.executable },
      { name: 'localharness_external', data: files.harness },
    ]);
    const renamedAsset = assetFor(await serve(renamed), renamed);
    await expect(installation(renamedAsset).install(() => {})).rejects.toThrow(
      /unexpected, unsafe, or incorrectly sized/,
    );
    await new Promise<void>((resolve) => server?.close(() => resolve()));

    // 往上一级的路径：yauzl 的 strictFileNames 先拒绝。
    const escaping = buildZip([
      { name: '../agy_acp_server.par', data: files.executable },
      { name: 'localharness_external', data: files.harness },
    ]);
    const escapingAsset = assetFor(await serve(escaping), escaping);
    await expect(installation(escapingAsset).install(() => {})).rejects.toThrow(
      /Could not extract|unsafe/,
    );
    expect(
      existsSync(path.join(home, 'engines', 'antigravity', 'runtime', 'agy_acp_server.par')),
    ).toBe(false);
  });

  it('运行体自报的不是这个发布：校验失败，不启用', async () => {
    const asset = assetFor(await serve(ZIP));
    const target = installation(asset, {
      env: { ...process.env, FAKE_AGY_NAME: 'something-else' },
    });
    await expect(target.install(() => {})).rejects.toThrow(/did not identify/);
    await expect(target.resolve()).rejects.toThrow(/not installed/);
  });

  it('连不上 dl.google.com：说明在大陆网络下的出路，下载地址可以换成镜像', async () => {
    const asset = resolveAntigravityReleaseAsset('darwin', 'arm64') as AntigravityReleaseAsset;
    expect(antigravityDownloadUrl(asset, {})).toBe(asset.url);
    expect(
      antigravityDownloadUrl(asset, {
        WEVIR_ANTIGRAVITY_MIRROR: 'https://mirror.example.cn/google/',
      }),
    ).toBe(
      'https://mirror.example.cn/google/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-arm64.zip',
    );

    const target = installation(asset, {
      fetch: async () => {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      },
      validate: async () => {},
    });
    const failure = (await target.install(() => {}).catch((error: unknown) => error)) as Error;
    expect(failure).toBeInstanceOf(AntigravityInstallationError);
    expect(failure.message).toContain('Could not reach dl.google.com (ECONNRESET)');
    expect(failure.message).toContain('WEVIR_ANTIGRAVITY_MIRROR');
    expect(failure.message).toContain('custom executable path');
  });

  it('指定的路径：可执行文件与同目录的 localharness_external 都要在', async () => {
    const target = installation(assetFor('http://127.0.0.1:9/unused.zip'));
    await expect(target.resolve(path.join(home, 'nowhere', 'agy_acp_server.par'))).rejects.toThrow(
      /custom Antigravity executable/,
    );
  });
});
