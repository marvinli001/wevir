import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpeechInstallProgress } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  mirroredUrl,
  SENSE_VOICE_SMALL,
  SPEECH_MIRRORS,
  SpeechInstallCancelled,
  SpeechInstallError,
  type SpeechMirror,
  SpeechModelInstaller,
  type SpeechModelSpec,
  speechSourcesOf,
} from './install.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wevir-speech-'));
  dirs.push(dir);
  return dir;
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const archive = Buffer.from('fake archive');
const vad = Buffer.from('fake vad');

const spec: SpeechModelSpec = {
  key: 'test-model',
  name: 'Test',
  assets: [
    {
      url: 'https://github.com/x/y/releases/download/t/model.tar.bz2',
      sha256: sha256(archive),
      size: archive.byteLength,
      fileName: 'model.tar.bz2',
      extract: ['inner/model.int8.onnx', 'inner/tokens.txt'],
    },
    {
      url: 'https://github.com/x/y/releases/download/t/silero_vad.onnx',
      sha256: sha256(vad),
      size: vad.byteLength,
      fileName: 'silero_vad.onnx',
    },
  ],
  files: { model: 'model.int8.onnx', tokens: 'tokens.txt', vad: 'silero_vad.onnx' },
};

function fakeFetch(bodies: Record<string, Buffer>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const body = Object.entries(bodies).find(([suffix]) => url.endsWith(suffix))?.[1];
    if (body === undefined) return new Response('missing', { status: 404 });
    return new Response(new Uint8Array(body), {
      headers: { 'content-length': String(body.byteLength) },
    });
  }) as typeof fetch;
}

async function fakeExtract(
  _archive: string,
  entries: readonly string[],
  destination: string,
): Promise<void> {
  for (const entry of entries) {
    await fsp.mkdir(join(destination, entry, '..'), { recursive: true });
    await fsp.writeFile(join(destination, entry), `content of ${entry}`);
  }
}

describe('SpeechModelInstaller', () => {
  it('下载、核对、只解出要的文件，装好后整个目录改名到位', async () => {
    const directory = tempDir();
    const progress: SpeechInstallProgress[] = [];
    const installer = new SpeechModelInstaller({
      directory,
      spec,
      mirrors: [],
      fetch: fakeFetch({ 'model.tar.bz2': archive, 'silero_vad.onnx': vad }),
      extract: fakeExtract,
      progressIntervalMs: 0,
    });
    expect(await installer.installed()).toBeUndefined();
    const paths = await installer.install((p) => progress.push(p));
    expect(paths.dir).toBe(join(directory, 'test-model'));
    expect(readFileSync(paths.model, 'utf8')).toBe('content of inner/model.int8.onnx');
    expect(readFileSync(paths.vad)).toEqual(vad);
    expect(await installer.installed()).toEqual(paths);
    // 没有留下下载的临时目录。
    expect(readdirSync(directory)).toEqual(['test-model']);
    expect(progress.map((p) => p.phase)).toContain('extracting');
    expect(progress.at(-1)).toEqual({
      phase: 'verifying',
      completedBytes: archive.byteLength + vad.byteLength,
      totalBytes: archive.byteLength + vad.byteLength,
    });
    expect(await installer.installedBytes()).toBeGreaterThan(0);
    await installer.uninstall();
    expect(existsSync(paths.dir)).toBe(false);
  });

  it('sha256 不对时失败，不留下半成品', async () => {
    const directory = tempDir();
    const installer = new SpeechModelInstaller({
      directory,
      spec,
      mirrors: [],
      fetch: fakeFetch({ 'model.tar.bz2': Buffer.from('tampered'), 'silero_vad.onnx': vad }),
      extract: fakeExtract,
    });
    await expect(installer.install(() => {})).rejects.toBeInstanceOf(SpeechInstallError);
    expect(readdirSync(directory)).toEqual([]);
    expect(installer.installing).toBe(false);
  });

  it('下载地址回错误时失败', async () => {
    const installer = new SpeechModelInstaller({
      directory: tempDir(),
      spec,
      mirrors: [],
      fetch: fakeFetch({}),
      extract: fakeExtract,
    });
    await expect(installer.install(() => {})).rejects.toThrow(/answered 404/);
  });

  it('取消时抛 SpeechInstallCancelled', async () => {
    const directory = tempDir();
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const installer = new SpeechModelInstaller({
      directory,
      spec,
      mirrors: [],
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        await blocked;
        init?.signal?.throwIfAborted();
        return new Response(new Uint8Array(archive));
      }) as typeof fetch,
      extract: fakeExtract,
    });
    const done = installer.install(() => {});
    expect(installer.installing).toBe(true);
    installer.cancel();
    release();
    await expect(done).rejects.toBeInstanceOf(SpeechInstallCancelled);
    expect(readdirSync(directory).filter((entry) => !entry.startsWith('.'))).toEqual([]);
  });

  it('WEVIR_GITHUB_MIRROR 替换 GitHub 的前缀', async () => {
    const seen: string[] = [];
    const installer = new SpeechModelInstaller({
      directory: tempDir(),
      spec,
      mirrors: [],
      env: { WEVIR_GITHUB_MIRROR: 'https://mirror.example/gh/' },
      fetch: fakeFetch({ 'model.tar.bz2': archive, 'silero_vad.onnx': vad }, seen),
      extract: fakeExtract,
    });
    await installer.install(() => {});
    expect(seen[0]).toBe('https://mirror.example/gh/x/y/releases/download/t/model.tar.bz2');
    expect(mirroredUrl('https://example.com/a', { WEVIR_GITHUB_MIRROR: 'https://m' })).toBe(
      'https://example.com/a',
    );
  });

  it('默认的模型是 SenseVoice Small 与 Silero VAD，sha256 都写死', () => {
    expect(SENSE_VOICE_SMALL.assets).toHaveLength(2);
    for (const asset of SENSE_VOICE_SMALL.assets) {
      expect(asset.url.startsWith('https://github.com/k2-fsa/sherpa-onnx/releases/')).toBe(true);
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('下载线路', () => {
  const mirrors: SpeechMirror[] = [
    {
      id: 'github',
      url: 'https://github.com/o/r/releases/download/speech-models',
      layout: 'release',
    },
    { id: 'r2', url: 'https://r2.example/speech' },
    { id: 'global', url: 'https://global.example/speech', fallback: true },
  ];
  const upstream = {
    archive: 'https://github.com/x/y/releases/download/t/model.tar.bz2',
    vad: 'https://github.com/x/y/releases/download/t/silero_vad.onnx',
  };
  const at = {
    github: 'https://github.com/o/r/releases/download/speech-models/test-model-model.tar.bz2',
    r2: 'https://r2.example/speech/test-model/model.tar.bz2',
    global: 'https://global.example/speech/test-model/model.tar.bz2',
  };

  /** 按完整地址回应；`hang` 里的地址一直不回，直到请求被取消。 */
  function routedFetch(
    routes: Record<string, Buffer>,
    seen: string[],
    hang: readonly string[] = [],
    aborted: string[] = [],
  ): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (hang.includes(url)) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted.push(url);
            reject(init.signal?.reason);
          });
        });
      }
      const body = routes[url];
      if (body === undefined) return new Response('missing', { status: 404 });
      return new Response(new Uint8Array(body));
    }) as typeof fetch;
  }

  it('地址：GitHub 与 R2 是主线路，Bunny 与上游依次兜底', () => {
    const [asset] = spec.assets;
    if (asset === undefined) throw new Error('no asset');
    expect(speechSourcesOf(spec, asset, mirrors, {})).toEqual({
      primary: [at.github, at.r2],
      fallback: [at.global, upstream.archive],
    });
    expect(
      speechSourcesOf(spec, asset, mirrors, {
        WEVIR_GITHUB_MIRROR: 'https://m.example',
      }).primary[0],
    ).toBe('https://m.example/o/r/releases/download/speech-models/test-model-model.tar.bz2');
    expect(SPEECH_MIRRORS.map((mirror) => mirror.id)).toEqual(['github', 'r2', 'global']);
    const vadAsset = SENSE_VOICE_SMALL.assets[1];
    if (vadAsset === undefined) throw new Error('no VAD asset');
    expect(speechSourcesOf(SENSE_VOICE_SMALL, vadAsset, SPEECH_MIRRORS, {})).toEqual({
      primary: [
        'https://github.com/marvinli001/wevir/releases/download/speech-models/sense-voice-small-int8-2025-09-09-silero_vad.onnx',
        'https://dl.edgeweir.com/speech/sense-voice-small-int8-2025-09-09/silero_vad.onnx',
      ],
      fallback: [
        'https://download.wevir.si/speech/sense-voice-small-int8-2025-09-09/silero_vad.onnx',
        vadAsset.url,
      ],
    });
  });

  it('主线路竞速：先回应的那条下载，另一条取消', async () => {
    const seen: string[] = [];
    const aborted: string[] = [];
    const installer = new SpeechModelInstaller({
      directory: tempDir(),
      spec,
      mirrors,
      fetch: routedFetch(
        {
          [at.r2]: archive,
          'https://r2.example/speech/test-model/silero_vad.onnx': vad,
        },
        seen,
        [
          at.github,
          'https://github.com/o/r/releases/download/speech-models/test-model-silero_vad.onnx',
        ],
        aborted,
      ),
      extract: fakeExtract,
    });
    await installer.install(() => {});
    expect(aborted).toEqual([
      at.github,
      'https://github.com/o/r/releases/download/speech-models/test-model-silero_vad.onnx',
    ]);
    expect(seen.some((url) => url.startsWith('https://global.example/'))).toBe(false);
  });

  it('主线路都不行时用后备，后备也不行时用上游', async () => {
    const seen: string[] = [];
    const installer = new SpeechModelInstaller({
      directory: tempDir(),
      spec,
      mirrors,
      fetch: routedFetch(
        {
          [upstream.archive]: archive,
          'https://global.example/speech/test-model/silero_vad.onnx': vad,
        },
        seen,
      ),
      extract: fakeExtract,
    });
    await installer.install(() => {});
    expect(seen.slice(0, 4)).toEqual([at.github, at.r2, at.global, upstream.archive]);
    expect(seen).not.toContain(upstream.vad);
  });

  it('下载的内容对不上时换下一条线路', async () => {
    const seen: string[] = [];
    const installer = new SpeechModelInstaller({
      directory: tempDir(),
      spec,
      mirrors: mirrors.slice(1),
      fetch: routedFetch(
        {
          [at.r2]: Buffer.from('tampered'),
          [at.global]: archive,
          'https://r2.example/speech/test-model/silero_vad.onnx': vad,
        },
        seen,
      ),
      extract: fakeExtract,
    });
    await installer.install(() => {});
    expect(seen.slice(0, 2)).toEqual([at.r2, at.global]);
  });

  it('都失败时错误里列出每条线路的原因', async () => {
    const installer = new SpeechModelInstaller({
      directory: tempDir(),
      spec,
      mirrors,
      fetch: routedFetch({ [at.r2]: Buffer.from('tampered') }, []),
      extract: fakeExtract,
    });
    const error = await installer.install(() => {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpeechInstallError);
    expect((error as Error).message).toMatch(
      /github\.com: answered 404.*r2\.example: the file did not match.*global\.example: answered 404.*github\.com: answered 404/,
    );
  });
});
