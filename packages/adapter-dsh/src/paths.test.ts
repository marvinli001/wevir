import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DSH_VERSION, dshPaths, prepareDshHome, resolveDshEntry } from './paths.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wevir-adapter-dsh-paths-')));
  dirs.push(dir);
  return dir;
}

describe('resolveDshEntry', () => {
  it('从本包的依赖解析 dsh 入口，版本与 package.json 锁定的一致', () => {
    const { entry, version } = resolveDshEntry();
    expect(version).toBe(DSH_VERSION);
    expect(entry).toMatch(/[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/);
    expect(existsSync(entry)).toBe(true);
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies['@deepseek-ai/dsh']).toBe(DSH_VERSION);
  });

  it('不依赖 PATH：空环境下用 Node 直接运行入口', () => {
    const home = tempDir();
    const result = spawnSync(process.execPath, [resolveDshEntry().entry, '--version'], {
      env: { DSH_HOME: home },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(DSH_VERSION);
  });

  it('解析到的版本不是锁定版本、或没有 bin.dsh 时报错', () => {
    const fakeDsh = (manifest: object) => {
      const root = tempDir();
      const dir = join(root, 'node_modules', '@deepseek-ai', 'dsh');
      mkdirSync(join(dir, 'lib'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
      writeFileSync(join(dir, 'lib', 'bin.js'), '');
      return pathToFileURL(join(root, 'index.js'));
    };
    expect(() =>
      resolveDshEntry(fakeDsh({ version: '0.2.0-rc.2', bin: { dsh: 'lib/bin.js' } })),
    ).toThrow(/版本是 0\.2\.0-rc\.2，适配器锁定的是 0\.2\.1-alpha\.2/);
    expect(() => resolveDshEntry(fakeDsh({ version: DSH_VERSION }))).toThrow(/没有 bin\.dsh/);
    expect(
      resolveDshEntry(fakeDsh({ version: DSH_VERSION, bin: { dsh: 'lib/bin.js' } })).entry,
    ).toMatch(/node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/);
  });
});

describe('dshPaths / prepareDshHome', () => {
  it('DSH_HOME 是 <数据目录>/engines/dsh，DSH_AGENTS_HOME 是它旁边的 engines/dsh-agents', () => {
    const home = tempDir();
    expect(dshPaths(home)).toEqual({
      dshHome: join(home, 'engines', 'dsh'),
      agentsHome: join(home, 'engines', 'dsh-agents'),
    });
    expect(() => dshPaths(`relative${sep}home`)).toThrow(/绝对路径/);
  });

  it('首次启动时建好两个目录（0700），DSH_AGENTS_HOME 为空', () => {
    const paths = prepareDshHome(dshPaths(tempDir()));
    for (const dir of [paths.dshHome, paths.agentsHome]) {
      expect(statSync(dir).isDirectory()).toBe(true);
      if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  });

  it('重复调用不动已有内容，只把权限收紧到 0700', () => {
    const paths = dshPaths(tempDir());
    mkdirSync(join(paths.dshHome, 'sessions'), { recursive: true });
    writeFileSync(join(paths.dshHome, 'sessions', 'keep.jsonl'), 'x');
    chmodSync(paths.dshHome, 0o755);
    prepareDshHome(paths);
    prepareDshHome(paths);
    expect(readFileSync(join(paths.dshHome, 'sessions', 'keep.jsonl'), 'utf8')).toBe('x');
    if (process.platform !== 'win32') expect(statSync(paths.dshHome).mode & 0o777).toBe(0o700);
  });
});
