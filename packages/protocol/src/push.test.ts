import { describe, expect, it } from 'vitest';
import {
  PUSH_GATEWAY_PATHS,
  PUSH_GATEWAY_URL,
  PUSH_PAYLOAD_MAX_LENGTH,
  PUSH_REQUEST_MAX_BYTES,
  pushSignatureMessage,
} from './index.js';

describe('pushSignatureMessage', () => {
  it('用途前缀、路径与原样的请求体字节', () => {
    const body = new TextEncoder().encode('{"a":1}');
    expect(new TextDecoder().decode(pushSignatureMessage(PUSH_GATEWAY_PATHS.send, body))).toBe(
      'wevir-push/1 /v1/send\n{"a":1}',
    );
  });

  it('不同路径的签名内容不同：bind 的签名不能拿去 send', () => {
    const body = new Uint8Array([1, 2, 3]);
    expect(pushSignatureMessage(PUSH_GATEWAY_PATHS.bind, body)).not.toEqual(
      pushSignatureMessage(PUSH_GATEWAY_PATHS.send, body),
    );
  });
});

describe('推送网关的常量', () => {
  it('官方地址是 https，载荷放得进请求体', () => {
    expect(new URL(PUSH_GATEWAY_URL).protocol).toBe('https:');
    expect(PUSH_PAYLOAD_MAX_LENGTH).toBeLessThan(PUSH_REQUEST_MAX_BYTES / 2);
  });
});
