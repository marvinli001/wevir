import {
  type ProviderProfile,
  SUBSCRIPTION_KINDS,
  type UserContentPart,
  type UserFilePart,
  type UserImageMimeType,
  type UserImagePart,
} from '@wevir/protocol';
import { textParts } from './composer-pastes';

export const COMPOSER_IMAGE_TYPES: readonly UserImageMimeType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

export type ComposerAttachmentPart = UserImagePart | UserFilePart;
export type SourceImageType = UserImageMimeType | 'image/heic' | 'image/heif';
const SOURCE_TYPES: readonly SourceImageType[] = [
  ...COMPOSER_IMAGE_TYPES,
  'image/heic',
  'image/heif',
];
export const COMPOSER_IMAGE_ACCEPT = [...SOURCE_TYPES, '.heic', '.heif'].join(',');

const BY_EXTENSION: Readonly<Record<string, SourceImageType>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

export function imageMimeType(file: { name: string; type: string }): SourceImageType | undefined {
  const type = file.type.toLowerCase();
  if ((SOURCE_TYPES as readonly string[]).includes(type)) return type as SourceImageType;
  if (type !== '' && type !== 'application/octet-stream') return undefined;
  const dot = file.name.lastIndexOf('.');
  return dot > 0 ? BY_EXTENSION[file.name.slice(dot + 1).toLowerCase()] : undefined;
}

export function splitFiles<F extends { name: string; type: string }>(
  files: readonly F[],
  imagesEnabled: boolean,
) {
  const images: F[] = [],
    others: F[] = [];
  for (const file of files) (imagesEnabled && imageMimeType(file) ? images : others).push(file);
  return { images, others };
}

/** 拖进来的东西里有没有文件（拖动过程中读不到文件本身，只看类型）。 */
export function dragHasFiles(types: readonly string[]): boolean {
  return types.includes('Files');
}

/** 发出去的内容：有字时先是文本（粘贴的大段各成一段，0.90.0），之后是图片。 */
export function messageContent(
  text: string,
  attachments: readonly ComposerAttachmentPart[] = [],
): UserContentPart[] {
  return [...textParts(text), ...attachments];
}

/** `data:<类型>;base64,<数据>` 里的数据。 */
export function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma < 0 ? '' : dataUrl.slice(comma + 1);
}

/** 内容里的图片。 */
export function imagesOf(content: readonly UserContentPart[]): UserImagePart[] {
  return content.flatMap((part) => (part.type === 'image' ? [part] : []));
}

/**
 * 这个模型能不能发图片（界面只看模型列表，Host 发送时再按引擎核对）：标了 `supportsImages` 的看它；没标的，订阅来源
 * （Claude、Cursor、OpenCode、Grok、Antigravity、WorkBuddy，由引擎自己判断）算能，经网关的 Provider 不算（Codex 只给标了的模型
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
