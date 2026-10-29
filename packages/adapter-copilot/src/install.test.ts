import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  COPILOT_RELEASE_URL,
  COPILOT_RELEASE_URL_ENV,
  CopilotInstallCancelled,
  CopilotInstallError,
  CopilotInstaller,
  type CopilotInstallProgress,
  copilotArchive,
  copilotReleaseUrl,
  parseChecksums,
} from './install.js';

// GitHub Release 的安装：假的发布服务器（本机 HTTP）给 latest/download/SHA256SUMS.txt 与 download/v<版本>/ 下的 tar.gz，包里只有
// copilot 一个文件，和真实的压缩包一样；解包用系统的 tar（和生产一样）。清单默认是 1.0.105 起的格式（npm 包只有分平台的），
// `redirectLatest` 时像 GitHub 一样把 latest 转到 download/v<版本>/。

function tarHeader(name: string, size: number, mode = '0000755'): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write(`${mode}\0`, 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

function tarEntry(name: string, content: string, mode?: string): Buffer {
  const data = Buffer.from(content);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([tarHeader(name, data.length, mode), data, padding]);
}

function tgz(entries: Buffer[]): Buffer {
  return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const ARCHIVE = { target: 'test-os-x64', format: 'tar.gz', fileName: 'copilot' } as const;
const ASSET = `copilot-${ARCHIVE.target}.tar.gz`;

interface Release {
  version: string;
  archive: Buffer;
  /** SHA256SUMS.txt 里写的 sha256，省略时按压缩包算。 */
  checksum?: string;
  /** 换掉整个 SHA256SUMS.txt。 */
  sums?: string;
}

let server: Server;
let origin = '';
let release: Release | undefined;
let latestStatus = 200;
let archiveHang = false;
let redirectLatest = false;
const hits: string[] = [];

function handle(request: IncomingMessage, response: ServerResponse) {
  hits.push(request.url ?? '');
  const url = new URL(request.url ?? '/', origin);
  if (latestStatus !== 200) {
    response.statusCode = latestStatus;
    response.end('no');
    return;
  }
  if (release === undefined) {
    response.statusCode = 404;
    response.end('not found');
    return;
  }
  if (redirectLatest && url.pathname === '/latest/download/SHA256SUMS.txt') {
    response.writeHead(302, { location: `/download/v${release.version}/SHA256SUMS.txt` });
    response.end();
    return;
  }
  if (
    url.pathname ===
    (redirectLatest
      ? `/download/v${release.version}/SHA256SUMS.txt`
      : '/latest/download/SHA256SUMS.txt')
  ) {
    response.end(
      release.sums ??
        [
          `${'0'.repeat(64)}  copilot-other-os-arm64.tar.gz`,
          `${release.checksum ?? sha256(release.archive)}  ${ASSET}`,
          `${'1'.repeat(64)}  github-copilot-${release.version}-other-os-arm64.tgz`,
          `${'2'.repeat(64)}  github-copilot-${release.version}-test-os-x64.tgz`,
        ].join('\n'),
    );
    return;
  }
  if (url.pathname === `/download/v${release.version}/${ASSET}`) {
    response.writeHead(200, { 'content-length': String(release.archive.length) });
    if (archiveHang) {
      response.write(release.archive.subarray(0, 10));
      return; // 不再发数据，也不结束
    }
    response.end(release.archive);
    return;
  }
  response.statusCode = 404;
  response.end('not found');
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const roots: string[] = [];
function fresh(): string {
  const root = mkdtempSync(join(tmpdir(), 'wevir-copilot-install-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  release = undefined;
  latestStatus = 200;
  archiveHang = false;
  redirectLatest = false;
  hits.length = 0;
});

function good(version = '1.0.103'): Release {
  return { version, archive: tgz([tarEntry('copilot', `binary ${version}`)]) };
}

function installer(
  directory: string,
  extra: Partial<ConstructorParameters<typeof CopilotInstaller>[0]> = {},
) {
  return new CopilotInstaller({
    directory,
    archive: ARCHIVE,
    releaseUrl: origin,
    progressIntervalMs: 0,
    ...extra,
  });
}

describe('copilotArchive', () => {
  it('官方发布的平台：macOS、Linux（glibc 与 musl）、Windows 的 arm64 与 x64，Windows 是 zip', () => {
    expect(copilotArchive('darwin', 'arm64')).toEqual({
      target: 'darwin-arm64',
      format: 'tar.gz',
      fileName: 'copilot',
    });
    expect(copilotArchive('darwin', 'x64')?.target).toBe('darwin-x64');
    expect(copilotArchive('linux', 'x64', () => false)?.target).toBe('linux-x64');
    expect(copilotArchive('linux', 'arm64', () => true)?.target).toBe('linuxmusl-arm64');
    expect(copilotArchive('win32', 'x64')).toEqual({
      target: 'win32-x64',
      format: 'zip',
      fileName: 'copilot.exe',
    });
    expect(copilotArchive('win32', 'arm64')?.target).toBe('win32-arm64');
    expect(copilotArchive('freebsd', 'x64')).toBeUndefined();
    expect(copilotArchive('linux', 'ia32')).toBeUndefined();
  });
  it('下载地址默认官方的 GitHub Release，可由环境变量换掉', () => {
    expect(copilotReleaseUrl({})).toBe(COPILOT_RELEASE_URL);
    expect(
      copilotReleaseUrl({ [COPILOT_RELEASE_URL_ENV]: ' https://mirror.example/releases/// ' }),
    ).toBe('https://mirror.example/releases');
  });
  it('SHA256SUMS.txt：文件名到 sha256，版本取自 npm 包的文件名（1.0.103 的格式）', () => {
    const { version, sums } = parseChecksums(
      [
        `${'A'.repeat(64)}  copilot-darwin-arm64.tar.gz`,
        `${'b'.repeat(64)}  github-copilot-1.0.103-darwin-arm64.tgz`,
        `${'c'.repeat(64)}  github-copilot-1.0.103.tgz`,
        'garbage line',
      ].join('\r\n'),
    );
    expect(version).toBe('1.0.103');
    expect(sums.get('copilot-darwin-arm64.tar.gz')).toBe('a'.repeat(64));
    expect(parseChecksums('').version).toBeUndefined();
    expect(
      parseChecksums(`${'b'.repeat(64)}  github-copilot-1.0.103-darwin-arm64.tgz`).version,
    ).toBeUndefined();
  });
  it('1.0.105 起只有分平台的 npm 包：去掉清单里出现过的平台名得到版本，预发布版本号也认', () => {
    const sums = (version: string) =>
      [
        `${'a'.repeat(64)}  copilot-win32-x64.zip`,
        `${'b'.repeat(64)}  copilot-darwin-arm64.tar.gz`,
        `${'c'.repeat(64)}  copilot-x64.msi`,
        `${'d'.repeat(64)}  github-copilot-${version}-darwin-arm64.tgz`,
        `${'e'.repeat(64)}  github-copilot-${version}-win32-x64.tgz`,
      ].join('\n');
    expect(parseChecksums(sums('1.0.105')).version).toBe('1.0.105');
    expect(parseChecksums(sums('1.0.106-0')).version).toBe('1.0.106-0');
    expect(
      parseChecksums(
        [
          `${'b'.repeat(64)}  copilot-darwin-arm64.tar.gz`,
          `${'d'.repeat(64)}  github-copilot-latest-darwin-arm64.tgz`,
        ].join('\n'),
      ).version,
    ).toBeUndefined();
  });
});

describe('CopilotInstaller', () => {
  it('装好：核对 sha256、整个压缩包解进 versions/<版本>，启动校验过才写指针', async () => {
    release = good();
    const root = fresh();
    const validated: string[] = [];
    const phases: CopilotInstallProgress['phase'][] = [];
    const subject = installer(root, {
      validate: async (file, version) => {
        validated.push(`${version}:${readFileSync(file, 'utf8')}`);
        // 指针还没写：校验失败不会留下半成品。
        expect(existsSync(join(root, 'active.json'))).toBe(false);
      },
    });
    expect(await subject.active()).toBeUndefined();
    const installed = await subject.install((progress) => {
      if (phases.at(-1) !== progress.phase) phases.push(progress.phase);
    });
    expect(installed).toEqual({
      path: join(root, 'versions', '1.0.103', 'copilot'),
      version: '1.0.103',
    });
    expect(validated).toEqual(['1.0.103:binary 1.0.103']);
    expect(phases).toEqual(['resolving', 'downloading', 'extracting', 'verifying']);
    expect(await subject.active()).toEqual(installed);
    if (process.platform !== 'win32') {
      expect(statSync(installed.path).mode & 0o111).not.toBe(0);
    }
    expect(readdirSync(join(root, 'versions'))).toEqual(['1.0.103']);
    expect(hits).toEqual([
      '/latest/download/SHA256SUMS.txt',
      '/download/v1.0.103/copilot-test-os-x64.tar.gz',
    ]);
  });

  it('进度带字节数；已是最新版时只核对一遍不重新下载；新版本换掉旧版本', async () => {
    release = good('1.0.1');
    const root = fresh();
    const subject = installer(root);
    const progress: CopilotInstallProgress[] = [];
    await subject.install((p) => progress.push(p));
    const downloading = progress.filter((p) => p.phase === 'downloading');
    expect(downloading.at(-1)).toMatchObject({
      completedBytes: release.archive.length,
      totalBytes: release.archive.length,
    });
    hits.length = 0;
    await subject.install(() => {});
    expect(hits).toEqual(['/latest/download/SHA256SUMS.txt']);

    release = good('1.0.2');
    await subject.install(() => {});
    expect((await subject.active())?.version).toBe('1.0.2');
    expect(readdirSync(join(root, 'versions'))).toEqual(['1.0.2']);
  });

  it('装好的那份校验失败时重新下载换掉它', async () => {
    release = good('3.0.0');
    const root = fresh();
    let fail = false;
    const subject = installer(root, {
      validate: async () => {
        if (fail) throw new Error('broken');
      },
    });
    await subject.install(() => {});
    fail = true;
    // 第二次装：已装的校验失败 → 重新下载后的校验仍失败 → 报错，指针不动
    await expect(subject.install(() => {})).rejects.toMatchObject({ operation: 'verify' });
    expect(hits.filter((hit) => hit.endsWith('.tar.gz'))).toHaveLength(2);
  });

  it('SHA256SUMS.txt 里的 sha256 不对：报错，什么都没装', async () => {
    release = { ...good(), checksum: 'a'.repeat(64) };
    const root = fresh();
    const subject = installer(root);
    const error = await subject.install(() => {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CopilotInstallError);
    expect(error).toMatchObject({
      operation: 'verify',
      message: expect.stringContaining('checksum'),
    });
    expect(await subject.active()).toBeUndefined();
    expect(readdirSync(join(root, 'versions'))).toEqual([]);
  });

  it('清单里认不出版本时用 latest 转向里的版本', async () => {
    redirectLatest = true;
    release = good('1.0.107');
    release = { ...release, sums: `${sha256(release.archive)}  ${ASSET}` };
    const root = fresh();
    expect(await installer(root).install(() => {})).toEqual({
      path: join(root, 'versions', '1.0.107', 'copilot'),
      version: '1.0.107',
    });
    expect(hits).toEqual([
      '/latest/download/SHA256SUMS.txt',
      '/download/v1.0.107/SHA256SUMS.txt',
      '/download/v1.0.107/copilot-test-os-x64.tar.gz',
    ]);
  });

  it('Release 里没有本平台、认不出版本、地址连不上：说明哪里出了问题', async () => {
    release = { ...good(), sums: `${'1'.repeat(64)}  github-copilot-1.0.103.tgz` };
    const root = fresh();
    await expect(installer(root).install(() => {})).rejects.toMatchObject({
      operation: 'resolve',
      message: expect.stringContaining(`no checksum for ${ASSET}`),
    });
    release = { ...good(), sums: `${'1'.repeat(64)}  ${ASSET}` };
    await expect(installer(root).install(() => {})).rejects.toMatchObject({
      operation: 'resolve',
      message: expect.stringContaining('no version'),
    });
    latestStatus = 503;
    await expect(installer(root).install(() => {})).rejects.toMatchObject({
      operation: 'resolve',
      message: expect.stringContaining('503'),
    });
    await expect(
      installer(root, { releaseUrl: 'http://127.0.0.1:1' }).install(() => {}),
    ).rejects.toMatchObject({
      operation: 'resolve',
      message: expect.stringContaining(COPILOT_RELEASE_URL_ENV),
    });
  });

  it('压缩包里没有程序文件、或条目路径越界：报错，不写到安装目录之外', async () => {
    const root = fresh();
    release = { version: '4.0.0', archive: tgz([tarEntry('share/only', 'x')]) };
    await expect(installer(root).install(() => {})).rejects.toMatchObject({
      operation: 'verify',
      message: expect.stringContaining('does not contain copilot'),
    });
    release = {
      version: '4.0.1',
      archive: tgz([tarEntry('copilot', 'x'), tarEntry('../escaped.txt', 'evil')]),
    };
    await expect(installer(root).install(() => {})).rejects.toMatchObject({
      operation: 'install',
      message: expect.stringContaining('unsafe path'),
    });
    expect(existsSync(join(root, 'escaped.txt'))).toBe(false);
    expect(existsSync(join(root, 'versions', 'escaped.txt'))).toBe(false);
    expect(readdirSync(join(root, 'versions'))).toEqual([]);
  });

  it('下载的程序跑不起来：报错，不留下半成品也不写指针', async () => {
    release = good();
    const root = fresh();
    const subject = installer(root, {
      validate: async () => {
        throw new Error('exec format error');
      },
    });
    await expect(subject.install(() => {})).rejects.toMatchObject({
      operation: 'verify',
      message: expect.stringContaining('exec format error'),
    });
    expect(await subject.active()).toBeUndefined();
    expect(readdirSync(join(root, 'versions'))).toEqual([]);
  });

  it('下载卡住超时、取消：已装的版本不受影响', async () => {
    release = good('5.0.0');
    const root = fresh();
    await installer(root).install(() => {});
    release = good('5.1.0');
    archiveHang = true;
    await expect(installer(root, { idleTimeoutMs: 100 }).install(() => {})).rejects.toMatchObject({
      operation: 'download',
      message: expect.stringContaining('no data'),
    });
    const subject = installer(root);
    const started = subject.install((progress) => {
      if (progress.phase === 'downloading' && progress.completedBytes > 0) subject.cancel();
    });
    await expect(started).rejects.toBeInstanceOf(CopilotInstallCancelled);
    expect(subject.installing).toBe(false);
    expect((await installer(root).active())?.version).toBe('5.0.0');
    expect(readdirSync(join(root, 'versions'))).toEqual(['5.0.0']);
  });

  it('同一时刻只有一次安装；先前遗留的 .install-* 目录被清掉', async () => {
    release = good();
    const root = fresh();
    const subject = installer(root);
    const first = subject.install(() => {});
    expect(subject.installing).toBe(true);
    const second = subject.install(() => {});
    expect(await second).toEqual(await first);
    expect(subject.installing).toBe(false);
    const leftover = join(root, 'versions', '.install-old');
    mkdirSync(leftover, { recursive: true });
    await subject.install(() => {});
    expect(existsSync(leftover)).toBe(false);
  });
});
