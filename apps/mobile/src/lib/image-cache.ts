// 帖子里的图片在手机上的缓存：第一次显示时经隧道读（`image.read`）写进缓存目录 `post-images/<电脑名>/<图片 ID>.<扩展名>`，之后直接用
// 文件。系统清缓存目录时重读。同一张同时只读一遍。

import type { UserImagePart } from '@wevir/protocol';
import { Directory, File, Paths } from 'expo-file-system';

const EXTENSIONS: Record<UserImagePart['mimeType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const reading = new Map<string, Promise<string>>();

/** 图片的本机文件 URI；没缓存时用 `read` 一段段读进来（每段 base64 单独解码）。 */
export function cachedImage(
  computer: string,
  image: UserImagePart,
  read: (write: (base64: string) => Promise<void>) => Promise<void>,
): Promise<string> {
  const id = `${computer}/${image.imageId}`;
  const pending = reading.get(id);
  if (pending !== undefined) return pending;
  const task = (async () => {
    const dir = new Directory(Paths.cache, 'post-images', encodeURIComponent(computer));
    const file = new File(dir, `${image.imageId}.${EXTENSIONS[image.mimeType] ?? 'img'}`);
    if (file.exists && file.size === image.size) return file.uri;
    dir.create({ intermediates: true, idempotent: true });
    const partial = new File(dir, `${image.imageId}.part`);
    if (partial.exists) partial.delete();
    partial.create();
    await read((base64) => partial.write(base64, { encoding: 'base64', append: true }));
    if (file.exists) file.delete();
    partial.move(file);
    return file.uri;
  })();
  reading.set(id, task);
  task.finally(() => reading.delete(id)).catch(() => {});
  return task;
}
