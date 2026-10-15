// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/provider/acp/AntigravitySessionFiles.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：Effect 改写成 Promise，失败只告警。
//
// 登录、刷新模型时开的一次性会话在 profile 里留下对话文件；临时 cwd 是这次独有的，据此确认是自己的会话再删。

import * as fsp from 'node:fs/promises';
import path from 'node:path';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** 进程关掉之后调用。只删 cwd 与 `<id>.meta` 里记的一致的那个会话。 */
export async function removeAntigravitySessionFiles(input: {
  profileDirectory: string;
  sessionId: string | undefined;
  cwd: string;
}): Promise<void> {
  if (input.sessionId === undefined || !UUID_V4.test(input.sessionId)) return;
  const acpDirectory = path.join(input.profileDirectory, 'antigravity-acp');
  const base = path.join(acpDirectory, 'conversations', input.sessionId);
  try {
    const metadata = JSON.parse(await fsp.readFile(`${base}.meta`, 'utf8')) as { cwd?: unknown };
    if (metadata.cwd !== input.cwd) return;
    for (const suffix of ['.db', '.db-wal', '.db-shm', '.db-journal', '.meta']) {
      await fsp.rm(`${base}${suffix}`, { force: true });
    }
    await fsp.rm(path.join(acpDirectory, 'brain', input.sessionId), {
      recursive: true,
      force: true,
    });
  } catch {
    // 没有这个会话的文件，或读不了：留着。
  }
}

/**
 * 删掉每个进程的临时目录的上级里剩下的东西。启动任何进程之前调用一次：上一个 Host 被杀掉时，解包的运行体（约 1 GB）
 * 会留在这里。只动 Wevir 自己的目录，不扫系统的临时目录。
 */
export async function removeAntigravityRuntimeTempDirs(tempDirectory: string): Promise<void> {
  await fsp.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
}
