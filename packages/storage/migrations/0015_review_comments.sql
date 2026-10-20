-- 0015_review_comments：diff 上的行级批注（协议 0.67.0 的 review.*）。
--
-- dir 是批注所在目录（工作区目录或会话的 worktree）的 realpath，目录相同的会话看到同一组批注；session_id 是在哪个会话里写的，
-- 删会话时一起删。source 是 DiffSource 的 JSON。snippet 与前后几行上下文是 Host 写批注时从那一侧读出的原文，用来重新定位。
CREATE TABLE review_comments (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  dir             TEXT NOT NULL,
  session_id      TEXT,
  path            TEXT NOT NULL,
  previous_path   TEXT,
  side            TEXT NOT NULL,
  start_line      INTEGER NOT NULL,
  end_line        INTEGER NOT NULL,
  source          TEXT NOT NULL,
  base            TEXT NOT NULL,
  head            TEXT,
  branch          TEXT,
  snippet         TEXT NOT NULL,
  context_before  TEXT NOT NULL,
  context_after   TEXT NOT NULL,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL,
  sent_session_id TEXT,
  sent_turn_id    TEXT,
  sent_pending_id TEXT,
  sent_at         TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;

CREATE INDEX review_comments_by_dir ON review_comments (dir, created_at);
CREATE INDEX review_comments_by_session ON review_comments (session_id);
