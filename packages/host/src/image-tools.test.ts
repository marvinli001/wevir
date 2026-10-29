import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HostId, SessionId } from '@wevir/protocol';
import type { AgentEvent } from '@wevir/runtime-adapter';
import type { Storage } from '@wevir/storage';
import { describe, expect, it } from 'vitest';
import { AppToolError } from './app-mcp.js';
import { APP_TOOLS_INSTRUCTIONS, AppTools } from './app-tools.js';
import { EventStore } from './event-store.js';
import {
  compareImageModels,
  discoverImageModels,
  generateImages,
  isImageModelId,
} from './image-gen.js';
import { fileStem, IMAGE_TOOL, ImageTools } from './image-tools.js';
import type { SessionManager } from './session-manager.js';
import { SES, SES2, T0, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();

/** 1×1 的 PNG。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(respond: (url: string, init?: RequestInit) => Response): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('图片模型', () => {
  it('认得出 gpt-image 与 chatgpt-image，带前缀、快照与 mini 也算', () => {
    for (const id of [
      'gpt-image-2',
      'gpt-image-2.5',
      'gpt-image-1-mini',
      'gpt-image-1.5-2025-12-16',
      'chatgpt-image-latest',
      'openai/gpt-image-2',
    ]) {
      expect(isImageModelId(id), id).toBe(true);
    }
    for (const id of ['gpt-5', 'dall-e-3', 'gpt-4o-image-preview', 'whisper-1']) {
      expect(isImageModelId(id), id).toBe(false);
    }
  });

  it('新版本在前，同版本里别名先于快照、完整版先于 mini', () => {
    expect(
      [
        'gpt-image-1',
        'gpt-image-2-2026-04-21',
        'gpt-image-1-mini',
        'gpt-image-2.5',
        'gpt-image-2',
      ].sort(compareImageModels),
    ).toEqual([
      'gpt-image-2.5',
      'gpt-image-2',
      'gpt-image-2-2026-04-21',
      'gpt-image-1',
      'gpt-image-1-mini',
    ]);
  });

  it('discoverImageModels 读 /models，只留图片模型，Key 进 Authorization', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({
        data: [
          { id: 'gpt-5' },
          { id: 'gpt-image-1.5' },
          { id: 'gpt-image-2' },
          { id: 'gpt-image-2' },
        ],
      }),
    );
    const result = await discoverImageModels(
      { baseURL: 'https://api.openai.com/v1/', apiKey: 'sk-test' },
      fetch,
    );
    expect(result).toEqual({ ok: true, models: [{ id: 'gpt-image-2' }, { id: 'gpt-image-1.5' }] });
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/models');
    expect((calls[0]?.init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      'Bearer sk-test',
    );
  });

  it('discoverImageModels 的失败归到 ProviderTestFailure', async () => {
    const unauthorized = fakeFetch(() => json({ error: { message: 'bad key' } }, 401));
    expect(
      await discoverImageModels({ baseURL: 'https://x/v1', apiKey: 'k' }, unauthorized.fetch),
    ).toEqual({
      ok: false,
      models: [],
      reason: 'auth',
      httpStatus: 401,
    });
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(
      await discoverImageModels({ baseURL: 'https://x/v1', apiKey: undefined }, offline),
    ).toEqual({
      ok: false,
      models: [],
      reason: 'network',
    });
    const odd = fakeFetch(() => json({ models: [] }));
    expect(
      (await discoverImageModels({ baseURL: 'https://x/v1', apiKey: 'k' }, odd.fetch)).reason,
    ).toBe('protocol');
  });
});

describe('generateImages', () => {
  const signal = new AbortController().signal;

  it('没有输入图时 POST /images/generations（JSON），回 base64 与修改后的提示', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ data: [{ b64_json: PNG.toString('base64'), revised_prompt: 'a red mug' }] }),
    );
    const images = await generateImages(
      { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-test' },
      {
        model: 'gpt-image-2',
        prompt: 'a mug',
        size: '1024x1024',
        quality: 'low',
        n: 1,
        outputFormat: 'png',
      },
      { signal, fetch },
    );
    expect(images).toEqual([{ bytes: PNG, revisedPrompt: 'a red mug' }]);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/images/generations');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: 'gpt-image-2',
      prompt: 'a mug',
      size: '1024x1024',
      quality: 'low',
      output_format: 'png',
      n: 1,
    });
  });

  it('有输入图时 POST /images/edits（multipart），多张用 image[]，带 mask', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ data: [{ b64_json: PNG.toString('base64') }] }),
    );
    const file = { bytes: new Uint8Array(PNG), mimeType: 'image/png', name: 'a.png' };
    await generateImages(
      { baseURL: 'https://x/v1', apiKey: 'k' },
      {
        model: 'gpt-image-2',
        prompt: 'merge',
        images: [file, { ...file, name: 'b.png' }],
        mask: file,
      },
      { signal, fetch },
    );
    expect(calls[0]?.url).toBe('https://x/v1/images/edits');
    const form = calls[0]?.init?.body as FormData;
    expect(form.getAll('image[]')).toHaveLength(2);
    expect(form.get('mask')).toBeInstanceOf(Blob);
    expect(form.get('model')).toBe('gpt-image-2');
    const single = fakeFetch(() => json({ data: [{ b64_json: PNG.toString('base64') }] }));
    await generateImages(
      { baseURL: 'https://x/v1', apiKey: 'k' },
      { model: 'gpt-image-2', prompt: 'edit', images: [file] },
      { signal, fetch: single.fetch },
    );
    expect((single.calls[0]?.init?.body as FormData | undefined)?.getAll('image')).toHaveLength(1);
  });

  it('兼容服务回 url 时下载（不带 Key），错误带服务端的说明不带 Key', async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.endsWith('/images/generations')
        ? json({ data: [{ url: 'https://cdn.example.com/out.png' }] })
        : new Response(PNG),
    );
    const images = await generateImages(
      { baseURL: 'https://x/v1', apiKey: 'secret-key' },
      { model: 'gpt-image-2', prompt: 'p' },
      { signal, fetch },
    );
    expect(images[0]?.bytes.equals(PNG)).toBe(true);
    expect(calls[1]?.init?.headers).toBeUndefined();

    const failing = fakeFetch(() =>
      json({ error: { message: 'Billing hard limit reached' } }, 400),
    );
    await expect(
      generateImages(
        { baseURL: 'https://x/v1', apiKey: 'secret-key' },
        { model: 'm', prompt: 'p' },
        { signal, fetch: failing.fetch },
      ),
    ).rejects.toThrow('The image service answered 400: Billing hard limit reached.');
  });
});

function seed(storage: Storage, cwd: string, imageModels?: unknown[]): void {
  storage.workspaces.insert({
    id: 'ws_1',
    rootPath: cwd,
    displayName: 'p',
    createdAt: T0,
    updatedAt: T0,
  });
  storage.providers.insert({
    id: 'openai',
    kind: 'openai-compatible',
    displayName: 'OpenAI',
    api: 'openai-responses',
    baseURL: 'https://api.openai.com/v1',
    models: [{ id: 'gpt-6.1', supportsImages: true }, { id: 'text-only' }],
    defaultModelId: 'gpt-6.1',
    ...(imageModels !== undefined && { imageModels }),
    createdAt: T0,
    updatedAt: T0,
  });
  storage.providers.insert({
    id: 'deepseek-official',
    kind: 'deepseek-official',
    displayName: 'DeepSeek',
    models: [],
    defaultModelId: 'deepseek-chat',
    createdAt: T0,
    updatedAt: T0,
  });
  const session = {
    workspaceId: 'ws_1',
    cwd,
    engine: 'codex',
    title: '',
    titleSource: 'first_prompt',
    state: 'idle',
    lastSeq: 0,
    createdAt: T0,
    updatedAt: T0,
  } as const;
  storage.sessions.insert({
    ...session,
    id: SES,
    engineSessionId: 'e1',
    providerId: 'openai',
    modelId: 'gpt-6.1',
  });
  storage.sessions.insert({
    ...session,
    id: SES2,
    engineSessionId: 'e2',
    providerId: 'deepseek-official',
    modelId: 'deepseek-chat',
  });
}

function setup(
  imageModels: unknown[] | undefined = [{ id: 'gpt-image-2' }, { id: 'gpt-image-1.5' }],
) {
  const root = tempDir();
  const storage = storages.open(join(root, 'data'));
  seed(storage, root, imageModels);
  const responses: Response[] = [];
  const { fetch, calls } = fakeFetch(
    () => responses.shift() ?? json({ data: [{ b64_json: PNG.toString('base64') }] }),
  );
  const options = {
    storage,
    dir: join(root, 'data', 'generated-images'),
    target: async (providerId: string) =>
      providerId === 'openai'
        ? { baseURL: 'https://api.openai.com/v1', apiKey: 'sk-test' }
        : undefined,
    fetch,
  };
  return { root, storage, options, calls, responses, images: new ImageTools(options) };
}

const call = { sessionId: SES, signal: new AbortController().signal };
/** 正在建、还没写进存储的会话。 */
const CREATING = 'ses_creating' as SessionId;

describe('wevir_image_generate', () => {
  it('只列给 Provider 有图片模型的会话，说明里的那一行跟着工具', async () => {
    const { storage, options } = setup();
    const tools = new AppTools({
      storage,
      events: new EventStore({ storage, deltaWindowMs: 5 }),
      sessions: {
        toolPresetOf: () => undefined,
        creating: (id: SessionId) =>
          id === CREATING ? { workspaceId: 'ws_1', providerId: 'openai' } : undefined,
      } as unknown as SessionManager,
      hostId: 'host_test' as HostId,
      sendWhileBusy: () => 'queue',
      images: options,
    });
    const names = async (id: SessionId | undefined) =>
      (await tools.filterTools(id, tools.tools)).map((tool) => tool.name);
    expect(await names(SES)).toContain(IMAGE_TOOL);
    // 正在建、还没写进存储的会话（引擎建会话时就读工具与说明）按它将要用的 Provider 算。
    expect(await names(CREATING)).toContain(IMAGE_TOOL);
    expect(await tools.toolInstructions(CREATING)).toContain('- wevir_image_generate:');
    expect(await names(SES2)).not.toContain(IMAGE_TOOL);
    expect(await names(undefined)).not.toContain(IMAGE_TOOL);
    expect(await tools.toolInstructions(SES)).toContain('- wevir_image_generate:');
    expect(await tools.toolInstructions(SES2)).not.toContain('wevir_image_generate');
    expect(APP_TOOLS_INSTRUCTIONS).not.toContain('wevir_image_generate');
    // Provider 停用或去掉图片模型后就不列了。
    const record = storage.providers.get('openai');
    if (record) storage.providers.update({ ...record, imageModels: undefined });
    expect(await names(SES)).not.toContain(IMAGE_TOOL);
  });

  it('生成：用第一个图片模型，存进会话目录，结果有路径；模型收图时带上图片', async () => {
    const { images, calls, options } = setup();
    const tool = images.tools[0];
    const result = await tool?.call({ prompt: 'a ceramic mug', name: 'Hero shot!', n: 1 }, call);
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ model: 'gpt-image-2', n: 1 });
    const text = result?.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('Generated 1 image with gpt-image-2');
    const path = /- (\S+\.png) \(1x1\)/.exec(text)?.[1] ?? '';
    expect(path.startsWith(join(options.dir, SES))).toBe(true);
    expect(path).toMatch(/Hero-shot-\d{8}-\d{6}\.png$/);
    expect(readFileSync(path).equals(PNG)).toBe(true);
    expect(result?.content[1]).toEqual({
      type: 'image',
      data: PNG.toString('base64'),
      mimeType: 'image/png',
    });
    expect(text).not.toContain('sk-test');
  });

  it('编辑：读会话目录里的输入图与 mask，发到 /images/edits', async () => {
    const { images, calls, root } = setup();
    writeFileSync(join(root, 'in.png'), PNG);
    writeFileSync(join(root, 'notes.txt'), 'hi');
    const tool = images.tools[0];
    await tool?.call(
      { prompt: 'remove the cup', images: ['in.png'], mask: join(root, 'in.png') },
      call,
    );
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/images/edits');
    await expect(tool?.call({ prompt: 'x', images: ['notes.txt'] }, call)).rejects.toThrow(
      'is not a PNG, JPEG or WebP image',
    );
    await expect(tool?.call({ prompt: 'x', images: ['missing.png'] }, call)).rejects.toThrow(
      'does not exist',
    );
    await expect(tool?.call({ prompt: 'x', mask: 'in.png' }, call)).rejects.toThrow(
      'mask needs the image',
    );
  });

  it('参数检查：模型不在列表里、尺寸格式不对、没有图片模型的会话', async () => {
    const { images } = setup();
    const tool = images.tools[0];
    await expect(tool?.call({ prompt: 'x', model: 'dall-e-3' }, call)).rejects.toThrow(
      'gpt-image-2, gpt-image-1.5',
    );
    await expect(tool?.call({ prompt: 'x', size: 'big' }, call)).rejects.toThrow('size must be');
    await expect(tool?.call({ prompt: 'x', n: 9 }, call)).rejects.toThrow('n must be');
    await expect(tool?.call({ prompt: 'x' }, { ...call, sessionId: SES2 })).rejects.toBeInstanceOf(
      AppToolError,
    );
  });

  it('服务端出错时把原因交给模型', async () => {
    const { images, responses } = setup();
    responses.push(json({ error: { message: 'Your organization must be verified' } }, 403));
    await expect(images.tools[0]?.call({ prompt: 'x' }, call)).rejects.toThrow(
      'The image service answered 403: Your organization must be verified.',
    );
  });

  it('prepareEvent：展示换成 image，结束时带上生成的图片，输出不带 base64', async () => {
    const { images } = setup();
    const started: AgentEvent = {
      type: 'tool.started',
      engineSessionId: 'e1',
      toolCallId: 'call_1',
      toolName: `mcp__wevir__${IMAGE_TOOL}`,
      input: { server: 'wevir', tool: IMAGE_TOOL, arguments: { prompt: 'a mug' } },
    } as AgentEvent;
    expect(images.prepareEvent(SES, started)).toMatchObject({
      display: { kind: 'image', summary: 'a mug' },
    });
    await images.tools[0]?.call({ prompt: 'a mug' }, call);
    const finished = images.prepareEvent(SES, {
      type: 'tool.finished',
      engineSessionId: 'e1',
      toolCallId: 'call_1',
      status: 'completed',
      output: '{"content":[{"type":"image","data":"…"}]}',
    });
    expect(finished.type === 'tool.finished' && finished.images).toEqual([
      { data: PNG.toString('base64') },
    ]);
    expect(finished.type === 'tool.finished' && finished.output).toContain('Generated 1 image');
    // 别的工具原样。
    const other: AgentEvent = {
      type: 'tool.started',
      engineSessionId: 'e1',
      toolCallId: 'call_2',
      toolName: 'mcp__wevir__wevir_show',
      input: { prompt: 'x' },
    } as AgentEvent;
    expect(images.prepareEvent(SES, other)).toBe(other);
  });

  it('文件名主干只留字母数字与连字符', () => {
    expect(fileStem('hero image.png')).toBe('hero-image');
    expect(fileStem('图标/图 1')).toBe('图标-图-1');
    expect(fileStem('...')).toBeUndefined();
    expect(fileStem(undefined)).toBeUndefined();
  });
});
