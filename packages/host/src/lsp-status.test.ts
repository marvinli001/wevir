// 语言服务器的状态与安装（0.70.0，lsp/service.ts、lsp/scan.ts、lsp/probe.ts）：没装任何服务器、只有项目内的 TypeScript、全局的
// 版本过旧、起来后崩溃、安装失败、安装成功后诊断出来、monorepo 多个根、rustup 代理跑不起来；用户级方案要明确确认。装的东西都在
// 临时目录里（假的安装命令、假的语言服务器），不碰全局。

import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LspInstallRun, LspServerStatus } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { isHostError } from './errors.js';
import { LspManager } from './lsp/manager.js';
import { clearProbeCache, parseVersion } from './lsp/probe.js';
import { scanLanguages } from './lsp/scan.js';
import { BUILTIN_SERVERS, compareVersions, RUST, type ServerSpec } from './lsp/servers.js';
import { type LspChange, LspStatusService } from './lsp/service.js';
import { useTempDir } from './test-utils.js';

const FAKE_SERVER = join(dirname(fileURLToPath(import.meta.url)), 'test-fixtures', 'fake-lsp.mjs');
const posix = process.platform !== 'win32';

const tempDir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  clearProbeCache();
});

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function service(servers: readonly ServerSpec[], env: NodeJS.ProcessEnv) {
  const changes: LspChange[] = [];
  const lsp = new LspManager({
    servers,
    env,
    watch: false,
    onChange: (serverId, root) => status.changed({ serverId, root }),
  });
  const status = new LspStatusService({ lsp, installTimeoutMs: 20_000 });
  status.watch((change) => changes.push(change));
  cleanups.push(async () => {
    status.close();
    await lsp.close();
  });
  return { lsp, status, changes };
}

/** 一个装不装取决于标记文件的假服务器；安装方案运行 node 写下标记文件（或失败）。 */
function installableSpec(marker: string, options: { fail?: boolean } = {}): ServerSpec {
  const script = options.fail
    ? "process.stderr.write('npm error 404 Not Found - GET https://registry.example/fake-lsp\\n'); process.exit(1)"
    : `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok'); console.log('added 1 package')`;
  return {
    id: 'fake',
    language: 'Fake',
    extensions: ['.fake'],
    root: async (_file, stop) => stop,
    resolve: async () =>
      existsSync(marker)
        ? { command: process.execPath, args: [FAKE_SERVER], label: 'fake-lsp', version: '1.0.0' }
        : { missing: 'fake-lsp not found.' },
    plans: async (root) => [
      {
        id: 'project-add',
        scope: 'project',
        argv: [process.execPath, '-e', script],
        cwd: root,
        runnable: true,
      },
      { id: 'user-add', scope: 'user', argv: [process.execPath, '-e', script], runnable: true },
      { id: 'manual', scope: 'system', argv: ['sudo', 'true'], runnable: false },
    ],
  };
}

async function waitFor(
  check: () => Promise<LspInstallRun | undefined>,
  done: (run: LspInstallRun) => boolean,
): Promise<LspInstallRun> {
  for (let i = 0; i < 300; i += 1) {
    const run = await check();
    if (run !== undefined && done(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('install did not finish');
}

const one = (servers: LspServerStatus[], serverId: string) => {
  const found = servers.find((server) => server.serverId === serverId);
  if (found === undefined) throw new Error(`no ${serverId}`);
  return found;
};

describe('lsp.status', () => {
  it('没装任何服务器：每种语言 missing，带原因与项目级在前的方案', async () => {
    const dir = tempDir();
    const empty = join(dir, '.empty');
    mkdirSync(empty);
    write(join(dir, 'package.json'), '{"name":"app","devDependencies":{}}');
    write(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    write(join(dir, 'src', 'index.ts'), 'export const a = 1;\n');
    write(join(dir, 'tool', 'main.go'), 'package main\n');
    write(join(dir, 'tool', 'go.mod'), 'module tool\n');
    const { status } = service(BUILTIN_SERVERS, { PATH: empty, HOME: join(dir, 'home') });
    const result = await status.status(dir);
    expect(result.servers.map((server) => [server.serverId, server.root, server.state])).toEqual([
      ['typescript', dir, 'missing'],
      ['go', join(dir, 'tool'), 'missing'],
    ]);
    const ts = one(result.servers, 'typescript');
    expect(ts.reason).toContain('No TypeScript found');
    expect(ts.plans?.map((plan) => [plan.id, plan.scope, plan.command, plan.cwd])).toEqual([
      ['project-add-typescript', 'project', 'pnpm add -D typescript', dir],
      ['user-typescript', 'user', 'npm install -g typescript@latest', undefined],
    ]);
    expect(one(result.servers, 'go').plans?.[0]).toMatchObject({
      scope: 'user',
      command: 'go install golang.org/x/tools/gopls@latest',
    });
  });

  it('只有项目内的 TypeScript 7：not_started、项目内、版本，用过后有能力与诊断时间', async () => {
    const dir = tempDir();
    write(join(dir, 'package-lock.json'), '{}');
    write(join(dir, 'a.ts'), 'export {};\n');
    write(
      join(dir, 'node_modules', 'typescript', 'package.json'),
      '{"name":"typescript","version":"7.0.2"}',
    );
    const native = join(
      dir,
      'node_modules',
      '@typescript',
      `typescript-${process.platform}-${process.arch}`,
    );
    write(join(native, 'package.json'), '{}');
    write(join(native, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc'), '');
    const { status } = service(BUILTIN_SERVERS, {
      PATH: join(dir, '.none'),
      HOME: join(dir, 'home'),
    });
    const ts = one((await status.status(dir)).servers, 'typescript');
    expect(ts).toMatchObject({
      state: 'not_started',
      source: 'project',
      version: '7.0.2',
      name: 'tsc --lsp (TypeScript 7.0.2)',
    });
    expect(ts.plans).toBeUndefined();
    expect(ts.capabilities).toBeUndefined();
  });

  it.runIf(posix)(
    '全局的 typescript-language-server 过旧：outdated、用户级、最低版本与升级方案；工具也不用它',
    async () => {
      const dir = tempDir();
      const home = join(dir, 'home');
      write(
        join(dir, 'project', 'package.json'),
        '{"name":"app","devDependencies":{"typescript":"5.9.3"}}',
      );
      write(join(dir, 'project', 'package-lock.json'), '{}');
      write(join(dir, 'project', 'a.ts'), 'export {};\n');
      const ts = join(dir, 'project', 'node_modules', 'typescript');
      write(join(ts, 'package.json'), '{"name":"typescript","version":"5.9.3"}');
      write(join(ts, 'lib', 'tsserver.js'), '');
      // `npm install -g` 的样子：包在 lib/node_modules，bin 里是链接。
      const pkg = join(home, '.npm-global', 'lib', 'node_modules', 'typescript-language-server');
      write(join(pkg, 'package.json'), '{"name":"typescript-language-server","version":"1.2.0"}');
      write(join(pkg, 'lib', 'cli.mjs'), '#!/bin/sh\n');
      chmodSync(join(pkg, 'lib', 'cli.mjs'), 0o755);
      const bin = join(home, '.npm-global', 'bin');
      mkdirSync(bin, { recursive: true });
      symlinkSync(join(pkg, 'lib', 'cli.mjs'), join(bin, 'typescript-language-server'));
      const project = join(dir, 'project');
      const { status, lsp } = service(BUILTIN_SERVERS, { PATH: bin, HOME: home });
      const server = one((await status.status(project)).servers, 'typescript');
      expect(server).toMatchObject({
        state: 'outdated',
        source: 'user',
        version: '1.2.0',
        minVersion: '2.1.0',
        path: join(bin, 'typescript-language-server'),
      });
      expect(server.reason).toContain('older than 2.1.0');
      expect(server.plans?.map((plan) => [plan.id, plan.command])).toEqual([
        ['project-add-server', 'npm install -D typescript-language-server'],
        ['user-server', 'npm install -g typescript-language-server@latest'],
      ]);
      await expect(lsp.client(join(project, 'a.ts'), project)).rejects.toMatchObject({
        state: 'outdated',
      });
    },
  );

  it.runIf(posix)('rustup 的代理没有 rust-analyzer 组件：missing，原因是它跑不起来', async () => {
    const base = tempDir();
    const dir = join(base, 'project');
    write(join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
    write(join(dir, 'src', 'main.rs'), 'fn main() {}\n');
    const bin = join(base, 'home', '.cargo', 'bin');
    write(
      join(bin, 'rust-analyzer'),
      "#!/bin/sh\necho \"error: Unknown binary 'rust-analyzer' in official toolchain 'stable'.\" >&2\nexit 1\n",
    );
    chmodSync(join(bin, 'rust-analyzer'), 0o755);
    const { status } = service([RUST], { PATH: bin, HOME: join(base, 'home') });
    const server = one((await status.status(dir)).servers, 'rust');
    expect(server.state).toBe('missing');
    expect(server.source).toBe('user');
    expect(server.reason).toContain("Unknown binary 'rust-analyzer'");
    expect(server.plans?.[0]).toMatchObject({
      command: 'rustup component add rust-analyzer',
      cwd: dir,
    });
  });

  it('monorepo：每个 go.mod、pyproject.toml 一个根，TypeScript 按锁文件一个根；跳过依赖与隐藏目录', async () => {
    const dir = tempDir();
    write(join(dir, 'pnpm-lock.yaml'), '');
    write(join(dir, 'packages', 'web', 'src', 'a.tsx'), '');
    write(join(dir, 'packages', 'api', 'b.ts'), '');
    write(join(dir, 'services', 'one', 'go.mod'), 'module one\n');
    write(join(dir, 'services', 'one', 'main.go'), '');
    write(join(dir, 'services', 'two', 'go.mod'), 'module two\n');
    write(join(dir, 'services', 'two', 'cmd', 'x.go'), '');
    write(join(dir, 'ml', 'pyproject.toml'), '');
    write(join(dir, 'ml', 'train.py'), '');
    write(join(dir, 'node_modules', 'dep', 'index.js'), '');
    write(join(dir, '.git', 'hooks', 'x.py'), '');
    const scan = await scanLanguages(dir, BUILTIN_SERVERS);
    expect(scan.servers.map((found) => [found.spec.id, found.root, found.files])).toEqual([
      ['typescript', dir, 2],
      ['python', join(dir, 'ml'), 1],
      ['go', join(dir, 'services', 'one'), 1],
      ['go', join(dir, 'services', 'two'), 1],
    ]);
    expect(scan.truncated).toBe(false);
  });
});

describe('lsp.restart / lsp.log', () => {
  it('起来后崩溃：failed、崩溃原因与次数，日志里有启动命令与 stderr；重启后能用', async () => {
    const dir = tempDir();
    write(join(dir, 'a.fake'), 'def alpha\n');
    const marker = join(dir, '.installed');
    writeFileSync(marker, '');
    const spec = installableSpec(marker);
    const env: NodeJS.ProcessEnv = { ...process.env, FAKE_LSP_CRASH_AFTER_MS: '100' };
    const { status, lsp, changes } = service([spec], env);
    await lsp.client(join(dir, 'a.fake'), dir);
    expect(one((await status.status(dir)).servers, 'fake')).toMatchObject({
      state: 'running',
      capabilities: [
        'definition',
        'references',
        'hover',
        'documentSymbol',
        'workspaceSymbol',
        'callHierarchy',
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const crashed = one((await status.status(dir)).servers, 'fake');
    expect(crashed.state).toBe('failed');
    expect(crashed.failures).toBe(1);
    expect(crashed.reason).toContain('fake-lsp exited (code 139)');
    expect(crashed.reason).toContain('segmentation fault after start');
    expect(changes).toContainEqual({ serverId: 'fake', root: dir });
    const log = await status.log(dir, 'fake', dir);
    expect(log).toMatch(/start: .*fake-lsp\.mjs \(system, 1\.0\.0\) in /);
    expect(log).toContain('initialized: definition, references');
    expect(log).toContain('exited (code 139)');
    expect(log).toContain('  | fake-lsp: segmentation fault after start');

    // 去掉崩溃后重启：正常运行，崩溃计数清零。
    delete env.FAKE_LSP_CRASH_AFTER_MS;
    const restarted = await status.restart(dir, 'fake', dir);
    expect(restarted.state).toBe('running');
    expect(restarted.failures).toBeUndefined();
  });

  it('不在扫描结果里的根不接受', async () => {
    const dir = tempDir();
    write(join(dir, 'a.fake'), '');
    const { status } = service([installableSpec(join(dir, '.m'))], process.env);
    await expect(status.restart(dir, 'fake', '/etc')).rejects.toSatisfy((error) =>
      isHostError(error, 'INVALID_PARAMS'),
    );
  });
});

describe('lsp.install', () => {
  it('安装成功：运行方案、重新查找、起服务器、诊断出错误', async () => {
    const dir = tempDir();
    write(join(dir, 'src', 'a.fake'), 'def alpha\nERROR here\n');
    const marker = join(dir, '.installed');
    const { status, changes } = service([installableSpec(marker)], process.env);
    expect(one((await status.status(dir)).servers, 'fake').state).toBe('missing');
    const started = await status.install(dir, 'fake', dir, 'project-add', false);
    expect(started).toMatchObject({ status: 'running', scope: 'project', planId: 'project-add' });
    expect(started.command).toContain('-e');
    const run = await waitFor(
      async () => one((await status.status(dir)).servers, 'fake').install,
      (item) => item.status !== 'running' && item.status !== 'verifying',
    );
    expect(run.status).toBe('succeeded');
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain('added 1 package');
    expect(run.verification).toEqual({
      server: 'fake-lsp',
      file: join('src', 'a.fake'),
      diagnostics: 1,
    });
    const server = one((await status.status(dir)).servers, 'fake');
    expect(server.state).toBe('running');
    expect(server.lastDiagnosticsAt).toBeDefined();
    expect(changes.length).toBeGreaterThan(2);
    expect(await status.log(dir, 'fake', dir)).toContain('checked src/a.fake: 1 diagnostics');
  });

  it('安装失败：failed，原因是输出的最后几行；服务器仍是 missing', async () => {
    const dir = tempDir();
    write(join(dir, 'a.fake'), '');
    const { status } = service([installableSpec(join(dir, '.m'), { fail: true })], process.env);
    await status.install(dir, 'fake', dir, 'project-add', false);
    const run = await waitFor(
      async () => one((await status.status(dir)).servers, 'fake').install,
      (item) => item.status !== 'running',
    );
    expect(run.status).toBe('failed');
    expect(run.exitCode).toBe(1);
    expect(run.reason).toContain('Exited with code 1.');
    expect(run.reason).toContain('npm error 404 Not Found');
    expect(one((await status.status(dir)).servers, 'fake').state).toBe('missing');
  });

  it('用户级方案要 confirmGlobal；手动方案与不存在的方案不接受；同一个服务器不能同时装两次', async () => {
    const dir = tempDir();
    write(join(dir, 'a.fake'), '');
    const { status } = service([installableSpec(join(dir, '.m'))], process.env);
    const invalid = (error: unknown) => isHostError(error, 'INVALID_PARAMS');
    await expect(status.install(dir, 'fake', dir, 'user-add', false)).rejects.toSatisfy(invalid);
    await expect(status.install(dir, 'fake', dir, 'manual', true)).rejects.toSatisfy(invalid);
    await expect(status.install(dir, 'fake', dir, 'nope', true)).rejects.toSatisfy(invalid);
    const run = await status.install(dir, 'fake', dir, 'user-add', true);
    expect(run.scope).toBe('user');
    await expect(status.install(dir, 'fake', dir, 'project-add', false)).rejects.toSatisfy(
      (error) => isHostError(error, 'RESOURCE_IN_USE'),
    );
    await waitFor(
      async () => one((await status.status(dir)).servers, 'fake').install,
      (item) => item.status === 'succeeded',
    );
  });

  it('取消：cancelled', async () => {
    const dir = tempDir();
    write(join(dir, 'a.fake'), '');
    const spec: ServerSpec = {
      ...installableSpec(join(dir, '.m')),
      plans: async (root) => [
        {
          id: 'slow',
          scope: 'project',
          argv: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'],
          cwd: root,
          runnable: true,
        },
      ],
    };
    const { status } = service([spec], process.env);
    const run = await status.install(dir, 'fake', dir, 'slow', false);
    status.cancel(run.id);
    const done = await waitFor(
      async () => one((await status.status(dir)).servers, 'fake').install,
      (item) => item.status !== 'running',
    );
    expect(done.status).toBe('cancelled');
  });
});

describe('versions', () => {
  it('parses and compares versions', () => {
    expect(parseVersion('golang.org/x/tools/gopls v0.16.2')).toBe('0.16.2');
    expect(parseVersion('Apple clangd version 21.0.0 (clang-2100.1.1.101)')).toBe('21.0.0');
    expect(parseVersion('rust-analyzer 1.91.0 (f8297e3 2025-10-28)')).toBe('1.91.0');
    expect(compareVersions('1.2.0', '2.1.0')).toBeLessThan(0);
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
    expect(compareVersions('4.3.4', '4.3.4')).toBe(0);
  });
});
