import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  archiveName,
  nodeDist,
  packageRootOf,
  platformDir,
  shasumOf,
  ThirdPartyLicenses,
  UNIX_LAUNCHER,
  WINDOWS_LAUNCHER,
} from './package.ts';

const temps: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wevir-cli-package-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('names', () => {
  it('names packages after the platform directories of the desktop feed', () => {
    expect(platformDir('x86_64-unknown-linux-musl')).toBe('linux-x64');
    expect(archiveName('0.2.1-beta.4', 'aarch64-unknown-linux-musl')).toBe(
      'wevir-cli-0.2.1-beta.4-linux-arm64.tar.gz',
    );
    expect(archiveName('0.2.0', 'aarch64-apple-darwin')).toBe(
      'wevir-cli-0.2.0-darwin-arm64.tar.gz',
    );
    expect(archiveName('0.2.0', 'x86_64-pc-windows-msvc')).toBe('wevir-cli-0.2.0-win32-x64.zip');
  });

  it('picks the official Node archive for the target', () => {
    expect(nodeDist('24.22.1', 'x86_64-unknown-linux-musl')).toEqual({
      file: 'node-v24.22.1-linux-x64.tar.gz',
      root: 'node-v24.22.1-linux-x64',
    });
    expect(nodeDist('24.22.1', 'x86_64-apple-darwin').file).toBe('node-v24.22.1-darwin-x64.tar.gz');
    expect(nodeDist('24.22.1', 'x86_64-pc-windows-msvc')).toEqual({
      file: 'node-v24.22.1-win-x64.zip',
      root: 'node-v24.22.1-win-x64',
    });
  });

  it('reads a sha256 from SHASUMS256.txt', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const text = `${a}  node-v24.22.1-linux-x64.tar.gz\n${b}  node-v24.22.1-linux-x64.tar.xz\n`;
    expect(shasumOf(text, 'node-v24.22.1-linux-x64.tar.gz')).toBe(a);
    expect(shasumOf(text, 'node-v24.22.1-linux-x64.tar.xz')).toBe(b);
    expect(shasumOf(text, 'node-v24.22.1-linux-x64')).toBeUndefined();
  });
});

describe('ThirdPartyLicenses', () => {
  it('finds the package of a module, scoped or nested', () => {
    expect(packageRootOf('/h/node_modules/ws/lib/websocket.js')).toBe('/h/node_modules/ws');
    expect(packageRootOf('/h/node_modules/@noble/curves/esm/ed25519.js')).toBe(
      '/h/node_modules/@noble/curves',
    );
    expect(packageRootOf('/h/node_modules/a/node_modules/b/index.js')).toBe(
      '/h/node_modules/a/node_modules/b',
    );
    expect(packageRootOf('/repo/packages/protocol/src/index.ts')).toBeUndefined();
    expect(packageRootOf('\0rolldown/runtime.js')).toBeUndefined();
  });

  it('collects each package once with its license files and skips workspace packages', () => {
    const root = temp();
    const pkg = (name: string, version: string, files: Record<string, string>) => {
      const dir = join(root, 'node_modules', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, license: 'MIT' }));
      for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
      return dir;
    };
    const ws = pkg('ws', '8.0.0', { LICENSE: 'ws license', 'index.js': '' });
    pkg('@scope/x', '1.0.0', { 'LICENSE.md': 'x license', NOTICE: 'x notice' });
    pkg('@wevir/protocol', '0.0.0', { LICENSE: 'ours' });
    pkg('bare', '2.0.0', {});
    const licenses = new ThirdPartyLicenses();
    licenses.addModules([join(ws, 'index.js'), join(ws, 'lib', 'a.js')]);
    licenses.addTree(join(root, 'node_modules'));
    expect(licenses.size).toBe(3);
    const text = licenses.render();
    expect(text).toContain('ws 8.0.0 (MIT)\n');
    expect(text).toContain('ws license');
    expect(text).toContain('x license\n\nx notice');
    expect(text).toContain('bare 2.0.0 (MIT)');
    expect(text).toContain('(no license file in the package)');
    expect(text).not.toContain('@wevir/protocol');
    expect(text.indexOf('@scope/x')).toBeLessThan(text.indexOf('bare 2.0.0'));
  });
});

describe('launchers', () => {
  it.skipIf(process.platform === 'win32')(
    'the Unix launcher follows links to find lib/ and passes arguments through',
    () => {
      const root = temp();
      const pkg = join(root, 'pkg');
      mkdirSync(join(pkg, 'bin'), { recursive: true });
      mkdirSync(join(pkg, 'lib', 'node'), { recursive: true });
      writeFileSync(join(pkg, 'bin', 'wevir'), UNIX_LAUNCHER, { mode: 0o755 });
      // 假的 node：打印它收到的参数。
      writeFileSync(join(pkg, 'lib', 'node', 'node'), '#!/bin/sh\nprintf "%s|" "$@"\n');
      chmodSync(join(pkg, 'lib', 'node', 'node'), 0o755);
      mkdirSync(join(root, 'links'));
      symlinkSync(join(pkg, 'bin', 'wevir'), join(root, 'links', 'one'));
      symlinkSync('one', join(root, 'links', 'wevir'));
      const result = spawnSync(join(root, 'links', 'wevir'), ['host', 'start', 'a b'], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      const [script, ...args] = result.stdout.split('|').filter((part) => part !== '');
      expect(script?.endsWith('/lib/cli/main.js')).toBe(true);
      expect(args).toEqual(['host', 'start', 'a b']);
    },
  );

  it('the Windows launcher uses CRLF and hands back the exit code', () => {
    expect(WINDOWS_LAUNCHER.split('\r\n').every((line) => !line.includes('\n'))).toBe(true);
    expect(WINDOWS_LAUNCHER).toContain(
      '"%WEVIR_LIB%\\node\\node.exe" "%WEVIR_LIB%\\cli\\main.js" %*',
    );
    expect(WINDOWS_LAUNCHER).toContain('exit /b %ERRORLEVEL%');
  });
});
