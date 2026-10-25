import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  extractTarEntry,
  NpmInstallCancelled,
  NpmInstallError,
  type NpmInstallProgress,
  NpmPackageInstaller,
  npmRegistries,
} from './npm-package.js';

// 让落盘文件的 `close` 晚一点到，复现 Windows 上句柄还没放开、马上启动程序会 EBUSY 的时序。
const slowClose = vi.hoisted(() => ({ ms: 0, streams: [] as { closed: boolean }[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
      const stream = actual.createWriteStream(...args);
      if (slowClose.ms > 0) {
        slowClose.streams.push(stream);
        const destroy = stream._destroy.bind(stream);
        stream._destroy = (error, callback) => {
          setTimeout(() => destroy(error, callback), slowClose.ms);
        };
      }
      return stream;
    },
  };
});

// 引擎运行体的安装：假 registry（本机 HTTP）给元数据与 tgz，tgz 里只有一个程序文件，和真实的平台包一样。

function tarHeader(name: string, size: number, type = '0', prefix = ''): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000755\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  if (prefix !== '') header.write(prefix, 345, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

function tarEntry(name: string, data: Buffer, type = '0', prefix = ''): Buffer {
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([tarHeader(name, data.length, type, prefix), data, padding]);
}

function tgz(entries: Buffer[]): Buffer {
  return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

const sha512 = (data: Buffer) => `sha512-${createHash('sha512').update(data).digest('base64')}`;

interface Package {
  version: string;
  tarball: Buffer;
  integrity?: string;
}

let server: Server;
let origin = '';
let packages: Record<string, Package> = {};
let metadataStatus = 200;
let tarballHang = false;
let tarballStatus = 200;
const hits: string[] = [];

function handle(request: IncomingMessage, response: ServerResponse) {
  hits.push(request.url ?? '');
  const url = new URL(request.url ?? '/', origin);
  const metadata = /^\/(.+)\/latest$/u.exec(url.pathname);
  if (metadata !== null) {
    if (metadataStatus !== 200) {
      response.statusCode = metadataStatus;
      response.end('no');
      return;
    }
    const name = decodeURIComponent(metadata[1] as string);
    const found = packages[name];
    if (found === undefined) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        name,
        version: found.version,
        dist: {
          tarball: `${origin}/tarballs/${found.version}.tgz`,
          integrity: found.integrity ?? sha512(found.tarball),
          unpackedSize: 1024,
        },
      }),
    );
    return;
  }
  const tarball = /^\/tarballs\/(.+)\.tgz$/u.exec(url.pathname);
  const found =
    tarball === null ? undefined : Object.values(packages).find((p) => p.version === tarball[1]);
  if (found === undefined) {
    response.statusCode = 404;
    response.end('not found');
    return;
  }
  if (tarballStatus !== 200) {
    response.statusCode = tarballStatus;
    response.end('broken');
    return;
  }
  if (tarballHang) {
    response.writeHead(200, { 'content-length': String(found.tarball.length) });
    response.write(found.tarball.subarray(0, 10));
    return; // 不再发数据，也不结束
  }
  response.writeHead(200, { 'content-length': String(found.tarball.length) });
  response.end(found.tarball);
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const dirs: string[] = [];
afterEach(() => {
  packages = {};
  metadataStatus = 200;
  tarballHang = false;
  tarballStatus = 200;
  slowClose.ms = 0;
  slowClose.streams.length = 0;
  hits.length = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function installer(options: Partial<ConstructorParameters<typeof NpmPackageInstaller>[0]> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'wevir-npm-install-'));
  dirs.push(directory);
  return new NpmPackageInstaller({
    directory,
    spec: { packageName: '@scope/tool-darwin-arm64', entry: 'tool', fileName: 'tool' },
    registries: [origin],
    ...options,
  });
}

const BINARY = Buffer.from('#!/bin/sh\necho 1.2.3\n'.repeat(500));
function publish(version = '1.2.3', entries?: Buffer[]) {
  packages['@scope/tool-darwin-arm64'] = {
    version,
    tarball: tgz(entries ?? [tarEntry('package/tool', BINARY)]),
  };
}

describe('NpmPackageInstaller', () => {
  it('取最新版本的 tgz，核对 sha512，只解出要的文件，写下指针', async () => {
    publish('1.2.3', [
      tarEntry('package/package.json', Buffer.from('{}')),
      tarEntry('package/tool', BINARY),
      tarEntry('package/README.md', Buffer.from('# hi')),
    ]);
    const target = installer();
    const progress: NpmInstallProgress[] = [];
    const result = await target.install((entry) => progress.push(entry));
    expect(result.version).toBe('1.2.3');
    expect(result.path).toBe(join(target.directory, 'versions', '1.2.3', 'tool'));
    expect(readFileSync(result.path)).toEqual(BINARY);
    if (process.platform !== 'win32') expect(statSync(result.path).mode & 0o111).toBe(0o111);
    expect(readdirSync(join(target.directory, 'versions', '1.2.3'))).toEqual(['tool']);
    expect(await target.active()).toEqual(result);
    expect(progress[0]).toMatchObject({ phase: 'resolving' });
    expect(
      progress.some((entry) => entry.phase === 'downloading' && entry.totalBytes !== undefined),
    ).toBe(true);
    expect(progress.at(-1)).toMatchObject({ phase: 'verifying' });
    // 包名里的 `/` 在地址里写成 %2F。
    expect(hits[0]).toBe('/@scope%2Ftool-darwin-arm64/latest');
  });

  it('校验和不对就不装，已装的版本不动', async () => {
    publish('1.0.0');
    const target = installer();
    await target.install(() => {});
    publish('1.1.0');
    (packages['@scope/tool-darwin-arm64'] as Package).integrity = sha512(Buffer.from('other'));
    await expect(target.install(() => {})).rejects.toMatchObject({
      name: 'NpmInstallError',
      operation: 'verify',
      message: expect.stringContaining('did not match the checksum'),
    });
    expect((await target.active())?.version).toBe('1.0.0');
    expect(readdirSync(join(target.directory, 'versions'))).toEqual(['1.0.0']);
  });

  it('包里没有要的文件时报错，不留半成品', async () => {
    publish('1.2.3', [tarEntry('package/other', Buffer.from('x'))]);
    const target = installer();
    await expect(target.install(() => {})).rejects.toBeInstanceOf(NpmInstallError);
    expect(await target.active()).toBeUndefined();
    expect(readdirSync(join(target.directory, 'versions'))).toEqual([]);
  });

  it('启动核对失败就不启用', async () => {
    publish();
    const target = installer({
      validate: async () => {
        throw new Error('exec format error');
      },
    });
    await expect(target.install(() => {})).rejects.toMatchObject({
      operation: 'verify',
      message: expect.stringContaining('exec format error'),
    });
    expect(await target.active()).toBeUndefined();
    expect(readdirSync(join(target.directory, 'versions'))).toEqual([]);
  });

  it('程序文件的句柄放开后才启动核对', async () => {
    publish();
    slowClose.ms = 100;
    const closed: boolean[] = [];
    const target = installer({
      validate: async () => {
        closed.push(...slowClose.streams.map((stream) => stream.closed));
      },
    });
    await target.install(() => {});
    expect(closed).toEqual([true]);
  });

  describe('Windows 上核对遇到文件占用', () => {
    const busy = (code: string) => Object.assign(new Error(`spawn ${code}`), { code });

    it.each(['EBUSY', 'EPERM', 'EACCES'])('%s：等一会儿再试，通过就装好', async (code) => {
      publish();
      let calls = 0;
      const target = installer({
        platform: 'win32',
        validationRetryDelayMs: 1,
        validate: async () => {
          calls += 1;
          if (calls < 3) throw busy(code);
        },
      });
      const result = await target.install(() => {});
      expect(calls).toBe(3);
      expect((await target.active())?.version).toBe(result.version);
    });

    it('错误只在消息里带占用的码（被包了一层）也算', async () => {
      publish();
      let calls = 0;
      const target = installer({
        platform: 'win32',
        validationRetryDelayMs: 1,
        validate: async () => {
          calls += 1;
          if (calls < 2) throw new Error('`claude --version` failed: spawn EBUSY');
        },
      });
      await target.install(() => {});
      expect(calls).toBe(2);
    });

    it('一直占用：试满次数后报错，带原因，不启用', async () => {
      publish();
      let calls = 0;
      const target = installer({
        platform: 'win32',
        validationRetryDelayMs: 1,
        validate: async () => {
          calls += 1;
          throw busy('EBUSY');
        },
      });
      await expect(target.install(() => {})).rejects.toMatchObject({
        operation: 'verify',
        message: expect.stringContaining('did not run: spawn EBUSY'),
      });
      expect(calls).toBe(10);
      expect(await target.active()).toBeUndefined();
      expect(readdirSync(join(target.directory, 'versions'))).toEqual([]);
    });

    it('别的错误不重试', async () => {
      publish();
      let calls = 0;
      const target = installer({
        platform: 'win32',
        validationRetryDelayMs: 1,
        validate: async () => {
          calls += 1;
          throw new Error('exec format error');
        },
      });
      await expect(target.install(() => {})).rejects.toMatchObject({ operation: 'verify' });
      expect(calls).toBe(1);
    });

    it('其他平台不重试', async () => {
      publish();
      let calls = 0;
      const target = installer({
        platform: 'darwin',
        validationRetryDelayMs: 1,
        validate: async () => {
          calls += 1;
          throw busy('EBUSY');
        },
      });
      await expect(target.install(() => {})).rejects.toMatchObject({ operation: 'verify' });
      expect(calls).toBe(1);
    });

    it('等待重试时取消：立即抛 NpmInstallCancelled', async () => {
      publish();
      let target: NpmPackageInstaller | undefined;
      target = installer({
        platform: 'win32',
        validationRetryDelayMs: 60_000,
        validate: async () => {
          setTimeout(() => target?.cancel(), 20);
          throw busy('EBUSY');
        },
      });
      await expect(target.install(() => {})).rejects.toBeInstanceOf(NpmInstallCancelled);
      expect(target.installing).toBe(false);
      expect(readdirSync(join(target.directory, 'versions'))).toEqual([]);
    });
  });

  it('新版本启用后删掉旧版本；已经是最新的只核对，不再下载', async () => {
    publish('1.0.0');
    const target = installer();
    await target.install(() => {});
    publish('1.1.0');
    await target.install(() => {});
    expect(readdirSync(join(target.directory, 'versions'))).toEqual(['1.1.0']);
    expect((await target.active())?.version).toBe('1.1.0');
    hits.length = 0;
    await target.install(() => {});
    expect(hits.filter((hit) => hit.startsWith('/tarballs/'))).toEqual([]);
  });

  it('装好的文件被删了：指针不算数；已装的坏了会重新下载', async () => {
    publish();
    const target = installer();
    const { path } = await target.install(() => {});
    rmSync(path);
    expect(await target.active()).toBeUndefined();
    await target.install(() => {});
    expect(existsSync(path)).toBe(true);
  });

  it('registry 连不上：说明试了哪些，并提示换 registry', async () => {
    metadataStatus = 503;
    const target = installer();
    const failure = await target.install(() => {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NpmInstallError);
    expect((failure as NpmInstallError).operation).toBe('resolve');
    expect((failure as NpmInstallError).message).toContain('127.0.0.1');
    expect((failure as NpmInstallError).message).toContain('WEVIR_NPM_REGISTRY');
  });

  it('第一个 registry 的 tgz 下不来：换另一个同版本的 registry', async () => {
    publish();
    tarballStatus = 500;
    const found = packages['@scope/tool-darwin-arm64'] as Package;
    // 第二台只在第一台答完之后才答元数据，保证第一台先被选中。
    const second = createServer((request, response) => {
      if ((request.url ?? '').endsWith('/latest')) {
        const base = `http://127.0.0.1:${(second.address() as AddressInfo).port}`;
        setTimeout(
          () =>
            response.end(
              JSON.stringify({
                version: found.version,
                dist: { tarball: `${base}/ok.tgz`, integrity: sha512(found.tarball) },
              }),
            ),
          200,
        );
        return;
      }
      response.end(found.tarball);
    });
    await new Promise<void>((resolve) => second.listen(0, '127.0.0.1', resolve));
    try {
      const target = installer({
        registries: [origin, `http://127.0.0.1:${(second.address() as AddressInfo).port}`],
      });
      const result = await target.install(() => {});
      expect(result.version).toBe('1.2.3');
      expect(readFileSync(result.path)).toEqual(BINARY);
      expect(hits.filter((hit) => hit.startsWith('/tarballs/'))).toHaveLength(1);
    } finally {
      second.closeAllConnections();
      await new Promise((resolve) => second.close(resolve));
    }
  });

  it('收不到数据超过时限算卡住', async () => {
    publish();
    tarballHang = true;
    const target = installer({ idleTimeoutMs: 150 });
    await expect(target.install(() => {})).rejects.toMatchObject({
      operation: 'download',
      message: expect.stringContaining('no data'),
    });
    expect(readdirSync(join(target.directory, 'versions'))).toEqual([]);
  });

  it('取消：抛 NpmInstallCancelled，没有半成品', async () => {
    publish();
    tarballHang = true;
    const target = installer({ idleTimeoutMs: 10_000 });
    const running = target.install(() => {});
    running.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    target.cancel();
    await expect(running).rejects.toBeInstanceOf(NpmInstallCancelled);
    expect(target.installing).toBe(false);
    expect(readdirSync(join(target.directory, 'versions'))).toEqual([]);
  });

  it('brotli 压缩的包内文件落盘前解开', async () => {
    const compressed = zlib.brotliCompressSync(BINARY);
    packages['@scope/tool-darwin-arm64'] = {
      version: '0.1.220',
      tarball: tgz([tarEntry('package/bin/tool.br', compressed)]),
    };
    const target = installer({
      spec: {
        packageName: '@scope/tool-darwin-arm64',
        entry: 'bin/tool.br',
        fileName: 'tool',
        decode: 'brotli',
      },
    });
    const result = await target.install(() => {});
    expect(readFileSync(result.path)).toEqual(BINARY);
  });

  it('同一时刻只有一次安装', async () => {
    publish();
    const target = installer();
    const [a, b] = await Promise.all([target.install(() => {}), target.install(() => {})]);
    expect(a).toEqual(b);
    expect(hits.filter((hit) => hit.startsWith('/tarballs/'))).toHaveLength(1);
  });
});

describe('extractTarEntry', () => {
  async function* chunks(data: Buffer, size: number) {
    for (let offset = 0; offset < data.length; offset += size) {
      yield data.subarray(offset, offset + size);
    }
  }
  const collect = async (source: Buffer, wanted: string, size = 7) => {
    const parts: Buffer[] = [];
    const found = await extractTarEntry(chunks(source, size), wanted, async (data) => {
      parts.push(data);
    });
    return { found, data: Buffer.concat(parts) };
  };

  it('任意切块都能解出；只取第一个同名文件', async () => {
    const tar = Buffer.concat([
      tarEntry('package/a', Buffer.from('aaa')),
      tarEntry('package/b', Buffer.alloc(1300, 7)),
      tarEntry('package/b', Buffer.from('second')),
      Buffer.alloc(1024),
    ]);
    for (const size of [1, 7, 511, 512, 513, 100_000]) {
      const result = await collect(tar, 'package/b', size);
      expect(result.found).toBe(true);
      expect(result.data).toEqual(Buffer.alloc(1300, 7));
    }
  });

  it('没有要的文件返回 false；目录和符号链接不算', async () => {
    const tar = Buffer.concat([
      tarEntry('package/b', Buffer.alloc(0), '5'),
      tarEntry('package/c', Buffer.alloc(0), '2'),
      tarEntry('package/a', Buffer.from('aaa')),
      Buffer.alloc(1024),
    ]);
    expect((await collect(tar, 'package/b')).found).toBe(false);
    expect((await collect(tar, 'package/c')).found).toBe(false);
  });

  it('认 ustar 的 prefix、pax 的 path 与 GNU 的长名字', async () => {
    const long = `package/${'d/'.repeat(80)}tool`;
    const record = (key: string, value: string) => {
      const body = ` ${key}=${value}\n`;
      let length = body.length + 1;
      while (`${length}${body}`.length !== length) length = `${length}${body}`.length;
      return `${length}${body}`;
    };
    const tar = Buffer.concat([
      tarEntry('tool', Buffer.from('one'), '0', 'package/sub'),
      tarEntry('PaxHeader', Buffer.from(record('path', long)), 'x'),
      tarEntry('placeholder', Buffer.from('two')),
      tarEntry('././@LongLink', Buffer.from(`${long}2\0`), 'L'),
      tarEntry('placeholder', Buffer.from('three')),
      Buffer.alloc(1024),
    ]);
    expect((await collect(tar, 'package/sub/tool')).data.toString()).toBe('one');
    expect((await collect(tar, long)).data.toString()).toBe('two');
    expect((await collect(tar, `${long}2`)).data.toString()).toBe('three');
  });

  it('读完整个流才返回（结束标记后的字节也要被读到）', async () => {
    const tar = Buffer.concat([
      tarEntry('package/a', Buffer.from('a')),
      Buffer.alloc(1024),
      Buffer.from('trailing'),
    ]);
    let consumed = 0;
    async function* counted() {
      for await (const piece of chunks(tar, 100)) {
        consumed += piece.length;
        yield piece;
      }
    }
    expect(await extractTarEntry(counted(), 'package/a', async () => {})).toBe(true);
    expect(consumed).toBe(tar.length);
  });
});

describe('npmRegistries', () => {
  it('默认 npmjs 与 npmmirror；环境变量换成逗号分隔的列表', () => {
    expect(npmRegistries({})).toEqual([
      'https://registry.npmjs.org',
      'https://registry.npmmirror.com',
    ]);
    expect(
      npmRegistries({ WEVIR_NPM_REGISTRY: ' https://a.example/ , https://b.example ' }),
    ).toEqual(['https://a.example', 'https://b.example']);
    expect(npmRegistries({ WEVIR_NPM_REGISTRY: ' , ' })).toHaveLength(2);
  });
});
