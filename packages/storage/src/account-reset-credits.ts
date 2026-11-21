import type { SqliteDatabase, SqlRow } from './driver.js';
import { integer, optionalText, orNull, text } from './rows.js';

type Outcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';

export interface ResetCreditAttempt {
  attemptId: number;
  idempotencyKey: string;
  creditId?: string;
  outcome?: Outcome;
}

export function createAccountResetCreditRepository(db: SqliteDatabase) {
  const latest = db.prepare(
    'SELECT * FROM account_reset_credit_attempts WHERE account_id = ? AND identity = ? ORDER BY id DESC LIMIT 1',
  );
  const get = db.prepare(
    'SELECT * FROM account_reset_credit_attempts WHERE account_id = ? AND identity = ? AND id = ?',
  );
  const legacy = db.prepare(`
    SELECT attempt.* FROM account_reset_credit_attempts AS attempt
    JOIN account_reset_credit_legacy_keys AS legacy ON legacy.attempt_id = attempt.id
    WHERE attempt.account_id = ? AND attempt.identity = ? AND legacy.key = ?`);
  const insert = db.prepare(`
    INSERT INTO account_reset_credit_attempts (account_id, identity, idempotency_key, credit_id)
    VALUES (?, ?, ?, ?)`);
  const saveLegacy = db.prepare(
    'INSERT OR IGNORE INTO account_reset_credit_legacy_keys (attempt_id, key) VALUES (?, ?)',
  );
  const settle = db.prepare('UPDATE account_reset_credit_attempts SET outcome = ? WHERE id = ?');
  const remove = db.prepare('DELETE FROM account_reset_credit_attempts WHERE account_id = ?');
  return {
    latest: (accountId: string, identity: string) => fromRow(latest.get(accountId, identity)),
    get: (accountId: string, identity: string, attemptId: number) =>
      fromRow(get.get(accountId, identity, attemptId)),
    legacy: (accountId: string, identity: string, key: string) =>
      fromRow(legacy.get(accountId, identity, key)),
    insert: (accountId: string, identity: string, idempotencyKey: string, creditId?: string) =>
      Number(insert.run(accountId, identity, idempotencyKey, orNull(creditId)).lastInsertRowid),
    saveLegacy: (attemptId: number, key: string) => void saveLegacy.run(attemptId, key),
    settle: (attemptId: number, outcome: Outcome) => void settle.run(outcome, attemptId),
    remove: (accountId: string) => void remove.run(accountId),
  };
}

function fromRow(row: SqlRow | undefined): ResetCreditAttempt | undefined {
  if (row === undefined) return undefined;
  const creditId = optionalText(row, 'credit_id');
  const outcome = optionalText(row, 'outcome') as Outcome | undefined;
  return {
    attemptId: integer(row, 'id'),
    idempotencyKey: text(row, 'idempotency_key'),
    ...(creditId !== undefined && { creditId }),
    ...(outcome !== undefined && { outcome }),
  };
}
