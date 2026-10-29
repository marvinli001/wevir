// 听写（Host 功能 `speech`）：点麦克风开始录音，再点结束并转写，文字放进输入框，不自动发送；✕ 丢掉这次录音。录音用 expo-audio 的
// `useAudioStream` 直接取 16 kHz 单声道 16 位 PCM（iOS 按硬件采样率转换，Android 用 AudioRecord），上传与转写在 lib/dictation.ts。
// 装的开发构建还没有 expo-audio 的原生模块时（换了依赖没重新编译）听写不可用，麦克风照旧灰着。

import { SPEECH_MAX_SECONDS, SPEECH_SAMPLE_RATE } from '@wevir/protocol';
import { requireOptionalNativeModule } from 'expo';
import type { AudioStreamBuffer, AudioStreamOptions, AudioStreamResult } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageKey } from '../i18n';
import { DictationUpload, dictationErrorKey, type SpeechClient } from '../lib/dictation';

type ExpoAudio = typeof import('expo-audio');

// 有原生模块才加载 expo-audio（所以用 require）：它在导入时就要 `ExpoAudio`，没有会抛错。
const audio: ExpoAudio | undefined =
  requireOptionalNativeModule('ExpoAudio') !== null
    ? (require('expo-audio') as ExpoAudio)
    : undefined;

const noStream = (_options?: AudioStreamOptions): Partial<AudioStreamResult> => ({});
const useStream: (options?: AudioStreamOptions) => Partial<AudioStreamResult> =
  audio?.useAudioStream ?? noStream;

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing';

export interface Dictation {
  /** 能听写：有原生录音模块，Host 支持 `speech`，这台设备能写。 */
  available: boolean;
  phase: DictationPhase;
  /** 录音开始的时刻（毫秒），录音条计时用。 */
  startedAt: number | undefined;
  start(): void;
  /** 结束录音并转写。 */
  stop(): void;
  /** 丢掉这次录音。 */
  cancel(): void;
}

export function useDictation({
  client,
  sessionId,
  onText,
  onError,
}: {
  /** 没有时不能听写（Host 不支持 `speech`，或这台设备不能写）。 */
  client: SpeechClient | undefined;
  /** 会话页给：Host 开着润色时用这个会话的模型润色。 */
  sessionId?: string;
  onText: (text: string) => void;
  /** 失败（`undefined`：开始新的一次，清掉上一条）。 */
  onError: (key: MessageKey | undefined) => void;
}): Dictation {
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [startedAt, setStartedAt] = useState<number>();
  const upload = useRef<DictationUpload | undefined>(undefined);
  const latest = useRef({ client, sessionId, onText, onError });
  latest.current = { client, sessionId, onText, onError };
  // 停止要在录音的回调里也能调（到上限时），经 ref 拿最新的。
  const stopRef = useRef<() => void>(() => {});

  const onBuffer = useCallback((buffer: AudioStreamBuffer) => {
    const current = upload.current;
    if (current === undefined) return;
    if (buffer.sampleRate !== SPEECH_SAMPLE_RATE || buffer.channels !== 1) {
      // 拿不到 16 kHz 单声道（Android 少数机型）：没法转写，结束这次。
      current.discard();
      upload.current = undefined;
      latest.current.onError('dictation.error.failed');
      stopRef.current();
      return;
    }
    current.push(new Uint8Array(buffer.data));
    if (current.full) stopRef.current();
  }, []);

  const { stream } = useStream({
    sampleRate: SPEECH_SAMPLE_RATE,
    channels: 1,
    encoding: 'int16',
    onBuffer,
  });

  const release = useCallback(() => {
    try {
      stream?.stop();
    } catch {}
    setStartedAt(undefined);
  }, [stream]);

  const stop = useCallback(() => {
    release();
    const current = upload.current;
    upload.current = undefined;
    if (current === undefined) {
      setPhase('idle');
      return;
    }
    setPhase('transcribing');
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    current.finish(latest.current.sessionId).then(
      (text) => {
        if (text !== '') latest.current.onText(text);
        setPhase('idle');
      },
      (error: unknown) => {
        console.warn('[wevir] dictation failed', error);
        latest.current.onError(dictationErrorKey(error));
        setPhase('idle');
      },
    );
  }, [release]);
  stopRef.current = stop;

  const cancel = useCallback(() => {
    release();
    upload.current?.discard();
    upload.current = undefined;
    setPhase('idle');
  }, [release]);

  const start = useCallback(() => {
    const speech = latest.current.client;
    if (audio === undefined || stream === undefined || speech === undefined || phase !== 'idle')
      return;
    latest.current.onError(undefined);
    setPhase('starting');
    void (async () => {
      try {
        const permission = await audio.requestRecordingPermissionsAsync();
        if (!permission.granted) {
          latest.current.onError('dictation.error.micDenied');
          setPhase('idle');
          return;
        }
        upload.current = await DictationUpload.begin(speech);
        await stream.start();
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        setStartedAt(Date.now());
        setPhase('recording');
      } catch (error) {
        console.warn('[wevir] could not start dictation', error);
        upload.current?.discard();
        upload.current = undefined;
        release();
        latest.current.onError(dictationErrorKey(error));
        setPhase('idle');
      }
    })();
  }, [phase, stream, release]);

  // 录到上限就结束（Host 那边超过 `SPEECH_MAX_SECONDS` 也不再收）。
  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = setTimeout(() => stopRef.current(), SPEECH_MAX_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [phase]);

  // 离开页面时丢掉没结束的录音。
  useEffect(
    () => () => {
      upload.current?.discard();
      upload.current = undefined;
    },
    [],
  );

  return {
    available: audio !== undefined && stream !== undefined && client !== undefined,
    phase,
    startedAt,
    start,
    stop,
    cancel,
  };
}
