// 运行体的下载安装（installation.ts）对着本机的假下载服务器：成功（含校验运行体）、sha256 不对、断线后用 Range 接着下、
// 服务器不支持 Range、卡住、取消、HTTP 错误、不安全的压缩包、校验失败、连不上 dl.google.com 时的说明。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  ANTIGRAVITY_CLI_MINIMUM_VERSION,
  ANTIGRAVITY_RELEASE_VERSION,
  type AntigravityCliReleaseAsset,
  type AntigravityReleaseAsset,
  antigravityCliManifestUrl,
  antigravityDownloadUrl,
  matchesReleaseVersion,
  parseAntigravityCliRelease,
  resolveAntigravityReleaseAsset,
} from './release.js';
import { INITIALIZE_1_4_1 } from './test-fixtures/acp-samples.js';
import {
  buildZip,
  collectingLogger,
  fakeRuntimeFiles,
  installFakeRuntime,
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
          // 半关（FIN）而不是 destroy：destroy 会丢掉还在发送缓冲里的数据，机器忙时客户端可能一个字节都没收到，
          // 也就没有可以接着下的部分。半关时已写出的数据都送到，响应在 content-length 之前断掉。
          res.socket?.end();
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
  asset: AntigravityReleaseAsset | AntigravityCliReleaseAsset | undefined,
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

function nativeArchive(symlink = false): Buffer {
  const directory = tempDir();
  try {
    if (symlink) {
      symlinkSync('/bin/sh', path.join(directory, 'antigravity'));
    } else {
      writeFileSync(path.join(directory, 'antigravity'), files.executable);
    }
    const archive = path.join(directory, 'cli.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', directory, 'antigravity']);
    return readFileSync(archive);
  } finally {
    removeDir(directory);
  }
}

function nativeManifest(assetPath: string, archive: Buffer, version = '1.5.13') {
  return {
    version,
    url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-42/${assetPath}`,
    sha512: createHash('sha512').update(archive).digest('hex'),
  };
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
    const asset = assetFor(await serve(ZIP, { range: false }));
    const target = installation(asset);
    // 直接放一段没下完的部分（内容故意不对），不靠断线留下：连接提前断开时 fetch 会丢掉已收到、还没读走的数据，
    // 机器忙时可能一个字节都留不下。从头下才能通过 sha256。
    mkdirSync(path.dirname(partialPath(asset)), { recursive: true });
    writeFileSync(partialPath(asset), Buffer.alloc(64 * 1024, 1));
    await target.install(() => {});
    expect(requests).toHaveLength(1);
    expect(requests[0]?.range).toBe(`bytes=${64 * 1024}-`);
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

  it('启动时删掉 active.json 没指着的发布与别的发布的半截下载；没装过时什么都不做', async () => {
    const url = await serve(ZIP);
    const asset = assetFor(url);
    const target = installation(asset);
    await target.removeInactiveReleases();
    expect(existsSync(target.managedDirectory)).toBe(false);

    await target.install(() => {});
    const versions = path.join(target.managedDirectory, 'versions');
    const downloads = path.join(target.managedDirectory, 'downloads');
    const stale = path.join(versions, 'a'.repeat(64));
    mkdirSync(stale, { recursive: true });
    writeFileSync(path.join(stale, 'agy_acp_server.par'), 'old');
    writeFileSync(path.join(downloads, `${'b'.repeat(64)}.zip.part`), 'old');
    writeFileSync(path.join(downloads, `${asset.sha256}.zip.part`), 'resume');

    await target.removeInactiveReleases();
    expect(readdirSync(versions)).toEqual([asset.sha256]);
    expect(readdirSync(downloads)).toEqual([`${asset.sha256}.zip.part`]);
    expect(await target.resolve()).toMatchObject({ source: 'managed' });
  });

  it('保留旧版安装，使用官方清单和镜像续传新版，成功后才切换', async () => {
    const platform = { platform: 'darwin', arch: 'arm64' } as const;
    const legacy = await installation(assetFor(await serve(ZIP)), platform).install(() => {});
    const archive = nativeArchive();
    const manifest = nativeManifest('darwin-arm/cli_mac_arm64.tar.gz', archive);
    let latest = manifest;
    const mirror = 'https://mirror.example';
    const download = new URL(manifest.url).pathname;
    const seen: Array<{ url: string; range: string | null }> = [];
    const target = installation(undefined, {
      ...platform,
      env: { ...process.env, WEVIR_ANTIGRAVITY_MIRROR: mirror },
      fetch: async (input, options) => {
        const url = String(input);
        const range = new Headers(options?.headers).get('range');
        seen.push({ url, range });
        if (url === antigravityCliManifestUrl(platform.platform, platform.arch)) {
          return Response.json(latest);
        }
        expect(url).toBe(mirror + download);
        return new Response(new Uint8Array(archive.subarray(16)), {
          status: 206,
          headers: { 'content-range': `bytes 16-${archive.length - 1}/${archive.length}` },
        });
      },
    });
    const downloads = path.join(target.managedDirectory, 'downloads');
    writeFileSync(path.join(downloads, `${manifest.sha512}.tar.gz.part`), archive.subarray(0, 16));
    expect(await target.resolve()).toEqual(legacy);
    expect(seen).toEqual([]);
    const progress: InstallProgress[] = [];
    const installed = await target.install((p) => progress.push(p));
    expect(installed).toMatchObject({
      source: 'managed',
      kind: 'native',
      harnessPath: null,
      version: '1.5.13',
    });
    expect(seen).toEqual([
      { url: antigravityCliManifestUrl(platform.platform, platform.arch), range: null },
      { url: mirror + download, range: 'bytes=16-' },
    ]);
    expect(progress).toContainEqual({
      phase: 'verifying',
      completedBytes: archive.length,
      totalBytes: archive.length,
    });
    expect(await target.resolve()).toEqual(installed);
    latest = nativeManifest('darwin-arm/cli_mac_arm64.tar.gz', archive, '1.5.1');
    expect(await target.install(() => {})).toEqual(installed);
    expect(seen).toHaveLength(3);
    expect(existsSync(legacy.executablePath)).toBe(true);
    await target.removeInactiveReleases();
    expect(existsSync(legacy.executablePath)).toBe(false);
  });

  it('安装 Windows 官方的单文件发布，并用 CLI 自报版本核对', async () => {
    const manifest = nativeManifest('windows-arm/cli_windows_arm64.exe', files.executable);
    const target = installation(undefined, {
      platform: 'win32',
      arch: 'arm64',
      validate: async () => {},
      fetch: async (input) =>
        String(input) === antigravityCliManifestUrl('win32', 'arm64')
          ? Response.json(manifest)
          : new Response(new Uint8Array(files.executable)),
    });
    const installed = await target.install(() => {});
    expect(path.basename(installed.executablePath)).toBe('agy.exe');
    expect(installed).toMatchObject({ kind: 'native', version: '1.5.13', harnessPath: null });
    expect(readFileSync(installed.executablePath)).toEqual(files.executable);
  });

  it.each(['checksum', 'symlink', 'version'] as const)(
    '拒绝 SHA-512、归档或版本校验失败的新版（%s）',
    async (failure) => {
      const archive = nativeArchive(failure === 'symlink');
      const version = failure === 'version' ? '1.5.1' : '1.5.13';
      const manifest = nativeManifest('darwin-arm/cli_mac_arm64.tar.gz', archive, version);
      if (failure === 'checksum') manifest.sha512 = 'a'.repeat(128);
      const target = installation(undefined, {
        platform: 'darwin',
        arch: 'arm64',
        fetch: async (input) =>
          String(input) === antigravityCliManifestUrl('darwin', 'arm64')
            ? Response.json(manifest)
            : new Response(new Uint8Array(archive)),
      });
      const messages = {
        checksum: /SHA-512/u,
        symlink: /extract/u,
        version: /verified as version/u,
      };
      await expect(target.install(() => {})).rejects.toThrow(messages[failure]);
      await expect(target.resolve()).rejects.toThrow(/not installed/u);
    },
  );

  it('从 PATH 和显式路径发现已安装的 agy，拒绝低于最低版本的原生 CLI', async () => {
    const executable = installFakeRuntime(path.join(home, 'bin'), { native: true });
    const target = installation(undefined, {
      env: { ...process.env, PATH: path.dirname(executable) },
    });
    expect(await target.resolve()).toMatchObject({
      executablePath: executable,
      kind: 'native',
      source: 'path',
      version: '1.5.13',
    });
    expect(await target.resolve(executable)).toMatchObject({ source: 'override' });

    const old = installation(undefined, { env: { ...process.env, FAKE_AGY_CLI_VERSION: '1.5.0' } });
    await expect(old.resolve(executable)).rejects.toThrow(
      `Version ${ANTIGRAVITY_CLI_MINIMUM_VERSION} or later is required.`,
    );
  });

  it('运行体自报的不是这个发布：校验失败，不启用', async () => {
    const asset = assetFor(await serve(ZIP));
    const target = installation(asset, {
      env: { ...process.env, FAKE_AGY_NAME: 'something-else' },
    });
    await expect(target.install(() => {})).rejects.toThrow(/did not identify/);
    await expect(target.resolve()).rejects.toThrow(/not installed/);
  });

  it.each([
    [
      'OSError: [Errno 97] Address family not supported by protocol: enforce_kernel_ipv6_support',
      /requires IPv6 socket support/,
    ],
    [
      'external/base/allocator/page-size.cc:42 Compile-time page size does not match run-time page size',
      /4 KiB memory pages/,
    ],
    ['Segmentation fault', /could not start in this environment/],
  ])('运行体一启动就退出：按 stderr 说明原因（%s）', async (stderr, message) => {
    const asset = assetFor(await serve(ZIP));
    const target = installation(asset, {
      env: { ...process.env, FAKE_AGY_EXIT_AT_START: '1', FAKE_AGY_START_STDERR: stderr },
    });
    await expect(target.install(() => {})).rejects.toThrow(message);
    await expect(target.resolve()).rejects.toThrow(/not installed/);
  });

  it('linux-arm64 的内核内存页大于 4 KiB：下载之前就说明，不下载', async () => {
    const asset = assetFor(await serve(ZIP));
    const sizes: Array<number | undefined> = [16_384, undefined];
    const target = installation(asset, {
      platform: 'linux',
      arch: 'arm64',
      pageSize: async () => sizes.shift(),
    });
    await expect(target.install(() => {})).rejects.toMatchObject({
      operation: 'download',
      message: expect.stringMatching(/4 KiB memory pages/),
    });
    expect(requests).toHaveLength(0);
    // 读不到页大小时不拦。
    await target.install(() => {});
    expect(requests).toHaveLength(1);
  });

  it('Intel Mac：核对 sha256 之后 ad-hoc 重新签名两个文件，记下签名后的大小（之后 resolve 认得出）；别的平台不签', async () => {
    const asset = assetFor(await serve(ZIP));
    const signed: string[][] = [];
    // codesign 改写签名，文件大小随之变化。
    const codesign = async (paths: readonly string[]) => {
      signed.push([...paths]);
      for (const file of paths) appendFileSync(file, '\n// ad-hoc signature\n');
    };
    const target = installation(asset, { platform: 'darwin', arch: 'x64', codesign });
    const installed = await target.install(() => {});
    // 签的是解包目录里的文件（之后整个目录挪到 versions/<sha256>/）。
    expect(signed.map((paths) => paths.map((file) => path.basename(file)))).toEqual([
      [path.basename(installed.executablePath), path.basename(installed.harnessPath ?? '')],
    ]);
    const resolved = await installation(asset, {
      platform: 'darwin',
      arch: 'x64',
      codesign,
    }).resolve();
    expect(resolved).toMatchObject({ source: 'managed', version: ANTIGRAVITY_RELEASE_VERSION });
    expect(statSync(resolved.executablePath).size).toBeGreaterThan(asset.executable.bytes);

    await installation(asset, { platform: 'darwin', arch: 'arm64', codesign }).install(() => {});
    expect(signed).toHaveLength(1);
  });

  it('Intel Mac：codesign 失败时安装失败并说明，不启用', async () => {
    const asset = assetFor(await serve(ZIP));
    const target = installation(asset, {
      platform: 'darwin',
      arch: 'x64',
      codesign: async () => {
        throw new Error('codesign exited with 1');
      },
    });
    await expect(target.install(() => {})).rejects.toMatchObject({
      operation: 'extract',
      message: expect.stringMatching(/codesign is available/),
    });
    await expect(target.resolve()).rejects.toThrow(/not installed/);
  });

  it('钉住的发布是 1.4.5：六个平台的地址、sha256 与大小（官方发布清单，macOS arm64 已实测），运行体自报的版本认得出', () => {
    expect(ANTIGRAVITY_RELEASE_VERSION).toBe('1.4.5');
    const platforms = [
      [
        'darwin',
        'arm64',
        'macos/agy-acp-server-1.4.5-darwin-arm64.zip',
        '886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f',
        97_923_855,
      ],
      [
        'darwin',
        'x64',
        'macos/agy-acp-server-1.4.5-darwin-x86_64.zip',
        'b39f3573c03b9acb9df028853f647527f1f3133f32bd77e78b796e48a205114a',
        103_577_295,
      ],
      [
        'linux',
        'x64',
        'linux/agy-acp-server-1.4.5-linux-x86_64.zip',
        '923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b',
        321_783_181,
      ],
      [
        'linux',
        'arm64',
        'linux/agy-acp-server-1.4.5-linux-arm64.zip',
        '7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056',
        307_829_008,
      ],
      [
        'win32',
        'x64',
        'windows/agy-acp-server-1.4.5-windows-x86_64.zip',
        'd24f4c73c9f96d4f44384e281c855a56c72d8eaa9c5b0fad7ccb1635c6b63f50',
        100_423_655,
      ],
      [
        'win32',
        'arm64',
        'windows/agy-acp-server-1.4.5-windows-arm64.zip',
        'ab0a9aac8349e08ef289be6d16da8f89e3abe60eba5158032ef78c4a1220261c',
        102_703_121,
      ],
    ] as const;
    for (const [platform, arch, file, sha256, archiveBytes] of platforms) {
      expect(resolveAntigravityReleaseAsset(platform, arch)).toMatchObject({
        version: '1.4.5',
        url: `https://dl.google.com/agy-extensions/releases/${file}`,
        sha256,
        archiveBytes,
      });
    }
    expect(resolveAntigravityReleaseAsset('darwin', 'arm64')).toMatchObject({
      executable: { name: 'agy_acp_server.par', bytes: 178_915_920 },
      harness: { name: 'localharness_external', bytes: 122_957_936 },
    });
    expect(resolveAntigravityReleaseAsset('win32', 'x64')).toMatchObject({
      executable: { name: 'agy_acp_server.exe', bytes: 55_839_864 },
      harness: { name: 'localharness_external.exe', bytes: 147_843_736 },
    });
    // 真实 1.4.5 的 initialize 报裸版本号。
    expect(matchesReleaseVersion('1.4.5', ANTIGRAVITY_RELEASE_VERSION)).toBe(true);
    expect(matchesReleaseVersion(INITIALIZE_1_4_1.agentInfo.version, '1.4.1')).toBe(true);
    expect(matchesReleaseVersion('1.3.0', ANTIGRAVITY_RELEASE_VERSION)).toBe(false);
  });

  it('连不上 dl.google.com：说明在大陆网络下的出路，下载地址可以换成镜像', async () => {
    const asset = resolveAntigravityReleaseAsset('darwin', 'arm64') as AntigravityReleaseAsset;
    expect(antigravityDownloadUrl(asset, {})).toBe(asset.url);
    expect(
      antigravityDownloadUrl(asset, {
        WEVIR_ANTIGRAVITY_MIRROR: 'https://mirror.example.cn/google/',
      }),
    ).toBe(
      'https://mirror.example.cn/google/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-arm64.zip',
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

describe('Antigravity CLI manifest', () => {
  it.each([
    ['darwin', 'arm64', false, 'darwin_arm64', 'darwin-arm/cli_mac_arm64.tar.gz'],
    ['darwin', 'x64', false, 'darwin_amd64', 'darwin-x64/cli_mac_x64.tar.gz'],
    ['linux', 'arm64', false, 'linux_arm64', 'linux-arm/cli_linux_arm64.tar.gz'],
    ['linux', 'x64', false, 'linux_amd64', 'linux-x64/cli_linux_x64.tar.gz'],
    ['linux', 'arm64', true, 'linux_arm64_musl', 'linux-arm-musl/cli_linux_arm64_musl.tar.gz'],
    ['linux', 'x64', true, 'linux_amd64_musl', 'linux-x64-musl/cli_linux_x64_musl.tar.gz'],
    ['win32', 'arm64', false, 'windows_arm64', 'windows-arm/cli_windows_arm64.exe'],
    ['win32', 'x64', false, 'windows_amd64', 'windows-x64/cli_windows_x64.exe'],
  ] as const)('解析 %s %s（musl %s）的官方发布', (platform, arch, musl, target, assetPath) => {
    const manifest = nativeManifest(assetPath, files.executable);
    expect(antigravityCliManifestUrl(platform, arch, musl)).toBe(
      `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${target}.json`,
    );
    expect(parseAntigravityCliRelease(manifest, platform, arch, musl)).toEqual({
      ...manifest,
      format: platform === 'win32' ? 'executable' : 'tar.gz',
    });
  });

  it('排除低于最低版本、校验值错误、第三方主机和不匹配的平台归档', () => {
    const arm = nativeManifest('darwin-arm/cli_mac_arm64.tar.gz', files.executable, '1.5.1');
    expect(parseAntigravityCliRelease(arm, 'darwin', 'arm64')).toBeDefined();
    for (const manifest of [
      nativeManifest('darwin-arm/cli_mac_arm64.tar.gz', files.executable, '1.5.0'),
      { ...arm, sha512: 'bad' },
      { ...arm, url: arm.url.replace('storage.googleapis.com', 'mirror.example') },
      { ...arm, url: `${arm.url}?redirect=true` },
      nativeManifest('darwin-x64/cli_mac_x64.tar.gz', files.executable, '1.5.1'),
    ]) {
      expect(parseAntigravityCliRelease(manifest, 'darwin', 'arm64')).toBeUndefined();
    }
    expect(antigravityCliManifestUrl('freebsd', 'x64')).toBeUndefined();
  });
});
