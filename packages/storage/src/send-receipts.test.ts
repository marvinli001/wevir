import { describe, expect, it } from 'vitest';
import { requestFingerprint, type SendReceiptRecord } from './send-receipts.js';
import { seedSession, T0, T1, useTempStorage } from './test-utils.js';

const content = [{ type: 'text', text: '继续' }];

function receipt(overrides: Partial<SendReceiptRecord> = {}): SendReceiptRecord {
  return {
    sessionId: 'ses_01',
    clientMessageId: 'msg-1',
    fingerprint: requestFingerprint(content),
    status: 'accepted',
    turnId: 'trn_01',
    seq: 5,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

describe('send_receipts', () => {
  const { storage } = useTempStorage();

  it('插入与读取', () => {
    const s = storage();
    seedSession(s);
    s.sendReceipts.insert(receipt());
    expect(s.sendReceipts.get('ses_01', 'msg-1')).toEqual(receipt());
    expect(s.sendReceipts.get('ses_01', 'msg-2')).toBeUndefined();
  });

  it('(session_id, client_message_id) 唯一；不同会话可以用同一个 ID', () => {
    const s = storage();
    seedSession(s);
    seedSession(s, { id: 'ses_02', engineSessionId: 'e2' });
    s.sendReceipts.insert(receipt());
    expect(() => s.sendReceipts.insert(receipt({ turnId: 'trn_02' }))).toThrow(
      /UNIQUE constraint failed: send_receipts\.session_id, send_receipts\.client_message_id/,
    );
    s.sendReceipts.insert(receipt({ sessionId: 'ses_02' }));
  });

  it('会话必须存在', () => {
    expect(() => storage().sendReceipts.insert(receipt())).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('更新状态；启动对账把 accepted 标为 unknown', () => {
    const s = storage();
    seedSession(s);
    s.sendReceipts.insert(receipt({ clientMessageId: 'a' }));
    s.sendReceipts.insert(receipt({ clientMessageId: 'b' }));
    s.sendReceipts.insert(receipt({ clientMessageId: 'c' }));
    expect(s.sendReceipts.setStatus('ses_01', 'a', 'confirmed', T1)).toBe(true);
    expect(s.sendReceipts.setStatus('ses_01', 'missing', 'confirmed', T1)).toBe(false);

    expect(s.sendReceipts.markAcceptedAsUnknown(T1)).toBe(2);
    expect(s.sendReceipts.markAcceptedAsUnknown(T1)).toBe(0);
    const status = (id: string) => s.sendReceipts.get('ses_01', id)?.status;
    expect([status('a'), status('b'), status('c')]).toEqual(['confirmed', 'unknown', 'unknown']);
    expect(s.sendReceipts.get('ses_01', 'b')?.updatedAt).toBe(T1);
  });
});

describe('requestFingerprint', () => {
  it('与对象键顺序无关', () => {
    expect(requestFingerprint([{ type: 'text', text: 'hi', extra: { b: 1, a: 2 } }])).toBe(
      requestFingerprint([{ extra: { a: 2, b: 1 }, text: 'hi', type: 'text' }]),
    );
  });

  it('内容或数组顺序不同则不同', () => {
    const base = requestFingerprint(content);
    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(requestFingerprint([{ type: 'text', text: '继续。' }])).not.toBe(base);
    expect(requestFingerprint([{ text: 'a' }, { text: 'b' }])).not.toBe(
      requestFingerprint([{ text: 'b' }, { text: 'a' }]),
    );
  });
});
