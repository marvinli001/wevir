import { REMOTE_NATIVE_ORIGIN } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { type NativeWebSocketConstructor, withNativeOrigin } from './remote';

describe('withNativeOrigin', () => {
  it('replaces the Origin React Native adds with the native-app value', () => {
    const calls: unknown[][] = [];
    const Base = class {
      binaryType = 'blob';
      constructor(...args: unknown[]) {
        calls.push(args);
      }
    } as unknown as NativeWebSocketConstructor;
    const WebSocketImpl = withNativeOrigin(Base);
    const socket = new WebSocketImpl('ws://192.168.1.5:47830/v1/connect');
    expect(socket).toBeInstanceOf(Base);
    expect(calls).toEqual([
      [
        'ws://192.168.1.5:47830/v1/connect',
        undefined,
        { headers: { origin: REMOTE_NATIVE_ORIGIN } },
      ],
    ]);
  });
});
