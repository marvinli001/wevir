import { randomBytes } from 'node:crypto';

// Host 生成的 ID：`<前缀>_<ULID>`（host-api.md §6）。ULID 是 26 位 Crockford Base32：10 位 48 bit
// 毫秒时间戳 + 16 位 80 bit 随机数。不保证同一毫秒内单调；客户端把 ID 当不透明字符串。

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now: number = Date.now()): string {
  let time = '';
  let rest = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  // 每个字节只取低 5 位：256 是 32 的倍数，取值均匀。
  let random = '';
  for (const byte of randomBytes(16)) random += CROCKFORD[byte & 31];
  return time + random;
}

export function newId<P extends string>(prefix: P): `${P}_${string}` {
  return `${prefix}_${ulid()}`;
}
