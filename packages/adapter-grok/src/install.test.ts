import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { NpmPackageInstaller } from '@wevir/runtime-adapter/npm-package';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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

  it('稳定版（主包的 latest 或 x.ai/cli/stable）在列表里、不比平台包的 latest 标签旧时装它，没打标签的旧 alpha 不装', () => {
    // 2026-10-29：稳定版 1.0.70，alpha 1.0.73，1.0.71 与 1.0.72 是没打标签的旧 alpha。
    const versions = [...REAL_VERSIONS, '1.0.70', '1.0.71', '1.0.72', '1.0.73'];
    const current = listing({ latest: '0.1.220', alpha: '1.0.73' }, versions);
    expect(pickGrokVersion(current)).toBe('1.0.72');
    expect(pickGrokVersion(current, ['1.0.70'])).toBe('1.0.70');
    // npmmirror 上主包的 latest 停在 0.1.4：比平台包的 latest 标签旧，不信，用下一个。
    expect(pickGrokVersion(current, ['0.1.4', '1.0.70'])).toBe('1.0.70');
    // 不在列表里、不是版本号：退回旧办法。
    expect(pickGrokVersion(current, ['1.0.99', 'nightly', undefined])).toBe('1.0.72');
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
/** 主包的 `latest` 与 `x.ai/cli/stable` 给的版本（假 registry 与假的稳定版指针）。 */
let mainLatest = '1.0.61';
let stablePointer = '1.0.61';
afterEach(() => {
  mainLatest = '1.0.61';
  stablePointer = '1.0.61';
});
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
  if (path === '/@xai-official%2Fgrok') {
    json(listing({ latest: mainLatest }, REAL_VERSIONS));
  } else if (path === '/cli/stable') {
    response.end(`${stablePointer}\n`);
  } else if (path === '/@xai-official%2Fgrok-darwin-arm64') {
    json(listing({ latest: '0.1.220', alpha: '1.0.63' }, REAL_VERSIONS));
  } else if (path === '/@xai-official%2Fgrok-darwin-arm64/latest') {
    json(version('0.1.220')); // 过期的标签：不能装它
  } else if (/^\/@xai-official%2Fgrok-darwin-arm64\/1\.0\.6[12]$/u.test(path)) {
    json(version(path.slice(path.lastIndexOf('/') + 1)));
  } else if (/^\/tarballs\/1\.0\.6[12]\.tgz$/u.test(path)) {
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
    const pinned = pinnedGrokFetch(PACKAGE, undefined, `${origin}/cli/stable`);
    const resolve = async () =>
      (
        (await (await pinned(`${origin}/@xai-official%2Fgrok-darwin-arm64/latest`)).json()) as {
          version: string;
        }
      ).version;
    // 主包的 latest 是稳定版。
    expect(await resolve()).toBe('1.0.61');
    expect(hits).not.toContain('/cli/stable');
    // 主包的 latest 过期（npmmirror 的 0.1.4）：问 x.ai/cli/stable。
    mainLatest = '0.1.4';
    expect(await resolve()).toBe('1.0.61');
    expect(hits).toContain('/cli/stable');
    // 稳定版指针也读不出：退回版本列表里没打别的标签的最大版本。
    stablePointer = '<html>';
    expect(await resolve()).toBe('1.0.62');
    const other = await pinned(`${origin}/@xai-official%2Fgrok-darwin-arm64/1.0.62`);
    expect((await other.json()) as { version: string }).toMatchObject({ version: '1.0.62' });
    const missing = await pinned(`${origin}/nothing/latest`);
    expect(missing.status).toBe(404);
  });

  it('版本列表读不到：把响应原样交回；列表里没有稳定版本：抛错', async () => {
    const failing = pinnedGrokFetch(
      PACKAGE,
      async () => new Response('no', { status: 503 }),
      'https://stable.example/',
    );
    expect(
      (await failing('https://registry.example/@xai-official%2Fgrok-darwin-arm64/latest')).status,
    ).toBe(503);
    const empty = pinnedGrokFetch(
      PACKAGE,
      async () => new Response(JSON.stringify(listing({}, ['1.0.0-alpha.1']))),
      'https://stable.example/',
    );
    await expect(
      empty('https://registry.example/@xai-official%2Fgrok-darwin-arm64/latest'),
    ).rejects.toThrow(/no stable version/u);
  });
});

describe('NpmPackageInstaller + Grok 的包', () => {
  it('装平台包里的 brotli 程序：版本取主包的 latest 而不是平台包过期的 latest 标签，文件是解开后的程序', async () => {
    const spec = grokNpmPackage('darwin', 'arm64');
    expect(spec?.packageName).toBe(PACKAGE);
    const directory = join(root, 'runtime');
    const validated: string[] = [];
    const installer = new NpmPackageInstaller({
      directory,
      spec: spec as NonNullable<typeof spec>,
      registries: [origin],
      fetch: pinnedGrokFetch(PACKAGE, undefined, `${origin}/cli/stable`),
      validate: async (file, version) => {
        validated.push(`${version}:${readFileSync(file).length}`);
      },
    });
    const installed = await installer.install(() => {});
    expect(installed.version).toBe('1.0.61');
    expect(installed.path).toBe(join(directory, 'versions', '1.0.61', 'grok'));
    expect(readFileSync(installed.path).equals(PROGRAM)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(installed.path).mode & 0o777).toBe(0o755);
    expect(validated).toEqual([`1.0.61:${PROGRAM.length}`]);
    expect(await installer.active()).toEqual(installed);
    expect(hits).not.toContain('/tarballs/0.1.220.tgz');
  });
});
