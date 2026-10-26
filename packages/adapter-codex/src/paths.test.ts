import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CodexAdapter } from './codex-adapter.js';
import {
  CODEX_VERSION,
  checkCodexVersion,
  codexBinaryName,
  codexPackageBinary,
  codexPathDir,
  codexPaths,
  parseCodexVersion,
  prepareCodexHome,
  RESOURCES_DIR_ENV,
  resolveCodexBinary,
  resourcesCodexDir,
} from './paths.js';

const dir = mkdtempSync(join(tmpdir(), 'wevir-codex-paths-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('resolveCodexBinary', () => {
  it('WEVIR_CODEX_BIN 优先，必须是存在的绝对路径', () => {
    const file = join(dir, 'my-codex');
    writeFileSync(file, '');
    expect(resolveCodexBinary({ env: { WEVIR_CODEX_BIN: file }, devDir: '/nowhere' })).toBe(file);
    expect(() => resolveCodexBinary({ env: { WEVIR_CODEX_BIN: 'relative/codex' } })).toThrow(
      '绝对路径',
    );
    expect(() => resolveCodexBinary({ env: { WEVIR_CODEX_BIN: join(dir, 'missing') } })).toThrow(
      '不存在',
    );
  });

  it('其次是开发缓存；找不到时给出下载命令', () => {
    // 二进制在运行时包的 bin/ 下（上游的包布局），平铺在包根目录的旧布局不算。
    writeFileSync(join(dir, codexBinaryName('linux')), '');
    expect(() => resolveCodexBinary({ env: {}, devDir: dir, platform: 'linux' })).toThrow(
      'bash scripts/fetch-codex.sh',
    );
    mkdirSync(join(dir, 'bin'), { recursive: true });
    writeFileSync(join(dir, 'bin', codexBinaryName('linux')), '');
    expect(resolveCodexBinary({ env: {}, devDir: dir, platform: 'linux' })).toBe(
      join(dir, 'bin', 'codex-app-server'),
    );
    expect(codexBinaryName('win32')).toBe('codex-app-server.exe');
    expect(codexPackageBinary('/pkg', 'win32')).toBe(join('/pkg', 'bin', 'codex-app-server.exe'));
    expect(() =>
      resolveCodexBinary({ env: {}, devDir: join(dir, 'empty'), platform: 'linux' }),
    ).toThrow('bash scripts/fetch-codex.sh');
  });

  it('应用资源目录（安装包随附的）排在开发缓存之前，WEVIR_CODEX_BIN 之后', () => {
    const resources = join(dir, 'resources');
    const bundled = join(resourcesCodexDir(resources), 'bin', 'codex-app-server');
    mkdirSync(join(resourcesCodexDir(resources), 'bin'), { recursive: true });
    writeFileSync(bundled, '');
    const env = { [RESOURCES_DIR_ENV]: resources };
    expect(resolveCodexBinary({ env, devDir: dir, platform: 'linux' })).toBe(bundled);
    const override = join(dir, 'override-codex');
    writeFileSync(override, '');
    expect(
      resolveCodexBinary({
        env: { ...env, WEVIR_CODEX_BIN: override },
        devDir: dir,
        platform: 'linux',
      }),
    ).toBe(override);
    // 资源目录里没有（开发时设了这个变量但没准备资源）：退回开发缓存。
    expect(
      resolveCodexBinary({
        env: { [RESOURCES_DIR_ENV]: join(dir, 'no-resources') },
        devDir: dir,
        platform: 'linux',
      }),
    ).toBe(join(dir, 'bin', 'codex-app-server'));
    expect(() =>
      resolveCodexBinary({
        env: { [RESOURCES_DIR_ENV]: 'relative' },
        devDir: dir,
        platform: 'linux',
      }),
    ).toThrow('绝对路径');
  });
});

describe('codexPathDir', () => {
  it('只有二进制在包布局里（bin/ 下、上一级有 codex-package.json、有 codex-path/）才有', () => {
    const pkg = join(dir, 'pkg');
    const binary = join(pkg, 'bin', 'codex-app-server');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(binary, '');
    // 平铺或缺元数据：Codex 认不出包，也就没有这个目录。
    expect(codexPathDir(binary)).toBeUndefined();
    writeFileSync(join(pkg, 'codex-package.json'), '{}');
    expect(codexPathDir(binary)).toBeUndefined();
    mkdirSync(join(pkg, 'codex-path'));
    expect(codexPathDir(binary)).toBe(join(pkg, 'codex-path'));
    expect(codexPathDir(join(pkg, 'codex-app-server'))).toBeUndefined();
  });
});

describe('版本', () => {
  it('解析 --version 的输出', () => {
    expect(parseCodexVersion('codex-app-server 0.162.1\n')).toBe('rust-v0.162.1');
    expect(parseCodexVersion('codex-app-server 0.163.0-alpha.2')).toBe('rust-v0.163.0-alpha.2');
    expect(parseCodexVersion('something else')).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('版本不一致时报错，一致时通过', async () => {
    const fake = (version: string) => {
      const file = join(dir, `fake-${version}`);
      writeFileSync(file, `#!/bin/sh\necho "codex-app-server ${version}"\n`);
      chmodSync(file, 0o755);
      return file;
    };
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
    await expect(checkCodexVersion(fake(CODEX_VERSION.replace('rust-v', '')), env)).resolves.toBe(
      CODEX_VERSION,
    );
    await expect(checkCodexVersion(fake('0.1.0'), env)).rejects.toThrow(
      `codex-app-server 的版本是 rust-v0.1.0，适配器锁定的是 ${CODEX_VERSION}`,
    );
  });
});

describe('codexPaths', () => {
  it('CODEX_HOME 在数据目录的 engines/codex，事先建好且是 0700', () => {
    expect(() => codexPaths('relative')).toThrow('绝对路径');
    const paths = codexPaths(join(dir, 'data'));
    expect(paths.codexHome).toBe(join(dir, 'data', 'engines', 'codex'));
    expect(paths.configFile).toBe(join(paths.codexHome, 'config.toml'));
    prepareCodexHome(paths);
    if (process.platform !== 'win32') expect(statSync(paths.codexHome).mode & 0o777).toBe(0o700);
  });

  it('添加的 ChatGPT 账号（0.63.0）用它自己的 CODEX_HOME', () => {
    const own = join(dir, 'data', 'accounts', 'chatgpt-0b1c', 'codex');
    expect(codexPaths(join(dir, 'data'), 'chatgpt', own).codexHome).toBe(own);
    expect(() => codexPaths(join(dir, 'data'), 'chatgpt', 'relative')).toThrow('绝对路径');
  });
});

describe('CodexAdapter 的 ChatGPT 账号（0.63.0）', () => {
  it('添加的账号的进程只认它自己的 Provider ID，凭据在它自己的 CODEX_HOME', async () => {
    const own = join(dir, 'data', 'accounts', 'chatgpt-0b1c', 'codex');
    const adapter = new CodexAdapter({
      home: join(dir, 'data'),
      mode: 'chatgpt',
      account: { codexHome: own, providerId: 'chatgpt-0b1c' },
    });
    const provider = (id: string) => ({
      id,
      kind: 'chatgpt' as const,
      displayName: 'ChatGPT',
      models: [],
      defaultModelId: 'gpt-6.1-sol',
    });
    expect(adapter.validateProvider(provider('chatgpt-0b1c'))).toEqual([]);
    expect(adapter.validateProvider(provider('chatgpt'))).toHaveLength(1);
    expect(adapter.accounts?.kinds).toEqual(['chatgpt']);
    await adapter.dispose();
  });
});
