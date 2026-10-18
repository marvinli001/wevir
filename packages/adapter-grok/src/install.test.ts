import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { NpmPackageInstaller } from '@wevir/runtime-adapter/npm-package';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grokNpmPackage, pickGrokVersion, pinnedGrokFetch } from './install.js';

describe('grokNpmPackage', () => {
  it('平台包名与包内的 brotli 文件', () => {
    expect(grokNpmPackage('darwin', 'arm64')).toEqual({
      packageName: '@xai-official/grok-darwin-arm64',
      entry: 'bin/grok.br',
      fileName: 'grok',
      decode: 'brotli',
    });
    expect(grokNpmPackage('linux', 'x64')?.packageName).toBe('@xai-official/grok-linux-x64');
    expect(grokNpmPackage('win32', 'arm64')).toMatchObject({
      packageName: '@xai-official/grok-win32-arm64',
      entry: 'bin/grok.exe.br',
      fileName: 'grok.exe',
    });
  });

  it('xAI 没有发布的平台没有包', () => {
    expect(grokNpmPackage('linux', 'ia32')).toBeUndefined();
    expect(grokNpmPackage('freebsd', 'x64')).toBeUndefined();
    expect(grokNpmPackage('darwin', 'ppc64')).toBeUndefined();
  });
});

// 2026-10-18 的真实情形：平台包的 `latest` 标签停在 0.1.220，1.0 之后只给 `alpha` 打标签，1.0.63 是 alpha。
const listing = (tags: Record<string, string>, versions: string[]) => ({
  'dist-tags': tags,
  versions: Object.fromEntries(versions.map((version) => [version, { version }])),
});
const REAL_VERSIONS = [
  '0.1.219',
  '0.1.220-alpha.1',
  '0.1.220',
  '0.2.0',
  '1.0.9',
  '1.0.10',
  '1.0.61',
  '1.0.62',
  '1.0.63',
];

describe('pickGrokVersion', () => {
  it('最大的、不带预发布后缀、不是别的标签指向的版本；按数字比较不按字典序', () => {
    expect(pickGrokVersion(listing({ latest: '0.1.220', alpha: '1.0.63' }, REAL_VERSIONS))).toBe(
      '1.0.62',
    );
    expect(pickGrokVersion(listing({ latest: '0.1.220' }, ['1.0.9', '1.0.10', '1.0.2']))).toBe(
      '1.0.10',
    );
  });

  it('alpha 提升成 latest 之后它就是要装的', () => {
    expect(pickGrokVersion(listing({ latest: '1.0.63', alpha: '1.0.63' }, REAL_VERSIONS))).toBe(
      '1.0.63',
    );
    expect(
      pickGrokVersion(listing({ latest: '1.0.63', alpha: '1.0.64' }, [...REAL_VERSIONS])),
    ).toBe('1.0.63');
  });

  it('挑不出来：没有稳定版本、列表不对', () => {
    expect(pickGrokVersion(listing({}, ['1.0.0-alpha.1', '1.0.0-beta']))).toBeUndefined();
    expect(pickGrokVersion(listing({ alpha: '1.0.1' }, ['1.0.1']))).toBeUndefined();
    expect(pickGrokVersion({})).toBeUndefined();
    expect(pickGrokVersion(null)).toBeUndefined();
    expect(pickGrokVersion('x')).toBeUndefined();
  });
});

// 假 registry（本机 HTTP）：和 npmjs 一样的路径——完整版本列表 `/<包>`、`/<包>/latest`、`/<包>/<版本>`、tgz。

const PACKAGE = '@xai-official/grok-darwin-arm64';
const PROGRAM = Buffer.from('#!/bin/sh\necho "grok 1.0.62 (test)"\n'.repeat(200));

function tarEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function platformTarball(program: Buffer): Buffer {
  return zlib.gzipSync(
    Buffer.concat([
      tarEntry('package/package.json', Buffer.from('{"name":"x"}')),
      tarEntry('package/bin/grok.br', zlib.brotliCompressSync(program)),
      tarEntry('package/README.md', Buffer.from('hello')),
      Buffer.alloc(1024),
    ]),
  );
}

let server: Server;
let origin = '';
let tarball: Buffer = Buffer.alloc(0);
const hits: string[] = [];
const root = mkdtempSync(join(tmpdir(), 'wevir-grok-install-'));

function handle(request: IncomingMessage, response: ServerResponse) {
  hits.push(request.url ?? '');
  const path = new URL(request.url ?? '/', origin).pathname;
  const json = (body: unknown) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  };
  const version = (name: string) => ({
    name: PACKAGE,
    version: name,
    dist: {
      tarball: `${origin}/tarballs/${name}.tgz`,
      integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
      unpackedSize: 4096,
    },
  });
  if (path === '/@xai-official%2Fgrok-darwin-arm64') {
    json(listing({ latest: '0.1.220', alpha: '1.0.63' }, REAL_VERSIONS));
  } else if (path === '/@xai-official%2Fgrok-darwin-arm64/latest') {
    json(version('0.1.220')); // 过期的标签：不能装它
  } else if (path === '/@xai-official%2Fgrok-darwin-arm64/1.0.62') {
    json(version('1.0.62'));
  } else if (path === '/tarballs/1.0.62.tgz') {
    response.writeHead(200, { 'content-length': String(tarball.length) });
    response.end(tarball);
  } else {
    response.statusCode = 404;
    response.end('not found');
  }
}

beforeAll(async () => {
  tarball = platformTarball(PROGRAM);
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

describe('pinnedGrokFetch', () => {
  it('平台包的 latest 查询换成挑出的版本；别的请求原样转发', async () => {
    const pinned = pinnedGrokFetch(PACKAGE);
    const latest = await pinned(`${origin}/@xai-official%2Fgrok-darwin-arm64/latest`);
    expect((await latest.json()) as { version: string }).toMatchObject({ version: '1.0.62' });
    const other = await pinned(`${origin}/@xai-official%2Fgrok-darwin-arm64/1.0.62`);
    expect((await other.json()) as { version: string }).toMatchObject({ version: '1.0.62' });
    const missing = await pinned(`${origin}/nothing/latest`);
    expect(missing.status).toBe(404);
  });

  it('版本列表读不到：把响应原样交回；列表里没有稳定版本：抛错', async () => {
    const failing = pinnedGrokFetch(PACKAGE, async () => new Response('no', { status: 503 }));
    expect(
      (await failing('https://registry.example/@xai-official%2Fgrok-darwin-arm64/latest')).status,
    ).toBe(503);
    const empty = pinnedGrokFetch(
      PACKAGE,
      async () => new Response(JSON.stringify(listing({}, ['1.0.0-alpha.1']))),
    );
    await expect(
      empty('https://registry.example/@xai-official%2Fgrok-darwin-arm64/latest'),
    ).rejects.toThrow(/no stable version/u);
  });
});

describe('NpmPackageInstaller + Grok 的包', () => {
  it('装平台包里的 brotli 程序：版本取列表里的稳定版而不是过期的 latest 标签，文件是解开后的程序', async () => {
    const spec = grokNpmPackage('darwin', 'arm64');
    expect(spec?.packageName).toBe(PACKAGE);
    const directory = join(root, 'runtime');
    const validated: string[] = [];
    const installer = new NpmPackageInstaller({
      directory,
      spec: spec as NonNullable<typeof spec>,
      registries: [origin],
      fetch: pinnedGrokFetch(PACKAGE),
      validate: async (file, version) => {
        validated.push(`${version}:${readFileSync(file).length}`);
      },
    });
    const installed = await installer.install(() => {});
    expect(installed.version).toBe('1.0.62');
    expect(installed.path).toBe(join(directory, 'versions', '1.0.62', 'grok'));
    expect(readFileSync(installed.path).equals(PROGRAM)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(installed.path).mode & 0o777).toBe(0o755);
    expect(validated).toEqual([`1.0.62:${PROGRAM.length}`]);
    expect(await installer.active()).toEqual(installed);
    expect(hits).not.toContain('/tarballs/0.1.220.tgz');
  });
});
