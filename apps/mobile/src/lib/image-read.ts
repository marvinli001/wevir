// 读电脑上的一张图片（帖子、会话里用户附的照片）：`image.read` 一段段往下读（每段最多 `IMAGE_READ_CHUNK_BYTES`），每段的 base64
// 交给 `write`（各段单独解码，边界不用对齐）。

import type { WevirClient } from '@wevir/client-sdk';
import type { UserImagePart } from '@wevir/protocol';
import { base64Bytes } from './photo-size';

export async function readImage(
  client: { request: WevirClient['request'] },
  imageId: UserImagePart['imageId'],
  write: (base64: string) => Promise<void>,
): Promise<void> {
  let offset = 0;
  for (;;) {
    const chunk = await client.request('image.read', { imageId, offset });
    const bytes = base64Bytes(chunk.data);
    if (bytes > 0) await write(chunk.data);
    offset += bytes;
    if (bytes === 0 || offset >= chunk.size) return;
  }
}
