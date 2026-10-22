import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_LENGTH } from './cipher-state.js';
import { FrameReader, MAX_FRAGMENT_LENGTH, MAX_FRAME_LENGTH, sealFrame } from './frame.js';
import { expectNoiseError, newPeers, reconnectPair, runHandshake, toHex } from './test-utils.js';

function channel() {
  const reconnect = reconnectPair(newPeers());
  runHandshake(reconnect.device, reconnect.host);
  const device = reconnect.device.split();
  const host = reconnect.host.split();
  return { send: device.send, reader: new FrameReader(host.receive), receive: host.receive };
}

function frameOf(length: number): Uint8Array {
  const frame = new Uint8Array(length);
  for (let i = 0; i < length; i++) frame[i] = (i * 31 + 7) & 0xff;
  return frame;
}

function deliver(reader: FrameReader, messages: readonly Uint8Array[]): Uint8Array {
  let frame: Uint8Array | undefined;
  messages.forEach((message, index) => {
    frame = reader.push(message);
    if (index < messages.length - 1) expect(frame).toBeUndefined();
  });
  if (frame === undefined) throw new Error('frame not complete');
  return frame;
}

describe('frames', () => {
  it('uses 65518 bytes of payload per Noise message', () => {
    expect(MAX_FRAGMENT_LENGTH).toBe(65518);
  });

  it.each([
    [0, 1],
    [1, 1],
    [65517, 1],
    [65518, 1],
    [65519, 2],
    [65518 * 2, 2],
    [65518 * 2 + 1, 3],
    [87 * 1024, 2],
  ])('splits a %i-byte frame into %i message(s) and reassembles it', (length, count) => {
    const { send, reader } = channel();
    const frame = frameOf(length);
    const messages = sealFrame(send, frame);
    expect(messages).toHaveLength(count);
    for (const message of messages) expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(messages.at(-1)?.length).toBe(17 + (length - (count - 1) * MAX_FRAGMENT_LENGTH));
    expect(toHex(deliver(reader, messages))).toBe(toHex(frame));
  });

  it('reassembles consecutive frames on one channel', () => {
    const { send, reader } = channel();
    for (const length of [10, 70000, 0, 3]) {
      const frame = frameOf(length);
      expect(toHex(deliver(reader, sealFrame(send, frame)))).toBe(toHex(frame));
    }
  });

  it('accepts a frame of exactly the limit and rejects one byte more', () => {
    const { send, reader } = channel();
    const frame = frameOf(MAX_FRAME_LENGTH);
    expect(deliver(reader, sealFrame(send, frame))).toHaveLength(MAX_FRAME_LENGTH);
    expectNoiseError(() => sealFrame(send, frameOf(MAX_FRAME_LENGTH + 1)), 'frame_too_large');
  });

  it('stops a peer that sends more than the receiver allows', () => {
    const reconnect = reconnectPair(newPeers());
    runHandshake(reconnect.device, reconnect.host);
    const send = reconnect.device.split().send;
    const reader = new FrameReader(reconnect.host.split().receive, 100_000);
    const messages = sealFrame(send, frameOf(150_000));
    expect(reader.push(messages[0] ?? new Uint8Array())).toBeUndefined();
    expectNoiseError(() => reader.push(messages[1] ?? new Uint8Array()), 'frame_too_large');
    expectNoiseError(() => reader.push(messages[2] ?? new Uint8Array()), 'invalid_state');
  });

  it('rejects an unknown fragment flag', () => {
    const { send, reader } = channel();
    const message = send.encryptWithAd(new Uint8Array(0), Uint8Array.of(2, 1, 2, 3));
    expectNoiseError(() => reader.push(message), 'bad_message');
  });

  it('rejects an empty transport message (no flag byte)', () => {
    const { send, reader } = channel();
    const message = send.encryptWithAd(new Uint8Array(0), new Uint8Array(0));
    expectNoiseError(() => reader.push(message), 'bad_message');
  });

  it('fails on a dropped, replayed or tampered fragment and stays failed', () => {
    for (const mutate of [
      (messages: Uint8Array[]) => [messages[0], messages[2]],
      (messages: Uint8Array[]) => [messages[0], messages[0]],
      (messages: Uint8Array[]) => {
        const copy = Uint8Array.from(messages[1] ?? []);
        copy[100] = (copy[100] ?? 0) ^ 1;
        return [messages[0], copy];
      },
    ]) {
      const { send, reader } = channel();
      const messages = sealFrame(send, frameOf(65518 * 2 + 10));
      const delivered = mutate(messages).map((message) => message ?? new Uint8Array());
      expect(reader.push(delivered[0] ?? new Uint8Array())).toBeUndefined();
      expectNoiseError(() => reader.push(delivered[1] ?? new Uint8Array()), 'decrypt_failed');
      expectNoiseError(() => reader.push(messages[2] ?? new Uint8Array()), 'invalid_state');
    }
  });
});
