// 听写（0.92.0）的 AudioWorklet：AudioContext 已经按 16 kHz 建（浏览器把麦克风重采样过来），这里把单声道的 Float32 帧攒成约
// 100 ms 一段转给主线程（转移所有权，不复制）。在音频线程里跑，不 import 任何东西。

interface AudioWorkletProcessorLike {
  readonly port: MessagePort;
}
declare const AudioWorkletProcessor: {
  prototype: AudioWorkletProcessorLike;
  new (): AudioWorkletProcessorLike;
};
declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessorLike,
): void;

/** 每段的采样数（16 kHz 下 100 ms）。 */
const FRAMES = 1600;

class PcmCapture extends AudioWorkletProcessor {
  #buffer = new Float32Array(FRAMES);
  #filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (channel === undefined) return true;
    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(FRAMES - this.#filled, channel.length - offset);
      this.#buffer.set(channel.subarray(offset, offset + take), this.#filled);
      this.#filled += take;
      offset += take;
      if (this.#filled === FRAMES) {
        this.port.postMessage(this.#buffer, [this.#buffer.buffer]);
        this.#buffer = new Float32Array(FRAMES);
        this.#filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('wevir-pcm-capture', PcmCapture);
