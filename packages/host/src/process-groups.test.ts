// 子进程组的登记与回收（process-groups.ts）：用真实的 sleep 子进程。“Host 一侧”是另起的 node 进程（直接跑 process-groups.ts，
// 靠 Node 的类型擦除），测试用 SIGKILL 结束它，模拟 Host 被强行结束。Windows 上跳过（没有进程组）。

import { type ChildProcess, spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ProcessGroupRecord,
  ProcessGroupRegistry,
  processFingerprint,
} from './process-groups.js';
import { useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const posix = process.platform !== 'win32';
const MODULE_URL = pathToFileURL(join(import.meta.dirname, 'process-groups.ts')).href;

/** 测试起过的组与 Host 一侧的进程：结束时全部收掉。 */
const groups = new Set<number>();
const hosts: ChildProcess[] = [];
const registries: ProcessGroupRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  for (const host of hosts.splice(0)) host.kill('SIGKILL');
  for (const pgid of groups) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {}
  }
  groups.clear();
});

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 一个自成进程组的 sleep（组里还有一个后台 sleep）。 */
function sleeper(): ChildProcess {
  const child = spawn('/bin/sh', ['-c', 'sleep 60 & exec sleep 60'], {
    detached: true,
    stdio: 'ignore',
  });
  if (child.pid !== undefined) groups.add(child.pid);
  return child;
}

const HOST_SIDE = `
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
const [moduleUrl, dir, watchdog, count] = process.argv.slice(2);
const { ProcessGroupRegistry } = await import(moduleUrl);
const registry = new ProcessGroupRegistry({ dir, watchdog: watchdog === '1', graceMs: 1000 });
const pids = [];
for (let i = 0; i < Number(count); i++) {
  const child = spawn('/bin/sh', ['-c', 'sleep 60 & exec sleep 60'], { detached: true, stdio: 'ignore' });
  registry.track(child, {
    kind: 'process', name: 'sleep ' + i, sessionId: 'ses_A', ownerId: 'p' + (i + 1),
    command: 'sleep 60', cwd: dir, logPath: dir + '/p' + (i + 1) + '.log',
  });
  pids.push(child.pid);
}
const files = () => { try { return readdirSync(dir).filter((name) => name.endsWith('.json')).length; } catch { return 0; } };
while (files() < pids.length) await new Promise((resolve) => setTimeout(resolve, 20));
process.stdout.write(JSON.stringify(pids) + '\\n');
setInterval(() => {}, 1000);
`;

/** 起“Host 一侧”，等它登记好 `count` 个组，返回组号。 */
async function startHostSide(root: string, watchdog: boolean, count = 2) {
  const script = join(root, 'host-side.mjs');
  writeFileSync(script, HOST_SIDE);
  const dir = join(root, 'process-groups');
  const host = spawn(
    process.execPath,
    ['--no-warnings', script, MODULE_URL, dir, watchdog ? '1' : '0', String(count)],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  hosts.push(host);
  const pgids = await new Promise<number[]>((resolve, reject) => {
    let out = '';
    host.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('\n')) resolve(JSON.parse(out) as number[]);
    });
    host.once('exit', (code) => reject(new Error(`host side exited (${code})`)));
  });
  for (const pgid of pgids) groups.add(pgid);
  return { host, dir, pgids };
}

async function kill9(host: ChildProcess): Promise<void> {
  const exited = new Promise((resolve) => host.once('exit', resolve));
  host.kill('SIGKILL');
  await exited;
}

describe.runIf(posix)('processFingerprint', () => {
  it('活着的进程每次读到的一样，不同进程不同；进程不在了时没有', async () => {
    const first = await processFingerprint(process.pid);
    expect(first).toMatch(/^(linux|ps):/);
    expect(await processFingerprint(process.pid)).toBe(first);
    const child = sleeper();
    const pid = child.pid as number;
    await vi.waitFor(async () => expect(await processFingerprint(pid)).toBeDefined());
    const exited = new Promise((resolve) => child.once('exit', resolve));
    process.kill(-pid, 'SIGKILL');
    await exited;
    expect(await processFingerprint(pid)).toBeUndefined();
  });
});

describe.runIf(posix)('ProcessGroupRegistry', () => {
  it('登记组长与指纹，组长关闭时删掉登记', async () => {
    const root = tempDir();
    const dir = join(root, 'groups');
    const registry = new ProcessGroupRegistry({ dir, watchdog: false });
    registries.push(registry);
    const child = sleeper();
    const pgid = child.pid as number;
    registry.track(child, { kind: 'process', name: 'demo', sessionId: 'ses_A', ownerId: 'p1' });
    await vi.waitFor(() => expect(readdirSync(dir)).toEqual([`${pgid}.json`]));
    const record = JSON.parse(
      readFileSync(join(dir, `${pgid}.json`), 'utf8'),
    ) as ProcessGroupRecord;
    expect(record).toMatchObject({
      pgid,
      kind: 'process',
      name: 'demo',
      sessionId: 'ses_A',
      ownerId: 'p1',
      hostPid: process.pid,
      fingerprint: await processFingerprint(pgid),
    });
    process.kill(-pgid, 'SIGTERM');
    await vi.waitFor(() => expect(readdirSync(dir)).toEqual([]));
  });

  it('Host 被强行结束（没有看门狗）：组留着；再启动时 reap 结束它们、清掉登记', async () => {
    const root = tempDir();
    const { host, dir, pgids } = await startHostSide(root, false);
    await kill9(host);
    // 组长与组里的后台 sleep 都还在。
    for (const pgid of pgids) expect(groupAlive(pgid)).toBe(true);

    const registry = new ProcessGroupRegistry({ dir, watchdog: false, graceMs: 1000 });
    registries.push(registry);
    const reaped = await registry.reap();
    expect(reaped.map((group) => [group.record.pgid, group.outcome]).sort()).toEqual(
      pgids.map((pgid) => [pgid, 'stopped']).sort(),
    );
    expect(reaped[0]?.record).toMatchObject({ kind: 'process', sessionId: 'ses_A' });
    for (const pgid of pgids) await vi.waitFor(() => expect(groupAlive(pgid)).toBe(false));
    expect(readdirSync(dir)).toEqual([]);
    // 再回收一次：没有可回收的了。
    expect(await registry.reap()).toEqual([]);
  });

  it('Host 被强行结束（有看门狗）：看门狗当即结束登记的组', async () => {
    const root = tempDir();
    const { host, pgids } = await startHostSide(root, true);
    await kill9(host);
    for (const pgid of pgids) {
      await vi.waitFor(() => expect(groupAlive(pgid)).toBe(false), { timeout: 5000 });
    }
  });

  it('Host 正常关闭：看门狗不动手；没结束的组的登记留到下次启动', async () => {
    const root = tempDir();
    const dir = join(root, 'groups');
    const registry = new ProcessGroupRegistry({ dir, graceMs: 1000 });
    const child = sleeper();
    const pgid = child.pid as number;
    registry.track(child, { kind: 'engine', name: 'engine' });
    await vi.waitFor(() => expect(readdirSync(dir)).toHaveLength(1));
    await registry.close();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(groupAlive(pgid)).toBe(true);
    const next = new ProcessGroupRegistry({ dir, watchdog: false, graceMs: 1000 });
    registries.push(next);
    expect((await next.reap()).map((group) => group.outcome)).toEqual(['stopped']);
    await vi.waitFor(() => expect(groupAlive(pgid)).toBe(false));
  });

  it('PID 被别的进程重用（指纹不同）时不碰；组长不在了的只删登记', async () => {
    const root = tempDir();
    const dir = join(root, 'groups');
    await mkdir(dir, { recursive: true });
    const other = sleeper();
    const otherPid = other.pid as number;
    const gone = sleeper();
    const gonePid = gone.pid as number;
    const goneExited = new Promise((resolve) => gone.once('exit', resolve));
    process.kill(-gonePid, 'SIGKILL');
    await goneExited;
    const base = { kind: 'process', name: 'x', hostPid: 1, hostInstance: 'old', startedAt: 0 };
    writeFileSync(
      join(dir, `${otherPid}.json`),
      JSON.stringify({ ...base, pgid: otherPid, fingerprint: 'ps:Thu Jan  1 00:00:00 1970' }),
    );
    writeFileSync(
      join(dir, `${gonePid}.json`),
      JSON.stringify({ ...base, pgid: gonePid, fingerprint: 'ps:x' }),
    );
    writeFileSync(join(dir, 'broken.json'), '{');
    writeFileSync(join(dir, '7.json.abc.tmp'), '{');

    const registry = new ProcessGroupRegistry({ dir, watchdog: false, graceMs: 500 });
    registries.push(registry);
    const reaped = await registry.reap();
    expect(Object.fromEntries(reaped.map((group) => [group.record.pgid, group.outcome]))).toEqual({
      [otherPid]: 'reused',
      [gonePid]: 'gone',
    });
    expect(groupAlive(otherPid)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('本进程里还开着的登记表的组不回收', async () => {
    const root = tempDir();
    const dir = join(root, 'groups');
    const first = new ProcessGroupRegistry({ dir, watchdog: false });
    registries.push(first);
    const child = sleeper();
    const pgid = child.pid as number;
    first.track(child, { kind: 'process', name: 'live' });
    await vi.waitFor(() => expect(readdirSync(dir)).toHaveLength(1));
    const second = new ProcessGroupRegistry({ dir, watchdog: false });
    registries.push(second);
    expect(await second.reap()).toEqual([]);
    expect(groupAlive(pgid)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(1);
  });
});
