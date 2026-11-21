CREATE TABLE account_reset_credit_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    identity TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    credit_id TEXT,
    outcome TEXT CHECK (outcome IN ('reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'))
) STRICT;

CREATE UNIQUE INDEX account_reset_credit_pending
    ON account_reset_credit_attempts (account_id, identity) WHERE outcome IS NULL;

CREATE INDEX account_reset_credit_history ON account_reset_credit_attempts (account_id, identity, id);

CREATE TABLE account_reset_credit_legacy_keys (
    attempt_id INTEGER NOT NULL REFERENCES account_reset_credit_attempts (id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    PRIMARY KEY (attempt_id, key)
) STRICT;

CREATE INDEX account_reset_credit_legacy_lookup ON account_reset_credit_legacy_keys (key);
