import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { NpmInstallCancelled, NpmInstallError } from '@wevir/runtime-adapter/npm-package';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CURSOR_SDK_VERSION, loadCursorSdk } from './sdk.js';
import {
  CURSOR_SDK_PACKAGES,
  type CursorSdkInstallEvent,
  CursorSdkInstaller,
  type CursorSdkPackage,
  cursorSdkPackages,
  tarballUrl,
} from './sdk-install.js';

// 安装包里的 SDK 按需下载：假 registry（本机 HTTP，两个前缀当两个 registry）给版本元数据与 tgz，包内容是假的 SDK、zod 与平台包，
// 校验和由测试按生成的 tgz 算出（`packages` 选项换掉钉住的清单）。

function tarEntry(name: string, data: Buffer, options: { type?: string; mode?: string } = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write(`${options.mode ?? '0000644'}\0`, 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(options.type ?? '0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function tgz(entries: Buffer[]): Buffer {
  return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const integrity = (data: Buffer) => `sha512-${createHash('sha512').update(data).digest('base64')}`;
const platformName = `@cursor/sdk-${process.platform}-${process.arch}`;

const SDK_ENTRY = `import { z } from 'zod';
export const Agent = {};
export const Cursor = {
  me: async ({ apiKey }) => ({ userEmail: 'fake@' + apiKey + '.' + z }),
  models: { list: async () => [] },
  auth: { login: async () => ({}) },
};
`;

const TARBALLS: Record<string, Buffer> = {
  '@cursor/sdk': tgz([
    tarEntry(
      'package/package.json',
      json({
        name: '@cursor/sdk',
        version: CURSOR_SDK_VERSION,
        type: 'module',
        exports: { '.': { require: './dist/cjs/index.js', import: './dist/esm/index.js' } },
      }),
    ),
    tarEntry('package/dist/esm/index.js', Buffer.from(SDK_ENTRY)),
    // 越界与链接一律跳过。
    tarEntry('package/../escape.txt', Buffer.from('no')),
    tarEntry('package/link', Buffer.alloc(0), { type: '2' }),
  ]),
  zod: tgz([
    tarEntry('package/package.json', json({ name: 'zod', type: 'module', exports: './index.js' })),
    tarEntry('package/index.js', Buffer.from("export const z = 'flat';\n")),
  ]),
  [platformName]: tgz([
    tarEntry('package/package.json', json({ name: platformName })),
    tarEntry('package/bin/rg', Buffer.from('#!/bin/sh\n'), { mode: '0000755' }),
    tarEntry('package/vendor/tree-sitter/index.js', Buffer.from('')),
  ]),
};

const PACKAGES: CursorSdkPackage[] = [
  {
    name: '@cursor/sdk',
    version: CURSOR_SDK_VERSION,
    integrity: integrity(TARBALLS['@cursor/sdk'] as Buffer),
  },
  { name: 'zod', version: '3.25.76', integrity: integrity(TARBALLS.zod as Buffer) },
  {
    name: platformName,
    version: CURSOR_SDK_VERSION,
    integrity: integrity(TARBALLS[platformName] as Buffer),
    os: process.platform,
    cpu: process.arch,
  },
];

/** 每个前缀（registry）的表现。 */
const behaviour: Record<string, 'ok' | 'down' | 'corrupt' | 'hang'> = {};
let server: Server;
let origin = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = request.url ?? '';
    const [, registry = '', ...rest] = url.split('/');
    const mode = behaviour[registry] ?? 'ok';
    const path = rest.join('/');
    if (path === `@cursor%2Fsdk/${CURSOR_SDK_VERSION}`) {
      if (mode === 'down') {
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ version: CURSOR_SDK_VERSION }));
      return;
    }
    const entry = PACKAGES.find(
      (item) =>
        `/${registry}/${path}` === new URL(tarballUrl(`/${registry}`, item), 'http://x').pathname,
    );
    const body = entry === undefined ? undefined : TARBALLS[entry.name];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    if (mode === 'hang') {
      response.writeHead(200, { 'Content-Length': String(body.length) });
      response.write(body.subarray(0, 10));
      return;
    }
    const sent = mode === 'corrupt' ? tgz([tarEntry('package/x', Buffer.from('bad'))]) : body;
    response.writeHead(200, { 'Content-Length': String(sent.length) });
    response.end(sent);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const dirs: string[] = [];
const savedEnv = {
  rg: process.env.CURSOR_RIPGREP_PATH,
  vendor: process.env.CURSOR_TREE_SITTER_VENDOR_DIR,
};
afterEach(() => {
  for (const key of Object.keys(behaviour)) delete behaviour[key];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [
    ['CURSOR_RIPGREP_PATH', savedEnv.rg],
    ['CURSOR_TREE_SITTER_VENDOR_DIR', savedEnv.vendor],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function installer(registries: string[], options: { idleTimeoutMs?: number } = {}) {
  const directory = join(mkdtempSync(join(tmpdir(), 'wevir-cursor-sdk-')), 'sdk');
  dirs.push(join(directory, '..'));
  const created = new CursorSdkInstaller({
    directory,
    registries: registries.map((name) => `${origin}/${name}`),
    packages: PACKAGES,
    progressIntervalMs: 0,
    ...options,
  });
  const events: CursorSdkInstallEvent[] = [];
  created.onChange((event) => events.push(event));
  return { installer: created, directory, events };
}

/** pnpm-lock.yaml 里 `@cursor/sdk@<版本>` 的生产依赖闭包：名字@版本 → { integrity, os, cpu }。 */
function lockClosure(): Map<string, { integrity: string; os?: string; cpu?: string }> {
  const lock = readFileSync(
    fileURLToPath(new URL('../../../pnpm-lock.yaml', import.meta.url)),
    'utf8',
  );
  // pnpm 12 的 lockfile 前面还有一份环境文档，取最后的 packages 与 snapshots。
  const packagesAt = lock.lastIndexOf('\npackages:\n');
  const snapshotsAt = lock.lastIndexOf('\nsnapshots:\n');
  const packagesPart = lock.slice(packagesAt, snapshotsAt);
  const snapshotsPart = lock.slice(snapshotsAt);
  const block = (text: string, key: string): string[] => {
    const lines = text.split('\n');
    // 快照的键可能带 peer 后缀（`'@connectrpc/connect@1.7.0(@bufbuild/protobuf@1.10.0)':`）。
    const start = lines.findIndex(
      (line) =>
        line.startsWith(`  '${key}'`) ||
        line.startsWith(`  ${key}:`) ||
        line.startsWith(`  '${key}(`),
    );
    if (start < 0) throw new Error(`${key} is not in pnpm-lock.yaml`);
    const body: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith('    ')) break;
      body.push(line);
    }
    return body;
  };
  const closure = new Map<string, { integrity: string; os?: string; cpu?: string }>();
  const visit = (key: string) => {
    if (closure.has(key)) return;
    const meta = block(packagesPart, key).join('\n');
    const field = (name: string) => meta.match(new RegExp(`${name}: \\[(\\S+)\\]`, 'u'))?.[1];
    closure.set(key, {
      integrity: meta.match(/integrity: (sha512-[^}\s]+)/u)?.[1] ?? '',
      ...(field('os') !== undefined && { os: field('os') }),
      ...(field('cpu') !== undefined && { cpu: field('cpu') }),
    });
    for (const line of block(snapshotsPart, key)) {
      const dependency = line.match(/^ {6}'?([^':]+)'?: ([^(\s]+)/u);
      if (dependency !== null) visit(`${dependency[1]}@${dependency[2]}`);
    }
  };
  visit(`@cursor/sdk@${CURSOR_SDK_VERSION}`);
  return closure;
}

describe('CURSOR_SDK_PACKAGES', () => {
  it('与 pnpm-lock.yaml 里 SDK 的依赖闭包（版本、sha512、平台包的 os / cpu）一致', () => {
    const closure = lockClosure();
    expect(
      CURSOR_SDK_PACKAGES.map((entry) => [
        `${entry.name}@${entry.version}`,
        {
          integrity: entry.integrity,
          ...(entry.os !== undefined && { os: entry.os }),
          ...(entry.cpu !== undefined && { cpu: entry.cpu }),
        },
      ]).sort(),
    ).toEqual([...closure.entries()].sort());
  });

  it('每个平台装通用的包加自己的平台包；SDK 没有构建的平台不能装', () => {
    const darwin = cursorSdkPackages('darwin', 'arm64')?.map((entry) => entry.name);
    expect(darwin).toHaveLength(8);
    expect(darwin).toContain('@cursor/sdk-darwin-arm64');
    expect(darwin).not.toContain('@cursor/sdk-darwin-x64');
    expect(cursorSdkPackages('win32', 'x64')?.map((entry) => entry.name)).toContain(
      '@cursor/sdk-win32-x64',
    );
    expect(cursorSdkPackages('win32', 'arm64')).toBeUndefined();
    expect(
      tarballUrl('https://registry.npmjs.org', CURSOR_SDK_PACKAGES[0] as CursorSdkPackage),
    ).toBe('https://registry.npmjs.org/@cursor/sdk/-/sdk-1.0.35.tgz');
    expect(tarballUrl('https://r.example', { name: 'zod', version: '3.25.76' })).toBe(
      'https://r.example/zod/-/zod-3.25.76.tgz',
    );
  });
});

describe('CursorSdkInstaller', () => {
  it('装进 versions/<版本>/node_modules 的扁平布局、写指针；只写普通文件、不越界，可执行位照包里的；进度有总数', async () => {
    const { installer: sdk, directory, events } = installer(['a']);
    expect(await sdk.active()).toBeUndefined();
    const installation = await sdk.install();
    const root = join(directory, 'versions', CURSOR_SDK_VERSION);
    expect(installation).toEqual({ root, version: CURSOR_SDK_VERSION });
    expect(await sdk.active()).toEqual(installation);
    expect(JSON.parse(readFileSync(join(directory, 'active.json'), 'utf8'))).toEqual({
      version: CURSOR_SDK_VERSION,
    });
    expect(
      existsSync(join(root, 'node_modules', '@cursor', 'sdk', 'dist', 'esm', 'index.js')),
    ).toBe(true);
    expect(existsSync(join(root, 'node_modules', 'zod', 'index.js'))).toBe(true);
    expect(existsSync(join(root, 'node_modules', '@cursor', 'escape.txt'))).toBe(false);
    expect(existsSync(join(root, 'node_modules', 'escape.txt'))).toBe(false);
    expect(existsSync(join(root, 'node_modules', '@cursor', 'sdk', 'link'))).toBe(false);
    const rg = join(root, 'node_modules', ...platformName.split('/'), 'bin', 'rg');
    if (process.platform !== 'win32') expect(statSync(rg).mode & 0o111).not.toBe(0);
    expect(readdirSync(join(directory, 'versions'))).toEqual([CURSOR_SDK_VERSION]);
    const total = PACKAGES.reduce((sum, entry) => sum + (TARBALLS[entry.name] as Buffer).length, 0);
    expect(events.at(-1)).toEqual({ type: 'installed', installation });
    expect(events).toContainEqual({ type: 'progress', completedBytes: total, totalBytes: total });
    expect(sdk.installing).toBeUndefined();
    // 已装好：再装只是核对，不再下载。
    behaviour.a = 'down';
    expect(await sdk.install()).toEqual(installation);
  });

  it('装好的 SDK 从数据目录加载：包里的裸导入解析到同一个 node_modules，平台包的 rg 与 tree-sitter 经环境变量交给 SDK', async () => {
    delete process.env.CURSOR_RIPGREP_PATH;
    delete process.env.CURSOR_TREE_SITTER_VENDOR_DIR;
    const { installer: sdk } = installer(['a']);
    const { root } = await sdk.install();
    const loaded = await loadCursorSdk(root);
    expect(await loaded.me('k1')).toEqual({ userEmail: 'fake@k1.flat' });
    expect(await loadCursorSdk(root)).toBe(loaded);
    const platformDir = join(root, 'node_modules', ...platformName.split('/'));
    expect(process.env.CURSOR_RIPGREP_PATH).toBe(join(platformDir, 'bin', 'rg'));
    expect(process.env.CURSOR_TREE_SITTER_VENDOR_DIR).toBe(join(platformDir, 'vendor'));
  });

  it('先答的 registry 先用；一个包校验和不对就换下一个 registry', async () => {
    behaviour.a = 'corrupt';
    const { installer: sdk } = installer(['a', 'b']);
    const { root } = await sdk.install();
    expect(readFileSync(join(root, 'node_modules', 'zod', 'index.js'), 'utf8')).toContain('flat');
    expect(existsSync(join(root, 'node_modules', 'zod', 'x'))).toBe(false);
  });

  it('都失败：报 NpmInstallError（带各 registry 的原因），不留半截、不写指针，原因留在 error 里直到下一次安装', async () => {
    behaviour.a = 'corrupt';
    const { installer: sdk, directory, events } = installer(['a']);
    const failure = await sdk.install().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NpmInstallError);
    expect((failure as Error).message).toContain('checksum');
    expect(readdirSync(join(directory, 'versions'))).toEqual([]);
    expect(existsSync(join(directory, 'active.json'))).toBe(false);
    expect(await sdk.active()).toBeUndefined();
    expect(sdk.error).toBe((failure as Error).message);
    expect(events.at(-1)).toEqual({ type: 'failed', message: (failure as Error).message });

    behaviour.a = 'ok';
    const retry = sdk.install();
    expect(sdk.error).toBeUndefined();
    await retry;
  });

  it('没有 registry 答得上：resolve 失败；卡住的下载按空闲超时换下一个', async () => {
    behaviour.a = 'down';
    const down = installer(['a']);
    await expect(down.installer.install()).rejects.toMatchObject({ operation: 'resolve' });

    behaviour.a = 'hang';
    const stuck = installer(['a', 'b'], { idleTimeoutMs: 200 });
    // a 先答元数据也可能是 b 先答；两个都能装上。
    await expect(stuck.installer.install()).resolves.toMatchObject({ version: CURSOR_SDK_VERSION });
  });

  it('取消：抛 NpmInstallCancelled、发 cancelled，不留半截', async () => {
    behaviour.a = 'hang';
    const { installer: sdk, directory, events } = installer(['a']);
    const running = sdk.install();
    expect(sdk.install()).toBe(running);
    expect(sdk.installing).toEqual({ completedBytes: 0 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    sdk.cancel();
    await expect(running).rejects.toBeInstanceOf(NpmInstallCancelled);
    expect(events.at(-1)).toEqual({ type: 'cancelled' });
    expect(sdk.error).toBeUndefined();
    expect(readdirSync(join(directory, 'versions'))).toEqual([]);
  });
});
