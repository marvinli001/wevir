import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REMOTE_SETTINGS,
  DEVICE_ASSIGNABLE_PERMISSIONS,
  formatPairingCode,
  formatPairingUri,
  formatWebPairingUrl,
  normalizePairingCode,
  OFFICIAL_RELAY_URL,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PairingCodeSchema,
  type PairingPayload,
  parsePairingUri,
  type RemoteSettings,
  RemoteSettingsSchema,
  relayConfigured,
  relayMode,
  WEB_CLIENT_DEFAULT_URL,
  WebClientUrlSchema,
  webClientUrl,
  webDeviceIdleDays,
} from './devices.js';

const KEY = 'q0XrYwM1Xk1vH2C6uWqG5yQyq9b0mW0n8Sx3cG1fYQE';
const ROUTE = 'Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg';
const SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

const payload: PairingPayload = {
  hostPublicKey: KEY,
  routeId: ROUTE,
  secret: SECRET,
  hostName: 'Marvin 的 Mac',
  candidates: [
    { host: '192.168.1.20', port: 47900 },
    { host: 'fd7a:115c:a1e0::1', port: 47900 },
    { host: 'mac.tail1234.ts.net', port: 47900 },
  ],
  relayUrl: 'wss://relay.example.com/r',
};

describe('二维码载荷', () => {
  it('写出的 URI 按固定顺序、能原样读回', () => {
    const uri = formatPairingUri(payload);
    expect(uri.startsWith(`wevir://pair?v=1&k=${KEY}&r=${ROUTE}&s=${SECRET}&n=`)).toBe(true);
    expect(uri).toContain('&a=%5Bfd7a%3A115c%3Aa1e0%3A%3A1%5D%3A47900');
    expect(parsePairingUri(uri)).toEqual(payload);
  });

  it('只有必需的参数时也能读', () => {
    const minimal = { hostPublicKey: KEY, routeId: ROUTE, secret: SECRET, candidates: [] };
    expect(parsePairingUri(formatPairingUri(minimal))).toEqual(minimal);
  });

  it('忽略不认识的参数', () => {
    expect(parsePairingUri(`${formatPairingUri(payload)}&x=1`)).toEqual(payload);
  });

  it('格式、版本或必需参数不对时返回 null', () => {
    const uri = formatPairingUri(payload);
    expect(parsePairingUri(uri.replace('wevir://pair?', 'https://pair?'))).toBeNull();
    expect(parsePairingUri(uri.replace('v=1', 'v=2'))).toBeNull();
    expect(parsePairingUri(uri.replace(`k=${KEY}`, 'k=short'))).toBeNull();
    expect(parsePairingUri(uri.replace(`s=${SECRET}`, `s=${SECRET.slice(0, 22)}`))).toBeNull();
    expect(parsePairingUri(uri.replace(`&r=${ROUTE}`, ''))).toBeNull();
    expect(parsePairingUri(uri.replace('47900', '70000'))).toBeNull();
    expect(
      parsePairingUri(formatPairingUri({ ...payload, relayUrl: 'https://relay.example.com' })),
    ).toBeNull();
  });
});

describe('网页配对链接（0.117.0）', () => {
  it('官方网页地址加 /pair，参数与 wevir://pair? 完全相同、放在 # 后面', () => {
    const url = formatWebPairingUrl(payload);
    expect(url.startsWith(`${WEB_CLIENT_DEFAULT_URL}/pair#v=1&k=${KEY}`)).toBe(true);
    expect(url.slice(url.indexOf('#') + 1)).toBe(
      formatPairingUri(payload).slice('wevir://pair?'.length),
    );
    expect(parsePairingUri(url)).toEqual(payload);
  });

  it('自建的网页地址可以带路径，末尾的 / 去掉', () => {
    const url = formatWebPairingUrl(payload, 'https://example.com/wevir/');
    expect(url.startsWith('https://example.com/wevir/pair#v=1&')).toBe(true);
    expect(parsePairingUri(url)).toEqual(payload);
    const local = formatWebPairingUrl(payload, 'http://localhost:5173');
    expect(parsePairingUri(local)).toEqual(payload);
    expect(parsePairingUri(formatWebPairingUrl(payload, 'http://127.0.0.1:8080'))).toEqual(payload);
  });

  it('没有中继地址时写不出、也读不进来', () => {
    const { relayUrl: _relay, ...direct } = payload;
    expect(() => formatWebPairingUrl(direct)).toThrow();
    const params = formatPairingUri(direct).slice('wevir://pair?'.length);
    expect(parsePairingUri(`https://web.wevir.si/pair#${params}`)).toBeNull();
    // wevir:// 的链接不要求中继。
    expect(parsePairingUri(formatPairingUri(direct))).toEqual(direct);
  });

  it('路径不是 /pair、参数不在 # 后面、非回环地址用 http 时返回 null', () => {
    const params = formatPairingUri(payload).slice('wevir://pair?'.length);
    expect(parsePairingUri(`https://web.wevir.si/pair#${params}`)).toEqual(payload);
    expect(parsePairingUri(`https://web.wevir.si/pair/#${params}`)).toEqual(payload);
    expect(parsePairingUri(`https://web.wevir.si/other#${params}`)).toBeNull();
    expect(parsePairingUri(`https://web.wevir.si/pair?${params}`)).toBeNull();
    expect(parsePairingUri(`https://web.wevir.si/pair#`)).toBeNull();
    expect(parsePairingUri(`http://web.wevir.si/pair#${params}`)).toBeNull();
    expect(parsePairingUri(`http://192.168.1.2/pair#${params}`)).toBeNull();
    expect(parsePairingUri(`ftp://web.wevir.si/pair#${params}`)).toBeNull();
    expect(parsePairingUri(`https://web.wevir.si/pair#${params.replace('v=1', 'v=2')}`)).toBeNull();
  });

  it('网页客户端地址：https，或回环地址上的 http；不带查询与 #', () => {
    expect(WebClientUrlSchema.safeParse('https://web.wevir.si').success).toBe(true);
    expect(WebClientUrlSchema.safeParse('https://example.com/wevir').success).toBe(true);
    expect(WebClientUrlSchema.safeParse('http://localhost:5173').success).toBe(true);
    expect(WebClientUrlSchema.safeParse('http://[::1]:5173').success).toBe(true);
    expect(WebClientUrlSchema.safeParse('http://example.com').success).toBe(false);
    expect(WebClientUrlSchema.safeParse('https://example.com/?a=1').success).toBe(false);
    expect(WebClientUrlSchema.safeParse('https://example.com/#x').success).toBe(false);
    expect(WebClientUrlSchema.safeParse('wss://example.com').success).toBe(false);
  });
});

describe('中继的三态与网页设置（0.117.0）', () => {
  const remote = (relay: RemoteSettings['relay']): RemoteSettings => ({
    ...DEFAULT_REMOTE_SETTINGS,
    enabled: true,
    relay,
  });

  it('关、官方、自建', () => {
    expect(relayMode(remote({ enabled: false }))).toBe('off');
    expect(relayMode(remote({ enabled: false, mode: 'official' }))).toBe('off');
    expect(relayConfigured(remote({ enabled: false, mode: 'official' }))).toBeUndefined();
    expect(relayMode(remote({ enabled: true, mode: 'official' }))).toBe('official');
    expect(relayConfigured(remote({ enabled: true, mode: 'official' }))).toBe(OFFICIAL_RELAY_URL);
    // 选了官方时自建的地址留着，但不用。
    expect(
      relayConfigured(remote({ enabled: true, mode: 'official', url: 'wss://relay.example.com' })),
    ).toBe(OFFICIAL_RELAY_URL);
    expect(
      relayConfigured(remote({ enabled: true, mode: 'custom', url: 'wss://relay.example.com' })),
    ).toBe('wss://relay.example.com');
    expect(relayMode(remote({ enabled: true, mode: 'custom' }))).toBe('off');
  });

  it('旧设置：开着且填了地址是自建，开着没填地址是关，官方地址从不作默认', () => {
    const custom = RemoteSettingsSchema.parse(
      remote({ enabled: true, url: 'wss://relay.example.com' }),
    );
    expect(relayMode(custom)).toBe('custom');
    expect(relayConfigured(custom)).toBe('wss://relay.example.com');
    const blank = RemoteSettingsSchema.parse(remote({ enabled: true }));
    expect(relayMode(blank)).toBe('off');
    expect(relayConfigured(blank)).toBeUndefined();
    expect(relayConfigured(DEFAULT_REMOTE_SETTINGS)).toBeUndefined();
    expect(
      RemoteSettingsSchema.safeParse(remote({ enabled: true, mode: 'other' as never })).success,
    ).toBe(false);
  });

  it('网页地址与闲置天数的默认值', () => {
    expect(webClientUrl(DEFAULT_REMOTE_SETTINGS)).toBe(WEB_CLIENT_DEFAULT_URL);
    expect(webDeviceIdleDays(DEFAULT_REMOTE_SETTINGS)).toBe(30);
    const web = RemoteSettingsSchema.parse({
      ...DEFAULT_REMOTE_SETTINGS,
      web: { url: 'https://example.com/wevir', idleDays: 0 },
    });
    expect(webClientUrl(web)).toBe('https://example.com/wevir');
    expect(webDeviceIdleDays(web)).toBe(0);
    expect(
      RemoteSettingsSchema.safeParse({ ...DEFAULT_REMOTE_SETTINGS, web: { idleDays: -1 } }).success,
    ).toBe(false);
    expect(
      RemoteSettingsSchema.safeParse({ ...DEFAULT_REMOTE_SETTINGS, web: { idleDays: 1.5 } })
        .success,
    ).toBe(false);
  });
});

describe('短码', () => {
  it('字符表是 32 个字符，不含 I L O U', () => {
    expect(new Set(PAIRING_CODE_ALPHABET).size).toBe(32);
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[ILOU]/);
    expect(PAIRING_CODE_LENGTH).toBe(8);
    expect(PairingCodeSchema.safeParse('7KQ2M9XD').success).toBe(true);
    expect(PairingCodeSchema.safeParse('7KQ2M9XU').success).toBe(false);
  });

  it('手输的短码规范成大写、去掉分隔，I L 当 1、O 当 0', () => {
    expect(normalizePairingCode('7kq2-m9xd')).toBe('7KQ2M9XD');
    expect(normalizePairingCode(' 7KQ2 M9XD ')).toBe('7KQ2M9XD');
    expect(normalizePairingCode('IL0O-ABCD')).toBe('1100ABCD');
    expect(normalizePairingCode('7KQ2-M9X')).toBeNull();
    expect(normalizePairingCode('7KQ2-M9XU')).toBeNull();
    expect(formatPairingCode('7KQ2M9XD')).toBe('7KQ2-M9XD');
  });
});

it('能给设备的权限不含 host.manage', () => {
  expect(DEVICE_ASSIGNABLE_PERMISSIONS).not.toContain('host.manage');
  expect(DEVICE_ASSIGNABLE_PERMISSIONS).toContain('terminal.write');
});
