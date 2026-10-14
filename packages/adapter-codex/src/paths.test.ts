import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CODEX_VERSION,
  checkCodexVersion,
  codexBinaryName,
  codexPaths,
  parseCodexVersion,
  prepareCodexHome,
  resolveCodexBinary,
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
    writeFileSync(join(dir, codexBinaryName('linux')), '');
    expect(resolveCodexBinary({ env: {}, devDir: dir, platform: 'linux' })).toBe(
      join(dir, 'codex-app-server'),
    );
    expect(codexBinaryName('win32')).toBe('codex-app-server.exe');
    expect(() =>
      resolveCodexBinary({ env: {}, devDir: join(dir, 'empty'), platform: 'linux' }),
    ).toThrow('bash scripts/fetch-codex.sh');
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
});
