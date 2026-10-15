// 测试的共用部分：假运行体（fake-agent.mjs 复制成 agy_acp_server.par）、数据目录、登录文件、ZIP 打包、模拟浏览器回调。

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32 } from 'node:zlib';
import { antigravityTokenPath } from '../profile.js';

const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));

/** 新建一个临时目录（测试结束由调用方删）。 */
export function tempDir(prefix = 'wevir-agy-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function removeDir(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

/**
 * 假运行体的两个文件的内容：可执行文件是当前 Node 的脚本，动态 import fake-agent.mjs（扩展名 .par 不能直接当 ESM 运行）。
 */
export function fakeRuntimeFiles(): { executable: Buffer; harness: Buffer } {
  return {
    executable: Buffer.from(
      `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(FAKE_AGENT).href)});\n`,
    ),
    // 补一些注释，让下载测试能在传输中途断开、卡住。
    harness: Buffer.from(`#!/bin/sh\nexit 0\n${'#'.repeat(256 * 1024)}\n`),
  };
}

/** 在 `directory` 里放一对假运行体，返回可执行文件的路径。 */
export function installFakeRuntime(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const files = fakeRuntimeFiles();
  const executable = path.join(directory, 'agy_acp_server.par');
  const harness = path.join(directory, 'localharness_external');
  writeFileSync(executable, files.executable);
  writeFileSync(harness, files.harness);
  chmodSync(executable, 0o755);
  chmodSync(harness, 0o755);
  return executable;
}

/** 当作已经登录：在 profile 里写一个假的登录文件。 */
export function writeFakeToken(home: string): void {
  const tokenPath = antigravityTokenPath(path.join(home, 'engines', 'antigravity', 'profile'));
  mkdirSync(path.dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify({ fake: true }));
}

/** 只用 stored（不压缩）条目打一个 ZIP，Unix 权限写进外部属性。 */
export function buildZip(entries: Array<{ name: string; data: Buffer; mode?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((0o100000 | (entry.mode ?? 0o755)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** 模拟用户在浏览器里登录完成：对登录网址里的 127.0.0.1 回调发 code 与 state。 */
export async function completeBrowserSignIn(authUrl: string, error?: string): Promise<void> {
  const url = new URL(authUrl);
  const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
  redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
  if (error === undefined) redirect.searchParams.set('code', 'fake-code');
  else redirect.searchParams.set('error', error);
  const response = await fetch(redirect);
  await response.text();
}

/** 等到条件成立（轮询），超时抛错。 */
export async function waitFor<T>(
  check: () => T | undefined | false | Promise<T | undefined | false>,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 测试用的告警出口：收集起来，不写 stderr。 */
export function collectingLogger(): {
  warn: (message: string, fields?: Record<string, unknown>) => void;
  messages: string[];
} {
  const messages: string[] = [];
  return { warn: (message) => messages.push(message), messages };
}
