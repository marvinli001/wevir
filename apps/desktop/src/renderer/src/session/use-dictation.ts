// 听写（0.92.0，desktop-layout.md §37）：按住麦克风按钮（或快捷键）录音，松开后交给 Host 转写，文字放进输入框，不自动发送。点一下
// （不到 `DICTATION_HOLD_MS`）是另一种用法：开始录音，再点一下结束。录音时 `getUserMedia` 取麦克风，AudioContext 按 16 kHz 建，
// AudioWorklet（pcm-worklet.ts）把帧交回来，转成 16 位 PCM 每半秒 `speech.append` 一次；松开时补上剩下的再 `speech.finish`。

import type { SessionId } from '@wevir/protocol';
import { SPEECH_MAX_SECONDS } from '@wevir/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useHostConnection } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import {
  DICTATION_HOLD_MS,
  DICTATION_LEVELS_MAX,
  dictationErrorKey,
  floatToPcm16,
  levelOf,
  PcmChunker,
  toBase64,
} from './dictation-model';
import workletUrl from './pcm-worklet.ts?worker&url';

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing';

export interface Dictation {
  /** Host 支持听写（`speech` 功能）。 */
  available: boolean;
  phase: DictationPhase;
  /** 录音以来每 50 ms 一格的音量（0–1），最新的在末尾，最多 `DICTATION_LEVELS_MAX` 格；画波形用。 */
  levels: readonly number[];
  /** 上一次失败的原因；再开始录音时清掉。 */
  error: string | undefined;
  errorKey: PlainMessageKey | undefined;
  /** 按下（按钮的 pointerdown、快捷键的 keydown）。 */
  press(): void;
  /** 松开：按住够久就结束录音并转写，否则进入“点一下”模式，等下一次按下。 */
  release(): void;
  /** 结束录音并转写（录音条上的停止键、发送键），按住或点一下开始的都算。 */
  stop(): void;
  /** 丢掉这次录音（Esc、录音条上的 ✕）。 */
  cancel(): void;
  clearError(): void;
}

interface Recording {
  recordingId: string | undefined;
  stream: MediaStream | undefined;
  context: AudioContext | undefined;
  chunker: PcmChunker;
  offset: number;
  uploads: Promise<void>;
  failure: unknown;
  pressedAt: number;
  /** 点一下开始的：松开不结束。 */
  toggled: boolean;
  stopped: boolean;
  limit: number | undefined;
}

export function useDictation({
  sessionId,
  onText,
}: {
  /** 听写时所在的会话：设置里打开润色时 Host 用它的模型。新会话的草稿页没有。 */
  sessionId?: SessionId | undefined;
  /** 转写出的文字（非空）。 */
  onText: (text: string) => void;
}): Dictation {
  const { client } = useHostConnection();
  const available = client?.supports('speech') === true;
  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [levels, setLevels] = useState<readonly number[]>([]);
  const [errorKey, setErrorKey] = useState<PlainMessageKey>();
  const recording = useRef<Recording | undefined>(undefined);
  const latest = useRef({ client, sessionId, onText });
  latest.current = { client, sessionId, onText };

  const teardown = useCallback((current: Recording) => {
    if (current.limit !== undefined) window.clearTimeout(current.limit);
    for (const track of current.stream?.getTracks() ?? []) track.stop();
    void current.context?.close().catch(() => {});
    current.stream = undefined;
    current.context = undefined;
  }, []);

  const fail = useCallback(
    (current: Recording, error: unknown) => {
      teardown(current);
      if (recording.current === current) recording.current = undefined;
      const { client: active } = latest.current;
      if (current.recordingId !== undefined && active !== undefined) {
        void active.request('speech.discard', { recordingId: current.recordingId }).catch(() => {});
      }
      setErrorKey(dictationErrorKey(error));
      setPhase('idle');
    },
    [teardown],
  );

  const upload = useCallback((current: Recording, chunk: Uint8Array) => {
    const { client: active } = latest.current;
    if (active === undefined || current.recordingId === undefined) return;
    const recordingId = current.recordingId;
    const offset = current.offset;
    current.offset += chunk.byteLength;
    current.uploads = current.uploads.then(async () => {
      if (current.failure !== undefined) return;
      try {
        await active.request('speech.append', { recordingId, offset, data: toBase64(chunk) });
      } catch (error) {
        current.failure = error;
      }
    });
  }, []);

  const finish = useCallback(
    async (current: Recording) => {
      if (current.stopped) return;
      current.stopped = true;
      teardown(current);
      setPhase('transcribing');
      const rest = current.chunker.flush();
      if (rest !== undefined) upload(current, rest);
      await current.uploads;
      const { client: active, sessionId: session, onText: deliver } = latest.current;
      if (recording.current !== current) return;
      recording.current = undefined;
      // 还没开始录就松开了（`speech.begin` 还在路上）：什么都不做，start 回来后会丢掉它。
      if (current.recordingId === undefined) {
        setPhase('idle');
        return;
      }
      if (current.failure !== undefined || active === undefined) {
        fail(current, current.failure);
        return;
      }
      try {
        const result = await active.request('speech.finish', {
          recordingId: current.recordingId,
          ...(session !== undefined && { sessionId: session }),
        });
        if (result.text !== '') deliver(result.text);
        setPhase('idle');
      } catch (error) {
        setErrorKey(dictationErrorKey(error));
        setPhase('idle');
      }
    },
    [fail, teardown, upload],
  );

  const start = useCallback(async () => {
    const { client: active } = latest.current;
    if (active === undefined) return;
    const current: Recording = {
      recordingId: undefined,
      stream: undefined,
      context: undefined,
      chunker: new PcmChunker(),
      offset: 0,
      uploads: Promise.resolve(),
      failure: undefined,
      pressedAt: performance.now(),
      toggled: false,
      stopped: false,
      limit: undefined,
    };
    recording.current = current;
    setErrorKey(undefined);
    setLevels([]);
    setPhase('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      current.stream = stream;
      if (recording.current !== current) {
        teardown(current);
        return;
      }
      const { recordingId } = await active.request('speech.begin', {});
      current.recordingId = recordingId;
      const context = new AudioContext({ sampleRate: 16_000 });
      current.context = context;
      await context.audioWorklet.addModule(workletUrl);
      if (recording.current !== current || current.stopped) {
        teardown(current);
        if (recording.current !== current) {
          void active.request('speech.discard', { recordingId }).catch(() => {});
        }
        return;
      }
      const source = context.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(context, 'wevir-pcm-capture');
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (current.stopped) return;
        const half = event.data.length / 2;
        const next = [levelOf(event.data.subarray(0, half)), levelOf(event.data.subarray(half))];
        setLevels((previous) => [...previous, ...next].slice(-DICTATION_LEVELS_MAX));
        for (const chunk of current.chunker.push(floatToPcm16(event.data))) upload(current, chunk);
      };
      source.connect(node);
      current.limit = window.setTimeout(() => void finish(current), SPEECH_MAX_SECONDS * 1000);
      setPhase('recording');
    } catch (error) {
      fail(current, error);
    }
  }, [fail, finish, teardown, upload]);

  const press = useCallback(() => {
    const current = recording.current;
    if (current === undefined) {
      if (phase === 'transcribing') return;
      void start();
      return;
    }
    // 点一下开始的录音，再按一下结束。
    if (current.toggled) void finish(current);
  }, [finish, phase, start]);

  const release = useCallback(() => {
    const current = recording.current;
    if (current === undefined || current.stopped) return;
    if (current.toggled) return;
    if (performance.now() - current.pressedAt < DICTATION_HOLD_MS) {
      current.toggled = true;
      return;
    }
    void finish(current);
  }, [finish]);

  const stop = useCallback(() => {
    const current = recording.current;
    if (current !== undefined && !current.stopped) void finish(current);
  }, [finish]);

  const cancel = useCallback(() => {
    const current = recording.current;
    if (current === undefined || current.stopped) return;
    current.stopped = true;
    teardown(current);
    recording.current = undefined;
    const { client: active } = latest.current;
    if (current.recordingId !== undefined && active !== undefined) {
      void active.request('speech.discard', { recordingId: current.recordingId }).catch(() => {});
    }
    setPhase('idle');
  }, [teardown]);

  // 离开页面（换会话、关掉输入框）时丢掉还在录的。
  useEffect(() => () => cancel(), [cancel]);

  return {
    available,
    phase,
    levels,
    error: errorKey === undefined ? undefined : t(errorKey),
    errorKey,
    press,
    release,
    stop,
    cancel,
    clearError: () => setErrorKey(undefined),
  };
}
