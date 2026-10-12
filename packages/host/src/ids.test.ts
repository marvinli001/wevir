import { ApprovalIdSchema, SessionIdSchema, StreamIdSchema, TurnIdSchema } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { newId, ulid } from './ids.js';

describe('ids', () => {
  it('ULID 是 26 位 Crockford Base32，前 10 位是毫秒时间戳', () => {
    const id = ulid(Date.UTC(2026, 9, 13));
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ulid(0).slice(0, 10)).toBe('0000000000');
    expect(ulid(2 ** 48 - 1).slice(0, 10)).toBe('7ZZZZZZZZZ');
    // 时间部分按字典序递增。
    expect(ulid(1000).slice(0, 10) < ulid(1001).slice(0, 10)).toBe(true);
  });

  it('newId 带前缀，符合 protocol 的 ID schema，且不重复', () => {
    expect(SessionIdSchema.safeParse(newId('ses')).success).toBe(true);
    expect(TurnIdSchema.safeParse(newId('trn')).success).toBe(true);
    expect(ApprovalIdSchema.safeParse(newId('apr')).success).toBe(true);
    expect(StreamIdSchema.safeParse(newId('stm')).success).toBe(true);
    const ids = new Set(Array.from({ length: 1000 }, () => newId('ses')));
    expect(ids.size).toBe(1000);
  });
});
