// 输入栏上待发的照片（会话页与助理页共用）：从相册选或拍一张，压缩后传给 Host（`image.upload`），传好的带上图片部件。上传怎么做
// 由页面给（会话页要在 Android 选照片断线后换新连接再传）；出错时交给页面显示哪条提示。照片按草稿键存（attachment-store.ts），
// 离开页面再回来还在。

import {
  MESSAGE_ATTACHMENT_MAX_BYTES,
  type UserImageMimeType,
  type UserImagePart,
} from '@wevir/protocol';
import { useCallback, useSyncExternalStore } from 'react';
import type { MenuSection } from '../components/menu';
import { type MessageKey, t } from '../i18n';
import {
  PHOTOS_PER_MESSAGE,
  PhotoBudgetError,
  PhotoPermissionError,
  type PhotoSource,
  pickPhotos,
} from '../lib/photos';
import { sendErrorKey } from '../lib/session-actions';
import {
  type PhotoAttachment,
  readAttachments,
  updateAttachments,
  watchAttachments,
} from './attachment-store';

export type { PhotoAttachment } from './attachment-store';

// 正在选照片的草稿键：同一个草稿一次只选一批（页面离开又回来也算同一个）。
const adding = new Set<string>();

export function usePhotoAttachments({
  draftKey,
  upload,
  onError,
}: {
  /** 与输入栏的 `draftKey` 相同。 */
  draftKey: string;
  upload: (mimeType: UserImageMimeType, data: string) => Promise<UserImagePart>;
  /** 选或传失败（`undefined`：开始新的一次，清掉上一条）。 */
  onError: (key: MessageKey | undefined) => void;
}): {
  attachments: readonly PhotoAttachment[];
  /** 传好的图片部件，按添加的先后。 */
  images: readonly UserImagePart[];
  /** 加照片按钮的菜单：相册、拍照。 */
  menu: readonly MenuSection[];
  remove: (key: string) => void;
  clear: () => void;
} {
  const attachments = useSyncExternalStore(
    useCallback((listener) => watchAttachments(draftKey, listener), [draftKey]),
    () => readAttachments(draftKey),
  );
  const attach = async (source: PhotoSource) => {
    const target = draftKey;
    if (adding.has(target)) return;
    adding.add(target);
    onError(undefined);
    try {
      const attachments = readAttachments(target);
      const used = attachments.reduce((sum, item) => sum + (item.image?.size ?? 0), 0);
      const photos = await pickPhotos(
        source,
        PHOTOS_PER_MESSAGE - attachments.length,
        MESSAGE_ATTACHMENT_MAX_BYTES - used,
      );
      const entries = photos.map(({ uri }, index) => ({
        key: `${uri}:${Date.now()}:${index}`,
        uri,
        uploading: true,
      }));
      updateAttachments(target, (current) => [...current, ...entries]);
      for (const [index, photo] of photos.entries()) {
        const key = entries[index]?.key;
        try {
          const image = await upload(photo.mimeType, photo.data);
          updateAttachments(target, (current) =>
            current.map((item) => (item.key === key ? { ...item, uploading: false, image } : item)),
          );
        } catch (error) {
          onError(
            sendErrorKey(error) === 'error.computerOnly' ? 'error.computerOnly' : 'photo.failed',
          );
          updateAttachments(target, (current) => current.filter((item) => item.key !== key));
        }
      }
    } catch (error) {
      onError(
        error instanceof PhotoPermissionError
          ? 'photo.cameraDenied'
          : error instanceof PhotoBudgetError
            ? 'photo.budget'
            : 'photo.failed',
      );
    } finally {
      adding.delete(target);
    }
  };

  return {
    attachments,
    images: attachments.flatMap((a) => (a.image !== undefined ? [a.image] : [])),
    menu: [
      {
        items: [
          {
            label: t('photo.library'),
            icon: 'photo.on.rectangle',
            onPress: () => void attach('library'),
          },
          { label: t('photo.camera'), icon: 'camera', onPress: () => void attach('camera') },
        ],
      },
    ],
    remove: (key) => updateAttachments(draftKey, (current) => current.filter((a) => a.key !== key)),
    clear: () => updateAttachments(draftKey, () => []),
  };
}
