import { WevirRpcError } from '@wevir/client-sdk';
import { describe, expect, it } from 'vitest';
import {
  dictationErrorKey,
  floatToPcm16,
  insertDictation,
  levelOf,
  PcmChunker,
  toBase64,
} from './dictation-model';

describe('听写的采样与分段', () => {
  it('Float32 截到范围内转成 16 位整数', () => {
    expect([...floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]))]).toEqual([
      0, 32767, -32768, 32767, -32768, 16383,
    ]);
  });

  it('攒满一块才交出，剩下的由 flush 取走', () => {
    const chunker = new PcmChunker(8);
    expect(chunker.push(new Int16Array([1, 2, 3]))).toEqual([]);
    const full = chunker.push(new Int16Array([4, 5, 6]));
    expect(full).toHaveLength(1);
    expect([...new Int16Array(full[0]?.buffer ?? new ArrayBuffer(0))]).toEqual([1, 2, 3, 4]);
    expect([...new Int16Array(chunker.flush()?.buffer ?? new ArrayBuffer(0))]).toEqual([5, 6]);
    expect(chunker.flush()).toBeUndefined();
  });

  it('Base64 与音量', () => {
    expect(toBase64(new Uint8Array([0, 1, 2, 255]))).toBe('AAEC/w==');
    expect(levelOf(new Float32Array())).toBe(0);
    expect(levelOf(new Float32Array([1, -1]))).toBe(1);
    expect(levelOf(new Float32Array([0.1, -0.1]))).toBeCloseTo(0.506, 2);
  });
});

describe('听写的错误', () => {
  const failed = (reason: string) =>
    new WevirRpcError('speech.finish', { code: -32042, message: 'x', data: { reason } });

  it('Host 的原因与麦克风的错误各有说法', () => {
    expect(dictationErrorKey(failed('model_missing'))).toBe('dictation.error.modelMissing');
    expect(dictationErrorKey(failed('provider_error'))).toBe('dictation.error.providerError');
    expect(dictationErrorKey(new DOMException('no', 'NotAllowedError'))).toBe(
      'dictation.error.micDenied',
    );
    expect(dictationErrorKey(new DOMException('none', 'NotFoundError'))).toBe(
      'dictation.error.noMic',
    );
    expect(dictationErrorKey(new Error('boom'))).toBe('dictation.error.failed');
  });
});

describe('转写的文字放进输入框', () => {
  it('放在光标处，字母数字之间补空格，中文不补', () => {
    expect(insertDictation('', 0, '你好')).toEqual({ text: '你好', cursor: 2 });
    expect(insertDictation('hello', 5, 'world')).toEqual({ text: 'hello world', cursor: 11 });
    expect(insertDictation('ab', 1, 'X')).toEqual({ text: 'a X b', cursor: 4 });
    expect(insertDictation('前文', 2, '后文')).toEqual({ text: '前文后文', cursor: 4 });
    expect(insertDictation('fix ', 4, 'it')).toEqual({ text: 'fix it', cursor: 6 });
    expect(insertDictation('abc', 99, '中')).toEqual({ text: 'abc中', cursor: 4 });
  });
});
