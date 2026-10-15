// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/zipArchive.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：Effect 改写成 Promise；错误统一成 ZipArchiveError（带说明），由调用方包成安装失败。
//
// 打开一个已经校验过 sha256 的本地 ZIP，一次读一个条目（yauzl 的 lazyEntries）。用完要 `close`。

import type { Readable } from 'node:stream';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

export class ZipArchiveError extends Error {
  override readonly name = 'ZipArchiveError';
}

export interface ZipArchive {
  readonly entryCount: number;
  /** 下一个条目；读完时为 null。 */
  next(): Promise<Entry | null>;
  /** 条目内容的流（deflate 已解开，yauzl 校验解出的大小）。 */
  openEntry(entry: Entry): Promise<Readable>;
  close(): Promise<void>;
}

export async function openZipArchive(archivePath: string): Promise<ZipArchive> {
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    yauzl.open(
      archivePath,
      { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true },
      (error, opened) => {
        if (error || !opened) {
          reject(new ZipArchiveError('Could not open the verified archive.', { cause: error }));
          return;
        }
        resolve(opened);
      },
    );
  });
  let closed = false;
  let archiveError: Error | undefined;
  zip.on('close', () => {
    closed = true;
  });
  zip.on('error', (cause: unknown) => {
    archiveError = new ZipArchiveError('The archive could not be read.', { cause });
  });

  return {
    entryCount: zip.entryCount,
    next: () =>
      new Promise<Entry | null>((resolve, reject) => {
        if (archiveError !== undefined) {
          reject(archiveError);
          return;
        }
        const cleanup = () => {
          zip.removeListener('entry', onEntry);
          zip.removeListener('end', onEnd);
          zip.removeListener('error', onError);
        };
        const onEntry = (entry: Entry) => {
          cleanup();
          resolve(entry);
        };
        const onEnd = () => {
          cleanup();
          resolve(null);
        };
        const onError = (cause: unknown) => {
          cleanup();
          reject(new ZipArchiveError('The archive could not be read.', { cause }));
        };
        zip.once('entry', onEntry);
        zip.once('end', onEnd);
        zip.once('error', onError);
        zip.readEntry();
      }),
    openEntry: (entry) =>
      new Promise<Readable>((resolve, reject) => {
        zip.openReadStream(entry, (cause, readable) => {
          if (cause || !readable) {
            reject(new ZipArchiveError('Could not read an archive member.', { cause }));
            return;
          }
          resolve(readable);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        zip.once('close', () => resolve());
        zip.close();
      }),
  };
}
