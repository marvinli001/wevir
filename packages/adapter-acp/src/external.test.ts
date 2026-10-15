import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkExternalVersion,
  compareVersions,
  type ExternalExecutableSpec,
  resolveExternalExecutable,
} from './external.js';

const root = mkdtempSync(join(tmpdir(), 'wevir-external-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const spec: ExternalExecutableSpec = {
  displayName: 'Demo',
  command: 'demo',
  envVar: 'WEVIR_DEMO_BIN',
  installHint: '照官方文档安装。',
};

function executable(dir: string, name = 'demo', body = '#!/bin/sh\necho "demo 1.2.3"\n'): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

describe.skipIf(process.platform === 'win32')('resolveExternalExecutable', () => {
  const onPath = executable(join(root, 'path-a'));
  const component = executable(join(root, 'component', 'bin'));
  const configured = executable(join(root, 'configured'));
  const fromEnv = executable(join(root, 'env'));
  const env = { PATH: [join(root, 'empty'), join(root, 'path-a')].join(delimiter) };

  it('环境变量 → 设置里的路径 → 组件目录 → PATH', () => {
    const all = { configuredPath: configured, componentDir: join(root, 'component') };
    expect(
      resolveExternalExecutable(spec, { ...all, env: { ...env, WEVIR_DEMO_BIN: fromEnv } }),
    ).toEqual({
      path: fromEnv,
      source: 'env',
    });
    expect(resolveExternalExecutable(spec, { ...all, env })).toEqual({
      path: configured,
      source: 'configured',
    });
    expect(resolveExternalExecutable(spec, { componentDir: join(root, 'component'), env })).toEqual(
      { path: component, source: 'component' },
    );
    expect(resolveExternalExecutable(spec, { env })).toEqual({ path: onPath, source: 'path' });
  });

  it('PATH 里没有时找常见的安装目录；设置里的路径可以用 ~/ 开头', () => {
    const extra = executable(join(root, 'home', '.local', 'bin'));
    const options = { env: { PATH: join(root, 'empty') }, home: join(root, 'home') };
    expect(
      resolveExternalExecutable(spec, {
        ...options,
        extraDirs: [join(root, 'missing'), join(root, 'home', '.local', 'bin')],
      }),
    ).toEqual({ path: extra, source: 'path' });
    expect(
      resolveExternalExecutable(spec, { ...options, configuredPath: '~/.local/bin/demo' }),
    ).toEqual({ path: extra, source: 'configured' });
    expect(() => resolveExternalExecutable(spec, { ...options, extraDirs: [] })).toThrow(
      /PATH里也没有/,
    );
  });

  it('指定的路径不对时报错，不悄悄换别处的；PATH 里不能执行的文件跳过', () => {
    expect(() => resolveExternalExecutable(spec, { configuredPath: 'demo', env })).toThrow(
      /绝对路径/,
    );
    expect(() =>
      resolveExternalExecutable(spec, { configuredPath: join(root, 'nope'), env }),
    ).toThrow(/不存在或不能执行/);
    const plain = join(root, 'plain');
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, 'demo'), 'not executable');
    expect(() => resolveExternalExecutable(spec, { env: { PATH: plain } })).toThrow(
      /找不到 Demo（demo）.*照官方文档安装/,
    );
  });

  it('版本：取出版本号，低于最低版本报错，与核实的版本比较', async () => {
    const policy = { minimum: '1.0.0', tested: '1.2.3' };
    const parse = (out: string) => /demo (\S+)/.exec(out)?.[1];
    await expect(
      checkExternalVersion({ displayName: 'Demo', path: onPath, env, parse, policy }),
    ).resolves.toEqual({ version: '1.2.3', tested: true });
    await expect(
      checkExternalVersion({
        displayName: 'Demo',
        path: onPath,
        env,
        parse,
        policy: { minimum: '1.0.0', tested: '1.3.0' },
      }),
    ).resolves.toEqual({ version: '1.2.3', tested: false });
    await expect(
      checkExternalVersion({
        displayName: 'Demo',
        path: onPath,
        env,
        parse,
        policy: { minimum: '2.0.0', tested: '2.0.0' },
      }),
    ).rejects.toThrow(/至少 2\.0\.0/);
    const garbled = executable(join(root, 'garbled'), 'demo', '#!/bin/sh\necho hello\n');
    await expect(
      checkExternalVersion({ displayName: 'Demo', path: garbled, env, parse, policy }),
    ).rejects.toThrow(/看不懂/);
  });
});

describe('compareVersions', () => {
  it('按数字比较主、次、修订号，忽略后缀', () => {
    expect(compareVersions('1.0.52', '1.0.9')).toBe(1);
    expect(compareVersions('0.64.0', '0.64.0-nightly.1')).toBe(0);
    expect(compareVersions('0.9', '0.10.0')).toBe(-1);
  });
});
