import { describe, expect, it } from 'vitest';
import { APP_ORIGIN, DEV_SERVER_ORIGIN } from '../shared/renderer-origin.js';
import { allowMicrophoneCheck, allowMicrophoneRequest } from './media-permission.js';

const origin = APP_ORIGIN;

describe('麦克风权限', () => {
  it('只放行应用自己的页面在主框架里只要音频', () => {
    const base = {
      permission: 'media',
      requestingUrl: `${APP_ORIGIN}/index.html`,
      isMainFrame: true,
    };
    expect(allowMicrophoneRequest({ ...base, mediaTypes: ['audio'] }, origin)).toBe(true);
    expect(allowMicrophoneRequest({ ...base, mediaTypes: ['audio', 'video'] }, origin)).toBe(false);
    expect(allowMicrophoneRequest({ ...base, mediaTypes: ['video'] }, origin)).toBe(false);
    expect(allowMicrophoneRequest({ ...base, mediaTypes: [] }, origin)).toBe(false);
    expect(
      allowMicrophoneRequest({ ...base, mediaTypes: ['audio'], isMainFrame: false }, origin),
    ).toBe(false);
    expect(
      allowMicrophoneRequest(
        { ...base, mediaTypes: ['audio'], requestingUrl: 'http://127.0.0.1:5000/x' },
        origin,
      ),
    ).toBe(false);
    expect(allowMicrophoneRequest({ ...base, permission: 'notifications' }, origin)).toBe(false);
    // 开发时页面在开发服务器上。
    expect(
      allowMicrophoneRequest(
        { ...base, mediaTypes: ['audio'], requestingUrl: `${DEV_SERVER_ORIGIN}/` },
        DEV_SERVER_ORIGIN,
      ),
    ).toBe(true);
  });

  it('查询只回答应用自己的页面问麦克风', () => {
    expect(allowMicrophoneCheck('media', origin, 'audio', origin)).toBe(true);
    expect(allowMicrophoneCheck('media', origin, 'video', origin)).toBe(false);
    expect(allowMicrophoneCheck('media', 'http://127.0.0.1:1', 'audio', origin)).toBe(false);
    expect(allowMicrophoneCheck('clipboard-read', origin, undefined, origin)).toBe(false);
  });
});
