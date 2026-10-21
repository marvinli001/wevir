// 听写的音频处理（0.92.0）：客户端送来的是 16 kHz 单声道 16 位小端 PCM。本机识别要 [-1, 1] 的 Float32，转写服务收 WAV 文件。

import { SPEECH_SAMPLE_RATE } from '@wevir/protocol';

/** PCM（`pcm_s16le`）→ [-1, 1] 的 Float32。 */
export function pcmToFloat32(pcm: Uint8Array): Float32Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = new Float32Array(Math.floor(pcm.byteLength / 2));
  for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true) / 32768;
  return samples;
}

/** PCM 加上 44 字节的 RIFF 头，成为 WAV 文件。 */
export function pcmToWav(
  pcm: Uint8Array,
  sampleRate: number = SPEECH_SAMPLE_RATE,
): Uint8Array<ArrayBuffer> {
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) wav[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}

export function durationMsOf(bytes: number, sampleRate: number = SPEECH_SAMPLE_RATE): number {
  return Math.round((bytes / 2 / sampleRate) * 1000);
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;

/** 把几段识别结果接起来：两边都是中日韩文字（含全角标点）时直接接，否则隔一个空格。 */
export function joinSegments(segments: readonly string[]): string {
  let text = '';
  for (const raw of segments) {
    const part = raw.trim();
    if (part === '') continue;
    if (text === '') {
      text = part;
      continue;
    }
    const tight = CJK.test(text.at(-1) ?? '') && CJK.test(part[0] ?? '');
    text += tight ? part : ` ${part}`;
  }
  return text;
}
