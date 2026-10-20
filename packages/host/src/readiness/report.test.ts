// 预检报告：在临时目录里摆出各种项目（都不是 Git 仓库），工具探测换成假的，逐项核对状态、原因、依据与安装方案。
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CheckDefinition, ReadinessReport } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePnpmLock, parseYarnLock } from './node.js';
import type { ProbeResult } from './probe.js';
import { buildReport } from './report.js';
import { relevantBlocking } from './service.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), 'wevir-readiness-'));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

/** 假的探测：给了版本的就是装了，`null` 是找不到。 */
function fakeProbe(tools: Record<string, string | null | { exitCode: number; output: string }>) {
  const asked: string[][] = [];
  const probe = async (names: readonly string[]) => {
    asked.push([...names]);
    const map = new Map<string, ProbeResult>();
    for (const name of names) {
      const value = tools[name];
      const command = `${name} --version`;
      if (value === undefined || value === null) {
        map.set(name, { name, command, exitCode: 127, output: '', problem: 'not_found' });
      } else if (typeof value === 'string') {
        map.set(name, {
          name,
          path: `/usr/local/bin/${name}`,
          command,
          exitCode: 0,
          output: value,
        });
      } else {
        map.set(name, { name, path: `/usr/local/bin/${name}`, command, ...value });
      }
    }
    return map;
  };
  return { probe, asked };
}

const WS = 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR' as const;

async function report(
  root: string,
  tools: Record<string, string | null | { exitCode: number; output: string }>,
  extra: Partial<Parameters<typeof buildReport>[0]> = {},
): Promise<ReadinessReport> {
  return buildReport({
    workspaceId: WS,
    root,
    checks: [],
    env: {},
    platform: 'darwin',
    home: join(root, '.home-none'),
    probe: fakeProbe(tools).probe,
    credentials: new Set(),
    ...extra,
  });
}

const item = (r: ReadinessReport, id: string) => r.items.find((entry) => entry.id === id);

const pnpmLock = (deps: Record<string, string>) =>
  [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    ...Object.entries(deps).flatMap(([name, spec]) => [
      `      ${name}:`,
      `        specifier: ${spec}`,
      `        version: ${spec.replace(/^[\^~]/, '')}`,
    ]),
    '',
    'packages: {}',
    '',
  ].join('\n');

function installed(root: string, ...names: string[]) {
  for (const name of names) {
    mkdirSync(join(root, 'node_modules', name), { recursive: true });
    writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name }));
  }
  writeFileSync(join(root, 'node_modules', '.modules.yaml'), 'layoutVersion: 5\n');
}

function age(root: string, path: string, secondsAgo: number) {
  const time = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(join(root, path), time, time);
}

describe('Node 项目', () => {
  it('没有依赖目录：缺依赖，按锁文件给出 pnpm install --frozen-lockfile，列出项目的安装脚本', async () => {
    const root = project({
      'package.json': {
        packageManager: 'pnpm@12.6.0',
        engines: { node: '>=24.15' },
        scripts: { postinstall: 'node scripts/setup.js', test: 'vitest run' },
        dependencies: { zod: '^4.6.5' },
      },
      'pnpm-lock.yaml': pnpmLock({ zod: '^4.6.5' }),
    });
    const r = await report(root, { node: 'v24.21.0', pnpm: '12.6.0' });
    expect(r.status).toBe('not_ready');
    expect(item(r, 'dependencies::')).toMatchObject({
      status: 'missing',
      reason: 'dependencies_missing',
      blocking: true,
    });
    expect(item(r, 'lockfile::')).toMatchObject({ status: 'ready' });
    expect(item(r, 'runtime::node')).toMatchObject({
      status: 'ready',
      required: '>=24.15',
      found: '24.21.0',
    });
    expect(item(r, 'package_manager::pnpm')).toMatchObject({
      status: 'ready',
      required: '12.6.0',
      found: '12.6.0',
    });
    expect(item(r, 'package_manager::pnpm')?.evidence).toContainEqual({
      kind: 'file',
      path: 'package.json',
      detail: 'packageManager: pnpm@12.6.0',
    });
    expect(r.plans).toHaveLength(1);
    expect(r.plans[0]).toMatchObject({
      command: 'pnpm install --frozen-lockfile',
      lockfile: 'pnpm-lock.yaml',
      writesLockfile: false,
      reason: 'dependencies_missing',
      scripts: { project: ['postinstall: node scripts/setup.js'], dependencies: 'restricted' },
    });
    expect(r.plans[0]?.id).toMatch(/^pln_[0-9a-f]{12}$/);
  });

  it('依赖都在且比锁文件新：就绪，没有方案；锁文件后来改过：依赖过期', async () => {
    const root = project({
      'package.json': { dependencies: { zod: '^4.6.5' } },
      'pnpm-lock.yaml': pnpmLock({ zod: '^4.6.5' }),
    });
    installed(root, 'zod');
    age(root, 'pnpm-lock.yaml', 60);
    const ready = await report(root, { node: 'v24.21.0', pnpm: '12.6.0' });
    expect(ready.status).toBe('ready');
    expect(item(ready, 'dependencies::')?.status).toBe('ready');
    expect(ready.plans).toEqual([]);

    age(root, 'node_modules/.modules.yaml', 120);
    age(root, 'pnpm-lock.yaml', 0);
    const outdated = await report(root, { node: 'v24.21.0', pnpm: '12.6.0' });
    expect(item(outdated, 'dependencies::')).toMatchObject({
      status: 'incompatible',
      reason: 'dependencies_outdated',
    });
    expect(outdated.plans[0]?.reason).toBe('dependencies_outdated');
  });

  it('上次安装没跑完（停止、失败、超时）：依赖目录看着在也算缺，重新给出方案；之后装过就不算', async () => {
    const root = project({
      'package.json': { dependencies: { zod: '^4.6.5' } },
      'pnpm-lock.yaml': pnpmLock({ zod: '^4.6.5' }),
    });
    installed(root, 'zod');
    age(root, 'pnpm-lock.yaml', 60);
    age(root, 'node_modules/.modules.yaml', 30);
    const install = {
      id: 'ins_01JA2B3C4D5E6F7G8H9JKMNPQR' as const,
      workspaceId: WS,
      root,
      planId: 'pln_x',
      path: '',
      manager: 'pnpm',
      command: 'pnpm install --frozen-lockfile',
      status: 'cancelled' as const,
      reason: 'user',
      startedAt: new Date(Date.now() - 20_000).toISOString(),
      finishedAt: new Date(Date.now() - 10_000).toISOString(),
      timeoutMs: 60_000,
      bytes: 0,
    };
    const r = await report(root, { node: 'v24.21.0', pnpm: '12.6.0' }, { install });
    expect(r.status).toBe('not_ready');
    expect(item(r, 'dependencies::')).toMatchObject({
      status: 'missing',
      reason: 'install_incomplete',
      blocking: true,
    });
    expect(r.plans[0]).toMatchObject({
      command: 'pnpm install --frozen-lockfile',
      reason: 'install_incomplete',
    });

    // 依赖目录比那次安装新（在终端里装过）：就绪。
    age(root, 'node_modules/.modules.yaml', 0);
    const later = await report(root, { node: 'v24.21.0', pnpm: '12.6.0' }, { install });
    expect(later.status).toBe('ready');
    expect(later.plans).toEqual([]);
    // 成功的安装不影响。
    age(root, 'node_modules/.modules.yaml', 30);
    const ok = await report(
      root,
      { node: 'v24.21.0', pnpm: '12.6.0' },
      { install: { ...install, status: 'succeeded' } },
    );
    expect(ok.status).toBe('ready');
  });

  it('嵌套的项目用同一个已就绪的工具：只列上层那一项', async () => {
    const root = project({
      'package.json': { dependencies: { local: 'file:./local' } },
      'local/package.json': { name: 'local', version: '1.0.0' },
    });
    const r = await report(root, { node: 'v24.21.0', npm: '11.0.0' });
    expect(r.items.filter((entry) => entry.name === 'node').map((entry) => entry.path)).toEqual([
      '',
    ]);
    expect(r.items.filter((entry) => entry.name === 'npm').map((entry) => entry.path)).toEqual([
      '',
    ]);
  });

  it('清单里加了依赖却没进锁文件：锁文件不一致，方案改成会写锁文件的安装', async () => {
    const root = project({
      'package.json': { dependencies: { zod: '^4.6.5', 'left-pad': '^1.3.0' } },
      'pnpm-lock.yaml': pnpmLock({ zod: '^4.6.5' }),
    });
    installed(root, 'zod');
    const r = await report(root, { node: 'v24.21.0', pnpm: '12.6.0' });
    expect(item(r, 'lockfile::')).toMatchObject({
      status: 'incompatible',
      reason: 'lockfile_mismatch',
      blocking: true,
    });
    expect(item(r, 'lockfile::')?.evidence[0]?.detail).toContain('left-pad not locked');
    expect(item(r, 'dependencies::')).toMatchObject({
      status: 'missing',
      reason: 'dependencies_missing',
    });
    expect(r.plans[0]).toMatchObject({
      command: 'pnpm install',
      writesLockfile: true,
      reason: 'lockfile_mismatch',
    });
  });

  it('npm、yarn、bun 的锁文件与命令', async () => {
    const npm = project({
      'package.json': { dependencies: { zod: '^4.0.0' } },
      'package-lock.json': {
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { zod: '^4.0.0' } },
          'node_modules/zod': { version: '4.0.0' },
        },
      },
      '.npmrc': 'ignore-scripts=true\n',
    });
    const r1 = await report(npm, { node: 'v24.0.0', npm: '11.0.0' });
    expect(item(r1, 'lockfile::')?.status).toBe('ready');
    expect(r1.plans[0]).toMatchObject({ command: 'npm ci', scripts: { dependencies: 'disabled' } });

    const yarn = project({
      'package.json': { dependencies: { zod: '^4.0.0' } },
      'yarn.lock': '"zod@npm:^4.0.0":\n  version: 4.0.0\n',
      '.yarnrc.yml': 'nodeLinker: node-modules\n',
    });
    const r2 = await report(yarn, { node: 'v24.0.0', yarn: '4.5.0' });
    expect(item(r2, 'lockfile::')?.status).toBe('ready');
    expect(r2.plans[0]?.command).toBe('yarn install --immutable');

    const bun = project({
      'package.json': { dependencies: { zod: '^4.0.0' } },
      'bun.lock':
        '{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "dependencies": { "zod": "^4.0.0", },\n    },\n  },\n}\n',
    });
    const r3 = await report(bun, { node: 'v24.0.0', bun: '1.2.0' });
    expect(item(r3, 'lockfile::')?.status).toBe('ready');
    expect(r3.plans[0]).toMatchObject({
      command: 'bun install --frozen-lockfile',
      scripts: { dependencies: 'restricted' },
    });
  });

  it('工作区成员并进根项目：成员的依赖要在锁文件里，成员目录里缺的也算', async () => {
    const root = project({
      'package.json': { packageManager: 'pnpm@12.6.0', devDependencies: { typescript: '^7.0.0' } },
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      'pnpm-lock.yaml': [
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    devDependencies:',
        '      typescript:',
        '        specifier: ^7.0.0',
        '        version: 7.0.2',
        '  packages/core:',
        '    dependencies:',
        '      zod:',
        '        specifier: ^4.6.5',
        '        version: 4.6.5',
        '',
      ].join('\n'),
      'packages/core/package.json': { name: 'core', dependencies: { zod: '^4.6.5' } },
    });
    installed(root, 'typescript');
    const r = await report(root, { node: 'v24.0.0', pnpm: '12.6.0' });
    expect(r.projects).toEqual([{ path: '', ecosystems: ['node'] }]);
    expect(item(r, 'lockfile::')?.status).toBe('ready');
    expect(item(r, 'dependencies::')).toMatchObject({ status: 'missing' });
    expect(item(r, 'dependencies::')?.evidence[0]?.detail).toContain('packages/core: zod');
  });

  it('工具：没装、版本不对、corepack 的版本还没下载', async () => {
    const root = project({
      'package.json': {
        packageManager: 'pnpm@12.6.0',
        engines: { node: '>=24.15' },
        dependencies: { zod: '^4' },
      },
      'pnpm-lock.yaml': pnpmLock({ zod: '^4' }),
    });
    const missing = await report(root, { node: null, pnpm: null });
    expect(item(missing, 'runtime::node')).toMatchObject({
      status: 'missing',
      reason: 'not_found',
      blocking: true,
    });
    expect(item(missing, 'package_manager::pnpm')).toMatchObject({
      status: 'missing',
      reason: 'not_found',
    });

    const old = await report(root, { node: 'v22.11.0', pnpm: '10.0.0' });
    expect(item(old, 'runtime::node')).toMatchObject({
      status: 'incompatible',
      reason: 'version_mismatch',
      found: '22.11.0',
      blocking: true,
    });
    // 包管理器版本不对不阻塞（pnpm 会自己切换版本）。
    expect(item(old, 'package_manager::pnpm')).toMatchObject({
      status: 'incompatible',
      blocking: false,
    });
    expect(old.plans[0]?.scripts.dependencies).toBe('restricted');

    const corepack = await report(root, {
      node: 'v24.21.0',
      pnpm: {
        exitCode: 1,
        output:
          'Usage Error: Network access disabled by the environment; Corepack cannot reach registry.npmjs.org',
      },
    });
    expect(item(corepack, 'package_manager::pnpm')).toMatchObject({
      status: 'missing',
      reason: 'not_cached',
      blocking: false,
    });
  });

  it('pnpm 11 起锁文件里有两份文档：包管理器那份不算项目的依赖', () => {
    const text = [
      '---',
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    packageManagerDependencies:',
      '      pnpm:',
      '        specifier: 12.6.0',
      '        version: 12.6.0',
      '---',
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      "      '@scope/pkg':",
      '        specifier: ^1.0.0',
      '        version: 1.0.0',
      '',
    ].join('\n');
    expect([...(parsePnpmLock(text)?.get('.') ?? new Map())]).toEqual([['@scope/pkg', '^1.0.0']]);
  });

  it('yarn classic 的描述符', () => {
    const lock = parseYarnLock(
      '# yarn lockfile v1\n\n"@babel/core@^7.0.0", "@babel/core@^7.1.0":\n  version "7.2.0"\nlodash@^4.17.21:\n  version "4.17.21"\n',
    );
    expect([...(lock.get('*')?.keys() ?? [])]).toEqual([
      '@babel/core@^7.0.0',
      '@babel/core@^7.1.0',
      'lodash@^4.17.21',
    ]);
  });

  it('.gitignore 里写明的目录不扫（参考克隆之类）', async () => {
    const root = project({
      '.gitignore': 'upstream/\n',
      'upstream/other/package.json': { dependencies: { zod: '^4' } },
      'tools/package.json': { name: 'tools' },
    });
    const r = await report(root, { node: 'v24.0.0', npm: '11.0.0' });
    expect(r.projects.map((p) => p.path)).toEqual(['tools']);
  });
});

describe('Python、Go、Rust、C 与多语言项目', () => {
  it('uv：没有虚拟环境是缺依赖；pyproject 里的依赖不在 uv.lock 里是不一致', async () => {
    const root = project({
      'backend/pyproject.toml':
        '[project]\nname = "api"\nrequires-python = ">=3.11"\ndependencies = [\n  "httpx>=0.27",\n  "Pydantic>=2",\n]\n\n[tool.uv]\n',
      'backend/uv.lock':
        'version = 1\n\n[[package]]\nname = "api"\nversion = "0.1.0"\nsource = { editable = "." }\ndependencies = [\n    { name = "httpx" },\n]\n\n[package.metadata]\nrequires-dist = [{ name = "httpx", specifier = ">=0.27" }]\n',
      'frontend/package.json': { dependencies: { zod: '^4' } },
      'frontend/package-lock.json': {
        lockfileVersion: 3,
        packages: { '': { dependencies: { zod: '^4' } } },
      },
    });
    const r = await report(root, {
      python3: 'Python 3.12.4',
      uv: 'uv 0.5.0',
      node: 'v24.0.0',
      npm: '11.0.0',
    });
    expect(r.projects).toEqual([
      { path: 'backend', ecosystems: ['python'] },
      { path: 'frontend', ecosystems: ['node'] },
    ]);
    expect(item(r, 'runtime:backend:python')).toMatchObject({
      status: 'ready',
      required: '>=3.11',
      found: '3.12.4',
    });
    expect(item(r, 'lockfile::backend')).toMatchObject({
      status: 'incompatible',
      reason: 'lockfile_mismatch',
    });
    expect(item(r, 'lockfile::backend')?.evidence[0]?.detail).toContain('pydantic');
    expect(item(r, 'dependencies::backend')).toMatchObject({ status: 'missing', name: '.venv' });
    expect(r.plans.map((plan) => [plan.path, plan.command])).toEqual([
      ['backend', 'uv sync'],
      ['frontend', 'npm ci'],
    ]);
    expect(r.plans[0]?.scripts.dependencies).toBe('run');
  });

  it('pip 没有项目里的虚拟环境：不给方案（不往系统里装），记成未知', async () => {
    const root = project({ 'requirements.txt': 'requests==2.32.0\n' });
    const r = await report(root, { python3: 'Python 3.12.4' });
    expect(item(r, 'dependencies::')).toMatchObject({
      status: 'unknown',
      reason: 'no_virtualenv',
      blocking: false,
    });
    expect(r.plans).toEqual([]);
  });

  it('macOS 没装命令行工具时 /usr/bin 的空壳记成没安装', async () => {
    const root = project({
      'CMakeLists.txt': 'project(x C)\n',
      'main.c': 'int main(){return 0;}\n',
    });
    const { probe } = fakeProbe({ cmake: 'cmake version 3.31.6' });
    const r = await buildReport({
      workspaceId: WS,
      root,
      checks: [],
      env: {},
      platform: 'darwin',
      credentials: new Set(),
      probe: async (names) => {
        const map = new Map(await probe(names));
        map.set('cc', {
          name: 'cc',
          path: '/usr/bin/cc',
          command: 'cc --version',
          exitCode: null,
          output: '',
          problem: 'clt_missing',
        });
        return map;
      },
    });
    expect(item(r, 'compiler::cc')).toMatchObject({
      status: 'missing',
      reason: 'clt_missing',
      blocking: true,
    });
    expect(item(r, 'build_tool::cmake')).toMatchObject({ status: 'ready', found: '3.31.6' });
  });

  it('Go：go.sum 少了模块是不一致，模块缓存里没有是缺依赖；要求的 Go 更高是版本不兼容', async () => {
    const home = mkdtempSync(join(tmpdir(), 'wevir-readiness-home-'));
    dirs.push(home);
    const root = project({
      'go.mod':
        'module example.com/x\n\ngo 1.23\n\nrequire (\n\tgithub.com/BurntSushi/toml v1.4.0\n\tgolang.org/x/text v0.21.0 // indirect\n)\n',
      'go.sum':
        'github.com/BurntSushi/toml v1.4.0 h1:x=\ngithub.com/BurntSushi/toml v1.4.0/go.mod h1:y=\n',
    });
    const cache = join(
      home,
      'go',
      'pkg',
      'mod',
      'cache',
      'download',
      'github.com',
      '!burnt!sushi',
      'toml',
      '@v',
    );
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'v1.4.0.mod'), 'module github.com/BurntSushi/toml\n');
    const r = await report(root, { go: 'go version go1.22.3 darwin/arm64' }, { home });
    expect(item(r, 'runtime::go')).toMatchObject({
      status: 'incompatible',
      required: '1.23',
      found: '1.22.3',
      blocking: true,
    });
    expect(item(r, 'lockfile::')).toMatchObject({
      status: 'incompatible',
      reason: 'lockfile_mismatch',
    });
    expect(item(r, 'dependencies::')).toMatchObject({ status: 'missing' });
    expect(item(r, 'dependencies::')?.evidence[0]?.detail).toContain('golang.org/x/text@v0.21.0');
    expect(r.plans[0]).toMatchObject({
      command: 'go mod download',
      scripts: { dependencies: 'disabled' },
    });
  });

  it('Rust：Cargo.toml 的依赖不在 Cargo.lock 里', async () => {
    const root = project({
      'Cargo.toml':
        '[package]\nname = "x"\nversion = "0.1.0"\nrust-version = "1.80"\n\n[dependencies]\nserde = { version = "1", features = ["derive"] }\nanyhow = "1"\nlocal = { path = "../local" }\n',
      'Cargo.lock':
        'version = 4\n\n[[package]]\nname = "serde"\nversion = "1.0.200"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
    });
    const r = await report(root, { rustc: 'rustc 1.85.0 (x)', cargo: 'cargo 1.85.0 (x)' });
    expect(item(r, 'compiler::rustc')).toMatchObject({ status: 'ready', required: '1.80' });
    expect(item(r, 'lockfile::')).toMatchObject({ status: 'incompatible' });
    expect(item(r, 'lockfile::')?.evidence[0]?.detail).toBe('not locked: anyhow');
    expect(r.plans[0]?.command).toBe('cargo fetch');
  });

  it('没有认得的项目：状态未知', async () => {
    const root = project({ 'README.md': '# hi\n' });
    const r = await report(root, {});
    expect(r).toMatchObject({ status: 'unknown', items: [], plans: [] });
  });
});

const check = (patch: Partial<CheckDefinition>): CheckDefinition => ({
  id: 'chk_01JA2B3C4D5E6F7G8H9JKMNPQR',
  name: 'test',
  command: 'pnpm test',
  cwd: '',
  timeoutMs: 60_000,
  kind: 'test',
  trigger: 'after_turn',
  source: { kind: 'user' },
  revision: 1,
  approvedAt: '2026-10-20T00:00:00.000Z',
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-20T00:00:00.000Z',
  ...patch,
});

describe('检查命令', () => {
  it('脚本在不在、依赖里的命令在不在、文件能不能执行、命令找不到', async () => {
    const root = project({
      'package.json': { scripts: { test: 'vitest run' } },
      'scripts/run.sh': '#!/bin/sh\nexit 0\n',
      'scripts/plain.sh': 'exit 0\n',
    });
    chmodSync(join(root, 'scripts/run.sh'), 0o755);
    chmodSync(join(root, 'scripts/plain.sh'), 0o644);
    const checks = [
      check({ id: 'chk_01JA2B3C4D5E6F7G8H9JKMNP01', command: 'pnpm test' }),
      check({ id: 'chk_01JA2B3C4D5E6F7G8H9JKMNP02', command: 'npm run lint' }),
      check({ id: 'chk_01JA2B3C4D5E6F7G8H9JKMNP03', command: 'npx vitest run' }),
      check({ id: 'chk_01JA2B3C4D5E6F7G8H9JKMNP04', command: './scripts/run.sh' }),
      check({ id: 'chk_01JA2B3C4D5E6F7G8H9JKMNP05', command: 'CI=1 ./scripts/plain.sh' }),
      check({ id: 'chk_01JA2B3C4D5E6F7G8H9JKMNP06', command: 'cd sub && just test' }),
      check({ id: 'chk_01JA2B3C4D5E6F7G8H9JKMNP07', command: 'pytest -q' }),
    ];
    mkdirSync(join(root, 'sub'));
    const r = await report(
      root,
      { node: 'v24.0.0', npm: '11.0.0', pnpm: '12.6.0', just: null, pytest: '' },
      { checks },
    );
    const status = (id: string) => {
      const found = item(r, `check::${id}`);
      return [found?.status, found?.reason, found?.path];
    };
    expect(status('chk_01JA2B3C4D5E6F7G8H9JKMNP01')).toEqual(['ready', undefined, '']);
    expect(status('chk_01JA2B3C4D5E6F7G8H9JKMNP02')).toEqual(['missing', 'script_missing', '']);
    expect(status('chk_01JA2B3C4D5E6F7G8H9JKMNP03')).toEqual(['missing', 'bin_missing', '']);
    expect(status('chk_01JA2B3C4D5E6F7G8H9JKMNP04')).toEqual(['ready', undefined, '']);
    expect(status('chk_01JA2B3C4D5E6F7G8H9JKMNP05')).toEqual(['permission', 'not_executable', '']);
    expect(status('chk_01JA2B3C4D5E6F7G8H9JKMNP06')).toEqual([
      'missing',
      'command_not_found',
      'sub',
    ]);
    expect(status('chk_01JA2B3C4D5E6F7G8H9JKMNP07')).toEqual(['ready', undefined, '']);
  });

  it('只把与检查相关的阻塞项算进回合后验证', async () => {
    const root = project({
      'web/package.json': { dependencies: { zod: '^4' } },
      'web/pnpm-lock.yaml': pnpmLock({ zod: '^4' }),
      'api/go.mod': 'module x\n\ngo 1.22\n',
    });
    const r = await report(root, { node: 'v24.0.0', pnpm: '12.6.0', go: null });
    const web = check({ command: 'pnpm test', cwd: 'web' });
    expect(relevantBlocking(r, web).map((entry) => entry.id)).toEqual(['dependencies::web']);
    const api = check({ command: 'go test ./...', cwd: 'api' });
    expect(relevantBlocking(r, api).map((entry) => entry.id)).toEqual(['runtime:api:go']);
    // 在根目录跑、认不出语言的命令：只看根目录与上层的，子项目的不算。
    expect(relevantBlocking(r, check({ command: './test.sh', cwd: '' }))).toEqual([]);
  });
});

describe('网络诊断', () => {
  it('私有仓库：认证引用的变量不在时记 missing；不带凭据值，URL 去掉用户名口令', async () => {
    const root = project({
      'package.json': { dependencies: { '@corp/ui': '^1.0.0' } },
      'package-lock.json': {
        lockfileVersion: 3,
        packages: { '': { dependencies: { '@corp/ui': '^1.0.0' } } },
      },
      '.npmrc':
        // biome-ignore lint/suspicious/noTemplateCurlyInString: .npmrc 里的变量引用。
        '@corp:registry=https://npm.corp.example/repo/\n//npm.corp.example/repo/:_authToken=${CORP_TOKEN}\nhttps-proxy=http://user:pw@proxy:8080\n',
    });
    const without = await report(
      root,
      { node: 'v24.0.0', npm: '11.0.0' },
      { env: { HTTPS_PROXY: 'http://u:p@proxy:3128' } },
    );
    expect(without.network.registries).toContainEqual({
      ecosystem: 'node',
      url: 'https://npm.corp.example/repo/',
      source: '.npmrc',
      auth: 'missing',
    });
    expect(without.network.proxy).toEqual(['HTTPS_PROXY', 'npmrc:https-proxy']);
    expect(without.network.advice).toEqual(
      expect.arrayContaining(['install_by_user', 'registry_auth_missing', 'domains_not_enforced']),
    );
    expect(without.plans[0]?.credentials).toEqual([{ name: 'CORP_TOKEN', source: 'missing' }]);
    expect(JSON.stringify(without)).not.toContain('pw@');

    const stored = await report(
      root,
      { node: 'v24.0.0', npm: '11.0.0' },
      { credentials: new Set(['CORP_TOKEN']) },
    );
    expect(stored.network.registries.find((entry) => entry.source === '.npmrc')?.auth).toBe(
      'configured',
    );
    expect(stored.plans[0]?.credentials).toEqual([{ name: 'CORP_TOKEN', source: 'wevir' }]);
  });

  it('Agent 的网络：Codex 在沙箱里不能联网，域名从不算限定', async () => {
    const root = project({ 'package.json': { name: 'x' } });
    const r = await report(
      root,
      { node: 'v24.0.0', npm: '11.0.0' },
      {
        agent: {
          engine: 'codex',
          permissionMode: 'on_request',
          network: 'sandboxed',
          domains: 'not_enforced',
        },
      },
    );
    expect(r.network.agent).toEqual({
      engine: 'codex',
      permissionMode: 'on_request',
      network: 'sandboxed',
      domains: 'not_enforced',
    });
    expect(r.network.advice).toContain('domains_not_enforced');
  });
});
