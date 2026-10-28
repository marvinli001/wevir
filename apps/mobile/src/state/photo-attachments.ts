// 输入栏上待发的照片（会话页与助理页共用）：从相册选或拍一张，压缩后传给 Host（`image.upload`），传好的带上图片部件。上传怎么做
// 由页面给（会话页要在 Android 选照片断线后换新连接再传）；出错时交给页面显示哪条提示。

import type { UserImageMimeType, UserImagePart } from '@wevir/protocol';
import { useState } from 'react';
import type { ComposerAttachment } from '../components/composer';
import type { SheetAction } from '../components/sheets';
import { type MessageKey, t } from '../i18n';
import {
  PHOTOS_PER_MESSAGE,
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
  showSheet,
  onError,
}: {
  upload: (mimeType: UserImageMimeType, data: string) => Promise<UserImagePart>;
  showSheet: (actions: readonly SheetAction[]) => void;
  /** 选或传失败（`undefined`：开始新的一次，清掉上一条）。 */
  onError: (key: MessageKey | undefined) => void;
}): {
  attachments: readonly PhotoAttachment[];
  /** 传好的图片部件，按添加的先后。 */
  images: readonly UserImagePart[];
  /** 弹出“相册 / 拍照”。 */
  choose: () => void;
  remove: (key: string) => void;
  clear: () => void;
} {
  const [attachments, setAttachments] = useState<PhotoAttachment[]>([]);

  const attach = async (source: PhotoSource) => {
    onError(undefined);
    let photos: Awaited<ReturnType<typeof pickPhotos>>;
    try {
      photos = await pickPhotos(source, PHOTOS_PER_MESSAGE - attachments.length);
    } catch (e) {
      onError(e instanceof PhotoPermissionError ? 'photo.cameraDenied' : 'photo.failed');
      return;
    }
    for (const photo of photos) {
      const key = `${photo.uri}:${Date.now()}`;
      setAttachments((current) => [...current, { key, uri: photo.uri, uploading: true }]);
      upload(photo.mimeType, photo.data).then(
        (image) =>
          setAttachments((current) =>
            current.map((a) => (a.key === key ? { ...a, uploading: false, image } : a)),
          ),
        (e: unknown) => {
          console.warn('[wevir] image upload failed', e);
          onError(sendErrorKey(e) === 'error.computerOnly' ? 'error.computerOnly' : 'photo.failed');
          setAttachments((current) => current.filter((a) => a.key !== key));
        },
      );
    }
  };

  return {
    attachments,
    images: attachments.flatMap((a) => (a.image !== undefined ? [a.image] : [])),
    choose: () =>
      showSheet([
        { label: t('photo.library'), onPress: () => void attach('library') },
        { label: t('photo.camera'), onPress: () => void attach('camera') },
      ]),
    remove: (key) => setAttachments((current) => current.filter((a) => a.key !== key)),
    clear: () => setAttachments([]),
  };
}
