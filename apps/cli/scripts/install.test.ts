import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// install.sh 对着本机的假线路跑：线路上是只会打印自己版本的假包，核对下载、校验、版本目录、链接与清理。

const script = fileURLToPath(new URL('./install.sh', import.meta.url));
const plat = `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

let root: string;
let mirror: string;
let server: Server;
let url: string;

function addVersion(version: string, options: { badSum?: boolean } = {}): void {
  const name = `wevir-cli-${version}-${plat}`;
  const stage = join(root, 'stage', name);
  mkdirSync(join(stage, 'bin'), { recursive: true });
  mkdirSync(join(stage, 'lib'), { recursive: true });
  writeFileSync(join(stage, 'bin', 'wevir'), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  const archive = join(mirror, `${name}.tar.gz`);
  const tar = spawnSync('tar', ['-czf', archive, '-C', join(root, 'stage'), name]);
  expect(tar.status).toBe(0);
  const sha = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const sum = options.badSum ? sha.replace(/^./, sha.startsWith('0') ? '1' : '0') : sha;
  writeFileSync(join(mirror, `wevir-cli-${version}-checksums.txt`), `${sum}  ${name}.tar.gz\n`);
}

function install(home: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('sh', [script, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: join(root, 'tmp'),
        WEVIR_CLI_MIRROR: url,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function wevirVersion(home: string): string {
  return spawnSync(join(home, '.local', 'bin', 'wevir'), { encoding: 'utf8' }).stdout.trim();
}

const unix = process.platform === 'darwin' || process.platform === 'linux';

describe.skipIf(!unix)('install.sh', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'wevir-cli-install-'));
    mirror = join(root, 'mirror');
    mkdirSync(mirror);
    mkdirSync(join(root, 'tmp'));
    server = createServer((req, res) => {
      const path = join(mirror, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
      if (!path.startsWith(mirror) || !existsSync(path)) {
        res.writeHead(404).end();
        return;
      }
      res.end(readFileSync(path));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    addVersion('0.1.1-beta.3');
    addVersion('0.1.1-beta.4');
    addVersion('0.1.1-beta.5');
    addVersion('0.1.1-beta.6', { badSum: true });
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  it('falls back to beta without a stable release, links the current version and keeps the previous one', async () => {
    const home = join(root, 'home-a');
    writeFileSync(join(mirror, 'beta.txt'), '0.1.1-beta.3\n');
    const first = await install(home);
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('No stable release yet');
    expect(wevirVersion(home)).toBe('0.1.1-beta.3');
    const prefix = join(home, '.local', 'share', 'wevir-cli');
    expect(readlinkSync(join(prefix, 'current'))).toBe('0.1.1-beta.3');
    expect(readlinkSync(join(home, '.local', 'bin', 'wevir'))).toBe(
      join(prefix, 'current', 'bin', 'wevir'),
    );

    writeFileSync(join(mirror, 'beta.txt'), '0.1.1-beta.4\n');
    expect((await install(home, ['--channel', 'beta'])).status).toBe(0);
    expect(wevirVersion(home)).toBe('0.1.1-beta.4');
    expect(readdirSync(prefix).sort()).toEqual(['0.1.1-beta.3', '0.1.1-beta.4', 'current']);

    const third = await install(home, ['--version', '0.1.1-beta.5']);
    expect(third.status).toBe(0);
    expect(third.stdout).toContain('A Host started by wevir 0.1.1-beta.4 keeps running');
    expect(readdirSync(prefix).sort()).toEqual(['0.1.1-beta.4', '0.1.1-beta.5', 'current']);
  });

  it('refuses a package whose sha256 does not match', async () => {
    const home = join(root, 'home-b');
    const result = await install(home, ['--version', '0.1.1-beta.6']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not download a verified');
    expect(existsSync(join(home, '.local', 'bin', 'wevir'))).toBe(false);
  });

  it('fails clearly when the channel has no release', async () => {
    const result = await install(join(root, 'home-c'), [], { WEVIR_CLI_CHANNEL: 'stable' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not read the newest stable version');
  });
});
