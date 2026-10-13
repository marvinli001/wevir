import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HostAlreadyRunningError,
  type HostRuntimeInfo,
  isRuntimeInfoStale,
  parseRuntimeInfo,
  RUNTIME_FILE,
  RuntimeFile,
} from './runtime-file.js';
import { useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const POSIX = process.platform !== 'win32';
const versions = { protocolVersion: '0.1.0', hostVersion: '0.0.0' };

function filePath(): string {
  return join(tempDir(), 'run', RUNTIME_FILE);
}

function read(): HostRuntimeInfo {
  return JSON.parse(readFileSync(filePath(), 'utf8')) as HostRuntimeInfo;
}

async function writeExisting(content: string): Promise<void> {
  await mkdir(join(tempDir(), 'run'), { recursive: true });
  writeFileSync(filePath(), content);
}

/** 一个已经退出的进程的 PID。 */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ['-e', '']).pid;
  if (pid === undefined) throw new Error('spawnSync 没有返回 pid');
  return pid;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('RuntimeFile', () => {
  it('acquire：run/ 0700、host.json 0600，先写不含 url 与令牌的占位', async () => {
    const file = await RuntimeFile.acquire({ home: tempDir(), ...versions });
    expect(file.path).toBe(filePath());
    expect(read()).toEqual({ pid: process.pid, startedAt: file.info.startedAt, ...versions });
    expect(file.reclaimed).toBeUndefined();
    if (POSIX) {
      expect(mode(join(tempDir(), 'run'))).toBe(0o700);
      expect(mode(filePath())).toBe(0o600);
    }
  });

  it('acquire：已有的 run/ 权限过宽时收紧到 0700', async () => {
    if (!POSIX) return;
    await mkdir(join(tempDir(), 'run'), { recursive: true, mode: 0o755 });
    await RuntimeFile.acquire({ home: tempDir(), ...versions });
    expect(mode(join(tempDir(), 'run'))).toBe(0o700);
  });

  it('publish：原子地补上 url 与令牌，不留临时文件，权限仍为 0600', async () => {
    const file = await RuntimeFile.acquire({ home: tempDir(), ...versions });
    await file.publish('ws://127.0.0.1:1234/', 'tok');
    expect(read()).toEqual({
      pid: process.pid,
      startedAt: file.info.startedAt,
      ...versions,
      url: 'ws://127.0.0.1:1234/',
      token: 'tok',
    });
    expect(readdirSync(join(tempDir(), 'run'))).toEqual([RUNTIME_FILE]);
    if (POSIX) expect(mode(filePath())).toBe(0o600);
  });

  it('已有活着的 Host：抛 HostAlreadyRunningError，不动它的文件', async () => {
    // 父进程（运行测试的进程树）一定活着，且不是当前进程。
    const existing = { pid: process.ppid, startedAt: new Date().toISOString(), ...versions };
    const text = JSON.stringify({ ...existing, url: 'ws://127.0.0.1:1/', token: 'theirs' });
    await writeExisting(text);
    const error = await RuntimeFile.acquire({ home: tempDir(), ...versions }).catch((e) => e);
    expect(error).toBeInstanceOf(HostAlreadyRunningError);
    expect(error.existing).toMatchObject(existing);
    expect(readFileSync(filePath(), 'utf8')).toBe(text);
  });

  it('陈旧文件被回收：PID 已退出、写于本次开机之前、PID 是自己', async () => {
    const cases: Array<Pick<HostRuntimeInfo, 'pid' | 'startedAt'>> = [
      { pid: deadPid(), startedAt: new Date().toISOString() },
      { pid: process.ppid, startedAt: '2000-01-01T00:00:00.000Z' },
      { pid: process.pid, startedAt: new Date().toISOString() },
    ];
    for (const stale of cases) {
      await writeExisting(JSON.stringify({ ...stale, ...versions, url: 'ws://x/', token: 't' }));
      const file = await RuntimeFile.acquire({ home: tempDir(), ...versions });
      expect(file.reclaimed).toMatchObject(stale);
      expect(read().startedAt).toBe(file.info.startedAt);
      expect(file.releaseSync()).toBe(true);
    }
  });

  it('创建者写入前就退出留下的空文件被回收', async () => {
    await writeExisting('');
    const file = await RuntimeFile.acquire({ home: tempDir(), ...versions });
    expect(read().pid).toBe(process.pid);
    expect(file.reclaimed).toBeUndefined();
  });

  it('内容无法解析时拒绝启动，不擅自删除', async () => {
    await writeExisting('{not json');
    await expect(RuntimeFile.acquire({ home: tempDir(), ...versions })).rejects.toThrow(
      'not a valid runtime file',
    );
    expect(readFileSync(filePath(), 'utf8')).toBe('{not json');
  });

  it('releaseSync 只删除 {pid, startedAt} 仍是自己的文件', async () => {
    const file = await RuntimeFile.acquire({ home: tempDir(), ...versions });
    const other = {
      pid: process.ppid,
      startedAt: new Date(Date.now() + 1).toISOString(),
      ...versions,
    };
    writeFileSync(filePath(), JSON.stringify(other));
    expect(file.releaseSync()).toBe(false);
    expect(read()).toEqual(other);
    // 别人的文件也不会被 publish 覆盖。
    await expect(file.publish('ws://127.0.0.1:1/', 'tok')).rejects.toThrow('no longer owned');
    expect(read()).toEqual(other);

    writeFileSync(filePath(), JSON.stringify(file.info));
    expect(file.releaseSync()).toBe(true);
    expect(file.releaseSync()).toBe(false);
  });
});

describe('isRuntimeInfoStale', () => {
  const info = { pid: 42, startedAt: '2026-10-13T08:00:00.000Z', ...versions };
  const boot = Date.parse('2026-10-13T07:00:00.000Z');

  it('PID 活着且写于本次开机之后：不陈旧', () => {
    expect(isRuntimeInfoStale(info, { isAlive: () => true, bootTime: boot, selfPid: 1 })).toBe(
      false,
    );
  });

  it('PID 不在、写于本次开机之前（含 5 s 容差之外）、PID 是自己：陈旧', () => {
    expect(isRuntimeInfoStale(info, { isAlive: () => false, bootTime: boot, selfPid: 1 })).toBe(
      true,
    );
    const beforeBoot = { ...info, startedAt: '2026-10-13T06:59:54.000Z' };
    expect(
      isRuntimeInfoStale(beforeBoot, { isAlive: () => true, bootTime: boot, selfPid: 1 }),
    ).toBe(true);
    const withinTolerance = { ...info, startedAt: '2026-10-13T06:59:56.000Z' };
    expect(
      isRuntimeInfoStale(withinTolerance, { isAlive: () => true, bootTime: boot, selfPid: 1 }),
    ).toBe(false);
    expect(isRuntimeInfoStale(info, { isAlive: () => true, bootTime: boot, selfPid: 42 })).toBe(
      true,
    );
  });
});

describe('parseRuntimeInfo', () => {
  it('接受占位与完整内容，忽略多余字段；形状不对返回 undefined', () => {
    const base = { pid: 1, startedAt: 'x', ...versions };
    expect(parseRuntimeInfo(JSON.stringify(base))).toEqual(base);
    expect(parseRuntimeInfo(JSON.stringify({ ...base, url: 'u', token: 't', extra: 1 }))).toEqual({
      ...base,
      url: 'u',
      token: 't',
    });
    expect(parseRuntimeInfo('')).toBeUndefined();
    expect(parseRuntimeInfo('[]')).toBeUndefined();
    expect(parseRuntimeInfo(JSON.stringify({ ...base, pid: 0 }))).toBeUndefined();
    expect(parseRuntimeInfo(JSON.stringify({ ...base, url: 1 }))).toBeUndefined();
    expect(parseRuntimeInfo(JSON.stringify({ pid: 1 }))).toBeUndefined();
  });
});
