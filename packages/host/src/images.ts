import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  IMAGE_MAX_BYTES,
  IMAGE_READ_CHUNK_BYTES,
  type ImageId,
  type MethodParams,
  type MethodResult,
  type UserContentPart,
  type UserImageMimeType,
  type UserImagePart,
  UserImagePartSchema,
} from '@wevir/protocol';
import { HostError } from './errors.js';
import { newId } from './ids.js';

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

/** 上传了没发出去的图片留多久。 */
export const STAGED_IMAGE_TTL_MS = 24 * 60 * 60 * 1000;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface ImageStoreOptions {
  /** 数据目录里的 `images/`。 */
  dir: string;
  /** 测试用。 */
  now?: () => number;
}

interface StoredImage {
  part: UserImagePart;
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
    if (params.data.length % 4 !== 0 || !BASE64.test(params.data)) {
      throw invalid(['data'], 'data is not base64');
    }
    const bytes = Buffer.from(params.data, 'base64');
    if (bytes.length === 0) throw invalid(['data'], 'image is empty');
    if (bytes.length > IMAGE_MAX_BYTES) {
      throw invalid(['data'], `image is larger than ${IMAGE_MAX_BYTES} bytes`);
    }
    const header = sniffImage(bytes);
    if (header === undefined) throw invalid(['data'], 'not a PNG, JPEG, GIF or WebP image');
    const part: UserImagePart = {
      type: 'image',
      imageId: newId('img'),
      mimeType: header.mimeType,
      size: bytes.length,
      ...(header.width !== undefined && { width: header.width, height: header.height }),
      ...(params.name !== undefined && { name: params.name }),
    };
    await mkdir(this.#staged, { recursive: true, mode: 0o700 });
    await writeFile(join(this.#staged, fileName(part)), bytes, { mode: 0o600 });
    await writeFile(join(this.#staged, `${part.imageId}.json`), JSON.stringify(part), {
      mode: 0o600,
    });
    void this.sweep().catch(() => {});
    return part;
  }

  /** `image.read`：从 `offset` 起最多 `IMAGE_READ_CHUNK_BYTES`。 */
  async read(params: MethodParams<'image.read'>): Promise<MethodResult<'image.read'>> {
    const image = await this.#find(params.imageId);
    if (image === undefined) throw notFound(params.imageId);
    const offset = params.offset ?? 0;
    const { size } = image.part;
    if (offset >= size) throw invalid(['offset'], `offset is past the end (${size} bytes)`);
    const length = Math.min(IMAGE_READ_CHUNK_BYTES, size - offset);
    const handle = await open(image.path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return {
        imageId: image.part.imageId,
        mimeType: image.part.mimeType,
        size,
        offset,
        data: buffer.subarray(0, bytesRead).toString('base64'),
      };
    } finally {
      await handle.close();
    }
  }

  /** 发给引擎的图片在磁盘上的路径；没有这张图片时 `undefined`。 */
  async path(imageId: ImageId): Promise<string | undefined> {
    return (await this.#find(imageId))?.path;
  }

  /**
   * 消息被接受之前：每张图片换成 Host 记下的（客户端给的元数据不作数），挪出 `staged/`。没有这张图片时回
   * `IMAGE_NOT_FOUND`；文本原样。
   */
  async keep(content: readonly UserContentPart[]): Promise<UserContentPart[]> {
    const kept: UserContentPart[] = [];
    for (const part of content) {
      if (part.type !== 'image') {
        kept.push(part);
        continue;
      }
      const image = await this.#find(part.imageId);
      if (image === undefined) throw notFound(part.imageId);
      if (image.path.startsWith(this.#staged)) await this.#unstage(image.part);
      kept.push(image.part);
    }
    return kept;
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

  async #find(imageId: ImageId): Promise<StoredImage | undefined> {
    for (const dir of [this.#dir, this.#staged]) {
      const part = await readPart(join(dir, `${imageId}.json`));
      if (part !== undefined && part.imageId === imageId) {
        return { part, path: join(dir, fileName(part)) };
      }
    }
    return undefined;
  }

  /** 挪出 `staged/`；同一张图片被两条消息同时用到时，后一个发现已经挪走了就算成功。 */
  async #unstage(part: UserImagePart): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    for (const name of [fileName(part), `${part.imageId}.json`]) {
      try {
        await rename(join(this.#staged, name), join(this.#dir, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await stat(join(this.#dir, name)).catch(() => {
          throw notFound(part.imageId);
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

function fileName(part: UserImagePart): string {
  return `${part.imageId}.${EXTENSIONS[part.mimeType]}`;
}

async function readPart(path: string): Promise<UserImagePart | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = UserImagePartSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function invalid(path: Array<string | number>, message: string): HostError<'INVALID_PARAMS'> {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}

function notFound(imageId: string): HostError<'IMAGE_NOT_FOUND'> {
  return new HostError('IMAGE_NOT_FOUND', `image ${imageId} not found`);
}
