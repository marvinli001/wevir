import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { actoolVersion, builderArgs, MAC_FALLBACK_ICON, macIconArgs } from './package.js';
import {
  checkHostTree,
  EXCLUDED_PACKAGES,
  hostTarget,
  nodePlatform,
  pruneDependencies,
} from './stage-resources.js';

describe('hostTarget', () => {
  it('与 fetch-codex.sh 的三元组一致', () => {
    const script = readFileSync(
      new URL('../../../scripts/fetch-codex.sh', import.meta.url),
      'utf8',
    );
    const cases: Array<[NodeJS.Platform, string, string]> = [
      ['darwin', 'arm64', 'aarch64-apple-darwin'],
      ['darwin', 'x64', 'x86_64-apple-darwin'],
      ['linux', 'x64', 'x86_64-unknown-linux-musl'],
      ['linux', 'arm64', 'aarch64-unknown-linux-musl'],
      ['win32', 'x64', 'x86_64-pc-windows-msvc'],
      ['win32', 'arm64', 'aarch64-pc-windows-msvc'],
    ];
    for (const [platform, arch, target] of cases) {
      expect(hostTarget(platform, arch)).toBe(target);
      expect(script).toContain(`  ${target})`);
      // 反过来得到 pnpm 的 --os / --cpu。
      expect(nodePlatform(target)).toEqual({ os: platform, cpu: arch });
    }
    expect(() => hostTarget('freebsd', 'x64')).toThrow('不支持');
    expect(() => nodePlatform('riscv64-unknown-linux-gnu')).toThrow('不认识');
  });

  it('electron-builder 的平台与架构参数', () => {
    expect(builderArgs('aarch64-apple-darwin')).toEqual(['--mac', '--arm64']);
    expect(builderArgs('x86_64-pc-windows-msvc')).toEqual(['--win', '--x64']);
    expect(builderArgs('x86_64-unknown-linux-musl')).toEqual(['--linux', '--x64']);
  });

  it('macOS 图标：actool 26 起用 Icon Composer 工程，否则改用浅色 ICNS', () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>com.apple.actool.version</key><dict>
<key>bundle-version</key><string>24127</string>
<key>short-bundle-version</key><string>26.1</string>
</dict></dict></plist>`;
    expect(actoolVersion(plist)).toBe('26.1');
    expect(actoolVersion('xcrun: error: unable to find utility "actool"')).toBeUndefined();
    expect(macIconArgs('26.1')).toEqual([]);
    expect(macIconArgs('16.4')).toEqual([`-c.mac.icon=${MAC_FALLBACK_ICON}`]);
    expect(macIconArgs(undefined)).toEqual([`-c.mac.icon=${MAC_FALLBACK_ICON}`]);
    expect(existsSync(new URL(`../${MAC_FALLBACK_ICON}`, import.meta.url))).toBe(true);
  });
});

/** 在 `root` 下写一个包（`name` 可带作用域）。 */
function pkg(root: string, name: string, manifest: Record<string, unknown> = {}): string {
  const dir = join(root, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...manifest }));
  return dir;
}

describe('pruneDependencies / checkHostTree', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function deployLike(): void {
    root = mkdtempSync(join(tmpdir(), 'wevir-stage-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: '@wevir/host',
        dependencies: { '@wevir/runtime-adapter': '*', ws: '*' },
      }),
    );
    pkg(root, '@wevir/runtime-adapter', {
      dependencies: { shared: '*' },
      peerDependencies: { vitest: '*' },
    });
    pkg(root, 'ws', { optionalDependencies: { bufferutil: '*' } });
    pkg(root, 'shared');
    // vitest 与只被它用到的包（Vite 那一串）。
    pkg(root, 'vitest', { dependencies: { vite: '*', shared: '*' } });
    pkg(root, 'vite', { scripts: { postinstall: 'node x.js' } });
    // 嵌套的不同版本留在用到它的包里。
    const nested = pkg(join(root, 'node_modules', 'ws'), 'shared', { version: '2.0.0' });
    expect(existsSync(nested)).toBe(true);
    // pnpm 自己的文件。
    mkdirSync(join(root, 'node_modules', '.bin'));
    symlinkSync('../ws/index.js', join(root, 'node_modules', '.bin', 'ws'));
    writeFileSync(join(root, 'node_modules', '.modules.yaml'), '');
  }

  it('从 Host 的依赖出发只留走得到的包，排除的包与只被它用到的包、pnpm 的文件都删掉', () => {
    deployLike();
    const removed = pruneDependencies(root, EXCLUDED_PACKAGES);
    expect(removed.sort()).toEqual(['vite', 'vitest']);
    const left = (name: string) => existsSync(join(root, 'node_modules', name, 'package.json'));
    expect(['@wevir/runtime-adapter', 'ws', 'shared'].every(left)).toBe(true);
    expect(existsSync(join(root, 'node_modules', 'ws', 'node_modules', 'shared'))).toBe(true);
    expect(existsSync(join(root, 'node_modules', '.bin'))).toBe(false);
    expect(existsSync(join(root, 'node_modules', '.modules.yaml'))).toBe(false);
    expect(() => checkHostTree(root, EXCLUDED_PACKAGES)).not.toThrow();
  });

  it('必需的依赖没装上时报错', () => {
    deployLike();
    rmSync(join(root, 'node_modules', 'shared'), { recursive: true });
    expect(() => pruneDependencies(root, EXCLUDED_PACKAGES)).toThrow('shared 没有装上');
  });

  it('不剪枝时 checkHostTree 指出排除的包、安装脚本与符号链接', () => {
    deployLike();
    expect(() => checkHostTree(root, EXCLUDED_PACKAGES)).toThrow(
      /符号链接[\s\S]*vite 有 postinstall 脚本[\s\S]*不该进安装包的包/,
    );
  });
});
