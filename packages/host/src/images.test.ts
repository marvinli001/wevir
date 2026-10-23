// 消息里的图片（0.28.0）：文件头、ImageStore，以及经方法表对着 EchoAdapter 发带图片的消息。

import { existsSync, mkdirSync, readdirSync, realpathSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import {
  IMAGE_MAX_PER_MESSAGE,
  IMAGE_READ_CHUNK_BYTES,
  type SessionId,
  type UserContentPart,
  type UserImagePart,
} from '@wevir/protocol';
import { ECHO_IMAGE_SIZE, EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from './event-store.js';
import { createHostMethods } from './host-methods.js';
import { ImageStore, STAGED_IMAGE_TTL_MS, sniffImage } from './images.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();

/** 只有文件头的 PNG（签名 + IHDR），后面补到 `size` 字节。 */
function png(width: number, height: number, size = 33): Buffer {
  const bytes = Buffer.alloc(Math.max(size, 33));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function gif(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(13);
  bytes.write('GIF89a', 0, 'latin1');
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

/** SOI、一个 APP0 段、SOF0。 */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function webp(chunk: 'VP8 ' | 'VP8L' | 'VP8X', width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'latin1');
  bytes.write('WEBP', 8, 'latin1');
  bytes.write(chunk, 12, 'latin1');
  if (chunk === 'VP8 ') {
    bytes.set([0x9d, 0x01, 0x2a], 23);
    bytes.writeUInt16LE(width, 26);
    bytes.writeUInt16LE(height, 28);
  } else if (chunk === 'VP8L') {
    bytes[20] = 0x2f;
    const w = width - 1;
    const h = height - 1;
    bytes[21] = w & 0xff;
    bytes[22] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6);
    bytes[23] = (h >> 2) & 0xff;
    bytes[24] = (h >> 10) & 0x0f;
  } else {
    bytes.writeUIntLE(width - 1, 24, 3);
    bytes.writeUIntLE(height - 1, 27, 3);
  }
  return bytes;
}

describe('sniffImage', () => {
  it('认出四种格式并读出像素', () => {
    expect(sniffImage(png(1280, 800))).toEqual({ mimeType: 'image/png', width: 1280, height: 800 });
    expect(sniffImage(gif(16, 9))).toEqual({ mimeType: 'image/gif', width: 16, height: 9 });
    expect(sniffImage(jpeg(640, 480))).toEqual({ mimeType: 'image/jpeg', width: 640, height: 480 });
    expect(sniffImage(webp('VP8 ', 300, 200))).toEqual({
      mimeType: 'image/webp',
      width: 300,
      height: 200,
    });
    expect(sniffImage(webp('VP8L', 1000, 3000))).toEqual({
      mimeType: 'image/webp',
      width: 1000,
      height: 3000,
    });
    expect(sniffImage(webp('VP8X', 4096, 2160))).toEqual({
      mimeType: 'image/webp',
      width: 4096,
      height: 2160,
    });
  });

  it('读不出像素时只有格式；别的格式认不出', () => {
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toEqual({ mimeType: 'image/jpeg' });
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
    expect(sniffImage(Buffer.from('BM\0\0\0\0'))).toBeUndefined();
    expect(sniffImage(Buffer.alloc(0))).toBeUndefined();
  });
});

describe('ImageStore', () => {
  function store(now?: () => number) {
    const dir = join(realpathSync(tempDir()), 'images');
    return { dir, images: new ImageStore({ dir, ...(now && { now }) }) };
  }

  it('上传写进 staged/，格式以文件头为准；keep 之后挪到 images/', async () => {
    const { dir, images } = store();
    const part = await images.upload({
      mimeType: 'image/jpeg',
      data: png(2, 3).toString('base64'),
      name: 'shot.jpg',
    });
    expect(part).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      size: 33,
      width: 2,
      height: 3,
      name: 'shot.jpg',
    });
    expect(part.imageId).toMatch(/^img_/);
    expect(readdirSync(join(dir, 'staged')).sort()).toEqual(
      [`${part.imageId}.json`, `${part.imageId}.png`].sort(),
    );

    // 客户端给的元数据不作数。
    const forged: UserImagePart = { ...part, size: 1, name: 'other.png' };
    const kept = await images.keep([{ type: 'text', text: 'look' }, forged]);
    expect(kept).toEqual([{ type: 'text', text: 'look' }, part]);
    expect(existsSync(join(dir, `${part.imageId}.png`))).toBe(true);
    expect(existsSync(join(dir, 'staged', `${part.imageId}.png`))).toBe(false);
    // 同一张图片再发一次照样可以。
    expect(await images.keep([part])).toEqual([part]);
    expect(await images.path(part.imageId)).toBe(join(dir, `${part.imageId}.png`));
  });

  it('拒绝不是 base64 的、认不出格式的；没有的图片回 IMAGE_NOT_FOUND', async () => {
    const { images } = store();
    await expect(
      images.upload({ mimeType: 'image/png', data: 'not base64!' }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      images.upload({ mimeType: 'image/png', data: Buffer.from('GIF7').toString('base64') }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    const missing = 'img_01JA2B3C4D5E6F7G8H9JKMNPQR' as const;
    await expect(images.read({ imageId: missing })).rejects.toMatchObject({
      code: 'IMAGE_NOT_FOUND',
    });
    await expect(
      images.keep([{ type: 'image', imageId: missing, mimeType: 'image/png', size: 1 }]),
    ).rejects.toMatchObject({ code: 'IMAGE_NOT_FOUND' });
  });

  it('工具产出的图片直接写进 images/；认不出的、不是 base64 的不存', async () => {
    const { dir, images } = store();
    const part = images.saveToolImage(png(1024, 768, 2000).toString('base64'));
    expect(part).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      size: 2000,
      width: 1024,
      height: 768,
    });
    if (part === undefined) throw new Error('expected an image');
    expect(readdirSync(dir).sort()).toEqual([`${part.imageId}.json`, `${part.imageId}.png`].sort());
    expect((await images.read({ imageId: part.imageId })).size).toBe(2000);
    expect(images.saveToolImage('not base64!')).toBeUndefined();
    expect(images.saveToolImage(Buffer.from('plain text').toString('base64'))).toBeUndefined();
    expect(images.saveToolImage('')).toBeUndefined();
  });

  it('image.read 分段读，offset 越界回 INVALID_PARAMS', async () => {
    const { images } = store();
    const bytes = png(10, 10, IMAGE_READ_CHUNK_BYTES + 1000);
    const part = await images.upload({ mimeType: 'image/png', data: bytes.toString('base64') });
    const first = await images.read({ imageId: part.imageId });
    expect(first).toMatchObject({ mimeType: 'image/png', size: bytes.length, offset: 0 });
    expect(Buffer.from(first.data, 'base64').length).toBe(IMAGE_READ_CHUNK_BYTES);
    const rest = await images.read({ imageId: part.imageId, offset: IMAGE_READ_CHUNK_BYTES });
    const all = Buffer.concat([
      Buffer.from(first.data, 'base64'),
      Buffer.from(rest.data, 'base64'),
    ]);
    expect(all.equals(bytes)).toBe(true);
    await expect(
      images.read({ imageId: part.imageId, offset: bytes.length }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('清理只删 staged/ 里放了超过一天的', async () => {
    let now = Date.now();
    const { dir, images } = store(() => now);
    const old = await images.upload({ mimeType: 'image/png', data: png(1, 1).toString('base64') });
    const sent = await images.upload({ mimeType: 'image/png', data: png(1, 1).toString('base64') });
    await images.keep([sent]);
    const fresh = await images.upload({
      mimeType: 'image/png',
      data: png(1, 1).toString('base64'),
    });
    const past = (now - STAGED_IMAGE_TTL_MS - 1000) / 1000;
    for (const name of [`${old.imageId}.png`, `${old.imageId}.json`]) {
      utimesSync(join(dir, 'staged', name), past, past);
    }
    now += 120_000;
    await images.sweep();
    expect(await images.path(old.imageId)).toBeUndefined();
    expect(await images.path(fresh.imageId)).toBeDefined();
    expect(await images.path(sent.imageId)).toBeDefined();
  });
});

describe('带图片的消息', () => {
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  });

  function setup(adapter: EchoAdapter = new EchoAdapter({ stepDelayMs: 0 }), name = 'host') {
    const root = join(realpathSync(tempDir()), name);
    mkdirSync(root);
    const storage = storages.open(join(root, 'data'));
    const workspaceDir = join(root, 'ws');
    mkdirSync(workspaceDir);
    const T0 = '2026-10-15T00:00:00.000Z';
    storage.workspaces.insert({
      id: 'ws_1',
      rootPath: workspaceDir,
      displayName: 'ws',
      createdAt: T0,
      updatedAt: T0,
    });
    storage.providers.insert({
      id: 'mock',
      kind: 'openai-compatible',
      displayName: 'Mock',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:9/v1',
      models: [{ id: 'm' }, { id: 'text-only', supportsImages: false }],
      defaultModelId: 'm',
      createdAt: T0,
      updatedAt: T0,
    });
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const images = new ImageStore({ dir: join(root, 'data', 'images') });
    const manager = new SessionManager({ storage, events, adapter, images });
    managers.push(manager);
    const methods = createHostMethods({
      storage,
      events,
      sessions: manager,
      secrets: new FileSecretStore(join(root, 'data')),
      images,
    });
    return { storage, events, manager, methods };
  }
  const context = { client: identity, capabilities: {} };

  async function upload(env: ReturnType<typeof setup>, name?: string): Promise<UserImagePart> {
    const { image } = await env.methods['image.upload'](
      { mimeType: 'image/png', data: png(4, 2).toString('base64'), ...(name && { name }) },
      context,
    );
    return image;
  }

  it('发出去：user.message 带 Host 记下的图片，引擎收到文件', async () => {
    const env = setup();
    const session = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = session.id as SessionId;
    const image = await upload(env, 'chart.png');
    const content: UserContentPart[] = [{ type: 'text', text: '看这张图' }, image];
    await env.methods['session.send']({ sessionId, content, clientMessageId: 'msg-1' }, context);
    await vi.waitFor(() => expect(env.events.snapshot(sessionId)?.session.state).toBe('idle'));
    const all = env.events.readSince(sessionId, 0, 1000);
    const message = all.find((event) => event.type === 'user.message');
    expect(message?.payload).toMatchObject({ content });
    const reply = all.find((event) => event.type === 'assistant.message');
    expect(reply?.payload).toMatchObject({ text: 'Echo: 看这张图\n[image: chart.png]' });
    // 标题只用文字。
    expect(env.events.snapshot(sessionId)?.session.title).toBe('看这张图');

    // 只有图片也可以；重发同一个 clientMessageId 返回原结果。
    const again = await env.methods['session.send'](
      { sessionId, content, clientMessageId: 'msg-1' },
      context,
    );
    expect(again.seq).toBe(message?.seq);
    await env.methods['session.send']({ sessionId, content: [image] }, context);
    await vi.waitFor(() =>
      expect(
        env.events
          .readSince(sessionId, 0, 1000)
          .filter((event) => event.type === 'assistant.message')
          .at(-1)?.payload,
      ).toMatchObject({ text: 'Echo: [image: chart.png]' }),
    );
  });

  it('模型不收图片、引擎不收图片、超过张数、图片不存在：都不写事件', async () => {
    const env = setup();
    const session = await env.manager.create({
      workspaceId: 'ws_1',
      providerId: 'mock',
      modelId: 'text-only',
    });
    const sessionId = session.id as SessionId;
    const image = await upload(env);
    const before = env.events.snapshot(sessionId)?.session.lastSeq;
    await expect(
      env.methods['session.send']({ sessionId, content: [image] }, context),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });

    await env.manager.configure({ sessionId, modelId: 'm' });
    const many = Array.from({ length: IMAGE_MAX_PER_MESSAGE + 1 }, () => image);
    await expect(
      env.methods['session.send']({ sessionId, content: many }, context),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      env.methods['session.send'](
        { sessionId, content: [{ ...image, imageId: 'img_01JA2B3C4D5E6F7G8H9JKMNPQR' }] },
        context,
      ),
    ).rejects.toMatchObject({ code: 'IMAGE_NOT_FOUND' });
    const types = env.events
      .readSince(sessionId, before ?? 0, 1000)
      .map((event) => event.type)
      .filter((type) => type === 'user.message');
    expect(types).toEqual([]);

    // 引擎不收图片（没有 acceptsImages）。
    const textOnly = new EchoAdapter({ stepDelayMs: 0 });
    Object.defineProperty(textOnly, 'acceptsImages', { value: undefined });
    const plain = setup(textOnly, 'text-only');
    const other = await plain.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const otherImage = await upload(plain);
    await expect(
      plain.methods['session.send'](
        { sessionId: other.id as SessionId, content: [otherImage] },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('生成的图片（0.118.0）：tool.finished 带 Host 存下的图片，image.read 读得回', async () => {
    const env = setup();
    const session = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = session.id as SessionId;
    await env.methods['session.send'](
      { sessionId, content: [{ type: 'text', text: 'imagine a fox' }] },
      context,
    );
    await vi.waitFor(() => expect(env.events.snapshot(sessionId)?.session.state).toBe('idle'));
    const all = env.events.readSince(sessionId, 0, 1000);
    const started = all.find((event) => event.type === 'tool.started');
    expect(started?.payload).toMatchObject({
      toolName: 'imageGeneration',
      display: { kind: 'image' },
    });
    const finished = all.find((event) => event.type === 'tool.finished');
    if (finished?.type !== 'tool.finished') throw new Error('expected tool.finished');
    expect(finished.payload.status).toBe('completed');
    const [image] = finished.payload.images ?? [];
    expect(image).toMatchObject({
      mimeType: 'image/png',
      width: ECHO_IMAGE_SIZE,
      height: ECHO_IMAGE_SIZE,
    });
    if (image === undefined) throw new Error('expected an image');
    const read = await env.methods['image.read']({ imageId: image.imageId }, context);
    expect(Buffer.from(read.data, 'base64').subarray(0, 4).toString('latin1')).toBe('\x89PNG');
    // 会话的占用把它算进去（删会话时一起删）。
    expect(env.storage.events.imageRefs().get(image.imageId)).toEqual(new Set([sessionId]));
  });

  it('排队的消息改内容时可以换图片', async () => {
    const env = setup();
    const session = await env.manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    const sessionId = session.id as SessionId;
    await env.methods['session.send'](
      { sessionId, content: [{ type: 'text', text: 'slow' }] },
      context,
    );
    const image = await upload(env, 'a.png');
    const { pendingId } = await env.methods['session.send'](
      { sessionId, content: [{ type: 'text', text: 'next' }], delivery: 'queue' },
      context,
    );
    if (pendingId === undefined) throw new Error('expected a pending message');
    const { pending } = await env.methods['pending.update'](
      { sessionId, pendingId, content: [{ type: 'text', text: 'next' }, image] },
      context,
    );
    expect(pending.content).toEqual([{ type: 'text', text: 'next' }, image]);
    await vi.waitFor(() =>
      expect(
        env.events
          .readSince(sessionId, 0, 1000)
          .filter((event) => event.type === 'assistant.message')
          .at(-1)?.payload,
      ).toMatchObject({ text: 'Echo: next\n[image: a.png]' }),
    );
  });
});
