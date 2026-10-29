// 生图的应用级工具（0.139.0）：`wevir_image_generate`。会话的 Provider（`openai-compatible`）有图片模型时才列出，Host 用这个
// Provider 的 Key 调它的 `/images/*`（image-gen.ts），生成的图存进数据目录的 `generated-images/<会话>/`，在对话里照 Codex 的生图
// 显示（`prepareEvent` 把展示换成 `image`、结束时带上图片）。模型拿到的是文件路径；属于项目的图由它用自己的 shell 复制进项目，
// 所以 Host 只写自己的目录。归在工具预设的 `workbench` 组，常驻。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { ProviderImageModel, ProviderModel, SessionId } from '@wevir/protocol';
import { type AgentEvent, type AgentToolImage, appToolBaseName } from '@wevir/runtime-adapter';
import type { Storage } from '@wevir/storage';
import { type AppTool, AppToolError, type AppToolResult } from './app-mcp.js';
import { appToolArgs } from './browser-batch.js';
import { callerCwd } from './browser-tools.js';
import {
  generateImages,
  ImageGenerationError,
  type ImageProviderTarget,
  type ImageRequest,
} from './image-gen.js';
import { sniffImage } from './images.js';

export const IMAGE_TOOL = 'wevir_image_generate';
/** 说明里讲生图工具的一行（app-tools.ts 只给列出了它的会话加上）：告诉模型它能生图。 */
export const IMAGE_TOOL_INSTRUCTIONS =
  "- wevir_image_generate: this session's provider has an image model, so you can create and edit images (photos, illustrations, sprites, mockups); follow the imagegen skill.";
/** 编辑时最多几张输入图（OpenAI 的 `gpt-image-*` 认 16 张）。 */
export const IMAGE_INPUTS_MAX = 16;
/** 一张输入图最大多少字节（OpenAI 的上限 50 MB）。 */
export const IMAGE_INPUT_MAX_BYTES = 50 * 1024 * 1024;
/** 一次最多几张变体。 */
export const IMAGE_VARIANTS_MAX = 4;
/** 生成的图一起交给模型看时的总大小上限，超过只给路径。 */
const IMAGE_RESULT_INLINE_BYTES = 16 * 1024 * 1024;
const PROMPT_MAX_CHARS = 32_000;

const INPUT_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface ImageToolsOptions {
  storage: Storage;
  /** 生成的图存在这里（`<数据目录>/generated-images`），每个会话一个子目录。 */
  dir: string;
  /** Provider 的地址与 Key（SecretStore）；不在了时 `undefined`。 */
  target: (providerId: string) => Promise<ImageProviderTarget | undefined>;
  fetch?: typeof fetch;
}

/**
 * 会话的 Provider 的图片模型：`openai-compatible`、启用、有地址并配了图片模型时有，否则空。`creatingProviderId`：正在建、还没写进
 * 存储的会话将要用的 Provider（引擎在建会话期间就读工具与说明）。
 */
export function sessionImageModels(
  storage: Storage,
  sessionId: SessionId,
  creatingProviderId?: string,
): ProviderImageModel[] {
  const providerId = storage.sessions.get(sessionId)?.providerId ?? creatingProviderId;
  const provider = providerId === undefined ? undefined : storage.providers.get(providerId);
  if (
    provider === undefined ||
    provider.kind !== 'openai-compatible' ||
    provider.enabled === false ||
    provider.baseURL === undefined
  ) {
    return [];
  }
  const models = provider.imageModels as ProviderImageModel[] | undefined;
  return Array.isArray(models) ? models : [];
}

/** 一次生成的结果，等 `tool.finished` 时交给对话显示。 */
interface Finished {
  paths: string[];
  text: string;
}

export class ImageTools {
  readonly tools: AppTool[];
  readonly #options: ImageToolsOptions;
  /** 已完成、还没等到 `tool.finished` 的生成：`<会话>\0<提示>` → 结果（同一提示按先后）。 */
  readonly #finished = new Map<string, Finished[]>();
  /** 进行中的调用：`<会话>:<工具调用>` → 提示。 */
  readonly #calls = new Map<string, string>();

  constructor(options: ImageToolsOptions) {
    this.#options = options;
    this.tools = [this.#generateTool()];
  }

  /** 这个会话列不列生图工具；`creatingProviderId` 见 `sessionImageModels`。 */
  available(sessionId: SessionId, creatingProviderId?: string): boolean {
    return sessionImageModels(this.#options.storage, sessionId, creatingProviderId).length > 0;
  }

  /**
   * 工具事件落库前：生图调用的展示换成 `image`（摘要是提示），结束时带上生成的图片，输出换成给模型的那段文字（不带 base64）。
   * 别的事件原样返回。
   */
  prepareEvent(sessionId: SessionId, event: AgentEvent): AgentEvent {
    if (event.type === 'tool.started' || event.type === 'tool.updated') {
      const key = `${sessionId}:${event.toolCallId}`;
      const known = this.#calls.has(key);
      if (event.type === 'tool.started' && appToolBaseName(event.toolName) !== IMAGE_TOOL)
        return event;
      if (event.type === 'tool.updated' && !known) return event;
      const prompt = promptOf(event.input) ?? this.#calls.get(key);
      if (prompt === undefined && !known) return event;
      this.#calls.set(key, prompt ?? '');
      trim(this.#calls, 200);
      return { ...event, display: { kind: 'image', ...(prompt && { summary: prompt }) } };
    }
    if (event.type !== 'tool.finished') return event;
    const key = `${sessionId}:${event.toolCallId}`;
    const prompt = this.#calls.get(key);
    if (prompt === undefined) return event;
    this.#calls.delete(key);
    const queue = this.#finished.get(`${sessionId}\0${prompt}`);
    const done = queue?.shift();
    if (queue?.length === 0) this.#finished.delete(`${sessionId}\0${prompt}`);
    if (done === undefined) return event;
    const images: AgentToolImage[] = [];
    for (const path of done.paths) {
      try {
        images.push({ data: readFileSync(path).toString('base64') });
      } catch {}
    }
    return {
      ...event,
      output: done.text,
      ...(images.length > 0 && { images }),
    };
  }

  #remember(sessionId: SessionId, prompt: string, finished: Finished): void {
    const key = `${sessionId}\0${prompt}`;
    const queue = this.#finished.get(key) ?? [];
    queue.push(finished);
    this.#finished.set(key, queue);
    trim(this.#finished, 100);
  }

  #generateTool(): AppTool {
    return {
      name: IMAGE_TOOL,
      title: 'Generate or edit images',
      description:
        "Create or edit raster images with this session's image model (OpenAI Images API). images: local files to " +
        'edit or use as references; mask: PNG whose transparent pixels mark the area to change; n: variants of one ' +
        "prompt. The user sees the images inline; the result lists the paths saved in Wevir's data folder. Copy " +
        'project assets into the project without overwriting files. May take a minute.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          images: { type: 'array', items: { type: 'string' }, maxItems: IMAGE_INPUTS_MAX },
          mask: { type: 'string' },
          size: { type: 'string', description: 'auto or WIDTHxHEIGHT' },
          quality: { type: 'string', enum: ['low', 'medium', 'high', 'auto'] },
          background: { type: 'string', enum: ['auto', 'opaque', 'transparent'] },
          n: { type: 'integer', minimum: 1, maximum: IMAGE_VARIANTS_MAX },
          model: { type: 'string', description: 'Defaults to the first image model' },
          outputFormat: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
          name: { type: 'string', description: 'File name stem' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      // 不改项目里的文件（只写 Wevir 自己的数据目录），同 Codex 的生图不问：标成只读，Codex 的批准方式不拦它（Claude 按名字放行）。
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      call: (args, call) => this.#generate(args, call.sessionId, call.signal),
    };
  }

  async #generate(
    args: Record<string, unknown>,
    sessionId: SessionId,
    signal: AbortSignal,
  ): Promise<AppToolResult> {
    const { storage } = this.#options;
    const cwd = callerCwd(storage, sessionId);
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (prompt === '') throw new AppToolError('prompt is required.');
    if (prompt.length > PROMPT_MAX_CHARS) {
      throw new AppToolError(`prompt is longer than ${PROMPT_MAX_CHARS} characters.`);
    }
    const models = sessionImageModels(storage, sessionId);
    const record = storage.sessions.get(sessionId);
    if (models.length === 0 || record === undefined) {
      throw new AppToolError(
        "This session's provider has no image models. Add one (such as gpt-image-2) to the provider in Wevir's settings.",
      );
    }
    const model = optionalText(args, 'model') ?? models[0]?.id ?? '';
    if (!models.some((entry) => entry.id === model)) {
      throw new AppToolError(
        `model must be one of this provider's image models: ${models.map((entry) => entry.id).join(', ')}.`,
      );
    }
    const size = optionalText(args, 'size');
    if (size !== undefined && size !== 'auto' && !/^\d{2,5}x\d{2,5}$/.test(size)) {
      throw new AppToolError('size must be auto or WIDTHxHEIGHT, like 1536x1024.');
    }
    const quality = optionalChoice(args, 'quality', ['low', 'medium', 'high', 'auto']);
    const background = optionalChoice(args, 'background', ['auto', 'opaque', 'transparent']);
    const outputFormat = optionalChoice(args, 'outputFormat', ['png', 'jpeg', 'webp']);
    let n: number | undefined;
    if (args.n !== undefined) {
      if (
        !Number.isInteger(args.n) ||
        (args.n as number) < 1 ||
        (args.n as number) > IMAGE_VARIANTS_MAX
      ) {
        throw new AppToolError(`n must be an integer from 1 to ${IMAGE_VARIANTS_MAX}.`);
      }
      n = args.n as number;
    }
    const paths = args.images;
    if (
      paths !== undefined &&
      (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string'))
    ) {
      throw new AppToolError('images must be a list of file paths.');
    }
    if ((paths?.length ?? 0) > IMAGE_INPUTS_MAX) {
      throw new AppToolError(`At most ${IMAGE_INPUTS_MAX} images.`);
    }
    const images = await Promise.all(
      ((paths ?? []) as string[]).map((path) => readInput(cwd, path, 'images')),
    );
    const maskPath = optionalText(args, 'mask');
    if (maskPath !== undefined && images.length === 0) {
      throw new AppToolError('mask needs the image to edit in images.');
    }
    const mask = maskPath === undefined ? undefined : await readInput(cwd, maskPath, 'mask');
    if (mask !== undefined && mask.mimeType !== 'image/png') {
      throw new AppToolError('mask must be a PNG with an alpha channel.');
    }
    const target = await this.#options.target(record.providerId);
    if (target === undefined) throw new AppToolError("This session's provider no longer exists.");

    const request: ImageRequest = {
      model,
      prompt,
      ...(images.length > 0 && { images }),
      ...(mask !== undefined && { mask }),
      ...(size !== undefined && { size }),
      ...(quality !== undefined && { quality }),
      ...(background !== undefined && { background }),
      ...(n !== undefined && { n }),
      ...(outputFormat !== undefined && { outputFormat }),
    };
    let generated: Awaited<ReturnType<typeof generateImages>>;
    try {
      generated = await generateImages(target, request, {
        signal,
        ...(this.#options.fetch !== undefined && { fetch: this.#options.fetch }),
      });
    } catch (error) {
      if (error instanceof ImageGenerationError) throw new AppToolError(error.message);
      throw error;
    }

    const dir = join(this.#options.dir, sessionId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stem = fileStem(optionalText(args, 'name')) ?? 'image';
    const stamp = timestamp(new Date());
    const saved: Array<{ path: string; bytes: Buffer; mimeType: string; size?: string }> = [];
    for (const image of generated) {
      const header = sniffImage(image.bytes);
      if (header === undefined) continue;
      const ext = EXTENSION[header.mimeType] ?? 'png';
      const path = uniquePath(dir, `${stem}-${stamp}`, ext);
      writeFileSync(path, image.bytes, { mode: 0o600, flag: 'wx' });
      saved.push({
        path,
        bytes: image.bytes,
        mimeType: header.mimeType,
        ...(header.width !== undefined && { size: `${header.width}x${header.height}` }),
      });
    }
    if (saved.length === 0)
      throw new AppToolError('The image service returned data that is not an image.');

    const revised = [...new Set(generated.flatMap((image) => image.revisedPrompt ?? []))];
    const lines = [
      `${images.length > 0 ? 'Edited' : 'Generated'} ${saved.length} image${saved.length === 1 ? '' : 's'} with ${model}; the user sees ${saved.length === 1 ? 'it' : 'them'} in the conversation.`,
      ...saved.map((image) => `- ${image.path}${image.size ? ` (${image.size})` : ''}`),
      ...revised.map((text) => `Revised prompt: ${text}`),
      "The files are in Wevir's data folder: copy the ones the project uses into it (keep existing files; use a versioned name).",
    ];
    const text = lines.join('\n');
    this.#remember(sessionId, prompt, { paths: saved.map((image) => image.path), text });

    const content: AppToolResult['content'] = [{ type: 'text', text }];
    // 模型收图时把生成的图交给它检查（总大小有上限）。
    const total = saved.reduce((sum, image) => sum + image.bytes.length, 0);
    if (modelTakesImages(storage, sessionId) && total <= IMAGE_RESULT_INLINE_BYTES) {
      for (const image of saved) {
        content.push({
          type: 'image',
          data: image.bytes.toString('base64'),
          mimeType: image.mimeType,
        });
      }
    }
    return { content };
  }
}

async function readInput(
  cwd: string,
  path: string,
  field: 'images' | 'mask',
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mimeType: string; name: string }> {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(absolute);
  } catch {
    throw new AppToolError(`${field}: ${path} does not exist.`);
  }
  if (!info.isFile()) throw new AppToolError(`${field}: ${path} is not a file.`);
  if (info.size > IMAGE_INPUT_MAX_BYTES) {
    throw new AppToolError(`${field}: ${path} is larger than 50 MB.`);
  }
  const bytes = await readFile(absolute);
  const header = sniffImage(bytes);
  if (header === undefined || !INPUT_MIME.has(header.mimeType)) {
    throw new AppToolError(`${field}: ${path} is not a PNG, JPEG or WebP image.`);
  }
  return { bytes, mimeType: header.mimeType, name: basename(absolute) };
}

/** 会话当前的模型收不收图（Provider 的模型表里明确写了 `supportsImages`）。 */
function modelTakesImages(storage: Storage, sessionId: SessionId): boolean {
  const record = storage.sessions.get(sessionId);
  const provider = record && storage.providers.get(record.providerId);
  const models = provider?.models as ProviderModel[] | undefined;
  return models?.find((model) => model.id === record?.modelId)?.supportsImages === true;
}

function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new AppToolError(`${key} must be a string.`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function optionalChoice(
  args: Record<string, unknown>,
  key: string,
  choices: readonly string[],
): string | undefined {
  const value = optionalText(args, key);
  if (value !== undefined && !choices.includes(value)) {
    throw new AppToolError(`${key} must be one of ${choices.join(', ')}.`);
  }
  return value;
}

/** 文件名主干：字母、数字、`-`、`_`，最多 60 个字符；什么都不剩时 `undefined`。 */
export function fileStem(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const stem = name
    .replace(/\.(png|jpe?g|webp)$/i, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return stem === '' ? undefined : stem;
}

function timestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function uniquePath(dir: string, base: string, ext: string): string {
  for (let index = 1; ; index += 1) {
    const path = join(dir, index === 1 ? `${base}.${ext}` : `${base}-${index}.${ext}`);
    if (!existsSync(path)) return path;
  }
}

function promptOf(input: unknown): string | undefined {
  const args = appToolArgs(input);
  const prompt = (args as { prompt?: unknown } | null | undefined)?.prompt;
  return typeof prompt === 'string' && prompt.trim() !== '' ? prompt.trim() : undefined;
}

function trim<K, V>(map: Map<K, V>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}
