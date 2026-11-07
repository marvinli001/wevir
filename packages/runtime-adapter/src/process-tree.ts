// SPDX-License-Identifier: MIT
// npm 原生程序 shim 解析移植自 pingdotgg/t3code packages/shared/src/shell.ts。
// 来源提交 b6629dcd68dd26a98250e34087c594592ea55a46，Copyright (c) 2026 T3 Tools Inc.
// 修改：与进程树回收一起供引擎适配器共用；仅绕过完全匹配的 npm 原生程序 shim。

import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** POSIX 结束进程组，Windows 结束启动器及其全部子孙。 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    }).once('error', () => child.kill(signal));
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

// 移植自 pingdotgg/t3code packages/shared/src/shell.ts，b6629dcd68dd26a98250e34087c594592ea55a46，MIT。
const NPM_SHIM_PREFIX = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
];

function readShim(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** 只绕过 npm 原生程序 shim；CMD 保留的空白和额外命令必须原样比较。 */
export function npmShimExecutable(
  shim: string,
  read: (file: string) => string | undefined = readShim,
  exists: (file: string) => boolean = isFile,
): string | undefined {
  if (path.win32.extname(shim).toLowerCase() !== '.cmd') return undefined;
  const lines = read(shim)
    ?.split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (lines?.length !== NPM_SHIM_PREFIX.length + 1) return undefined;
  if (NPM_SHIM_PREFIX.some((line, index) => lines[index] !== line)) return undefined;
  const target = /^"%dp0%\\([^"%]+\.exe)" +%\*$/.exec(lines.at(-1) ?? '')?.[1];
  if (target === undefined) return undefined;
  const executable = path.win32.join(path.win32.dirname(shim), target);
  return exists(executable) ? executable : undefined;
}
