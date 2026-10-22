import { describe, expect, it } from 'vitest';
import {
  DEVICE_ASSIGNABLE_PERMISSIONS,
  formatPairingCode,
  formatPairingUri,
  normalizePairingCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PairingCodeSchema,
  type PairingPayload,
  parsePairingUri,
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
