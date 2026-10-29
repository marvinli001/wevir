import { WevirRpcError } from '@wevir/client-sdk';
import { ErrorCode, SPEECH_MAX_BYTES } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  DICTATION_CHUNK_BYTES,
  DictationUpload,
  dictationErrorKey,
  insertDictation,
  type SpeechClient,
  toBase64,
} from './dictation';

function fakeClient(options: { failAppend?: boolean } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const client: SpeechClient = {
    request: async (method, params) => {
      calls.push({ method, params: params as Record<string, unknown> });
      if (method === 'speech.begin') return { recordingId: 'rec_test0001' } as never;
      if (method === 'speech.append') {
        if (options.failAppend) throw new Error('append failed');
        return { receivedBytes: 0 } as never;
      }
      if (method === 'speech.finish')
        return { text: ' 你好 ', transcriber: { kind: 'local' }, durationMs: 10 } as never;
      return {} as never;
    },
  };
  return { client, calls };
}

describe('dictation', () => {
  it('攒满一块就传，结束时补上剩下的再转写', async () => {
    const { client, calls } = fakeClient();
    const upload = await DictationUpload.begin(client);
    upload.push(new Uint8Array(DICTATION_CHUNK_BYTES + 100));
    upload.push(new Uint8Array(51));
    expect(await upload.finish('ses_1')).toBe('你好');
    const appends = calls.filter((c) => c.method === 'speech.append');
    expect(appends.map((c) => c.params.offset)).toEqual([0, DICTATION_CHUNK_BYTES]);
    // 奇数字节截掉最后一个。
    expect(Buffer.from(appends[1]?.params.data as string, 'base64').byteLength).toBe(150);
    expect(calls.at(-1)).toEqual({
      method: 'speech.finish',
      params: { recordingId: 'rec_test0001', sessionId: 'ses_1' },
    });
  });

  it('到上限就不再收', async () => {
    const { client } = fakeClient();
    const upload = await DictationUpload.begin(client);
    upload.push(new Uint8Array(SPEECH_MAX_BYTES + 1000));
    expect(upload.full).toBe(true);
    upload.discard();
  });

  it('上传失败时 finish 抛错并丢掉录音', async () => {
    const { client, calls } = fakeClient({ failAppend: true });
    const upload = await DictationUpload.begin(client);
    upload.push(new Uint8Array(DICTATION_CHUNK_BYTES));
    await expect(upload.finish()).rejects.toThrow('append failed');
    expect(calls.map((c) => c.method)).toEqual(['speech.begin', 'speech.append', 'speech.discard']);
  });

  it('base64 与 Node 的一致', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 300]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37) % 256);
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  it('错误按原因归类', () => {
    const failed = new WevirRpcError('speech.finish', {
      code: ErrorCode.SPEECH_FAILED,
      message: 'failed',
      data: { reason: 'model_missing' },
    });
    expect(dictationErrorKey(failed)).toBe('dictation.error.modelMissing');
    expect(dictationErrorKey(new Error('x'))).toBe('dictation.error.failed');
  });

  it('转写的文字放到光标处，英文前后补空格', () => {
    expect(insertDictation('发给', 2, '林')).toEqual({ text: '发给林', cursor: 3 });
    expect(insertDictation('Send to', 7, 'Lin')).toEqual({ text: 'Send to Lin', cursor: 11 });
  });
});
