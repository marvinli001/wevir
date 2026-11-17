import { describe, expect, it } from 'vitest';
import {
  MethodSchemas,
  PUSH_GATEWAY_PATHS,
  PUSH_GATEWAY_URL,
  PUSH_PAYLOAD_MAX_LENGTH,
  PUSH_REQUEST_MAX_BYTES,
  PushMessageSchema,
  pushSignatureMessage,
} from './index.js';

describe('助理推送兼容', () => {
  const legacy = {
    v: 1,
    id: 'channel:cpo_1',
    kind: 'channel',
    category: 'completion',
    title: 'Inbox',
    host: 'Mac',
    channelId: 'chn_1',
    createdAt: '2026-11-17T00:00:00.000Z',
  };
  it('旧载荷仍有效，正文和序号都是可选字段', () => {
    expect(PushMessageSchema.parse(legacy)).toEqual(legacy);
    expect(PushMessageSchema.parse({ ...legacy, body: '😀'.repeat(120), seq: 9 })).toMatchObject({
      seq: 9,
    });
    expect(PushMessageSchema.safeParse({ ...legacy, seq: 0 }).success).toBe(false);
    expect(PushMessageSchema.safeParse({ ...legacy, seq: '9' }).success).toBe(false);
  });
  it('暂停只需写会话，修改资料仍需写项目；设备偏好只需读取会话', () => {
    expect(MethodSchemas['channel.pause'].permission).toBe('session.write');
    expect(MethodSchemas['channel.update'].permission).toBe('workspace.write');
    expect(MethodSchemas['push.update'].permission).toBe('session.read');
  });
});

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
