import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OfficeEngineStatus } from '@wevir/protocol';
import type {
  NpmClosureInstallation,
  NpmClosureInstallEvent,
  NpmClosureInstaller,
} from '@wevir/runtime-adapter/npm-closure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OFFICE_ENGINE_PACKAGES,
  officeEngineBackend,
  officeEngineDownloadBytes,
  officeEnginePackages,
} from './engine.js';
import { OfficeConversionFailed, type OfficeKit, OfficeService } from './service.js';

// 预览引擎的下载与转换：安装器与引擎 API 换成假的（真的下载与转换在 office.engine.integration.test.ts，CI 在三个平台跑）。

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wevir-office-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 假安装器：`active()` 给 `installed`；`install()` 发出 installed 事件。 */
function fakeInstaller(installed?: NpmClosureInstallation) {
  const listeners = new Set<(event: NpmClosureInstallEvent) => void>();
  const state = {
    installation: installed,
    uninstalled: 0,
    installing: undefined as { completedBytes: number } | undefined,
  };
  const installer = {
    supported: true,
    get installing() {
      return state.installing;
    },
    error: undefined,
    active: async () => state.installation,
    install: async () => {
      const installation = { root: tempDir(), version: '0.2.0' };
      state.installation = installation;
      for (const listener of listeners) listener({ type: 'installed', installation });
      return installation;
    },
    cancel: () => {},
    uninstall: async () => {
      state.uninstalled += 1;
      state.installation = undefined;
    },
    onChange: (listener: (event: NpmClosureInstallEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { installer: installer as unknown as NpmClosureInstaller, state };
}

/** 假引擎：把源文件的名字写进 PDF；`fail` 时抛带 `code` 的错误（同上游的 ConversionError）。 */
function fakeKit(options: { fail?: string; pageCount?: number; delayMs?: number } = {}) {
  const calls = { render: 0, created: 0, disposed: 0 };
  const kit: OfficeKit = {
    createConverter: async () => {
      calls.created += 1;
      return {
        render: async ({ inputPath, outputPath }) => {
          calls.render += 1;
          if (options.delayMs !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, options.delayMs));
          }
          if (options.fail !== undefined) {
            throw Object.assign(new Error(`engine said ${options.fail}`), { code: options.fail });
          }
          writeFileSync(outputPath, `%PDF-1.7 ${readFileSync(inputPath, 'utf8')}`);
          return { missingFonts: ['Calibri', 'Calibri'], pageCount: options.pageCount ?? 3 };
        },
        dispose: async () => {
          calls.disposed += 1;
        },
      };
    },
  };
  return { kit, calls };
}

function sourceFile(
  dir: string,
  name: string,
  text = 'hello',
): {
  real: string;
  size: number;
  mtimeMs: number;
} {
  const real = join(dir, name);
  writeFileSync(real, text);
  return { real, size: text.length, mtimeMs: 1_760_000_000_000 };
}

describe('引擎的包与平台', () => {
  it('macOS 与 Windows 用原生引擎，Linux 用 WebAssembly 引擎；别的平台不能装', () => {
    expect(officeEngineBackend('darwin', 'arm64')).toBe('native');
    expect(officeEngineBackend('win32', 'x64')).toBe('native');
    expect(officeEngineBackend('linux', 'x64')).toBe('wasm');
    expect(officeEngineBackend('linux', 'arm64')).toBe('wasm');
    expect(officeEngineBackend('freebsd', 'x64')).toBeUndefined();
    expect(officeEnginePackages('freebsd', 'x64')).toBeUndefined();
  });

  it('每个平台装 Node API 与通用依赖加自己的一个引擎；Windows 另装 koffi 与它的平台包', () => {
    const names = (platform: NodeJS.Platform, arch: string) =>
      (officeEnginePackages(platform, arch) ?? []).map((entry) => entry.name);
    const mac = names('darwin', 'arm64');
    expect(mac).toContain('@deepseek-ai/libreoffice-kit');
    expect(mac).toContain('fontkit');
    expect(mac.filter((name) => name.startsWith('@deepseek-ai/libreoffice-kit-'))).toEqual([
      '@deepseek-ai/libreoffice-kit-darwin-arm64',
    ]);
    expect(mac).not.toContain('koffi');
    const windows = names('win32', 'arm64');
    expect(windows.filter((name) => name.startsWith('@deepseek-ai/libreoffice-kit-'))).toEqual([
      '@deepseek-ai/libreoffice-kit-win32-arm64',
    ]);
    expect(windows).toContain('koffi');
    expect(windows).toContain('@koromix/koffi-win32-arm64');
    expect(windows).not.toContain('@koromix/koffi-win32-x64');
    const linux = names('linux', 'x64');
    expect(linux.filter((name) => name.startsWith('@deepseek-ai/libreoffice-kit-'))).toEqual([
      '@deepseek-ai/libreoffice-kit-wasm',
    ]);
    expect(linux).not.toContain('koffi');
  });

  it('包表里每个包都钉了 sha512，名字不重复；下载大小按平台给', () => {
    const names = OFFICE_ENGINE_PACKAGES.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of OFFICE_ENGINE_PACKAGES) {
      expect(entry.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    }
    expect(officeEngineDownloadBytes('darwin', 'arm64')).toBeGreaterThan(60_000_000);
    expect(officeEngineDownloadBytes('linux', 'x64')).toBeLessThan(
      officeEngineDownloadBytes('win32', 'x64'),
    );
    expect(officeEngineDownloadBytes('freebsd', 'x64')).toBe(0);
  });
});

describe('OfficeService', () => {
  it('状态：没装是 missing（带下载大小与引擎类型），不支持的平台是 unsupported', async () => {
    const { installer } = fakeInstaller();
    const service = new OfficeService({
      directory: tempDir(),
      installer,
      platform: 'darwin',
      arch: 'arm64',
    });
    await service.init();
    expect(service.status()).toMatchObject({
      state: 'missing',
      engineName: 'LibreOffice',
      backend: 'native',
    });
    expect(service.status().downloadBytes).toBeGreaterThan(0);
    const unsupported = new OfficeService({
      directory: tempDir(),
      installer: fakeInstaller().installer,
      platform: 'freebsd',
      arch: 'x64',
    });
    expect(unsupported.status().state).toBe('unsupported');
    expect(unsupported.install().status.state).toBe('unsupported');
  });

  it('install 装好后经 watch 通知 ready（带占用的字节数）；启动时读到装好的引擎也是 ready', async () => {
    const { installer } = fakeInstaller();
    const service = new OfficeService({
      directory: tempDir(),
      installer,
      platform: 'linux',
      arch: 'x64',
    });
    await service.init();
    const seen: OfficeEngineStatus[] = [];
    service.watch((status) => seen.push(status));
    service.install();
    await vi.waitFor(() => expect(seen.at(-1)?.state).toBe('ready'));
    expect(seen.at(-1)).toMatchObject({ backend: 'wasm', installedBytes: 0 });

    const root = tempDir();
    writeFileSync(join(root, 'engine.bin'), 'x'.repeat(100));
    const restarted = new OfficeService({
      directory: tempDir(),
      installer: fakeInstaller({ root, version: '0.2.0' }).installer,
      platform: 'linux',
      arch: 'x64',
    });
    await restarted.init();
    expect(restarted.status()).toMatchObject({ state: 'ready', installedBytes: 100 });
  });

  it('convert：引擎没装是 engine_missing；不能转的扩展名是 unsupported；超过上限是 too_large', async () => {
    const dir = tempDir();
    const service = new OfficeService({
      directory: tempDir(),
      installer: fakeInstaller().installer,
    });
    await service.init();
    await expect(service.convert(sourceFile(dir, 'a.docx'))).rejects.toMatchObject({
      reason: 'engine_missing',
    });
    await expect(service.convert(sourceFile(dir, 'a.key'))).rejects.toMatchObject({
      reason: 'unsupported',
    });
    await expect(
      service.convert({ ...sourceFile(dir, 'b.pptx'), size: 65 * 1024 * 1024 }),
    ).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('convert 转出 PDF 放进缓存；同一份文件只转一次（同时来的共用一次），改过的文件重新转', async () => {
    const dir = tempDir();
    const directory = tempDir();
    const { kit, calls } = fakeKit({ delayMs: 20 });
    const service = new OfficeService({
      directory,
      installer: fakeInstaller({ root: tempDir(), version: '0.2.0' }).installer,
      loadKit: async () => kit,
    });
    await service.init();
    const source = sourceFile(dir, '报告.DOCX', 'body');
    const [first, second] = await Promise.all([service.convert(source), service.convert(source)]);
    expect(calls.render).toBe(1);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ pageCount: 3, missingFonts: ['Calibri'] });
    expect(readFileSync(join(service.pdfDirectory, first.file), 'utf8')).toBe('%PDF-1.7 body');
    expect(await service.convert(source)).toEqual(first);
    expect(calls.render).toBe(1);
    const changed = await service.convert({ ...source, mtimeMs: source.mtimeMs + 1 });
    expect(changed.file).not.toBe(first.file);
    expect(calls.render).toBe(2);
    // 转换用的私有目录不留下。
    expect(readdirSync(join(directory, 'work'))).toEqual([]);
    await service.dispose();
    expect(calls.disposed).toBe(1);
  });

  it('引擎的错误码归到 unavailable；Windows 上引擎起不来时提示装 Visual C++ 运行库', async () => {
    const dir = tempDir();
    const cases: [string, string][] = [
      ['invalid-document', 'invalid_document'],
      ['input-too-large', 'too_large'],
      ['output-too-large', 'too_large'],
      ['timeout', 'timeout'],
      ['unsupported-format', 'unsupported'],
      ['failed', 'failed'],
    ];
    for (const [code, reason] of cases) {
      const service = new OfficeService({
        directory: tempDir(),
        installer: fakeInstaller({ root: tempDir(), version: '0.2.0' }).installer,
        loadKit: async () => fakeKit({ fail: code }).kit,
      });
      await service.init();
      const failure = await service.convert(sourceFile(dir, 'x.pptx')).catch((error) => error);
      expect(failure).toBeInstanceOf(OfficeConversionFailed);
      expect((failure as OfficeConversionFailed).reason).toBe(reason);
    }
    const windows = new OfficeService({
      directory: tempDir(),
      installer: fakeInstaller({ root: tempDir(), version: '0.2.0' }).installer,
      loadKit: async () => fakeKit({ fail: 'unavailable' }).kit,
      platform: 'win32',
      arch: 'x64',
    });
    await windows.init();
    const failure = (await windows
      .convert(sourceFile(dir, 'x.xls'))
      .catch((error) => error)) as OfficeConversionFailed;
    expect(failure.reason).toBe('failed');
    expect(failure.message).toContain('Visual C++');
  });

  it('缓存超过上限时删掉最久没用的；转换器闲置后释放，下次再建', async () => {
    const dir = tempDir();
    const { kit, calls } = fakeKit();
    const service = new OfficeService({
      directory: tempDir(),
      installer: fakeInstaller({ root: tempDir(), version: '0.2.0' }).installer,
      loadKit: async () => kit,
      cacheMaxEntries: 1,
      idleMs: 10,
    });
    await service.init();
    const first = await service.convert(sourceFile(dir, 'a.odt'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await service.convert(sourceFile(dir, 'b.ods'));
    await vi.waitFor(() => {
      const files = readdirSync(service.pdfDirectory);
      expect(files).toContain(second.file);
      expect(files).not.toContain(first.file);
    });
    await vi.waitFor(() => expect(calls.disposed).toBe(2));
    expect(calls.created).toBe(2);
  });

  it('uninstall 释放转换器、删引擎与 PDF 缓存，状态回到 missing', async () => {
    const dir = tempDir();
    const { kit, calls } = fakeKit();
    const { installer, state } = fakeInstaller({ root: tempDir(), version: '0.2.0' });
    const service = new OfficeService({
      directory: tempDir(),
      installer,
      loadKit: async () => kit,
      platform: 'darwin',
      arch: 'x64',
    });
    await service.init();
    await service.convert(sourceFile(dir, 'a.ppt'));
    const result = await service.uninstall();
    expect(result.status.state).toBe('missing');
    expect(state.uninstalled).toBe(1);
    expect(calls.disposed).toBe(1);
    expect(() => readdirSync(service.pdfDirectory)).toThrow();
  });
});
