// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/orchestration-v2/Adapters/ClaudeTaskOutputTail.ts（`claudeTaskOutputRoot`、`tailClaudeTaskOutput`）
// 来源提交 a5d97921f6a2a310f55c481763248a313ed3dc17
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写成不依赖 `effect` 的普通 TS（node:fs/promises 与定时器）；停下时不再补读最后一次，命令的完整输出以工具结果为准。
//
// 前台 Bash 的实时输出。Agent SDK 在工具结果之前不给命令的输出，但 Claude Code 把跑着的命令的合并输出写进
// `<临时目录>/claude-<uid>/<项目>/<session_id>/tasks/<task_id>.output`，并在 `task_started`（`task_type: 'local_bash'`）里给出
// task_id。这是 Claude Code 私有的目录布局，不是 SDK 的接口：找不到文件、读失败或布局变了都只是没有实时输出，工具结果照样
// 带完整输出。

import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** 命令跑着时多久看一次文件。 */
export const TASK_OUTPUT_POLL_MS = 250;
/** 找文件的次数上限：Claude Code 一直没写（新的布局、Windows）就放弃。 */
const MAX_LOCATE_ATTEMPTS = 40;
/** 每次最多读的字节：写得更快时跳到末尾，反正界面只显示尾部。 */
const MAX_READ_BYTES = 256 * 1024;

/** Claude Code 按用户分的临时目录；没有 uid 的平台（Windows）没有。 */
export function claudeTaskOutputRoot(
  env: Readonly<Record<string, string | undefined>> | undefined,
): string | undefined {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  const base = env?.CLAUDE_CODE_TMPDIR?.trim() || '/tmp';
  return join(base, `claude-${uid}`);
}

async function locate(
  root: string,
  sessionId: string,
  taskId: string,
): Promise<string | undefined> {
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return undefined;
  }
  for (const project of projects) {
    const candidate = join(root, project, sessionId, 'tasks', `${taskId}.output`);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // 不在这个项目目录下。
    }
  }
  return undefined;
}

/**
 * 读文件新追加的部分交给 `onChunk`，直到返回的 `stop` 被调用。读不到时什么也不交。
 */
export function tailClaudeTaskOutput(input: {
  root: string;
  sessionId: string;
  taskId: string;
  onChunk: (chunk: string) => void;
  pollMs?: number;
}): { stop: () => void } {
  const pollMs = input.pollMs ?? TASK_OUTPUT_POLL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const pause = () =>
    new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, pollMs);
    });

  void (async () => {
    let file: string | undefined;
    for (let attempt = 0; file === undefined; attempt += 1) {
      file = await locate(input.root, input.sessionId, input.taskId);
      if (stopped) return;
      if (file !== undefined) break;
      if (attempt + 1 >= MAX_LOCATE_ATTEMPTS) return;
      await pause();
      if (stopped) return;
    }
    // `stream: true` 让跨两次读的多字节字符保持完整；坏字节换成 U+FFFD。
    let decoder = new TextDecoder('utf-8', { fatal: false });
    let offset = 0;
    while (!stopped) {
      let size = offset;
      try {
        size = (await stat(file)).size;
      } catch {
        // 文件暂时读不到：下次再看。
      }
      if (size < offset) offset = 0;
      if (size > offset) {
        const start = size - offset > MAX_READ_BYTES ? size - MAX_READ_BYTES : offset;
        let bytes: Uint8Array | undefined;
        try {
          const handle = await open(file, 'r');
          try {
            const buffer = Buffer.alloc(size - start);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
            bytes = buffer.subarray(0, bytesRead);
          } finally {
            await handle.close();
          }
        } catch {
          bytes = undefined;
        }
        if (stopped) return;
        if (bytes !== undefined) {
          // 跳过了一段：不把前后两行拼在一起，跳过之前没读完的字符也不要了。
          const skipped = start > offset;
          if (skipped) decoder = new TextDecoder('utf-8', { fatal: false });
          offset = start + bytes.byteLength;
          const text = (skipped ? '\n' : '') + decoder.decode(bytes, { stream: true });
          if (text.length > 0) input.onChunk(text);
        }
      }
      await pause();
    }
  })().catch(() => {
    // 私有布局读失败只是没有实时输出。
  });

  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      wake?.();
    },
  };
}
