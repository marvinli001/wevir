import type { HostHello, WevirClient } from '@wevir/client-sdk';
import {
  type ImageId,
  PERMISSIONS,
  PROTOCOL_VERSION,
  type ProviderProfile,
  type UserImagePart,
} from '@wevir/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkbenchProviders } from '@/data/workbench-data';
import { type HostConnection, useHostConnection } from '@/host/host-connection';
import { splitFiles } from './composer-images';
import { readImage, useAcceptsImages } from './image-attachments';

vi.mock('@/data/workbench-data', () => ({ useWorkbenchProviders: vi.fn() }));
vi.mock('@/host/host-connection', () => ({ useHostConnection: vi.fn() }));

const provider: ProviderProfile = {
  id: 'vision',
  kind: 'openai-compatible',
  displayName: 'Vision',
  models: [
    { id: 'vision', supportsImages: true },
    { id: 'text', supportsImages: false },
  ],
  defaultModelId: 'vision',
  hasSecret: true,
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
};
const choice = { providerId: provider.id, modelId: provider.defaultModelId };
let connection: HostConnection;
let hello: HostHello;

beforeEach(() => {
  hello = {
    hostId: 'hst_01JA2B3C4D5E6F7G8H9JKMNPQR',
    hostVersion: '0.0.0',
    protocolVersion: PROTOCOL_VERSION,
    minProtocolVersion: '0.1.0',
    features: { user_images: true },
    permissions: [...PERMISSIONS],
  };
  connection = {
    view: { status: 'connected', hello },
    client: {
      get hello() {
        return hello;
      },
    } as WevirClient,
    identity: undefined,
    hostStatus: undefined,
    retry: vi.fn(),
  };
  vi.mocked(useHostConnection).mockImplementation(() => connection);
  vi.mocked(useWorkbenchProviders).mockReturnValue([provider]);
});

function acceptedFiles(selected: typeof choice | undefined = choice) {
  const screenshot = new File(['screenshot'], 'image.png', { type: 'image/png' });
  let images: File[] = [];
  function Probe() {
    images = splitFiles([screenshot], useAcceptsImages(selected)).images;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return images;
}

describe('输入框图片能力', () => {
  it('共享正在读取的图片，按 data URL 字节预算淘汰缓存', async () => {
    const data = 'A'.repeat(4 * 1024 * 1024);
    const request = vi.fn(async () => ({ mimeType: 'image/png', size: 3 * 1024 * 1024, data }));
    const client = { request } as unknown as WevirClient;
    const part = (id: string): UserImagePart => ({
      type: 'image',
      imageId: id as ImageId,
      mimeType: 'image/png',
      size: 3 * 1024 * 1024,
    });
    const first = readImage(client, part('img_budget1'));
    expect(readImage(client, part('img_budget1'))).toBe(first);
    await first;
    const second = readImage(client, part('img_budget2'));
    await second;
    expect(readImage(client, part('img_budget2'))).toBe(second);
    await readImage(client, part('img_budget1'));
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('短暂重连期间粘贴的 PNG 截图仍走图片上传', () => {
    expect(acceptedFiles()).toHaveLength(1);
    connection.view = { status: 'reconnecting', attempt: 1 };
    expect(acceptedFiles()).toHaveLength(1);
    connection.view = { status: 'connected', hello };
    expect(acceptedFiles()).toHaveLength(1);
  });

  it('首次连接之前不启用图片，明确不支持图片的模型仍拒绝', () => {
    expect(acceptedFiles({ ...choice, modelId: 'text' })).toEqual([]);
    connection.view = { status: 'connecting' };
    connection.client = undefined;
    expect(acceptedFiles()).toEqual([]);
  });

  it('重连后采用新的 Host 图片能力', () => {
    hello = { ...hello, features: {} };
    connection.view = { status: 'connected', hello };
    expect(acceptedFiles()).toEqual([]);
  });
});
