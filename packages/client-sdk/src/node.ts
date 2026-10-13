// Node 入口（ADR-0002 §7）：读取 `<数据目录>/run/host.json` 找到本机的 Host。浏览器入口（index.ts）不含
// 这些，Node 内置模块只在本文件里 import。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type HostEndpoint, WevirClient, type WevirClientOptions } from './client.js';
import { HostUnavailableError } from './errors.js';

/** `run/host.json` 的路径（host-api.md §1）。`home` 是 Host 的数据目录。 */
export function hostRuntimeFilePath(home: string): string {
  return join(home, 'run', 'host.json');
}

/**
 * 读出 Host 的端点。只用文件里的 `url`，不自己拼地址、不回退到任何默认端口（ADR-0002 §1）。
 * 文件不存在：Host 没在运行；没有 `url`：Host 正在启动（占位文件，稍后重读）；两者都抛
 * `HostUnavailableError`，`reason` 区分。
 */
export async function readHostEndpoint(home: string): Promise<HostEndpoint> {
  const path = hostRuntimeFilePath(home);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HostUnavailableError('not_running', path);
    }
    throw new HostUnavailableError('invalid_runtime_file', path, { cause: error });
  }
  // 占位文件刚被排他创建、还没写入内容时是空的。
  if (text.trim() === '') throw new HostUnavailableError('starting', path);
  let info: unknown;
  try {
    info = JSON.parse(text);
  } catch (error) {
    throw new HostUnavailableError('invalid_runtime_file', path, { cause: error });
  }
  if (typeof info !== 'object' || info === null) {
    throw new HostUnavailableError('invalid_runtime_file', path);
  }
  const { url, token } = info as Record<string, unknown>;
  if (url === undefined) throw new HostUnavailableError('starting', path);
  if (typeof url !== 'string' || url === '' || typeof token !== 'string' || token === '') {
    throw new HostUnavailableError('invalid_runtime_file', path);
  }
  return { url, token };
}

export interface LocalHostOptions extends Omit<WevirClientOptions, 'endpoint'> {
  /** Host 的数据目录（绝对路径）。 */
  home: string;
}

/**
 * 连接本机数据目录 `home` 下的 Host。每次连接尝试都重读 `run/host.json`，所以 Host 重启（换了端口和
 * 令牌）之后能自动重连上新的 Host。
 */
export function connectLocalHost({ home, ...options }: LocalHostOptions): Promise<WevirClient> {
  return WevirClient.connect({ ...options, endpoint: () => readHostEndpoint(home) });
}
