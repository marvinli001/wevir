import { isUtf8 } from 'node:buffer';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import {
  FILE_MAX_BYTES,
  type FileId,
  FileIdSchema,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_EDGE,
  IMAGE_READ_CHUNK_BYTES,
  IMAGE_SEND_MAX_BYTES,
  type ImageId,
  ImageIdSchema,
  MESSAGE_ATTACHMENT_MAX_BYTES,
  type MethodParams,
  type MethodResult,
  messageContentIssue,
  type UserContentPart,
  type UserFilePart,
  UserFilePartSchema,
  type UserImageMimeType,
  type UserImagePart,
  UserImagePartSchema,
} from '@wevir/protocol';
import type { AgentFileInput } from '@wevir/runtime-adapter';
import { HostError } from './errors.js';
import { newId } from './ids.js';
import { pastedText } from './relay.js';

// 消息里的图片（0.28.0，host-api.md §3.1 `image.upload` / `image.read`）。`image.upload` 把字节写进数据目录的
// `images/staged/`，旁边一份 `<id>.json` 记下 Host 认定的 `UserImagePart`；消息被接受时（`session.send`、待发消息）挪到
// `images/`，之后一直留着（事件里引用它）。没有发出去的过一天删掉（Host 启动时与之后每次上传时顺带清理）。
// 格式按文件头认，不信扩展名与客户端给的类型；像素也从文件头读。

const EXTENSIONS: Record<UserImageMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** 工具产出的一张图片最大多少字节（gpt-image 的 4K PNG 也在这以内）。 */
export const TOOL_IMAGE_MAX_BYTES = 64 * 1024 * 1024;

/** 上传了没发出去的图片留多久。 */
export const STAGED_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface ImageStoreOptions {
  /** 数据目录里的 `images/`。 */
  dir: string;
  /** 测试用。 */
  now?: () => number;
}

type Attachment = UserImagePart | UserFilePart;
type AttachmentId = ImageId | FileId;
interface StoredAsset {
  part: Attachment;
  path: string;
}

export class ImageStore {
  readonly #dir: string;
  readonly #staged: string;
  readonly #now: () => number;
  #lastSweep = 0;

  constructor(options: ImageStoreOptions) {
    this.#dir = options.dir;
    this.#staged = join(options.dir, 'staged');
    this.#now = options.now ?? Date.now;
  }

  /** `image.upload`：解码、认格式、读像素，写进 `staged/`。 */
  async upload(params: MethodParams<'image.upload'>): Promise<UserImagePart> {
    const input = uploadBytes(params.data, IMAGE_MAX_BYTES);
    if (input.length === 0) throw invalid(['data'], 'image is empty');
    const header = sniffImage(input);
    if (!header) throw invalid(['data'], 'not a PNG, JPEG, GIF or WebP image');
    const { bytes, ...format } = await prepareImage(input, header);
    const part: UserImagePart = {
      type: 'image',
      imageId: newId('img'),
      ...format,
      size: bytes.length,
      ...(params.name !== undefined && { name: params.name }),
    };
    await this.#stage(part, bytes);
    return part;
  }

  async uploadFile(params: MethodParams<'file.upload'>): Promise<UserFilePart> {
    const bytes = uploadBytes(params.data, FILE_MAX_BYTES);
    const part: UserFilePart = {
      type: 'file',
      fileId: newId('file'),
      name: params.name,
      size: bytes.length,
      ...(params.mimeType !== undefined && { mimeType: params.mimeType }),
    };
    await this.#stage(part, bytes);
    return part;
  }

  async #stage(part: Attachment, bytes: Buffer): Promise<void> {
    await mkdir(this.#staged, { recursive: true, mode: 0o700 });
    await writeFile(join(this.#staged, fileName(part)), bytes, { mode: 0o600 });
    await writeFile(join(this.#staged, `${assetId(part)}.json`), JSON.stringify(part), {
      mode: 0o600,
    });
    void this.sweep().catch(() => {});
  }

  /**
   * 工具产出的图片（0.118.0，`tool.finished.images`）：认格式、读像素，直接写进 `images/`（事件引用它，不经过 `staged/`）。
   * Host 等写完后才处理 `tool.finished`。不是 base64、不是四种格式之一，或比
   * `TOOL_IMAGE_MAX_BYTES` 大时 `undefined`。
   */
  async saveToolImage(data: string): Promise<UserImagePart | undefined> {
    if (data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length === 0 || bytes.length > TOOL_IMAGE_MAX_BYTES) return undefined;
    const header = sniffImage(bytes);
    if (header === undefined) return undefined;
    const part: UserImagePart = {
      type: 'image',
      imageId: newId('img'),
      mimeType: header.mimeType,
      size: bytes.length,
      ...(header.width !== undefined && { width: header.width, height: header.height }),
    };
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    await writeFile(join(this.#dir, fileName(part)), bytes, { mode: 0o600 });
    await writeFile(join(this.#dir, `${part.imageId}.json`), JSON.stringify(part), { mode: 0o600 });
    return part;
  }

  /** `image.read`：从 `offset` 起最多 `IMAGE_READ_CHUNK_BYTES`。 */
  async read(params: MethodParams<'image.read'>): Promise<MethodResult<'image.read'>> {
    const image = await this.#find(params.imageId);
    if (image?.part.type !== 'image') throw notFound(params.imageId);
    return {
      imageId: image.part.imageId,
      mimeType: image.part.mimeType,
      ...(await this.#readChunk(image, params.offset ?? 0)),
    };
  }

  async readFile(params: MethodParams<'file.read'>): Promise<MethodResult<'file.read'>> {
    const file = await this.#find(params.fileId);
    if (file?.part.type !== 'file') throw notFound(params.fileId);
    return { fileId: file.part.fileId, ...(await this.#readChunk(file, params.offset ?? 0)) };
  }

  async engineFile(fileId: FileId, remainingText: number): Promise<AgentFileInput> {
    const file = await this.#find(fileId);
    if (file?.part.type !== 'file') throw notFound(fileId);
    if (file.part.size > FILE_MAX_BYTES)
      throw invalid(['content'], 'stored file exceeds upload limit');
    const { name, size } = file.part;
    const handle = await this.#openStored(file);
    let bytes: Buffer;
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const pdf = bytes.subarray(0, 5).toString('ascii') === '%PDF-';
    let decoded: string | undefined;
    if (
      !pdf &&
      isUtf8(bytes) &&
      bytes.every((byte) => byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte >= 32)
    ) {
      const preview = bytes.subarray(0, remainingText * 4);
      decoded = new TextDecoder().decode(preview, { stream: preview.length < size });
    }
    const mimeType = pdf
      ? 'application/pdf'
      : decoded !== undefined
        ? 'text/plain'
        : 'application/octet-stream';
    const clipped =
      decoded !== undefined && (decoded.length > remainingText || size > remainingText * 4);
    const text = `[Attached file ${JSON.stringify(name)}: ${JSON.stringify(file.path)}${clipped ? '; partial preview' : ''}]`;
    return {
      type: 'file',
      path: file.path,
      name,
      mimeType,
      text:
        decoded !== undefined && remainingText > 0
          ? `${text}\n${pastedText(decoded.slice(0, remainingText))}`
          : text,
    };
  }

  async #openStored(asset: StoredAsset) {
    const handle = await open(asset.path, 'r').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' || dirname(asset.path) !== this.#staged) throw error;
      // 并发发送可能已把已验证的文件挪出了暂存区。
      return open(join(this.#dir, fileName(asset.part)), 'r');
    });
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== asset.part.size)
        throw invalid(['content'], 'stored attachment size changed');
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async #readChunk(
    asset: StoredAsset,
    offset: number,
  ): Promise<{ size: number; offset: number; data: string }> {
    const size = asset.part.size;
    if (size === 0 && offset === 0) return { size, offset, data: '' };
    if (offset >= size) throw invalid(['offset'], `offset is past the end (${size} bytes)`);
    const handle = await this.#openStored(asset);
    try {
      const buffer = Buffer.alloc(Math.min(IMAGE_READ_CHUNK_BYTES, size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      return { size, offset, data: buffer.subarray(0, bytesRead).toString('base64') };
    } finally {
      await handle.close();
    }
  }

  /** 发给引擎的附件在磁盘上的路径；没有时 `undefined`。 */
  async path(imageId: AttachmentId): Promise<string | undefined> {
    return (await this.#find(imageId))?.path;
  }

  /**
   * 消息被接受之前：每张图片换成 Host 记下的（客户端给的元数据不作数），挪出 `staged/`。没有这张图片时回
   * `IMAGE_NOT_FOUND`；文本原样。
   */
  async keep(content: readonly UserContentPart[]): Promise<UserContentPart[]> {
    const issue = messageContentIssue(content, false);
    if (issue) throw invalid(['content'], issue);
    const kept: UserContentPart[] = [];
    const staged = new Map<AttachmentId, Attachment>();
    const resolved = new Map<AttachmentId, Attachment>();
    let total = 0;
    for (const part of content) {
      if (part.type === 'text') {
        kept.push(part);
        continue;
      }
      const id = assetId(part);
      let attachment = resolved.get(id);
      if (!attachment) {
        const asset = await this.#find(id);
        if (!asset) throw notFound(id);
        attachment = asset.part;
        const handle = await this.#openStored(asset);
        try {
          if (attachment.type === 'image' && needsResize(attachment, attachment.size)) {
            // 旧上传或工具产物保留原图及历史引用，新消息另用优化后的副本。
            const { bytes, ...format } = await prepareImage(await handle.readFile(), attachment);
            attachment = { ...attachment, ...format, imageId: newId('img'), size: bytes.length };
            await this.#stage(attachment, bytes);
            staged.set(attachment.imageId, attachment);
          } else if (dirname(asset.path) === this.#staged) {
            staged.set(id, attachment);
          }
        } finally {
          await handle.close();
        }
        resolved.set(id, attachment);
      }
      total += attachment.size;
      if (total > MESSAGE_ATTACHMENT_MAX_BYTES)
        throw invalid(
          ['content'],
          `message attachments exceed ${MESSAGE_ATTACHMENT_MAX_BYTES} bytes`,
        );
      kept.push(attachment);
    }
    for (const part of staged.values()) await this.#unstage(part);
    return kept;
  }

  /** 这张图片在磁盘上的文件（0.43.0，`session.usage` / `session.delete`）：图片本身与旁边的 `.json`；没有时为空数组。 */
  async files(imageId: AttachmentId): Promise<string[]> {
    const image = await this.#find(imageId);
    if (image === undefined) return [];
    return [image.path, join(dirname(image.path), `${imageId}.json`)];
  }

  /** 删掉这张图片（0.43.0，`session.delete` 删掉最后一个引用它的会话时）。没有时无操作。 */
  async remove(imageId: AttachmentId): Promise<void> {
    for (const path of await this.files(imageId)) await rm(path, { force: true });
  }

  /** 删掉 `staged/` 里放了超过一天的图片。最多一分钟一次。 */
  async sweep(): Promise<void> {
    const now = this.#now();
    if (now - this.#lastSweep < 60_000) return;
    this.#lastSweep = now;
    let names: string[];
    try {
      names = await readdir(this.#staged);
    } catch {
      return;
    }
    await Promise.all(
      names.map(async (name) => {
        const path = join(this.#staged, name);
        const info = await stat(path).catch(() => undefined);
        if (info !== undefined && now - info.mtimeMs > STAGED_IMAGE_TTL_MS) {
          await rm(path, { force: true });
        }
      }),
    );
  }

  async #find(imageId: AttachmentId): Promise<StoredAsset | undefined> {
    if (!(imageId.startsWith('file_') ? FileIdSchema : ImageIdSchema).safeParse(imageId).success)
      return undefined;
    for (const dir of [this.#staged, this.#dir]) {
      const part = await readPart(join(dir, `${imageId}.json`));
      if (part !== undefined && assetId(part) === imageId) {
        return { part, path: join(dir, fileName(part)) };
      }
    }
    return undefined;
  }
  syncAsset(imageId: AttachmentId): Promise<StoredAsset | undefined> {
    return this.#find(imageId);
  }
  async importSynced(part: Attachment, path: string): Promise<boolean> {
    const parsed =
      part.type === 'image' ? UserImagePartSchema.parse(part) : UserFilePartSchema.parse(part);
    const info = await stat(path);
    if (
      info.size !== parsed.size ||
      info.size > (parsed.type === 'image' ? TOOL_IMAGE_MAX_BYTES : FILE_MAX_BYTES)
    )
      return false;
    const bytes = await readFile(path);
    if (parsed.type === 'image' && sniffImage(bytes)?.mimeType !== parsed.mimeType) return false;
    const existing = await this.#find(assetId(parsed));
    if (existing)
      return (
        existing.part.type === parsed.type &&
        existing.part.mimeType === parsed.mimeType &&
        (parsed.type !== 'file' || existing.part.name === parsed.name) &&
        (await readFile(existing.path)).equals(bytes)
      );
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    for (const [target, content] of [
      [join(this.#dir, fileName(parsed)), bytes],
      [join(this.#dir, `${assetId(parsed)}.json`), Buffer.from(JSON.stringify(parsed))],
    ] as const) {
      try {
        const file = await open(target, 'wx', 0o600);
        try {
          await file.writeFile(content);
          await file.sync();
        } finally {
          await file.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!(await readFile(target)).equals(content)) return false;
      }
    }
    return true;
  }

  /** 挪出 `staged/`；同一张图片被两条消息同时用到时，后一个发现已经挪走了就算成功。 */
  async #unstage(part: Attachment): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    for (const name of [fileName(part), `${assetId(part)}.json`]) {
      try {
        await rename(join(this.#staged, name), join(this.#dir, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await stat(join(this.#dir, name)).catch(() => {
          throw notFound(assetId(part));
        });
      }
    }
  }
}

/** 文件头认出的格式与像素（读不出像素时只有格式）。 */
export interface ImageHeader {
  mimeType: UserImageMimeType;
  width?: number;
  height?: number;
}

/** 按文件头认 PNG、JPEG、GIF、WebP，并读出像素；不是这四种时 `undefined`。 */
export function sniffImage(bytes: Uint8Array): ImageHeader | undefined {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return sized('image/png', () =>
      buf.length >= 24 && buf.toString('latin1', 12, 16) === 'IHDR'
        ? [buf.readUInt32BE(16), buf.readUInt32BE(20)]
        : undefined,
    );
  }
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) {
    return sized('image/gif', () =>
      buf.length >= 10 ? [buf.readUInt16LE(6), buf.readUInt16LE(8)] : undefined,
    );
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return sized('image/jpeg', () => jpegSize(buf));
  }
  if (
    buf.length >= 16 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return sized('image/webp', () => webpSize(buf));
  }
  return undefined;
}

function sized(mimeType: UserImageMimeType, read: () => [number, number] | undefined): ImageHeader {
  const size = read();
  if (size === undefined || size[0] < 1 || size[1] < 1) return { mimeType };
  return { mimeType, width: size[0], height: size[1] };
}

/** JPEG：顺着段找第一个 SOF（C0–CF，除去 C4 DHT、C8 JPG、CC DAC）。 */
function jpegSize(buf: Buffer): [number, number] | undefined {
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) return undefined;
    const marker = buf[offset + 1] as number;
    // 填充字节。
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // 没有长度的标记：SOI、EOI、RSTn、TEM。
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > buf.length) return undefined;
      return [buf.readUInt16BE(offset + 7), buf.readUInt16BE(offset + 5)];
    }
    offset += 2 + length;
  }
  return undefined;
}

/** WebP：`VP8 `（有损）、`VP8L`（无损）、`VP8X`（扩展）三种头。 */
function webpSize(buf: Buffer): [number, number] | undefined {
  const chunk = buf.toString('latin1', 12, 16);
  if (chunk === 'VP8 ' && buf.length >= 30) {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return undefined;
    return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  }
  if (chunk === 'VP8L' && buf.length >= 25) {
    if (buf[20] !== 0x2f) return undefined;
    const b0 = buf[21] as number;
    const b1 = buf[22] as number;
    const b2 = buf[23] as number;
    const b3 = buf[24] as number;
    return [
      1 + (((b1 & 0x3f) << 8) | b0),
      1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    ];
  }
  if (chunk === 'VP8X' && buf.length >= 30) {
    return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
  }
  return undefined;
}

function assetId(part: Attachment): AttachmentId {
  return part.type === 'image' ? part.imageId : part.fileId;
}

function uploadBytes(data: string, limit: number): Buffer {
  if (data.length > Math.ceil(limit / 3) * 4 || data.length % 4 !== 0 || !BASE64.test(data)) {
    throw invalid(['data'], 'invalid or oversized base64 attachment');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > limit) throw invalid(['data'], `attachment exceeds ${limit} bytes`);
  return bytes;
}

function needsResize(header: ImageHeader, size: number): boolean {
  return (
    size > IMAGE_SEND_MAX_BYTES ||
    Math.max(header.width ?? Infinity, header.height ?? Infinity) > IMAGE_MAX_EDGE
  );
}

async function prepareImage(
  bytes: Buffer,
  header: ImageHeader,
): Promise<ImageHeader & { bytes: Buffer }> {
  if (!needsResize(header, bytes.length)) return { ...header, bytes };
  const { default: sharp } = await import('sharp');
  try {
    const { data, info } = await sharp(bytes, { limitInputPixels: 64_000_000 })
      .autoOrient()
      .resize(IMAGE_MAX_EDGE, IMAGE_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#fff' })
      .jpeg({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    if (data.length <= IMAGE_SEND_MAX_BYTES)
      return { bytes: data, mimeType: 'image/jpeg', width: info.width, height: info.height };
  } catch {
    throw invalid(['data'], 'image cannot be resized');
  }
  throw invalid(['data'], `resized image exceeds ${IMAGE_SEND_MAX_BYTES} bytes`);
}

function fileName(part: Attachment): string {
  if (part.type === 'file') {
    const ext = extname(part.name);
    return `${part.fileId}.data${/^\.[a-z0-9]{1,12}$/i.test(ext) ? ext : ''}`;
  }
  return `${part.imageId}.${EXTENSIONS[part.mimeType]}`;
}

async function readPart(path: string): Promise<Attachment | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const raw = JSON.parse(text);
    const parsed =
      raw?.type === 'file' ? UserFilePartSchema.safeParse(raw) : UserImagePartSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function invalid(path: Array<string | number>, message: string): HostError<'INVALID_PARAMS'> {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}

function notFound(imageId: string): HostError<'IMAGE_NOT_FOUND' | 'INVALID_PARAMS'> {
  if (imageId.startsWith('file_')) return invalid(['content'], `attachment ${imageId} not found`);
  return new HostError('IMAGE_NOT_FOUND', `image ${imageId} not found`);
}
