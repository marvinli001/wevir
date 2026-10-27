// 附照片的尺寸与大小（纯逻辑，photos.ts 用）。

import { IMAGE_MAX_PER_MESSAGE } from '@wevir/protocol';

/** 长边上限：模型看图够用，经隧道的字节少。 */
export const PHOTO_MAX_EDGE = 2048;
export const JPEG_QUALITY = 0.8;

/** 一条消息里最多几张（Host 的上限）。 */
export const PHOTOS_PER_MESSAGE = IMAGE_MAX_PER_MESSAGE;

/** 缩到长边不超过 `max` 的尺寸；本来就小的不放大。 */
export function fitWithin(
  width: number,
  height: number,
  max: number = PHOTO_MAX_EDGE,
): { width: number; height: number } {
  const edge = Math.max(width, height);
  if (edge <= max || edge <= 0) return { width, height };
  const scale = max / edge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** base64 解码后的字节数。 */
export function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}
