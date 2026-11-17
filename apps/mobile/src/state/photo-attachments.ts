// 输入栏上待发的照片（会话页与助理页共用）：从相册选或拍一张，压缩后传给 Host（`image.upload`），传好的带上图片部件。上传怎么做
// 由页面给（会话页要在 Android 选照片断线后换新连接再传）；出错时交给页面显示哪条提示。

import {
  MESSAGE_ATTACHMENT_MAX_BYTES,
  type UserImageMimeType,
  type UserImagePart,
} from '@wevir/protocol';
import { useRef, useState } from 'react';
import type { ComposerAttachment } from '../components/composer';
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

export interface PhotoAttachment extends ComposerAttachment {
  image?: UserImagePart;
}

export function usePhotoAttachments({
  upload,
  onError,
}: {
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
  const [attachments, setAttachments] = useState<PhotoAttachment[]>([]);

  const adding = useRef(false);
  const attach = async (source: PhotoSource) => {
    if (adding.current) return;
    adding.current = true;
    onError(undefined);
    try {
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
      setAttachments((current) => [...current, ...entries]);
      for (const [index, photo] of photos.entries()) {
        const key = entries[index]?.key;
        try {
          const image = await upload(photo.mimeType, photo.data);
          setAttachments((current) =>
            current.map((item) => (item.key === key ? { ...item, uploading: false, image } : item)),
          );
        } catch (error) {
          onError(
            sendErrorKey(error) === 'error.computerOnly' ? 'error.computerOnly' : 'photo.failed',
          );
          setAttachments((current) => current.filter((item) => item.key !== key));
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
      adding.current = false;
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
    remove: (key) => setAttachments((current) => current.filter((a) => a.key !== key)),
    clear: () => setAttachments([]),
  };
}
