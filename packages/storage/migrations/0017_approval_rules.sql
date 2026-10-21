-- 0017_approval_rules：可持久的审批规则（协议 0.80.0 的 approvalRule.*）。
--
-- workspace_id 为 NULL 是全局规则，否则只对这个项目的会话有效。prefix 是命令前缀的 JSON 数组（["git","status"]）。
-- 同一范围里同一前缀只有一条。source 是规则从哪来：approval（审批卡片上选了“总是允许”）或 suggestion（从历史建议里加的）；
-- 从审批来的记下会话与审批。use_count / last_used_at 是 Host 按规则自动允许的次数与最近一次。
CREATE TABLE approval_rules (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT,
  kind               TEXT NOT NULL,
  prefix             TEXT NOT NULL,
  source             TEXT NOT NULL,
  source_session_id  TEXT,
  source_approval_id TEXT,
  created_at         TEXT NOT NULL,
  use_count          INTEGER NOT NULL DEFAULT 0,
  last_used_at       TEXT
) STRICT;

CREATE UNIQUE INDEX approval_rules_unique ON approval_rules (COALESCE(workspace_id, ''), kind, prefix);
