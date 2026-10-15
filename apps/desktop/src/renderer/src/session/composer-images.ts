// 输入框里的图片（0.28.0，照 Codex 桌面端、Claude Code 桌面端与 T3 Code）：粘贴、拖进来或从“+”菜单选的图片先传给
// Host（`image.upload`），发送时把 Host 给的引用放进 `content`。格式与大小的规则照 T3 Code 的 chatAttachment.ts 与
// composerAttachmentFiles.ts（MIT，ec1313c）重写：png、jpeg、gif、webp，每张不超过 10 MiB，类型为空时按扩展名认；一条消息
// 最多 `IMAGE_MAX_PER_MESSAGE` 张。这里是纯逻辑，组件在 image-attachments.tsx。

import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_PER_MESSAGE,
  type ProviderProfile,
  SUBSCRIPTION_KINDS,
  type UserContentPart,
  type UserImageMimeType,
  type UserImagePart,
} from '@wevir/protocol';

export const COMPOSER_IMAGE_TYPES: readonly UserImageMimeType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

/** 文件选择框的 `accept`。 */
export const COMPOSER_IMAGE_ACCEPT = COMPOSER_IMAGE_TYPES.join(',');

const BY_EXTENSION: Readonly<Record<string, UserImageMimeType>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** 文件是哪种能发的图片：先看类型，类型为空或是通用二进制时看扩展名（同 T3 的 inferImageMimeTypeFromName）。 */
export function imageMimeType(file: { name: string; type: string }): UserImageMimeType | undefined {
  const type = file.type.toLowerCase();
  if ((COMPOSER_IMAGE_TYPES as readonly string[]).includes(type)) return type as UserImageMimeType;
  if (type !== '' && type !== 'application/octet-stream') return undefined;
  const dot = file.name.lastIndexOf('.');
  return dot > 0 ? BY_EXTENSION[file.name.slice(dot + 1).toLowerCase()] : undefined;
}

export type ImageRejection = 'unsupported' | 'too_large' | 'limit';

export interface PickedImages<F> {
  accepted: Array<{ file: F; mimeType: UserImageMimeType }>;
  /** 第一个被拒的原因与文件名（只提示一条）。 */
  rejected?: { reason: ImageRejection; name: string };
}

/** 从粘贴、拖放或选择框的文件里挑能发的图片；已有 `existing` 张，超过上限的不要。 */
export function pickImages<F extends { name: string; type: string; size: number }>(
  files: readonly F[],
  existing: number,
): PickedImages<F> {
  const accepted: PickedImages<F>['accepted'] = [];
  let rejected: PickedImages<F>['rejected'];
  for (const file of files) {
    const mimeType = imageMimeType(file);
    const reason: ImageRejection | undefined =
      mimeType === undefined
        ? 'unsupported'
        : file.size > IMAGE_MAX_BYTES
          ? 'too_large'
          : existing + accepted.length >= IMAGE_MAX_PER_MESSAGE
            ? 'limit'
            : undefined;
    if (reason === undefined && mimeType !== undefined) accepted.push({ file, mimeType });
    else rejected ??= { reason: reason ?? 'unsupported', name: file.name };
  }
  return rejected === undefined ? { accepted } : { accepted, rejected };
}

/** 拖进来的东西里有没有文件（拖动过程中读不到文件本身，只看类型）。 */
export function dragHasFiles(types: readonly string[]): boolean {
  return types.includes('Files');
}

/** 发出去的内容：有字时先是文本，之后是图片。 */
export function messageContent(
  text: string,
  images: readonly UserImagePart[] = [],
): UserContentPart[] {
  return [...(text === '' ? [] : [{ type: 'text' as const, text }]), ...images];
}

/** `data:<类型>;base64,<数据>` 里的数据。 */
export function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma < 0 ? '' : dataUrl.slice(comma + 1);
}

/** 输入框里的一张图片：先在本地显示，传完后有 Host 给的 `part`。 */
export interface ComposerImage {
  /** 本地的 key（还没传完时没有 `imageId`）。 */
  key: string;
  name?: string;
  dataUrl: string;
  part?: UserImagePart;
}

/** 内容里的图片。 */
export function imagesOf(content: readonly UserContentPart[]): UserImagePart[] {
  return content.flatMap((part) => (part.type === 'image' ? [part] : []));
}

/**
 * 这个模型能不能发图片（界面只看模型列表，Host 发送时再按引擎核对）：标了 `supportsImages` 的看它；没标的，订阅来源
 * （Claude、Cursor、OpenCode、Grok、Antigravity，由引擎自己判断）算能，经网关的 Provider 不算（Codex 只给标了的模型
 * 开图片输入）。
 */
export function modelAcceptsImages(
  provider: ProviderProfile | undefined,
  modelId: string,
): boolean {
  if (provider === undefined) return false;
  const model = provider.models.find((candidate) => candidate.id === modelId);
  if (model?.supportsImages !== undefined) return model.supportsImages;
  return (SUBSCRIPTION_KINDS as readonly string[]).includes(provider.kind);
}
