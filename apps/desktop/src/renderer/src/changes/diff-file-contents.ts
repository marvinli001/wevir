// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/web/src/lib/diffFileContents.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：只取 createDiffFileContentsLoader，请求换成 Wevir 的 `workspace.diffFile`；读不了时抛错，由 Pierre 收起展开。
//
// “展开未修改的行”的全文加载：Pierre 点开分隔条时要这个文件两侧的全文，经 `workspace.diffFile` 向 Host 要（旧的一侧是
// 这段 diff 的 `base`，新的一侧是 `head` 或磁盘上的工作树）。

import type { FileDiffContentsLoader } from '@pierre/diffs';
import type { WevirClient } from '@wevir/client-sdk';
import type { SessionId, WorkspaceId } from '@wevir/protocol';
import { resolveFileDiffPath } from './diff-rendering';

export interface DiffFileContentsSource {
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  /** 这段 diff 旧的一侧与新的一侧（没有时是工作树）。 */
  base: string;
  head: string | undefined;
  /** 这段 diff 的身份，Pierre 带进它渲染全文的缓存。 */
  cacheKey: string;
}

export function createDiffFileContentsLoader(
  client: WevirClient,
  source: DiffFileContentsSource,
): FileDiffContentsLoader {
  return async (fileDiff) => {
    const newPath = resolveFileDiffPath(fileDiff);
    const oldPath = fileDiff.prevName ?? newPath;
    const result = await client.request('workspace.diffFile', {
      workspaceId: source.workspaceId,
      sessionId: source.sessionId,
      ...(fileDiff.type !== 'new' && { oldRev: source.base, oldPath }),
      ...(fileDiff.type !== 'deleted' && {
        newPath,
        ...(source.head !== undefined && { newRev: source.head }),
      }),
    });
    if (result.unavailable !== undefined) throw new Error(result.unavailable);
    const newFile = {
      name: newPath,
      contents: result.newContents ?? '',
      cacheKey: `${source.cacheKey}:new:${newPath}`,
    };
    if (fileDiff.type === 'rename-pure') return { oldFile: null, newFile };
    return {
      oldFile: {
        name: oldPath,
        contents: result.oldContents ?? '',
        cacheKey: `${source.cacheKey}:old:${oldPath}`,
      },
      newFile,
    };
  };
}
