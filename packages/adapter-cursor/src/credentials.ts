// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-cursor/src/server/credentialStore.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：凭据从 T3 的密钥库改存 Wevir 数据目录的 engines/cursor/auth.json（0700 目录、0600 文件、临时文件加 rename，照 storage 的 FileSecretStore）
// ；去掉旧版文件的迁移；加上登录用的内存存储。
//
// Cursor 登录铸出的 API Key 存在 Wevir 自己的数据目录里（AGENTS.md 规则 5“密钥不落地”：不进仓库、日志、事件），不用 SDK 默认的
// `~/.cursor/sdk/auth.json`，也不读 Cursor CLI 自己的登录。格式是 SDK 的 `StoredSdkCredentials`，SDK 的登录直接写进来。

import { randomBytes } from 'node:crypto';
import { type FileHandle, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SdkCredentialStore, StoredSdkCredentials } from '@cursor/sdk';

/** 数据目录下 Cursor 引擎的目录（与 Codex 的 `engines/codex` 并列）。 */
export function cursorEngineDir(home: string): string {
  return join(home, 'engines', 'cursor');
}

export function cursorCredentialsPath(home: string): string {
  return join(cursorEngineDir(home), 'auth.json');
}

/** 不认识的内容当作没登录（SDK 自己的 FileCredentialStore 也这样），不抛错、不引用文件内容。 */
export function parseCredentials(value: unknown): StoredSdkCredentials | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.backendUrl !== 'string' ||
    typeof record.apiKey !== 'string' ||
    record.apiKey === '' ||
    typeof record.createdAtMs !== 'number'
  ) {
    return undefined;
  }
  if (record.apiKeyExpiresAtMs !== undefined && typeof record.apiKeyExpiresAtMs !== 'number') {
    return undefined;
  }
  if (record.email !== undefined && typeof record.email !== 'string') return undefined;
  return {
    version: 1,
    backendUrl: record.backendUrl,
    apiKey: record.apiKey,
    createdAtMs: record.createdAtMs,
    ...(typeof record.apiKeyExpiresAtMs === 'number' && {
      apiKeyExpiresAtMs: record.apiKeyExpiresAtMs,
    }),
    ...(typeof record.email === 'string' && { email: record.email }),
  };
}

/** 一个文件的 SdkCredentialStore。同一实例内的操作串行。 */
export class CursorCredentialFile implements SdkCredentialStore {
  readonly path: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  load(): Promise<StoredSdkCredentials | undefined> {
    return this.#serial(async () => {
      let content: string;
      try {
        content = await readFile(this.path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
      try {
        return parseCredentials(JSON.parse(content));
      } catch {
        return undefined;
      }
    });
  }

  save(credentials: StoredSdkCredentials): Promise<void> {
    return this.#serial(async () => {
      const dir = dirname(this.path);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = join(dir, `.auth.json.${randomBytes(6).toString('hex')}.tmp`);
      let handle: FileHandle | undefined;
      try {
        // wx：排他创建；umask 只会去掉权限位，再 chmod 一次确保正好是 0600。
        handle = await open(tmp, 'wx', 0o600);
        await handle.chmod(0o600);
        await handle.writeFile(`${JSON.stringify(credentials)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(tmp, this.path);
      } catch (error) {
        await handle?.close().catch(() => {});
        await rm(tmp, { force: true }).catch(() => {});
        throw error;
      }
    });
  }

  clear(): Promise<void> {
    return this.#serial(() => rm(this.path, { force: true }));
  }

  #serial<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(op, op);
    this.#queue = result.catch(() => {});
    return result;
  }
}

/** 只在内存里的 SdkCredentialStore：登录先写这里，确认是当前这次登录、没被取消，才存进文件（T3 的 pendingStore）。 */
export class MemoryCredentials implements SdkCredentialStore {
  #value: StoredSdkCredentials | undefined;

  async load(): Promise<StoredSdkCredentials | undefined> {
    return this.#value;
  }

  async save(credentials: StoredSdkCredentials): Promise<void> {
    this.#value = credentials;
  }

  async clear(): Promise<void> {
    this.#value = undefined;
  }
}
