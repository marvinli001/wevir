// 办公文档预览引擎（0.138.0）：DeepSeek 的 `@deepseek-ai/libreoffice-kit`（MPL-2.0，github.com/deepseek-ai/dsh-libreoffice-kit）。
// 安装包不带它（每个平台 150–200 MB），第一次要高保真预览时由 Host 从 npm registry 下载（runtime-adapter 的 npm-closure.ts）：
// Node API 与它的依赖、本平台的引擎包。macOS 与 Windows 用原生引擎（LibreOfficeKit 的 helper 进程），其余平台（Linux）用共享的
// WebAssembly 引擎，三个平台走同一个 API。Windows 的原生引擎经 koffi 建管道，koffi 的平台包也要装。
//
// 版本与 sha512 照 `npm install @deepseek-ai/libreoffice-kit@0.2.0` 的 package-lock.json（不取 registry 给的元数据）。0.2.0 是
// 发布满两周的最新版；升级时重新生成这张表，并核对上游 README 的平台与运行库要求（Windows 要 Visual C++ v14 运行库）。

import { closureFor, type NpmClosurePackage } from '@wevir/runtime-adapter/npm-closure';

export const OFFICE_ENGINE_NAME = 'LibreOffice';
export const OFFICE_KIT_PACKAGE = '@deepseek-ai/libreoffice-kit';
export const OFFICE_KIT_VERSION = '0.2.0';

/** 原生引擎的平台；其余平台用 WebAssembly 引擎。 */
const NATIVE_TARGETS = new Set(['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64']);

/** WebAssembly 引擎能跑的平台（上游只给 Linux 用；macOS 与 Windows 有原生引擎）。 */
const WASM_TARGETS = new Set(['linux-x64', 'linux-arm64']);

const KIT_ENGINES: readonly NpmClosurePackage[] = [
  {
    name: '@deepseek-ai/libreoffice-kit-darwin-arm64',
    version: OFFICE_KIT_VERSION,
    integrity:
      'sha512-dF8KmNflPfVPQD/h1ADaUT94V3vrGEVDxaaLNKpbbY/vNLm5PadTT2W+LFtyEAYLRPUQ+1ZZ1UxWqvFl09BOCQ==',
    os: 'darwin',
    cpu: 'arm64',
  },
  {
    name: '@deepseek-ai/libreoffice-kit-darwin-x64',
    version: OFFICE_KIT_VERSION,
    integrity:
      'sha512-arJTSNoAQMdQeRZpC/4VNS0rnQdA/M9mi9T1Xn8T3pT5Zw4kbRVY+KCZlr3C4WK4xDkLRU4Cp651hYgA1wWwMQ==',
    os: 'darwin',
    cpu: 'x64',
  },
  {
    name: '@deepseek-ai/libreoffice-kit-win32-arm64',
    version: OFFICE_KIT_VERSION,
    integrity:
      'sha512-q0yLj8BusQmAw7FG8pqS7SkcFN0y+8kZt8WtyHflfnJDHPCZPu2T4//7P9qsD7mXuOETUXm5JBrz2phM8pkMNg==',
    os: 'win32',
    cpu: 'arm64',
  },
  {
    name: '@deepseek-ai/libreoffice-kit-win32-x64',
    version: OFFICE_KIT_VERSION,
    integrity:
      'sha512-5Fscl181XAcgKDTanf1poOgJOi5hdKuuLV9KmCuTOvKuirty1+kgMNXIuVQm4Rnq0Yh1mz02x/ThnqrPFta4vQ==',
    os: 'win32',
    cpu: 'x64',
  },
  {
    name: 'koffi',
    version: '3.1.1',
    integrity:
      'sha512-mRX6AMeeKCxSOeOopqAcLAl5jcNvge7NAG8l7rF/8gGJATI0tdHFYjteIdE0mGOtWdsrJOij+PjnP8Q9c1gwgA==',
    os: 'win32',
  },
  {
    name: '@koromix/koffi-win32-arm64',
    version: '3.1.1',
    integrity:
      'sha512-JhqHauEwQvdcWUERxrV5HH/DT9W7hY1A1eU6/o8tB+yck+D3kt5elpRDBt9KjpW6h+vHPy3V0sjDvO0CXyabTA==',
    os: 'win32',
    cpu: 'arm64',
  },
  {
    name: '@koromix/koffi-win32-x64',
    version: '3.1.1',
    integrity:
      'sha512-KqHPmvj6QILhNyI/To8QSihHsijeVGIYYPBOUnXEpcnH2LuLbargY4Hd6dDeTN3Z90uUUxN+1FWz1UnhVzFOiA==',
    os: 'win32',
    cpu: 'x64',
  },
];

const KIT_WASM: NpmClosurePackage = {
  name: '@deepseek-ai/libreoffice-kit-wasm',
  version: OFFICE_KIT_VERSION,
  integrity:
    'sha512-5QQyllsIRe7iXQSc5Xlubh4gqo/lup+qk84fmTKLoIB38cEa7tEmet1AFy/At/+hqAYNAxSOgdBUVp7hvM6sAA==',
};

/** Node API 与它的生产依赖（fflate、fontkit 与 fontkit 的依赖、saxes），各平台都装。 */
const KIT_COMMON: readonly NpmClosurePackage[] = [
  {
    name: OFFICE_KIT_PACKAGE,
    version: OFFICE_KIT_VERSION,
    integrity:
      'sha512-RhmxJgrOi8wWBfV+5V8CDijyqKqmS0f5GNM48ceuHuCYiTVaP5r9deSTlUo/8Hrsvq74hsc7N2RsljHHGdTnrw==',
  },
  {
    name: '@swc/helpers',
    version: '0.5.23',
    integrity:
      'sha512-5lSsMOTXURePglDfvuAQUqkGek9Hg2kksOYay2m0+XR++b2NWYL/4sWyuvVBIs8oKnJaxkdi9whaL/sqN13afw==',
  },
  {
    name: 'base64-js',
    version: '1.5.1',
    integrity:
      'sha512-AKpaYlHn8t4SVbOHCy+b5+KKgvR4vrsD8vbvrbiQJps7fKDTkjkDry6ji0rUJjC0kzbNePLwzxq8iypo41qeWA==',
  },
  {
    name: 'brotli',
    version: '1.3.3',
    integrity:
      'sha512-oTKjJdShmDuGW94SyyaoQvAjf30dZaHnjJ8uAF+u2/vGJkJbJPJAT1gDiOJP5v1Zb6f9KEyW/1HpuaWIXtGHPg==',
  },
  {
    name: 'clone',
    version: '2.1.2',
    integrity:
      'sha512-3Pe/CF1Nn94hyhIYpjtiLhdCoEoz0DqQ+988E9gmeEdQZlojxnOb74wctFyuwWQHzqyf9X7C7MG8juUpqBJT8w==',
  },
  {
    name: 'dfa',
    version: '1.2.0',
    integrity:
      'sha512-ED3jP8saaweFTjeGX8HQPjeC1YYyZs98jGNZx6IiBvxW7JG5v492kamAQB3m2wop07CvU/RQmzcKr6bgcC5D/Q==',
  },
  {
    name: 'fast-deep-equal',
    version: '3.1.3',
    integrity:
      'sha512-f3qQ9oQy9j2AhBe/H9VC91wLmKBCCU/gDOnKNAYG5hswO7BLKj09Hc5HYNz9cGI++xlpDCIgDaitVs03ATR84Q==',
  },
  {
    name: 'fflate',
    version: '0.8.2',
    integrity:
      'sha512-cPJU47OaAoCbg0pBvzsgpTPhmhqI5eJjh/JIu8tPj5q+T7iLvW/JAYUqmE7KOB4R1ZyEhzBaIQpQpardBF5z8A==',
  },
  {
    name: 'fontkit',
    version: '2.0.4',
    integrity:
      'sha512-syetQadaUEDNdxdugga9CpEYVaQIxOwk7GlwZWWZ19//qW4zE5bknOKeMBDYAASwnpaSHKJITRLMF9m1fp3s6g==',
  },
  {
    name: 'pako',
    version: '0.2.9',
    integrity:
      'sha512-NUcwaKxUxWrZLpDG+z/xZaCgQITkA/Dv4V/T6bw7VON6l1Xz/VnrBqrYjZQ12TamKHzITTfOEIYUj48y2KXImA==',
  },
  {
    name: 'restructure',
    version: '3.0.2',
    integrity:
      'sha512-gSfoiOEA0VPE6Tukkrr7I0RBdE0s7H1eFCDBk05l1KIQT1UIKNc5JZy6jdyW6eYH3aR3g5b3PuL77rq0hvwtAw==',
  },
  {
    name: 'saxes',
    version: '6.0.0',
    integrity:
      'sha512-xAg7SOnEhrm5zI3puOOKyy1OMcMlIJZYNJY7xLBwSze0UjhPLnWfj2GF2EpT0jmzaJKIWKHLsaSSajf35bcYnA==',
  },
  {
    name: 'tiny-inflate',
    version: '1.0.3',
    integrity:
      'sha512-pkY1fj1cKHb2seWDy0B16HeWyczlJA9/WW3u3c4z/NiWDsO3DOU5D7nhTLE9CF0yXv/QZFY7sEJmj24dK+Rrqw==',
  },
  {
    name: 'tslib',
    version: '2.8.1',
    integrity:
      'sha512-oJFu94HQb+KVduSUQL7wnpmqnfmLsOA/nAh6b6EH0wCEoK0/mPeXU6c3wKDV83MkOuHPRHtSXKKU99IBazS/2w==',
  },
  {
    name: 'unicode-properties',
    version: '1.4.1',
    integrity:
      'sha512-CLjCCLQ6UuMxWnbIylkisbRj31qxHPAurvena/0iwSVbQ2G1VY5/HjV0IRabOEbDHlzZlRdCrD4NhB0JtU40Pg==',
  },
  {
    name: 'unicode-trie',
    version: '2.0.0',
    integrity:
      'sha512-x7bc76x0bm4prf1VLg79uhAzKw8DVboClSN5VxJuQ+LKDOVEW9CdH+VY7SP+vX7xCYQqzzgQpFqz15zeLvAtZQ==',
  },
  {
    name: 'xmlchars',
    version: '2.2.0',
    integrity:
      'sha512-JZnDKK8B0RCDw84FNdDAIpZK+JuJw+s7Lz8nksI7SIuU3UXJJslUthsi+uWBUYOwPFwW7W7PRLRfUKpxjtjFCw==',
  },
];

/** 全部包（含各平台的引擎包），测试核对用。 */
export const OFFICE_ENGINE_PACKAGES: readonly NpmClosurePackage[] = Object.freeze([
  ...KIT_COMMON,
  ...KIT_ENGINES,
  KIT_WASM,
]);

/** 各平台引擎包 tgz 的字节数（registry 的 Content-Range），加上通用包约 3 MB；界面显示“下载约 N MB”用。 */
const ENGINE_DOWNLOAD_BYTES: Readonly<Record<string, number>> = {
  'darwin-arm64': 69_506_878,
  'darwin-x64': 71_371_895,
  'win32-arm64': 70_692_841,
  'win32-x64': 74_281_691,
  wasm: 48_081_667,
};
const COMMON_DOWNLOAD_BYTES = 3_000_000;

export type OfficeEngineBackend = 'native' | 'wasm';

/** 这个平台用哪种引擎；没有能用的引擎时 undefined。 */
export function officeEngineBackend(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): OfficeEngineBackend | undefined {
  const target = `${platform}-${arch}`;
  if (NATIVE_TARGETS.has(target)) return 'native';
  if (WASM_TARGETS.has(target)) return 'wasm';
  return undefined;
}

/** 这个平台要装的包；不能装时 undefined。原生平台不装 WebAssembly 引擎（上游也是只选一个）。 */
export function officeEnginePackages(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): NpmClosurePackage[] | undefined {
  const backend = officeEngineBackend(platform, arch);
  if (backend === undefined) return undefined;
  const own = closureFor([...KIT_COMMON, ...KIT_ENGINES], platform, arch);
  return backend === 'wasm' ? [...own, KIT_WASM] : own;
}

/** 要下载的字节数（约数）。 */
export function officeEngineDownloadBytes(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): number {
  const backend = officeEngineBackend(platform, arch);
  if (backend === undefined) return 0;
  const key = backend === 'wasm' ? 'wasm' : `${platform}-${arch}`;
  return (ENGINE_DOWNLOAD_BYTES[key] ?? 0) + COMMON_DOWNLOAD_BYTES;
}

/** 解开后约占的空间（最大的 Windows x64 引擎约 200 MB），留出余量。 */
export const OFFICE_ENGINE_REQUIRED_SPACE = 400 * 1024 * 1024;
