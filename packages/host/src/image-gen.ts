// 生图（0.139.0）：OpenAI 兼容服务的图片接口。`POST <baseURL>/images/generations`（JSON）生成，`POST <baseURL>/images/edits`
// （multipart：`image` / `image[]`、可选 `mask`）编辑，回 `{ data: [{ b64_json | url, revised_prompt? }] }`。OpenAI 的
// `gpt-image-*` 总回 base64；兼容服务回 `url` 时再下载一次。`provider.discoverImageModels` 读 `GET <baseURL>/models` 找图片模型。
// Key 只放进 Authorization 头，不进日志、错误信息与工具结果。

import type { MethodResult, ProviderImageModel, ProviderTestFailure } from '@wevir/protocol';
import { PROVIDER_IMAGE_MODELS_MAX } from '@wevir/protocol';

export interface ImageProviderTarget {
  baseURL: string;
  apiKey: string | undefined;
}

/** 生成或编辑一次的参数（`wevir_image_generate` 的参数，路径已读成字节）。 */
export interface ImageRequest {
  model: string;
  prompt: string;
  /** 有它时是编辑：要改的图与参考图，按顺序。 */
  images?: Array<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string; name: string }>;
  mask?: { bytes: Uint8Array<ArrayBuffer>; mimeType: string; name: string };
  size?: string;
  quality?: string;
  background?: string;
  n?: number;
  outputFormat?: string;
}

export interface GeneratedImage {
  bytes: Buffer;
  revisedPrompt?: string;
}

/** 图片服务出错：`message` 给模型和人看（不含 Key）。 */
export class ImageGenerationError extends Error {
  override readonly name = 'ImageGenerationError';
  readonly failure: ProviderTestFailure;
  readonly httpStatus: number | undefined;
  constructor(message: string, failure: ProviderTestFailure, httpStatus?: number) {
    super(message);
    this.failure = failure;
    this.httpStatus = httpStatus;
  }
}

/** 生成要几分钟（高质量、大尺寸、多张），等服务端的时限。 */
export const IMAGE_TIMEOUT_MS = 5 * 60_000;
/** 一次响应最多读多少（4 张 4K PNG 的 base64）。 */
const MAX_IMAGE_RESPONSE_BYTES = 160 * 1024 * 1024;
/** 兼容服务回 `url` 时，下载一张图最多多大。 */
const MAX_IMAGE_DOWNLOAD_BYTES = 40 * 1024 * 1024;
const MAX_MODELS_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * 认得出的图片模型：OpenAI 的 `gpt-image-*` 与 `chatgpt-image-*`（含带日期的快照与 `-mini`），兼容服务加前缀的
 * `openai/gpt-image-2` 也算。
 */
export function isImageModelId(id: string): boolean {
  const name = id.split('/').at(-1) ?? id;
  return /^(?:gpt|chatgpt)-image(?:-|$)/i.test(name);
}

/** 版本号、`-mini`、日期快照：新版本在前，同版本里别名先于快照、完整版先于 mini。 */
function imageModelKey(id: string): [number, number, number] {
  const name = (id.split('/').at(-1) ?? id).toLowerCase();
  const version = /-image-(\d+(?:\.\d+)?)/.exec(name)?.[1];
  return [
    version === undefined ? 0 : Number(version),
    name.includes('-mini') ? 0 : 1,
    /-\d{4}-\d{2}-\d{2}$/.test(name) ? 0 : 1,
  ];
}

export function compareImageModels(a: string, b: string): number {
  const ka = imageModelKey(a);
  const kb = imageModelKey(b);
  for (let i = 0; i < ka.length; i += 1) {
    const diff = (kb[i] ?? 0) - (ka[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

function endpoint(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/u, '')}${path}`;
}

function headersOf(target: ImageProviderTarget): Record<string, string> {
  return target.apiKey === undefined ? {} : { authorization: `Bearer ${target.apiKey}` };
}

function statusFailure(status: number): ProviderTestFailure {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_not_found';
  if (status === 429) return 'rate_limited';
  return status >= 500 ? 'server' : 'protocol';
}

function timedOut(signal: AbortSignal): boolean {
  return (
    signal.aborted && (signal.reason as { name?: unknown } | undefined)?.name === 'TimeoutError'
  );
}

/** `provider.discoverImageModels`：`GET <baseURL>/models` 里认得出的图片模型，按版本从新到旧。 */
export async function discoverImageModels(
  target: ImageProviderTarget,
  doFetch: typeof fetch = fetch,
): Promise<MethodResult<'provider.discoverImageModels'>> {
  const signal = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    response = await doFetch(endpoint(target.baseURL, '/models'), {
      headers: headersOf(target),
      redirect: 'error',
      signal,
    });
  } catch {
    return { ok: false, models: [], reason: timedOut(signal) ? 'timeout' : 'network' };
  }
  const body = await readLimited(response, MAX_MODELS_RESPONSE_BYTES);
  if (!response.ok) {
    return {
      ok: false,
      models: [],
      reason: statusFailure(response.status),
      httpStatus: response.status,
    };
  }
  const data = (parseJson(body) as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) return { ok: false, models: [], reason: 'protocol' };
  const ids = [
    ...new Set(
      data.flatMap((entry) => {
        const id = (entry as { id?: unknown } | null)?.id;
        return typeof id === 'string' && id.length <= 200 && isImageModelId(id) ? [id] : [];
      }),
    ),
  ];
  const models: ProviderImageModel[] = ids
    .sort(compareImageModels)
    .slice(0, PROVIDER_IMAGE_MODELS_MAX)
    .map((id) => ({ id }));
  return { ok: true, models };
}

/** 生成或编辑：回服务端给的每一张图。 */
export async function generateImages(
  target: ImageProviderTarget,
  request: ImageRequest,
  options: { signal: AbortSignal; fetch?: typeof fetch },
): Promise<GeneratedImage[]> {
  const doFetch = options.fetch ?? fetch;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)]);
  const edit = request.images !== undefined && request.images.length > 0;
  const url = endpoint(target.baseURL, edit ? '/images/edits' : '/images/generations');
  const fields: Record<string, string> = {
    model: request.model,
    prompt: request.prompt,
    ...(request.size !== undefined && { size: request.size }),
    ...(request.quality !== undefined && { quality: request.quality }),
    ...(request.background !== undefined && { background: request.background }),
    ...(request.outputFormat !== undefined && { output_format: request.outputFormat }),
  };
  let body: BodyInit;
  const headers = headersOf(target);
  if (edit) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    if (request.n !== undefined) form.append('n', String(request.n));
    const images = request.images ?? [];
    const field = images.length > 1 ? 'image[]' : 'image';
    for (const image of images) {
      form.append(field, new Blob([image.bytes], { type: image.mimeType }), image.name);
    }
    if (request.mask !== undefined) {
      form.append(
        'mask',
        new Blob([request.mask.bytes], { type: request.mask.mimeType }),
        request.mask.name,
      );
    }
    body = form;
  } else {
    headers['content-type'] = 'application/json';
    body = JSON.stringify({ ...fields, ...(request.n !== undefined && { n: request.n }) });
  }
  let response: Response;
  try {
    response = await doFetch(url, { method: 'POST', headers, body, redirect: 'error', signal });
  } catch {
    if (options.signal.aborted) throw new ImageGenerationError('Cancelled.', 'unknown');
    throw new ImageGenerationError(
      timedOut(signal)
        ? 'The image service did not answer in time.'
        : `Could not reach the image service (${hostOf(url)}).`,
      timedOut(signal) ? 'timeout' : 'network',
    );
  }
  const text = await readLimited(response, MAX_IMAGE_RESPONSE_BYTES);
  if (!response.ok) {
    throw new ImageGenerationError(
      `The image service answered ${response.status}${detailOf(text)}.`,
      statusFailure(response.status),
      response.status,
    );
  }
  const data = (parseJson(text) as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new ImageGenerationError(
      'The image service returned no images.',
      'protocol',
      response.status,
    );
  }
  const images: GeneratedImage[] = [];
  for (const entry of data) {
    const item = (entry ?? {}) as { b64_json?: unknown; url?: unknown; revised_prompt?: unknown };
    let bytes: Buffer | undefined;
    if (typeof item.b64_json === 'string' && item.b64_json !== '') {
      bytes = Buffer.from(item.b64_json, 'base64');
    } else if (typeof item.url === 'string' && /^https?:\/\//.test(item.url)) {
      bytes = await download(item.url, doFetch, signal);
    } else if (typeof item.url === 'string' && item.url.startsWith('data:image/')) {
      bytes = Buffer.from(item.url.slice(item.url.indexOf(',') + 1), 'base64');
    }
    if (bytes === undefined || bytes.length === 0) continue;
    images.push({
      bytes,
      ...(typeof item.revised_prompt === 'string' &&
        item.revised_prompt.trim() !== '' && { revisedPrompt: item.revised_prompt.trim() }),
    });
  }
  if (images.length === 0) {
    throw new ImageGenerationError(
      'The image service returned no image data.',
      'protocol',
      response.status,
    );
  }
  return images;
}

async function download(url: string, doFetch: typeof fetch, signal: AbortSignal): Promise<Buffer> {
  let response: Response;
  try {
    // 服务端给的下载地址（常是对象存储的签名地址）：不带 Key。
    response = await doFetch(url, { signal });
  } catch {
    throw new ImageGenerationError(
      `Could not download the generated image (${hostOf(url)}).`,
      'network',
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ImageGenerationError(
      `Downloading the generated image answered ${response.status}.`,
      statusFailure(response.status),
      response.status,
    );
  }
  const chunks = await readChunks(response, MAX_IMAGE_DOWNLOAD_BYTES);
  if (chunks === undefined) {
    throw new ImageGenerationError('The generated image is too large to download.', 'protocol');
  }
  return Buffer.concat(chunks);
}

/** 读到上限为止；超过时返回 `undefined`。 */
async function readChunks(response: Response, limit: number): Promise<Uint8Array[] | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return [];
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return chunks;
}

async function readLimited(response: Response, limit: number): Promise<string> {
  const chunks = await readChunks(response, limit);
  return chunks === undefined ? '' : Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 服务端错误里的一句说明（OpenAI 的 `{ error: { message } }`），最多 300 个字符。 */
function detailOf(body: string): string {
  const message = (parseJson(body) as { error?: { message?: unknown } } | undefined)?.error
    ?.message;
  return typeof message === 'string' && message.trim() !== ''
    ? `: ${message.trim().slice(0, 300)}`
    : '';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown host';
  }
}
