// Wevir 替用户装 opencode：假 registry（只在内存里给元数据与 tgz，和真实平台包一样 tgz 里只有一个程序文件）+ 假的 opencode 服务器。

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import type { AccountState } from '@wevir/runtime-adapter';
import { NpmInstallCancelled } from '@wevir/runtime-adapter/npm-package';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeAccounts } from './accounts.js';
import { OpenCodeInstaller } from './install.js';
import { OpenCodeRuntime } from './runtime.js';
import { FAKE_OPENCODE_VERSION, FakeOpenCode } from './test-fixtures/fake-opencode.js';

function tarEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000755\0', 100);
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

/** 平台包：package.json 加程序文件。 */
function platformPackage(binary: string, content: string): Buffer {
  return zlib.gzipSync(
    Buffer.concat([
      tarEntry('package/package.json', Buffer.from('{}')),
      tarEntry(`package/${binary}`, Buffer.from(content)),
      Buffer.alloc(1024),
    ]),
  );
}

const REGISTRY = 'http://registry.test';

/** 假 registry：`packages` 是包名 → { version, tgz }；`requested` 记下被问过的地址。 */
function fakeRegistry(packages: Record<string, { version: string; tgz: Buffer }>) {
  const requested: string[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    requested.push(url);
    const metadata = /^http:\/\/registry\.test\/(.+)\/latest$/u.exec(url);
    if (metadata !== null) {
      const found = packages[decodeURIComponent(metadata[1] as string)];
      if (found === undefined) return new Response('not found', { status: 404 });
      return new Response(
        JSON.stringify({
          version: found.version,
          dist: {
            tarball: `${REGISTRY}/tarballs/${metadata[1]}.tgz`,
            integrity: `sha512-${createHash('sha512').update(found.tgz).digest('base64')}`,
            unpackedSize: 1024,
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    const tarball = /^http:\/\/registry\.test\/tarballs\/(.+)\.tgz$/u.exec(url);
    const found = tarball === null ? undefined : packages[decodeURIComponent(tarball[1] as string)];
    if (found === undefined) return new Response('not found', { status: 404 });
    return new Response(found.tgz, { headers: { 'content-length': String(found.tgz.length) } });
  };
  return { fetch: fetchImpl as typeof fetch, requested };
}

const dirs: string[] = [];
const runtimes: OpenCodeRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wevir-opencode-install-'));
  dirs.push(dir);
  return dir;
}

describe('OpenCodeInstaller', () => {
  it('x64 没有 AVX2：下载 baseline 构建，只取 bin/opencode，装好后 active() 找得到', async () => {
    const registry = fakeRegistry({
      'opencode-darwin-x64-baseline': {
        version: '1.19.3',
        tgz: platformPackage('bin/opencode', '#!/bin/sh\necho 1.19.3\n'),
      },
    });
    const directory = tempDir();
    const validated: string[] = [];
    const installer = new OpenCodeInstaller({
      directory,
      platform: 'darwin',
      arch: 'x64',
      target: async () => ({ avx2: false }),
      validate: async (file) => {
        validated.push(file);
      },
      npm: { fetch: registry.fetch, registries: [REGISTRY] },
    });
    expect(await installer.active()).toBeUndefined();
    const progress: string[] = [];
    const installed = await installer.install((entry) => progress.push(entry.phase));
    expect(installed).toEqual({
      path: join(directory, 'versions', '1.19.3', 'opencode'),
      version: '1.19.3',
    });
    expect(registry.requested[0]).toBe(`${REGISTRY}/opencode-darwin-x64-baseline/latest`);
    expect(progress).toContain('downloading');
    expect(validated).toEqual([expect.stringContaining('.install-')]);
    expect(readFileSync(installed.path, 'utf8')).toContain('echo 1.19.3');
    if (process.platform !== 'win32') expect(statSync(installed.path).mode & 0o111).not.toBe(0);
    expect(await installer.active()).toEqual(installed);
    expect(installer.installing).toBe(false);
  });

  it('有 AVX2：用普通构建；Windows 的程序是 opencode.exe', async () => {
    const registry = fakeRegistry({
      'opencode-windows-x64': {
        version: '1.19.3',
        tgz: platformPackage('bin/opencode.exe', 'MZ'),
      },
    });
    const directory = tempDir();
    const installer = new OpenCodeInstaller({
      directory,
      platform: 'win32',
      arch: 'x64',
      target: async () => ({ avx2: true }),
      validate: async () => {},
      npm: { fetch: registry.fetch, registries: [REGISTRY] },
    });
    const installed = await installer.install(() => {});
    expect(installed.path).toBe(join(directory, 'versions', '1.19.3', 'opencode.exe'));
    expect(registry.requested[0]).toBe(`${REGISTRY}/opencode-windows-x64/latest`);
  });

  it('包里没有 bin/opencode：安装失败，什么都没装', async () => {
    const registry = fakeRegistry({
      'opencode-darwin-arm64': {
        version: '1.19.3',
        tgz: platformPackage('bin/other', 'x'),
      },
    });
    const directory = tempDir();
    const installer = new OpenCodeInstaller({
      directory,
      platform: 'darwin',
      arch: 'arm64',
      validate: async () => {},
      npm: { fetch: registry.fetch, registries: [REGISTRY] },
    });
    await expect(installer.install(() => {})).rejects.toThrow('does not contain bin/opencode');
    expect(await installer.active()).toBeUndefined();
    expect(existsSync(join(directory, 'versions', '1.19.3'))).toBe(false);
  });

  it('下载前取消：不碰 registry', async () => {
    const registry = fakeRegistry({});
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const installer = new OpenCodeInstaller({
      directory: tempDir(),
      platform: 'darwin',
      arch: 'x64',
      target: async () => {
        await gate;
        return { avx2: true };
      },
      validate: async () => {},
      npm: { fetch: registry.fetch, registries: [REGISTRY] },
    });
    const running = installer.install(() => {});
    expect(installer.installing).toBe(true);
    // 安装中再调一次：同一个 Promise。
    expect(installer.install(() => {})).toBe(running);
    installer.cancel();
    release();
    await expect(running).rejects.toBeInstanceOf(NpmInstallCancelled);
    expect(registry.requested).toEqual([]);
    expect(installer.installing).toBe(false);
  });

  it('本平台没有构建：active() 是空，install() 报错', async () => {
    const installer = new OpenCodeInstaller({
      directory: tempDir(),
      platform: 'freebsd',
      arch: 'x64',
      target: async () => ({ avx2: true }),
      validate: async () => {},
    });
    expect(await installer.active()).toBeUndefined();
    await expect(installer.install(() => {})).rejects.toThrow('no opencode build for freebsd-x64');
  });
});

// 账号 + 运行环境 + 默认安装器（假 registry）：装好后用的是 Wevir 装的那份，版本不支持的下载不会被启用。
describe('OpenCodeAccounts：下载安装', () => {
  function setup(
    options: { version?: string; packages?: Parameters<typeof fakeRegistry>[0] } = {},
  ) {
    const fake = new FakeOpenCode();
    const engineDir = tempDir();
    const registry = fakeRegistry(
      options.packages ?? {
        'opencode-darwin-arm64': {
          version: '1.19.3',
          tgz: platformPackage('bin/opencode', 'binary'),
        },
      },
    );
    const probed: string[] = [];
    const runtime = new OpenCodeRuntime({
      engineDir,
      env: { PATH: '' },
      sdk: async () => fake,
      // 用户自己没装：只有 Wevir 装的那份。
      findExecutable: (_custom, managed) => managed,
      probeVersion: async (executable) => {
        probed.push(executable);
        return { ok: true, version: options.version ?? FAKE_OPENCODE_VERSION };
      },
      startServer: fake.start,
      idleTtlMs: 20,
      installerOptions: {
        platform: 'darwin',
        arch: 'arm64',
        npm: { fetch: registry.fetch, registries: [REGISTRY] },
      },
    });
    runtimes.push(runtime);
    const accounts = new OpenCodeAccounts({ runtime, env: {} });
    const seen: AccountState[] = [];
    accounts.onChange((state) => seen.push(state));
    return { fake, runtime, accounts, seen, engineDir, registry, probed };
  }

  it('没装：installed false，带下载（canInstall）和自己安装的命令', async () => {
    const { accounts } = setup();
    expect(await accounts.read('opencode')).toMatchObject({
      status: 'signed_out',
      installed: false,
      canInstall: true,
      installCommand: 'npm install -g opencode-ai',
      loginCommand: 'opencode auth login',
    });
    await expect(accounts.requireReady()).rejects.toMatchObject({
      code: 'engine_unavailable',
      message: expect.stringContaining('download it in Settings'),
    });
  });

  it('下载安装：先报 installing，装好后重新检测，用的是 <引擎目录>/runtime 下的那份，登录命令写全路径', async () => {
    const { accounts, seen, engineDir, probed } = setup();
    const started = await accounts.install('opencode');
    expect(started).toMatchObject({ installed: false, installing: { completedBytes: 0 } });
    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ installed: true }));
    const executable = join(engineDir, 'runtime', 'versions', '1.19.3', 'opencode');
    expect(seen.at(-1)).toMatchObject({
      status: 'signed_in',
      executablePath: executable,
      loginCommand: `"${executable}" auth login`,
    });
    expect(seen.at(-1)?.installing).toBeUndefined();
    expect(seen.at(-1)?.canInstall).toBeUndefined();
    // 下载下来先试跑（版本核对），再启用。
    expect(probed.some((file) => file.includes('.install-'))).toBe(true);
    expect((await accounts.read('opencode')).executablePath).toBe(executable);
    await expect(accounts.requireReady()).resolves.toBeUndefined();
  });

  it('下载下来的版本不支持（2.x）：安装失败，原因进 lastError，不启用', async () => {
    const { accounts, seen, runtime } = setup({ version: '2.0.1' });
    await accounts.install('opencode');
    await vi.waitFor(() =>
      expect(seen.at(-1)).toMatchObject({
        installed: false,
        canInstall: true,
        lastError: expect.stringContaining('(2.x) is not supported yet'),
      }),
    );
    expect(await runtime.installer?.active()).toBeUndefined();
    // 重新检测清掉失败的原因。
    expect((await accounts.read('opencode', { refresh: true })).lastError).toBeUndefined();
  });

  it('下载失败：registry 连不上时说明原因，仍可再下', async () => {
    const { accounts, seen } = setup({ packages: {} });
    await accounts.install('opencode');
    await vi.waitFor(() =>
      expect(seen.at(-1)).toMatchObject({
        installed: false,
        canInstall: true,
        lastError: expect.stringContaining('Could not reach the npm registry'),
      }),
    );
    expect(seen.at(-1)?.installing).toBeUndefined();
  });

  it('Wevir 装的那份跑不起来：当作没装，可以重新下载；用户自己的跑不起来照旧是 installed', async () => {
    const fake = new FakeOpenCode();
    const engineDir = tempDir();
    const registry = fakeRegistry({
      'opencode-darwin-arm64': { version: '1.19.3', tgz: platformPackage('bin/opencode', 'x') },
    });
    const make = (find: (custom: string | null, managed?: string) => string | undefined) => {
      const runtime = new OpenCodeRuntime({
        engineDir,
        env: {},
        sdk: async () => fake,
        findExecutable: find,
        probeVersion: async (executable) =>
          executable.includes('.install-')
            ? { ok: true, version: FAKE_OPENCODE_VERSION }
            : { ok: false, reason: 'failed', message: 'exec format error' },
        startServer: fake.start,
        idleTtlMs: 20,
        installerOptions: {
          platform: 'darwin',
          arch: 'arm64',
          npm: { fetch: registry.fetch, registries: [REGISTRY] },
        },
      });
      runtimes.push(runtime);
      return { runtime, accounts: new OpenCodeAccounts({ runtime, env: {} }) };
    };
    const managed = make((_custom, path) => path);
    const seen: AccountState[] = [];
    managed.accounts.onChange((state) => seen.push(state));
    await managed.accounts.install('opencode');
    await vi.waitFor(() => expect(seen.at(-1)?.installing).toBeUndefined());
    // 装好之后的试跑（上面的探测对非 staging 的路径一律失败）报“跑不起来”。
    expect(await managed.accounts.read('opencode', { refresh: true })).toMatchObject({
      installed: false,
      canInstall: true,
      lastError: 'exec format error',
    });
    const own = make(() => '/opt/opencode');
    expect(await own.accounts.read('opencode', { refresh: true })).toMatchObject({
      installed: true,
      lastError: 'exec format error',
    });
    expect((await own.accounts.read('opencode')).canInstall).toBeUndefined();
  });

  it('本平台没有构建：不给下载，install 报 invalid_input', async () => {
    const fake = new FakeOpenCode();
    const runtime = new OpenCodeRuntime({
      engineDir: tempDir(),
      env: {},
      sdk: async () => fake,
      findExecutable: () => undefined,
      installerOptions: { platform: 'freebsd', arch: 'x64' },
      startServer: fake.start,
    });
    runtimes.push(runtime);
    const accounts = new OpenCodeAccounts({ runtime, env: {} });
    expect((await accounts.read('opencode')).canInstall).toBeUndefined();
    await expect(accounts.install('opencode')).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
