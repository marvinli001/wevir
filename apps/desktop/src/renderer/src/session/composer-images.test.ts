import type { ProviderProfile } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  base64Of,
  dragHasFiles,
  imageMimeType,
  imagesOf,
  messageContent,
  modelAcceptsImages,
  splitFiles,
} from './composer-images';

const file = (name: string, type: string, size = 100) => ({ name, type, size });
const image = {
  type: 'image' as const,
  imageId: 'img_01JA2B3C4D5E6F7G8H9JKMNPQR' as const,
  mimeType: 'image/png' as const,
  size: 100,
};

describe('imageMimeType', () => {
  it('看类型；类型为空或是通用二进制时看扩展名', () => {
    expect(imageMimeType(file('a.png', 'image/png'))).toBe('image/png');
    expect(imageMimeType(file('a', 'IMAGE/JPEG'))).toBe('image/jpeg');
    expect(imageMimeType(file('photo.JPG', ''))).toBe('image/jpeg');
    expect(imageMimeType(file('photo.HEIF', 'application/octet-stream'))).toBe('image/heif');
    expect(imageMimeType(file('photo', 'image/heic'))).toBe('image/heic');
    expect(imageMimeType(file('anim.gif', 'application/octet-stream'))).toBe('image/gif');
    expect(imageMimeType(file('icon.svg', 'image/svg+xml'))).toBeUndefined();
    expect(imageMimeType(file('notes.txt', ''))).toBeUndefined();
    // 类型明确不是图片时不看扩展名。
    expect(imageMimeType(file('fake.png', 'text/plain'))).toBeUndefined();
  });
});

describe('splitFiles', () => {
  const files = [
    file('shot.png', 'image/png'),
    file('key.pem', ''),
    file('notes.pdf', 'application/pdf'),
  ];

  it('能发图片时认得的图片走上传，其余的插入成提及', () => {
    const { images, others } = splitFiles(files, true);
    expect(images.map((f) => f.name)).toEqual(['shot.png']);
    expect(others.map((f) => f.name)).toEqual(['key.pem', 'notes.pdf']);
  });

  it('不能发图片时全部插入成提及', () => {
    expect(splitFiles(files, false)).toEqual({ images: [], others: files });
  });
});

describe('消息内容', () => {
  it('有字时文本在前，图片在后；只有图片时没有文本段', () => {
    expect(messageContent('看', [image])).toEqual([{ type: 'text', text: '看' }, image]);
    expect(messageContent('', [image])).toEqual([image]);
    expect(messageContent('只有字')).toEqual([{ type: 'text', text: '只有字' }]);
    expect(imagesOf([{ type: 'text', text: 'x' }, image])).toEqual([image]);
  });

  it('data URL 里的数据；拖进来的是不是文件', () => {
    expect(base64Of('data:image/png;base64,iVBORw0KGgo=')).toBe('iVBORw0KGgo=');
    expect(base64Of('nope')).toBe('');
    expect(dragHasFiles(['Files'])).toBe(true);
    expect(dragHasFiles(['text/plain'])).toBe(false);
  });
});

describe('modelAcceptsImages', () => {
  const T0 = '2026-10-15T00:00:00.000Z';
  const gateway: ProviderProfile = {
    id: 'mock',
    kind: 'openai-compatible',
    displayName: 'Mock',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:9/v1',
    models: [{ id: 'vision', supportsImages: true }, { id: 'plain' }],
    defaultModelId: 'vision',
    hasSecret: true,
    createdAt: T0,
    updatedAt: T0,
  };
  const claude: ProviderProfile = {
    id: 'claude',
    kind: 'claude',
    displayName: 'Claude',
    models: [{ id: 'opus' }, { id: 'old', supportsImages: false }],
    defaultModelId: 'opus',
    hasSecret: false,
    createdAt: T0,
    updatedAt: T0,
  };

  it('标了的看标的；没标的只有订阅来源算能', () => {
    expect(modelAcceptsImages(gateway, 'vision')).toBe(true);
    expect(modelAcceptsImages(gateway, 'plain')).toBe(false);
    expect(modelAcceptsImages(gateway, 'unknown')).toBe(false);
    expect(modelAcceptsImages(claude, 'opus')).toBe(true);
    expect(modelAcceptsImages(claude, 'old')).toBe(false);
    expect(modelAcceptsImages(undefined, 'opus')).toBe(false);
  });
});
