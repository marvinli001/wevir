// 本机识别的真实测试：要已下载的 SenseVoice Small 与 Silero VAD。默认跳过；设 `WEVIR_TEST_SPEECH_MODEL` 为放着 `model.int8.onnx`、
// `tokens.txt`、`silero_vad.onnx` 的目录（如数据目录的 `speech/sense-voice-small-int8-2025-09-09/`），`WEVIR_TEST_SPEECH_WAV` 为一段
// 16 kHz 单声道 16 位的中文 WAV（模型压缩包里的 `test_wavs/zh.wav`，内容是“开放时间早上九点至下午五点”）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalTranscriber, loadSherpa } from './local.js';

const modelDir = process.env.WEVIR_TEST_SPEECH_MODEL;
const wav = process.env.WEVIR_TEST_SPEECH_WAV;
const skip = modelDir === undefined || wav === undefined;
if (skip) {
  console.log('跳过本机识别的真实测试：设 WEVIR_TEST_SPEECH_MODEL 与 WEVIR_TEST_SPEECH_WAV');
}

describe.skipIf(skip)('LocalTranscriber（真实模型）', () => {
  it('转写中文 WAV，静音得到空串', async () => {
    const sherpa = loadSherpa();
    expect(sherpa).toBeDefined();
    if (sherpa === undefined || modelDir === undefined || wav === undefined) return;
    const paths = {
      dir: modelDir,
      model: join(modelDir, 'model.int8.onnx'),
      tokens: join(modelDir, 'tokens.txt'),
      vad: join(modelDir, 'silero_vad.onnx'),
    };
    const local = new LocalTranscriber(sherpa, async () => paths);
    // 去掉 44 字节的 WAV 头，剩下 PCM。
    const pcm = readFileSync(wav).subarray(44);
    const text = await local.transcribe(pcm);
    expect(text).toContain('九点');
    expect(await local.transcribe(new Uint8Array(32_000))).toBe('');
    local.unload();
  }, 60_000);
});
