import { describe, expect, it, vi } from 'vitest';
import type { SpeechModelPaths } from './install.js';
import { LocalTranscriber, type SherpaModule } from './local.js';

describe('LocalTranscriber', () => {
  it('有模型且首次转写时才加载原生运行体，后续转写复用', async () => {
    let paths: SpeechModelPaths | undefined;
    const createAsync = vi.fn(async () => ({
      createStream: () => ({ acceptWaveform() {} }),
      decodeAsync: async () => ({ text: '' }),
    }));
    const load = vi.fn(
      (): SherpaModule => ({
        OfflineRecognizer: { createAsync },
        Vad: class {
          acceptWaveform() {}
          isEmpty() {
            return true;
          }
          front() {
            return { start: 0, samples: new Float32Array() };
          }
          pop() {}
          flush() {}
        },
      }),
    );
    const local = new LocalTranscriber(load, async () => paths);
    try {
      expect(load).not.toHaveBeenCalled();
      expect(await local.transcribe(new Uint8Array())).toBeUndefined();
      expect(load).not.toHaveBeenCalled();
      paths = { dir: '/model', model: '/model/m', tokens: '/model/t', vad: '/model/v' };
      expect(await local.transcribe(new Uint8Array())).toBe('');
      expect(await local.transcribe(new Uint8Array())).toBe('');
      expect(load).toHaveBeenCalledTimes(1);
      expect(createAsync).toHaveBeenCalledTimes(1);
    } finally {
      local.unload();
    }
  });
});
