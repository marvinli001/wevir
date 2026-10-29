import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NpmClosureInstaller,
  type NpmClosureMirror,
  type NpmClosurePackage,
  npmMirrorAssetName,
  tarballUrl,
} from './npm-closure.js';
import { NpmInstallError } from './npm-package.js';

// 镜像线路：假 fetch 按地址给 registry 的版本元数据、registry 与镜像上的 tgz，记下每个请求，核对谁参加竞速、后备线路何时才用。

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

function packageTgz(name: string, version: string): Buffer {
  const manifest = Buffer.from(JSON.stringify({ name, version }));
  return zlib.gzipSync(
    Buffer.concat([tarEntry('package/package.json', manifest), Buffer.alloc(1024)]),
  );
}

const MAIN = { name: '@scope/main', version: '1.0.0' };
const TARBALLS = new Map([
  [MAIN.name, packageTgz(MAIN.name, MAIN.version)],
  ['dep', packageTgz('dep', '2.0.0')],
]);
const PACKAGES: NpmClosurePackage[] = [
  { ...MAIN, integrity: integrity(TARBALLS.get(MAIN.name) as Buffer) },
  { name: 'dep', version: '2.0.0', integrity: integrity(TARBALLS.get('dep') as Buffer) },
];

function integrity(data: Buffer): string {
  return `sha512-${createHash('sha512').update(data).digest('base64')}`;
}

const REGISTRY = 'https://registry.test';
const MIRRORS: NpmClosureMirror[] = [
  { id: 'github', url: 'https://github.test/release' },
  { id: 'global', url: 'https://cdn.test/engine', fallback: true },
];

/** 每处有哪些包；`down` 里的主机一律连不上。 */
function fakeFetch(has: Record<string, readonly string[]>, down: readonly string[] = []) {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    const host = new URL(url).host;
    if (down.includes(host)) throw new TypeError('fetch failed');
    const available = has[host] ?? [];
    if (
      host === 'registry.test' &&
      url.endsWith(`/${MAIN.name.replace('/', '%2F')}/${MAIN.version}`)
    ) {
      return available.includes(MAIN.name)
        ? new Response(JSON.stringify(MAIN), { status: 200 })
        : new Response('', { status: 404 });
    }
    const entry = PACKAGES.find(
      (item) =>
        url === tarballUrl(REGISTRY, item) ||
        MIRRORS.some((mirror) => url === `${mirror.url}/${npmMirrorAssetName(item)}`),
    );
    if (entry === undefined || !available.includes(entry.name)) {
      return new Response('', { status: 404 });
    }
    return new Response(TARBALLS.get(entry.name) as Buffer, { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function installer(fetchImpl: typeof fetch, mirrors: NpmClosureMirror[] = MIRRORS) {
  const directory = mkdtempSync(join(tmpdir(), 'wevir-npm-closure-'));
  dirs.push(directory);
  return new NpmClosureInstaller({
    directory,
    label: 'test engine',
    main: MAIN,
    packages: PACKAGES,
    requiredSpace: 0,
    registries: [REGISTRY],
    mirrors,
    fetch: fetchImpl,
    progressIntervalMs: 0,
  });
}

const ALL = [MAIN.name, 'dep'];

describe('NpmClosureInstaller mirrors', () => {
  it('names mirrored files flat, without the scope @', () => {
    expect(
      npmMirrorAssetName({ name: '@deepseek-ai/libreoffice-kit-wasm', version: '0.2.0' }),
    ).toBe('deepseek-ai-libreoffice-kit-wasm-0.2.0.tgz');
    expect(npmMirrorAssetName({ name: 'koffi', version: '3.1.1' })).toBe('koffi-3.1.1.tgz');
  });

  it('installs from a primary mirror when the registry is unreachable, without touching the fallback', async () => {
    const { fetchImpl, requests } = fakeFetch({ 'github.test': ALL }, ['registry.test']);
    const created = installer(fetchImpl);
    const installation = await created.install();
    const manifest = JSON.parse(
      readFileSync(join(installation.root, 'node_modules', 'dep', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(manifest.version).toBe('2.0.0');
    expect(requests.filter((url) => url.startsWith('https://github.test/'))).toContain(
      'https://github.test/release/scope-main-1.0.0.tgz',
    );
    expect(requests.some((url) => url.startsWith('https://cdn.test/'))).toBe(false);
  });

  it('takes a package the mirror lacks from the registry', async () => {
    const { fetchImpl, requests } = fakeFetch({
      'github.test': [MAIN.name],
      'registry.test': ALL,
    });
    await installer(fetchImpl).install();
    expect(requests).toContain(tarballUrl(REGISTRY, PACKAGES[1] as NpmClosurePackage));
    expect(requests.some((url) => url.startsWith('https://cdn.test/'))).toBe(false);
  });

  it('falls back to the fallback mirror only when every primary source fails', async () => {
    const { fetchImpl, requests } = fakeFetch({ 'cdn.test': ALL }, [
      'registry.test',
      'github.test',
    ]);
    const installation = await installer(fetchImpl).install();
    expect(installation.version).toBe('1.0.0');
    expect(requests).toContain('https://cdn.test/engine/dep-2.0.0.tgz');
  });

  it('reports every source when nothing can serve a package', async () => {
    const { fetchImpl } = fakeFetch({ 'github.test': [MAIN.name] }, ['registry.test']);
    const error = await installer(fetchImpl)
      .install()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NpmInstallError);
    expect((error as Error).message).toContain('dep@2.0.0');
    expect((error as Error).message).toContain('github.test');
    expect((error as Error).message).toContain('cdn.test');
  });

  it('fails to resolve when no primary source answers and there is no fallback', async () => {
    const { fetchImpl } = fakeFetch({}, ['registry.test', 'github.test']);
    const error = await installer(fetchImpl, [MIRRORS[0] as NpmClosureMirror])
      .install()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NpmInstallError);
    expect((error as Error).message).toContain('registry.test, github.test');
  });
});
