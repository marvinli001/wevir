import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  actoolVersion,
  builderArgs,
  LINUX_HICOLOR,
  MAC_FALLBACK_ICON,
  macIconArgs,
  stageLinuxIcons,
} from './package.js';
import {
  bundleHost,
  checkBundleImports,
  checkHostTree,
  EXCLUDED_PACKAGES,
  entryFiles,
  hostTarget,
  nodePlatform,
  ON_DISK_PACKAGES,
  pruneDependencies,
  pruneUnusedFiles,
  trimNodePty,
  writeBundleManifest,
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

  it('fetch-codex.sh 给每个目标钉了 rg 的 sha256，ripgrep 的许可证随包', () => {
    const script = readFileSync(
      new URL('../../../scripts/fetch-codex.sh', import.meta.url),
      'utf8',
    );
    // 6 个目标各有一个 64 位十六进制的 rg_sha，且互不相同。
    const shas = [...script.matchAll(/^\s+rg_sha="([0-9a-f]{64})"/gm)].map((m) => m[1]);
    expect(shas).toHaveLength(6);
    expect(new Set(shas).size).toBe(6);
    expect(script).toMatch(/^rg_version="\d+\.\d+\.\d+"$/m);
    for (const file of ['LICENSE-MIT', 'UNLICENSE']) {
      const license = new URL(`../licenses/ripgrep/${file}`, import.meta.url);
      expect(readFileSync(license, 'utf8').length).toBeGreaterThan(500);
    }
  });

  it('electron-builder 的平台与架构参数', () => {
    expect(builderArgs('aarch64-apple-darwin')).toEqual(['--mac', '--arm64']);
    expect(builderArgs('x86_64-pc-windows-msvc')).toEqual(['--win', '--x64']);
    expect(builderArgs('x86_64-unknown-linux-musl')).toEqual([
      '--linux',
      '--x64',
      `-c.linux.artifactName=\${productName}-\${version}-linux-x64.\${ext}`,
    ]);
    expect(builderArgs('aarch64-unknown-linux-musl')).toContain(
      `-c.linux.artifactName=\${productName}-\${version}-linux-arm64.\${ext}`,
    );
  });

  it('Linux 图标：hicolor 的各个尺寸平铺成 electron-builder 认的 <尺寸>x<尺寸>.png', () => {
    const dest = mkdtempSync(join(tmpdir(), 'wevir-linux-icons-'));
    try {
      const sizes = stageLinuxIcons(LINUX_HICOLOR, dest);
      expect(sizes).toContain('16x16');
      expect(sizes).toContain('512x512');
      expect(readdirSync(dest).sort()).toEqual(sizes.map((size) => `${size}.png`).sort());
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
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

describe('bundleHost / checkBundleImports / writeBundleManifest', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function file(path: string, content: string): void {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }

  it('依赖打进 bundle，import() 拆成按需加载的文件，ON_DISK_PACKAGES 留成外部依赖；产物能跑', async () => {
    root = mkdtempSync(join(tmpdir(), 'wevir-bundle-'));
    file('package.json', JSON.stringify({ name: '@wevir/host', type: 'module' }));
    file(
      'dist/main.js',
      [
        "import { greet } from 'esm-dep';",
        "const lazy = (await import('cjs-dep')).default;",
        "const zod = await import('zod').catch(() => 'zod stays outside the bundle');",
        'console.log(greet(lazy.name), typeof zod);',
      ].join('\n'),
    );
    pkg(root, 'esm-dep', { type: 'module', exports: './index.js' });
    file('node_modules/esm-dep/index.js', 'export const greet = (n) => "hello " + n;');
    pkg(root, 'cjs-dep', { main: 'index.js' });
    file('node_modules/cjs-dep/index.js', "module.exports = { name: 'cjs' };");
    pkg(root, 'zod', { version: '4.0.0', type: 'module', exports: './index.js' });
    file('node_modules/zod/index.js', 'export const z = 1;');

    const files = await bundleHost(root);
    expect(files[0]).toBe('main.js');
    expect(files.length).toBeGreaterThan(1);
    expect(readdirSync(join(root, 'dist')).sort()).toEqual([...files].sort());
    const main = readFileSync(join(root, 'dist', 'main.js'), 'utf8');
    // esm-dep 打进 main.js，cjs-dep 拆成按需加载的文件，zod 留在外面。
    expect(main).toContain('"hello " + n');
    expect(main).not.toMatch(/from "esm-dep"|import\("cjs-dep"\)/);
    expect(main).toMatch(/import\("zod"\)/);

    // 只留 zod：bundle 照样能跑，打进去的包不再需要。
    writeBundleManifest(root);
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).toEqual({
      name: 'wevir-host',
      private: true,
      type: 'module',
      main: 'dist/main.js',
      dependencies: { zod: '4.0.0' },
      optionalDependencies: {},
    });
    expect(pruneDependencies(root, EXCLUDED_PACKAGES).sort()).toEqual(['cjs-dep', 'esm-dep']);
    const output = execFileSync(process.execPath, [join(root, 'dist', 'main.js')], {
      encoding: 'utf8',
    });
    expect(output.trim()).toBe('hello cjs object');
  });

  it('checkBundleImports 指出没打进去的 import 与运行时的 require，内置模块、外部包与相对路径不算', () => {
    const chunk = (code: string, imports: string[] = []) => ({
      fileName: 'main.js',
      imports,
      dynamicImports: [],
      code,
    });
    const allowed = [...ON_DISK_PACKAGES, ...EXCLUDED_PACKAGES];
    expect(() =>
      checkBundleImports(
        [
          chunk(
            [
              'const require = createRequire(import.meta.url);',
              "require('node-pty'); require.resolve('zod/package.json'); require('./local.js');",
              '__require("fs"); __require("node:path"); some.require("x");',
            ].join('\n'),
            ['node:fs', 'events', 'zod', '@anthropic-ai/claude-agent-sdk', 'chunk-1.js'],
          ),
          { ...chunk(''), fileName: 'chunk-1.js' },
        ],
        allowed,
      ),
    ).not.toThrow();
    expect(() =>
      checkBundleImports(
        [
          chunk(
            [
              "createRequire(import.meta.url)('vscode-languageserver-protocol/node');",
              "const t = require$1('turndown');",
            ].join('\n'),
            ['ws'],
          ),
        ],
        allowed,
      ),
    ).toThrow(
      /main\.js：import ws[\s\S]*require vscode-languageserver-protocol\/node[\s\S]*require turndown/,
    );
  });
});

describe('pruneUnusedFiles', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function file(path: string, content = ''): void {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }

  it('删掉 TypeScript 文件、source map 与包根目录的测试目录，留下入口、许可证与 JS', () => {
    root = mkdtempSync(join(tmpdir(), 'wevir-stage-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@wevir/host' }));
    const zod = pkg(root, 'zod', {
      exports: {
        '.': {
          '@zod/source': './src/index.ts',
          types: './index.d.cts',
          import: './index.js',
          require: './index.cjs',
        },
      },
    });
    file('node_modules/zod/index.js');
    file('node_modules/zod/index.cjs');
    file('node_modules/zod/index.d.cts');
    file('node_modules/zod/index.d.ts');
    file('node_modules/zod/index.js.map');
    file('node_modules/zod/src/index.ts');
    file('node_modules/zod/src/v4/core.ts');
    file('node_modules/zod/LICENSE');
    pkg(root, 'domino', { main: './lib/index.js' });
    file('node_modules/domino/lib/index.js');
    file('node_modules/domino/test/w3c/a.js');
    file('node_modules/domino/test/b.html');
    file('node_modules/domino/.yarn/plugins/x.cjs');
    // 不在包根目录的 test 目录是包的一部分，留下；嵌套的 node_modules 里的包同样处理。
    file('node_modules/domino/lib/test/helper.js');
    pkg(join(root, 'node_modules', 'domino'), 'inner', { main: 'index.js' });
    file('node_modules/domino/node_modules/inner/index.js');
    file('node_modules/domino/node_modules/inner/index.d.mts');
    file('node_modules/domino/node_modules/inner/tests/t.js');

    expect(pruneUnusedFiles(root)).toBe(10);
    const has = (path: string) => existsSync(join(root, path));
    for (const kept of [
      'node_modules/zod/index.js',
      'node_modules/zod/index.cjs',
      'node_modules/zod/LICENSE',
      'node_modules/domino/lib/index.js',
      'node_modules/domino/lib/test/helper.js',
      'node_modules/domino/node_modules/inner/index.js',
    ]) {
      expect(has(kept), kept).toBe(true);
    }
    for (const gone of [
      'node_modules/zod/index.d.ts',
      'node_modules/zod/index.js.map',
      'node_modules/zod/src',
      'node_modules/domino/test',
      'node_modules/domino/.yarn',
      'node_modules/domino/node_modules/inner/index.d.mts',
      'node_modules/domino/node_modules/inner/tests',
    ]) {
      expect(has(gone), gone).toBe(false);
    }
    expect(() => checkHostTree(root, EXCLUDED_PACKAGES)).not.toThrow();
    // 入口被删掉时 checkHostTree 报出来。
    rmSync(join(zod, 'index.cjs'));
    expect(() => checkHostTree(root, EXCLUDED_PACKAGES)).toThrow('zod 的入口不在：./index.cjs');
  });

  it('entryFiles 只取 Node 会加载的文件', () => {
    expect(
      entryFiles({
        main: 'main.js',
        bin: { a: './bin/a.js' },
        exports: {
          '.': { '@x/source': './src/index.ts', types: './index.d.ts', default: './index.js' },
          './features/*': './features/*.js',
          './list': ['./list.mjs', './list.cjs'],
        },
      }),
    ).toEqual(['main.js', './bin/a.js', './index.js', './list.mjs', './list.cjs']);
  });
});

describe('trimNodePty', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** 照 node-pty 1.1.0 的 npm 包：各平台的预编译、源码、安装脚本，spawn-helper 没有执行位。 */
  function nodePty(): string {
    root = mkdtempSync(join(tmpdir(), 'wevir-pty-'));
    const dir = pkg(root, 'node-pty', {
      scripts: { install: 'node scripts/prebuild.js || node-gyp rebuild', postinstall: 'x' },
      dependencies: { 'node-addon-api': '*' },
    });
    const files = [
      'LICENSE',
      'lib/index.js',
      'src/unix/pty.cc',
      'deps/winpty/x.h',
      'third_party/conpty/1/win10-x64/conpty.dll',
      'binding.gyp',
      'scripts/prebuild.js',
      'prebuilds/darwin-arm64/pty.node',
      'prebuilds/darwin-arm64/spawn-helper',
      'prebuilds/darwin-x64/pty.node',
      'prebuilds/win32-x64/conpty.node',
      'prebuilds/win32-x64/conpty.pdb',
      'prebuilds/win32-x64/conpty_console_list.node',
      'prebuilds/win32-x64/pty.node',
      'prebuilds/win32-x64/winpty.dll',
      'prebuilds/win32-x64/winpty-agent.exe',
      'prebuilds/win32-x64/conpty/conpty.dll',
    ];
    for (const file of files) {
      mkdirSync(join(dir, file, '..'), { recursive: true });
      writeFileSync(join(dir, file), '');
    }
    return dir;
  }

  const listing = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (at: string, prefix: string) => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(at, entry.name), `${prefix}${entry.name}/`);
        else out.push(`${prefix}${entry.name}`);
      }
    };
    walk(dir, '');
    return out.sort();
  };

  it('macOS：只留目标架构的预编译，spawn-helper 补上执行位；审查过的安装脚本不挡 checkHostTree', () => {
    const dir = nodePty();
    expect(() => checkHostTree(root, EXCLUDED_PACKAGES)).not.toThrow();
    expect(trimNodePty(root, 'darwin', 'arm64')).toBe(join(dir, 'prebuilds', 'darwin-arm64'));
    expect(listing(dir)).toEqual([
      'LICENSE',
      'lib/index.js',
      'package.json',
      'prebuilds/darwin-arm64/pty.node',
      'prebuilds/darwin-arm64/spawn-helper',
    ]);
    // Windows 的文件系统没有执行位，只在能表达它的平台上查。
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'prebuilds/darwin-arm64/spawn-helper')).mode & 0o111).toBe(0o111);
    }
  });

  it('Linux：从 build-node-pty.sh 的输出目录复制 pty.node；没有时整个去掉', () => {
    const dir = nodePty();
    const built = mkdtempSync(join(tmpdir(), 'wevir-pty-built-'));
    try {
      mkdirSync(join(built, 'linux-arm64'));
      writeFileSync(join(built, 'linux-arm64', 'pty.node'), 'arm64');
      expect(trimNodePty(root, 'linux', 'arm64', built)).toBe(
        join(dir, 'prebuilds', 'linux-arm64'),
      );
      expect(listing(dir)).toEqual([
        'LICENSE',
        'lib/index.js',
        'package.json',
        'prebuilds/linux-arm64/pty.node',
      ]);
      expect(readFileSync(join(dir, 'prebuilds/linux-arm64/pty.node'), 'utf8')).toBe('arm64');
      // 只有另一个架构的：这个架构没有用户终端。
      rmSync(root, { recursive: true, force: true });
      nodePty();
      expect(trimNodePty(root, 'linux', 'x64', built)).toBeUndefined();
      expect(existsSync(join(root, 'node_modules', 'node-pty'))).toBe(false);
    } finally {
      rmSync(built, { recursive: true, force: true });
    }
  });

  it('Windows：去掉调试符号与用不到的 conpty.dll，winpty 留给旧版 Windows', () => {
    const dir = nodePty();
    trimNodePty(root, 'win32', 'x64');
    expect(listing(join(dir, 'prebuilds'))).toEqual([
      'win32-x64/conpty.node',
      'win32-x64/conpty_console_list.node',
      'win32-x64/pty.node',
      'win32-x64/winpty-agent.exe',
      'win32-x64/winpty.dll',
    ]);
  });
});
