import type { FileDiffMetadata } from '@pierre/diffs';
import type { WevirClient } from '@wevir/client-sdk';
import type { SessionId, WorkspaceId } from '@wevir/protocol';
import { describe, expect, it, vi } from 'vitest';
import { folderCacheKey } from './change-folders';
import { createDiffFileContentsLoader } from './diff-file-contents';

const workspaceId = 'ws_contents' as WorkspaceId;
const sessionId = 'ses_contents' as SessionId;
const file = { name: 'same.ts', type: 'change' } as FileDiffMetadata;

describe('diff 全文目录', () => {
  it.each([true, false])('全文请求按 Host 功能发送目录：%s', async (multiple) => {
    const request = vi.fn().mockResolvedValue({ oldContents: 'old', newContents: 'new' });
    const client = { request } as unknown as WevirClient;
    const source = {
      workspaceId,
      sessionId,
      folder: '/api',
      base: 'a'.repeat(40),
      head: undefined,
      cacheKey: folderCacheKey(sessionId, '/api'),
    };
    const load = createDiffFileContentsLoader(client, source, { multi_folder_changes: multiple });
    await load(file);
    expect(request).toHaveBeenCalledWith('workspace.diffFile', {
      workspaceId,
      sessionId,
      oldRev: source.base,
      oldPath: 'same.ts',
      newPath: 'same.ts',
      ...(multiple && { folder: '/api' }),
    });
  });

  it('不同目录同名文件的全文缓存分开', async () => {
    const request = vi.fn().mockResolvedValue({ oldContents: 'old', newContents: 'new' });
    const client = { request } as unknown as WevirClient;
    const contents = await Promise.all(
      ['/app', '/api'].map((folder) =>
        createDiffFileContentsLoader(
          client,
          {
            workspaceId,
            sessionId,
            folder,
            base: 'a'.repeat(40),
            head: undefined,
            cacheKey: folderCacheKey(sessionId, folder),
          },
          { multi_folder_changes: true },
        )(file),
      ),
    );
    expect(contents[0]?.oldFile?.cacheKey).not.toBe(contents[1]?.oldFile?.cacheKey);
    expect(contents[0]?.newFile?.cacheKey).not.toBe(contents[1]?.newFile?.cacheKey);
  });
});
