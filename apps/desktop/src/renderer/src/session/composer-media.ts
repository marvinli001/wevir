import type { WevirClient } from '@wevir/client-sdk';
import {
  FILE_MAX_BYTES,
  IMAGE_MAX_EDGE,
  IMAGE_MAX_PER_MESSAGE,
  IMAGE_SEND_MAX_BYTES,
  type UserImageMimeType,
} from '@wevir/protocol';
import { t } from '@/i18n';
import { type DraftAttachment, draftFor, draftIssue } from './composer-drafts';
import {
  base64Of,
  type ComposerAttachmentPart,
  imageMimeType,
  type SourceImageType,
} from './composer-images';
import { readAsDataUrl, readImage, uploadImage } from './image-attachments';
import { readAttachedFile } from './message-files';

export function fittedSize(width: number, height: number, longest: number) {
  const scale = Math.min(1, longest / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
async function decode(file: Blob, mime: SourceImageType) {
  try {
    return await createImageBitmap(file);
  } catch (error) {
    if (mime !== 'image/heic' && mime !== 'image/heif') throw error;
    const { heicTo } = await import('heic-to/csp');
    return heicTo({ blob: file, type: 'bitmap' });
  }
}
function scaled(bitmap: ImageBitmap, longest: number) {
  const size = fittedSize(bitmap.width, bitmap.height, longest);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error(t('composer.imageDecodeFailed'));
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  return canvas;
}
export async function prepareImage(
  file: Blob,
  sourceType: SourceImageType,
  name?: string,
): Promise<DraftAttachment> {
  const bitmap = await decode(file, sourceType).catch(() => {
    throw new Error(t('composer.imageDecodeFailed'));
  });
  try {
    const thumb = scaled(bitmap, 112);
    const thumbnail = thumb.toDataURL('image/webp', 0.7);
    const heic = sourceType === 'image/heic' || sourceType === 'image/heif';
    let blob = file;
    let mime = sourceType;
    if (
      heic ||
      Math.max(bitmap.width, bitmap.height) > IMAGE_MAX_EDGE ||
      file.size > IMAGE_SEND_MAX_BYTES
    ) {
      mime = heic || sourceType === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
      const canvas = scaled(bitmap, IMAGE_MAX_EDGE);
      try {
        for (const quality of [0.86, 0.72, 0.5]) {
          blob = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
              (value) =>
                value ? resolve(value) : reject(new Error(t('composer.imageDecodeFailed'))),
              mime,
              quality,
            ),
          );
          if (blob.size <= IMAGE_SEND_MAX_BYTES) break;
        }
      } finally {
        canvas.width = canvas.height = 1;
      }
    }
    if (blob.size > IMAGE_SEND_MAX_BYTES)
      throw new Error(
        t('composer.imageOutputLimit', { count: IMAGE_SEND_MAX_BYTES / 1024 / 1024 }),
      );
    if (blob.type !== mime) blob = blob.slice(0, blob.size, mime);
    const filename =
      name &&
      (mime === sourceType
        ? name
        : name.replace(/(?:\.[^.]+)?$/, mime === 'image/jpeg' ? '.jpg' : '.webp'));
    return {
      key: crypto.randomUUID(),
      kind: 'image',
      blob,
      size: blob.size,
      thumbnail,
      ...(filename && { name: filename }),
    };
  } finally {
    bitmap.close();
  }
}

const uploading = new WeakMap<
  DraftAttachment,
  { client: WevirClient; at: number; part: Promise<ComposerAttachmentPart> }
>();
export function uploadAttachment(
  client: WevirClient,
  item: DraftAttachment,
): Promise<ComposerAttachmentPart> {
  if (item.part && !item.blob) return Promise.resolve(item.part);
  const cached = uploading.get(item);
  // 未发送的上传会在 Host 上过期；草稿和历史始终保留可重传的 Blob。
  if (cached && cached.client === client && Date.now() - cached.at < 12 * 60 * 60 * 1000)
    return cached.part;
  const part = (async () => {
    if (!item.blob)
      throw new Error(t('composer.fileUnavailable', { name: item.name ?? t('image.preview') }));
    const data = await readAsDataUrl(item.blob);
    if (item.kind === 'image')
      return uploadImage(client, data, item.blob.type as UserImageMimeType, item.name);
    const result = await client.request('file.upload', {
      data: base64Of(data),
      name: item.name ?? t('composer.uploadFiles'),
      ...(item.blob.type && { mimeType: item.blob.type }),
    });
    return result.file;
  })();
  uploading.set(item, { client, at: Date.now(), part });
  void part.catch(() => uploading.delete(item));
  return part;
}

export async function uploadDraft(
  client: WevirClient | undefined,
  attachments: readonly DraftAttachment[],
) {
  const result: ComposerAttachmentPart[] = [];
  if (!client && attachments.length) throw new Error(t('composer.uploadUnavailable'));
  if (client)
    for (const item of attachments) {
      try {
        result.push(await uploadAttachment(client, item));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(item.name ? `${item.name} · ${detail}` : detail, { cause: error });
      }
    }
  return result;
}

type DraftStore = ReturnType<typeof draftFor>;
// 已有消息恢复进草稿时只有 Host 引用。趁引用可读补存本地副本，之后可以重新上传。
const backupJobs = new WeakMap<DraftStore, Promise<void>>();
const attempted = new WeakMap<DraftAttachment, WevirClient>();
export function backUpRestoredFiles(
  store: DraftStore,
  client: WevirClient,
  onError: (message: string) => void,
) {
  const running = backupJobs.get(store);
  if (running) return running;
  const job = (async () => {
    await store.loaded;
    while (true) {
      const item = store
        .get()
        .draft.attachments.find((a) => a.part && !a.blob && attempted.get(a) !== client);
      if (!item?.part) return;
      attempted.set(item, client);
      try {
        let saved: DraftAttachment;
        if (item.part.type === 'image') {
          const url = await readImage(client, item.part);
          const bytes = Uint8Array.from(atob(base64Of(url)), (ch) => ch.charCodeAt(0));
          saved = await prepareImage(
            new Blob([bytes], { type: item.part.mimeType }),
            item.part.mimeType,
            item.part.name,
          );
        } else {
          const data = await readAttachedFile(client, item.part);
          saved = { ...item, blob: data.slice(0, data.size, item.part.mimeType ?? '') };
        }
        store.edit((d) => ({
          ...d,
          attachments: d.attachments.map((a) => (a === item ? { ...saved, key: item.key } : a)),
        }));
      } catch {
        onError(t('composer.fileUnavailable', { name: item.name ?? t('image.preview') }));
      }
    }
  })().finally(() => backupJobs.delete(store));
  backupJobs.set(store, job);
  return job;
}

const preparing = new WeakMap<DraftStore, Promise<void>>();

export function resumeComposerImages(store: DraftStore) {
  const running = preparing.get(store);
  if (running) return running;
  const job = (async () => {
    await store.loaded;
    while (true) {
      const item = store.get().draft.attachments.find((a) => a.sourceType && !a.failure);
      if (!item?.blob || !item.sourceType) return;
      try {
        const normalized = await prepareImage(item.blob, item.sourceType, item.name);
        const current = store.get().draft;
        if (!current.attachments.includes(item)) continue;
        const attachments = current.attachments.map((a) =>
          a === item ? { ...normalized, key: item.key } : a,
        );
        const issue = draftIssue({ ...current, text: '', pastes: [], attachments });
        if (issue) throw new Error(issue);
        store.edit((d) => ({ ...d, attachments }));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const failure = item.name ? `${item.name} · ${detail}` : detail;
        store.edit((d) => ({
          ...d,
          attachments: d.attachments.map((a) => (a === item ? { ...item, failure } : a)),
        }));
      }
    }
  })().finally(() => preparing.delete(store));
  preparing.set(store, job);
  return job;
}

// 源图先以 Blob 进入草稿。选择百张时按顺序解码，应用在转换期间重启也能接着处理。
export async function addComposerFiles(
  key: string,
  files: readonly File[],
  options: { images: boolean; files: boolean; named: boolean },
  onError: (message: string) => void,
) {
  const store = draftFor(key);
  await store.loaded;
  const current = store.get().draft;
  const attachments = [...current.attachments];
  for (const file of files) {
    if (attachments.length >= IMAGE_MAX_PER_MESSAGE) {
      onError(t('composer.attachmentLimit', { count: IMAGE_MAX_PER_MESSAGE }));
      break;
    }
    const mime = imageMimeType(file);
    let item: DraftAttachment;
    if (mime && options.images) {
      const name =
        options.named || !/^image\.(png|jpe?g|webp|gif)$/i.test(file.name) ? file.name : undefined;
      item = {
        key: crypto.randomUUID(),
        kind: 'image',
        size: file.size,
        blob: file,
        sourceType: mime,
        ...(name && { name }),
      };
    } else if (mime || !options.files) {
      onError(
        mime ? t('composer.modelNoImages') : t('composer.fileUnsupported', { name: file.name }),
      );
      continue;
    } else if (file.size > FILE_MAX_BYTES) {
      onError(t('composer.fileLimit', { name: file.name, count: FILE_MAX_BYTES / 1024 / 1024 }));
      continue;
    } else {
      item = {
        key: crypto.randomUUID(),
        kind: 'file',
        size: file.size,
        blob: file,
        name: file.name.slice(0, 255),
      };
    }
    const issue = draftIssue({ text: '', pastes: [], attachments: [...attachments, item] });
    if (issue) {
      onError(issue);
      continue;
    }
    attachments.push(item);
  }
  store.edit((d) => ({ ...d, attachments }));
  await resumeComposerImages(store);
}
