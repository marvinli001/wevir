// 附照片：从相册选或拍一张，长边缩到 `PHOTO_MAX_EDGE`、转 JPEG（去掉 EXIF，连同位置），得到 base64 交给 `image.upload`
// （隧道里走，不用 `fetch`）。缩放的尺寸是纯逻辑（photo-size.ts），选取与压缩用 expo-image-picker / expo-image-manipulator。

import { IMAGE_MAX_BYTES } from '@wevir/protocol';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { base64Bytes, fitWithin, JPEG_QUALITY } from './photo-size';

export { PHOTOS_PER_MESSAGE } from './photo-size';

export interface PickedPhoto {
  /** 本机文件（缩略图用）。 */
  uri: string;
  mimeType: 'image/jpeg';
  /** JPEG 的 base64。 */
  data: string;
}

export type PhotoSource = 'library' | 'camera';

export class PhotoPermissionError extends Error {
  override readonly name = 'PhotoPermissionError';
}

export class PhotoTooLargeError extends Error {
  override readonly name = 'PhotoTooLargeError';
}

/** 选或拍照片；取消时返回空数组。相册一次可选多张（不超过 `limit`）。 */
export async function pickPhotos(source: PhotoSource, limit: number): Promise<PickedPhoto[]> {
  if (limit <= 0) return [];
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    quality: 1,
    exif: false,
    allowsMultipleSelection: source === 'library' && limit > 1,
    selectionLimit: limit,
  };
  let result: ImagePicker.ImagePickerResult;
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new PhotoPermissionError('camera permission denied');
    result = await ImagePicker.launchCameraAsync(options);
  } else {
    result = await ImagePicker.launchImageLibraryAsync(options);
  }
  if (result.canceled) return [];
  const photos: PickedPhoto[] = [];
  for (const asset of result.assets.slice(0, limit)) photos.push(await compress(asset));
  return photos;
}

async function compress(asset: ImagePicker.ImagePickerAsset): Promise<PickedPhoto> {
  const size = fitWithin(asset.width, asset.height);
  const context = ImageManipulator.manipulate(asset.uri);
  if (size.width !== asset.width || size.height !== asset.height) context.resize(size);
  const image = await context.renderAsync();
  const saved = await image.saveAsync({
    format: SaveFormat.JPEG,
    compress: JPEG_QUALITY,
    base64: true,
  });
  const data = saved.base64 ?? '';
  if (data === '' || base64Bytes(data) > IMAGE_MAX_BYTES)
    throw new PhotoTooLargeError('photo too large');
  return { uri: saved.uri, mimeType: 'image/jpeg', data };
}
