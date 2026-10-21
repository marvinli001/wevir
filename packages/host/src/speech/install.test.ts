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
  SpeechInstallCancelled,
  SpeechInstallError,
  SpeechModelInstaller,
  type SpeechModelSpec,
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
