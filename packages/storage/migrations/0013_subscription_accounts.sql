-- 0013_subscription_accounts：同一订阅来源的多个账号（协议 0.63.0 的 account.add / account.setLabel）。字段含义见
-- docs/architecture/domain-model.md §3.6。
--
-- 账号 ID 就是它的 Provider 的 ID。每种的首个账号（ID 等于种类）不登记，设了标签时才有一行；添加的账号各一行，凭据与会话
-- 在数据目录的 accounts/<id>/。删账号时删这一行。
CREATE TABLE subscription_accounts (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL
) STRICT;
