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
  WORKBUDDY_RELEASE_URL,
  WORKBUDDY_RELEASE_URL_ENV,
  WorkBuddyInstallCancelled,
  WorkBuddyInstallError,
  WorkBuddyInstaller,
  type WorkBuddyInstallProgress,
  workbuddyArchive,
  workbuddyReleaseUrl,
} from './install.js';

// 官方独立版本的安装：假的发布服务器（本机 HTTP）给 latest、checksums.txt 与 tar.gz，包里是一个程序加 vendor/ 下的文件，
// 和真实的压缩包一样；解包用系统的 tar（和生产一样）。

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
const ARCHIVE = {
  name: 'codebuddy-code_Test_x86_64.tar.gz',
  format: 'tar.gz',
  fileName: 'codebuddy',
} as const;

interface Release {
  version: string;
  archive: Buffer;
  /** checksums.txt 里写的 sha256，省略时按压缩包算。 */
  checksum?: string;
  checksums?: string;
}

let server: Server;
let origin = '';
let release: Release | undefined;
let latestStatus = 200;
let archiveHang = false;
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
  if (url.pathname === '/latest') {
    response.end(`${release.version}\n`);
    return;
  }
  if (url.pathname === `/download/${release.version}/checksums.txt`) {
    response.end(
      release.checksums ??
        `${'0'.repeat(64)}  codebuddy-code_Other_arm64.tar.gz\n${release.checksum ?? sha256(release.archive)}  ${ARCHIVE.name}\n`,
    );
    return;
  }
  if (url.pathname === `/download/${release.version}/${ARCHIVE.name}`) {
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
  const root = mkdtempSync(join(tmpdir(), 'wevir-workbuddy-install-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  release = undefined;
  latestStatus = 200;
  archiveHang = false;
  hits.length = 0;
});

function good(version = '2.168.2'): Release {
  return {
    version,
    archive: tgz([
      tarEntry('codebuddy', `binary ${version}`),
      tarEntry('vendor/sandbox/tool', 'helper'),
      tarEntry('vendor/readme.txt', 'text', '0000644'),
    ]),
  };
}

function installer(
  directory: string,
  extra: Partial<ConstructorParameters<typeof WorkBuddyInstaller>[0]> = {},
) {
  return new WorkBuddyInstaller({
    directory,
    archive: ARCHIVE,
    releaseUrl: origin,
    progressIntervalMs: 0,
    ...extra,
  });
}

describe('workbuddyArchive', () => {
  it('官方发布的平台：Darwin / Linux 的 arm64 与 x86_64，Linux 另有 musl，Windows 只有 x86_64', () => {
    expect(workbuddyArchive('darwin', 'arm64', false)).toEqual({
      name: 'codebuddy-code_Darwin_arm64.tar.gz',
      format: 'tar.gz',
      fileName: 'codebuddy',
    });
    expect(workbuddyArchive('darwin', 'x64', false)?.name).toBe(
      'codebuddy-code_Darwin_x86_64.tar.gz',
    );
    expect(workbuddyArchive('linux', 'x64', false)?.name).toBe(
      'codebuddy-code_Linux_x86_64.tar.gz',
    );
    expect(workbuddyArchive('linux', 'arm64', true)?.name).toBe(
      'codebuddy-code_Linux_arm64_musl.tar.gz',
    );
    expect(workbuddyArchive('win32', 'x64')).toEqual({
      name: 'codebuddy-code_Windows_x86_64.zip',
      format: 'zip',
      fileName: 'codebuddy.exe',
    });
    expect(workbuddyArchive('win32', 'arm64')).toBeUndefined();
    expect(workbuddyArchive('freebsd', 'x64')).toBeUndefined();
    expect(workbuddyArchive('linux', 'ia32')).toBeUndefined();
  });
  it('下载地址默认官方的 COS，可由环境变量换掉', () => {
    expect(workbuddyReleaseUrl({})).toBe(WORKBUDDY_RELEASE_URL);
    expect(
      workbuddyReleaseUrl({ [WORKBUDDY_RELEASE_URL_ENV]: ' https://mirror.example/r/// ' }),
    ).toBe('https://mirror.example/r');
  });
});

describe('WorkBuddyInstaller', () => {
  it('装好：核对 sha256、整个压缩包解进 versions/<版本>，启动校验过才写指针', async () => {
    release = good();
    const root = fresh();
    const validated: string[] = [];
    const phases: WorkBuddyInstallProgress['phase'][] = [];
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
      path: join(root, 'versions', '2.168.2', 'codebuddy'),
      version: '2.168.2',
    });
    expect(validated).toEqual(['2.168.2:binary 2.168.2']);
    expect(phases).toEqual(['resolving', 'downloading', 'extracting', 'verifying']);
    expect(await subject.active()).toEqual(installed);
    expect(
      readFileSync(join(root, 'versions', '2.168.2', 'vendor', 'sandbox', 'tool'), 'utf8'),
    ).toBe('helper');
    if (process.platform !== 'win32') {
      expect(statSync(installed.path).mode & 0o111).not.toBe(0);
    }
    expect(readdirSync(join(root, 'versions'))).toEqual(['2.168.2']);
    expect(hits).toEqual([
      '/latest',
      '/download/2.168.2/checksums.txt',
      '/download/2.168.2/codebuddy-code_Test_x86_64.tar.gz',
    ]);
  });

  it('进度带字节数；已是最新版时只核对一遍不重新下载；新版本换掉旧版本', async () => {
    release = good('2.1.0');
    const root = fresh();
    const subject = installer(root);
    const progress: WorkBuddyInstallProgress[] = [];
    await subject.install((p) => progress.push(p));
    const downloading = progress.filter((p) => p.phase === 'downloading');
    expect(downloading.at(-1)).toMatchObject({
      completedBytes: release.archive.length,
      totalBytes: release.archive.length,
    });
    hits.length = 0;
    await subject.install(() => {});
    expect(hits).toEqual(['/latest', '/download/2.1.0/checksums.txt']);

    release = good('2.2.0');
    await subject.install(() => {});
    expect((await subject.active())?.version).toBe('2.2.0');
    expect(readdirSync(join(root, 'versions'))).toEqual(['2.2.0']);
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

  it('清单里的 sha256 不对：报错，什么都没装', async () => {
    release = { ...good(), checksum: 'a'.repeat(64) };
    const root = fresh();
    const subject = installer(root);
    const error = await subject.install(() => {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkBuddyInstallError);
    expect(error).toMatchObject({
      operation: 'verify',
      message: expect.stringContaining('checksum'),
    });
    expect(await subject.active()).toBeUndefined();
    expect(readdirSync(join(root, 'versions'))).toEqual([]);
  });

  it('清单里没有这个压缩包、latest 不可用、地址连不上：说明哪里出了问题', async () => {
    release = { ...good(), checksums: `${'1'.repeat(64)}  something-else.tar.gz\n` };
    const root = fresh();
    await expect(installer(root).install(() => {})).rejects.toMatchObject({
      operation: 'resolve',
      message: expect.stringContaining('not in the release checksums'),
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
      message: expect.stringContaining(WORKBUDDY_RELEASE_URL_ENV),
    });
    release = { ...good('bad version!') };
    latestStatus = 200;
    await expect(installer(root).install(() => {})).rejects.toMatchObject({ operation: 'resolve' });
  });

  it('压缩包里没有程序文件、或条目路径越界：报错，不写到安装目录之外', async () => {
    const root = fresh();
    release = { version: '4.0.0', archive: tgz([tarEntry('vendor/only', 'x')]) };
    await expect(installer(root).install(() => {})).rejects.toMatchObject({
      operation: 'verify',
      message: expect.stringContaining('does not contain codebuddy'),
    });
    release = {
      version: '4.0.1',
      archive: tgz([tarEntry('codebuddy', 'x'), tarEntry('../escaped.txt', 'evil')]),
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
    await expect(started).rejects.toBeInstanceOf(WorkBuddyInstallCancelled);
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
